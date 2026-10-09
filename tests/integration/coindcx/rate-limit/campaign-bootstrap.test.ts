import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeCampaignHost, startCampaignHost } from '../../../../scripts/sync-read-launch/campaign-host';
import { clientCampaignAccess, coordinatorCampaignAccess } from '../../../../scripts/sync-read-launch/campaign-access';
import { RateLimitClient } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { encodeFrame, FrameDecoder } from '../../../../src/integration/coindcx/rate-limit/runtime/framing';
import { SLOT_FILES } from '../../../../src/integration/coindcx/rate-limit/runtime/state-store';
import { hostFixture, fixtureProposal, connection, venue, ROOT, saveEvidence } from './campaign-bootstrap-support';
import { waitFor, sleep } from './support';

const hosts: Array<Awaited<ReturnType<typeof startCampaignHost>>> = [];
const clients: RateLimitClient[] = [];
const venues: Array<Awaited<ReturnType<typeof venue>>> = [];
const timers: ReturnType<typeof setInterval>[] = [];
afterEach(async () => { timers.splice(0).forEach(clearInterval); clients.splice(0).forEach(c => c.close());
  for (const h of hosts.splice(0)) await h.close(); for (const v of venues.splice(0)) await v.close(); vi.restoreAllMocks(); }, 30000);
async function host(f: ReturnType<typeof hostFixture>) { const h = await startCampaignHost(f.cfg, f.keys); hosts.push(h); return h; }
async function peer(f: ReturnType<typeof hostFixture>, role: 'READ' | 'OPERATOR_STOP', key: string) {
  const c = new RateLimitClient(f.cfg.client, clientCampaignAccess(f.cfg.installationId, role, key)); clients.push(c); return { c, connected: await c.connect() };
}
const request = { cls: 'P1' as const, operation: 'READ' as const, scope: 'API_AUTH' as const, deadlineInMs: 5000, lifetimeMs: 10000 };
const test = (name: string, body: () => Promise<void> | void) => it(name, body, 30_000);

