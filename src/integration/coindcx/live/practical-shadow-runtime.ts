/**
 * Phase 18B Checkpoint C: the SHADOW-ONLY composition root and CLI commands
 * (`scripts/practical-shadow.ts` is a thin wrapper).
 *
 * EXPLICITLY OPT-IN, DISABLED BY DEFAULT. `start` refuses unless
 * LIVE_PRACTICAL_SHADOW_ENABLED=true. It composes ONLY read-only pieces:
 *   - the read-only CoinDCX REST client (`../client.ts`, list/get only) behind
 *     the existing read-only evidence adapter;
 *   - the existing CoinDCX private account stream, OBSERVED (the real stream
 *     is UNPROVEN: it has no provider subscription confirmation);
 *   - the Phase 18 reconciliation state (`loadState` only) and the Stage 1B1
 *     practical account (`loadAccount` only), each wrapped so no other
 *     repository method is reachable;
 *   - the shadow calibration store (`live_practical_shadow_*` tables only).
 * It never constructs an order gateway, a mutation transport, the Phase 17
 * production runtime, a dispatch path, a certificate issuer, a revocation
 * port, or any Stage 1B1 write, and nothing in the live mutation runtime
 * imports it (pinned by architecture tests).
 *
 * SOFTWARE PROVENANCE: `start` and `stop` bind to the exact CLEAN source
 * commit. A dirty source tree (SHADOW_SOURCE_DIRTY) or an unknown one
 * (SHADOW_SOURCE_PROVENANCE_UNAVAILABLE) is refused before any database or
 * network access: no campaign row is created and nothing is resumed.
 *
 * `status`, `report`, and `replay` read the database only: no network, no
 * credentials, no provider call.
 *
 * `abort` is the separate, EXPLICIT operator abort of a campaign whose
 * binding drifted (a normal `stop` requires the same binding). It needs the
 * exact `--account`, `--campaign`, and `--reason <CODE>` on the command line,
 * writes only the shadow tables in one transaction, and never resumes,
 * collects, or touches the network. `start` never aborts anything.
 *
 * PROVIDER BINDING: the campaign configuration digest covers a safe provider
 * descriptor -- the normalized REST origin (COINDCX_BASE_URL, or the client
 * default) and the private-stream endpoint -- so a resume against another
 * CoinDCX environment is a binding mismatch. The REST client is built with
 * exactly that normalized origin. No credential is part of it.
 *
 * Credentials are read from the environment, passed to the read client and
 * the stream, and never printed or logged.
 */
import type { PrismaClient } from '@prisma/client';
import { SystemClock } from '../../../core/time/clock';
import { PrismaPracticalSafetyRepository } from '../../../execution/live/practical-persistence/repository';
import {
  PracticalShadowCampaignRunner,
  abortPracticalShadowCampaign,
  newPracticalShadowRuntimeEpoch,
  practicalShadowTierBStatus,
} from '../../../execution/live/practical-shadow/campaign';
import type { PracticalShadowSources } from '../../../execution/live/practical-shadow/collector';
import { resolvePracticalShadowConfig, type PracticalShadowConfig } from '../../../execution/live/practical-shadow/config';
import type { PracticalShadowCampaignSnapshot } from '../../../execution/live/practical-shadow/ports';
import {
  resolvePracticalShadowSourceProvenance,
  type PracticalShadowSourceProbe,
  type PracticalShadowSourceProvenance,
} from '../../../execution/live/practical-shadow/provenance';
import { replayPracticalShadowSnapshot } from '../../../execution/live/practical-shadow/replay';
import { PrismaPracticalShadowStore } from '../../../execution/live/practical-shadow/repository';
import { PrismaLiveReconciliationRepository } from '../../../execution/live/reconciliation/repository';
import { CoinDcxClient } from '../client';
import { DEFAULT_BASE_URL } from '../transport';
import { CoinDcxPrivateAccountStream } from '../websocket/private-stream';
import { SystemStreamScheduler } from '../websocket/public-stream';
import { COINDCX_DEFAULT_SOCKET_ENDPOINT, ProductionCoinDcxSocketFactory } from '../websocket/socket-adapter';
import { CoinDcxReconciliationEvidenceAdapter } from './reconciliation-evidence-adapter';

