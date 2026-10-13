import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCampaignInvocation, requireRecordedAuthorization, campaignDigest, campaignParameters } from '../../../scripts/sync-read-launch/campaign-input';
const requireLocal = createRequire(__filename);
type Result = { code: number; outcome: string; taskChildExited?: boolean };
type Hooks = { interactive: boolean; signals: EventEmitter; emit: (value: unknown) => void; validate: () => void | Promise<void>;
  supervise: (options: { onChild: () => void }) => Promise<Record<string, unknown>> };
const { runOnce } = requireLocal('../../../scripts/sync-read-launch/collection-once.cjs') as {
  runOnce: (files: Record<string, string>, hooks: Hooks) => Promise<Result>;
};
const { superviseChild } = requireLocal('../../../scripts/sync-read-launch/identity-supervisor.cjs') as {
  superviseChild: (spawnChild: () => ReturnType<typeof spawn>, supervision: Record<string, number>, deadline: number,
    options: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
const directories: string[] = [];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coindcx-once-offline-')); directories.push(directory);
  const files = { claim: path.join(directory, 'claim.json'), supervisor: path.join(directory, 'supervisor.json'), exit: path.join(directory, 'exit.json') };
  const events: unknown[] = []; let calls = 0;
  const hooks: Hooks = { interactive: true, signals: new EventEmitter(), emit: event => { events.push(event); }, validate: () => {},
    supervise: async () => { calls++; return { code: 0, signal: null, taskChildExited: true, childCreated: true, killed: false }; } };
  return { files, hooks, events, calls: () => calls };
}
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
describe('one further collection admission, synthetic and offline only', () => {
  it('admits exactly once, retaining the claim after success and refusing concurrent/repeated invocations', async () => {
    const f = fixture();
    const results = await Promise.all([runOnce(f.files, f.hooks), runOnce(f.files, f.hooks)]);
    expect(results.map(result => result.code).sort()).toEqual([0, 4]); expect(f.calls()).toBe(1);
    expect((await runOnce(f.files, f.hooks)).outcome).toBe('COLLECTION_ATTEMPT_ALREADY_CONSUMED');
    expect(f.hooks.signals.listenerCount('SIGINT')).toBe(0);
  });
  it('never admits redirected/noninteractive input', async () => {
    const f = fixture(); f.hooks.interactive = false;
    expect(await runOnce(f.files, f.hooks)).toMatchObject({ code: 3, outcome: 'INTERACTIVE_OPERATOR_CONSOLE_REQUIRED' });
    expect(fs.existsSync(f.files.claim)).toBe(false); expect(f.calls()).toBe(0);
  });
  it.each(['SUPERVISOR_CUSTODY_PREFLIGHT_FAILED', 'untrusted arbitrary error containing a synthetic secret'])('retains admission after refusal without echoing raw errors: %s', async message => {
    const f = fixture(); f.hooks.validate = () => { throw Error(message); };
    expect((await runOnce(f.files, f.hooks)).code).toBe(3); expect(f.calls()).toBe(0);
    expect((await runOnce(f.files, f.hooks)).code).toBe(4);
    expect(JSON.stringify(f.events)).not.toContain('synthetic secret');
  });
  it('rejects an expired correctly bound synthetic authorization before supervisor/credential callbacks', async () => {
    const f = fixture(), now = Date.parse('2026-10-13T00:00:00Z');
    const template = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/launch/m4-collection-input.pending.json'), 'utf8'));
    const input = validateCampaignInvocation(template, now);
    const authorization = { kind: 'RECORDED_READ_ONLY_COLLECTION_AUTHORIZATION', target: 'COINDCX_PROVIDER',
      authorizationId: 'OFFLINE-NOT-A-PROVIDER-AUTHORIZATION', authorizedBy: 'SYNTHETIC TEST', authorizedAt: '2026-10-10T18:42:53.595Z',
      expiresAt: '2026-10-10T19:42:53.595Z', invocationSha256: campaignDigest(input), accountId: input.accountMapping.accountId,
      expectedProviderAccountFingerprint: input.accountMapping.expectedProviderAccountFingerprint, scope: 'ORDERS_POSITIONS_ONLY_INFORMATION_COLLECTION',
      maximumRequests: 39, approvedProposalParametersSha256: campaignDigest(campaignParameters(input.proposal)),
      reviews: Object.fromEntries(['hostSecurity','credentialCustody','supervisorAndStop','reportAccess','stateLifecycle','aggregateManagedBudget'].map(key => [key, 'OFFLINE SYNTHETIC'])),
      residualHostAssumptions: 'EXPLICITLY_REVIEWED_NO_ACL_REMOTE_OR_PROCESS_IDENTITY_PROOF' };
    f.hooks.validate = () => requireRecordedAuthorization(input, authorization, now);
    expect(await runOnce(f.files, f.hooks)).toMatchObject({ code: 3, outcome: 'RECORDED_PROVIDER_AUTHORIZATION_MISMATCH_OR_EXPIRED' });
    expect(f.calls()).toBe(0); expect((await runOnce(f.files, f.hooks)).code).toBe(4);
  });
  it('keeps failed native startup consumed, with the exact supervisor result', async () => {
    const f = fixture(); let calls = 0;
    f.hooks.supervise = async () => { calls++; return { code: 1, signal: null, startupFailure: true,
      spawnErrorCode: 'EPERM', childCreated: false, taskChildExited: true, killed: false }; };
    expect(await runOnce(f.files, f.hooks)).toMatchObject({ code: 1, outcome: 'SUPERVISOR_CHILD_STARTUP_FAILED' });
    expect(JSON.parse(fs.readFileSync(f.files.supervisor, 'utf8')).spawnErrorCode).toBe('EPERM');
    expect((await runOnce(f.files, f.hooks)).code).toBe(4); expect(calls).toBe(1);
  });
  it('cancels before supervision and retains admission', async () => {
    const f = fixture(); f.hooks.validate = () => { f.hooks.signals.emit('SIGINT'); };
    expect(await runOnce(f.files, f.hooks)).toMatchObject({ code: 130, outcome: 'COLLECTION_CANCELLED_BEFORE_SUPERVISOR' });
    expect(f.calls()).toBe(0); expect((await runOnce(f.files, f.hooks)).code).toBe(4);
  });
  it('runs the existing piped lifecycle with synthetic credentials; stop is 130 only after confirmed exit', async () => {
    const f = fixture();
    const source = [
      "const deny=()=>{throw Error('OFFLINE_NETWORK_DISABLED')};for(const m of ['node:http','node:https']){const t=require(m);t.request=t.get=deny}",
      "const n=require('node:net');n.connect=n.createConnection=n.Socket.prototype.connect=deny;require('node:tls').connect=deny;require('node:dgram').createSocket=deny;globalThis.fetch=deny;globalThis.WebSocket=deny;",
      "if(process.env.COINDCX_CAMPAIGN_API_KEY!=='OFFLINE-KEY'||process.env.COINDCX_CAMPAIGN_API_SECRET!=='OFFLINE-SECRET')process.exit(9);let wire='';process.stdin.on('data',b=>{wire+=b;if(wire.includes('HEARTBEAT\\n')&&wire.includes('STOP\\n'))process.exit(0)});",
    ].join(';');
    f.hooks.supervise = options => superviseChild(() => spawn(process.execPath, ['-e', source], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: 'C:\\Windows',
        COINDCX_CAMPAIGN_API_KEY: 'OFFLINE-KEY', COINDCX_CAMPAIGN_API_SECRET: 'OFFLINE-SECRET' },
    }), { heartbeatIntervalMs: 10, shutdownWaitMs: 2000 }, 5000,
    { ...options, onChild: () => { options.onChild(); setTimeout(() => f.hooks.signals.emit('SIGINT'), 20); }, stopAfterMs: 200 });
    expect(await runOnce(f.files, f.hooks)).toMatchObject({ code: 130, taskChildExited: true });
    expect(f.hooks.signals.listenerCount('SIGTERM')).toBe(0);
  });
  it('reports unresolved exit as failure even after Ctrl+C', async () => {
    const f = fixture(); f.hooks.supervise = async () => { f.hooks.signals.emit('SIGINT'); return { code: 1, taskChildExited: false }; };
    expect(await runOnce(f.files, f.hooks)).toMatchObject({ code: 1, outcome: 'COLLECTION_CHILD_EXIT_UNRESOLVED' });
  });
  it('never reopens admission when evidence cannot be written', async () => {
    const f = fixture(); fs.writeFileSync(f.files.exit, 'previous evidence');
    expect(await runOnce(f.files, f.hooks)).toMatchObject({ code: 1, outcome: 'COLLECTION_EXIT_REPORT_FAILED' });
    expect(fs.readFileSync(f.files.exit, 'utf8')).toBe('previous evidence');
    expect((await runOnce(f.files, f.hooks)).code).toBe(4);
  });
});
