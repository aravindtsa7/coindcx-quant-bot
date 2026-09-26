/**
 * Phase 18B Checkpoint B: the bounded REST observation protocol (pure).
 *
 * ONE PASS IS A BRACKETED O-P-O-P-O READ SEQUENCE. Account state is read as
 *
 *     Orders O1, Positions P1, Orders O2, Positions P2, Orders O3
 *
 * back to back, so every position read is BRACKETED by an order read before
 * and after it, and the inner order read by position reads. The account
 * identity is read immediately before O1 and immediately after O3
 * (IDENTITY_OPEN / IDENTITY_CLOSE): both must observe exactly the configured
 * fingerprint, which binds the pass to that account without replacing any of
 * the five O/P reads.
 *
 * A pass is USABLE only if all of these hold:
 *   - all seven reads succeeded, in exactly that order;
 *   - every O/P read is complete: every pagination chain was followed to the
 *     end (`provenance.complete`, at least one page, no incomplete reason).
 *     A partial page set in ANY of the five reads fails the pass;
 *   - O1 == O2 == O3 and P1 == P2, as exact canonical record-set digests;
 *   - both identity reads are the configured account (so it is unchanged);
 *   - every read's times are valid and the reads are strictly sequential.
 * Only then does the pass get a stable state digest (identity + the agreed
 * order set + the agreed position set). The engine (`./service.ts`) adds the
 * run-level conditions: the same runtime epoch, Phase 18 generation, and
 * stream incarnation throughout, no tripwire event, and the hard ceilings.
 *
 * A CERTIFICATION is at least `minimumPasses` usable passes separated by
 * pauses: consecutive passes at least `minimumPassSpacingMs` apart (end of one
 * to start of the next), the first start to the last end at least
 * `minimumCertificationSpanMs`, and every pass's state digest EXACTLY equal.
 * Those three are Stage 1A HARD CEILINGS from the enablement.
 *
 * THIS IS NOT AN ATOMIC SNAPSHOT AND NOT CONTINUITY. The reads of a pass
 * happen at different times, and CoinDCX offers no snapshot revision,
 * account sequence, or replay. Bracketing narrows what can go unseen: a
 * change that persists across a bracket is seen, and a transient change is
 * seen whenever one of the bracket reads observes it (that read then differs
 * from its bracket partner). Finite bracketing CANNOT eliminate an ABA change
 * that starts and reverts entirely between two reads of the same resource,
 * nor a cross-resource race (orders and positions changing together between
 * reads so that every read still agrees). That residual risk is exactly why
 * the result is only PRACTICAL_RECOVERY evidence, why the private-stream
 * tripwire watches the gaps, and why the certificate is one-shot and
 * short-lived.
 *
 * The evidence digest binds the evidence deterministically: the same
 * bindings, passes, and reads (slot, times, pages, digest) always give the
 * same digest, and any change to any of them gives a different one.
 */
import { sha256CanonicalJson } from '../../../risk';
import { verifyProviderAccountIdentity, type LiveProviderAccountIdentityRead } from '../reconciliation/account-identity';
import { dedupeOrderEvidence, dedupePositionEvidence, rawOrderSetSha256, rawPositionSetSha256 } from '../reconciliation/evidence';
import type { LiveEvidenceProvenance } from '../reconciliation/types';
import type { PracticalCertificationEvidenceSummary } from '../practical/certificate';
import type { PracticalSafetyCeilings } from '../practical/policy';
import type { PracticalOrderReadResult, PracticalPositionReadResult } from './ports';
import type { PracticalBracketDisagreement, PracticalObservationReadKind, PracticalPassReadSlot } from './telemetry';

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/** Why one read did not produce usable evidence. Each maps to exactly one durable outcome (see `./service.ts`). */
export type PracticalReadFailure =
  | 'PROVIDER_UNAVAILABLE'
  /** The HARD read timeout (`./timing.ts`) fired. Never a calibration candidate. */
  | 'READ_HARD_TIMEOUT'
  | 'PAGINATION_INCOMPLETE'
  | 'MALFORMED_RESPONSE'
  | 'ACCOUNT_FINGERPRINT_MISMATCH'
  | 'ACCOUNT_IDENTITY_UNAVAILABLE'
  | 'CLOCK_ANOMALY';

/** Why one pass is not usable. */
export type PracticalPassFailure =
  | PracticalReadFailure
  /** Inside the pass: O1 != O2, P1 != P2, or O2 != O3. */
  | 'BRACKET_DISAGREEMENT';