export interface PracticalShadowCliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface PracticalShadowCliContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly io: PracticalShadowCliIo;
  readonly prisma: PrismaClient;
  /**
   * Probes the source tree the process runs from (the script runs
   * `git rev-parse --verify HEAD` and `git status --porcelain`; tests inject a
   * deterministic probe). Only an exact CLEAN commit may start or stop.
   */
  readonly sourceProbe: () => PracticalShadowSourceProbe;
  /** Stop signal for `start` (SIGINT/SIGTERM in the script). Checked between evaluations. */
  readonly shouldContinue?: (() => boolean) | undefined;
}

const USAGE = 'usage: practical-shadow <start [--new|--resume] | stop | status | report | replay> [--campaign <campaignId>]'
  + ' | abort --account <accountId> --campaign <campaignId> --reason <CODE>';

const ABORT_HINT = 'To end a campaign whose binding changed, abort it EXPLICITLY: practical-shadow abort --account <accountId> --campaign <campaignId> --reason <CODE>';

function argValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
}

function requireEnv(context: PracticalShadowCliContext, name: string): string | null {
  const value = context.env[name]?.trim() ?? '';
  if (value === '') {
    context.io.err(`Refusing to run: ${name} must be set.`);
    return null;
  }
  return value;
}

interface ShadowIdentity {
  readonly accountId: string;
  readonly fingerprint: string;
  readonly cadenceMs: number;
  readonly runtimeEpoch: string;
}

function shadowIdentity(context: PracticalShadowCliContext): ShadowIdentity | null {
  const accountId = requireEnv(context, 'COINDCX_LIVE_ACCOUNT_ID');
  const fingerprint = requireEnv(context, 'COINDCX_EXPECTED_ACCOUNT_FINGERPRINT');
  const cadence = requireEnv(context, 'LIVE_PRACTICAL_SHADOW_CADENCE_MS');
  if (accountId === null || fingerprint === null || cadence === null) return null;
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    context.io.err('Refusing to run: COINDCX_EXPECTED_ACCOUNT_FINGERPRINT must be a lowercase 64-hex fingerprint.');
    return null;
  }
  if (!/^[1-9]\d*$/.test(cadence)) {
    context.io.err('Refusing to run: LIVE_PRACTICAL_SHADOW_CADENCE_MS must be a positive integer (observational cadence; not a provider guarantee).');
    return null;
  }
  // The runtime epoch to evaluate Phase 18 state against (the live runtime's); a fresh shadow epoch otherwise.
  const runtimeEpoch = context.env['LIVE_PRACTICAL_SHADOW_RUNTIME_EPOCH']?.trim() || newPracticalShadowRuntimeEpoch();
  return { accountId, fingerprint, cadenceMs: Number(cadence), runtimeEpoch };
}

/** Resolves the source provenance; prints the refusal (never the tree's contents) unless CLEAN. */
function cleanSourceProvenance(context: PracticalShadowCliContext): PracticalShadowSourceProvenance | null {
  let probe: PracticalShadowSourceProbe | null = null;
  try {
    probe = context.sourceProbe();
  } catch {
    probe = null;
  }
  const provenance = resolvePracticalShadowSourceProvenance(probe);
  if (provenance.state === 'DIRTY') {
    context.io.err(`Refusing to run: SHADOW_SOURCE_DIRTY (${provenance.changedEntries} uncommitted or untracked entries). Run from a clean checkout of an exact commit.`);
    return null;
  }
  if (provenance.state !== 'CLEAN') {
    context.io.err('Refusing to run: SHADOW_SOURCE_PROVENANCE_UNAVAILABLE (the exact source commit and a clean tree could not be established).');
    return null;
  }
  return provenance;
}

/**
 * The campaign configuration, including the SAFE provider descriptor bound
 * into its digest. Prints the refusal (never the URL value) when invalid.
 */
