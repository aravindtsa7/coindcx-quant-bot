/**
 * READ-ONLY CoinDCX provider probe: orchestration and artifacts.
 *
 * Sequence: repeated REST read cycles, a private-socket session, a client
 * disconnect, a bounded gap, a second session. Nothing here can mutate the
 * venue: REST goes only through `ProbeReadClient` and the socket only through
 * `observePrivateSession`. Artifacts are written only to a git-ignored
 * directory, and only after a final sweep proves they contain no registered
 * secret, signature, or identifying value.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProbeReadEndpoint } from './allowlist';
import { buildReport, type EtagAnalysis, type ProbeRunResult, type RestObservation } from './report';
import type { ProbeOrderSide, ProbeReadClient } from './rest-probe';
import {
  CandidateTracker,
  SecretRegistry,
  TimestampTracker,
  analyzeUserInfo,
  enumerateKeyPaths,
  kindOf,
  registerSensitiveLeaves,
  sanitizeHeaders,
  scalarText,
  sha256Hex,
  structureSha256,
  type UserInfoObservation,
} from './sanitize';
import { observePrivateSession, type ProbeSocketFactory } from './ws-probe';
import type { RequestSigner } from '../../src/integration/coindcx/signer';

export interface ProbeRunDependencies {
  readonly client: ProbeReadClient;
  readonly socketFactory: ProbeSocketFactory;
  readonly signer: RequestSigner;
  readonly apiKey: string;
  readonly registry: SecretRegistry;
  readonly log: (line: string) => void;
  readonly monotonicNow: () => number;
  readonly wallNow: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly timing: ProbeTiming;
}

export interface ProbeTiming {
  readonly restCycles: number;
  readonly cycleDelayMs: number;
  readonly wsWindowMs: number;
  readonly gapMs: number;
  readonly connectTimeoutMs: number;
}

export const DEFAULT_PROBE_TIMING: ProbeTiming = Object.freeze({
  restCycles: 3, cycleDelayMs: 1_500, wsWindowMs: 20_000, gapMs: 5_000, connectTimeoutMs: 10_000,
});

const CYCLE_READS: readonly { readonly endpoint: ProbeReadEndpoint; readonly side?: ProbeOrderSide }[] = [
  { endpoint: 'USER_INFO' },
  { endpoint: 'FUTURES_ORDERS', side: 'buy' },
  { endpoint: 'FUTURES_ORDERS', side: 'sell' },
  { endpoint: 'FUTURES_POSITIONS' },
  { endpoint: 'FUTURES_WALLETS' },
];

const GAP_READS: readonly { readonly endpoint: ProbeReadEndpoint; readonly side?: ProbeOrderSide }[] = [
  { endpoint: 'FUTURES_ORDERS', side: 'buy' },
  { endpoint: 'FUTURES_ORDERS', side: 'sell' },
  { endpoint: 'FUTURES_POSITIONS' },
];

function errorSummary(error: unknown): { readonly name: string; readonly status: number | null } {
  const candidate = error as { name?: unknown; statusCode?: unknown; details?: { statusCode?: unknown } } | null;
  const status = typeof candidate?.statusCode === 'number' ? candidate.statusCode
    : typeof candidate?.details?.statusCode === 'number' ? candidate.details.statusCode : null;
  return { name: typeof candidate?.name === 'string' ? candidate.name : 'UnknownError', status };
}

/** A structural fingerprint of the account's visible orders/positions: identities and update times only, never serialized. */
function stateFingerprint(payloads: readonly unknown[]): string {
  const rows: string[] = [];
  for (const payload of payloads) {
    for (const item of Array.isArray(payload) ? payload : []) {
      if (item === null || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      rows.push(`${sha256Hex(scalarText(record['id']) ?? '')}:${scalarText(record['updated_at']) ?? ''}:${scalarText(record['status']) ?? ''}:${scalarText(record['active_pos']) ?? ''}`);
    }
  }
  return sha256Hex(rows.sort().join('\n'));
}

export async function runProviderProbe(deps: ProbeRunDependencies): Promise<ProbeRunResult> {
  const runStart = deps.monotonicNow();
  const at = () => Math.round(deps.monotonicNow() - runStart);
  const candidates = new CandidateTracker();
  const timestamps = new TimestampTracker();
  const headerSeries = new Map<string, { endpoints: Set<string>; values: string[] }>();
  const rest: RestObservation[] = [];
  const identity: UserInfoObservation[] = [];
  // In memory only: (ETag, response-content digest) pairs, to test whether the ETag behaves as a content validator.
  const etagPairs: { etag: string; content: string }[] = [];

  const read = async (cycle: string, endpoint: ProbeReadEndpoint, side: ProbeOrderSide | undefined) => {
    const startedAtMs = at();
    try {
      const response = await deps.client.read(endpoint, side);
      const endedAtMs = at();
      if (endpoint === 'USER_INFO') identity.push(analyzeUserInfo(response.data, deps.registry));
      else registerSensitiveLeaves(response.data, deps.registry);
      const scope = `rest:${endpoint}`;
      const etag = response.headers['etag'] ?? response.headers['ETag'];
      if (typeof etag === 'string') etagPairs.push({ etag, content: sha256Hex(`${endpoint}|${JSON.stringify(response.data)}`) });
      candidates.observe(scope, response.data);
      timestamps.observe(scope, response.data);
      for (const [name, raw] of Object.entries(response.headers)) {
        const lower = name.toLowerCase();
        const series = headerSeries.get(lower) ?? { endpoints: new Set<string>(), values: [] };
        series.endpoints.add(endpoint);
        series.values.push(Array.isArray(raw) ? raw.join(', ') : String(raw ?? ''));
        headerSeries.set(lower, series);
      }
      rest.push({
        cycle, endpoint, side: side ?? null, startedAtMs, endedAtMs, ok: true, status: response.status, error: null,
        headers: sanitizeHeaders(response.headers),
        topLevelKind: kindOf(response.data),
        resourceCount: Array.isArray(response.data) ? response.data.length : null,
        keyPaths: endpoint === 'USER_INFO' ? [] : enumerateKeyPaths(response.data),
        structureSha256: structureSha256(response.data),
      });
      return response.data;
    } catch (error) {
      rest.push({
        cycle, endpoint, side: side ?? null, startedAtMs, endedAtMs: at(), ok: false, status: errorSummary(error).status,
        error: errorSummary(error).name, headers: [], topLevelKind: null, resourceCount: null, keyPaths: [], structureSha256: null,
      });
      deps.log(`[probe] ${endpoint}${side === undefined ? '' : `(${side})`} read failed: ${errorSummary(error).name}`);
      return null;
    }
  };

  for (let cycle = 1; cycle <= deps.timing.restCycles; cycle += 1) {
    deps.log(`[probe] REST cycle ${cycle}/${deps.timing.restCycles}`);
    for (const { endpoint, side } of CYCLE_READS) await read(`cycle-${cycle}`, endpoint, side);
    if (cycle < deps.timing.restCycles) await deps.sleep(deps.timing.cycleDelayMs);
  }

  const sessionOptions = {
    apiKey: deps.apiKey, signer: deps.signer, factory: deps.socketFactory, windowMs: deps.timing.wsWindowMs,
    connectTimeoutMs: deps.timing.connectTimeoutMs, monotonicNow: deps.monotonicNow, wallNow: deps.wallNow,
    sleep: deps.sleep, registry: deps.registry, candidates, timestamps,
  };
  deps.log('[probe] private socket session 1 (observe, then client disconnect)');
  const first = await observePrivateSession({ ...sessionOptions, label: 'session-1' });
  const gapStartWallMs = deps.wallNow();
  const before = stateFingerprint(await Promise.all(GAP_READS.map(({ endpoint, side }) => read('gap-before', endpoint, side))));
  deps.log(`[probe] disconnected gap of ${deps.timing.gapMs} ms (no venue action of any kind)`);
  await deps.sleep(deps.timing.gapMs);
  const after = stateFingerprint(await Promise.all(GAP_READS.map(({ endpoint, side }) => read('gap-after', endpoint, side))));
  const gapEndWallMs = deps.wallNow();
  deps.log('[probe] private socket session 2 (reconnect, rejoin, observe)');
  const second = await observePrivateSession({ ...sessionOptions, label: 'session-2' });

  const gapActivityObservedViaRest = before !== after;
  // Neutral wall-clock comparison only: a timestamp-named value is not an event
  // time or a replay marker, so this count never feeds the replay classification.
  const postReconnectAccountEventsWithTimestampValueInsideGapInterval = second.privateData.accountEventTimestampValuesMs
    .filter((values) => values.some((ms) => ms >= gapStartWallMs && ms <= gapEndWallMs)).length;
  const resumeLikeKeys = [...new Set([...first.privateData.allKeys, ...second.privateData.allKeys])]
    .filter((key) => /resume|replay|cursor|last_?seq|last_?event|since|offset/i.test(key)).sort();

  const headerCandidates = [...headerSeries.entries()]
    .filter(([name]) => sanitizeHeaders({ [name]: '' })[0]?.candidate === true && sanitizeHeaders({ [name]: '' })[0]?.treatment !== 'SUPPRESSED')
    .map(([name, series]) => {
      const digits = series.values.every((value) => /^\d+$/.test(value));
      return {
        name,
        endpoints: [...series.endpoints].sort(),
        occurrences: series.values.length,
        distinctValues: new Set(series.values).size,
        allNumeric: digits,
        numericNonDecreasing: digits ? series.values.every((value, index) => index === 0 || BigInt(value) >= BigInt(series.values[index - 1]!)) : null,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  const etagAnalysis = analyzeEtags(etagPairs);

  return buildReport({
    runStartedAtIso: new Date(deps.wallNow() - (deps.monotonicNow() - runStart)).toISOString(),
    durationMs: at(),
    timing: deps.timing,
    rest,
    identity,
    headerCandidates,
    etagAnalysis,
    payloadCandidates: candidates.summarize(),
    timestampFields: timestamps.summarize(),
    sessions: [first.observation, second.observation],
    reconnect: {
      bothSessionsConnected: first.observation.connected && second.observation.connected,
      socketIdChanged: first.observation.socketIdSha256 !== null && second.observation.socketIdSha256 !== null
        ? first.observation.socketIdSha256 !== second.observation.socketIdSha256 : null,
      engineIdChanged: first.observation.engineIdSha256 !== null && second.observation.engineIdSha256 !== null
        ? first.observation.engineIdSha256 !== second.observation.engineIdSha256 : null,
      resumeLikeKeysObserved: resumeLikeKeys,
      gapActivityObservedViaRest,
      postReconnectAccountEventsWithTimestampValueInsideGapInterval,
      accountEventsSession1: first.observation.accountEventCount,
      accountEventsSession2: second.observation.accountEventCount,
    },
  });
}

/**
 * Whether the ETag behaves like an HTTP content validator in this run: the same
 * response content always carried the same ETag, and different content a
 * different one. Observed consistency is an inference, never a guarantee.
 */
export function analyzeEtags(pairs: readonly { readonly etag: string; readonly content: string }[]): EtagAnalysis {
  if (pairs.length === 0) return { responsesWithEtag: 0, distinctEtags: 0, distinctContents: 0, verdict: 'NO_ETAG_OBSERVED' };
  const byContent = new Map<string, Set<string>>();
  const byEtag = new Map<string, Set<string>>();
  for (const { etag, content } of pairs) {
    byContent.set(content, (byContent.get(content) ?? new Set<string>()).add(etag));
    byEtag.set(etag, (byEtag.get(etag) ?? new Set<string>()).add(content));
  }
  const consistent = [...byContent.values()].every((set) => set.size === 1) && [...byEtag.values()].every((set) => set.size === 1);
  return {
    responsesWithEtag: pairs.length,
    distinctEtags: byEtag.size,
    distinctContents: byContent.size,
    verdict: consistent ? 'CONSISTENT_WITH_RESPONSE_CONTENT_VALIDATOR' : 'NOT_CONSISTENT_WITH_RESPONSE_CONTENT',
  };
}

/** Refuses to write anywhere git would track. */
export function assertGitIgnored(repoRoot: string, target: string): void {
  try {
    execFileSync('git', ['check-ignore', '-q', path.relative(repoRoot, target).split(path.sep).join('/')], { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    throw new Error(`[PROBE_ARTIFACT_PATH_NOT_IGNORED] Refusing to write probe artifacts to a git-tracked path: ${path.relative(repoRoot, target)}`);
  }
}

export interface ProbeArtifacts {
  readonly 'summary.json': string;
  readonly 'rest-observations.json': string;
  readonly 'websocket-observations.json': string;
  readonly 'report.md': string;
}

export function renderArtifacts(result: ProbeRunResult): ProbeArtifacts {
  return {
    'summary.json': `${JSON.stringify(result.summary, null, 2)}\n`,
    'rest-observations.json': `${JSON.stringify(result.rest, null, 2)}\n`,
    'websocket-observations.json': `${JSON.stringify(result.websocket, null, 2)}\n`,
    'report.md': result.reportMarkdown,
  };
}

/** Sweeps every artifact against the registry first; writes nothing if any secret is found. */
export function writeArtifacts(repoRoot: string, directory: string, artifacts: ProbeArtifacts, registry: SecretRegistry): readonly string[] {
  for (const [file, content] of Object.entries(artifacts)) {
    const found = registry.findIn(content);
    if (found.length > 0) {
      throw new Error(`[PROBE_ARTIFACT_SECRET_SWEEP_FAILED] ${file} contains registered sensitive values (${[...new Set(found.map((label) => label.replace(/:.*/, '')))].join(', ')}); nothing was written`);
    }
  }
  assertGitIgnored(repoRoot, path.join(directory, 'summary.json'));
  mkdirSync(directory, { recursive: true });
  const written: string[] = [];
  for (const [file, content] of Object.entries(artifacts)) {
    const target = path.join(directory, file);
    writeFileSync(target, content, 'utf8');
    written.push(target);
  }
  return written;
}
