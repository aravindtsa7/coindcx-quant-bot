/**
 * Phase 18B Checkpoint C: the SAFE shadow evidence record (schema V1).
 *
 * One record per shadow evaluation window. It holds only codes, counts,
 * timings, and digests: the per-read Checkpoint B observation (slot, kind,
 * times, pages, completeness, failure, canonical record-set digest), stream
 * readiness samples and private-event COUNTS, Phase 18 generation samples,
 * the read-only practical account state summary, and the Tier-B
 * configuration status. It never holds a credential, a signature, a raw
 * provider account identity (only the Phase 18 fingerprint digest), or a
 * raw order/position payload.
 *
 * The record is sufficient to recompute its REST stability candidate,
 * authority blockers, and paper decisions deterministically (`./replay.ts`).
 *
 * V1 is a CLOSED schema. `parsePracticalShadowEvidence` requires the EXACT V1
 * field set at the root and in every nested object (an unknown field is
 * SHADOW_UNSUPPORTED_VERSION: a record carrying anything else is not a V1
 * record; a missing field is SHADOW_EVIDENCE_INSUFFICIENT), accepts only the
 * closed V1 code domains below (read slot/kind/failure, readiness and its
 * UNPROVEN reason, stream-health trip, event reason keys, Phase 18 status,
 * practical account state/fence mode/problem, Tier-B status/disabled
 * reason), and checks the record's internal consistency. It REBUILDS the
 * record from validated values only, so `canonicalPracticalShadowEvidenceJson`
 * of the parsed record is the only form that is ever persisted: no caller
 * field (a secret, a raw payload, arbitrary metadata) can survive into the
 * database. A value outside a V1 domain requires a new schema version.
 */
import { sha256CanonicalJson } from '../../../risk';
import type { PracticalReadFailure } from '../practical-recovery/observation';
import type { PracticalObservationReadKind, PracticalPassReadSlot } from '../practical-recovery/telemetry';
import {
  PRACTICAL_SHADOW_STREAM_READINESS,
  PRACTICAL_SHADOW_SUPPORTED_EVIDENCE_SCHEMA_VERSIONS,
  PracticalShadowError,
  type PracticalShadowStreamReadiness,
} from './types';

export interface PracticalShadowReadRecord {
  readonly passIndex: number;
  readonly slot: PracticalPassReadSlot;
  readonly kind: PracticalObservationReadKind;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly latencyMs: number;
  readonly failure: PracticalReadFailure | null;
  readonly pagesRead: number | null;
  readonly complete: boolean;
  /** Canonical record-set digest (or the configured fingerprint digest for identity). Null on failure. */
  readonly contentDigest: string | null;
}

export interface PracticalShadowReadinessSample {
  readonly atMs: number;
  readonly readiness: PracticalShadowStreamReadiness;
  readonly unprovenReason: string | null;
  readonly incarnation: number | null;
}

export interface PracticalShadowReconciliationSample {
  readonly atMs: number;
  /** The read succeeded and returned a row of EXACTLY this account. */
  readonly available: boolean;
  readonly status: string | null;
  readonly currentGeneration: number | null;
  readonly healthyGeneration: number | null;
  readonly runtimeEpochMatches: boolean;
}

export interface PracticalShadowPracticalAccountSummary {
  /** A valid FOUND read. */
  readonly readable: boolean;
  /** NOT_FOUND, MALFORMED, or UNREADABLE when not readable. */
  readonly problem: string | null;
  readonly state: string | null;
  readonly fenceMode: string | null;
  readonly fenceGeneration: number | null;
  readonly fenceRuntimeEpochMatches: boolean | null;
  readonly hasCurrentCertificate: boolean | null;
  readonly hasLease: boolean | null;
}

export interface PracticalShadowStreamEventCounts {
  readonly total: number;
  /** Counts by the Checkpoint B classification reason (PRIVATE_STATE_EVENT, WS_DISCONNECTED, ...). */
  readonly byReason: Readonly<Record<string, number>>;
}

