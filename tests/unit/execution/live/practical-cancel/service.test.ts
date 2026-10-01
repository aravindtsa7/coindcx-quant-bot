import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { CoinDcxLiveFuturesOrderGateway } from '../../../../../src/integration/coindcx/live/order-gateway';
import { CoinDcxOrderMutationTransport } from '../../../../../src/integration/coindcx/live/mutation-transport';
import * as provenance from '../../../../../src/execution/live/practical-cancel-transport-evidence';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../../../../src/core/time/clock';
import { resolveLiveExecutionGate } from '../../../../../src/execution/live/gate';
import { PracticalRecoveryCertificate, consumePracticalRecoveryCertificate } from '../../../../../src/execution/live/practical/certificate';
import { PracticalRecoveryService } from '../../../../../src/execution/live/practical-recovery/service';
import { PracticalCancelService } from '../../../../../src/execution/live/practical-cancel/service';
import { PracticalCancelGatewayBoundary } from '../../../../../src/execution/live/practical-cancel/gateway-boundary';
import { PracticalCancelLifecycle, createPracticalCancelLifecycle } from '../../../../../src/execution/live/practical-cancel/lifecycle';
import type { PracticalCancelDependencies, PracticalCancelStore } from '../../../../../src/execution/live/practical-cancel/ports';
import { PracticalMutationError } from '../../../../../src/execution/live/practical-mutation/ports';
import {
  issuePracticalAcquiredCancel, issuePracticalArmedCancel, reservePracticalAcquiredCancel, spendPracticalAcquiredCancel,
  reservePracticalCancelPermitCreation, issuePracticalCancelDispatchPermit, issuePracticalCancelDispatchAttempt,
  transitionPracticalCancelDispatchOwner, PracticalCancelDispatchOwner, PracticalArmedCancel,
  type PracticalAcquiredCancelRecord,
} from '../../../../../src/execution/live/practical-mutation/ticket';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch } from '../../../../../src/execution/live/reconciliation/barrier';
import { FINGERPRINT, FakePrivateStream, FakeReconciliation, FakeScheduler, FakeVenue, MemoryPracticalPersistence, T0, enablementFor } from '../practical-recovery/support';

const ACCOUNT = 'orchestration-test-account';
const INTENT = 'a'.repeat(64);

function genuineGateway(baseUrl = 'http://127.0.0.1:1', clock = { nowMs: () => T0 }) {
  if (baseUrl !== 'invalid-local-url' && !baseUrl.startsWith('http://127.0.0.1:')) throw new Error('NONLOCAL_TEST_GATEWAY_REFUSED');
  return new CoinDcxLiveFuturesOrderGateway({ apiKey: 'synthetic-unit-key', apiSecret: 'synthetic-unit-secret', baseUrl, clock });
}