describe('explicit isolated campaign ownership and authenticated control', () => {
  test('read capability cannot STOP, RESET, acquire mutations, change class/scope or probe; operator can STOP only', async () => {
    const f = hostFixture(), h = await host(f);
    const read = await peer(f, 'READ', f.keys.read), op = await peer(f, 'OPERATOR_STOP', f.keys.operatorStop);
    expect(read.connected && op.connected).toBe(true);
    for (const overrides of [{ operation: 'CREATE' as const }, { operation: 'CANCEL' as const }, { operation: 'PROBE' as const }, { scope: 'PUBLIC' as const }, { cls: 'P0' as const }])
      expect(await read.c.acquire({ ...request, ...overrides })).toMatchObject({ kind: 'REFUSED', code: 'CAMPAIGN_CAPABILITY_FORBIDDEN' });
    for (const action of ['STOP', 'RESET_STOP'] as const) expect(await read.c.control(action)).toMatchObject({ result: 'REJECTED', reason: 'CAMPAIGN_CONTROL_FORBIDDEN' });
    expect(await op.c.acquire(request)).toMatchObject({ kind: 'REFUSED', code: 'CAMPAIGN_CAPABILITY_FORBIDDEN' });
    expect(await op.c.control('RESET_STOP')).toMatchObject({ result: 'REJECTED' });
    expect(h.inspect().admission).toBe('OPEN');
    expect(await op.c.control('STOP')).toMatchObject({ result: 'APPLIED' });
    await waitFor(() => h.inspect().admission === 'STOPPED');
    expect(await read.c.acquire(request)).not.toMatchObject({ kind: 'GRANTED' });
    saveEvidence('control-results.json', { unauthorizedStopRejected: true, unauthorizedResetRejected: true, mutationsAndProbeRejected: true,
      operatorReadRejected: true, operatorResetRejected: true, operatorStopDurable: true, productionCredentialsSent: false, windowsAclEnforced: false });
  });
  test('forged operator capability, wrong key/installation and unauthenticated peers cannot connect', async () => {
    const f = hostFixture(); await host(f);
    expect((await peer(f, 'OPERATOR_STOP', f.keys.read)).connected).toBe(false);
    expect((await peer(f, 'READ', '0'.repeat(64))).connected).toBe(false);
    const wrong = new RateLimitClient(f.cfg.client, clientCampaignAccess(`c${'0'.repeat(32)}`, 'READ', f.keys.read)); clients.push(wrong); expect(await wrong.connect()).toBe(false);
    const none = new RateLimitClient(f.cfg.client); clients.push(none); expect(await none.connect()).toBe(false);
    const socket = net.connect(f.pipePath), decoder = new FrameDecoder(65536); const messages: Array<Record<string, unknown>> = [];
    socket.on('data', (b: Buffer) => { const result = decoder.push(b); if (result.kind === 'FRAMES') messages.push(...result.frames as Array<Record<string, unknown>>); });
    socket.on('error', () => undefined);
    await waitFor(() => messages.find(m => m['t'] === 'CHALLENGE'));
    const challenge = String(messages[0]!['nonce']);
    const hello = { t: 'HELLO' as const, v: 1 as const, probeScopes: [] };
    socket.write(encodeFrame({ ...hello, access: { installationId: f.cfg.installationId, capability: 'OPERATOR_STOP',
      proof: clientCampaignAccess(f.cfg.installationId, 'READ', f.keys.read).helloProof(challenge, hello) } }, 65536));
    await waitFor(() => socket.destroyed); expect(messages.some(m => m['t'] === 'WELCOME')).toBe(false);
  });
  test('coordinator proof binds role, installation and fresh challenge; forged/replayed welcome is rejected', () => {
    const f = hostFixture(false), auth = clientCampaignAccess(f.cfg.installationId, 'READ', f.keys.read);
    const welcome = { t: 'WELCOME' as const, epoch: `e${'1'.repeat(32)}`, sessionId: `s${'1'.repeat(32)}`, clientInstanceId: `c${'1'.repeat(32)}`,
      resumeSecret: '2'.repeat(64), state: { admission: 'OPEN' as const, blockedScopes: [], unknown: false },
      access: { installationId: f.cfg.installationId, capability: 'READ' as const, proof: '0'.repeat(64) } };
    expect(auth.verifyWelcome('3'.repeat(64), welcome)).toBe(false);
    welcome.access.proof = coordinatorCampaignAccess(f.cfg.installationId, f.keys).welcomeProof('3'.repeat(64), 'READ', welcome);
    expect(auth.verifyWelcome('3'.repeat(64), welcome)).toBe(true);
    expect(auth.verifyWelcome('4'.repeat(64), welcome)).toBe(false);
    expect(auth.verifyWelcome('3'.repeat(64), { ...welcome, sessionId: `s${'2'.repeat(32)}` })).toBe(false);
  });
  test('second instance, altered policy/keys and stale ownership fail without resetting state', async () => {
    const f = hostFixture(), h = await host(f);
    const before = fs.readFileSync(path.join(f.directory, 'state.slot-a'));
    await expect(startCampaignHost(f.cfg, f.keys)).rejects.toThrow();
    await expect(startCampaignHost({ ...f.cfg, supervision: { ...f.cfg.supervision, leaseMs: 16000 } }, f.keys)).rejects.toThrow('INCOMPATIBLE');
    await expect(startCampaignHost(f.cfg, { ...f.keys, read: '0'.repeat(64) })).rejects.toThrow('INCOMPATIBLE');
    expect(fs.readFileSync(path.join(f.directory, 'state.slot-a'))).toEqual(before); expect(h.inspect().unknown).toBeNull();
  });
  test('initialization rejects existing namespaces and invalid confirmation; failed initialization remains unrepairable', async () => {
    const f = hostFixture(false);
    expect(() => Reflect.apply(initializeCampaignHost, undefined, [f.cfg, f.keys, 'INVALID'])).toThrow(); expect(fs.existsSync(f.directory)).toBe(false);
    const sync = vi.spyOn(fs, 'fsyncSync'); sync.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw Error('SYNTHETIC_FLUSH_FAILURE'); });
    expect(() => initializeCampaignHost(f.cfg, f.keys, 'NEW_READ_ONLY_CAMPAIGN')).toThrow('SYNTHETIC_FLUSH_FAILURE'); sync.mockRestore();
    const bytes = fs.readFileSync(path.join(f.directory, SLOT_FILES.A));
    expect(() => initializeCampaignHost(f.cfg, f.keys, 'NEW_READ_ONLY_CAMPAIGN')).toThrow();
    await expect(startCampaignHost(f.cfg, f.keys)).rejects.toThrow(); expect(fs.readFileSync(path.join(f.directory, SLOT_FILES.A))).toEqual(bytes);
  });
  test('missing-after-initialization, corrupt or incompatible slots fail closed without repair', async () => {
    for (const kind of ['missing', 'corrupt', 'incompatible'] as const) {
      const f = hostFixture(), file = path.join(f.directory, SLOT_FILES.A);
      if (kind === 'missing') fs.unlinkSync(file); else if (kind === 'corrupt') fs.writeFileSync(file, 'SYNTHETIC_CORRUPTION');
      else { const bytes = fs.readFileSync(file); bytes.writeUInt32BE(999, 8); fs.writeFileSync(file, bytes); }
      const unaffected = fs.readFileSync(path.join(f.directory, SLOT_FILES.B));
      await expect(startCampaignHost(f.cfg, f.keys)).rejects.toThrow('CORRUPT_MISSING_OR_INCOMPATIBLE');
      expect(fs.readFileSync(path.join(f.directory, SLOT_FILES.B))).toEqual(unaffected); expect(fs.existsSync(path.join(f.directory, 'OWNER.lock'))).toBe(false);
    }
  });
  test('report ownership mismatch blocks start and provider origin is refused before any request', async () => {
    const f = hostFixture();
    await expect(startCampaignHost({ ...f.cfg, expectedWindowsOwner: 'OFFLINE-WRONG-OWNER' }, f.keys)).rejects.toThrow('OWNER_MISMATCH');
    const h = await host(f); const p = fixtureProposal(h.provenance.connectionId, f.cfg.reportDirectory);
    await expect(h.run(p, connection('https://api.coindcx.com'))).rejects.toThrow('LOOPBACK_ONLY');
    expect(h.inspect().charges).toEqual([]);
    const wrong = { ...p, configuration: { ...p.configuration, reportDestination: { kind: 'LOCAL_FILE' as const, path: path.join(f.parent, 'outside.json') } } };
    await expect(h.run(wrong, connection('http://127.0.0.1:1'))).rejects.toThrow('DESTINATION_INVALID'); expect(h.inspect().charges).toEqual([]);
    const reserved = { ...p, configuration: { ...p.configuration, reportDestination: { kind: 'LOCAL_FILE' as const, path: path.join(f.cfg.reportDirectory, 'Shutdown.json') } } };
    await expect(h.run(reserved, connection('http://127.0.0.1:1'))).rejects.toThrow('DESTINATION_INVALID'); expect(h.inspect().charges).toEqual([]);
  });
  test('identity mismatch precedes scans and leaves all grants false', async () => {
    const f = hostFixture(), h = await host(f), v = await venue(() => ({ status: 200, body: { coindcx_id: 'OFFLINE-DIFFERENT' } })); venues.push(v);
    const result = await h.run(fixtureProposal(h.provenance.connectionId, f.cfg.reportDirectory), connection(v.origin));
    expect(result.report.stopReason).toBe('ACCOUNT_IDENTITY_MISMATCH'); expect(v.hits.map(hit => hit.path)).toEqual(['/exchange/v1/users/info']);
    expect(Object.values(result.report.grants).every(v => v === false)).toBe(true);
  });
  test('supervisor loss durably stops the host; later reads and heartbeats cannot resume it', async () => {
    const f = hostFixture(true, { heartbeatIntervalMs: 20, leaseMs: 1200, pollMs: 20 }), h = await host(f);
    await waitFor(() => h.inspect().stopped === 'SUPERVISOR_LEASE_EXPIRED', 5000);
    await waitFor(() => h.inspect().admission === 'STOPPED'); expect(() => h.heartbeat()).toThrow('SUPERVISION_CLOSED');
    await expect(h.run(fixtureProposal(h.provenance.connectionId, f.cfg.reportDirectory), connection('http://127.0.0.1:1'))).rejects.toThrow('NOT_AVAILABLE');
  });
  test('shutdown with active reads reports unresolved capacity, discards late results and restores STOP conservatively', async () => {
    const f = hostFixture(), h = await host(f); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const v = await venue(async (url) => url.endsWith('/users/info') ? { status: 200, body: { coindcx_id: 'OFFLINE-CAMPAIGN-ACCOUNT-IDENTIFIER' } } : held.then(() => ({ status: 200, body: [] }))); venues.push(v);
    const run = h.run(fixtureProposal(h.provenance.connectionId, f.cfg.reportDirectory), connection(v.origin));
    await waitFor(() => v.hits.length >= 3); const shutdown = await h.close(); hosts.splice(hosts.indexOf(h), 1);
    const result = await run; const frozen = JSON.stringify(result.report);
    expect(shutdown.unresolved.length).toBeGreaterThan(0); expect(shutdown.capacityRefunded).toBe(false); expect(shutdown.stopAcknowledged).toBe(true);
    expect(result.report.stopReason).toBe('CANCELLED'); expect(result.report.inFlight.unsettled.length).toBeGreaterThan(0);
    release(); await sleep(100); expect(JSON.stringify(result.report)).toBe(frozen);
    await expect(startCampaignHost(f.cfg, f.keys)).rejects.toThrow('RESTORED_UNKNOWN_OR_STOPPED');
    saveEvidence('shutdown-active-results.json', { shutdown, reportStop: result.report.stopReason, lateResultsDiscarded: true });
  });
  test('exact initialize/run CLI requires supervisor input and remains loopback-only', async () => {
    const f = hostFixture(false), v = await venue(); venues.push(v);
    const file = path.join(f.parent, 'input.json');
    fs.writeFileSync(file, JSON.stringify({ kind: 'SYNTHETIC_LOOPBACK_BOOTSTRAP_INPUT', host: f.cfg, capabilityKeys: f.keys,
      proposal: fixtureProposal('OFFLINE-TO-BE-BOUND', f.cfg.reportDirectory, 1), connection: connection(v.origin) }));
    const invoke = (action: string, extras: string[] = []) => {
      const child = spawn(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs', './scripts/coindcx-sync-read-bootstrap.ts', action, '--offline-input', file, ...extras], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => undefined); // The host deliberately closes its supervisor pipe after shutdown.
      let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += String(b); }); child.stderr.on('data', b => { stderr += String(b); });
      return { child, finished: new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => child.on('exit', code => resolve({ code, stdout, stderr }))) };
    };
    const init = await invoke('initialize', ['--confirm', 'NEW_READ_ONLY_CAMPAIGN']).finished; expect(init.code, init.stderr).toBe(0);
    const running = invoke('run'); const heartbeat = setInterval(() => { running.child.stdin.write('HEARTBEAT\n'); }, 100); timers.push(heartbeat);
    const finished = await running.finished; clearInterval(heartbeat); timers.splice(timers.indexOf(heartbeat), 1);
    expect(finished.code, finished.stderr).toBe(0); expect(finished.stdout).toContain('OFFLINE_SUPERVISED_HOST_READY'); expect(v.hits).toHaveLength(13);
    saveEvidence('bootstrap-cli-results.json', { initExit: init.code, runExit: finished.code, stdout: finished.stdout, requestCount: v.hits.length, inputContainsOnlySyntheticSecrets: true });
  });
});
