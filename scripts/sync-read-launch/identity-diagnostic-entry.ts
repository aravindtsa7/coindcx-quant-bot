/** Explicit identity-only child. No startup, credentials or network on import. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { initializeCampaignHost, startCampaignHost, validateCampaignHostInput } from './campaign-host';
import { loadAuthorizedCredentialSource, loadIpcKeyFile } from './operator-local-secrets';
import { loadCampaignSecrets } from './campaign-secrets';

export interface IdentityDiagnosticInput {
  kind: 'IDENTITY_DIAGNOSTIC_ONLY'; target: 'COINDCX_PROVIDER' | 'LOOPBACK_FIXTURE'; origin: string;
  host: unknown; maximumPhysicalRequests: 1; transportTimeoutMs: number; journal: string;
  historical: { expectedFingerprint: string; observedAt: string; source: string };
  ipcCiphertext: string; authorization: string | null; offlineInputs?: { apiKey: string; apiSecret: string; read: string; operatorStop: string };
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function validateIdentityInput(input: IdentityDiagnosticInput, root: string): void {
  if (input.kind !== 'IDENTITY_DIAGNOSTIC_ONLY' || input.maximumPhysicalRequests !== 1 || !Number.isSafeInteger(input.transportTimeoutMs) || input.transportTimeoutMs <= 0
    || !/^[0-9a-f]{64}$/.test(input.historical.expectedFingerprint)) throw new Error('IDENTITY_INPUT_INVALID');
  const cfg = validateCampaignHostInput(input.host), inside = (file: string) => path.isAbsolute(file) && !path.relative(root, file).startsWith('..') && !path.isAbsolute(path.relative(root, file));
  if (![cfg.coordinator.stateDirectory, cfg.reportDirectory, input.journal].every(inside)) throw new Error('IDENTITY_PATH_ESCAPE');
  if (input.target === 'COINDCX_PROVIDER') {
    if (input.origin !== 'https://api.coindcx.com' || cfg.networkAccess !== 'COINDCX_PROVIDER_AUTHORIZATION_REQUIRED' || input.offlineInputs !== undefined
      || !inside(input.ipcCiphertext) || !input.authorization || !inside(input.authorization)
      || input.historical.observedAt !== '2026-09-24T13:11:41.439Z') throw new Error('IDENTITY_PROVIDER_INPUT_INVALID');
  } else {
    const url = new URL(input.origin);
    if (input.target !== 'LOOPBACK_FIXTURE' || cfg.networkAccess !== 'LOOPBACK_ONLY' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || !url.port || url.origin !== input.origin || input.authorization !== null || !input.offlineInputs?.apiKey.startsWith('OFFLINE-') || !input.offlineInputs.apiSecret.startsWith('OFFLINE-')) throw new Error('IDENTITY_LOOPBACK_INPUT_INVALID');
  }
}
export async function identityEntry(args: readonly string[]): Promise<number> {
  if (args.length !== 2 || args[0] !== '--input' || !path.isAbsolute(args[1]!)) throw new Error('IDENTITY_EXPLICIT_INPUT_REQUIRED');
  const root = path.resolve(__dirname, '../..'), file = args[1]!;
  if (path.relative(root, file).startsWith('..')) throw new Error('IDENTITY_INPUT_PATH_ESCAPE');
  const bytes = fs.readFileSync(file), input = JSON.parse(bytes.toString('utf8')) as IdentityDiagnosticInput;
  validateIdentityInput(input, root);
  const cfg = validateCampaignHostInput(input.host), inventory = JSON.parse(fs.readFileSync(path.join(root, 'runtime-inventory.json'), 'utf8')) as { powershell: { path: string } };
  const custodyCommand = `& { ${fs.readFileSync(path.join(__dirname, 'identity-custody.ps1'), 'utf8')} } -RuntimeRoot '${root.replaceAll("'", "''")}'`;
  const custody = JSON.parse(execFileSync(inventory.powershell.path, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(custodyCommand, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })) as { fileIntegrity?: boolean };
  if (custody.fileIntegrity !== true) throw new Error('IDENTITY_CUSTODY_REQUIRED');
  const provider = input.target === 'COINDCX_PROVIDER';
  if (provider) {
    const approval = JSON.parse(fs.readFileSync(input.authorization!, 'utf8')) as { kind?: string; scope?: string; inputSha256?: string; maximumPhysicalRequests?: number; fullCollectionAuthorized?: boolean };
    if (approval.kind !== 'USER_INSTRUCTION_IDENTITY_DIAGNOSTIC_ONLY' || approval.scope !== 'SINGLE_PROVIDER_IDENTITY_READ_DIAGNOSTIC_ONLY'
      || approval.maximumPhysicalRequests !== 1 || approval.inputSha256 !== hash(bytes) || approval.fullCollectionAuthorized !== false) throw new Error('IDENTITY_ONLY_AUTHORIZATION_REQUIRED');
    const offline = JSON.parse(fs.readFileSync(path.join(root, 'offline-checks-passed.json'), 'utf8')) as { passed?: boolean; checksExitCode?: number; inventorySha256?: string; providerRequests?: number };
    if (offline.passed !== true || offline.checksExitCode !== 0 || offline.providerRequests !== 0
      || offline.inventorySha256 !== hash(fs.readFileSync(path.join(root, 'runtime-inventory.json')))) throw new Error('IDENTITY_OFFLINE_CHECKS_REQUIRED');
  }
  const consumed = fs.openSync(path.join(path.dirname(input.journal), 'INVOCATION_CONSUMED.json'), 'wx');
  try { fs.writeFileSync(consumed, JSON.stringify({ target: input.target, at: new Date().toISOString(), maximumPhysicalRequests: 1 })); fs.fsyncSync(consumed); } finally { fs.closeSync(consumed); }
  // Only IPC ciphertext is decrypted here. Operational credentials remain deferred until a supervised host is ready.
  const keyEnvironment = provider ? loadIpcKeyFile(input.ipcCiphertext) : {
    COINDCX_CAMPAIGN_IPC_READ_KEY: input.offlineInputs!.read, COINDCX_CAMPAIGN_IPC_STOP_KEY: input.offlineInputs!.operatorStop };
  const keys = { read: keyEnvironment.COINDCX_CAMPAIGN_IPC_READ_KEY, operatorStop: keyEnvironment.COINDCX_CAMPAIGN_IPC_STOP_KEY };
  let host: Awaited<ReturnType<typeof startCampaignHost>> | null = null, supervisorStopped = false, heartbeatSeen = false;
  const lines = readline.createInterface({ input: process.stdin, terminal: false });
  const stop = () => { supervisorStopped = true; if (host) void host.stop(); };
  lines.on('line', line => { if (line === 'HEARTBEAT' && !supervisorStopped) { heartbeatSeen = true; try { host?.heartbeat(); } catch { stop(); } } else stop(); });
  lines.on('close', stop); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let exit = 1;
  try {
    initializeCampaignHost(cfg, keys, 'NEW_READ_ONLY_CAMPAIGN');
    host = await startCampaignHost(cfg, keys);
    if (supervisorStopped || !heartbeatSeen) { await host.stop(); throw new Error('IDENTITY_SUPERVISION_REQUIRED'); }
    host.heartbeat();
    const environment = provider ? (await loadAuthorizedCredentialSource()).environment : {
      COINDCX_CAMPAIGN_API_KEY: input.offlineInputs!.apiKey, COINDCX_CAMPAIGN_API_SECRET: input.offlineInputs!.apiSecret };
    const secrets = loadCampaignSecrets({ ...environment, ...keyEnvironment });
    const guard = createRequire(__filename)('./identity-request-guard.cjs') as { arm(origin: string, journal: string): void; inspect(): { physicalRequestCreationAttempts: number } };
    guard.arm(input.origin, input.journal);
    const report = await host.runIdentityDiagnostic({ target: input.target, origin: input.origin, expectedFingerprint: input.historical.expectedFingerprint,
      transportTimeoutMs: input.transportTimeoutMs, reportPath: path.join(cfg.reportDirectory, 'identity.json'),
      authorizationScope: provider ? 'SINGLE_PROVIDER_IDENTITY_READ_DIAGNOSTIC_ONLY' : 'SYNTHETIC_LOOPBACK_ONLY' }, secrets.credentials);
    console.log(JSON.stringify({ kind: 'IDENTITY_DIAGNOSTIC_RESULT', target: input.target, comparison: report.comparison, observation: report.observation,
      failure: report.failure, ...guard.inspect(), grants: report.grants }));
    exit = report.observation !== null && guard.inspect().physicalRequestCreationAttempts === 1 ? 0 : 1;
  } finally {
    if (host) { const shutdown = await host.close(); console.log(JSON.stringify({ ...shutdown, kind: 'IDENTITY_DIAGNOSTIC_SHUTDOWN' }));
      if (shutdown.delivery !== 'WRITTEN' || shutdown.unresolved.length || !shutdown.stopAcknowledged) exit = 1; }
    lines.removeListener('close', stop); lines.close(); process.stdin.destroy(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  return exit;
}
if (require.main === module) void identityEntry(process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(() => { console.error('IDENTITY_DIAGNOSTIC_REFUSED_OR_FAILED_NO_RETRY'); process.exitCode = 1; });