export interface PracticalShadowEvidence {
  readonly schemaVersion: string;
  readonly evaluationId: string;
  readonly campaignId: string;
  readonly accountId: string;
  /** The configured provider fingerprint digest the identity reads were checked against. */
  readonly expectedProviderAccountFingerprint: string;
  readonly runtimeEpoch: string;
  readonly window: { readonly minimumPasses: number; readonly minimumPassSpacingMs: number; readonly minimumCertificationSpanMs: number };
  readonly timing: {
    readonly readCandidateMs: number;
    readonly passCandidateMs: number;
    readonly interReadGapCandidateMs: number;
    readonly hardReadTimeoutMs: number;
    readonly hardPassDurationMs: number;
  };
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly clockAnomaly: boolean;
  readonly reads: readonly PracticalShadowReadRecord[];
  readonly readiness: {
    readonly atStart: PracticalShadowReadinessSample;
    readonly samples: readonly PracticalShadowReadinessSample[];
    readonly atEnd: PracticalShadowReadinessSample;
  };
  /** The first Checkpoint B health-check trip against the start binding (only when the start was PROVEN_READY). */
  readonly streamHealthTrip: string | null;
  readonly events: PracticalShadowStreamEventCounts;
  readonly reconciliation: readonly PracticalShadowReconciliationSample[];
  /** Phase 18 generation first observed with this stream incarnation in this campaign lifetime (null: none yet). */
  readonly generationBaseline: number | null;
  readonly practicalAccount: PracticalShadowPracticalAccountSummary;
  readonly tierB: { readonly status: 'ELIGIBLE' | 'DISABLED'; readonly disabledReason: string | null; readonly accountAllowlisted: boolean };
}

/** Deterministic digest over the canonical evidence record. */
export function practicalShadowEvidenceDigest(evidence: PracticalShadowEvidence): string {
  return sha256CanonicalJson({ schema: 'P18B_SHADOW_EVIDENCE_DIGEST_V1', evidence });
}

// ---------------------------------------------------------------------------
// The CLOSED V1 domains (a new value requires a new evidence schema version)
// ---------------------------------------------------------------------------

export const PRACTICAL_SHADOW_EVIDENCE_V1_DOMAINS = Object.freeze({
  readSlots: Object.freeze(['IDENTITY_OPEN', 'O1', 'P1', 'O2', 'P2', 'O3', 'IDENTITY_CLOSE'] as const),
  readKinds: Object.freeze(['IDENTITY', 'ORDERS', 'POSITIONS'] as const),
  readFailures: Object.freeze([
    'PROVIDER_UNAVAILABLE', 'READ_HARD_TIMEOUT', 'PAGINATION_INCOMPLETE', 'MALFORMED_RESPONSE', 'ACCOUNT_FINGERPRINT_MISMATCH', 'ACCOUNT_IDENTITY_UNAVAILABLE', 'CLOCK_ANOMALY',
  ] as const),
  unprovenReasons: Object.freeze([
    'HEALTH_MALFORMED', 'NO_INCARNATION', 'JOIN_NOT_SENT', 'STATE_NOT_READY', 'NO_PROVIDER_CONFIRMATION', 'CONFIRMATION_MALFORMED', 'CONFIRMATION_FOR_OTHER_INCARNATION',
  ] as const),
  /** `practicalStreamHealthTrip` results (plus UNKNOWN_PRIVATE_EVENT when the health read itself throws). */
  streamHealthTrips: Object.freeze(['UNKNOWN_PRIVATE_EVENT', 'STREAM_INCARNATION_CHANGED', 'WS_DISCONNECTED', 'WS_RECONNECTED', 'WS_JOIN_FAILED'] as const),
  /** `classifyPracticalPrivateEvent` TRIP reasons, plus NOISE. */
  eventReasons: Object.freeze(['NOISE', 'UNKNOWN_PRIVATE_EVENT', 'STREAM_INCARNATION_CHANGED', 'WS_DISCONNECTED', 'WS_PING_TIMEOUT', 'WS_RECONNECTED', 'PRIVATE_STATE_EVENT'] as const),
  reconciliationStatuses: Object.freeze(['RECONCILIATION_REQUIRED', 'RUNNING', 'HEALTHY', 'UNHEALTHY', 'MANUAL_REVIEW_REQUIRED'] as const),
  practicalAccountProblems: Object.freeze(['NOT_FOUND', 'MALFORMED', 'UNREADABLE'] as const),
  practicalAccountStates: Object.freeze(['QUARANTINED', 'CERTIFYING', 'PROVIDER_UNAVAILABLE', 'CERTIFIED_IDLE', 'MUTATING', 'MANUAL_REVIEW_REQUIRED'] as const),
  fenceModes: Object.freeze(['IDLE', 'CERTIFYING', 'MUTATION_LEASED'] as const),
  tierBStatuses: Object.freeze(['ELIGIBLE', 'DISABLED'] as const),
  tierBDisabledReasons: Object.freeze(['NOT_EXPLICITLY_ENABLED', 'MALFORMED_ENABLE_FLAG', 'EMPTY_ACCOUNT_ALLOWLIST', 'MALFORMED_CEILING', 'CEILING_WOULD_LOOSEN'] as const),
});