function shadowConfig(context: PracticalShadowCliContext, cadenceMs: number): PracticalShadowConfig | null {
  try {
    return resolvePracticalShadowConfig({
      provider: { restOrigin: context.env['COINDCX_BASE_URL']?.trim() || DEFAULT_BASE_URL, streamEndpoint: COINDCX_DEFAULT_SOCKET_ENDPOINT },
      cadenceMs,
    });
  } catch (error) {
    context.io.err(`Refusing to run: invalid shadow configuration (${error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'UNKNOWN'}). COINDCX_BASE_URL must be a bare https origin; the cadence must fit an evaluation window.`);
    return null;
  }
}

function readOnlySources(context: PracticalShadowCliContext, config: PracticalShadowConfig, accountId: string, apiKey: string, apiSecret: string): { sources: PracticalShadowSources; stream: CoinDcxPrivateAccountStream } {
  // Exactly the normalized REST origin bound into the campaign's configuration digest.
  const client = new CoinDcxClient({ apiKey, apiSecret, baseUrl: config.provider.restOrigin });
  // Exactly the stream endpoint bound into the campaign's configuration digest.
  const stream = new CoinDcxPrivateAccountStream({ apiKey, apiSecret, endpoint: config.provider.streamEndpoint, socketFactory: new ProductionCoinDcxSocketFactory() });
  const reconciliationRepository = new PrismaLiveReconciliationRepository(context.prisma);
  const practicalRepository = new PrismaPracticalSafetyRepository(context.prisma);
  return {
    stream,
    sources: Object.freeze({
      venue: new CoinDcxReconciliationEvidenceAdapter({ client, credentialAccountId: accountId }),
      privateStream: stream,
      // READ-ONLY wrappers: no other repository method is reachable from shadow code.
      reconciliation: Object.freeze({ loadState: (id: string) => reconciliationRepository.loadState(id) }),
      practicalAccount: Object.freeze({ loadAccount: (id: string) => practicalRepository.loadAccount(id) }),
      clock: new SystemClock(),
      scheduler: SystemStreamScheduler,
    }),
  };
}

async function commandStart(argv: readonly string[], context: PracticalShadowCliContext): Promise<number> {
  if (context.env['LIVE_PRACTICAL_SHADOW_ENABLED'] !== 'true') {
    context.io.err('Refusing to run: set LIVE_PRACTICAL_SHADOW_ENABLED=true to opt in to READ-ONLY practical shadow collection.');
    return 2;
  }
  const apiKey = context.env['COINDCX_API_KEY']?.trim() ?? '';
  const apiSecret = context.env['COINDCX_API_SECRET']?.trim() ?? '';
  if (apiKey === '' || apiSecret === '') {
    context.io.err('Refusing to run: COINDCX_API_KEY and COINDCX_API_SECRET must both be set (values are never printed).');
    return 2;
  }
  const identity = shadowIdentity(context);
  if (identity === null) return 2;
  const sourceProvenance = cleanSourceProvenance(context);
  if (sourceProvenance === null) return 2;
  const config = shadowConfig(context, identity.cadenceMs);
  if (config === null) return 2;
  const { sources, stream } = readOnlySources(context, config, identity.accountId, apiKey, apiSecret);
  const runner = new PracticalShadowCampaignRunner({
    store: new PrismaPracticalShadowStore(context.prisma),
    sources,
    config,
    accountId: identity.accountId,
    expectedProviderAccountFingerprint: identity.fingerprint,
    runtimeEpoch: identity.runtimeEpoch,
    sourceProvenance,
    tierB: practicalShadowTierBStatus(context.env, identity.accountId),
  });
  context.io.out('================================================================');
  context.io.out('  PHASE 18B PRACTICAL SHADOW COLLECTION (READ-ONLY)');
  context.io.out('  NO ORDER IS PLACED, CANCELLED, OR CLOSED. SHADOW EVIDENCE IS NOT AUTHORITY.');
  context.io.out('  Real CoinDCX private-stream readiness is UNPROVEN: authority stays ineligible.');
  context.io.out('================================================================');
  const mode = argv.includes('--new') ? 'START_NEW' : argv.includes('--resume') ? 'RESUME' : 'RESUME_OR_START';
  const opened = await runner.open(mode);
  if (opened.kind === 'REFUSED') {
    context.io.err(`Shadow campaign not opened: ${opened.reason} ${opened.detail.join(',')}`);
    // Never force-abort on start: the operator decides explicitly.
    if (opened.reason === 'BINDING_MISMATCH' || opened.reason === 'ACTIVE_CAMPAIGN_EXISTS') context.io.err(ABORT_HINT);
    return 1;
  }
  context.io.out(`[shadow] campaign ${opened.campaign.campaignId} ${opened.kind} (aborted stale evaluations: ${opened.abortedEvaluations})`);
  await stream.start();
  try {
    const maxRaw = context.env['LIVE_PRACTICAL_SHADOW_MAX_EVALUATIONS']?.trim();
    const maxEvaluations = maxRaw !== undefined && /^[1-9]\d*$/.test(maxRaw) ? Number(maxRaw) : undefined;
    const completed = await runner.runLoop({ maxEvaluations, shouldContinue: context.shouldContinue });
    context.io.out(`[shadow] stopped after ${completed} completed evaluations; the campaign stays ACTIVE and resumable.`);
  } finally {
    stream.stop();
  }
  return 0;
}