/** Why a whole certification could not be accepted. */
export type PracticalCertificationFailureCode =
  | PracticalPassFailure
  | 'STREAM_CHANGED'
  | 'GENERATION_CHANGED'
  /** Across passes: the pass state digests differ. */
  | 'OBSERVATION_DISAGREEMENT'
  /** A pass exceeded the HARD pass-duration ceiling (`./timing.ts`). Never a calibration candidate. */
  | 'PASS_HARD_CEILING_EXCEEDED'
  | 'TIMING_WINDOW_UNMET'
  | 'TOO_FEW_PASSES'
  | 'ISSUANCE_REFUSED'
  | 'PERSISTENCE_REFUSED'
  | 'UNEXPECTED_ERROR';

// ---------------------------------------------------------------------------
// One read
// ---------------------------------------------------------------------------

export interface PracticalReadObservation {
  readonly slot: PracticalPassReadSlot;
  readonly kind: PracticalObservationReadKind;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly latencyMs: number;
  /** null = the read produced usable, complete evidence. */
  readonly failure: PracticalReadFailure | null;
  /** Provider pages consumed (orders/positions), null for the identity read or when unknown. */
  readonly pagesRead: number | null;
  /** True only for a successful read whose every page was read (identity: a matching observed identity). */
  readonly complete: boolean;
  /** Comparison material: the exact record-set digest (or the fingerprint for identity). Null on failure. */
  readonly contentDigest: string | null;
}

/** Content-level result of a read, before timing is attached. */
export interface PracticalReadContent {
  readonly failure: PracticalReadFailure | null;
  readonly pagesRead: number | null;
  readonly complete: boolean;
  readonly contentDigest: string | null;
}