/** The one persisted form: the JSON of the REBUILT, validated record (never a caller's raw string). */
export function canonicalPracticalShadowEvidenceJson(evidence: PracticalShadowEvidence): string {
  return JSON.stringify(parsePracticalShadowEvidence(evidence));
}

// ---------------------------------------------------------------------------
// Strict CLOSED parsing (store completion and replay input)
// ---------------------------------------------------------------------------

function insufficient(path: string): never {
  throw new PracticalShadowError('SHADOW_EVIDENCE_INSUFFICIENT', `Shadow evidence is missing or malformed at ${path}; nothing is invented`);
}

/** An object with EXACTLY these fields: an unknown field is not V1 (refused), a missing one is insufficient. */
function closed(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) insufficient(path);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new PracticalShadowError('SHADOW_UNSUPPORTED_VERSION', `Shadow evidence at ${path} carries fields outside the closed V1 schema (${unknown.length}); it is refused, never stored or reinterpreted`);
  }
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) insufficient(`${path}.${key}`);
  return value as Record<string, unknown>;
}

function int(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) insufficient(path);
  return value;
}

function intOrNull(value: unknown, path: string): number | null {
  return value === null ? null : int(value, path);
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') insufficient(path);
  return value;
}

function boolOrNull(value: unknown, path: string): boolean | null {
  return value === null ? null : bool(value, path);
}

function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) insufficient(path);
  return value;
}

function code<T extends string>(value: unknown, domain: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(domain as readonly string[]).includes(value)) insufficient(path);
  return value as T;
}

function codeOrNull<T extends string>(value: unknown, domain: readonly T[], path: string): T | null {
  return value === null ? null : code(value, domain, path);
}

/** An exact identifier: printable ASCII without spaces (ids, runtime epochs, account ids). */
function identifier(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !/^[\x21-\x7e]+$/.test(value)) insufficient(path);
  return value;
}

function hex64(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) insufficient(path);
  return value;
}

const D = PRACTICAL_SHADOW_EVIDENCE_V1_DOMAINS;

/** The event-count map: only reasons that occurred are present, and every key must be a closed V1 event reason. */
function reasonCounts(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) insufficient(path);
  const unknown = Object.keys(value).filter((key) => !(D.eventReasons as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new PracticalShadowError('SHADOW_UNSUPPORTED_VERSION', `Shadow evidence at ${path} carries event reasons outside the closed V1 domain (${unknown.length}); it is refused, never stored`);
  }
  return value as Record<string, unknown>;
}

function readinessSample(value: unknown, path: string): PracticalShadowReadinessSample {
  const sample = closed(value, path, ['atMs', 'readiness', 'unprovenReason', 'incarnation']);
  const readiness = code<PracticalShadowStreamReadiness>(sample['readiness'], PRACTICAL_SHADOW_STREAM_READINESS, `${path}.readiness`);
  const unprovenReason = codeOrNull(sample['unprovenReason'], D.unprovenReasons, `${path}.unprovenReason`);
  // An UNPROVEN sample carries exactly one UNPROVEN reason; nothing else carries one.
  if ((readiness === 'UNPROVEN') !== (unprovenReason !== null)) insufficient(`${path}.unprovenReason`);
  return Object.freeze({ atMs: int(sample['atMs'], `${path}.atMs`), readiness, unprovenReason, incarnation: intOrNull(sample['incarnation'], `${path}.incarnation`) });
}

function read(value: unknown, path: string): PracticalShadowReadRecord {
  const entry = closed(value, path, ['passIndex', 'slot', 'kind', 'startedAtMs', 'endedAtMs', 'latencyMs', 'failure', 'pagesRead', 'complete', 'contentDigest']);
  const failure = codeOrNull<PracticalReadFailure>(entry['failure'], D.readFailures, `${path}.failure`);
  const contentDigest = entry['contentDigest'] === null ? null : hex64(entry['contentDigest'], `${path}.contentDigest`);
  if (failure !== null && contentDigest !== null) insufficient(`${path}.contentDigest`);
  return Object.freeze({
    passIndex: int(entry['passIndex'], `${path}.passIndex`, 1),
    slot: code<PracticalPassReadSlot>(entry['slot'], D.readSlots, `${path}.slot`),
    kind: code<PracticalObservationReadKind>(entry['kind'], D.readKinds, `${path}.kind`),
    startedAtMs: int(entry['startedAtMs'], `${path}.startedAtMs`),
    endedAtMs: int(entry['endedAtMs'], `${path}.endedAtMs`),
    latencyMs: int(entry['latencyMs'], `${path}.latencyMs`),
    failure,
    pagesRead: intOrNull(entry['pagesRead'], `${path}.pagesRead`),
    complete: bool(entry['complete'], `${path}.complete`),
    contentDigest,
  });
}