async function commandStop(context: PracticalShadowCliContext): Promise<number> {
  const identity = shadowIdentity(context);
  if (identity === null) return 2;
  const sourceProvenance = cleanSourceProvenance(context);
  if (sourceProvenance === null) return 2;
  const config = shadowConfig(context, identity.cadenceMs);
  if (config === null) return 2;
  const clock = new SystemClock();
  const runner = new PracticalShadowCampaignRunner({
    store: new PrismaPracticalShadowStore(context.prisma),
    // `stop` performs no read at all: the sources are inert placeholders that fail closed if ever used.
    sources: Object.freeze({
      venue: Object.freeze({
        readOrders: () => Promise.reject(new Error('stop reads nothing')),
        readPositions: () => Promise.reject(new Error('stop reads nothing')),
        readAccountIdentity: () => Promise.reject(new Error('stop reads nothing')),
      }),
      privateStream: Object.freeze({ subscribe: () => () => undefined, getHealthSnapshot: () => { throw new Error('stop reads nothing'); } }),
      reconciliation: Object.freeze({ loadState: () => Promise.reject(new Error('stop reads nothing')) }),
      practicalAccount: Object.freeze({ loadAccount: () => Promise.reject(new Error('stop reads nothing')) }),
      clock,
      scheduler: SystemStreamScheduler,
    }),
    config,
    accountId: identity.accountId,
    expectedProviderAccountFingerprint: identity.fingerprint,
    runtimeEpoch: identity.runtimeEpoch,
    sourceProvenance,
    tierB: practicalShadowTierBStatus(context.env, identity.accountId),
  });
  const opened = await runner.open('RESUME');
  if (opened.kind === 'REFUSED') {
    context.io.err(`No campaign stopped: ${opened.reason} ${opened.detail.join(',')}`);
    if (opened.reason === 'BINDING_MISMATCH') context.io.err(ABORT_HINT);
    return 1;
  }
  const stopped = await runner.stop('COMPLETED', 'OPERATOR_STOP');
  context.io.out(stopped ? `[shadow] campaign ${opened.campaign.campaignId} COMPLETED` : '[shadow] campaign was not stopped');
  return stopped ? 0 : 1;
}

async function snapshotFor(argv: readonly string[], context: PracticalShadowCliContext): Promise<PracticalShadowCampaignSnapshot | null> {
  const store = new PrismaPracticalShadowStore(context.prisma);
  let campaignId = argValue(argv, '--campaign');
  if (campaignId === null) {
    const accountId = requireEnv(context, 'COINDCX_LIVE_ACCOUNT_ID');
    if (accountId === null) return null;
    const active = await store.loadActiveCampaign(accountId);
    if (active === null) {
      context.io.err('No ACTIVE campaign for this account; pass --campaign <campaignId>.');
      return null;
    }
    campaignId = active.campaignId;
  }
  const snapshot = await store.snapshotCampaign(campaignId);
  if (snapshot === null) context.io.err('Unknown campaign.');
  return snapshot;
}

