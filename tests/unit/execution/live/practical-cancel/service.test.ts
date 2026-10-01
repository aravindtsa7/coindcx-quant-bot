import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../../../../src/core/time/clock';
import { resolveLiveExecutionGate } from '../../../../../src/execution/live/gate';
import { PracticalRecoveryCertificate, consumePracticalRecoveryCertificate } from '../../../../../src/execution/live/practical/certificate';
import { PracticalRecoveryService } from '../../../../../src/execution/live/practical-recovery/service';
import { PracticalCancelService } from '../../../../../src/execution/live/practical-cancel/service';
import { PracticalCancelGatewayBoundary } from '../../../../../src/execution/live/practical-cancel/gateway-boundary';
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
  it.each(['UNPROVEN', 'LATCH', 'DISCONNECTED', 'JOIN_LOST', 'INCARNATION', 'CONFIRMATION', 'INVALID_EVENT', 'STATE', 'EXPIRED', 'DWELL', 'CLOCK', 'RUNTIME', 'ENABLEMENT', 'LIVE_GATE', 'ACCOUNT', 'FAKE_CHECKER'] as const)('%s refuses with zero gateway calls', async reason => {
    const h = await harness();
    const dependencies = { ...h.dependencies };
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
    const result = await new PracticalCancelService(dependencies).cancel(h.input);
    expect(result.kind).toBe('REFUSED'); expect(h.gateway.cancelOrder).not.toHaveBeenCalled(); expect(h.calls).toEqual([]);
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
        if(operation==='delete')assert.throws(()=>{delete object[key]},TypeError);
        assert.equal(object[key],original);
      };
      const attack=h=>{
        current=h;
        mutate(Boundary.prototype,'invoke',redirect);
        mutate(namespace,'PracticalCancelGatewayBoundary',forgedConstructor);
        mutate(namespace,'checkPracticalCancelGuard',()=>({kind:'UNCHANGED',nowMs:0}));
        assert.equal(namespace.PracticalCancelGatewayBoundary,Boundary);
        assert.equal(Boundary.prototype.invoke,invoke);assert.equal(namespace.checkPracticalCancelGuard,guard);
        if(serviceNamespace){
          mutate(serviceNamespace,'PracticalCancelService',forgedConstructor);
          mutate(serviceNamespace,'PracticalCancelBookkeeping',forgedConstructor);
          mutate(serviceNamespace.PracticalCancelService.prototype,'cancel',redirect);
          mutate(serviceNamespace.PracticalCancelService.prototype,'retryBookkeeping',redirect);
        }
        if(h){
          const boundary=new Boundary(h.dependencies);
          assert.equal(Reflect.set(boundary,'invoke',redirect),false);
          assert.throws(()=>Object.defineProperty(boundary,'invoke',{value:redirect}),TypeError);
          assert.equal(boundary.invoke,invoke);
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
        assert.equal(redirectedCalls,0);assert.equal(forgedConstructions,0);
        console.log('COMMONJS_FINAL_DISPATCH_CHAIN_PINNED');
      })().catch(()=>{console.error('COMMONJS_FINAL_DISPATCH_CHAIN_REGRESSION_FAILED');process.exitCode=1});
    `, format === 'tsc' ? compiledRoot : path.resolve('src'), format === 'tsc' ? fixtureFile : tsxFixtureFile, timing, operation, format === 'tsc' ? 'js' : 'ts'], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, windowsHide: true });
    expect(output.trim()).toBe('COMMONJS_FINAL_DISPATCH_CHAIN_PINNED');
  }, 70_000);
});