describe('genuine practical cancel transport provenance', () => {
  it.each(['clock', 'base-url'] as const)('%s callback re-entry is refused before preparation without false no-write', async source => {
    const h = await harness(); let factoryCalls = 0, writes = 0, hooks = 0, clockCalls = 0;
    const nested: Promise<unknown>[] = []; let gateway!: CoinDcxLiveFuturesOrderGateway;
    const originalRequest = Object.freeze({ clientOrderId: `p17-${'b'.repeat(32)}`, exchangeOrderId: 'exact-venue-order', pair: 'B-BTC_USDT', timeoutMs: 20 });
    const reenter = () => { nested.push(gateway.cancelOrder(originalRequest).catch(() => null)); throw new Error('SYNTHETIC_COERCION_FAILED'); };
    const timestamp = { toJSON() { hooks++; return reenter(); } };
    const baseUrl = { [Symbol.toPrimitive]() { hooks++; if (hooks === 1) return reenter(); return 'http://127.0.0.1:1'; } };
    const native = vi.spyOn(http, 'request').mockImplementation((() => {
      factoryCalls++; const request = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; destroy: () => void };
      request.write = () => { writes++; }; request.destroy = () => undefined;
      request.end = () => queueMicrotask(() => request.emit('error', new Error('SYNTHETIC_LOCAL_FAILURE')));
      return request;
    }) as never);
    const tls = vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('UNEXPECTED_TLS_FACTORY'); });
    try {
      const options = { apiKey: 'synthetic-coercion-key', apiSecret: 'synthetic-coercion-secret',
        baseUrl: source === 'base-url' ? baseUrl as never : 'http://127.0.0.1:1', clock: { nowMs: () => source === 'clock' && clockCalls++ === 0 ? timestamp as never : T0 } };
      gateway = new CoinDcxLiveFuturesOrderGateway(options);
      const result = await new PracticalCancelService({ ...h.dependencies, gateway }).cancel(h.input);
      await Promise.all(nested);
      expect(result).toMatchObject({ kind: 'COMPLETED', outcome: 'AMBIGUOUS' });
      expect(factoryCalls).toBe(0); expect(writes).toBe(0); expect(hooks).toBe(0); expect(tls).not.toHaveBeenCalled(); expect(nested).toHaveLength(0);
      expect(h.cleanups.map(c => c.kind)).toEqual(['OUTCOME']);
      expect(PracticalCancelDispatchOwner.read(h.cleanups[0]!.owner)?.result?.kind).toBe('AMBIGUOUS');
    } finally { await Promise.all(nested); native.mockRestore(); tls.mockRestore(); }
  });
  it('reads every transport option once and retains the validated credential snapshots for ordinary dispatch', async () => {
    const reads = { key: 0, secret: 0, base: 0, limit: 0 }; let hooks = 0, writes = 0;
    const hostile = new Proxy({}, { get() { hooks++; throw new Error('CALLBACK_SECRET'); } });
    const options = { get apiKey(): string { return ++reads.key === 1 ? 'synthetic-getter-key' : hostile as never; },
      get apiSecret(): string { return ++reads.secret === 1 ? 'synthetic-getter-secret' : hostile as never; },
      get baseUrl() { reads.base++; return 'http://127.0.0.1:1'; }, get maxResponseBytes() { reads.limit++; return 1000; } };
    const native = vi.spyOn(http, 'request').mockImplementation((() => {
      const request = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; destroy: () => void };
      request.write = () => { writes++; }; request.destroy = () => undefined;
      request.end = () => queueMicrotask(() => request.emit('error', new Error('SYNTHETIC_LOCAL_FAILURE'))); return request;
    }) as never);
    try {
      const transport = new CoinDcxOrderMutationTransport(options);
      expect(await transport.execute('CANCEL_ORDER', { timestamp: T0, id: 'exact-venue-order' }, 20)).toMatchObject({ kind: 'PRE_DISPATCH' });
      expect(reads).toEqual({ key: 1, secret: 1, base: 1, limit: 1 }); expect(hooks).toBe(0); expect(writes).toBe(1); expect(native).toHaveBeenCalledTimes(1);
    } finally { native.mockRestore(); }
  });
  it.each(['boxed', 'object', 'proxy', 'revoked', 'date', 'string', 'bigint', 'symbol', 'boolean', 'null', 'undefined', 'nan', 'positive-infinity', 'negative-infinity', 'fraction', 'negative', 'unsafe'] as const)('malformed timestamp %s is ambiguous without coercion, factory calls or no-write receipt', async kind => {
    const h = await harness(); let hooks = 0;
    const refuse = () => { hooks++; throw new Error('UNEXPECTED_INPUT_INSPECTION'); };
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const values: Record<typeof kind, unknown> = { boxed: new Number(T0), object: { toJSON: refuse, toString: refuse, valueOf: refuse, [Symbol.toPrimitive]: refuse },
      proxy: new Proxy({}, { get: refuse, getPrototypeOf: refuse, ownKeys: refuse }), revoked: revoked.proxy, date: new Date(T0), string: '123', bigint: 1n,
      symbol: Symbol('synthetic-time'), boolean: false, null: null, undefined, nan: NaN, 'positive-infinity': Infinity, 'negative-infinity': -Infinity,
      fraction: 1.5, negative: -1, unsafe: Number.MAX_SAFE_INTEGER + 1 };
    const native = vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('UNEXPECTED_NATIVE_FACTORY'); });
    try {
      const gateway = genuineGateway('invalid-local-url', { nowMs: () => values[kind] as never });
      expect(await new PracticalCancelService({ ...h.dependencies, gateway }).cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'AMBIGUOUS' });
      expect(hooks).toBe(0); expect(native).not.toHaveBeenCalled(); expect(h.cleanups.map(c => c.kind)).toEqual(['OUTCOME']);
      expect(PracticalCancelDispatchOwner.read(h.cleanups[0]!.owner)?.result?.kind).toBe('AMBIGUOUS');
    } finally { native.mockRestore(); }
  });
  it.each(['boxed', 'object', 'proxy', 'revoked', 'number', 'bigint', 'symbol', 'boolean', 'null'] as const)('malformed retained base URL %s is ambiguous without coercion', async kind => {
    const h = await harness(); let hooks = 0;
    const refuse = () => { hooks++; throw new Error('UNEXPECTED_URL_INSPECTION'); };
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const values: Record<typeof kind, unknown> = { boxed: new String('http://127.0.0.1:1'), object: { toString: refuse, toJSON: refuse, valueOf: refuse, [Symbol.toPrimitive]: refuse },
      proxy: new Proxy({}, { get: refuse, getPrototypeOf: refuse, ownKeys: refuse }), revoked: revoked.proxy, number: 1, bigint: 1n, symbol: Symbol('synthetic-url'), boolean: false, null: null };
    const native = vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('UNEXPECTED_NATIVE_FACTORY'); });
    try {
      const gateway = new CoinDcxLiveFuturesOrderGateway({ apiKey: 'synthetic-url-key', apiSecret: 'synthetic-url-secret', baseUrl: values[kind] as never, clock: { nowMs: () => T0 } });
      expect(await new PracticalCancelService({ ...h.dependencies, gateway }).cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'AMBIGUOUS' });
      expect(hooks).toBe(0); expect(native).not.toHaveBeenCalled(); expect(h.cleanups.map(c => c.kind)).toEqual(['OUTCOME']);
      expect(PracticalCancelDispatchOwner.read(h.cleanups[0]!.owner)?.result?.kind).toBe('AMBIGUOUS');
    } finally { native.mockRestore(); }
  });
  it.each([0, T0, Number.MAX_SAFE_INTEGER])('valid primitive timestamp %s retains genuine invalid-primitive-URL preparation proof', async timestamp => {
    const h = await harness(); const native = vi.spyOn(http, 'request'), tls = vi.spyOn(https, 'request');
    try {
      expect(await new PracticalCancelService({ ...h.dependencies, gateway: genuineGateway('invalid-local-url', { nowMs: () => timestamp }) }).cancel(h.input)).toMatchObject({ outcome: 'PRE_DISPATCH_FAILURE' });
      expect(native).not.toHaveBeenCalled(); expect(tls).not.toHaveBeenCalled(); expect(h.cleanups.map(c => c.kind)).toEqual(['OUTCOME']);
    } finally { native.mockRestore(); tls.mockRestore(); }
  });
  it('a clock throwing outside preparation remains ambiguity and bookkeeping retry never resends', async () => {
    const h = await harness(); h.setUnknown(); const native = vi.spyOn(http, 'request'); let clockCalls = 0;
    try {
      const service = new PracticalCancelService({ ...h.dependencies, gateway: genuineGateway('invalid-local-url', { nowMs: () => { clockCalls++; throw new Error('SYNTHETIC_CLOCK_FAILURE'); } }) });
      const result = await service.cancel(h.input); if (result.kind !== 'BOOKKEEPING_PENDING') throw new Error('EXPECTED_PENDING');
      expect(PracticalCancelDispatchOwner.read(h.cleanups[0]!.owner)?.result?.kind).toBe('AMBIGUOUS');
      expect(await service.retryBookkeeping({ continuation: result.continuation })).toMatchObject({ outcome: 'AMBIGUOUS' });
      expect(h.cleanups[0]!.owner).toBe(h.cleanups[1]!.owner); expect(clockCalls).toBe(1); expect(native).not.toHaveBeenCalled();
      expect(h.calls.filter(c => c === 'CONSUMPTION')).toHaveLength(1); expect(h.cleanups.every(c => c.kind === 'OUTCOME')).toBe(true);
    } finally { native.mockRestore(); }
  });
  it.each(['apiKey', 'apiSecret'] as const)('callback-bearing %s snapshot refuses construction without coercion', field => {
    let reads = 0, hooks = 0;
    const hostile = new Proxy({}, { get() { hooks++; throw new Error('UNEXPECTED_CREDENTIAL_INSPECTION'); } });
    const options = { apiKey: 'synthetic-snapshot-key', apiSecret: 'synthetic-snapshot-secret' };
    Object.defineProperty(options, field, { get() { reads++; return hostile; } });
    expect(() => new CoinDcxOrderMutationTransport(options)).toThrow(); expect(reads).toBe(1); expect(hooks).toBe(0);
  });
  it('genuine bound gateway retains first validated credential options and never reads their hostile later values', async () => {
    const h = await harness(); let keyReads = 0, secretReads = 0, hooks = 0;
    const hostile = new Proxy({}, { get() { hooks++; throw new Error('UNEXPECTED_LATER_SECRET'); } });
    const options = { get apiKey(): string { return ++keyReads === 1 ? 'synthetic-once-key' : hostile as never; },
      get apiSecret(): string { return ++secretReads === 1 ? 'synthetic-once-secret' : hostile as never; }, baseUrl: 'invalid-local-url', clock: { nowMs: () => T0 } };
    const native = vi.spyOn(http, 'request');
    try {
      expect(await new PracticalCancelService({ ...h.dependencies, gateway: new CoinDcxLiveFuturesOrderGateway(options) }).cancel(h.input)).toMatchObject({ outcome: 'PRE_DISPATCH_FAILURE' });
      expect(keyReads).toBe(1); expect(secretReads).toBe(1); expect(hooks).toBe(0); expect(native).not.toHaveBeenCalled();
      expect(h.cleanups.map(c => c.kind)).toEqual(['OUTCOME']);
    } finally { native.mockRestore(); }
  });
  async function preparedAttempt() {
    const h = await harness(), d = h.dependencies;
    const acquisition = await d.store.acquireCancelLease({ accountId: ACCOUNT, expected: h.input.expected, certificate: h.certificate, enablement: d.enablement, runtimeIdentity: d.runtimeIdentity, intentId: INTENT, trustedNowMs: h.clock.nowMs() });
    if (acquisition.kind !== 'ACQUIRED') throw new Error('ATTEMPT_FIXTURE_FAILED');
    const armed = await d.store.armCancelLease({ acquired: acquisition.acquired, enablement: d.enablement, runtimeIdentity: d.runtimeIdentity, trustedNowMs: h.clock.nowMs() });
    const permit = await d.store.createCancelDispatchPermission({ armed: armed.ticket, enablement: d.enablement, runtimeIdentity: d.runtimeIdentity, trustedNowMs: h.clock.nowMs() });
    const consumed = await d.store.consumeCancelDispatchPermission({ permission: permit.permission, enablement: d.enablement, runtimeIdentity: d.runtimeIdentity, trustedNowMs: h.clock.nowMs() });
    const request = Object.freeze({ clientOrderId: `p17-${'b'.repeat(32)}`, exchangeOrderId: 'exact-venue-order', pair: 'B-BTC_USDT', timeoutMs: 1000 });
    return { attempt: consumed.attempt, request, gateway: genuineGateway('invalid-local-url') };
  }
  it('exact binding, duplicate reservation, context cloning and foreign source refuse without native calls', async () => {
    const a = await preparedAttempt(), b = await preparedAttempt(); const native = vi.spyOn(http, 'request');
    try {
      expect(() => provenance.reserveCancelTransportInvocation(a.gateway, a.attempt, Object.freeze({ ...a.request, pair: 'B-OTHER_USDT' }))).toThrow();
      expect(() => provenance.reserveCancelTransportInvocation(a.gateway, a.attempt, { ...a.request })).toThrow();
      const context = provenance.reserveCancelTransportInvocation(a.gateway, a.attempt, a.request)!;
      expect(() => provenance.reserveCancelTransportInvocation(a.gateway, a.attempt, a.request)).toThrow();
      expect(() => provenance.invokeCancelTransport({ ...context })).toThrow(); expect(() => JSON.stringify(context)).toThrow();
      expect(() => provenance.issueCancelTransportNoWrite(context, new CoinDcxOrderMutationTransport({ apiKey: 'synthetic-key', apiSecret: 'synthetic-secret' }))).toThrow();
      const other = provenance.reserveCancelTransportInvocation(b.gateway, b.attempt, b.request)!;
      transitionPracticalCancelDispatchOwner(a.attempt, 'UNENTERED', 'ENTERED'); transitionPracticalCancelDispatchOwner(b.attempt, 'UNENTERED', 'ENTERED');
      const [one, two] = await Promise.all([provenance.invokeCancelTransport(context), provenance.invokeCancelTransport(other)]);
      expect(() => provenance.invokeCancelTransport(context)).toThrow();
      expect(provenance.settleCancelTransportInvocation(context, two)).toBeNull();
      expect(provenance.settleCancelTransportInvocation(other, one)).toBeNull(); expect(native).not.toHaveBeenCalled();
    } finally { native.mockRestore(); }
  });
  it('genuine evidence is consumed once; a cloned envelope is not proof', async () => {
    const a = await preparedAttempt(), b = await preparedAttempt();
    const one = provenance.reserveCancelTransportInvocation(a.gateway, a.attempt, a.request)!, two = provenance.reserveCancelTransportInvocation(b.gateway, b.attempt, b.request)!;
    transitionPracticalCancelDispatchOwner(a.attempt, 'UNENTERED', 'ENTERED'); transitionPracticalCancelDispatchOwner(b.attempt, 'UNENTERED', 'ENTERED');
    const first = await provenance.invokeCancelTransport(one), second = await provenance.invokeCancelTransport(two);
    expect(provenance.settleCancelTransportInvocation(one, first)).toMatchObject({ noWrite: true });
    expect(provenance.settleCancelTransportInvocation(one, first)).toBeNull();
    expect(provenance.settleCancelTransportInvocation(two, { ...second as object })).toBeNull();
  });
  it('closing a genuine invocation before late propagation invalidates its proof', async () => {
    const a = await preparedAttempt(); const context = provenance.reserveCancelTransportInvocation(a.gateway, a.attempt, a.request)!;
    transitionPracticalCancelDispatchOwner(a.attempt, 'UNENTERED', 'ENTERED');
    const pending = provenance.invokeCancelTransport(context); provenance.closeCancelTransportInvocation(context);
    expect(provenance.settleCancelTransportInvocation(context, await pending)).toBeNull();
    expect(() => provenance.invokeCancelTransport(context)).toThrow();
  });
  it('actual preparation failure has zero native calls and completes an entered no-write outcome', async () => {
    const h = await harness();
    const native = vi.spyOn(http, 'request'), tls = vi.spyOn(https, 'request');
    const gateway = genuineGateway('invalid-local-url');
    const publicCall = vi.spyOn(gateway, 'cancelOrder').mockRejectedValue(new Error('PUBLIC_METHOD_MUST_NOT_BE_CALLED'));
    const publicTransport = vi.spyOn(CoinDcxOrderMutationTransport.prototype, 'execute').mockRejectedValue(new Error('PUBLIC_TRANSPORT_MUST_NOT_BE_CALLED'));
    try {
      expect(await new PracticalCancelService({ ...h.dependencies, gateway }).cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
      expect(native).not.toHaveBeenCalled(); expect(tls).not.toHaveBeenCalled(); expect(publicCall).not.toHaveBeenCalled(); expect(publicTransport).not.toHaveBeenCalled();
      expect(h.cleanups.map(c => c.kind)).toEqual(['OUTCOME']);
      expect(PracticalCancelDispatchOwner.read(h.cleanups[0]!.owner)?.result).toEqual({ kind: 'PRE_DISPATCH_FAILURE', reason: 'LOCAL_REQUEST_REFUSED' });
    } finally { native.mockRestore(); tls.mockRestore(); publicCall.mockRestore(); publicTransport.mockRestore(); }
  });
  it.each(['factory-throw', 'connecting-error', 'connected-error', 'reused-error', 'queued-write', 'partial-response', 'malformed-response', 'timeout'] as const)('%s after factory entry cannot prove no-write', async mode => {
    const h = await harness(20);
    const native = vi.spyOn(http, 'request').mockImplementation(((_url: unknown, _options: unknown, response: (value: unknown) => void) => {
      if (mode === 'factory-throw') throw new Error('SYNTHETIC_FACTORY_THROW');
      const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; destroy: () => void };
      req.write = () => { if (mode === 'queued-write') throw new Error('QUEUED_WRITE_FAILED'); };
      req.end = () => undefined; req.destroy = () => undefined;
      queueMicrotask(() => {
        const socket = new EventEmitter() as EventEmitter & { connecting: boolean };
        socket.connecting = mode !== 'reused-error'; req.emit('socket', socket);
        if (mode === 'connected-error') socket.emit('connect');
        if (mode === 'partial-response' || mode === 'malformed-response') {
          const res = new EventEmitter() as EventEmitter & { statusCode: number; destroy: () => void }; res.statusCode = 200; res.destroy = () => undefined;
          response(res); res.emit('data', Buffer.from('{')); res.emit(mode === 'partial-response' ? 'aborted' : 'end');
        } else if (mode !== 'timeout' && mode !== 'queued-write') req.emit('error', new Error('SYNTHETIC_TRANSPORT_ERROR'));
      });
      return req;
    }) as never);
    try {
      expect(await new PracticalCancelService({ ...h.dependencies, gateway: genuineGateway() }).cancel(h.input)).toMatchObject({ outcome: 'AMBIGUOUS' });
      expect(native).toHaveBeenCalledTimes(1); expect(h.cleanups.map(c => c.kind)).toEqual(['OUTCOME']);
    } finally { native.mockRestore(); }
  });
  it('genuine valid flow invokes once with original body despite public replacement', async () => {
    const h = await harness(); let payload = '';
    const native = vi.spyOn(http, 'request').mockImplementation(((_url: unknown, _options: unknown, response: (value: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & { write: (body: string) => void; end: () => void; destroy: () => void };
      req.write = body => { payload = body; }; req.destroy = () => undefined;
      req.end = () => queueMicrotask(() => { const res = new EventEmitter() as EventEmitter & { statusCode: number }; res.statusCode = 200;
        response(res); res.emit('data', Buffer.from('{"message":"success","status":200,"code":200}')); res.emit('end'); });
      return req;
    }) as never);
    const gateway = genuineGateway(), replaced = vi.spyOn(gateway, 'cancelOrder').mockRejectedValue(new Error('REPLACED_PUBLIC_METHOD'));
    try {
      const service = new PracticalCancelService({ ...h.dependencies, gateway });
      const [result, duplicate] = await Promise.all([service.cancel(h.input), service.cancel(h.input)]);
      expect(result).toMatchObject({ outcome: 'ACCEPTED' }); expect(duplicate.kind).toBe('REFUSED');
      expect(native).toHaveBeenCalledTimes(1); expect(replaced).not.toHaveBeenCalled();
      expect(JSON.parse(payload)).toEqual({ timestamp: T0, id: 'exact-venue-order' });
    } finally { native.mockRestore(); replaced.mockRestore(); }
  });
  it.each([200, 400, 429] as const)('actual loopback native factory HTTP %s preserves the existing response mapping', async status => {
    const h = await harness(); let requests = 0, payload = '';
    const server = http.createServer((request, response) => {
      requests++; request.on('data', bytes => { payload += String(bytes); });
      request.on('end', () => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(status === 200 ? { message: 'success', status: 200, code: 200 } : { message: 'synthetic local refusal', status: String(status), code: String(status) }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (address === null || typeof address === 'string') throw new Error('LOCAL_LISTENER_FAILED');
      const service = new PracticalCancelService({ ...h.dependencies, gateway: genuineGateway(`http://127.0.0.1:${address.port}`) });
      const [result, duplicate] = await Promise.all([service.cancel(h.input), service.cancel(h.input)]);
      expect(result).toMatchObject({ outcome: status === 200 ? 'ACCEPTED' : status === 400 ? 'REJECTED' : 'AMBIGUOUS' }); expect(duplicate.kind).toBe('REFUSED');
      expect(requests).toBe(1); expect(JSON.parse(payload)).toEqual({ timestamp: T0, id: 'exact-venue-order' });
      expect(h.cleanups.map(c => c.kind)).toEqual(['OUTCOME']);
      expect(requests).toBe(1);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it('watch loss after consumption causes zero native requests and only unentered cleanup', async () => {
    const h = await harness(); h.hooks.CONSUMPTION = () => { h.stream.unprove(); };
    const native = vi.spyOn(http, 'request');
    try {
      expect(await new PracticalCancelService({ ...h.dependencies, gateway: genuineGateway() }).cancel(h.input)).toMatchObject({ outcome: 'PRE_DISPATCH_FAILURE' });
      expect(native).not.toHaveBeenCalled(); expect(h.cleanups.map(c => c.kind)).toEqual(['UNENTERED']);
    } finally { native.mockRestore(); }
  });
  it('structural provenance port cannot qualify; structural no-write stays ambiguous', async () => {
    const h = await harness(); const forged = { cancelOrder: vi.fn(async () => ({ kind: 'PRE_DISPATCH_FAILURE' as const, reasonCode: 'LOCAL_CANCEL_PREPARATION_FAILED' })), cancelOrderWithProvenance: vi.fn() };
    expect(provenance.hasCancelTransportSource(forged)).toBe(false);
    expect(await new PracticalCancelService({ ...h.dependencies, gateway: forged }).cancel(h.input)).toMatchObject({ outcome: 'AMBIGUOUS' });
    expect(forged.cancelOrder).toHaveBeenCalledTimes(1); expect(forged.cancelOrderWithProvenance).not.toHaveBeenCalled();
  });
  it.each(['fulfil', 'reject'] as const)('timeout ignores late %s before reflection and cannot resend', async mode => {
    const h = await harness(5); let fulfil!: (value: unknown) => void, reject!: (error: unknown) => void;
    h.gateway.cancelOrder.mockImplementation(() => new Promise((yes, no) => { fulfil = yes; reject = no; }));
    expect(await h.service.cancel(h.input)).toMatchObject({ outcome: 'AMBIGUOUS' });
    let inspected = 0;
    if (mode === 'fulfil') fulfil(new Proxy({}, { getPrototypeOf() { inspected++; throw new Error('LATE_INSPECTION'); }, ownKeys() { inspected++; throw new Error('LATE_INSPECTION'); } }));
    else reject(new Error('LATE_REJECTION'));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(inspected).toBe(0); expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1); expect(h.cleanups).toHaveLength(1);
    expect(PracticalCancelDispatchOwner.read(h.cleanups[0]!.owner)?.result?.kind).toBe('AMBIGUOUS');
  });
  it('forged contexts, source selection, constructors and ownership clones refuse', async () => {
    const h = await harness(); const gateway = genuineGateway('invalid-local-url');
    const request = Object.freeze({ clientOrderId: `p17-${'b'.repeat(32)}`, exchangeOrderId: 'exact-venue-order', pair: 'B-BTC_USDT', timeoutMs: 1000 });
    for (const forged of [{}, Object.create(PracticalCancelDispatchOwner.prototype), { ...h.certificate }]) {
      expect(() => provenance.reserveCancelTransportInvocation(gateway, forged, request)).toThrow('PROVENANCE_REFUSED');
    }
    expect(() => provenance.registerCancelGatewaySource({}, {}, async () => ({}))).toThrow();
    expect(() => provenance.registerCancelTransportSource({})).toThrow();
    expect(() => provenance.installCancelTransportBrand(() => true)).toThrow();
    expect(() => provenance.installCancelGatewayBrand(() => true)).toThrow();
    expect(provenance.settleCancelTransportInvocation({}, {})).toBeNull(); expect(() => provenance.invokeCancelTransport({})).toThrow();
    expect(() => new provenance.CancelTransportInvocation({}, {} as never, request, {} as never, async () => ({}))).toThrow();
    expect(() => new provenance.CancelTransportNoWriteEvidence({}, {} as never)).toThrow();
  });
});
type Step = 'ACQUIRE' | 'ARM' | 'PERMISSION' | 'CONSUMPTION' | 'COMPLETION';
function liveGate(fingerprint = FINGERPRINT, pair = 'B-BTC_USDT') {
  const gate = resolveLiveExecutionGate({ NODE_ENV: 'production', LIVE_EXECUTION_ENABLED: 'true', COINDCX_API_KEY: 'synthetic-unit-key', COINDCX_API_SECRET: 'synthetic-unit-secret',
    COINDCX_LIVE_ACCOUNT_ID: ACCOUNT, COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: fingerprint, LIVE_EXECUTION_ACCOUNT_ALLOWLIST: ACCOUNT,
    LIVE_EXECUTION_PAIR_ALLOWLIST: pair, LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR: '10000000' });
  if (gate.status !== 'ENABLED') throw new Error('GATE_FIXTURE_FAILED');
  return gate.enablement;
}

/** Synthetic store only: genuine original issuance comes from the real recovery engine. */
async function harness(timeoutMs = 1000) {
  const identity = newLiveRuntimeIdentity();
  const epoch = readLiveRuntimeEpoch(identity)!;
  const clock = new FakeClock(T0);
  const stream = new FakePrivateStream();
  const persistence = new MemoryPracticalPersistence(ACCOUNT);
  const reconciliation = new FakeReconciliation(ACCOUNT, epoch);
  const enablement = enablementFor(ACCOUNT);
  const recovery = new PracticalRecoveryService({ accountId: ACCOUNT, runtimeEpoch: epoch, expectedProviderAccountFingerprint: FINGERPRINT,
    enablement, persistence, reconciliation, privateStream: stream, venue: new FakeVenue(clock), clock, scheduler: new FakeScheduler(clock) });
  await recovery.recoverAtStartup();
  await recovery.startWatch();
  reconciliation.completeHealthyRun(epoch);
  const certified = await recovery.certifyAccount();
  if (certified.kind !== 'CERTIFIED') throw new Error('CERTIFICATION_FIXTURE_FAILED');
  const certificate = certified.certificate;
  const record = PracticalRecoveryCertificate.read(certificate)!;
  clock.setTime(record.issuedAtMs + 60_000);
  const original: PracticalAcquiredCancelRecord = { accountId: ACCOUNT, leaseId: 'owned-test-lease', action: 'CANCEL', runtimeEpoch: epoch,
    reconciliationGeneration: record.reconciliationGeneration, leaseCreatedAtMs: clock.nowMs(), intentId: INTENT,
    clientOrderId: `p17-${'b'.repeat(32)}`, cancelGeneration: 1, pair: 'B-BTC_USDT', exchangeOrderId: 'exact-venue-order', orderRevisionAfterClaim: 3,
    certificate: { ...record, status: 'CONSUMED', consumedAtMs: clock.nowMs(), terminalReason: null }, acquiredAtMs: clock.nowMs() };
  const hooks: Partial<Record<Step, () => void | Promise<void>>> = {};
  const calls: string[] = [];
  const cleanups: Array<{ kind: string; owner: unknown; report?: unknown }> = [];
  let acquisitionStop: 'CERTIFICATE_TERMINATED' | 'AUTHORITY_INVALIDATED' | 'MALFORMED_LATCHED' | null = null;
  let malformedCleanup = false;
  let completionUnknown = false;
  const completed = <O extends 'ACCEPTED' | 'REJECTED' | 'AMBIGUOUS' | 'PRE_DISPATCH_FAILURE'>(outcome: O) => ({ kind: 'COMPLETED' as const, outcome, leaseId: original.leaseId, intentId: INTENT, cancelGeneration: 1 });
  const store: PracticalCancelStore = {
    async acquireCancelLease() {
      calls.push('ACQUIRE');
      if (acquisitionStop === 'CERTIFICATE_TERMINATED') return { kind: acquisitionStop, certificateId: record.certificateId, status: 'EXPIRED' };
      if (acquisitionStop === 'AUTHORITY_INVALIDATED') return { kind: acquisitionStop, certificateId: record.certificateId, reason: 'PREFLIGHT_MISMATCH', cause: 'PHASE17_ORDER_MISMATCH', phase17Code: null };
      if (acquisitionStop === 'MALFORMED_LATCHED') return { kind: acquisitionStop, reviewEpisodeId: 'test-review' };
      const acquired = issuePracticalAcquiredCancel(original);
      persistence.state = 'MUTATING';
      if (persistence.certificate !== null) persistence.certificate.record = { ...persistence.certificate.record, status: 'CONSUMED' };
      await hooks.ACQUIRE?.();
      return { kind: 'ACQUIRED', acquired };
    },
    async armCancelLease(input) {
      calls.push('ARM'); reservePracticalAcquiredCancel(input.acquired); spendPracticalAcquiredCancel(input.acquired);
      const ticket = issuePracticalArmedCancel({ accountId: ACCOUNT, leaseId: original.leaseId, certificateId: record.certificateId,
        intentId: INTENT, clientOrderId: original.clientOrderId, cancelGeneration: 1, exchangeOrderId: original.exchangeOrderId, pair: original.pair,
        orderRevisionAfterArm: 4, runtimeEpoch: epoch, reconciliationGeneration: record.reconciliationGeneration,
        certificateStreamIncarnation: record.streamIncarnation, certificateExpiresAtMs: record.expiresAtMs, armedAtMs: clock.nowMs(),
        action: 'CANCEL', basis: 'PRACTICAL_RECOVERY', provesAccountContinuity: false }, original);
      await hooks.ARM?.(); return { kind: 'ARMED', ticket };
    },
    async createCancelDispatchPermission(input) {
      calls.push('PERMISSION'); reservePracticalCancelPermitCreation(input.armed);
      const permission = issuePracticalCancelDispatchPermit(input.armed);
      await hooks.PERMISSION?.(); return { kind: 'PERMITTED', permission };
    },
    async consumeCancelDispatchPermission(input) {
      calls.push('CONSUMPTION'); transitionPracticalCancelDispatchOwner(input.permission, 'READY', 'CONSUMING');
      const attempt = issuePracticalCancelDispatchAttempt(input.permission);
      await hooks.CONSUMPTION?.(); return { kind: 'CONSUMED', attempt };
    },
    async abandonAcquiredCancel(input) { cleanups.push({ kind: 'ABANDON', owner: input.acquired }); return malformedCleanup ? { kind: 'MALFORMED_LATCHED', reviewEpisodeId: 'test-review' } : completed('PRE_DISPATCH_FAILURE'); },
    async completeUndispatchedCancel(input) { cleanups.push({ kind: 'ARMED', owner: input.armed, report: input.report }); return malformedCleanup ? { kind: 'MALFORMED_LATCHED', reviewEpisodeId: 'test-review' } : completed('PRE_DISPATCH_FAILURE'); },
    async completeUnenteredCancelDispatch(input) {
      cleanups.push({ kind: 'UNENTERED', owner: input.owner, report: input.report });
      if (malformedCleanup) return { kind: 'MALFORMED_LATCHED', reviewEpisodeId: 'test-review' };
      const from = PracticalCancelDispatchOwner.status(input.owner)!;
      transitionPracticalCancelDispatchOwner(input.owner, from, 'CLEANING', input.report.reason);
      transitionPracticalCancelDispatchOwner(input.owner, 'CLEANING', 'SPENT');
      return completed('PRE_DISPATCH_FAILURE');
    },
    async completeCancelLease(input) {
      calls.push('COMPLETION'); cleanups.push({ kind: 'OUTCOME', owner: input.outcome });
      if (malformedCleanup) return { kind: 'MALFORMED_LATCHED', reviewEpisodeId: 'test-review' };
      const from = PracticalCancelDispatchOwner.status(input.outcome)!;
      transitionPracticalCancelDispatchOwner(input.outcome, from, 'COMPLETING');
      await hooks.COMPLETION?.();
      if (completionUnknown) { completionUnknown = false; transitionPracticalCancelDispatchOwner(input.outcome, 'COMPLETING', 'COMMIT_UNKNOWN'); throw new PracticalMutationError('PRACTICAL_MUTATION_COMMIT_OUTCOME_UNKNOWN', 'TEST_UNKNOWN'); }
      transitionPracticalCancelDispatchOwner(input.outcome, 'COMPLETING', 'SPENT');
      const result = PracticalCancelDispatchOwner.read(input.outcome)!.result!;
      return completed(result.kind === 'CANCEL_ACCEPTED' ? 'ACCEPTED' : result.kind);
    },
    async resolveUnknownAcquire() { throw new Error('NOT_A_UNIT_RECOVERY_FIXTURE'); },
  };
  const gateway = { cancelOrder: vi.fn(async (_request: unknown): Promise<unknown> => ({ kind: 'CANCEL_ACCEPTED', observation: null })) };
  const dependencies: PracticalCancelDependencies = { store, clock, runtimeIdentity: identity, enablement, liveEnablement: liveGate(), recovery,
    gateway: gateway as unknown as PracticalCancelDependencies['gateway'], requestTimeoutMs: timeoutMs };
  const input = { intentId: INTENT, expected: { accountId: ACCOUNT, runtimeEpoch: epoch, reconciliationGeneration: record.reconciliationGeneration, revision: certified.account.fence.revision }, certificate };
  const service = new PracticalCancelService(dependencies);
  return { clock, stream, persistence, reconciliation, recovery, certificate, record, dependencies, service, input, calls, hooks, cleanups, gateway,
    setStop: (kind: typeof acquisitionStop) => { acquisitionStop = kind; }, setMalformed: () => { malformedCleanup = true; }, setUnknown: () => { completionUnknown = true; } };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('permanent local admission closure and bounded bookkeeping drain', () => {
  it('before stop drain refuses without work; repeated stop permanently refuses admission', async () => {
    const h = await harness();
    expect(await h.service.drain()).toEqual({ kind: 'REFUSED', code: 'ADMISSION_NOT_CLOSED' });
    expect(h.service.requestStop()).toEqual({ kind: 'ADMISSION_CLOSED' });
    expect(h.service.requestStop()).toEqual({ kind: 'ADMISSION_CLOSED' });
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'REFUSED', code: 'ADMISSION_CLOSED' });
    expect(await h.service.drain()).toEqual({ kind: 'LOCAL_DRAINED' });
    expect(h.calls).toEqual([]); expect(h.cleanups).toEqual([]); expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
  });

  it.each(['ACQUIRE', 'ARM', 'PERMISSION', 'CONSUMPTION'] as const)('stop while %s awaits retains the returned original owner and uses only eligible cleanup', async step => {
    const h = await harness(), reached = deferred(), release = deferred();
    h.hooks[step] = async () => { reached.resolve(); await release.promise; };
    const operation = h.service.cancel(h.input); await reached.promise;
    h.service.requestStop(); const drain = h.service.drain();
    expect(await h.service.drain()).toEqual({ kind: 'REFUSED', code: 'DRAIN_IN_PROGRESS' });
    release.resolve();
    expect(await operation).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(await drain).toEqual({ kind: 'LOCAL_DRAINED' });
    expect(h.calls).toEqual(['ACQUIRE', 'ARM', 'PERMISSION', 'CONSUMPTION'].slice(0, ['ACQUIRE', 'ARM', 'PERMISSION', 'CONSUMPTION'].indexOf(step) + 1));
    expect(h.cleanups.map(c => c.kind)).toEqual([step === 'ACQUIRE' ? 'ABANDON' : step === 'ARM' ? 'ARMED' : 'UNENTERED']);
    expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
  });

  it('reentrant stop inside final watch inspection precedes irreversible entry', async () => {
    const h = await harness();
    const health = h.stream.getHealthSnapshot.bind(h.stream); let armed = false;
    h.hooks.CONSUMPTION = () => { armed = true; };
    h.stream.getHealthSnapshot = () => { if (armed) { h.service.requestStop(); h.service.requestStop(); } return health(); };
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(h.gateway.cancelOrder).not.toHaveBeenCalled(); expect(h.cleanups.map(c => c.kind)).toEqual(['UNENTERED']);
    expect(await h.service.drain()).toEqual({ kind: 'LOCAL_DRAINED' });
  });

  it.each(['ACQUIRE', 'ARM', 'PERMISSION', 'CONSUMPTION'].flatMap(step => ['unprove', 'latch', 'replacement'].map(loss => [step, loss] as const)))('%s original-watch %s still cleans only its genuine owner and can drain locally', async (step, loss) => {
    const h = await harness();
    h.hooks[step as 'ACQUIRE' | 'ARM' | 'PERMISSION' | 'CONSUMPTION'] = async () => {
      if (loss === 'unprove') h.stream.unprove();
      if (loss === 'latch') h.stream.health = { ...h.stream.health, reconciliationRequired: true };
      if (loss === 'replacement') {
        h.stream.health = { ...h.stream.health, generationId: 2, subscriptionConfirmation: { source: 'PROVIDER', incarnation: 2, confirmedAtMs: h.clock.nowMs() } };
        await h.recovery.startWatch(); // synthetic test evidence only; never replacement authority for this certificate
      }
    };
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
    expect(h.cleanups.map(c => c.kind)).toEqual([step === 'ACQUIRE' ? 'ABANDON' : step === 'ARM' ? 'ARMED' : 'UNENTERED']);
    h.service.requestStop(); expect(await h.service.drain()).toEqual({ kind: 'LOCAL_DRAINED' });
    expect(h.calls.filter(c => c === 'ACQUIRE')).toHaveLength(1);
  });

  it('entry preceding stop finishes one invocation and outcome completion only', async () => {
    const h = await harness(), entered = deferred(), response = deferred<unknown>();
    h.gateway.cancelOrder.mockImplementation(async () => { entered.resolve(); return response.promise; });
    const operation = h.service.cancel(h.input); await entered.promise;
    h.service.requestStop(); const drain = h.service.drain(); response.resolve({ kind: 'CANCEL_ACCEPTED', observation: null });
    expect(await operation).toMatchObject({ outcome: 'ACCEPTED' }); expect(await drain).toEqual({ kind: 'LOCAL_DRAINED' });
    expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1); expect(h.cleanups.map(c => c.kind)).toEqual(['OUTCOME']);
  });

  it.each(['fulfill', 'reject'] as const)('timeout while original acquisition awaits preserves exclusivity until late %s', async late => {
    const h = await harness(), reached = deferred(), release = deferred();
    h.hooks.ACQUIRE = async () => { reached.resolve(); await release.promise; };
    const operation = h.service.cancel(h.input); await reached.promise; h.service.requestStop();
    vi.useFakeTimers();
    try {
      const drain = h.service.drain(); await vi.advanceTimersByTimeAsync(30_000);
      expect(await drain).toEqual({ kind: 'IN_FLIGHT', phase: 'ACQUIRE' });
      expect(await h.service.retryBookkeeping({ continuation: {} as never })).toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
      if (late === 'fulfill') release.resolve(); else release.reject(new Error('SYNTHETIC_ROLLBACK'));
      const result = await operation;
      expect(result.kind).toBe(late === 'fulfill' ? 'COMPLETED' : 'BLOCKED');
      expect((await h.service.drain()).kind).toBe(late === 'fulfill' ? 'LOCAL_DRAINED' : 'BLOCKED');
      expect(h.calls).toEqual(['ACQUIRE']); expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('a drain-started retry remains exclusive after timeout and late completion resolves the exact receipt', async () => {
    const h = await harness(); h.setUnknown(); const pending = await h.service.cancel(h.input);
    if (pending.kind !== 'BOOKKEEPING_PENDING') throw new Error('EXPECTED_PENDING');
    const reached = deferred(), release = deferred(); h.hooks.COMPLETION = async () => { reached.resolve(); await release.promise; };
    h.service.requestStop(); vi.useFakeTimers();
    try {
      const drain = h.service.drain(); await reached.promise; await vi.advanceTimersByTimeAsync(30_000);
      expect(await drain).toEqual({ kind: 'IN_FLIGHT', phase: 'COMPLETION' });
      expect(await h.service.retryBookkeeping({ continuation: pending.continuation })).toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
      const observer = h.service.drain(); release.resolve(); expect(await observer).toEqual({ kind: 'LOCAL_DRAINED' });
      expect(h.cleanups).toHaveLength(2); expect(h.cleanups[0]!.owner).toBe(h.cleanups[1]!.owner);
      expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1); expect(h.calls.filter(c => c === 'CONSUMPTION')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('one total budget includes waiting for cancel and the single subsequent bookkeeping retry', async () => {
    const h = await harness(); h.setUnknown(); const firstReached = deferred(), firstRelease = deferred(), retryReached = deferred(), retryRelease = deferred();
    let runs = 0; h.hooks.COMPLETION = async () => { if (++runs === 1) { firstReached.resolve(); await firstRelease.promise; } else { retryReached.resolve(); await retryRelease.promise; } };
    const operation = h.service.cancel(h.input); await firstReached.promise; h.service.requestStop(); vi.useFakeTimers();
    try {
      const drain = h.service.drain(); let settled = false; void drain.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(20_000); firstRelease.resolve(); expect((await operation).kind).toBe('BOOKKEEPING_PENDING'); await retryReached.promise;
      await vi.advanceTimersByTimeAsync(9_999); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(await drain).toEqual({ kind: 'IN_FLIGHT', phase: 'COMPLETION' });
      retryRelease.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(await h.service.drain()).toEqual({ kind: 'LOCAL_DRAINED' }); expect(h.cleanups).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('late retry rejection after the drain deadline keeps the exact genuine receipt and handles settlement', async () => {
    const h = await harness(); h.setUnknown(); const pending = await h.service.cancel(h.input);
    if (pending.kind !== 'BOOKKEEPING_PENDING') throw new Error('EXPECTED_PENDING');
    const reached = deferred(), release = deferred();
    h.hooks.COMPLETION = async () => {
      reached.resolve();
      try { await release.promise; }
      catch (error) {
        // Synthetic proven rollback of bookkeeping, not restored dispatch authority.
        transitionPracticalCancelDispatchOwner(h.cleanups.at(-1)!.owner, 'COMPLETING', 'COMMIT_UNKNOWN');
        throw error;
      }
    };
    h.service.requestStop(); vi.useFakeTimers();
    try {
      const drain = h.service.drain(); await reached.promise; await vi.advanceTimersByTimeAsync(30_000);
      expect(await drain).toEqual({ kind: 'IN_FLIGHT', phase: 'COMPLETION' });
      expect(await h.service.retryBookkeeping({ continuation: pending.continuation })).toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
      const observer = h.service.drain(); release.reject(new Error('SYNTHETIC_BOOKKEEPING_ROLLBACK'));
      expect(await observer).toEqual({ kind: 'BOOKKEEPING_PENDING', phase: 'COMPLETION' });
      expect(h.cleanups).toHaveLength(2); delete h.hooks.COMPLETION;
      expect(await h.service.retryBookkeeping({ continuation: pending.continuation })).toMatchObject({ kind: 'COMPLETED', outcome: 'ACCEPTED' });
      expect(await h.service.drain()).toEqual({ kind: 'LOCAL_DRAINED' });
      expect(new Set(h.cleanups.map(c => c.owner)).size).toBe(1);
      expect(h.calls.filter(c => c === 'ACQUIRE')).toHaveLength(1); expect(h.calls.filter(c => c === 'CONSUMPTION')).toHaveLength(1);
      expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it.each(['manual-first', 'drain-first'] as const)('%s bookkeeping/drain ordering never overlaps retries', async order => {
    const h = await harness(); h.setUnknown(); const pending = await h.service.cancel(h.input);
    if (pending.kind !== 'BOOKKEEPING_PENDING') throw new Error('EXPECTED_PENDING');
    const reached = deferred(), release = deferred(); h.hooks.COMPLETION = async () => { reached.resolve(); await release.promise; };
    h.service.requestStop();
    const first = order === 'manual-first' ? h.service.retryBookkeeping({ continuation: pending.continuation }) : h.service.drain(); await reached.promise;
    const drain = order === 'manual-first' ? h.service.drain() : null;
    expect(await h.service.retryBookkeeping({ continuation: pending.continuation })).toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
    expect(await h.service.drain()).toEqual({ kind: 'REFUSED', code: 'DRAIN_IN_PROGRESS' });
    release.resolve(); await first; if (drain !== null) expect(await drain).toEqual({ kind: 'LOCAL_DRAINED' });
    expect(await h.service.drain()).toEqual({ kind: 'LOCAL_DRAINED' }); expect(h.cleanups).toHaveLength(2); expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1);
  });

  it('a drain retries at most once and a later identical success clears retained uncertainty', async () => {
    const h = await harness(); h.setUnknown(); const pending = await h.service.cancel(h.input); expect(pending.kind).toBe('BOOKKEEPING_PENDING');
    h.service.requestStop(); h.setUnknown();
    expect(await h.service.drain()).toEqual({ kind: 'BOOKKEEPING_PENDING', phase: 'COMPLETION' });
    expect(h.cleanups).toHaveLength(2); expect(await h.service.drain()).toEqual({ kind: 'LOCAL_DRAINED' });
    expect(h.cleanups).toHaveLength(3); expect(new Set(h.cleanups.map(c => c.owner)).size).toBe(1); expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1);
  });

  it.each(['acquire-malformed', 'cleanup-malformed', 'ownerless-operational'] as const)('%s cannot become false local drainage or be erased by invalid requests', async fault => {
    const h = await harness();
    if (fault === 'acquire-malformed') h.setStop('MALFORMED_LATCHED');
    if (fault === 'cleanup-malformed') h.setMalformed();
    if (fault === 'ownerless-operational') h.dependencies.store.acquireCancelLease = async () => { throw new Error('SYNTHETIC_UNRESOLVED'); };
    expect((await h.service.cancel(h.input)).kind).toBe('BLOCKED');
    expect((await h.service.cancel({} as never)).kind).toBe('BLOCKED'); h.service.requestStop();
    expect((await h.service.retryBookkeeping({ continuation: {} as never })).kind).toBe('REFUSED');
    h.service.requestStop(); expect((await h.service.drain()).kind).toBe('BLOCKED');
  });

  it('missing/forged/cloned/foreign associations cannot construct a boundary or be minted for a fake service', async () => {
    const h = await harness(), other = await harness();
    for (const value of [undefined, {}, Object.create(PracticalCancelLifecycle.prototype), { ...h.service }, other.service]) {
      expect(() => new PracticalCancelGatewayBoundary(h.dependencies, value, h.service)).toThrow('CANCEL_LIFECYCLE_ASSOCIATION_REFUSED');
    }
    expect(() => createPracticalCancelLifecycle({}, h.dependencies)).toThrow();
    expect(() => createPracticalCancelLifecycle(Object.create(PracticalCancelService.prototype), h.dependencies)).toThrow();
    expect(() => createPracticalCancelLifecycle(h.service, h.dependencies)).toThrow();
    expect(await h.service.cancel(h.input)).toMatchObject({ outcome: 'ACCEPTED' }); expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1);
  });
});

describe('genuine original-watch continuation', () => {
  it.each(['assignment', 'reflect', 'define', 'delete'] as const)('%s cannot replace watch refusal after confirmed consumption or enter a gateway', async operation => {
    const h = await harness();
    const original = PracticalRecoveryService.checkOriginalCertificateWatch;
    h.hooks.CONSUMPTION = () => {
      h.stream.unprove();
      const target = PracticalRecoveryService as unknown as Record<string, unknown>;
      const key = 'checkOriginalCertificateWatch';
      const forged = () => ({ kind: 'UNCHANGED' });
      if (operation === 'assignment') expect(() => { target[key] = forged; }).toThrow(TypeError);
      if (operation === 'reflect') expect(Reflect.set(target, key, forged)).toBe(false);
      if (operation === 'define') expect(() => Object.defineProperty(target, key, { value: forged })).toThrow(TypeError);
      if (operation === 'delete') expect(Reflect.deleteProperty(target, key)).toBe(false);
      expect(PracticalRecoveryService.checkOriginalCertificateWatch).toBe(original);
      expect(original(h.recovery, { certificate: h.certificate, trustedNowMs: h.clock.nowMs() }).kind).toBe('REFUSED');
    };
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['ACQUIRE', 'ARM', 'PERMISSION', 'CONSUMPTION']);
    expect(h.cleanups.map(c => c.kind)).toEqual(['UNENTERED']);
    expect(PracticalCancelDispatchOwner.read(h.cleanups[0]!.owner)?.role).toBe('ATTEMPT');
    expect(PracticalCancelDispatchOwner.status(h.cleanups[0]!.owner)).toBe('SPENT');
  });
  it('survives durable and local consumption without renewing or changing authority monitor', async () => {
    const h = await harness();
    consumePracticalRecoveryCertificate(h.certificate, h.record, h.clock.nowMs(), 'owned-test-lease');
    const now = h.clock.nowMs();
    expect(PracticalRecoveryService.checkOriginalCertificateWatch(h.recovery, { certificate: h.certificate, trustedNowMs: now })).toEqual({ kind: 'UNCHANGED' });
    h.persistence.state = 'MUTATING';
    expect(await h.recovery.monitorAuthority()).toMatchObject({ kind: 'NO_OUTSTANDING_CERTIFICATE' });
    expect(PracticalRecoveryCertificate.status(h.certificate)).toBe('CONSUMED');
  });
  it('refuses fake recovery objects, certificate clones and cross-instance issuance', async () => {
    const h = await harness(), other = await harness();
    for (const [service, certificate] of [[{}, h.certificate], [Object.create(PracticalRecoveryService.prototype), h.certificate], [h.recovery, {}], [other.recovery, h.certificate]]) {
      expect(PracticalRecoveryService.checkOriginalCertificateWatch(service, { certificate, trustedNowMs: h.clock.nowMs() }).kind).toBe('REFUSED');
    }
  });
  it.each(['stop', 'trip', 'replacement'] as const)('refuses after %s without manufacturing a watch', async reason => {
    const h = await harness();
    if (reason === 'stop') await h.recovery.stopWatch();
    if (reason === 'trip') h.stream.emit('df-order-update');
    if (reason === 'replacement') { h.stream.health = { ...h.stream.health, generationId: 2, subscriptionConfirmation: { source: 'PROVIDER', incarnation: 2, confirmedAtMs: h.clock.nowMs() } }; await h.recovery.startWatch(); }
    expect(PracticalRecoveryService.checkOriginalCertificateWatch(h.recovery, { certificate: h.certificate, trustedNowMs: h.clock.nowMs() }).kind).toBe('REFUSED');
    expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
  });
});

describe('unwired orchestration and gateway boundary', () => {
  it.each(['before', 'after'].flatMap(timing => ['assignment', 'reflect', 'define', 'delete'].map(operation => [timing, operation] as const)))('%s construction: %s cannot send and falsely return NOT_ENTERED after consumption', async (timing, operation) => {
    const original = PracticalCancelGatewayBoundary.prototype.invoke;
    const redirected = vi.fn(async () => {
      await h.gateway.cancelOrder({ clientOrderId: 'forged-test-selector' });
      return { kind: 'NOT_ENTERED', code: 'ORIGINAL_WATCH_REFUSED' };
    });
    const attack = () => {
      const target = PracticalCancelGatewayBoundary.prototype as unknown as Record<string, unknown>;
      if (operation === 'assignment') expect(() => { target['invoke'] = redirected; }).toThrow(TypeError);
      if (operation === 'reflect') expect(Reflect.set(target, 'invoke', redirected)).toBe(false);
      if (operation === 'define') expect(() => Object.defineProperty(target, 'invoke', { value: redirected })).toThrow(TypeError);
      if (operation === 'delete') expect(Reflect.deleteProperty(target, 'invoke')).toBe(false);
      expect(PracticalCancelGatewayBoundary.prototype.invoke).toBe(original);
    };
    if (timing === 'before') attack();
    const h = await harness();
    h.hooks.CONSUMPTION = () => { h.stream.unprove(); attack(); };
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(redirected).not.toHaveBeenCalled(); expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['ACQUIRE', 'ARM', 'PERMISSION', 'CONSUMPTION']);
    expect(h.cleanups.map(c => c.kind)).toEqual(['UNENTERED']);
    expect(PracticalCancelDispatchOwner.read(h.cleanups[0]!.owner)?.role).toBe('ATTEMPT');
    expect(PracticalCancelDispatchOwner.status(h.cleanups[0]!.owner)).toBe('SPENT');
  });
  it('uses exact frozen original identity, one invocation and no economic observations', async () => {
    const h = await harness();
    h.gateway.cancelOrder.mockResolvedValue({ kind: 'CANCEL_ACCEPTED', observation: new Proxy({}, { get() { throw new Error('ECONOMIC_OBSERVATION_MUST_NOT_BE_READ'); } }) });
    expect(await h.service.cancel(h.input)).toEqual({ kind: 'COMPLETED', outcome: 'ACCEPTED', disposition: 'COMPLETED' });
    expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1);
    const request = h.gateway.cancelOrder.mock.calls[0]![0];
    expect(request).toEqual({ clientOrderId: `p17-${'b'.repeat(32)}`, exchangeOrderId: 'exact-venue-order', pair: 'B-BTC_USDT', timeoutMs: 1000 });
    expect(Object.isFrozen(request)).toBe(true);
    expect(h.calls).toEqual(['ACQUIRE', 'ARM', 'PERMISSION', 'CONSUMPTION', 'COMPLETION']);
  });
  it.each(['ordinary', 'provenance'].flatMap(source => ['UNPROVEN', 'LATCH', 'DISCONNECTED', 'JOIN_LOST', 'INCARNATION', 'CONFIRMATION', 'INVALID_EVENT', 'STATE', 'EXPIRED', 'DWELL', 'CLOCK', 'RUNTIME', 'ENABLEMENT', 'LIVE_GATE', 'ACCOUNT', 'FAKE_CHECKER'].map(reason => [source, reason] as const)))('%s %s refuses with zero gateway/native calls', async (source, reason) => {
    const h = await harness();
    const dependencies = { ...h.dependencies };
    if (source === 'provenance') dependencies.gateway = genuineGateway();
    switch (reason) {
      case 'UNPROVEN': h.stream.unprove(); break;
      case 'LATCH': h.stream.health = { ...h.stream.health, reconciliationRequired: true }; break;
      case 'DISCONNECTED': h.stream.health = { ...h.stream.health, connected: false }; break;
      case 'JOIN_LOST': h.stream.health = { ...h.stream.health, authJoinSent: false }; break;
      case 'INCARNATION': h.stream.health = { ...h.stream.health, generationId: 2 }; break;
      case 'CONFIRMATION': h.stream.confirmSubscription(T0 + 1); break;
      case 'INVALID_EVENT': h.stream.health = { ...h.stream.health, invalidEventCount: 1 }; break;
      case 'STATE': h.stream.health = { ...h.stream.health, state: 'DEGRADED' }; break;
      case 'EXPIRED': h.clock.setTime(h.record.expiresAtMs); break;
      case 'DWELL': h.clock.setTime(h.record.issuedAtMs + 1); break;
      case 'CLOCK': h.clock.setTime(Number.NaN); break;
      case 'RUNTIME': dependencies.runtimeIdentity = newLiveRuntimeIdentity(); break;
      case 'ENABLEMENT': dependencies.enablement = enablementFor('another-account'); break;
      case 'LIVE_GATE': dependencies.liveEnablement = {} as never; break;
      case 'ACCOUNT': dependencies.liveEnablement = liveGate('d'.repeat(64)); break;
      case 'FAKE_CHECKER': dependencies.recovery = { checkOriginalCertificateWatch: () => ({ kind: 'UNCHANGED' }) } as never; break;
    }
    const native = vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('UNEXPECTED_NATIVE_REQUEST'); });
    try {
      const result = await new PracticalCancelService(dependencies).cancel(h.input);
      expect(result.kind).toBe('REFUSED'); expect(h.gateway.cancelOrder).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled(); expect(h.calls).toEqual([]);
    } finally { native.mockRestore(); }
  });
  it.each(['ACQUIRE', 'ARM', 'PERMISSION', 'CONSUMPTION'] as const)('trip during %s cleans only current ownership and never calls gateway', async step => {
    const h = await harness(); h.hooks[step] = () => h.stream.emit('df-order-update');
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' });
    expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
    expect(h.cleanups.map(c => c.kind)).toEqual([step === 'ACQUIRE' ? 'ABANDON' : step === 'ARM' ? 'ARMED' : 'UNENTERED']);
    if (step === 'ARM') expect(PracticalArmedCancel.status(h.cleanups[0]!.owner)).toBe('ARMED');
  });
  it.each(['ACQUIRE', 'ARM', 'PERMISSION', 'CONSUMPTION'] as const)('clock regression during %s refuses entry', async step => {
    const h = await harness(); h.hooks[step] = () => h.clock.advance(-1);
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'PRE_DISPATCH_FAILURE' }); expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
  });
  it.each(['CERTIFICATE_TERMINATED', 'AUTHORITY_INVALIDATED', 'MALFORMED_LATCHED'] as const)('handles acquisition %s explicitly', async kind => {
    const h = await harness(); h.setStop(kind);
    const result = await h.service.cancel(h.input);
    expect(result.kind).toBe(kind === 'MALFORMED_LATCHED' ? 'BLOCKED' : 'ACQUISITION_STOPPED'); expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
  });
  it('malformed cleanup and completion cannot report completed', async () => {
    for (const preEntry of [true, false]) {
      const h = await harness(); h.setMalformed(); if (preEntry) h.hooks.ARM = () => { h.stream.unprove(); };
      expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'BLOCKED', code: 'MANUAL_REVIEW_REQUIRED' });
    }
  });
  it.each([{ kind: 'REJECTED', reasonCode: 'HTTP_400' }, { kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' }, { kind: 'PRE_DISPATCH_FAILURE', reasonCode: 'TRANSPORT_ERROR' },
    {}, { kind: 'CANCEL_ACCEPTED' }, Object.create({ kind: 'CANCEL_ACCEPTED', observation: null }),
    Object.defineProperty({ observation: null }, 'kind', { enumerable: true, get() { throw new Error('HOSTILE_RESULT'); } }),
    { kind: 'CANCEL_ACCEPTED', observation: null, secret: 'TEST_RAW_PROVIDER_VALUE' }])('projects only safe classification without raw data', async value => {
    const h = await harness(); h.gateway.cancelOrder.mockResolvedValue(value);
    const result = await h.service.cancel(h.input);
    expect(result).toMatchObject({ kind: 'COMPLETED', outcome: Object.getOwnPropertyDescriptor(value, 'kind')?.value === 'REJECTED' ? 'REJECTED' : 'AMBIGUOUS' });
    expect(JSON.stringify(result)).not.toMatch(/TEST_RAW|HOSTILE|TRANSPORT_ERROR|HTTP_400/); expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1);
  });
  it('post-entry throw never resends or performs no-wire cleanup', async () => {
    const h = await harness(); h.gateway.cancelOrder.mockImplementation(() => { throw new Error('PRIVATE_RAW_ERROR'); });
    expect(await h.service.cancel(h.input)).toMatchObject({ kind: 'COMPLETED', outcome: 'AMBIGUOUS' });
    expect(h.cleanups.map(c => c.kind)).toEqual(['OUTCOME']); expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1);
  });
  it('reserves before await and refuses duplicate/reentrant calls', async () => {
    const h = await harness(); let nested: unknown;
    h.hooks.ACQUIRE = async () => { nested = await h.service.cancel(h.input); };
    h.hooks.COMPLETION = async () => { expect(await h.service.cancel(h.input)).toMatchObject({ code: 'OPERATION_IN_PROGRESS' }); };
    h.gateway.cancelOrder.mockImplementation(async () => { expect(await h.service.cancel(h.input)).toMatchObject({ code: 'OPERATION_IN_PROGRESS' }); return { kind: 'CANCEL_ACCEPTED', observation: null }; });
    const first = h.service.cancel(h.input); expect(await h.service.cancel(h.input)).toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
    expect(await first).toMatchObject({ outcome: 'ACCEPTED' }); expect(nested).toMatchObject({ code: 'OPERATION_IN_PROGRESS' }); expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1);
  });
  it('timeout settles once and late fulfillment or rejection cannot alter outcome', async () => {
    for (const rejectLate of [false, true]) {
      const h = await harness(5); let fulfill!: (value: unknown) => void, reject!: (error: unknown) => void;
      h.gateway.cancelOrder.mockImplementation(() => new Promise((resolve, fail) => { fulfill = resolve; reject = fail; }));
      expect(await h.service.cancel(h.input)).toMatchObject({ outcome: 'AMBIGUOUS' });
      if (rejectLate) reject(new Error('LATE_PRIVATE_ERROR')); else fulfill({ kind: 'CANCEL_ACCEPTED', observation: null });
      await Promise.resolve(); expect(h.calls.filter(c => c === 'COMPLETION')).toHaveLength(1); expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1);
    }
  });
  it('continuations are opaque, service-bound, reserved before await and completion-only', async () => {
    const h = await harness(); h.setUnknown(); const result = await h.service.cancel(h.input);
    if (result.kind !== 'BOOKKEEPING_PENDING') throw new Error('EXPECTED_PENDING');
    expect(JSON.stringify(result.continuation)).toBe('{}');
    const other = await harness();
    for (const continuation of [{}, { ...result.continuation }, Object.create(Object.getPrototypeOf(result.continuation))]) expect(await h.service.retryBookkeeping({ continuation: continuation as never })).toMatchObject({ kind: 'REFUSED' });
    expect(await other.service.retryBookkeeping({ continuation: result.continuation })).toMatchObject({ kind: 'REFUSED' });
    h.hooks.COMPLETION = async () => { expect(await h.service.retryBookkeeping({ continuation: result.continuation })).toMatchObject({ code: 'OPERATION_IN_PROGRESS' }); };
    const retry = h.service.retryBookkeeping({ continuation: result.continuation });
    expect(await h.service.retryBookkeeping({ continuation: result.continuation })).toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
    expect(await retry).toMatchObject({ outcome: 'ACCEPTED' });
    expect(h.cleanups[0]!.owner).toBe(h.cleanups[1]!.owner); expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1);
    expect(await h.service.retryBookkeeping({ continuation: result.continuation })).toMatchObject({ kind: 'REFUSED' });
  });
  it('unknown or hostile caller keys cannot redirect identity', async () => {
    const h = await harness();
    for (const input of [{ ...h.input, exchangeOrderId: 'redirect' }, Object.create(h.input), Object.defineProperty({}, 'intentId', { get() { throw new Error('HOSTILE_INPUT'); } })]) {
      expect(await h.service.cancel(input as never)).toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(h.calls).toEqual([]); expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
  });
});