function reconciliationSample(value: unknown, path: string): PracticalShadowReconciliationSample {
  const sample = closed(value, path, ['atMs', 'available', 'status', 'currentGeneration', 'healthyGeneration', 'runtimeEpochMatches']);
  const available = bool(sample['available'], `${path}.available`);
  const result = Object.freeze({
    atMs: int(sample['atMs'], `${path}.atMs`),
    available,
    status: codeOrNull(sample['status'], D.reconciliationStatuses, `${path}.status`),
    currentGeneration: intOrNull(sample['currentGeneration'], `${path}.currentGeneration`),
    healthyGeneration: intOrNull(sample['healthyGeneration'], `${path}.healthyGeneration`),
    runtimeEpochMatches: bool(sample['runtimeEpochMatches'], `${path}.runtimeEpochMatches`),
  });
  // An unavailable read carries no observed values.
  if (!available && (result.status !== null || result.currentGeneration !== null || result.healthyGeneration !== null || result.runtimeEpochMatches)) insufficient(path);
  if (available && result.currentGeneration === null) insufficient(`${path}.currentGeneration`);
  return result;
}

function practicalAccount(value: unknown, path: string): PracticalShadowPracticalAccountSummary {
  const account = closed(value, path, ['readable', 'problem', 'state', 'fenceMode', 'fenceGeneration', 'fenceRuntimeEpochMatches', 'hasCurrentCertificate', 'hasLease']);
  const summary = Object.freeze({
    readable: bool(account['readable'], `${path}.readable`),
    problem: codeOrNull(account['problem'], D.practicalAccountProblems, `${path}.problem`),
    state: codeOrNull(account['state'], D.practicalAccountStates, `${path}.state`),
    fenceMode: codeOrNull(account['fenceMode'], D.fenceModes, `${path}.fenceMode`),
    fenceGeneration: intOrNull(account['fenceGeneration'], `${path}.fenceGeneration`),
    fenceRuntimeEpochMatches: boolOrNull(account['fenceRuntimeEpochMatches'], `${path}.fenceRuntimeEpochMatches`),
    hasCurrentCertificate: boolOrNull(account['hasCurrentCertificate'], `${path}.hasCurrentCertificate`),
    hasLease: boolOrNull(account['hasLease'], `${path}.hasLease`),
  });
  const observed = [summary.state, summary.fenceMode, summary.fenceGeneration, summary.fenceRuntimeEpochMatches, summary.hasCurrentCertificate, summary.hasLease];
  // Readable: no problem and every observed value present. Unreadable: exactly one problem and nothing observed.
  if (summary.readable ? summary.problem !== null || observed.some((entry) => entry === null) : summary.problem === null || observed.some((entry) => entry !== null)) insufficient(path);
  return summary;
}

/**
 * Strictly parses evidence against the CLOSED V1 schema and REBUILDS it from
 * validated values only. An unsupported schema version or an unknown field is
 * SHADOW_UNSUPPORTED_VERSION; a missing, malformed, out-of-domain, or
 * inconsistent value is SHADOW_EVIDENCE_INSUFFICIENT. Nothing is defaulted.
 */