async function commandStatus(argv: readonly string[], context: PracticalShadowCliContext): Promise<number> {
  const snapshot = await snapshotFor(argv, context);
  if (snapshot === null) return 1;
  const { campaign } = snapshot;
  const count = (status: string) => snapshot.evaluations.filter((row) => row.status === status).length;
  context.io.out(JSON.stringify({
    campaignId: campaign.campaignId,
    status: campaign.status,
    provenance: { sourceProvenance: campaign.sourceProvenance, softwareVersion: campaign.softwareVersion },
    configDigest: campaign.configDigest,
    endReason: campaign.endReason,
    startedAtMs: campaign.startedAtMs,
    endedAtMs: campaign.endedAtMs,
    cutoffSequence: snapshot.cutoffSequence,
    evaluations: { completed: count('COMPLETED'), aborted: count('ABORTED'), inProgress: count('CLAIMED') },
    authority: 'NOT AUTHORITY (shadow evidence only)',
  }, null, 2));
  return 0;
}

async function commandReportOrReplay(argv: readonly string[], context: PracticalShadowCliContext, replayOnly: boolean): Promise<number> {
  const snapshot = await snapshotFor(argv, context);
  if (snapshot === null) return 1;
  const replay = replayPracticalShadowSnapshot(snapshot);
  if (replayOnly) {
    context.io.out(JSON.stringify({
      campaignId: replay.campaignId,
      provenance: replay.provenance,
      cutoffSequence: replay.cutoffSequence,
      analysisVersion: replay.analysisVersion,
      evaluationsReplayed: replay.evaluationsReplayed,
      paperDecisionsReplayed: replay.paperDecisionsReplayed,
      consistent: replay.consistent,
      mismatches: replay.mismatches,
    }, null, 2));
    return replay.consistent ? 0 : 1;
  }
  context.io.out(JSON.stringify({ replayConsistent: replay.consistent, report: replay.report }, null, 2));
  return replay.consistent ? 0 : 1;
}

/**
 * EXPLICIT operator abort. Every identifier is required on the command line
 * (no environment fallback, no "the active one" default): exact account,
 * exact campaign, and a reason CODE. Database only.
 */
async function commandAbort(argv: readonly string[], context: PracticalShadowCliContext): Promise<number> {
  const accountId = argValue(argv, '--account');
  const campaignId = argValue(argv, '--campaign');
  const reason = argValue(argv, '--reason');
  if (accountId === null || campaignId === null || reason === null) {
    context.io.err('Refusing to abort: --account <accountId>, --campaign <campaignId>, and --reason <CODE> are all required (exact values; nothing is inferred).');
    return 2;
  }
  const result = await abortPracticalShadowCampaign({
    store: new PrismaPracticalShadowStore(context.prisma),
    accountId,
    campaignId,
    reason,
    nowMs: new SystemClock().nowMs(),
  });
  if (result.kind === 'REFUSED') {
    context.io.err(`No campaign aborted: ${result.reason}`);
    return 1;
  }
  context.io.out(JSON.stringify({
    result: result.kind,
    campaignId: result.campaign.campaignId,
    status: result.campaign.status,
    endReason: result.campaign.endReason,
    abortedEvaluations: result.kind === 'ABORTED' ? result.abortedEvaluations : 0,
    authority: 'NOT AUTHORITY (shadow evidence only)',
  }, null, 2));
  return 0;
}

/** Runs one CLI command. Returns the process exit code. */
export async function runPracticalShadowCli(argv: readonly string[], context: PracticalShadowCliContext): Promise<number> {
  switch (argv[0]) {
    case 'start':
      return commandStart(argv, context);
    case 'stop':
      return commandStop(context);
    case 'status':
      return commandStatus(argv, context);
    case 'report':
      return commandReportOrReplay(argv, context, false);
    case 'replay':
      return commandReportOrReplay(argv, context, true);
    case 'abort':
      return commandAbort(argv, context);
    default:
      context.io.err(USAGE);
      return 2;
  }
}