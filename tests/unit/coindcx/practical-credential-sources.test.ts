import { EventEmitter } from 'node:events';
import https from 'node:https';
import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { practicalPrivateStreamReadiness } from '../../../src/execution/live/practical-recovery/private-events';
import { currentAccountContinuityCapability } from '../../../src/execution/live/reconciliation/barrier';
import { PracticalRecoveryService } from '../../../src/execution/live/practical-recovery/service';
import { createCoinDcxPracticalCredentialSources as construct, readCoinDcxPracticalCredentialSources as read,
  checkCoinDcxPracticalCredentialSources as check, checkCoinDcxCredentialScope as checkScope,
  CoinDcxCredentialOriginAssociation, type CoinDcxCredentialConstructionOptions } from '../../../src/integration/coindcx/live/practical-credential-sources';

const sockets = vi.hoisted(() => ({ created: 0, raw: null as unknown }));
vi.mock('socket.io-client', () => ({ default: vi.fn(() => {
  sockets.created++;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const joins: unknown[][] = [];
  const raw = { connected: false, joins, listeners,
    connect() { raw.connected = true; listeners.get('connect')?.(); },
    disconnect() { raw.connected = false; listeners.get('disconnect')?.('io client disconnect'); },
    on(event: string, fn: (...args: unknown[]) => void) { listeners.set(event, fn); },
    off(event: string) { listeners.delete(event); },
    emit(event: string, ...args: unknown[]) { if (event === 'join') joins.push(args); },
  };
  sockets.raw = raw;
  return raw;
}) }));
const configuration = (): CoinDcxCredentialConstructionOptions => ({ apiKey: 'synthetic-construction-key', apiSecret: 'synthetic-construction-secret',
  configuredAccountId: 'synthetic-configured-account', expectedProviderAccountFingerprint: 'a'.repeat(64) });
function make(options = configuration()) {
  const result = construct(options);
  if (result.kind !== 'CONSTRUCTED') throw new Error('FIXTURE_CONSTRUCTION_FAILED');
  return { association: result.association, sources: read(result.association)! };
}
function wire() {
  const requests: Array<{ url: URL; headers: Record<string, string>; body: string }> = [];
  const factory = vi.spyOn(https, 'request').mockImplementation(((url: URL, options: { headers: Record<string, string> }, callback: (res: unknown) => void) => {
    const observation = { url, headers: options.headers, body: '' }; requests.push(observation);
    const request = new EventEmitter() as EventEmitter & { write(body: string): void; end(): void; destroy(): void };
    request.write = body => { observation.body = body; }; request.destroy = () => undefined;
    request.end = () => queueMicrotask(() => {
      const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, destroy() {} });
      callback(response);
      response.emit('data', Buffer.from(url.pathname.includes('users/info') ? '{"coindcx_id":"synthetic-provider-id"}' : '{"message":"success","status":200,"code":200}'));
      response.emit('end');
    });
    return request;
  }) as never);
  return { requests, factory };
}
afterEach(() => { vi.restoreAllMocks(); sockets.created = 0; sockets.raw = null; });

