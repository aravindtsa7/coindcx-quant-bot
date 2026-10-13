/** Explicit isolated campaign host. No startup/import side effects or production budget binding. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { CoinDcxClient } from '../../src/integration/coindcx/client';
import { RateLimitCoordinator } from '../../src/integration/coindcx/rate-limit/runtime/coordinator';
import { RateLimitClient } from '../../src/integration/coindcx/rate-limit/runtime/client';
import { validateCoordinatorConfig, validateClientConfig } from '../../src/integration/coindcx/rate-limit/runtime/config';
import { initializeCampaignStateDirectory, openStateStore } from '../../src/integration/coindcx/rate-limit/runtime/state-store';
import { createCoordinatorReadBudget, type ReadBudget, type ReadBudgetRequest, type ReadPermit } from '../../src/integration/coindcx/rate-limit/runtime/read-budget';
import { providerAccountFingerprint, verifyProviderAccountIdentity } from '../../src/execution/live/reconciliation/account-identity';
import { coordinatorCampaignAccess, clientCampaignAccess, validateCampaignKeys, type CampaignKeys } from './campaign-access';
import { inspectLaunchProposal, runPreparedCollection, type LaunchProposal } from './proposal';
import { localReportSink, writeNewJson } from './report-sink';
import { validateCampaignInvocation, requireRecordedAuthorization, campaignDigest, type CampaignInvocation } from './campaign-input';
import { CAMPAIGN_READ_ENDPOINTS, campaignReadBoundary } from './campaign-read-boundary';
import { redactCampaignOutput } from './campaign-secrets';
import { GRANTS_NOTHING } from '../../src/integration/coindcx/live/sync-read-campaign-preflight';

const positive = z.number().int().positive().refine(Number.isSafeInteger);
const hostSchema = z.object({
  valuesStatus: z.literal('PROPOSED_NOT_APPROVED'), networkAccess: z.enum(['LOOPBACK_ONLY', 'COINDCX_PROVIDER_AUTHORIZATION_REQUIRED']),
  campaignId: z.string().regex(/^readonly-campaign-[a-zA-Z0-9-]{1,80}$/), installationId: z.string().regex(/^[a-z][0-9a-f]{32}$/),
  coordinator: z.unknown(), client: z.unknown(),
  supervision: z.object({ heartbeatIntervalMs: positive, leaseMs: positive, shutdownWaitMs: positive, pollMs: positive }).strict(),
  expectedWindowsOwner: z.string().min(1), ownershipCheckTimeoutMs: positive, reportDirectory: z.string().min(1),
}).strict();
export function validateCampaignHostInput(input: unknown) {
  const parsed = hostSchema.parse(input);
  const coordinator = validateCoordinatorConfig(parsed.coordinator), client = validateClientConfig(parsed.client);
  if (coordinator.kind !== 'VALID' || client.kind !== 'VALID') throw new Error('CAMPAIGN_RUNTIME_CONFIGURATION_INVALID');
  const cfg = { ...parsed, coordinator: coordinator.config, client: client.config };
  if (path.basename(cfg.coordinator.stateDirectory) !== cfg.campaignId || cfg.coordinator.pipePath !== `\\\\.\\pipe\\coindcx-readonly-campaign-${cfg.installationId}`
    || cfg.client.pipePath !== cfg.coordinator.pipePath || cfg.client.probeScopes.length !== 0
    || path.resolve(cfg.reportDirectory) !== path.join(cfg.coordinator.stateDirectory, 'reports')
    || cfg.supervision.leaseMs < 3 * cfg.supervision.heartbeatIntervalMs || cfg.supervision.pollMs > cfg.supervision.heartbeatIntervalMs) throw new Error('CAMPAIGN_NAMESPACE_OR_SUPERVISION_INVALID');
  return cfg;
}
const validated = validateCampaignHostInput;
export type CampaignHostInput = z.infer<typeof hostSchema>;
const digest = (x: unknown): string => createHash('sha256').update(JSON.stringify(x)).digest('hex');
function noLinks(target: string): void {
  let current = path.resolve(target);
  for (;;) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('CAMPAIGN_LINK_PATH_FORBIDDEN');
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
/** Owner comparison only. This does not enforce or prove restrictive ACLs, remote exclusion or process identity. */
function windowsDirectoryOwners(directories: readonly string[], timeoutMs: number): string[] {
  if (process.platform !== 'win32') throw new Error('WINDOWS_OWNER_VALIDATION_REQUIRED');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('OWNER_LOOKUP_TIMEOUT_REQUIRED');
  directories.forEach(noLinks);
  const quoted = directories.map(directory => `'${directory.replaceAll("'", "''")}'`).join(',');
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; @(${quoted}) | ForEach-Object { [PSCustomObject]@{path=$_; owner=(Get-Acl -LiteralPath $_).Owner} } | ConvertTo-Json -Compress`;
  const json = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs })) as unknown;
  const rows = Array.isArray(json) ? json : [json];
  if (rows.length !== directories.length || !rows.every((row: unknown, i) => typeof row === 'object' && row !== null && (row as { path?: unknown }).path === directories[i] && typeof (row as { owner?: unknown }).owner === 'string')) throw new Error('OWNER_LOOKUP_INVALID');
  return rows.map(row => (row as { owner: string }).owner);
}
export function windowsDirectoryOwner(directory: string, timeoutMs: number): string { return windowsDirectoryOwners([directory], timeoutMs)[0]!; }
function owners(directories: readonly string[], expected: string, timeoutMs: number): void {
  if (!directories.every(directory => fs.statSync(directory).isDirectory()) || !windowsDirectoryOwners(directories, timeoutMs).every(actual => actual.toLowerCase() === expected.toLowerCase())) throw new Error('CAMPAIGN_DIRECTORY_OWNER_MISMATCH');
}
function manifest(cfg: ReturnType<typeof validated>, keys: CampaignKeys) {
  return { format: 'readonly-campaign-installation/1', campaignId: cfg.campaignId, installationId: cfg.installationId,
    configurationSha256: digest(cfg), readCapabilitySha256: digest(keys.read), operatorCapabilitySha256: digest(keys.operatorStop) };
}
/** Deliberate operation: validates first, creates a NEW namespace, flushes manifests; partial failure is never repaired. */
export function initializeCampaignHost(input: unknown, keys: CampaignKeys, confirmation: 'NEW_READ_ONLY_CAMPAIGN'): void {
  const cfg = validated(input); validateCampaignKeys(keys);
  if (confirmation !== 'NEW_READ_ONLY_CAMPAIGN') throw new Error('CAMPAIGN_INITIALIZATION_CONFIRMATION_REQUIRED');
  owners([path.dirname(cfg.coordinator.stateDirectory)], cfg.expectedWindowsOwner, cfg.ownershipCheckTimeoutMs);
  initializeCampaignStateDirectory(cfg.coordinator.stateDirectory, cfg.coordinator.pipePath, cfg.installationId, confirmation);
  fs.mkdirSync(cfg.reportDirectory);
  owners([cfg.coordinator.stateDirectory, cfg.reportDirectory], cfg.expectedWindowsOwner, cfg.ownershipCheckTimeoutMs);
  writeNewJson(path.join(cfg.reportDirectory, 'REPORT_OWNER.json'), { campaignId: cfg.campaignId, installationId: cfg.installationId, expectedWindowsOwner: cfg.expectedWindowsOwner });
  writeNewJson(path.join(cfg.coordinator.stateDirectory, 'CAMPAIGN.json'), manifest(cfg, keys));
}
function validateInstallation(cfg: ReturnType<typeof validated>, keys: CampaignKeys): void {
  owners([cfg.coordinator.stateDirectory, cfg.reportDirectory], cfg.expectedWindowsOwner, cfg.ownershipCheckTimeoutMs);
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (JSON.stringify(read(path.join(cfg.coordinator.stateDirectory, 'CAMPAIGN.json'))) !== JSON.stringify(manifest(cfg, keys))) throw new Error('CAMPAIGN_INSTALLATION_INCOMPATIBLE');
  if (JSON.stringify(read(path.join(cfg.reportDirectory, 'REPORT_OWNER.json'))) !== JSON.stringify({ campaignId: cfg.campaignId, installationId: cfg.installationId, expectedWindowsOwner: cfg.expectedWindowsOwner })) throw new Error('CAMPAIGN_REPORT_OWNERSHIP_INVALID');
  const marker = read(path.join(cfg.coordinator.stateDirectory, 'INSTALLATION.json')) as { installationId?: unknown; initialization?: unknown };
  if (marker.installationId !== cfg.installationId || marker.initialization !== 'NEW_READ_ONLY_CAMPAIGN') throw new Error('CAMPAIGN_STATE_INITIALIZATION_INVALID');
  const opened = openStateStore(cfg.coordinator.stateDirectory, cfg.coordinator.pipePath, cfg.coordinator.maxStateBytes);
  // This host is stricter than general M2 torn-write recovery: either missing/corrupt slot blocks it; no repair.
  if (opened.kind !== 'OPEN' || opened.recoveredFrom !== 'BOTH') throw new Error('CAMPAIGN_STATE_CORRUPT_MISSING_OR_INCOMPATIBLE');
}
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// Engine/assessment observation times are non-negative safe-integer milliseconds.
// Keep the monotonic clock domain; truncate only this local producer, never provider data or engine inputs.
export const campaignObservationClock = Object.freeze({ now: () => Math.floor(performance.now()), delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('CANCELLED')); return; }
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(new Error('CANCELLED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
} });

/** Explicit start requires external heartbeats. Losing the lease latches STOP and aborts collection, never RESET. */
export async function startCampaignHost(input: unknown, keys: CampaignKeys) {
  const cfg = validated(input); validateCampaignKeys(keys); validateInstallation(cfg, keys);
  const lockPath = path.join(cfg.coordinator.stateDirectory, 'OWNER.lock');
  const lockId = randomBytes(32).toString('hex');
  const fd = fs.openSync(lockPath, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify({ installationId: cfg.installationId, owner: lockId, pid: process.pid })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const releaseOwnership = () => {
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { owner?: unknown };
    if (held.owner !== lockId) throw new Error('CAMPAIGN_OWNERSHIP_CHANGED');
    fs.unlinkSync(lockPath); // Only this process's exclusively created lease; never an existing/stale lock.
  };
  let coordinator: RateLimitCoordinator | null = null;
  const reader = new RateLimitClient(cfg.client, clientCampaignAccess(cfg.installationId, 'READ', keys.read));
  const operator = new RateLimitClient(cfg.client, clientCampaignAccess(cfg.installationId, 'OPERATOR_STOP', keys.operatorStop));
  try {
    const started = await RateLimitCoordinator.start(cfg.coordinator, {}, coordinatorCampaignAccess(cfg.installationId, keys));
    if (started.kind !== 'RUNNING') throw new Error(`CAMPAIGN_COORDINATOR_${started.kind}`);
    coordinator = started.coordinator;
    if (coordinator.state.unknown !== null || coordinator.state.admission !== 'OPEN') throw new Error('CAMPAIGN_RESTORED_UNKNOWN_OR_STOPPED');
    if (!await operator.connect() || !await reader.connect()) throw new Error('CAMPAIGN_AUTHENTICATED_CONNECTION_FAILED');
  } catch (error) { reader.close(); operator.close(); if (coordinator !== null) await coordinator.close(); releaseOwnership(); throw error; }
  const running = coordinator;
  const abort = new AbortController();
  let lastHeartbeat = performance.now(), stopped: string | null = null, closed = false, collecting = false;
  let stopAck: Promise<{ result: string; reason?: string }> | null = null;
  const status = () => ({ connected: reader.session !== null, localStop: stopped !== null,
    coordinatorStop: stopped !== null || reader.view.admission !== 'OPEN' || reader.view.unknown ? 'DURABLE' : 'NONE' });
  const stop = (reason: string) => {
    if (stopped === null) { stopped = reason; abort.abort(); stopAck = operator.requestStop(cfg.supervision.shutdownWaitMs).acknowledgement.then(ack =>
      ack.kind === 'DURABLE' ? { result: 'APPLIED' } : { result: 'REJECTED', reason: ack.reason }); }
    return stopAck!;
  };
  let authorizationExpiresAt: number | null = null, invocationConsumed = false;
  let collectionSecrets: readonly string[] = [];
  const supervised = () => {
    if (authorizationExpiresAt !== null && Date.now() >= authorizationExpiresAt) void stop('RECORDED_AUTHORIZATION_EXPIRED');
    if (performance.now() - lastHeartbeat >= cfg.supervision.leaseMs) void stop('SUPERVISOR_LEASE_EXPIRED'); return stopped === null;
  };
  const watchdog = setInterval(() => {
    if (performance.now() - lastHeartbeat >= cfg.supervision.leaseMs) void stop('SUPERVISOR_LEASE_EXPIRED');
    if (reader.session === null || operator.session === null) void stop('COORDINATOR_CONNECTION_LOST');
    if (reader.view.admission !== 'OPEN' || reader.view.unknown) void stop('COORDINATOR_STOPPED_OR_UNKNOWN');
  }, cfg.supervision.pollMs);
  const backend = createCoordinatorReadBudget(reader, { cls: 'P1', deadlineInMs: cfg.coordinator.limiter.maxRequestDeadlineMs });
  const guardedBudget: ReadBudget = Object.freeze({ async acquire(request: ReadBudgetRequest) {
    if (!supervised()) return { kind: 'REFUSED' as const, reason: 'CAMPAIGN_STOPPED' };
    const result = await backend.acquire(request);
    if (result.kind !== 'GRANTED') return result;
    const permit = result.permit;
    return { kind: 'GRANTED' as const, permit: Object.freeze({
      start<T>(create: () => T) { if (!supervised()) { permit.release(); return { kind: 'NOT_STARTED' as const, reason: 'CAMPAIGN_STOPPED' }; } return permit.start(create); },
      complete: () => permit.complete(), release: () => permit.release(), throttled: (headers: Parameters<ReadPermit['throttled']>[0]) => permit.throttled(redactCampaignOutput(headers, collectionSecrets)),
    }) };
  } });
  const provenance = Object.freeze({ installationId: cfg.installationId, campaignId: cfg.campaignId, epoch: running.epoch,
    clientInstanceId: reader.clientInstanceId!, sessionId: reader.session!.sessionId, capability: 'AUTHENTICATED_READ_P1_API_AUTH',
    connectionId: `${cfg.installationId}:${reader.clientInstanceId}`, windowsAclEnforced: false, processIdentityProven: false, remoteClientsExcluded: false });
  const collect = async (proposal: LaunchProposal, connection: { origin: string; apiKey: string; apiSecret: string }, invocation?: CampaignInvocation, authorizationSha256: string | null = null) => {
      if (collecting || closed || stopped !== null) throw new Error('CAMPAIGN_NOT_AVAILABLE');
      const origin = new URL(connection.origin);
      if (invocation?.target.kind === 'COINDCX_PROVIDER') {
        if (cfg.networkAccess !== 'COINDCX_PROVIDER_AUTHORIZATION_REQUIRED' || connection.origin !== 'https://api.coindcx.com') throw new Error('CAMPAIGN_TARGET_MODE_MISMATCH');
      } else if (cfg.networkAccess !== 'LOOPBACK_ONLY' || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('CAMPAIGN_LOOPBACK_ONLY');
      const inspected = inspectLaunchProposal(proposal), c = proposal.configuration;
      if (!inspected.configurationValid || c.budget.connectionId !== provenance.connectionId || digest(c.budget.limiter) !== digest(cfg.coordinator.limiter)
        || c.budget.admissionDeadlineMs !== cfg.coordinator.limiter.maxRequestDeadlineMs || c.budget.priorityClass !== 'P1' || c.budget.scope !== 'API_AUTH') throw new Error('CAMPAIGN_POLICY_OR_BINDING_MISMATCH');
      const report = path.resolve(c.reportDestination.path);
      if (path.dirname(report) !== cfg.reportDirectory || ['report_owner.json', 'shutdown.json'].includes(path.basename(report).toLowerCase()) || fs.existsSync(report)) throw new Error('CAMPAIGN_REPORT_DESTINATION_INVALID');
      owners([cfg.reportDirectory], cfg.expectedWindowsOwner, cfg.ownershipCheckTimeoutMs);
      const probe = path.join(cfg.reportDirectory, `access-${randomBytes(16).toString('hex')}.tmp`);
      const access = fs.openSync(probe, 'wx'); try { fs.writeFileSync(access, 'access'); fs.fsyncSync(access); } finally { fs.closeSync(access); fs.unlinkSync(probe); }
      collecting = true;
      collectionSecrets = [connection.apiKey, connection.apiSecret, keys.read, keys.operatorStop];
      try {
        const client = new CoinDcxClient({ baseUrl: origin.origin, apiKey: connection.apiKey, apiSecret: connection.apiSecret,
          timeoutMs: c.budget.transportRequestTimeoutMs, readBudget: { budget: guardedBudget, scope: 'API_AUTH' }, allowedReadEndpoints: CAMPAIGN_READ_ENDPOINTS });
        const narrowed = Object.freeze({ getUserInfoSafe: () => client.getUserInfoSafe(), listInrFuturesOrders: client.listInrFuturesOrders.bind(client), listInrFuturesPositions: client.listInrFuturesPositions.bind(client) });
        const boundary = invocation ? campaignReadBoundary(narrowed, proposal, () => { void stop('FIRST_READ_ERROR'); }) : null;
        const secrets = [connection.apiKey, connection.apiSecret, keys.read, keys.operatorStop];
        const decorate = <T>(value: T) => redactCampaignOutput(invocation ? { ...value, collectionProvenance: {
          target: invocation.target.kind, origin: invocation.target.origin, invocationSha256: campaignDigest(invocation), authorizationRecordSha256: authorizationSha256,
          accountMappingSha256: campaignDigest(invocation.accountMapping), credentialProvenanceSha256: campaignDigest(invocation.credentialProvenance),
          declaredKnownManagedConsumers: invocation.managedTraffic.knownConsumers, externalTraffic: 'UNKNOWN_NOT_CONTROLLED',
          limitsApplyTo: 'MANAGED_CAMPAIGN_COORDINATOR_TRAFFIC_ONLY', lineage: invocation.lineageProvenance.kind,
          ...boundary!.inspect(), windowsAclEnforced: false, remoteClientsExcluded: false, processIdentityProven: false,
        } } : value, secrets);
        const result = await runPreparedCollection(proposal, { client: boundary?.client ?? narrowed, authenticatedClient: { kind: 'CREDENTIAL_BOUND', accountId: c.account.accountId!, budgetConnectionId: provenance.connectionId },
          identity: { fingerprint: providerAccountFingerprint, verify: verifyProviderAccountIdentity }, coordinator: { status },
          stream: null, clock: campaignObservationClock, signal: abort.signal, reportSink: { write: (destination, value) => localReportSink.write(destination, decorate(value)) } });
        return { ...result, report: decorate(result.report) };
      } finally { collecting = false; }
  };
  return Object.freeze({ provenance,
    heartbeat() { if (!supervised() || closed) throw new Error('CAMPAIGN_SUPERVISION_CLOSED'); lastHeartbeat = performance.now(); },
    stop: () => stop('SUPERVISED_OPERATOR_STOP'),
    inspect: () => ({ stopped, charges: running.state.charges.map(charge => ({ grantId: charge.grantId, operation: charge.operation, started: charge.started, slotHeld: charge.slotHeld })), unknown: running.state.unknown,
      outboxSize: reader.outboxSize, admission: running.state.admission }),
    run: (proposal: LaunchProposal, connection: { origin: string; apiKey: string; apiSecret: string }) => collect(proposal, connection),
    /** A separate one-shot identity diagnostic. Never invokes the account-scan campaign. */
    async runIdentityDiagnostic(input: { target: 'COINDCX_PROVIDER' | 'LOOPBACK_FIXTURE'; origin: string; expectedFingerprint: string;
      transportTimeoutMs: number; reportPath: string; authorizationScope: 'SINGLE_PROVIDER_IDENTITY_READ_DIAGNOSTIC_ONLY' | 'SYNTHETIC_LOOPBACK_ONLY' }, credentials: { apiKey: string; apiSecret: string }) {
      if (invocationConsumed || collecting || closed || !supervised()) throw new Error('IDENTITY_DIAGNOSTIC_UNAVAILABLE');
      const provider = input.target === 'COINDCX_PROVIDER', url = new URL(input.origin);
      if (provider ? cfg.networkAccess !== 'COINDCX_PROVIDER_AUTHORIZATION_REQUIRED' || input.origin !== 'https://api.coindcx.com'
        || input.authorizationScope !== 'SINGLE_PROVIDER_IDENTITY_READ_DIAGNOSTIC_ONLY'
        : cfg.networkAccess !== 'LOOPBACK_ONLY' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== input.origin
          || input.authorizationScope !== 'SYNTHETIC_LOOPBACK_ONLY' || !credentials.apiKey.startsWith('OFFLINE-') || !credentials.apiSecret.startsWith('OFFLINE-')) throw new Error('IDENTITY_DIAGNOSTIC_TARGET_OR_AUTHORIZATION_INVALID');
      if (!/^[0-9a-f]{64}$/.test(input.expectedFingerprint) || !Number.isSafeInteger(input.transportTimeoutMs) || input.transportTimeoutMs <= 0
        || !path.isAbsolute(input.reportPath) || path.dirname(input.reportPath) !== cfg.reportDirectory || path.basename(input.reportPath) !== 'identity.json'
        || fs.existsSync(input.reportPath)) throw new Error('IDENTITY_DIAGNOSTIC_INPUT_OR_REPORT_INVALID');
      owners([cfg.reportDirectory], cfg.expectedWindowsOwner, cfg.ownershipCheckTimeoutMs);
      invocationConsumed = true; collecting = true;
      collectionSecrets = [credentials.apiKey, credentials.apiSecret, keys.read, keys.operatorStop];
      let observation: { observedAt: string; fingerprint: string } | null = null;
      let failure: string | null = null;
      try {
        const client = new CoinDcxClient({ baseUrl: input.origin, ...credentials, timeoutMs: input.transportTimeoutMs,
          readBudget: { budget: guardedBudget, scope: 'API_AUTH' }, allowedReadEndpoints: ['USER_INFO'] });
        const identityOnly = Object.freeze({ getUserInfoSafe: () => client.getUserInfoSafe() });
        const response = await identityOnly.getUserInfoSafe();
        if (!supervised() || stopped !== null) failure = 'LATE_RESULT_DISCARDED';
        else if (typeof response.coindcxId !== 'string' || response.coindcxId.length === 0) failure = 'IDENTITY_UNAVAILABLE';
        else observation = { observedAt: new Date().toISOString(), fingerprint: providerAccountFingerprint(response.coindcxId) };
      } catch { failure = 'IDENTITY_READ_FAILED_NO_RETRY'; }
      finally { collecting = false; await stop('IDENTITY_DIAGNOSTIC_FINISHED'); }
      const report = redactCampaignOutput({ kind: 'SINGLE_IDENTITY_DIAGNOSTIC', target: input.target, source: `${input.origin}/exchange/v1/users/info`,
        observation, comparison: observation === null ? 'NOT_OBSERVED' : observation.fingerprint === input.expectedFingerprint ? 'MATCH' : 'MISMATCH',
        failure, provenance, grants: GRANTS_NOTHING, independentlyEstablishedAsserted: false, fullCampaignRun: false }, collectionSecrets);
      writeNewJson(input.reportPath, report);
      return report;
    },
    async runCampaign(input: unknown, record: unknown, credentials: { apiKey: string; apiSecret: string }) {
      const invocation = validateCampaignInvocation(input, Date.now());
      if (invocationConsumed || campaignDigest(validated(invocation.host)) !== campaignDigest(cfg)
        || !invocation.managedTraffic.knownConsumers.some(consumer => consumer.consumerId === cfg.campaignId && consumer.coordinatorInstallationId === cfg.installationId)) throw new Error('CAMPAIGN_INVOCATION_BINDING_INVALID_OR_CONSUMED');
      if (invocation.target.kind === 'COINDCX_PROVIDER') {
        requireRecordedAuthorization(invocation, record, Date.now());
        authorizationExpiresAt = Date.parse((record as { expiresAt: string }).expiresAt);
      } else if (record !== undefined || !credentials.apiKey.startsWith('OFFLINE-') || !credentials.apiSecret.startsWith('OFFLINE-')) throw new Error('LOOPBACK_FIXTURE_INPUTS_REQUIRED');
      invocationConsumed = true;
      const p = invocation.proposal;
      const bound = { ...p, configuration: { ...p.configuration, budget: { ...p.configuration.budget, connectionId: provenance.connectionId } } };
      return collect(bound, { origin: invocation.target.origin, ...credentials }, invocation, invocation.target.kind === 'COINDCX_PROVIDER' ? campaignDigest(record) : null);
    },
    async close() {
      if (closed) throw new Error('CAMPAIGN_ALREADY_CLOSED');
      closed = true; clearInterval(watchdog); void stop('HOST_SHUTDOWN');
      const deadline = performance.now() + cfg.supervision.shutdownWaitMs;
      while (performance.now() < deadline && (running.state.charges.some(charge => charge.slotHeld) || reader.outboxSize > 0 || operator.outboxSize > 0)) await wait(cfg.supervision.pollMs);
      const shutdown = { kind: 'READ_ONLY_CAMPAIGN_SHUTDOWN', provenance, reason: stopped, stopAcknowledged: operator.stopStatus.coordinator === 'DURABLE',
        unresolved: running.state.charges.filter(charge => charge.slotHeld).map(charge => ({ grantId: charge.grantId, started: charge.started, slotHeld: true })),
        pendingReportAcks: reader.outboxSize, pendingControlAcks: operator.outboxSize, capacityRefunded: false, unknownRecoveryAttempted: false };
      let delivery: 'WRITTEN' | 'FAILED' = 'WRITTEN';
      try { owners([cfg.reportDirectory], cfg.expectedWindowsOwner, cfg.ownershipCheckTimeoutMs); writeNewJson(path.join(cfg.reportDirectory, 'shutdown.json'), shutdown); } catch { delivery = 'FAILED'; }
      reader.close(); operator.close(); await running.close(); releaseOwnership();
      return { ...shutdown, delivery };
    },
  });
}