export function parsePracticalShadowEvidence(value: unknown): PracticalShadowEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) insufficient('evidence');
  const schemaVersion = (value as Record<string, unknown>)['schemaVersion'];
  if (schemaVersion === undefined) insufficient('schemaVersion');
  if (typeof schemaVersion !== 'string' || !PRACTICAL_SHADOW_SUPPORTED_EVIDENCE_SCHEMA_VERSIONS.includes(schemaVersion)) {
    throw new PracticalShadowError('SHADOW_UNSUPPORTED_VERSION', `Unsupported shadow evidence schema version ${JSON.stringify(schemaVersion)}; it is never reinterpreted`);
  }
  const root = closed(value, 'evidence', [
    'schemaVersion', 'evaluationId', 'campaignId', 'accountId', 'expectedProviderAccountFingerprint', 'runtimeEpoch', 'window', 'timing', 'startedAtMs', 'endedAtMs',
    'clockAnomaly', 'reads', 'readiness', 'streamHealthTrip', 'events', 'reconciliation', 'generationBaseline', 'practicalAccount', 'tierB',
  ]);
  const window = closed(root['window'], 'window', ['minimumPasses', 'minimumPassSpacingMs', 'minimumCertificationSpanMs']);
  const timing = closed(root['timing'], 'timing', ['readCandidateMs', 'passCandidateMs', 'interReadGapCandidateMs', 'hardReadTimeoutMs', 'hardPassDurationMs']);
  const readinessRoot = closed(root['readiness'], 'readiness', ['atStart', 'samples', 'atEnd']);
  const events = closed(root['events'], 'events', ['total', 'byReason']);
  const byReasonRaw = reasonCounts(events['byReason'], 'events.byReason');
  const byReason: Record<string, number> = {};
  let counted = 0;
  // Only reason keys that occurred are present: validate the keys actually carried.
  for (const reason of Object.keys(byReasonRaw)) {
    byReason[reason] = int(byReasonRaw[reason], `events.byReason.${reason}`, 1);
    counted += byReason[reason]!;
  }
  const total = int(events['total'], 'events.total');
  if (total !== counted) insufficient('events.total');
  const tierB = closed(root['tierB'], 'tierB', ['status', 'disabledReason', 'accountAllowlisted']);
  const tierBStatus = code(tierB['status'], D.tierBStatuses, 'tierB.status');
  const disabledReason = codeOrNull(tierB['disabledReason'], D.tierBDisabledReasons, 'tierB.disabledReason');
  const accountAllowlisted = bool(tierB['accountAllowlisted'], 'tierB.accountAllowlisted');
  if ((tierBStatus === 'DISABLED') !== (disabledReason !== null) || (tierBStatus === 'DISABLED' && accountAllowlisted)) insufficient('tierB');
  const evidence: PracticalShadowEvidence = {
    schemaVersion,
    evaluationId: identifier(root['evaluationId'], 'evaluationId', 64),
    campaignId: identifier(root['campaignId'], 'campaignId', 64),
    accountId: identifier(root['accountId'], 'accountId', 128),
    expectedProviderAccountFingerprint: hex64(root['expectedProviderAccountFingerprint'], 'expectedProviderAccountFingerprint'),
    runtimeEpoch: identifier(root['runtimeEpoch'], 'runtimeEpoch', 64),
    window: Object.freeze({
      minimumPasses: int(window['minimumPasses'], 'window.minimumPasses', 1),
      minimumPassSpacingMs: int(window['minimumPassSpacingMs'], 'window.minimumPassSpacingMs', 1),
      minimumCertificationSpanMs: int(window['minimumCertificationSpanMs'], 'window.minimumCertificationSpanMs', 1),
    }),
    timing: Object.freeze({
      readCandidateMs: int(timing['readCandidateMs'], 'timing.readCandidateMs', 1),
      passCandidateMs: int(timing['passCandidateMs'], 'timing.passCandidateMs', 1),
      interReadGapCandidateMs: int(timing['interReadGapCandidateMs'], 'timing.interReadGapCandidateMs', 1),
      hardReadTimeoutMs: int(timing['hardReadTimeoutMs'], 'timing.hardReadTimeoutMs', 1),
      hardPassDurationMs: int(timing['hardPassDurationMs'], 'timing.hardPassDurationMs', 1),
    }),
    startedAtMs: int(root['startedAtMs'], 'startedAtMs'),
    endedAtMs: int(root['endedAtMs'], 'endedAtMs'),
    clockAnomaly: bool(root['clockAnomaly'], 'clockAnomaly'),
    reads: Object.freeze(list(root['reads'], 'reads').map((entry, index) => read(entry, `reads[${index}]`))),
    readiness: Object.freeze({
      atStart: readinessSample(readinessRoot['atStart'], 'readiness.atStart'),
      samples: Object.freeze(list(readinessRoot['samples'], 'readiness.samples').map((entry, index) => readinessSample(entry, `readiness.samples[${index}]`))),
      atEnd: readinessSample(readinessRoot['atEnd'], 'readiness.atEnd'),
    }),
    streamHealthTrip: codeOrNull(root['streamHealthTrip'], D.streamHealthTrips, 'streamHealthTrip'),
    events: Object.freeze({ total, byReason: Object.freeze(byReason) }),
    reconciliation: Object.freeze(list(root['reconciliation'], 'reconciliation').map((entry, index) => reconciliationSample(entry, `reconciliation[${index}]`))),
    generationBaseline: intOrNull(root['generationBaseline'], 'generationBaseline'),
    practicalAccount: practicalAccount(root['practicalAccount'], 'practicalAccount'),
    tierB: Object.freeze({ status: tierBStatus, disabledReason, accountAllowlisted }),
  };
  if (evidence.endedAtMs < evidence.startedAtMs) insufficient('endedAtMs');
  return Object.freeze(evidence);
}