describe('unwired genuine credential origin', () => {
  it('constructs no network/socket/lifecycle and returns the original frozen tuple repeatedly', () => {
    const native = vi.spyOn(https, 'request'); const timers = vi.spyOn(globalThis, 'setTimeout');
    const h = make();
    expect(read(h.association)).toBe(h.sources); expect(Object.isFrozen(h.sources)).toBe(true);
    expect(check(h.association, h.sources)).toEqual({ kind: 'LOCAL_CONSTRUCTION_ASSOCIATED' });
    expect(checkScope(h.association, configuration())).toMatchObject({ kind: 'REFUSED', code: 'INVALID_SCOPE' });
    expect(checkScope(h.association, { configuredAccountId: configuration().configuredAccountId, expectedProviderAccountFingerprint: 'a'.repeat(64) })).toEqual({ kind: 'CONFIGURED_SCOPE_MATCH' });
    expect(sockets.created).toBe(0); expect(native).not.toHaveBeenCalled(); expect(timers).not.toHaveBeenCalled();
    expect(h.sources.privateStream.state).toBe('STOPPED');
  });
  it('rejects scope mismatches and accessor scope without exposing values or invoking getters', () => {
    const h = make(); let getters = 0;
    const accessor = { get configuredAccountId() { getters++; return configuration().configuredAccountId; }, expectedProviderAccountFingerprint: 'a'.repeat(64) };
    expect(checkScope(h.association, accessor)).toEqual({ kind: 'REFUSED', code: 'INVALID_SCOPE' }); expect(getters).toBe(0);
    for (const scope of [{ configuredAccountId: 'foreign-account', expectedProviderAccountFingerprint: 'a'.repeat(64) },
      { configuredAccountId: configuration().configuredAccountId, expectedProviderAccountFingerprint: 'b'.repeat(64) }]) {
      expect(checkScope(h.association, scope)).toEqual({ kind: 'REFUSED', code: 'CONFIGURED_SCOPE_MISMATCH' });
    }
  });
  it.each(['same', 'different-key', 'different-secret'] as const)('refuses foreign %s bundles and mixed instances', variation => {
    const a = make(), options = { ...configuration() };
    if (variation === 'different-key') options.apiKey = 'synthetic-other-key';
    if (variation === 'different-secret') options.apiSecret = 'synthetic-other-secret';
    const b = make(options);
    expect(a.association).not.toBe(b.association);
    expect(check(a.association, b.sources)).toMatchObject({ kind: 'REFUSED' });
    for (const key of ['reader', 'privateStream', 'gateway'] as const) expect(check(a.association, { ...a.sources, [key]: b.sources[key] })).toMatchObject({ kind: 'REFUSED' });
  });
  it('rejects clones, proxies, forged brands and hostile tuple getters without inspection', () => {
    const h = make(); let callbacks = 0;
    for (const association of [{}, Object.create(Object.getPrototypeOf(h.association)), new Proxy(h.association, {})]) expect(read(association)).toBeNull();
    for (const sources of [{ ...h.sources }, new Proxy(h.sources, {}), { ...h.sources, gateway: new Proxy(h.sources.gateway, {}) },
      { get reader() { callbacks++; throw new Error('HOSTILE_TUPLE'); } }]) expect(check(h.association, sources)).toMatchObject({ kind: 'REFUSED' });
    expect(callbacks).toBe(0);
    expect(() => new CoinDcxCredentialOriginAssociation({}, {} as never)).toThrow('CREDENTIAL_ASSOCIATION_INVALID');
  });
  it.each([
    {}, { restOrigin: undefined, streamEndpoint: undefined },
    { restOrigin: 'https://api.coindcx.com/', streamEndpoint: 'wss://stream.coindcx.com/' },
  ])('accepts only the resolved default pair: %j', endpoints => { expect(construct({ ...configuration(), ...endpoints }).kind).toBe('CONSTRUCTED'); });
  it.each([
    { restOrigin: null }, { streamEndpoint: null }, { restOrigin: '' }, { streamEndpoint: ' ' },
    { restOrigin: 'https://user:password@api.coindcx.com' }, { restOrigin: 'https://api.coindcx.com?query' },
    { streamEndpoint: 'wss://stream.coindcx.com#fragment' }, { restOrigin: 'https://api.coindcx.com/path' },
    { restOrigin: 'http://api.coindcx.com' }, { streamEndpoint: 'https://stream.coindcx.com' },
    { restOrigin: 'https://other.example' }, { streamEndpoint: 'wss://other.example' },
    { restOrigin: 'https://other.example', streamEndpoint: 'wss://other.example' },
    { restOrigin: 'https://api.coindcx.com/a/../' }, { restOrigin: 'https://api.coindcx.com/%2e/' },
    { restOrigin: 'https://@api.coindcx.com' }, { streamEndpoint: 'wss://stream.coin\ndcx.com' },
  ])('refuses invalid/incompatible endpoints without resources: %j', endpoints => {
    const native = vi.spyOn(https, 'request'); expect(construct({ ...configuration(), ...endpoints } as never).kind).toBe('REFUSED');
    expect(native).not.toHaveBeenCalled(); expect(sockets.created).toBe(0);
  });
  it('captures changing getters once and signs REST, stream and mutation with retained bytes', async () => {
    const values = { ...configuration(), restOrigin: 'https://api.coindcx.com', streamEndpoint: 'wss://stream.coindcx.com' }, counts: Record<string, number> = {}; let coercion = 0;
    const options = Object.fromEntries(Object.keys(values).map(key => [key, undefined]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(options, key, { get() {
      counts[key] = (counts[key] ?? 0) + 1;
      return counts[key] === 1 ? value : { toJSON() { coercion++; throw new Error('LATE_OPTION'); } };
    } });
    const network = wire(), h = make(options as never);
    await h.sources.reader.readAccountIdentity({ accountId: values.configuredAccountId, timeoutMs: 100 });
    await h.sources.privateStream.start();
    try {
      const raw = sockets.raw as { joins: Array<[{ authSignature: string; apiKey: string }]> };
      expect(raw.joins).toHaveLength(1);
      expect(raw.joins[0]![0].apiKey).toBe(values.apiKey);
      expect(raw.joins[0]![0].authSignature).toBe(createHmac('sha256', values.apiSecret).update('{"channel":"coindcx"}').digest('hex'));
      await h.sources.gateway.cancelOrder({ clientOrderId: 'original-client', exchangeOrderId: 'original-exchange', pair: 'B-BTC_USDT', timeoutMs: 100 });
      expect(network.requests).toHaveLength(2);
      for (const request of network.requests) {
        expect(request.url.origin).toBe('https://api.coindcx.com'); expect(request.headers['X-AUTH-APIKEY']).toBe(values.apiKey);
        expect(request.headers['X-AUTH-SIGNATURE']).toBe(createHmac('sha256', values.apiSecret).update(request.body).digest('hex'));
      }
      expect(counts).toEqual(Object.fromEntries(Object.keys(values).map(key => [key, 1]))); expect(coercion).toBe(0);
    } finally { h.sources.privateStream.stop(); }
  });
  it('handles reentrant construction with separate origins and throwing getter values without partial publication', () => {
    let nested: ReturnType<typeof make> | undefined;
    const options = { ...configuration(), get apiKey() { nested = make(); return configuration().apiKey; } };
    const outer = make(options); expect(check(outer.association, nested!.sources).kind).toBe('REFUSED');
    let inspections = 0;
    const failure = new Proxy({}, { get() { inspections++; throw new Error('MUST_NOT_INSPECT'); } });
    const result = construct({ ...configuration(), get apiKey(): string { throw failure; } });
    expect(result).toEqual({ kind: 'REFUSED', code: 'OPTION_READ_FAILED' }); expect(inspections).toBe(0); expect(read(result)).toBeNull(); expect(sockets.created).toBe(0);
  });
  it('sanitizes a child-construction fault and publishes no partial association or resource', () => {
    const original = Object.defineProperty;
    const native = vi.spyOn(https, 'request');
    const failure = vi.spyOn(Object, 'defineProperty').mockImplementation((target, key, descriptor) => {
      if (key === 'getUserInfoSafe') throw new Error(JSON.stringify(configuration()));
      return original(target, key, descriptor);
    });
    try {
      const result = construct(configuration());
      expect(result).toEqual({ kind: 'REFUSED', code: 'CONSTRUCTION_FAILED' }); expect(read(result)).toBeNull();
      expect(native).not.toHaveBeenCalled(); expect(sockets.created).toBe(0);
    } finally { failure.mockRestore(); }
    expect(construct(configuration()).kind).toBe('CONSTRUCTED');
  });
  it.each(['apiKey', 'apiSecret', 'configuredAccountId', 'expectedProviderAccountFingerprint', 'restOrigin', 'streamEndpoint'] as const)('refuses callback-bearing %s without coercion', key => {
    let hooks = 0; const hostile = new Proxy({}, { get() { hooks++; throw new Error('INPUT_CALLBACK'); } });
    for (const value of [hostile, new String('boxed'), null, 1, 1n, false, Symbol('invalid')]) expect(construct({ ...configuration(), [key]: value } as never).kind).toBe('REFUSED');
    expect(hooks).toBe(0); expect(sockets.created).toBe(0);
  });
  it('rejects padded credentials, inherited/unknown/symbol options and configuration proxies', () => {
    for (const options of [{ ...configuration(), apiKey: ' padded' }, { ...configuration(), apiSecret: 'padded ' },
      Object.assign(Object.create({ inherited: true }), configuration()), { ...configuration(), transport: {} },
      { ...configuration(), [Symbol('option')]: true }, new Proxy(configuration(), {})]) expect(construct(options as never).kind).toBe('REFUSED');
  });
  it('redacts serialization, inspection, capture errors and source reflection', () => {
    const config = configuration(), h = make();
    const thrown: unknown[] = [];
    try { JSON.stringify(h.association); } catch (error) { thrown.push(error); }
    const refused = construct({ ...config, get apiKey(): string { throw new Error(JSON.stringify(config)); } });
    const surfaces = [inspect(h.association, { showHidden: true, depth: 8 }), JSON.stringify(h.sources), JSON.stringify(refused), ...thrown.map(error => inspect(error))].join('\n');
    for (const value of Object.values(config)) expect(surfaces).not.toContain(value);
    expect(Object.keys(h.association)).toEqual([]); expect(surfaces).not.toContain('cause');
  });
  it('cannot manufacture provider readiness, replace an original watch or grant strict continuity', async () => {
    vi.useFakeTimers();
    const h = make(); await h.sources.privateStream.start();
    try {
      expect(practicalPrivateStreamReadiness(h.sources.privateStream.getHealthSnapshot())).toEqual({ kind: 'UNPROVEN', reason: 'NO_PROVIDER_CONFIRMATION' });
      expect(PracticalRecoveryService.checkOriginalCertificateWatch(h.association, { certificate: h.association } as never).kind).toBe('REFUSED');
      expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
      const raw = sockets.raw as { connected: boolean; listeners: Map<string, (...args: unknown[]) => void> };
      raw.connected = false; raw.listeners.get('disconnect')?.('transport close');
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.sources.privateStream.isReconciliationRequired).toBe(true);
      expect(check(h.association, h.sources).kind).toBe('LOCAL_CONSTRUCTION_ASSOCIATED');
      expect(h.sources.privateStream.isReconciliationRequired).toBe(true);
    } finally { h.sources.privateStream.stop(); vi.useRealTimers(); }
  });
});

describe('defining-module owned lookup protection in actual module formats', () => {
  let compiled: string;
  beforeAll(() => {
    mkdirSync(path.resolve('.local'), { recursive: true });
    compiled = path.join(mkdtempSync(path.resolve('.local/credential-origin-cjs-')), 'dist');
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json', '--outDir', compiled,
      '--declaration', 'false', '--sourceMap', 'false'], { stdio: 'pipe', timeout: 120_000, windowsHide: true });
  }, 150_000);
  it.each(['tsc', 'tsx'].flatMap(format => ['before', 'after'].flatMap(timing => ['assignment', 'reflect', 'define', 'delete'].map(attack => [format, timing, attack] as const))))('%s %s construction: %s cannot replace owned construction/reads/health/signing/dispatch', (format, timing, attack) => {
    const program = String.raw`
      const assert = require('node:assert/strict'), path = require('node:path'), {EventEmitter}=require('node:events'), crypto=require('node:crypto');
      const [base, extension, timing, attack] = process.argv.slice(1); let socketCalls=0, writes=0;
      const socketFactory=()=>{ socketCalls++; const socket=new EventEmitter(); socket.connected=false;
        socket.connect=()=>{socket.connected=true;socket.emit('connect');}; socket.disconnect=()=>{socket.connected=false;};
        const emit=socket.emit.bind(socket); socket.emit=(event,...args)=>{if(event==='join') { assert.equal(args[0].apiKey,'synthetic-process-key'); assert.equal(args[0].authSignature,crypto.createHmac('sha256','synthetic-process-secret').update('{"channel":"coindcx"}').digest('hex')); return true; }return emit(event,...args);};return socket; };
      const socketPath=require.resolve('socket.io-client'); require(socketPath); require.cache[socketPath].exports=socketFactory;
      const load=name=>require(path.join(base,'integration/coindcx',name+'.'+extension));
      const modules=[['client','CoinDcxClient','createOwnedCoinDcxReadClient','getUserInfoSafe'],['transport','CoinDcxTransport','createOwnedCoinDcxReadTransport','executeRead'],
        ['signer','HmacSha256Signer','createOwnedCoinDcxSigner','sign'],['websocket/private-stream','CoinDcxPrivateAccountStream','createOwnedCoinDcxPrivateStream','getHealthSnapshot'],
        ['websocket/socket-adapter','ProductionCoinDcxSocketFactory','createOwnedCoinDcxSocketFactory','createSocket'],
        ['live/reconciliation-evidence-adapter','CoinDcxReconciliationEvidenceAdapter','createOwnedCoinDcxReader','readAccountIdentity'],
        ['live/mutation-transport','CoinDcxOrderMutationTransport','createOwnedCoinDcxMutationTransport','execute'],
        ['live/order-gateway','CoinDcxLiveFuturesOrderGateway','createOwnedCoinDcxMutationGateway','cancelOrder']].map(([name,cls,helper,method])=>({m:load(name),cls,helper,method}));
      function replace(object,key){try{if(attack==='assignment')object[key]=()=>{throw new Error('REDIRECTED');}; else if(attack==='reflect')Reflect.set(object,key,()=>{throw new Error('REDIRECTED');});else if(attack==='define')Object.defineProperty(object,key,{value:()=>{throw new Error('REDIRECTED');},configurable:true});else Reflect.deleteProperty(object,key);}catch{}}
      const originals=modules.map(({m,cls})=>m[cls]);
      function patch(){modules.forEach(({m,cls,helper,method},i)=>{replace(m,helper);replace(m,cls);replace(originals[i].prototype,method);});}
      if(timing==='before')patch();
      const factory=load('live/practical-credential-sources');
      const result=factory.createCoinDcxPracticalCredentialSources({apiKey:'synthetic-process-key',apiSecret:'synthetic-process-secret',configuredAccountId:'synthetic-process-account',expectedProviderAccountFingerprint:'a'.repeat(64)});
      assert.equal(result.kind,'CONSTRUCTED'); const tuple=factory.readCoinDcxPracticalCredentialSources(result.association);
      assert.equal(socketCalls,0);
      if(timing==='after')patch();
      for(const target of [tuple.reader,tuple.privateStream,tuple.gateway])for(const method of ['readAccountIdentity','getHealthSnapshot','cancelOrder'])if(Object.hasOwn(target,method))replace(target,method);
      replace(factory,'createCoinDcxPracticalCredentialSources');replace(factory,'readCoinDcxPracticalCredentialSources');replace(factory,'CoinDcxCredentialOriginAssociation');
      const https=require('node:https'); https.request=(url,options,callback)=>{assert.equal(url.origin,'https://api.coindcx.com');assert.equal(options.headers['X-AUTH-APIKEY'],'synthetic-process-key');const req=new EventEmitter();let body='';req.destroy=()=>{};req.write=b=>{body=b;writes++;assert.equal(options.headers['X-AUTH-SIGNATURE'],crypto.createHmac('sha256','synthetic-process-secret').update(b).digest('hex'));};req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={};res.destroy=()=>{};callback(res);res.emit('data',Buffer.from(url.pathname.includes('users/info')?'{"coindcx_id":"synthetic-process-provider"}':'{"message":"success","status":200,"code":200}'));res.emit('end');});return req;};
      (async()=>{ assert.equal((await tuple.reader.readAccountIdentity({accountId:'synthetic-process-account',timeoutMs:100})).kind,'OBSERVED');
        await tuple.privateStream.start();try{assert.equal(tuple.privateStream.getHealthSnapshot().authJoinSent,true);
          assert.equal((await tuple.gateway.cancelOrder({clientOrderId:'original',exchangeOrderId:'venue',pair:'B-BTC_USDT',timeoutMs:100})).kind,'CANCEL_ACCEPTED');
          assert.equal(writes,2);assert.equal(socketCalls,1);assert.equal(factory.checkCoinDcxPracticalCredentialSources(result.association,tuple).kind,'LOCAL_CONSTRUCTION_ASSOCIATED');
          console.log('RESULT:'+JSON.stringify({writes,socketCalls}));}finally{tuple.privateStream.stop();}})().catch(()=>{console.error('BEHAVIORAL_PROBE_FAILED');process.exitCode=1;});
    `;
    const output = execFileSync(process.execPath, [...(format === 'tsx' ? ['--require', 'tsx/cjs'] : []), '-e', program,
      format === 'tsc' ? compiled : path.resolve('src'), format === 'tsc' ? 'js' : 'ts', timing, attack], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    expect(output).toContain('RESULT:{"writes":2,"socketCalls":1}');
  });
});
