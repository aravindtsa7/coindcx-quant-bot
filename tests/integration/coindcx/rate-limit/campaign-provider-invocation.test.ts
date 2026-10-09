import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCampaignHost } from '../../../../scripts/sync-read-launch/campaign-host';
import { validateCampaignInvocation, campaignDigest } from '../../../../scripts/sync-read-launch/campaign-input';
import { RateLimitClient } from '../../../../src/integration/coindcx/rate-limit/runtime/client';
import { clientCampaignAccess } from '../../../../scripts/sync-read-launch/campaign-access';
import { hostFixture, fixtureProposal, venue, connection, ROOT, IDENTITY, page, saveEvidence } from './campaign-bootstrap-support';
import { waitFor, sleep } from './support';

const hosts: Array<Awaited<ReturnType<typeof startCampaignHost>>> = [], venues: Array<Awaited<ReturnType<typeof venue>>> = [], peers: RateLimitClient[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
afterEach(async () => { timers.splice(0).forEach(clearInterval); peers.splice(0).forEach(peer => peer.close());
  for (const host of hosts.splice(0)) await host.close(); for (const v of venues.splice(0)) await v.close(); vi.restoreAllMocks(); }, 30000);
function invocation(f: ReturnType<typeof hostFixture>, origin: string) {
  const p = fixtureProposal('VALIDATION_ONLY', f.cfg.reportDirectory);
  return validateCampaignInvocation({ kind: 'COINDCX_READ_ONLY_CAMPAIGN_INPUT', target: { kind: 'LOOPBACK_FIXTURE', origin }, valuesStatus: 'PROPOSED_NOT_APPROVED', host: f.cfg,
    proposal: { ...p, configuration: { ...p.configuration, budget: { ...p.configuration.budget, connectionId: null }, lineage: { kind: 'UNAVAILABLE', reason: 'OFFLINE-NO-DURABLE-LINEAGE' } } },
    accountMapping: { ...p.configuration.account, sourceReference: 'OFFLINE-INDEPENDENT-MAPPING', verifiedAt: '2026-10-08T00:00:00Z', independentlyEstablished: true },
    credentialProvenance: { accountId: p.configuration.account.accountId, sourceReference: 'OFFLINE-ENVIRONMENT-SYNTHETIC', establishedAt: '2026-10-08T00:00:00Z' },
    lineageProvenance: { kind: 'UNAVAILABLE', reason: 'OFFLINE-NO-DURABLE-LINEAGE' }, connectionBinding: 'AUTHENTICATED_CAMPAIGN_SESSION_AT_START',
    managedTraffic: { knownConsumers: [{ consumerId: f.cfg.campaignId, coordinatorInstallationId: f.cfg.installationId, operations: 'READ_P1_API_AUTH' }], externalTraffic: 'UNKNOWN_NOT_CONTROLLED' },
  }, Date.now());
}
async function host(f: ReturnType<typeof hostFixture>) {
  const h = await startCampaignHost(f.cfg, f.keys); hosts.push(h);
  const timer = setInterval(() => { if (h.inspect().stopped === null) h.heartbeat(); else clearInterval(timer); }, 100);
  timers.push(timer); return h;
}
function environment(f: ReturnType<typeof hostFixture>) {
  return { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Windows;C:\\Program Files\\nodejs', TEMP: f.parent, LOG_LEVEL: 'debug',
    COINDCX_CAMPAIGN_API_KEY: 'OFFLINE-KEY-NEVER-LOG-561', COINDCX_CAMPAIGN_API_SECRET: 'OFFLINE-SECRET-NEVER-LOG-829',
    COINDCX_CAMPAIGN_IPC_READ_KEY: f.keys.read, COINDCX_CAMPAIGN_IPC_STOP_KEY: f.keys.operatorStop };
}
const args = (action: string, file: string, extras: string[] = []) => ['--import', './node_modules/tsx/dist/loader.mjs', './scripts/coindcx-sync-read-bootstrap.ts', action, '--input', file, ...extras];
describe('provider-capable invocation verified only with synthetic inputs and loopback', () => {
  it('imports all invocation modules with zero HTTP, HTTPS or coordinator startup', () => {
    const f = hostFixture(false), file = path.join(f.parent, 'import-check.cjs');
    const modules = ['scripts/coindcx-sync-read-bootstrap.ts', 'scripts/coindcx-sync-read-launch.ts', 'scripts/sync-read-launch/campaign-entry.ts', 'scripts/sync-read-launch/campaign-input.ts'];
    fs.writeFileSync(file, `const http=require('node:http'),https=require('node:https'),net=require('node:net');let calls=0;http.request=https.request=()=>{calls++;throw Error('NETWORK_FORBIDDEN')};net.Server.prototype.listen=()=>{calls++;throw Error('BIND_FORBIDDEN')};${modules.map(module => `require(${JSON.stringify(path.join(ROOT, module))});`).join('')}console.log(JSON.stringify({calls}));`);
    const result = spawnSync(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs', file], { cwd: ROOT, encoding: 'utf8', env: { SystemRoot: 'C:\\Windows', TEMP: f.parent } });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('{"calls":0}'); expect(fs.existsSync(f.directory)).toBe(false);
    saveEvidence('provider-import-results.json', { providerRequests: 0, allRequestCalls: 0, coordinatorStarts: 0, exit: result.status });
  }, 30000);
  it('missing credentials, mapping or provider authorization refuses before state startup or any provider traffic', () => {
    const f = hostFixture(false), v = 'http://127.0.0.1:1', file = path.join(f.parent, 'input.json'), p = invocation(f, v);
    const guard = path.join(f.parent, 'forbid-network.cjs'), counter = path.join(f.parent, 'network-attempts.json');
    fs.writeFileSync(guard, `let attempts=0;require('node:http').request=require('node:https').request=()=>{attempts++;throw Error('FIXTURE_NETWORK_FORBIDDEN')};process.on('exit',()=>require('node:fs').writeFileSync(${JSON.stringify(counter)},JSON.stringify({attempts})));`);
    const guarded = (action: string) => ['--require', guard, ...args(action, file)];
    const noAttempts = () => expect(JSON.parse(fs.readFileSync(counter, 'utf8')).attempts).toBe(0);
    const env = { SystemRoot: 'C:\\Windows', TEMP: f.parent, COINDCX_API_KEY: 'OFFLINE-INHERITED-LIVE-ALIAS', COINDCX_API_SECRET: 'OFFLINE-INHERITED-LIVE-ALIAS' };
    fs.writeFileSync(file, JSON.stringify(p));
    const missing = spawnSync(process.execPath, guarded('run-loopback'), { cwd: ROOT, env, encoding: 'utf8' }); expect(missing.status).toBe(1); noAttempts();
    const { accountMapping: _mapping, ...withoutMapping } = p; fs.writeFileSync(file, JSON.stringify(withoutMapping));
    expect(spawnSync(process.execPath, guarded('run-loopback'), { cwd: ROOT, env: environment(f), encoding: 'utf8' }).status).toBe(1); noAttempts();
    const provider = { ...p, host: { ...f.cfg, networkAccess: 'COINDCX_PROVIDER_AUTHORIZATION_REQUIRED' }, target: { kind: 'COINDCX_PROVIDER', origin: 'https://api.coindcx.com' } };
    fs.writeFileSync(file, JSON.stringify(provider));
    const denied = spawnSync(process.execPath, guarded('run-provider'), { cwd: ROOT, env: environment(f), encoding: 'utf8' }); expect(denied.status).toBe(1); noAttempts();
    expect(fs.existsSync(f.directory)).toBe(false); expect(denied.stdout).toBe(''); expect(denied.stderr).not.toContain('OFFLINE-SECRET');
    saveEvidence('provider-unauthorized-results.json', { credentialsMissingRefused: missing.status, providerAuthorizationMissingRefused: denied.status, stateStarted: false, providerCalls: 0, requestGuard: 'HTTP_AND_HTTPS_FORBIDDEN', guardAttempts: 0 });
  }, 30000);
  it('the exact prepare command validates configuration without reading secrets or calling a provider', () => {
    const f = hostFixture(false), p = invocation(f, 'http://127.0.0.1:1'), file = path.join(f.parent, 'input.json');
    fs.writeFileSync(file, JSON.stringify(p)); const result = spawnSync(process.execPath, args('prepare', file), { cwd: ROOT, env: { SystemRoot: 'C:\\Windows', TEMP: f.parent }, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'CAMPAIGN_CONFIGURATION_VALID', invocationSha256: campaignDigest(p), maximumRequests: 39, readyToContactProvider: false });
    expect(fs.existsSync(f.directory)).toBe(false);
  }, 30000);
  it('real-vs-loopback mismatches and missing real authorization cannot relabel fixture provenance or create HTTPS requests', async () => {
    const f = hostFixture(), h = await host(f), p = invocation(f, 'http://127.0.0.1:1'), request = vi.spyOn(https, 'request');
    await expect(h.runCampaign({ ...p, target: { kind: 'COINDCX_PROVIDER', origin: 'https://api.coindcx.com' } }, undefined, connection(p.target.origin))).rejects.toThrow('RECORDED_PROVIDER_AUTHORIZATION');
    await expect(h.runCampaign(p, { kind: 'FIXTURE_ONLY_NOT_AUTHORIZATION' }, connection(p.target.origin))).rejects.toThrow('LOOPBACK_FIXTURE');
    await expect(h.runCampaign({ ...p, target: { kind: 'LOOPBACK_FIXTURE', origin: 'https://api.coindcx.com' } }, undefined, connection(p.target.origin))).rejects.toThrow('CAMPAIGN_INPUT_INVALID');
    expect(request).not.toHaveBeenCalled(); expect(h.inspect().charges).toEqual([]);
  }, 30000);
  it('identity mismatch makes exactly one loopback identity request and no account scan', async () => {
    const f = hostFixture(), h = await host(f), v = await venue(() => ({ status: 200, body: { coindcx_id: 'OFFLINE-WRONG-ACCOUNT' } })); venues.push(v);
    const result = await h.runCampaign(invocation(f, v.origin), undefined, connection(v.origin));
    expect(result.report.stopReason).toBe('ACCOUNT_IDENTITY_MISMATCH'); expect(v.hits.map(hit => hit.path)).toEqual(['/exchange/v1/users/info']);
    expect(Object.values(result.report.grants).every(grant => grant === false)).toBe(true);
  }, 30000);
  it('first HTTP error or 429 stops further scans, without retries, fallback or secret echoes in reports', async () => {
    const throttle = vi.spyOn(RateLimitClient.prototype, 'reportThrottled');
    for (const status of [500, 429]) {
      const f = hostFixture(), h = await host(f), v = await venue(url => url.endsWith('/users/info') ? { status: 200, body: { coindcx_id: IDENTITY } }
        : url.endsWith('/orders') ? { status, body: { message: 'OFFLINE-SECRET' }, headers: { 'retry-after': 'OFFLINE-SECRET' } } : { status: 200, body: [] }); venues.push(v);
      const result = await h.runCampaign(invocation(f, v.origin), undefined, connection(v.origin));
      const report = JSON.parse(fs.readFileSync(path.join(f.cfg.reportDirectory, 'campaign.json'), 'utf8'));
      expect(report.collectionProvenance.firstError).toBe(status === 429 ? 'HTTP_429' : 'READ_FAILED');
      const count = v.hits.length; await sleep(150); expect(v.hits).toHaveLength(count); expect(count).toBeLessThanOrEqual(3);
      expect(JSON.stringify(result)).not.toContain('OFFLINE-SECRET'); expect(Object.values(result.report.grants).every(grant => grant === false)).toBe(true);
      if (status === 429) { expect(throttle).toHaveBeenCalled(); expect(throttle.mock.calls.at(-1)![1].retryAfter).toBe('[REDACTED]'); }
      saveEvidence(`provider-first-${status}-results.json`, { target: 'LOOPBACK_FIXTURE', requestCount: count, firstError: report.collectionProvenance.firstError, stopReason: result.report.stopReason, retries: 0, providerCalls: 0 });
    }
  }, 60000);
  it('real M2 admission refusal creates no HTTP and preserves held capacity', async () => {
    const f = hostFixture(), h = await host(f), peer = new RateLimitClient(f.cfg.client, clientCampaignAccess(f.cfg.installationId, 'READ', f.keys.read)); peers.push(peer); expect(await peer.connect()).toBe(true);
    for (let i = 0; i < 2; i++) { const result = await peer.acquire({ cls: 'P1', operation: 'READ', scope: 'API_AUTH', deadlineInMs: 5000, lifetimeMs: 10000 });
      if (result.kind !== 'GRANTED') throw Error('Fixture saturation failed'); expect(result.permit.start(() => undefined).kind).toBe('STARTED'); }
    await waitFor(() => h.inspect().charges.filter(charge => charge.started && charge.slotHeld).length === 2);
    const v = await venue(); venues.push(v); const result = await h.runCampaign(invocation(f, v.origin), undefined, connection(v.origin));
    expect(v.hits).toEqual([]); expect(h.inspect().charges.filter(charge => charge.started && charge.slotHeld)).toHaveLength(2);
    expect(JSON.stringify(result.report)).toContain('BUDGET_REFUSED'); expect(result.report.status).toBe('STOPPED');
  }, 30000);
  it('supervision loss and supervised STOP abandon active reads and prevent later scans', async () => {
    for (const mode of ['LEASE', 'STOP']) {
      const f = hostFixture(true, { heartbeatIntervalMs: 20, leaseMs: 1600, pollMs: 20 }), h = await host(f);
      let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
      const v = await venue(url => url.endsWith('/users/info') ? { status: 200, body: { coindcx_id: IDENTITY } } : held.then(() => ({ status: 200, body: [] }))); venues.push(v);
      const pending = h.runCampaign(invocation(f, v.origin), undefined, connection(v.origin)); await waitFor(() => v.hits.length >= 3);
      if (mode === 'STOP') await h.stop(); else { const timer = timers.pop()!; clearInterval(timer); await waitFor(() => h.inspect().stopped === 'SUPERVISOR_LEASE_EXPIRED', 5000); }
      const result = await pending, snapshot = JSON.stringify(result.report), count = v.hits.length;
      release(); await sleep(100); expect(v.hits).toHaveLength(count); expect(JSON.stringify(result.report)).toBe(snapshot); expect(result.report.stopReason).toBe('CANCELLED');
    }
  }, 60000);
  it('exact initialize/run-loopback CLI uses real M2, keeps unavailable ownership UNKNOWN and redacts synthetic credentials', async () => {
    const f = hostFixture(false), env = environment(f), v = await venue((url, body) => ({ status: 200, body: url.endsWith('/users/info') ? { coindcx_id: IDENTITY }
      : page(body, url.endsWith('/orders')).map((row, i) => ({ ...row as Record<string, unknown>, id: `${env.COINDCX_CAMPAIGN_API_KEY}-${i}` })) })); venues.push(v);
    const file = path.join(f.parent, 'input.json'); fs.writeFileSync(file, JSON.stringify(invocation(f, v.origin)));
    const initialized = spawnSync(process.execPath, args('initialize-campaign', file, ['--confirm', 'NEW_READ_ONLY_CAMPAIGN']), { cwd: ROOT, env, encoding: 'utf8' }); expect(initialized.status, initialized.stderr).toBe(0);
    const child = spawn(process.execPath, args('run-loopback', file), { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => undefined); let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); });
    const finished = new Promise<number | null>(resolve => child.on('exit', resolve)); const timer = setInterval(() => child.stdin.write('HEARTBEAT\n'), 100); timers.push(timer);
    await waitFor(() => v.hits.length === 13, 30000); child.stdin.write('STOP\n'); expect(await finished, stderr).toBe(0);
    clearInterval(timer); timers.splice(timers.indexOf(timer), 1);
    const reportText = fs.readFileSync(path.join(f.cfg.reportDirectory, 'campaign.json'), 'utf8'), report = JSON.parse(reportText);
    expect(v.hits).toHaveLength(13); expect(v.hits[0]!.path).toBe('/exchange/v1/users/info');
    expect(report.collectionProvenance).toMatchObject({ target: 'LOOPBACK_FIXTURE', externalTraffic: 'UNKNOWN_NOT_CONTROLLED', limitsApplyTo: 'MANAGED_CAMPAIGN_COORDINATOR_TRAFFIC_ONLY', lineage: 'UNAVAILABLE', started: 13 });
    expect(report.gaps).toContainEqual({ evaluation: null, gap: 'OWNERSHIP_LINEAGE_UNAVAILABLE', detail: 'NO_DURABLE_OWNERSHIP_ASSERTIONS_SUPPLIED' });
    expect(report.observations.convergedEvaluations).toBe(0); expect(Object.keys(report.observations.records).every(key => key.endsWith(':UNRESOLVED'))).toBe(true);
    expect(report.gaps.some((gap: { gap: string }) => gap.gap === 'PRIVATE_STREAM_OBSERVATION_UNKNOWN')).toBe(true);
    for (const secret of [env.COINDCX_CAMPAIGN_API_KEY, env.COINDCX_CAMPAIGN_API_SECRET, f.keys.read, f.keys.operatorStop]) expect(reportText + stdout + stderr).not.toContain(secret);
    saveEvidence('provider-loopback-cli-results.json', { initializeExit: initialized.status, runExit: 0, target: report.collectionProvenance.target, maximumRequests: 39, stoppedAfterFirstEvaluation: true,
      actualRequests: v.hits.length, mappingVerifiedBeforeScans: true, lineageGap: true, noOwnershipInferred: true, credentialsRedacted: true, providerCalls: 0, stdout });
  }, 60000);
});
