import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { CoinDcxPracticalAccountCoordinator, PracticalAccountStartup } from '../../../src/integration/coindcx/live/practical-account-coordinator';

// Deterministic MODEL coverage of the current production coordinator body.
// Every application dependency is doubled. This is not provider/MySQL readiness.
const emission = 'current-source-coordinator.cjs';
const code = ts.transpileModule(readFileSync(path.resolve('src/integration/coindcx/live/practical-account-coordinator.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
interface Deferred { promise: Promise<unknown>; resolve(value?: unknown): void; reject(error: unknown): void }
interface Model {
  coordinator: CoinDcxPracticalAccountCoordinator;
  calls: Array<{ name: string; time: number }>;
  advance(ms: number): Promise<void>; timers: Map<number, unknown>;
  setDrain(value: string): void; setNow(value: number): void; expireStartup(): Promise<void>;
  input(): { intentId: string }; watchLoss(): void;
}
interface Harness {
  model(options?: Record<string, unknown>): Model;
  admitted(model: Model): Promise<PracticalAccountStartup>;
  deferred(): Deferred; flush(): Promise<void>;
}
const harness = vm.runInNewContext(
  '(function(){ const vm = require("node:vm"), assert = require("node:assert/strict"); '+
  "const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};\nfunction deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject};}\nfunction model(options={}){\n let now=100000,id=0;const timers=new Map(),calls=[];let subscribed=null,watchLost=false,settlements=0;\n const record=(name,result)=>{calls.push({name,time:now}); now+=options.tickCalls?.[name]||0; if(options.throwAt===name)throw Error('MODEL_SYNC_REJECTION'); return options.waits?.[name] || (typeof result==='function'?result():result);};\n const load=options.load||Promise.resolve({kind:'NOT_FOUND'});let drainKind=options.drainKind||'LOCAL_DRAINED';\n const cert={},association={},fence={accountId:'MODEL_ACCOUNT',runtimeEpoch:'MODEL_EPOCH',reconciliationGeneration:2,revision:1};\n const recovery={recoverAtStartup:()=>record('recover',Promise.resolve({kind:'READY',account:{fence:{reconciliationGeneration:0}}})),startWatch:()=>record('startWatch',Promise.resolve({kind:'WATCHING',reconciliationGenerationAtArm:1,watch:{binding:{}}})),certifyAccount:()=>record('certify',options.certification||Promise.resolve({kind:'CERTIFIED',certificate:cert,account:{fence}})),monitorAuthority:()=>record('monitorAuthority',Promise.resolve({kind:options.invalidAuthority?'INVALIDATED':'CERTIFICATE_STILL_VALID'})),settled:()=>record(settlements++===0?'settled':'settled.final',Promise.resolve()),stopWatch:()=>record('stopWatch',Promise.resolve(options.stopWatchResult||{kind:'STOPPED'}))};\n const stream={start:()=>record('stream.start',Promise.resolve()),stop:()=>record('stream.stop'),getHealthSnapshot:()=>({syntheticFixture:true}),subscribe:fn=>{subscribed=fn;return()=>record('unsubscribe');}};\n const sources={privateStream:stream,reader:{},gateway:{}};\n class Cancel {constructor(){calls.push({name:'cancel.construct',time:now})}requestStop(){record('cancel.stop')}drain(){return record('drain',Promise.resolve({kind:drainKind}))}observeDrainWithoutRetry(){return record('drain',Promise.resolve({kind:drainKind}))}snapshotDrainWithoutRetry(){return {kind:drainKind,code:'OPERATIONAL_FAILURE'}}cancel(){return record('cancel',options.cancel||Promise.resolve({kind:'NOT_COMMITTED',certificateStatus:'ISSUED'}))}retryBookkeeping(){return record('retry',options.retry||Promise.resolve({kind:'COMPLETED'}))}}\n const deps={\n 'node:util':require('node:util'),\n '../../../execution/live/gate':{resolveLiveExecutionGate:()=>({status:'ENABLED',enablement:{}})},\n '../../../execution/live/practical/certificate':{PracticalRecoveryCertificate:{read:()=>({issuedAtMs:100000,expiresAtMs:400000}),status:()=>options.expiredCertificate?'EXPIRED':'ISSUED'}},\n '../../../execution/live/practical/policy':{issuePracticalLiveSafetyEnablement:()=>({status:'ENABLED',enablement:{ceilings:{firstMutationDwellMs:1,postIssuanceDwellMs:1}}})},\n '../../../execution/live/practical-cancel/service':{PracticalCancelService:Cancel},\n '../../../execution/live/practical-mutation/repository':{createOwnedPracticalCancelMutationStore:()=>({recoverPreviousRuntimeCancelLease:()=>record('previous',Promise.resolve({kind:'RECOVERED'}))})},\n '../../../execution/live/practical-persistence/repository':{createOwnedPracticalSafetyRepository:()=>({loadAccount:()=>record('loadAccount',load)})},\n '../../../execution/live/practical-recovery/service':{createOwnedPracticalRecoveryService:()=>recovery,PracticalRecoveryService:{checkOriginalCertificateWatch:()=>({kind:watchLost||options.expiredCertificate?'REFUSED':'UNCHANGED'})}},\n '../../../execution/live/practical-recovery/private-events':{practicalStreamHealthTrip:()=>watchLost?'MODEL_WATCH_LOST':null,practicalPrivateStreamReadiness:()=>({kind:options.unproven?'UNPROVEN':'PROVEN_READY'})},\n '../../../execution/live/reconciliation/barrier':{newLiveRuntimeIdentity:()=>({}),readLiveRuntimeEpoch:()=> 'MODEL_EPOCH'},\n '../../../execution/live/reconciliation/repository':{createOwnedLiveReconciliationRepository:()=>({})},\n '../../../execution/live/reconciliation/service':{createOwnedLiveReconciliationService:()=>({reconcileAccount:()=>record('reconcile',Promise.resolve({kind:'COMPLETED',result:{status:'HEALTHY',generation:2}}))})},\n '../../../execution/live/repository':{createOwnedLiveExecutionRepository:()=>({})},\n './practical-credential-sources':{createCoinDcxPracticalCredentialSources:()=>({kind:'CONSTRUCTED',association}),readCoinDcxPracticalCredentialSources:()=>sources,checkCoinDcxCredentialScope:()=>({kind:'CONFIGURED_SCOPE_MATCH'})}\n };\n const module={exports:{}};class FakeDate extends Date{static now(){return now}}\n const context=vm.createContext({module,exports:module.exports,require:n=>{assert(Object.hasOwn(deps,n),'unapproved model dependency');return deps[n]},Date:FakeDate,setTimeout:(fn,delay)=>{const handle=++id;timers.set(handle,{fn,due:now+delay});return handle},clearTimeout:handle=>timers.delete(handle)});\n vm.runInContext(code,context,{filename:emission});\n const construction=vm.runInContext(`module.exports.createCoinDcxPracticalAccountCoordinator({prisma:{},credentials:{apiKey:'MODEL_KEY',apiSecret:'MODEL_SECRET',configuredAccountId:'MODEL_ACCOUNT',expectedProviderAccountFingerprint:'MODEL_FINGERPRINT'},policy:{liveExecutionEnabled:'true',practicalSafetyEnabled:'true',pairAllowlist:'MODEL_PAIR',maxOrderNotionalInr:'1',requestTimeoutMs:1000}})`,context);\n assert.equal(construction.kind,'CONSTRUCTED');\n async function advance(ms){const target=now+ms;while(true){const next=[...timers].filter(([,t])=>t.due<=target).sort((a,b)=>a[1].due-b[1].due||a[0]-b[0])[0];if(!next)break;now=next[1].due;timers.delete(next[0]);next[1].fn();await flush()}now=target;await flush()}\n return{coordinator:construction.coordinator,calls,advance,timers,setDrain:v=>{drainKind=v},input:()=>vm.runInContext(`({intentId:'${'a'.repeat(64)}'})`,context),expireStartup:async()=>{const [handle,t]=[...timers].find(([,t])=>t.due===400000);now=400000;timers.delete(handle);t.fn();await flush();},setNow:v=>{now=v},watchLoss:()=>{watchLost=true;subscribed?.()}};\n}\nasync function admitted(m){const p=m.coordinator.start();await flush();await m.advance(1);const r=await p;assert.equal(r.kind,'ADMITTED');return r;}\n"+';return {model,admitted,deferred,flush}; })()',
  { require: createRequire(path.resolve('package.json')), code, emission },
) as Harness;
const { model, admitted, deferred, flush } = harness;
const count = (m: Model, name: string) => m.calls.filter(c => c.name === name).length;
const results: Record<string, unknown> = {
  loadAccount: { kind: 'NOT_FOUND' }, previous: { kind: 'RECOVERED' },
  recover: { kind: 'READY', account: { fence: { reconciliationGeneration: 0 } } },
  'stream.start': undefined, startWatch: { kind: 'WATCHING', reconciliationGenerationAtArm: 1, watch: { binding: {} } },
  reconcile: { kind: 'COMPLETED', result: { status: 'HEALTHY', generation: 2 } },
  certify: { kind: 'CERTIFIED', certificate: {}, account: { fence: { accountId: 'MODEL_ACCOUNT', runtimeEpoch: 'MODEL_EPOCH', reconciliationGeneration: 2, revision: 1 } } },
  monitorAuthority: { kind: 'CERTIFICATE_STILL_VALID' }, drain: { kind: 'LOCAL_DRAINED' },
  settled: undefined, stopWatch: { kind: 'STOPPED' }, 'settled.final': undefined,
};
describe('current-source deterministic coordinator lifecycle MODEL', () => {
  it('A: retains pending startup once; expiry never launches a successor after its late settlement', async () => {
    const d = deferred(), m = model({ load: d.promise });
    const startup = m.coordinator.start(), shutdown = m.coordinator.shutdown();
    await flush(); await m.advance(30_000);
    const first = await shutdown;
    expect(first).toMatchObject({ kind: 'SHUTDOWN_DEADLINE', phase: 'STARTUP_SETTLEMENT', pendingOperations: 1 });
    d.resolve({ kind: 'NOT_FOUND' }); await startup; await flush();
    expect(m.calls.map(c => c.name)).not.toContain('drain');
    expect(await m.coordinator.shutdown()).toMatchObject({ status: 'BUDGET_EXPIRED', pendingOperations: 0 });
  });
  it('B: stop cancels a pending observer and retains the original subscription until teardown', async () => {
    const m = model(); await admitted(m);
    const before = count(m, 'monitorAuthority'); m.coordinator.requestStop(); await m.advance(50);
    expect(count(m, 'monitorAuthority')).toBe(before); expect(count(m, 'unsubscribe')).toBe(0);
    expect(await m.coordinator.shutdown()).toMatchObject({ status: 'COMPLETE', kind: 'LOCAL_SHUTDOWN_COMPLETED' });
    expect(count(m, 'unsubscribe')).toBe(1); expect(count(m, 'stream.stop')).toBe(1);
  });
  it('C: fresh later reports observe retained settlement without repeating drain', async () => {
    const m = model({ drainKind: 'IN_FLIGHT' });
    const first = await m.coordinator.shutdown(); expect(first.status).toBe('PENDING_OBSERVATION');
    m.setDrain('LOCAL_DRAINED'); const second = await m.coordinator.shutdown();
    expect(second.status).toBe('COMPLETE'); expect(second).not.toBe(first); expect(count(m, 'drain')).toBe(1);
  });
  it.each(['sync', 'async'])('D: %s cancel rejection becomes terminal unknown effect, never stranded BUSY', async mode => {
    const d = deferred(), m = model(mode === 'sync' ? { throwAt: 'cancel' } : { cancel: d.promise }); await admitted(m);
    const work = m.coordinator.cancel(m.input()); await flush();
    if (mode === 'async') { expect(m.coordinator.snapshot().admission).toBe('BUSY'); d.reject(Error('MODEL_REJECTION')); }
    expect(await work).toMatchObject({ kind: 'BLOCKED', code: 'OPERATIONAL_FAILURE' });
    expect(m.coordinator.snapshot().admission).toBe('TERMINAL');
    expect(await m.coordinator.shutdown()).toMatchObject({ status: 'TERMINAL_REFUSAL', reason: 'CANCEL_EFFECT_UNKNOWN' });
    expect(count(m, 'drain')).toBe(0);
  });
  it.each(Object.keys(results).slice(0, 8))('stop retains the started startup await at %s and schedules no successor', async stage => {
    const d = deferred(), m = model({ waits: { [stage]: d.promise }, ...(stage === 'previous' ? { load: Promise.resolve({ kind: 'MALFORMED' }) } : {}) });
    const work = m.coordinator.start(); await flush(); expect(count(m, stage)).toBe(1);
    m.coordinator.requestStop(); const before = m.calls.length; d.resolve(results[stage]);
    expect((await work).kind).toBe('STOPPED'); await flush(); expect(m.calls.length).toBe(before);
    expect(await m.coordinator.cancel(m.input())).toMatchObject({ code: 'ADMISSION_CLOSED' });
  });
  it.each(['loadAccount', 'recover', 'stream.start', 'startWatch', 'reconcile', 'certify', 'monitorAuthority'])('startup original budget retains late result at %s without admission or restart', async stage => {
    const d = deferred(), m = model({ waits: { [stage]: d.promise } }); const p = m.coordinator.start(); await flush();
    await m.advance(300_000); expect((await p).kind).toBe('STARTUP_DEADLINE'); const before = m.calls.length;
    d.resolve(results[stage]); await flush(); expect(m.calls.length).toBe(before);
    expect(m.coordinator.start()).toBe(p); expect(m.coordinator.snapshot().admission).toBe('TERMINAL');
  });
  it.each(['drain', 'settled', 'stopWatch', 'settled.final'])('shutdown successor scheduling stops after original budget at %s', async stage => {
    const d = deferred(), m = model({ waits: { [stage]: d.promise } }); const p = m.coordinator.shutdown(); await flush();
    expect(count(m, stage)).toBe(1); await m.advance(30_000); expect((await p).status).toBe('BUDGET_EXPIRED');
    const before = m.calls.length; d.resolve(results[stage]); await flush(); expect(m.calls.length).toBe(before);
    expect((await m.coordinator.shutdown()).status).toBe('BUDGET_EXPIRED'); expect(count(m, stage)).toBe(1);
  });
  it.each(['unsubscribe', 'stream.stop'])('synchronous teardown crossing the deadline at %s cannot claim completion', async stage => {
    const m = model({ tickCalls: { [stage]: 30_000 } }); await admitted(m);
    const r = await m.coordinator.shutdown(); expect(r.status).toBe('BUDGET_EXPIRED'); expect(count(m, stage)).toBe(1);
    if (stage === 'unsubscribe') expect(count(m, 'stream.stop')).toBe(0);
    await m.coordinator.shutdown(); expect(count(m, stage)).toBe(1);
  });
  it('durable stopWatch refusal is terminal and never blindly retried', async () => {
    const m = model({ stopWatchResult: { kind: 'REFUSED' } }); await admitted(m);
    expect(await m.coordinator.shutdown()).toMatchObject({ status: 'TERMINAL_REFUSAL', reason: 'AUTHORITY_OUTSTANDING' });
    m.setDrain('LOCAL_DRAINED'); await m.coordinator.shutdown();
    expect(count(m, 'stopWatch')).toBe(1); expect(count(m, 'stream.stop')).toBe(0);
  });
  it('overlapping shutdown calls reserve every effect once and report one pending operation', async () => {
    const d = deferred(), m = model({ waits: { stopWatch: d.promise } });
    const a = m.coordinator.shutdown(), b = m.coordinator.shutdown(); await flush(); expect(count(m, 'stopWatch')).toBe(1);
    d.resolve({ kind: 'STOPPED' }); expect((await a).status).toBe('COMPLETE'); expect((await b).status).toBe('COMPLETE');
    await m.coordinator.shutdown(); expect(count(m, 'drain')).toBe(1); expect(count(m, 'stream.stop')).toBe(1);
  });
  it('an active observer is retained after stop; its rejection prevents false shutdown completion', async () => {
    const m = model(); await admitted(m); const d = deferred();
    // Change only the model's next already scheduled authority result.
    const options: Record<string, unknown> = { waits: {} };
    const n = model(options); await admitted(n); (options['waits'] as Record<string, unknown>)['monitorAuthority'] = d.promise;
    await n.advance(50); n.coordinator.requestStop(); const p = n.coordinator.shutdown(); await flush();
    d.reject(Error('MODEL_OBSERVER_REJECTION')); expect(await p).toMatchObject({ status: 'TERMINAL_REFUSAL', reason: 'OPERATIONAL_FAILURE' });
    expect(count(n, 'stopWatch')).toBe(0); expect(count(n, 'unsubscribe')).toBe(0); m.coordinator.requestStop();
  });
  it('sole post-stop bookkeeping retry token never retries a pending continuation twice', async () => {
    const pending = { kind: 'BOOKKEEPING_PENDING', phase: 'CLEANUP', code: 'OPERATIONAL_FAILURE', continuation: {} };
    const m = model({ cancel: Promise.resolve(pending), retry: Promise.resolve(pending) }); await admitted(m);
    expect(await m.coordinator.cancel(m.input())).toEqual({ kind: 'BOOKKEEPING_PENDING', phase: 'CLEANUP', code: 'OPERATIONAL_FAILURE' });
    m.setDrain('BOOKKEEPING_PENDING'); expect(await m.coordinator.shutdown()).toMatchObject({ status: 'TERMINAL_REFUSAL', reason: 'BOOKKEEPING_PENDING' });
    await m.coordinator.shutdown(); expect(count(m, 'retry')).toBe(1); expect(count(m, 'drain')).toBe(1);
  });
  it('a bookkeeping retry active when stop arrives spends the chain token', async () => {
    const pending = { kind: 'BOOKKEEPING_PENDING', phase: 'CLEANUP', code: 'OPERATIONAL_FAILURE', continuation: {} }, d = deferred();
    const m = model({ cancel: Promise.resolve(pending), retry: d.promise }); await admitted(m); await m.coordinator.cancel(m.input());
    const retry = m.coordinator.retryBookkeeping(); await flush(); const shutdown = m.coordinator.shutdown(); await flush();
    d.resolve({ kind: 'COMPLETED' }); await retry; expect((await shutdown).status).toBe('COMPLETE'); expect(count(m, 'retry')).toBe(1);
  });
  it('BUSY closes overlapping admission; a reusable result reopens only after fresh original watch checks', async () => {
    const d = deferred(), m = model({ cancel: d.promise }); await admitted(m); const work = m.coordinator.cancel(m.input()); await flush();
    expect(await m.coordinator.cancel(m.input())).toMatchObject({ code: 'ADMISSION_CLOSED' }); m.watchLoss();
    d.resolve({ kind: 'NOT_COMMITTED', certificateStatus: 'ISSUED' }); await work; expect(m.coordinator.snapshot().admission).toBe('TERMINAL');
  });
  it.each([NaN, -1, Number.MAX_SAFE_INTEGER])('invalid startup clock %s refuses once without I/O', async clock => {
    const m = model(); m.setNow(clock); const p = m.coordinator.start(); expect((await p).kind).toBe('BLOCKED');
    expect(m.coordinator.start()).toBe(p); expect(count(m, 'loadAccount')).toBe(0);
  });
  it('stop wakes an active dwell without removing watch/subscription prematurely', async () => {
    const m = model(); const p = m.coordinator.start(); await flush(); expect(m.coordinator.snapshot().phase).toBe('DWELL');
    m.coordinator.requestStop(); expect((await p).kind).toBe('STOPPED'); expect(count(m, 'unsubscribe')).toBe(0);
  });
  it('startup deadline wakes dwell and never schedules another monitor or admits', async () => {
    const m = model(); const p = m.coordinator.start(); await flush();
    // Move wall time to the absolute deadline while the original pause remains queued.
    await m.expireStartup();
    expect((await p).kind).toBe('STARTUP_DEADLINE'); expect(m.coordinator.snapshot().admission).toBe('TERMINAL');
  });
  it.each(['cancel', 'retry'])('shutdown budget retains active %s work exactly once without a late successor', async stage => {
    const d = deferred();
    const pending = { kind: 'BOOKKEEPING_PENDING', phase: 'CLEANUP', code: 'OPERATIONAL_FAILURE', continuation: {} };
    const m = model(stage === 'cancel' ? { cancel: d.promise } : { cancel: Promise.resolve(pending), retry: d.promise });
    await admitted(m);
    const cancel = m.coordinator.cancel(m.input()); await flush();
    if (stage === 'retry') { await cancel; m.setDrain('BOOKKEEPING_PENDING'); }
    const shutdown = m.coordinator.shutdown(); await flush(); expect(count(m, stage)).toBe(1);
    await m.advance(30_000); expect(await shutdown).toMatchObject({ status: 'BUDGET_EXPIRED', pendingOperations: 1 });
    const before = m.calls.length; d.resolve({ kind: 'COMPLETED' }); await cancel; await flush();
    expect(m.calls.length).toBe(before); expect(await m.coordinator.shutdown()).toMatchObject({ status: 'BUDGET_EXPIRED', pendingOperations: 0 });
    expect(count(m, 'drain')).toBe(0);
  });
  it.each(['generation', 'TTL', 'authority'])('%s refusal never becomes synthetic admission', async reason => {
    const m = model(reason === 'generation'
      ? { waits: { reconcile: Promise.resolve({ kind: 'COMPLETED', result: { status: 'HEALTHY', generation: 1 } }) } }
      : reason === 'TTL' ? { expiredCertificate: true } : { invalidAuthority: true });
    expect((await m.coordinator.start()).kind).toBe('BLOCKED'); expect(m.coordinator.snapshot().admission).toBe('TERMINAL');
  });
  it.each(['reconcile', 'certify', 'monitorAuthority'])('watch loss during %s prohibits late admission', async stage => {
    const d = deferred(), m = model({ waits: { [stage]: d.promise } }); const p = m.coordinator.start(); await flush();
    m.watchLoss(); d.resolve(results[stage]); expect((await p).kind).toBe('BLOCKED'); expect(m.coordinator.snapshot().admission).toBe('TERMINAL');
  });
  it('unproven model never reaches watch, certificate, or mutation', async () => {
    const m = model({ unproven: true }); expect(await m.coordinator.start()).toMatchObject({ kind: 'BLOCKED', phase: 'STREAM_PROOF' });
    expect(count(m, 'startWatch')).toBe(0); expect(count(m, 'certify')).toBe(0);
  });
});