function content(failure: PracticalReadFailure | null, pagesRead: number | null, contentDigest: string | null): PracticalReadContent {
  return Object.freeze({ failure, pagesRead, complete: failure === null, contentDigest: failure === null ? contentDigest : null });
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Pagination completeness, fail closed: complete only when the provider read
 * says so, read at least one page, and gives no incomplete reason. A
 * structurally broken provenance is MALFORMED; a clock that runs backwards
 * inside the read is a CLOCK_ANOMALY.
 */
export function practicalProvenanceFailure(provenance: unknown, expectedSource: LiveEvidenceProvenance['source']): PracticalReadFailure | null {
  if (typeof provenance !== 'object' || provenance === null) return 'MALFORMED_RESPONSE';
  const record = provenance as Record<string, unknown>;
  if (record['source'] !== expectedSource
    || typeof record['complete'] !== 'boolean'
    || !isSafeInteger(record['pagesRead']) || (record['pagesRead'] as number) < 0
    || !isSafeInteger(record['localReadStartedAtMs'])
    || !isSafeInteger(record['localReadEndedAtMs'])
    || (record['incompleteReason'] !== null && typeof record['incompleteReason'] !== 'string')) {
    return 'MALFORMED_RESPONSE';
  }
  if ((record['localReadEndedAtMs'] as number) < (record['localReadStartedAtMs'] as number)) return 'CLOCK_ANOMALY';
  if (record['complete'] !== true || (record['pagesRead'] as number) < 1 || record['incompleteReason'] !== null) return 'PAGINATION_INCOMPLETE';
  return null;
}

/** Exact, non-empty, untrimmed-equal identifier. */
function isExactId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

/** A list of records keyed by an exact id; identical duplicates are tolerated, conflicting ones are malformed. */
function recordsFailure(records: unknown, idField: string, digestOne: (record: never) => string): PracticalReadFailure | null {
  if (!Array.isArray(records)) return 'MALFORMED_RESPONSE';
  const seen = new Map<string, string>();
  for (const record of records) {
    if (typeof record !== 'object' || record === null || !isExactId((record as Record<string, unknown>)[idField])) return 'MALFORMED_RESPONSE';
    const id = (record as Record<string, unknown>)[idField] as string;
    const digest = digestOne(record as never);
    const previous = seen.get(id);
    if (previous !== undefined && previous !== digest) return 'MALFORMED_RESPONSE';
    seen.set(id, digest);
  }
  return null;
}

export function observeOrderRead(result: unknown): PracticalReadContent {
  if (typeof result !== 'object' || result === null) return content('MALFORMED_RESPONSE', null, null);
  const read = result as PracticalOrderReadResult;
  const pages = typeof read.provenance === 'object' && read.provenance !== null && isSafeInteger(read.provenance.pagesRead) ? read.provenance.pagesRead : null;
  const provenanceFailure = practicalProvenanceFailure(read.provenance, 'COINDCX_FUTURES_ORDERS');
  if (provenanceFailure !== null) return content(provenanceFailure, pages, null);
  try {
    const failure = recordsFailure(read.orders, 'exchangeOrderId', (order) => rawOrderSetSha256([order]));
    if (failure !== null) return content(failure, pages, null);
    return content(null, pages, rawOrderSetSha256(dedupeOrderEvidence(read.orders)));
  } catch {
    // A record canonical JSON cannot represent (e.g. an unsafe number) is malformed.
    return content('MALFORMED_RESPONSE', pages, null);
  }
}

export function observePositionRead(result: unknown): PracticalReadContent {
  if (typeof result !== 'object' || result === null) return content('MALFORMED_RESPONSE', null, null);
  const read = result as PracticalPositionReadResult;
  const pages = typeof read.provenance === 'object' && read.provenance !== null && isSafeInteger(read.provenance.pagesRead) ? read.provenance.pagesRead : null;
  const provenanceFailure = practicalProvenanceFailure(read.provenance, 'COINDCX_FUTURES_POSITIONS');
  if (provenanceFailure !== null) return content(provenanceFailure, pages, null);
  try {
    const failure = recordsFailure(read.positions, 'venuePositionId', (position) => rawPositionSetSha256([position]));
    if (failure !== null) return content(failure, pages, null);
    return content(null, pages, rawPositionSetSha256(dedupePositionEvidence(read.positions)));
  } catch {
    return content('MALFORMED_RESPONSE', pages, null);
  }
}

/**
 * The identity read must OBSERVE exactly the configured fingerprint. A read
 * the adapter could not perform is provider unavailability; a missing or
 * unusable identity is ACCOUNT_IDENTITY_UNAVAILABLE; a different account is a
 * MISMATCH (Stage 1A: manual review).
 */
export function observeIdentityRead(read: unknown, expectedFingerprint: string): PracticalReadContent {
  if (typeof read !== 'object' || read === null) return content('MALFORMED_RESPONSE', null, null);
  const identity = read as LiveProviderAccountIdentityRead;
  if (identity.kind === 'UNAVAILABLE') {
    return content(identity.reason === 'ACCOUNT_IDENTITY_READ_FAILED' ? 'PROVIDER_UNAVAILABLE' : 'ACCOUNT_IDENTITY_UNAVAILABLE', null, null);
  }
  if (identity.kind !== 'OBSERVED') return content('MALFORMED_RESPONSE', null, null);
  const verification = verifyProviderAccountIdentity(expectedFingerprint, identity);
  switch (verification.kind) {
    case 'ACCOUNT_IDENTITY_VERIFIED':
      return content(null, null, identity.fingerprint);
    case 'ACCOUNT_IDENTITY_MISMATCH':
      return content('ACCOUNT_FINGERPRINT_MISMATCH', null, null);
    default:
      return content('ACCOUNT_IDENTITY_UNAVAILABLE', null, null);
  }
}

// ---------------------------------------------------------------------------
// One bracketed pass
// ---------------------------------------------------------------------------

/** The exact read sequence of one pass: identity, O1 P1 O2 P2 O3, identity. */
export const PRACTICAL_PASS_READ_PLAN: readonly { readonly slot: PracticalPassReadSlot; readonly kind: PracticalObservationReadKind }[] = Object.freeze([
  Object.freeze({ slot: 'IDENTITY_OPEN' as const, kind: 'IDENTITY' as const }),
  Object.freeze({ slot: 'O1' as const, kind: 'ORDERS' as const }),
  Object.freeze({ slot: 'P1' as const, kind: 'POSITIONS' as const }),
  Object.freeze({ slot: 'O2' as const, kind: 'ORDERS' as const }),
  Object.freeze({ slot: 'P2' as const, kind: 'POSITIONS' as const }),
  Object.freeze({ slot: 'O3' as const, kind: 'ORDERS' as const }),
  Object.freeze({ slot: 'IDENTITY_CLOSE' as const, kind: 'IDENTITY' as const }),
]);

/** The bracket comparisons, in the order the reads make them decidable (after O2, after P2, after O3). */
const BRACKET_COMPARISONS: readonly { readonly first: PracticalPassReadSlot; readonly second: PracticalPassReadSlot; readonly disagreement: PracticalBracketDisagreement }[] = Object.freeze([
  Object.freeze({ first: 'O1' as const, second: 'O2' as const, disagreement: 'ORDERS_O1_O2' as const }),
  Object.freeze({ first: 'P1' as const, second: 'P2' as const, disagreement: 'POSITIONS_P1_P2' as const }),
  Object.freeze({ first: 'O2' as const, second: 'O3' as const, disagreement: 'ORDERS_O2_O3' as const }),
]);

/**
 * The first bracket comparison that fails among the successful reads present,
 * or null when every decidable comparison agrees.
 */
export function practicalBracketDisagreement(reads: readonly PracticalReadObservation[]): PracticalBracketDisagreement | null {
  const digestOf = (slot: PracticalPassReadSlot): string | null => {
    const read = reads.find((candidate) => candidate.slot === slot);
    return read === undefined || read.failure !== null ? null : read.contentDigest;
  };
  for (const comparison of BRACKET_COMPARISONS) {
    const first = digestOf(comparison.first);
    const second = digestOf(comparison.second);
    if (first !== null && second !== null && first !== second) return comparison.disagreement;
  }
  return null;
}

export interface PracticalObservationPass {
  readonly index: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly durationMs: number;
  /** First read start to last read start: how far apart this pass's observations were. */
  readonly observationSkewMs: number;
  /** Largest gap from one read's end to the next read's start. */
  readonly maxInterReadGapMs: number;
  readonly reads: readonly PracticalReadObservation[];
  /** The first failure, or null for a usable pass. */
  readonly failure: PracticalPassFailure | null;
  /** Which bracket comparison failed, when `failure` is BRACKET_DISAGREEMENT. */
  readonly bracketDisagreement: PracticalBracketDisagreement | null;
  readonly complete: boolean;
  /** Identity + agreed order-set + agreed position-set digest of a usable pass; null otherwise. */
  readonly stateDigest: string | null;
}

/**
 * Assembles one pass from its reads. A pass is usable only with exactly the
 * seven planned reads, in order, each complete, with valid and strictly
 * sequential times, every bracket comparison agreeing, and both identity
 * reads equal. Failure precedence: a read's own failure, a clock anomaly, a
 * bracket disagreement, a malformed shape.
 */
function passFailureOf(reads: readonly PracticalReadObservation[]): { readonly failure: PracticalPassFailure | null; readonly bracketDisagreement: PracticalBracketDisagreement | null } {
  const readFailure = reads.find((read) => read.failure !== null)?.failure ?? null;
  if (readFailure !== null) return { failure: readFailure, bracketDisagreement: null };
  const timesOk = reads.every((read, position) => read.endedAtMs >= read.startedAtMs && (position === 0 || read.startedAtMs >= reads[position - 1]!.endedAtMs));
  if (!timesOk) return { failure: 'CLOCK_ANOMALY', bracketDisagreement: null };
  const bracketDisagreement = practicalBracketDisagreement(reads);
  if (bracketDisagreement !== null) return { failure: 'BRACKET_DISAGREEMENT', bracketDisagreement };
  const shapeOk = reads.length === PRACTICAL_PASS_READ_PLAN.length
    && reads.every((read, position) => read.slot === PRACTICAL_PASS_READ_PLAN[position]!.slot
      && read.kind === PRACTICAL_PASS_READ_PLAN[position]!.kind
      && read.complete
      && read.contentDigest !== null);
  if (!shapeOk) return { failure: 'MALFORMED_RESPONSE', bracketDisagreement: null };
  // Each identity read matched the configured fingerprint (or failed above), so they are equal; checked anyway.
  if (reads[0]!.contentDigest !== reads[6]!.contentDigest) return { failure: 'ACCOUNT_FINGERPRINT_MISMATCH', bracketDisagreement: null };
  return { failure: null, bracketDisagreement: null };
}

export function assemblePracticalPass(index: number, reads: readonly PracticalReadObservation[]): PracticalObservationPass {
  const first = reads[0];
  const last = reads.at(-1);
  const startedAtMs = first === undefined ? 0 : first.startedAtMs;
  const endedAtMs = last === undefined ? startedAtMs : last.endedAtMs;
  const { failure, bracketDisagreement } = passFailureOf(reads);
  let maxInterReadGapMs = 0;
  for (let position = 1; position < reads.length; position += 1) {
    maxInterReadGapMs = Math.max(maxInterReadGapMs, reads[position]!.startedAtMs - reads[position - 1]!.endedAtMs);
  }
  const complete = failure === null;
  const stateDigest = complete
    ? sha256CanonicalJson({
      schema: 'P18B_PRACTICAL_PASS_STATE_V2',
      identity: reads[0]!.contentDigest,
      orders: reads[1]!.contentDigest,
      positions: reads[2]!.contentDigest,
    })
    : null;
  return Object.freeze({
    index,
    startedAtMs,
    endedAtMs,
    durationMs: endedAtMs - startedAtMs,
    observationSkewMs: last === undefined || first === undefined ? 0 : last.startedAtMs - first.startedAtMs,
    maxInterReadGapMs,
    reads: Object.freeze([...reads]),
    failure,
    bracketDisagreement,
    complete,
    stateDigest,
  });
}

// ---------------------------------------------------------------------------
// The whole certification
// ---------------------------------------------------------------------------

export interface PracticalCertificationEvidenceBindings {
  readonly accountId: string;
  readonly providerAccountFingerprint: string;
  readonly runtimeEpoch: string;
  readonly reconciliationGeneration: number;
  readonly streamIncarnation: number;
  readonly runId: string;
}

export type PracticalEvidenceEvaluation =
  | {
      readonly kind: 'ACCEPTED';
      readonly summary: PracticalCertificationEvidenceSummary;
      readonly stateDigest: string;
    }
  | { readonly kind: 'REJECTED'; readonly failure: PracticalCertificationFailureCode; readonly passIndex: number | null };

/**
 * The deterministic digest over the evidence: bindings, run, and every pass's
 * state digest and reads (slot, kind, start, end, latency, pages, digest), so
 * all five O/P reads and both identity reads of every pass, with their timing
 * metadata.
 */
export function practicalEvidenceDigest(bindings: PracticalCertificationEvidenceBindings, passes: readonly PracticalObservationPass[]): string {
  return sha256CanonicalJson({
    schema: 'P18B_PRACTICAL_CERTIFICATION_EVIDENCE_V2',
    accountId: bindings.accountId,
    providerAccountFingerprint: bindings.providerAccountFingerprint,
    runtimeEpoch: bindings.runtimeEpoch,
    reconciliationGeneration: bindings.reconciliationGeneration,
    streamIncarnation: bindings.streamIncarnation,
    runId: bindings.runId,
    passes: passes.map((pass) => ({
      index: pass.index,
      startedAtMs: pass.startedAtMs,
      endedAtMs: pass.endedAtMs,
      stateDigest: pass.stateDigest,
      reads: pass.reads.map((read) => ({
        slot: read.slot,
        kind: read.kind,
        startedAtMs: read.startedAtMs,
        endedAtMs: read.endedAtMs,
        latencyMs: read.latencyMs,
        pagesRead: read.pagesRead,
        contentDigest: read.contentDigest,
      })),
    })),
  });
}

/**
 * Accepts the passes as certification evidence only if EVERY rule holds:
 * enough passes, every pass usable (complete and bracket-agreeing), every
 * pass's state digest EXACTLY equal, passes strictly sequential, every gap at
 * least the spacing ceiling, and the span at least the span ceiling. The
 * first violated rule is reported.
 */
export function evaluatePracticalCertificationEvidence(
  bindings: PracticalCertificationEvidenceBindings,
  passes: readonly PracticalObservationPass[],
  ceilings: Pick<PracticalSafetyCeilings, 'minimumPasses' | 'minimumCertificationSpanMs' | 'minimumPassSpacingMs'>,
): PracticalEvidenceEvaluation {
  const reject = (failure: PracticalCertificationFailureCode, passIndex: number | null): PracticalEvidenceEvaluation =>
    Object.freeze({ kind: 'REJECTED' as const, failure, passIndex });
  for (const pass of passes) {
    if (!pass.complete || pass.stateDigest === null) return reject(pass.failure ?? 'MALFORMED_RESPONSE', pass.index);
  }
  if (passes.length < ceilings.minimumPasses) return reject('TOO_FEW_PASSES', null);
  const agreed = passes[0]!.stateDigest!;
  for (const pass of passes) {
    if (pass.stateDigest !== agreed) return reject('OBSERVATION_DISAGREEMENT', pass.index);
  }
  let minimumSpacing = Number.MAX_SAFE_INTEGER;
  for (let position = 1; position < passes.length; position += 1) {
    const gap = passes[position]!.startedAtMs - passes[position - 1]!.endedAtMs;
    if (gap < 0) return reject('CLOCK_ANOMALY', passes[position]!.index);
    minimumSpacing = Math.min(minimumSpacing, gap);
  }
  if (minimumSpacing < ceilings.minimumPassSpacingMs) return reject('TIMING_WINDOW_UNMET', null);
  const span = passes[passes.length - 1]!.endedAtMs - passes[0]!.startedAtMs;
  if (span < ceilings.minimumCertificationSpanMs) return reject('TIMING_WINDOW_UNMET', null);
  return Object.freeze({
    kind: 'ACCEPTED' as const,
    stateDigest: agreed,
    summary: Object.freeze({
      evidenceDigest: practicalEvidenceDigest(bindings, passes),
      passCount: passes.length,
      certificationSpanMs: span,
      minimumObservedPassSpacingMs: minimumSpacing,
    }),
  });
}