describe('trusted cancel lookup replacement through actual CommonJS loaders', () => {
  let compiledRoot: string;
  let fixtureFile: string;
  let tsxFixtureFile: string;
  beforeAll(() => {
    const base = path.resolve('.local');
    mkdirSync(base, { recursive: true });
    const temporary = mkdtempSync(path.join(base, 'practical-cancel-checker-cjs-'));
    compiledRoot = path.join(temporary, 'dist');
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json', '--outDir', compiledRoot,
      '--declaration', 'false', '--sourceMap', 'false'], { cwd: process.cwd(), stdio: 'pipe', timeout: 120_000, windowsHide: true });
    const options = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, alwaysStrict: true };
    const sourceRoot = compiledRoot.replaceAll('\\', '/');
    const supportFile = path.join(temporary, 'support.cjs');
    const support = readFileSync(path.resolve(__dirname, '../practical-recovery/support.ts'), 'utf8')
      .replaceAll('../../../../../src/', `${sourceRoot}/`);
    writeFileSync(supportFile, ts.transpileModule(support, { compilerOptions: options }).outputText);
    // Reuse this file's genuine issuance/owner fixture, not a production proof
    // fallback. Deliberately delay only the consumer import until after attacks.
    const source = readFileSync(__filename, 'utf8');
    const parsed = ts.createSourceFile(__filename, source, ts.ScriptTarget.ES2022, true);
    const fixtureSource = parsed.statements.filter(statement => {
      if (ts.isImportDeclaration(statement)) {
        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
        return (specifier.startsWith('../../../../../src/') || specifier === '../practical-recovery/support')
          && !['../../../../../src/execution/live/practical-cancel/service', '../../../../../src/execution/live/practical-cancel/gateway-boundary'].includes(specifier);
      }
      if (ts.isFunctionDeclaration(statement)) return ['harness', 'liveGate'].includes(statement.name?.text ?? '');
      if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(declaration => ['ACCOUNT', 'INTENT'].includes(declaration.name.getText(parsed)));
      return false;
    }).map(statement => statement.getText(parsed)).join('\n');
    const fixture = fixtureSource
      .replaceAll('../../../../../src/', `${sourceRoot}/`)
      .replaceAll('../practical-recovery/support', supportFile.replaceAll('\\', '/'));
    fixtureFile = path.join(temporary, 'fixture.cjs');
    writeFileSync(fixtureFile, ts.transpileModule(`
      const vi = { fn(implementation) { const f = (...args) => { f.mock.calls.push(args); return implementation(...args); }; f.mock = { calls: [] }; return f; } };
      let PracticalCancelService;
      ${fixture}
      module.exports.makeFixture = () => { PracticalCancelService = require(${JSON.stringify(path.join(compiledRoot, 'execution/live/practical-cancel/service.js'))}).PracticalCancelService; return harness(); };
    `, { compilerOptions: options }).outputText);
    const sourceDirectory = path.resolve('src').replaceAll('\\', '/');
    const tsxFixture = fixtureSource.replaceAll('../../../../../src/', `${sourceDirectory}/`)
      .replaceAll('../practical-recovery/support', path.resolve(__dirname, '../practical-recovery/support.ts').replaceAll('\\', '/'));
    tsxFixtureFile = path.join(temporary, 'tsx-fixture.cjs');
    writeFileSync(tsxFixtureFile, ts.transpileModule(`
      const vi = { fn(implementation) { const f = (...args) => { f.mock.calls.push(args); return implementation(...args); }; f.mock = { calls: [] }; return f; } };
      let PracticalCancelService;
      ${tsxFixture}
      module.exports.makeFixture = () => { PracticalCancelService = require(${JSON.stringify(path.resolve('src/execution/live/practical-cancel/service.ts'))}).PracticalCancelService; return harness(); };
    `, { compilerOptions: options }).outputText);
  }, 150_000);

  it.each(['tsc', 'tsx'].flatMap(format => ['before', 'after'].flatMap(timing => ['assignment', 'reflect', 'define', 'delete'].map(operation => [format, timing, operation] as const))))('%s %s consumer import: %s cannot redirect genuine refusal or gateway entry', (format, timing, operation) => {
    const output = execFileSync(process.execPath, [...(format === 'tsx' ? ['--require', 'tsx/cjs'] : []), '-e', String.raw`
      'use strict';
      const assert = require('node:assert/strict'), path = require('node:path');
      const [root, fixturePath, timing, operation, extension] = process.argv.slice(1);
      const recoveryPath = path.join(root, 'execution/live/practical-recovery/service.'+extension);
      const consumerPath = path.join(root, 'execution/live/practical-cancel/service.'+extension);
      const namespace = require(recoveryPath), Recovery = namespace.PracticalRecoveryService;
      const checker = Recovery.checkOriginalCertificateWatch;
      const { makeFixture } = require(fixturePath);
      assert.equal(require.cache[require.resolve(consumerPath)], undefined);
      if (timing === 'after') require(consumerPath);
      const attack = () => {
        for (const [object, key, value] of [[Recovery, 'checkOriginalCertificateWatch', () => ({kind:'UNCHANGED'})],
          [namespace, 'PracticalRecoveryService', {checkOriginalCertificateWatch:() => ({kind:'UNCHANGED'})}]]) {
          if (operation === 'assignment') assert.throws(() => { object[key] = value; }, TypeError);
          if (operation === 'reflect') assert.equal(Reflect.set(object, key, value), false);
          if (operation === 'define') assert.throws(() => Object.defineProperty(object, key, {value}), TypeError);
          if (operation === 'delete') assert.throws(() => { delete object[key]; }, TypeError);
        }
        assert.equal(namespace.PracticalRecoveryService, Recovery);
        assert.equal(Recovery.checkOriginalCertificateWatch, checker);
      };
      attack();
      (async () => {
        const valid = await makeFixture();
        assert.equal(checker(valid.recovery, {certificate:valid.certificate,trustedNowMs:valid.clock.nowMs()}).kind,'UNCHANGED');
        const [accepted, duplicate] = await Promise.all([valid.service.cancel(valid.input), valid.service.cancel(valid.input)]);
        assert.equal(accepted.outcome,'ACCEPTED'); assert.equal(duplicate.kind,'REFUSED');
        assert.equal(valid.gateway.cancelOrder.mock.calls.length,1);
        const lost = await makeFixture(), other = await makeFixture();
        for (const [service, certificate] of [[{},lost.certificate], [Object.create(Recovery.prototype),lost.certificate],
          [lost.recovery,{...lost.certificate}], [other.recovery,lost.certificate]]) {
          assert.equal(checker(service,{certificate,trustedNowMs:lost.clock.nowMs()}).kind,'REFUSED');
        }
        lost.hooks.CONSUMPTION = () => {
          lost.stream.unprove(); attack();
          assert.equal(checker(lost.recovery,{certificate:lost.certificate,trustedNowMs:lost.clock.nowMs()}).kind,'REFUSED');
        };
        const refused = await lost.service.cancel(lost.input);
        assert.equal(refused.kind,'COMPLETED'); assert.equal(refused.outcome,'PRE_DISPATCH_FAILURE');
        assert.equal(lost.gateway.cancelOrder.mock.calls.length,0);
        assert.deepEqual(lost.calls,['ACQUIRE','ARM','PERMISSION','CONSUMPTION']);
        assert.equal(lost.cleanups.length,1); assert.equal(lost.cleanups[0].kind,'UNENTERED');
        const Owner = require(path.join(root,'execution/live/practical-mutation/ticket.'+extension)).PracticalCancelDispatchOwner;
        assert.equal(Owner.read(lost.cleanups[0].owner).role,'ATTEMPT'); assert.equal(Owner.status(lost.cleanups[0].owner),'SPENT');
        const pending = await makeFixture(); pending.setUnknown();
        const uncertain = await pending.service.cancel(pending.input);
        assert.equal(uncertain.kind,'BOOKKEEPING_PENDING'); pending.stream.unprove(); attack();
        const before = pending.calls.filter(c=>c!=='COMPLETION');
        assert.equal((await pending.service.retryBookkeeping({continuation:uncertain.continuation})).outcome,'ACCEPTED');
        assert.deepEqual(pending.calls.filter(c=>c!=='COMPLETION'),before);
        assert.equal(pending.gateway.cancelOrder.mock.calls.length,1);
        assert.equal((await pending.service.retryBookkeeping({continuation:uncertain.continuation})).kind,'REFUSED');
        console.log('COMMONJS_ORIGINAL_WATCH_BEHAVIOR_PINNED');
      })().catch(() => { console.error('COMMONJS_BEHAVIOR_REGRESSION_FAILED'); process.exitCode=1; });
    `, format === 'tsc' ? compiledRoot : path.resolve('src'), format === 'tsc' ? fixtureFile : tsxFixtureFile, timing, operation, format === 'tsc' ? 'js' : 'ts'], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, windowsHide: true });
    expect(output.trim()).toBe('COMMONJS_ORIGINAL_WATCH_BEHAVIOR_PINNED');
  }, 70_000);

  it.each(['tsc', 'tsx'].flatMap(format => ['before', 'after'].flatMap(timing => ['assignment', 'reflect', 'define', 'delete'].map(operation => [format, timing, operation] as const))))('%s %s consumer import: %s cannot redirect the final dispatch call chain', (format, timing, operation) => {
    const output = execFileSync(process.execPath, [...(format === 'tsx' ? ['--require', 'tsx/cjs'] : []), '-e', String.raw`
      'use strict';
      const assert=require('assert/strict'),path=require('path');
      const [root,fixturePath,timing,operation,extension]=process.argv.slice(1);
      const file=p=>path.join(root,'execution/live',p+'.'+extension);
      const namespace=require(file('practical-cancel/gateway-boundary'));
      const Boundary=namespace.PracticalCancelGatewayBoundary,invoke=Boundary.prototype.invoke,guard=namespace.checkPracticalCancelGuard;
      const Recovery=require(file('practical-recovery/service')).PracticalRecoveryService;
      const Owner=require(file('practical-mutation/ticket')).PracticalCancelDispatchOwner;
      const proof=require(file('practical-cancel-transport-evidence'));
      const transportNamespace=require(path.join(root,'integration/coindcx/live/mutation-transport.'+extension));
      const gatewayNamespace=require(path.join(root,'integration/coindcx/live/order-gateway.'+extension));
      const Transport=transportNamespace.CoinDcxOrderMutationTransport,Gateway=gatewayNamespace.CoinDcxLiveFuturesOrderGateway;
      const consumer=file('practical-cancel/service'),{makeFixture}=require(fixturePath);
      assert.equal(require.cache[require.resolve(consumer)],undefined);
      let serviceNamespace=null,current=null,redirectedCalls=0,forgedConstructions=0;
      const redirect=async attempt=>{
        redirectedCalls++;
        const a=Owner.read(attempt).armed;
        await current.gateway.cancelOrder({clientOrderId:a.clientOrderId,exchangeOrderId:a.exchangeOrderId,pair:a.pair,timeoutMs:1000});
        return {kind:'NOT_ENTERED',code:'ORIGINAL_WATCH_REFUSED'};
      };
      const forgedConstructor=function(dependencies){forgedConstructions++;return {invoke:async attempt=>{
        redirectedCalls++;await dependencies.gateway.cancelOrder({clientOrderId:Owner.read(attempt).armed.clientOrderId});
        return {kind:'NOT_ENTERED',code:'ORIGINAL_WATCH_REFUSED'};
      }};};
      const mutate=(object,key,value)=>{
        const original=object[key];
        if(operation==='assignment')assert.throws(()=>{object[key]=value},TypeError);
        if(operation==='reflect')assert.equal(Reflect.set(object,key,value),false);
        if(operation==='define')assert.throws(()=>Object.defineProperty(object,key,{value}),TypeError);
        if(operation==='delete'){
          if(Object.hasOwn(object,key))assert.throws(()=>{delete object[key]},TypeError);
          else assert.equal(delete object[key],true); // inherited lookup is unchanged
        }
        assert.equal(object[key],original);
      };
      const attack=h=>{
        current=h;
        mutate(Boundary.prototype,'invoke',redirect);
        mutate(namespace,'PracticalCancelGatewayBoundary',forgedConstructor);
        mutate(namespace,'checkPracticalCancelGuard',()=>({kind:'UNCHANGED',nowMs:0}));
        for(const key of Object.keys(proof))mutate(proof,key,forgedConstructor);
        mutate(proof.CancelTransportInvocation,'invoke',redirect);
        mutate(proof.CancelTransportInvocation,'settle',()=>({noWrite:true,result:{kind:'CANCEL_ACCEPTED',observation:null}}));
        mutate(proof.CancelTransportNoWriteEvidence,'consume',()=>true);
        mutate(Transport,'executePracticalCancel',redirect);
        mutate(transportNamespace,'CoinDcxOrderMutationTransport',forgedConstructor);
        mutate(gatewayNamespace,'CoinDcxLiveFuturesOrderGateway',forgedConstructor);
        assert.equal(namespace.PracticalCancelGatewayBoundary,Boundary);
        assert.equal(Boundary.prototype.invoke,invoke);assert.equal(namespace.checkPracticalCancelGuard,guard);
        if(serviceNamespace){
          mutate(serviceNamespace,'PracticalCancelService',forgedConstructor);
          mutate(serviceNamespace,'PracticalCancelBookkeeping',forgedConstructor);
          mutate(serviceNamespace.PracticalCancelService.prototype,'cancel',redirect);
          mutate(serviceNamespace.PracticalCancelService.prototype,'retryBookkeeping',redirect);
        }
        if(h){
          assert.throws(()=>new Boundary(h.dependencies,{},h.service));
          assert.equal(Reflect.set(h.service,'cancel',redirect),false);
          assert.equal(Reflect.set(h.service,'retryBookkeeping',redirect),false);
        }
      };
      if(timing==='after')serviceNamespace=require(consumer);
      attack(null);
      (async()=>{
        const valid=await makeFixture();serviceNamespace=require(consumer);attack(valid);
        valid.hooks.CONSUMPTION=async()=>{attack(valid);assert.equal((await valid.service.cancel(valid.input)).kind,'REFUSED')};
        const [accepted,duplicate]=await Promise.all([valid.service.cancel(valid.input),valid.service.cancel(valid.input)]);
        assert.equal(accepted.outcome,'ACCEPTED');assert.equal(duplicate.kind,'REFUSED');assert.equal(valid.gateway.cancelOrder.mock.calls.length,1);
        const lost=await makeFixture();
        lost.hooks.CONSUMPTION=()=>{lost.stream.unprove();attack(lost);
          assert.equal(Recovery.checkOriginalCertificateWatch(lost.recovery,{certificate:lost.certificate,trustedNowMs:lost.clock.nowMs()}).kind,'REFUSED');};
        const refusal=await lost.service.cancel(lost.input);
        assert.equal(refusal.outcome,'PRE_DISPATCH_FAILURE');assert.equal(lost.gateway.cancelOrder.mock.calls.length,0);
        assert.deepEqual(lost.calls,['ACQUIRE','ARM','PERMISSION','CONSUMPTION']);assert.equal(lost.cleanups.length,1);
        assert.equal(lost.cleanups[0].kind,'UNENTERED');assert.equal(Owner.read(lost.cleanups[0].owner).role,'ATTEMPT');
        assert.equal(Owner.status(lost.cleanups[0].owner),'SPENT');
        const pending=await makeFixture();pending.setUnknown();const uncertain=await pending.service.cancel(pending.input);
        assert.equal(uncertain.kind,'BOOKKEEPING_PENDING');pending.stream.unprove();attack(pending);
        const before=pending.calls.filter(c=>c!=='COMPLETION');
        assert.equal((await pending.service.retryBookkeeping({continuation:uncertain.continuation})).outcome,'ACCEPTED');
        assert.deepEqual(pending.calls.filter(c=>c!=='COMPLETION'),before);assert.equal(pending.gateway.cancelOrder.mock.calls.length,1);
        assert.equal((await pending.service.retryBookkeeping({continuation:uncertain.continuation})).kind,'REFUSED');
        let nativeCalls=0;const http=require('node:http'),oldRequest=http.request;
        http.request=()=>{nativeCalls++;throw new Error('UNEXPECTED_NATIVE_REQUEST')};
        try{
          const genuine=await makeFixture();
          const gateway=new Gateway({apiKey:'synthetic-process-key',apiSecret:'synthetic-process-secret',baseUrl:'invalid-local-url',clock:genuine.clock});
          gateway.cancelOrder=()=>{redirectedCalls++;throw new Error('PUBLIC_GATEWAY_REPLACED')};
          const genuineService=new serviceNamespace.PracticalCancelService({...genuine.dependencies,gateway});
          attack(genuine);
          const [noWrite,second]=await Promise.all([genuineService.cancel(genuine.input),genuineService.cancel(genuine.input)]);
          assert.equal(noWrite.outcome,'PRE_DISPATCH_FAILURE');assert.equal(second.kind,'REFUSED');
          assert.equal(genuine.cleanups.length,1);assert.equal(genuine.cleanups[0].kind,'OUTCOME');
          assert.equal(Owner.read(genuine.cleanups[0].owner).result.kind,'PRE_DISPATCH_FAILURE');
          const lostGenuine=await makeFixture();
          const guarded=new serviceNamespace.PracticalCancelService({...lostGenuine.dependencies,gateway:new Gateway({apiKey:'synthetic-process-key',apiSecret:'synthetic-process-secret',baseUrl:'invalid-local-url',clock:lostGenuine.clock})});
          lostGenuine.hooks.CONSUMPTION=()=>{lostGenuine.stream.unprove();attack(lostGenuine)};
          assert.equal((await guarded.cancel(lostGenuine.input)).outcome,'PRE_DISPATCH_FAILURE');
          assert.equal(lostGenuine.cleanups.length,1);assert.equal(lostGenuine.cleanups[0].kind,'UNENTERED');
          assert.equal(nativeCalls,0);
        }finally{http.request=oldRequest}
        assert.equal(redirectedCalls,0);assert.equal(forgedConstructions,0);
        console.log('COMMONJS_FINAL_DISPATCH_CHAIN_PINNED');
      })().catch(()=>{console.error('COMMONJS_FINAL_DISPATCH_CHAIN_REGRESSION_FAILED');process.exitCode=1});
    `, format === 'tsc' ? compiledRoot : path.resolve('src'), format === 'tsc' ? fixtureFile : tsxFixtureFile, timing, operation, format === 'tsc' ? 'js' : 'ts'], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, windowsHide: true });
    expect(output.trim()).toBe('COMMONJS_FINAL_DISPATCH_CHAIN_PINNED');
  }, 70_000);

  it.each(['tsc', 'tsx'].flatMap(format => ['before', 'after'].flatMap(timing => ['assignment', 'reflect', 'define', 'delete'].map(operation => [format, timing, operation] as const))))('%s %s import: %s cannot reopen lifecycle or bypass stopped final entry', (format, timing, operation) => {
    const output = execFileSync(process.execPath, [...(format === 'tsx' ? ['--require', 'tsx/cjs'] : []), '-e', String.raw`
      'use strict'; const assert=require('assert/strict'),path=require('path');
      const [root,fixturePath,timing,operation,extension]=process.argv.slice(1);
      const file=p=>path.join(root,'execution/live/practical-cancel',p+'.'+extension);
      const lifecycle=require(file('lifecycle')),Class=lifecycle.PracticalCancelLifecycle;
      const {makeFixture}=require(fixturePath); let serviceNamespace=null;
      const mutate=(object,key,value)=>{
        const original=object[key];
        if(operation==='assignment')assert.throws(()=>{object[key]=value},TypeError);
        if(operation==='reflect')assert.equal(Reflect.set(object,key,value),false);
        if(operation==='define')assert.throws(()=>Object.defineProperty(object,key,{value}),TypeError);
        if(operation==='delete'){
          if(Object.hasOwn(object,key))assert.throws(()=>{delete object[key]},TypeError);
          else assert.equal(delete object[key],true); // inherited lookup is unchanged
        }
        assert.equal(object[key],original);
      };
      const attack=h=>{
        for(const key of Object.keys(lifecycle))mutate(lifecycle,key,()=>({kind:'UNCHANGED'}));
        for(const key of ['matches','open','close'])mutate(Class,key,()=>true);
        mutate(Class.prototype,'toJSON',()=>({}));
        if(serviceNamespace){for(const key of ['requestStop','drain'])mutate(serviceNamespace.PracticalCancelService.prototype,key,()=>({kind:'LOCAL_DRAINED'}));}
        if(h){for(const key of ['requestStop','drain'])mutate(h.service,key,()=>({kind:'LOCAL_DRAINED'}));}
      };
      if(timing==='after')serviceNamespace=require(file('service')); attack(null);
      (async()=>{
        const h=await makeFixture(); serviceNamespace=require(file('service')); attack(h);
        assert.equal(h.service.requestStop().kind,'ADMISSION_CLOSED');attack(h);
        assert.equal((await h.service.cancel(h.input)).code,'ADMISSION_CLOSED'); assert.equal(h.calls.length,0);assert.equal(h.gateway.cancelOrder.mock.calls.length,0);
        assert.equal((await h.service.drain()).kind,'LOCAL_DRAINED');
        const loss=await makeFixture();loss.hooks.CONSUMPTION=()=>{loss.service.requestStop();attack(loss)};
        assert.equal((await loss.service.cancel(loss.input)).outcome,'PRE_DISPATCH_FAILURE');assert.equal(loss.gateway.cancelOrder.mock.calls.length,0);
        assert.equal(loss.cleanups.length,1);assert.equal(loss.cleanups[0].kind,'UNENTERED');assert.equal((await loss.service.drain()).kind,'LOCAL_DRAINED');
        const pending=await makeFixture();pending.setUnknown();const result=await pending.service.cancel(pending.input);assert.equal(result.kind,'BOOKKEEPING_PENDING');
        pending.service.requestStop();attack(pending);assert.equal((await pending.service.drain()).kind,'LOCAL_DRAINED');
        assert.equal(pending.cleanups[0].owner,pending.cleanups[1].owner);assert.equal(pending.gateway.cancelOrder.mock.calls.length,1);
        assert.equal(pending.calls.filter(c=>c==='ACQUIRE').length,1);assert.equal(pending.calls.filter(c=>c==='CONSUMPTION').length,1);
        const valid=await makeFixture();attack(valid);assert.equal((await valid.service.cancel(valid.input)).outcome,'ACCEPTED');assert.equal(valid.gateway.cancelOrder.mock.calls.length,1);
        console.log('LOCAL_LIFECYCLE_BEHAVIOR_PINNED');
      })().catch(()=>{console.error('LOCAL_LIFECYCLE_BEHAVIOR_FAILED');process.exitCode=1});
    `, format === 'tsc' ? compiledRoot : path.resolve('src'), format === 'tsc' ? fixtureFile : tsxFixtureFile, timing, operation, format === 'tsc' ? 'js' : 'ts'], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, windowsHide: true });
    expect(output.trim()).toBe('LOCAL_LIFECYCLE_BEHAVIOR_PINNED');
  }, 70_000);

  it.each(['tsc', 'tsx'] as const)('%s native lifecycle associations reject genuine foreign owners/dependencies and cloned values', format => {
    // Privileged internal brand fixture, isolated from production service import.
    // It exercises association identity; gateway effects above use real services/recovery.
    const output = execFileSync(process.execPath, [...(format === 'tsx' ? ['--require', 'tsx/cjs'] : []), '-e', String.raw`
      'use strict';const assert=require('assert/strict'),path=require('path');const [root,extension]=process.argv.slice(1);
      const m=require(path.join(root,'execution/live/practical-cancel/lifecycle.'+extension));
      class NativeOwner{#brand=true;static genuine(v){return typeof v==='object'&&v!==null&&#brand in v}}
      m.installPracticalCancelLifecycleBrand(v=>NativeOwner.genuine(v));
      const a=new NativeOwner,b=new NativeOwner,da=Object.freeze({}),db=Object.freeze({});
      const one=m.createPracticalCancelLifecycle(a,da),two=m.createPracticalCancelLifecycle(b,db),C=m.PracticalCancelLifecycle;
      assert.equal(C.open(one,a,da),true);assert.equal(C.open(two,b,db),true);
      for(const [v,owner,deps] of [[one,b,da],[one,a,db],[two,a,da],[{...one},a,da],[Object.create(C.prototype),a,da],[null,a,da]]){
        assert.equal(C.open(v,owner,deps),false);assert.throws(()=>C.close(v,owner,deps));
      }
      assert.equal(C.open(one,a,da),true);C.close(one,a,da);C.close(one,a,da);assert.equal(C.open(one,a,da),false);assert.equal(C.open(two,b,db),true);
      assert.throws(()=>JSON.stringify(one));assert.throws(()=>m.createPracticalCancelLifecycle(a,da));assert.throws(()=>m.createPracticalCancelLifecycle({},da));
      console.log('NATIVE_LIFECYCLE_BINDINGS_PINNED');
    `, format === 'tsc' ? compiledRoot : path.resolve('src'), format === 'tsc' ? 'js' : 'ts'], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true });
    expect(output.trim()).toBe('NATIVE_LIFECYCLE_BINDINGS_PINNED');
  });
});
