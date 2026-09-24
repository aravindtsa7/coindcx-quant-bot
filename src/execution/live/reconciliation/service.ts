/**
 * The Phase18 reconciliation service (§3, §4, §12, §13, §16, §17).
 *
 * One controlled root that turns "this process just started" into a durable,
 * fenced verdict about whether an account may mutate exchange state.
 *
 * ORDERING IS FIXED AND NEVER VARIES:
 *
 *   claim generation (durable, fenced)
 *     -> read authoritative venue evidence
 *     -> validate evidence usability
 *     -> record snapshot identity against the owning run
 *     -> reconcile orders (pure)
 *     -> resolve ambiguous creates (pure)
 *     -> detect orphans (pure)
 *     -> reconcile positions (pure)
 *     -> apply proven effects durably
 *     -> optionally cancel orphans (claim BEFORE the wire call)
 *     -> persist findings
 *     -> complete the run and publish the account status
 *
 * A crash at ANY of those boundaries is safe, because the only thing that ever
 * unblocks an account is `completeRun` committing a HEALTHY status for the
 * CURRENT generation of the CURRENT runtime epoch. A run that dies halfway
 * leaves the account RUNNING — which the barrier treats as blocked — and the
 * next start claims a strictly newer generation that fences the dead one out.
 * No process-local memory participates in that recovery.
 *
 * It depends on PORTS only (`./ports.ts`) plus the Phase17 execution repository
 * port. It imports no CoinDCX module, no HTTP client, and no signer.
 */
import { createChildLogger } from '../../../monitoring/logger';
import { canonicalLiveDecimalString, liveDecimal } from '../decimal';
import { LiveExecutionError } from '../errors';
import type { LiveExecutionRepository } from '../repository';
import type { LiveRuntimeIdentity } from './barrier';
import { applyLiveOrderObservation, reclaimCancelAfterCrash, reclaimDispatchAfterCrash } from '../state-machine';
import type { LiveOrderObservation, LiveOrderStateName, LiveOrderStateRecord } from '../types';
import { buildFinding, countBlocking, findingSha256, sortFindings } from './findings';
import {
  assertEvidenceSetUsable,
  dedupeOrderEvidence,
  dedupePositionEvidence,
  evidenceSnapshotSha256,
  evidenceWindowIsSeparable,
  mergeEvidenceProvenance,
  rawEvidenceSnapshotSha256,
  rawOrderSetSha256,
  rawPositionSetSha256,
} from './evidence';
import {
  detectOrphanVenueOrders,
  planClaimRecovery,
  reconcileIdentifiedOrder,
  requiresAmbiguousCreateResolution,
  resolveAmbiguousCreate,
  type LiveClaimRecoveryEffect,
  type LiveOrderReconciliationEffect,
} from './order-reconciliation';
import { reconcilePosition, type LivePositionReconciliationEffect } from './position-attribution';
import { OrphanCleanupPolicy, type OrphanCleanupPolicyRecord } from './orphan-policy';
import type {
  LiveDurableOrderView,
  LiveOrphanCancellationPort,
  LiveReconciliationLease,
  LiveReconciliationRepository,
  LiveReconciliationStateRecord,
  LiveVenueEvidenceProvider,
} from './ports';
import type {
  LiveReconciliationFinding,
  LiveVenueEvidenceSet,
  LiveVenueOrderEvidence,
  LiveVenuePositionEvidence,
} from './types';

const logger = createChildLogger('execution:live:reconciliation');

/** A clock port, so tests are deterministic and no module reaches `Date.now` directly. */
export interface ReconciliationClock {
  nowMs(): number;
}

export class SystemReconciliationClock implements ReconciliationClock {
  public nowMs(): number { return Date.now(); }
}

export interface LiveReconciliationServiceDependencies {
  readonly repository: LiveReconciliationRepository;
  /** The Phase17 execution repository — the only writer of `live_order`. */
  readonly executionRepository: LiveExecutionRepository;
  readonly evidenceProvider: LiveVenueEvidenceProvider;
  /**
   * Identity of this process. A durable HEALTHY row stamped with a different
   * epoch never authorizes this runtime (§3).
   */
  readonly runtimeIdentity: LiveRuntimeIdentity;
  /** The one account owned by the credentials behind this evidence stream. */
  readonly credentialAccountId: string;
  readonly clock?: ReconciliationClock | undefined;
  /**
   * Orphan cancellation capability and its policy. BOTH must be present for a
   * single orphan cancel to be possible; absent means cleanup is off, which is
   * the default (§9.5).
   */
  readonly orphanCancellation?: LiveOrphanCancellationPort | undefined;
  readonly orphanPolicy?: OrphanCleanupPolicy | undefined;
  readonly requestTimeoutMs?: number | undefined;
  /**
   * Allowance applied when testing a venue-clock `created_at` against a
   * local-clock submission window. It is a CLOCK-DOMAIN allowance, never an
   * economic tolerance, and it can only ever make matching stricter-or-equal
   * in effect because it is applied to an already economically-unique
   * candidate (see `order-reconciliation.ts`).
   */
  readonly submissionWindowToleranceMs?: number | undefined;
  /**
   * [Wave B / F18-04] How many bracketed (orders/positions/orders/positions)
   * read attempts this run may make while hunting for a stable snapshot before
   * giving up and blocking. Must be a safe positive integer no larger than
   * `MAX_SNAPSHOT_ATTEMPTS_CEILING` — an unbounded or caller-controllable value
   * here would repeat the F18-10 `Infinity` class of bug in a new place.
   */
  readonly maxSnapshotAttempts?: number | undefined;
}

export interface LiveReconciliationRunResult {
  readonly accountId: string;
  readonly runId: string;
  readonly generation: number;
  readonly status: LiveReconciliationStateRecord['status'];
  readonly findings: readonly LiveReconciliationFinding[];
  readonly blockingFindingCount: number;
  readonly snapshotSha256: string;
  readonly state: LiveReconciliationStateRecord;
}

/**
 * [Wave B / F18-04, Wave B3 / F18-23] Result of the bracketed
 * snapshot-stability protocol. See
 * `LiveReconciliationService.#readStableVenueEvidence`.
 *
 * `finalOrdersProvenance`/`finalPositionsProvenance` are the UNMERGED
 * provenance of the LAST read of each kind (`ordersB`/`positionsB`) — see
 * §F18-23 in `evidence.ts`'s `evidenceWindowIsSeparable` doc for why the
 * merged, whole-bracket provenance (`evidence.ordersProvenance`/
 * `evidence.positionsProvenance`, which spans `[ordersA.start, ordersB.end]`
 * / `[positionsA.start, positionsB.end]`) must NEVER be used for that check.
 */
type LiveStableVenueEvidenceResult =
  | {
      readonly kind: 'STABLE';
      readonly evidence: LiveVenueEvidenceSet;
      readonly finalOrdersProvenance: LiveVenueEvidenceSet['ordersProvenance'];
      readonly finalPositionsProvenance: LiveVenueEvidenceSet['positionsProvenance'];
    }
  | { readonly kind: 'UNSTABLE'; readonly attempts: number; readonly snapshotSha256: string };

export type LiveReconciliationOutcome =
  | { readonly kind: 'COMPLETED'; readonly result: LiveReconciliationRunResult }
  /** Another worker owns a newer generation. This worker performed no repair. */
  | { readonly kind: 'NOT_OWNER'; readonly state: LiveReconciliationStateRecord };

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SUBMISSION_WINDOW_TOLERANCE_MS = 120_000;
/** [Wave B / F18-04] Conservative default: a small handful of retries. */
const DEFAULT_MAX_SNAPSHOT_ATTEMPTS = 3;
/**
 * [Wave B / F18-20-style guard] Implementation-owned ceiling. No configuration
 * input, environment variable, or dependency value may exceed this — the bound
 * itself is never caller-controllable, only whether to use fewer attempts.
 */
const MAX_SNAPSHOT_ATTEMPTS_CEILING = 10;

/**
 * [P18 Wave B4 / F18-25] The one finding shape for a durably-unestablished
 * orphan cancellation outcome, used both the moment it becomes ambiguous
 * (crash recovery, `#handleOrphans`) and every generation afterward it is
 * simply reasserted (`#recoverOrphanCancelClaims`). Deliberately excludes
 * anything generation- or run-specific from the evidence payload — only
 * facts that are stable for as long as the record stays `CANCEL_AMBIGUOUS`
 * (which, by the never-reclaim rule, is forever until an operator resolves
 * it) — so the SAME finding digest is produced every time and dedups to one
 * durable row rather than accumulating a new one each generation (§16).
 */
function stickyOrphanCancelAmbiguousFinding(
  pair: string,
  exchangeOrderId: string,
  cancelGeneration: number,
  cancelFaultCode: string | null,
): LiveReconciliationFinding {
  return buildFinding({
    category: 'MANUAL_REVIEW_REQUIRED',
    code: 'RECON_ORPHAN_CANCEL_AMBIGUOUS',
    subject: { pair, exchangeOrderId },
    evidence: {
      reason: 'A previous orphan cancellation has an unestablished outcome and is never resent; this remains durably blocking every generation regardless of whether the venue currently returns the order',
      cancelGeneration,
      cancelFaultCode,
    },
  });
}

/**
 * [Wave B / F18-04, guarding against an F18-10-style Infinity bug] Refuses
 * anything that is not a finite, safe, positive integer at or below the
 * implementation-owned ceiling. `undefined` takes the conservative default;
 * every other invalid input is a hard construction-time failure rather than a
 * silent clamp, so a misconfiguration is caught long before any reconciliation
 * run depends on it.
 */
function validateMaxSnapshotAttempts(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_SNAPSHOT_ATTEMPTS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SNAPSHOT_ATTEMPTS_CEILING) {
    throw new LiveExecutionError('LIVE_RECONCILIATION_EVIDENCE_INVALID', 'maxSnapshotAttempts must be a safe positive integer within the implementation-owned ceiling', {
      details: { value, ceiling: MAX_SNAPSHOT_ATTEMPTS_CEILING },
    });
  }
  return value;
}

/**
 * [Wave C2 / F18-10] The service reads the per-run cancellation ceiling only
 * from a genuine, configuration-issued policy, whose constructor has already
 * proven it a safe integer within the implementation-owned ceiling. A
 * structurally similar object (for example a cast `{ permitsAccount,
 * maxCancellationsPerRun: Infinity }`) is refused at construction, like an
 * invalid `maxSnapshotAttempts`, instead of silently defining the bound.
 */
function readGenuineOrphanPolicy(policy: OrphanCleanupPolicy | undefined): OrphanCleanupPolicyRecord | null {
  if (policy === undefined) return null;
  const record = OrphanCleanupPolicy.read(policy);
  if (record === null) {
    throw new LiveExecutionError('LIVE_EXECUTION_DISABLED', 'Only a configuration-issued orphan cleanup policy may enable orphan cancellation');
  }
  return record;
}

const COMPLETION_PROOF_ISSUER = Object.freeze({ purpose: 'reconciliation-completion-proof' });

export interface LiveReconciliationCompletionProofRecord {
  readonly accountId: string;
  readonly runId: string;
  readonly generation: number;
  readonly snapshotSha256: string;
  readonly findingSha256s: readonly string[];
}

/** Service-only proof that evaluation reached its final, persisted evidence set. */
export class LiveReconciliationCompletionProof {
  readonly #record: LiveReconciliationCompletionProofRecord;

  public constructor(issuer: unknown, record: LiveReconciliationCompletionProofRecord) {
    if (issuer !== COMPLETION_PROOF_ISSUER) {
      throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'Reconciliation completion authority is service-issued only');
    }
    this.#record = Object.freeze({ ...record, findingSha256s: Object.freeze([...record.findingSha256s].sort()) });
    Object.freeze(this);
  }

  public static read(value: unknown): LiveReconciliationCompletionProofRecord | null {
    if (!(value instanceof LiveReconciliationCompletionProof)) return null;
    try { return value.#record; } catch { return null; }
  }
}

export class LiveReconciliationService {
  readonly #repository: LiveReconciliationRepository;
  readonly #executionRepository: LiveExecutionRepository;
  readonly #evidenceProvider: LiveVenueEvidenceProvider;
  readonly #runtimeIdentity: LiveRuntimeIdentity;
  readonly #credentialAccountId: string;
  readonly #clock: ReconciliationClock;
  readonly #orphanCancellation: LiveOrphanCancellationPort | null;
  readonly #orphanPolicy: OrphanCleanupPolicyRecord | null;
  readonly #requestTimeoutMs: number;
  readonly #submissionWindowToleranceMs: number;
  readonly #maxSnapshotAttempts: number;

  public constructor(dependencies: LiveReconciliationServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#executionRepository = dependencies.executionRepository;
    this.#evidenceProvider = dependencies.evidenceProvider;
    this.#runtimeIdentity = dependencies.runtimeIdentity;
    this.#credentialAccountId = dependencies.credentialAccountId;
    this.#clock = dependencies.clock ?? new SystemReconciliationClock();
    this.#orphanCancellation = dependencies.orphanCancellation ?? null;
    this.#orphanPolicy = readGenuineOrphanPolicy(dependencies.orphanPolicy);
    this.#requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#submissionWindowToleranceMs = dependencies.submissionWindowToleranceMs ?? DEFAULT_SUBMISSION_WINDOW_TOLERANCE_MS;
    this.#maxSnapshotAttempts = validateMaxSnapshotAttempts(dependencies.maxSnapshotAttempts);
  }

  /**
   * Runs one full reconciliation for one account.
   *
   * Idempotent in effect: rerunning against unchanged durable state and
   * unchanged venue evidence applies no new economic effect, inserts no
   * duplicate event, mints no duplicate finding, and sends no second orphan
   * cancel. What DOES change is the generation, which is bookkeeping, not
   * economics.
   */
  public async reconcileAccount(accountId: string): Promise<LiveReconciliationOutcome> {
    if (accountId !== this.#credentialAccountId) {
      throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Credential-bound reconciliation cannot inspect or write another account', {
        details: { accountId },
      });
    }
    const claim = await this.#repository.claimGeneration(accountId, this.#runtimeIdentity, this.#clock.nowMs());
    if (claim.kind === 'LOST') {
      logger.warn({ accountId, currentGeneration: claim.state.currentGeneration }, 'Another reconciler owns a newer generation; performing no repair');
      return Object.freeze({ kind: 'NOT_OWNER' as const, state: claim.state });
    }
    const lease = claim.lease;
    const reconciliationAuthorization = claim.authorization;

    // From here on, a crash leaves the run RUNNING and the account blocked.
    // Nothing below can unblock the account except `completeRun` at the end.
    let durableOrders = await this.#executionRepository.listAccountOrderViews(accountId);

    // [P18 Wave A2 / F18-14] Crash-claim recovery runs FIRST and is deliberately
    // evidence-independent (§ "REQUIRED CONCEPTUAL REDESIGN"): a claim this
    // process inherited from a dead generation is classified purely from the
    // durable wire-arm proof it left behind, never from venue evidence, a
    // timeout, or process liveness. Findings accumulate into the same list
    // every other step below writes to.
    const findings: LiveReconciliationFinding[] = [];
    const orderRecovery = planClaimRecovery(durableOrders);
    findings.push(...orderRecovery.findings);
    for (const effect of orderRecovery.effects) {
      await this.#applyClaimRecoveryEffect(effect, reconciliationAuthorization);
    }
    const orphanRecovery = await this.#recoverOrphanCancelClaims(lease, reconciliationAuthorization, accountId);
    findings.push(...orphanRecovery.findings);
    const stickyAmbiguousExchangeOrderIds = orphanRecovery.stickyAmbiguousExchangeOrderIds;
    const resolvedExchangeOrderIds = orphanRecovery.resolvedExchangeOrderIds;
    if (orderRecovery.effects.length > 0) {
      // Refresh so every later step (evidence matching, ambiguous-create
      // resolution, position lineage) sees the post-recovery durable truth
      // rather than the pre-crash-recovery snapshot.
      durableOrders = await this.#executionRepository.listAccountOrderViews(accountId);
    }
    const pairs = [...new Set(durableOrders.map((order) => order.pair))].sort();

    // [Wave B / F18-04] CoinDCX exposes no atomic multi-endpoint snapshot, so a
    // lone orders-read/positions-read pair is never trusted on its own. Each
    // side is read TWICE, bracketing the other kind of read, and both
    // brackets must prove byte-identical before the result is even handed to
    // `assertEvidenceSetUsable`. This catches movement a lone timestamp check
    // cannot see at all — e.g. a brand-new resting order that never touches
    // the position aggregate — because the SECOND orders read simply differs
    // from the first, independent of what either read's own clock claims.
    const stability = await this.#readStableVenueEvidence(accountId, pairs);
    if (stability.kind === 'UNSTABLE') {
      // Exactly like unusable evidence below: an unstable snapshot is a
      // durable, blocking fact, and NOTHING downstream (order effects,
      // ambiguous-create resolution, orphan cancellation, position ownership)
      // may be computed or applied against it (§5's "no provisional economic
      // effects in a blocking run").
      await this.#repository.recordSnapshot(lease, stability.snapshotSha256, this.#clock.nowMs(), {
        validated: false,
        ordersComplete: false,
        positionsComplete: false,
      });
      return this.#completeWithFindings(lease, [...findings, buildFinding({
        category: 'AMBIGUOUS',
        code: 'RECON_EVIDENCE_SNAPSHOT_UNSTABLE',
        evidence: {
          reason: 'Repeated authoritative reads could not prove a stable venue snapshot within the bounded retry budget; venue activity between reads cannot be ruled out',
          attempts: stability.attempts,
          maxSnapshotAttempts: this.#maxSnapshotAttempts,
        },
      })], stability.snapshotSha256);
    }
    const rawEvidence = stability.evidence;
    const { finalOrdersProvenance, finalPositionsProvenance } = stability;

    let evidence: LiveVenueEvidenceSet;
    try {
      assertEvidenceSetUsable(rawEvidence, accountId);
      evidence = Object.freeze({
        ...rawEvidence,
        orders: dedupeOrderEvidence(rawEvidence.orders),
        positions: dedupePositionEvidence(rawEvidence.positions),
      });
    } catch (error) {
      // Unusable evidence is a durable, blocking fact — never a silent skip and
      // never a reason to declare the account healthy by default.
      await this.#repository.recordSnapshot(lease, evidenceSnapshotSha256(rawEvidence), this.#clock.nowMs(), {
        validated: false,
        ordersComplete: false,
        positionsComplete: false,
      });
      return this.#completeWithFindings(lease, [...findings, buildFinding({
        category: 'AMBIGUOUS',
        code: error instanceof LiveExecutionError && error.code === 'LIVE_RECONCILIATION_EVIDENCE_INVALID'
          ? 'RECON_EVIDENCE_CAUSALITY_VIOLATION'
          : 'RECON_EVIDENCE_INCOMPLETE',
        evidence: {
          reason: 'Authoritative venue evidence could not be established as usable',
          failure: error instanceof LiveExecutionError ? error.code : 'UNKNOWN',
        },
      })], evidenceSnapshotSha256(rawEvidence));
    }

    const snapshotSha256 = evidenceSnapshotSha256(evidence);
    await this.#repository.recordSnapshot(lease, snapshotSha256, this.#clock.nowMs(), {
      validated: true,
      ordersComplete: evidence.ordersProvenance.complete,
      positionsComplete: evidence.positionsProvenance.complete,
    });

    const orderEffects: LiveOrderReconciliationEffect[] = [];
    const claimedExchangeOrderIds = new Set<string>();

    // ---- evidence completeness is itself a finding (§14) -------------------
    if (!evidence.ordersProvenance.complete) {
      findings.push(buildFinding({
        category: 'AMBIGUOUS',
        code: 'RECON_EVIDENCE_INCOMPLETE',
        evidence: {
          source: evidence.ordersProvenance.source,
          reason: 'The provider order read could not prove it inspected the complete result set',
          incompleteReason: evidence.ordersProvenance.incompleteReason,
          pagesRead: evidence.ordersProvenance.pagesRead,
        },
      }));
    }
    if (!evidence.positionsProvenance.complete) {
      findings.push(buildFinding({
        category: 'AMBIGUOUS',
        code: 'RECON_EVIDENCE_INCOMPLETE',
        evidence: {
          source: evidence.positionsProvenance.source,
          reason: 'The provider position read could not prove it inspected the complete result set',
          incompleteReason: evidence.positionsProvenance.incompleteReason,
          pagesRead: evidence.positionsProvenance.pagesRead,
        },
      }));
    }

    // ---- §13: the FINAL two reads are not one atomic snapshot --------------
    // [Wave B3 / F18-23] Deliberately evaluated against `finalOrdersProvenance`
    // / `finalPositionsProvenance` (the unmerged LAST read of each kind, which
    // occur strictly sequentially: `ordersB` fully completes before
    // `positionsB` begins) rather than `evidence.ordersProvenance`/
    // `evidence.positionsProvenance` (the MERGED whole-bracket windows, which
    // span the entire `ordersA -> positionsA -> ordersB -> positionsB`
    // sequence and therefore overlap by construction under any real latency
    // — using them here made a clean, stable account with real network delay
    // between calls permanently unable to reach HEALTHY). See
    // `evidenceWindowIsSeparable`'s doc in `evidence.ts` for the full account
    // of what this check proves and why this is still the right evidence to
    // prove it against.
    if (!evidenceWindowIsSeparable({ ...evidence, ordersProvenance: finalOrdersProvenance, positionsProvenance: finalPositionsProvenance })) {
      findings.push(buildFinding({
        category: 'AMBIGUOUS',
        code: 'RECON_EVIDENCE_CAUSALITY_VIOLATION',
        evidence: {
          reason: 'The final orders and positions reads are not separable: a provider event time postdates the boundary between them, so venue activity between the two reads could change this result',
          ordersReadStartedAtMs: finalOrdersProvenance.localReadStartedAtMs,
          ordersReadEndedAtMs: finalOrdersProvenance.localReadEndedAtMs,
          positionsReadStartedAtMs: finalPositionsProvenance.localReadStartedAtMs,
          positionsReadEndedAtMs: finalPositionsProvenance.localReadEndedAtMs,
        },
      }));
    }

    // ---- orders already bound to an exact venue identity -------------------
    for (const order of durableOrders.filter((candidate) => candidate.exchangeOrderId !== null)) {
      const result = reconcileIdentifiedOrder(order, evidence);
      findings.push(...result.findings);
      orderEffects.push(...result.effects);
      for (const id of result.claimedExchangeOrderIds) claimedExchangeOrderIds.add(id);
    }

    // ---- ambiguous creates: unique proof or nothing (§6) -------------------
    const ambiguous = durableOrders.filter(requiresAmbiguousCreateResolution);
    const contested = this.#contestedCandidates(ambiguous, evidence);
    for (const order of ambiguous) {
      const result = resolveAmbiguousCreate({
        order,
        evidence,
        alreadyClaimed: claimedExchangeOrderIds,
        contestedCandidates: contested,
        submissionWindowToleranceMs: this.#submissionWindowToleranceMs,
      });
      findings.push(...result.findings);
      orderEffects.push(...result.effects);
      for (const id of result.claimedExchangeOrderIds) claimedExchangeOrderIds.add(id);
    }

    // ---- apply proven order effects durably --------------------------------
    for (const effect of orderEffects) {
        await this.#applyOrderEffect(effect, reconciliationAuthorization);
    }

    // ---- orphans (§9) ------------------------------------------------------
    const orphanDetection = detectOrphanVenueOrders(evidence, claimedExchangeOrderIds);
    const orphanHandlingFindings = orphanDetection.orphans.length > 0
      ? await this.#handleOrphans(lease, reconciliationAuthorization, accountId, orphanDetection.orphans)
      : Object.freeze([]);
    // [Wave B5 / F18-29] Suppress the generic `RECON_ORPHAN_VENUE_ORDER`
    // finding for any orphan already covered by a `RECON_ORPHAN_CANCEL_AMBIGUOUS`
    // finding this same generation — the sticky finding is strictly stronger
    // and duplicating it as a second, weaker finding for the identical
    // underlying orphan is pure operator noise, not additional safety. Two
    // sources feed the exclusion set: orphans ALREADY durably ambiguous
    // before this run even started fresh venue evidence
    // (`stickyAmbiguousExchangeOrderIds`, from `#recoverOrphanCancelClaims`
    // above) and orphans that become ambiguous for the FIRST time IN this run
    // (`#handleOrphans`'s direct-discovery branch, only known once it
    // returns) — both must be excluded, or the direct-discovery case would
    // still show a generic finding minted moments before the sticky one for
    // the exact same order. `#handleOrphans` itself still receives and
    // processes every orphan unconditionally; only the DISPLAYED finding is
    // deduplicated, never the claim/arm/cancel handling.
    const allStickyAmbiguousExchangeOrderIds = new Set(stickyAmbiguousExchangeOrderIds);
    for (const finding of orphanHandlingFindings) {
      if (finding.code === 'RECON_ORPHAN_CANCEL_AMBIGUOUS' && finding.subject.exchangeOrderId !== null) {
        allStickyAmbiguousExchangeOrderIds.add(finding.subject.exchangeOrderId);
      }
    }
    // [Wave C1 / F18-06] A currently-visible venue order whose exchange order
    // id was the subject of an EARLIER operator resolution
    // (`resolvedExchangeOrderIds`, from `#recoverOrphanCancelClaims`) is a
    // stronger signal than an ordinary fresh orphan: that resolution answered
    // a specific PAST ambiguity, not "this order may never be active again",
    // so this system must neither (a) silently treat it as still covered by
    // the old resolution, nor (b) treat it as an unremarkable new orphan. Its
    // generic finding is replaced with `RECON_ORPHAN_REAPPEARED_AFTER_RESOLUTION`.
    // Automatic cancellation is never attempted for it —
    // `claimOrphanCancellation`'s `cancelState !== 'NONE'` refusal already
    // covers that below, with nothing extra needed here — so it durably
    // blocks pending fresh human review. The historical resolution itself is
    // untouched: this never reopens, mutates, or reinterprets it.
    const reappearedFindings: LiveReconciliationFinding[] = [];
    const reappearedExchangeOrderIds = new Set<string>();
    for (const finding of orphanDetection.findings) {
      const exchangeOrderId = finding.subject.exchangeOrderId;
      if (exchangeOrderId !== null && resolvedExchangeOrderIds.has(exchangeOrderId) && !reappearedExchangeOrderIds.has(exchangeOrderId)) {
        reappearedExchangeOrderIds.add(exchangeOrderId);
        reappearedFindings.push(buildFinding({
          category: 'MANUAL_REVIEW_REQUIRED',
          code: 'RECON_ORPHAN_REAPPEARED_AFTER_RESOLUTION',
          subject: { pair: finding.subject.pair, exchangeOrderId },
          evidence: {
            reason: 'This exchange order id was the subject of a prior operator ambiguity resolution and is active at the venue again; the earlier resolution answered a different, past observation and does not apply here, automatic cancellation is never retried, and this requires fresh human review',
          },
        }));
      }
    }
    findings.push(...orphanDetection.findings.filter((finding) => {
      const exchangeOrderId = finding.subject.exchangeOrderId;
      if (exchangeOrderId === null) return true;
      if (reappearedExchangeOrderIds.has(exchangeOrderId)) return false;
      return !allStickyAmbiguousExchangeOrderIds.has(exchangeOrderId);
    }));
    findings.push(...reappearedFindings);
    findings.push(...orphanHandlingFindings);

    // ---- positions (§10, §11) ---------------------------------------------
    // Reconcile every pair either side knows about, so a venue position on a
    // pair with no local order is still detected as unattributed exposure.
    const positionPairs = [...new Set([...pairs, ...evidence.positions.map((position) => position.pair)])].sort();
    // Re-read orders after the effects above so position lineage uses the fills
    // this run just proved, rather than the pre-reconciliation snapshot.
    const reconciledOrders = orderEffects.length === 0
      ? durableOrders
      : await this.#executionRepository.listAccountOrderViews(accountId);

    for (const pair of positionPairs) {
      const pairOrders = reconciledOrders.filter((order) => order.pair === pair);
      const venuePosition = evidence.positions.find((position) => position.pair === pair) ?? null;
      const durablePosition = await this.#repository.loadLivePosition(accountId, pair);
      const result = reconcilePosition({
        accountId,
        pair,
        orders: pairOrders,
        venuePosition,
        durablePosition,
        evidence,
        hasUnresolvedOrders: pairOrders.some(isUnresolvedForOwnership),
      });
      findings.push(...result.findings);
      for (const effect of result.effects) {
        await this.#applyPositionEffect(lease, reconciliationAuthorization, effect);
      }
    }

    return this.#completeWithFindings(lease, findings, snapshotSha256);
  }

  /**
   * [Wave B / F18-04, corrected Wave B2 / F18-04] The bracketed
   * REPEATED-READ-AGREEMENT check. Despite its earlier name, this is NOT a
   * snapshot-consistency proof and MUST NOT be read as one — see the ABA
   * correction below, which independent review confirmed against the
   * original Wave B claim.
   *
   * Reads orders and positions TWICE each, in the sequence
   * `ordersA -> positionsA -> ordersB -> positionsB`, and requires BOTH
   * `ordersA == ordersB` and `positionsA == positionsB` (order-insensitive,
   * exact content) before the result is trusted.
   *
   * EXACTLY what this proves: the record set CoinDCX reported at the end of
   * this bracket (`ordersB`/`positionsB`) is IDENTICAL, field for field, to
   * what it reported at the start (`ordersA`/`positionsA`). That is genuinely
   * useful: it detects a new order, a fill, a cancellation, or a position
   * quantity/direction change that is STILL REFLECTED in the later read, and
   * it makes the two reads of each kind agree on one shared piece of
   * evidence to use.
   *
   * What this does NOT prove, and must never be described as proving
   * (corrected per independent review, F18-04): that no venue mutation
   * occurred during the bracket. A classic ABA sequence — an order (or
   * position) that appears and then fully reverts to its prior state before
   * the second read — is INVISIBLE to a content comparison of only the two
   * endpoints: `ordersA` and `ordersB` are genuinely, correctly equal, and
   * this check reports "stable" even though the venue moved in between.
   * CoinDCX exposes no snapshot revision, no monotonic account event
   * sequence, and no authoritative replay of the interval, so no number of
   * repeated REST reads — two, three, or five — can close this gap; it is a
   * structural property of polling a venue with no continuity mechanism, not
   * a bug in the read count.
   *
   * WHY THIS REMAINS SAFE FOR WHAT PHASE 18 ACTUALLY DOES WITH IT: every
   * economic effect this service can apply — ambiguous-create resolution
   * (`resolveAmbiguousCreate`), known-order advancement
   * (`reconcileIdentifiedOrder`), and position ownership
   * (`reconcilePosition`) — is computed from the FINAL agreed-upon record
   * (`ordersB`/`positionsB`), the CURRENT authoritative state, never from an
   * intermediate observation. An ABA event that fully reverts before the
   * final read therefore cannot cause a WRONG economic effect: there is
   * nothing left in the evidence this run sees to act on incorrectly. What it
   * CAN cause is a MISSED one — a transient fill or exposure that nets back to
   * exactly its prior state leaves no trace for Phase 18 to reconcile, exactly
   * as it always would for a system with no venue-side event stream. That is a
   * disclosed, accepted limitation (`docs/PHASE18_RECONCILIATION.md` §6),
   * not something this protocol claims to close.
   *
   * `assertEvidenceSetUsable`/`evidenceWindowIsSeparable` remain an
   * additional, independent diagnostic layer on the FINAL agreed evidence;
   * neither they nor this method are described as proving venue continuity.
   *
   * Bounded by `#maxSnapshotAttempts`: exhausting the budget without
   * repeated-read agreement returns `UNSTABLE` rather than looping forever or
   * falling back to a disagreeing result.
   */
  async #readStableVenueEvidence(accountId: string, pairs: readonly string[]): Promise<LiveStableVenueEvidenceResult> {
    let lastOrders: readonly LiveVenueOrderEvidence[] = [];
    let lastPositions: readonly LiveVenuePositionEvidence[] = [];
    let lastOrdersProvenance: LiveVenueEvidenceSet['ordersProvenance'] | null = null;
    let lastPositionsProvenance: LiveVenueEvidenceSet['positionsProvenance'] | null = null;

    for (let attempt = 1; attempt <= this.#maxSnapshotAttempts; attempt += 1) {
      const ordersA = await this.#evidenceProvider.readOrders({ accountId, pairs, timeoutMs: this.#requestTimeoutMs });
      const positionsA = await this.#evidenceProvider.readPositions({ accountId, timeoutMs: this.#requestTimeoutMs });
      const ordersB = await this.#evidenceProvider.readOrders({ accountId, pairs, timeoutMs: this.#requestTimeoutMs });
      const positionsB = await this.#evidenceProvider.readPositions({ accountId, timeoutMs: this.#requestTimeoutMs });

      lastOrders = ordersB.orders;
      lastPositions = positionsB.positions;
      lastOrdersProvenance = mergeEvidenceProvenance(ordersA.provenance, ordersB.provenance);
      lastPositionsProvenance = mergeEvidenceProvenance(positionsA.provenance, positionsB.provenance);

      const ordersStable = rawOrderSetSha256(ordersA.orders) === rawOrderSetSha256(ordersB.orders);
      const positionsStable = rawPositionSetSha256(positionsA.positions) === rawPositionSetSha256(positionsB.positions);
      if (ordersStable && positionsStable) {
        return {
          kind: 'STABLE',
          evidence: Object.freeze({
            accountId,
            orders: ordersB.orders,
            positions: positionsB.positions,
            ordersProvenance: lastOrdersProvenance,
            positionsProvenance: lastPositionsProvenance,
            evaluatedAtMs: this.#clock.nowMs(),
          }),
          // [Wave B3 / F18-23] UNMERGED: exactly the last (B) read of each
          // kind, which occur strictly sequentially (`ordersB` is fully
          // awaited before `positionsB` begins) — unlike the merged
          // whole-bracket provenance above, these two windows do not overlap
          // by construction under real latency.
          finalOrdersProvenance: ordersB.provenance,
          finalPositionsProvenance: positionsB.provenance,
        };
      }
      logger.warn({ accountId, attempt, maxSnapshotAttempts: this.#maxSnapshotAttempts, ordersStable, positionsStable }, 'Venue snapshot was not stable across a bracketed re-read; retrying within budget');
    }

    return {
      kind: 'UNSTABLE',
      attempts: this.#maxSnapshotAttempts,
      snapshotSha256: rawEvidenceSnapshotSha256(accountId, lastOrders, lastPositions),
    };
  }

  /**
   * Venue orders that more than one unresolved local order matches
   * economically. Such a candidate is adoptable by none of them (§6).
   */
  #contestedCandidates(
    ambiguousOrders: readonly LiveDurableOrderView[],
    evidence: LiveVenueEvidenceSet,
  ): ReadonlySet<string> {
    const counts = new Map<string, number>();
    for (const order of ambiguousOrders) {
      for (const candidate of evidence.orders) {
        // Reuse the exact same predicate the resolver uses, so the contest set
        // can never disagree with the matching rule it is protecting.
        const matches = candidate.pair === order.pair
          && candidate.side === order.side
          && candidate.wireOrderType === order.wireOrderType
          && liveDecimal(canonicalLiveDecimalString(candidate.orderedQuantity, 'orderedQuantity'))
            .equals(liveDecimal(canonicalLiveDecimalString(order.orderedQuantity, 'orderedQuantity')));
        if (matches) counts.set(candidate.exchangeOrderId, (counts.get(candidate.exchangeOrderId) ?? 0) + 1);
      }
    }
    const contested = new Set<string>();
    for (const [exchangeOrderId, count] of counts) if (count > 1) contested.add(exchangeOrderId);
    return contested;
  }

  async #applyOrderEffect(effect: LiveOrderReconciliationEffect, reconciliationAuthorization: unknown): Promise<void> {
    if (effect.kind === 'NONE') return;

    if (effect.kind === 'APPLY_OBSERVATION') {
      if (effect.clearsCancelClaim !== true) {
        // Phase17's own atomic path: validation, dedup insert, and projection
        // update in one row-locked transaction. Reconciliation adds nothing to it.
        await this.#executionRepository.applyObservationAtomically(effect.intentId, effect.observation, reconciliationAuthorization);
        return;
      }
      // [P18 Wave A2 / F18-14] This advance resolves an order whose cancel
      // claim (`CANCEL_RESERVED`/`CANCEL_AMBIGUOUS`) must be cleared in the
      // SAME durable write: `applyObservationAtomically` never touches
      // `cancelState`, and leaving it set would keep the account durably
      // blocked forever even though the economics are now proven.
      const current = await this.#executionRepository.load(effect.intentId);
      if (current === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Durable live order vanished during reconciliation', {
          details: { intentId: effect.intentId },
        });
      }
      if (current.cancelState !== 'CANCEL_RESERVED' && current.cancelState !== 'CANCEL_AMBIGUOUS') {
        logger.warn({ intentId: effect.intentId, cancelState: current.cancelState }, 'Cancel claim was already resolved by another worker; skipping this effect');
        return;
      }
      const application = applyLiveOrderObservation(current, effect.observation);
      if (application.kind !== 'APPLIED') return;
      const next = Object.freeze({ ...application.order, cancelState: 'NONE' as const, cancelFaultCode: null, cancelWireArmed: false });
      await this.#executionRepository.commitReconciledState(next, current.revision, effect.observation, reconciliationAuthorization);
      return;
    }

    if (effect.kind === 'CLEAR_CANCEL_CLAIM') {
      // [P18 Wave A2 / F18-14] `order.state` is deliberately untouched: the
      // frozen Phase17 transition table has no path from `CANCEL_REQUESTED`
      // back to `ACKNOWLEDGED`, so this never goes through the observation
      // pipeline. Only the cancel claim itself is cleared.
      const current = await this.#executionRepository.load(effect.intentId);
      if (current === null) {
        throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Durable live order vanished during reconciliation', {
          details: { intentId: effect.intentId },
        });
      }
      if (current.cancelState !== 'CANCEL_RESERVED' && current.cancelState !== 'CANCEL_AMBIGUOUS') {
        logger.warn({ intentId: effect.intentId, cancelState: current.cancelState }, 'Cancel claim was already resolved by another worker; skipping this effect');
        return;
      }
      const next = Object.freeze({ ...current, cancelState: 'NONE' as const, cancelFaultCode: null, cancelWireArmed: false, revision: current.revision + 1 });
      await this.#executionRepository.commitReconciledState(next, current.revision, null, reconciliationAuthorization);
      return;
    }

    const current = await this.#executionRepository.load(effect.intentId);
    if (current === null) {
      throw new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'Durable live order vanished during reconciliation', {
        details: { intentId: effect.intentId },
      });
    }
    // Re-prove the precondition under the current durable read. If another
    // worker resolved this order between the pure evaluation and here, the
    // state no longer matches and this effect is simply dropped — the next run
    // re-evaluates against the newer truth.
    if (current.exchangeOrderId !== null || (current.state !== 'SUBMISSION_AMBIGUOUS' && current.state !== 'DISPATCH_RESERVED')) {
      logger.warn({ intentId: effect.intentId, state: current.state }, 'Ambiguous create was resolved by another worker; skipping this effect');
      return;
    }
    const next = buildResolvedOrderState(current, effect.observation, effect.targetState);
    await this.#executionRepository.commitReconciledState(next, current.revision, effect.observation, reconciliationAuthorization);
  }

  /**
   * [P18 Wave A2 / F18-14] Applies one crash-claim reclaim proposed by
   * `planClaimRecovery`. Re-derives current durable state before writing, so a
   * claim resolved by a concurrent path between the pure plan and here is
   * simply skipped rather than double-handled.
   */
  async #applyClaimRecoveryEffect(effect: LiveClaimRecoveryEffect, reconciliationAuthorization: unknown): Promise<void> {
    const current = await this.#executionRepository.load(effect.intentId);
    if (current === null) return;
    if (effect.kind === 'RECLAIM_DISPATCH') {
      if (current.state !== 'DISPATCH_RESERVED' || current.dispatchWireArmed || current.exchangeOrderId !== null) return;
      const next = reclaimDispatchAfterCrash(current);
      await this.#executionRepository.commitReconciledState(next, current.revision, null, reconciliationAuthorization);
      return;
    }
    if (current.cancelState !== 'CANCEL_RESERVED' || current.cancelWireArmed) return;
    const next = reclaimCancelAfterCrash(current);
    await this.#executionRepository.commitReconciledState(next, current.revision, null, reconciliationAuthorization);
  }

  /**
   * [P18 Wave A2 / F18-14, extended Wave B4 / F18-25] Orphan-cancel-claim
   * crash recovery AND durable ambiguity reassertion, combined into one
   * evidence-INDEPENDENT pass at the very start of every generation, before
   * any fresh venue read even happens.
   *
   * Two durable facts are handled here, and ONLY here:
   *
   *   - [F18-14] a CLAIMED orphan cancellation this generation inherited from
   *     a dead process: an unarmed claim is reclaimed with zero exchange
   *     mutation; an armed one becomes `CANCEL_AMBIGUOUS` through the exact
   *     same durable path a live worker's own unestablished outcome uses,
   *     because local proof alone cannot show the wire request never left
   *     this process.
   *   - [F18-25] ANY orphan that is ALREADY durably `CANCEL_AMBIGUOUS` —
   *     whether it was just resolved that way above, or has been sitting
   *     ambiguous since a run many generations ago — reasserts its blocking
   *     finding for the CURRENT generation.
   *
   * The second part is deliberately independent of the fresh venue evidence
   * this run is about to read, and runs even if the orphan does not appear in
   * it at all. A durable cancellation ambiguity records "a cancel wire call
   * may have reached CoinDCX and this process does not know the outcome" — a
   * fact about what THIS SYSTEM already sent, not a fact about what the venue
   * currently shows. If the venue later stops returning that order — because
   * CoinDCX actually cancelled it, because it expired, or simply because a
   * later page boundary shifted — that says nothing about whether our earlier
   * cancel request caused it, duplicated something, or raced with an
   * unrelated event; the ambiguity is not retroactively resolved by the order
   * becoming invisible. Before this fix, the ONLY code paths that ever
   * reported `CANCEL_AMBIGUOUS` as a blocking finding were gated on the
   * orphan still appearing in the CURRENT run's fresh evidence
   * (`detectOrphanVenueOrders` -> `#handleOrphans`'s `NOT_CLAIMABLE` branch)
   * or on the crash having happened in the SAME run that discovers it. A
   * durably ambiguous orphan left over from an EARLIER run, reconciled by a
   * LATER run in which the venue no longer returns it, produced zero findings
   * and the account could reach HEALTHY with the ambiguity still unresolved —
   * exactly the confirmed exploit. Only an authoritative resolution path
   * (deferred to F18-06, out of scope for this wave) may ever clear
   * `CANCEL_AMBIGUOUS`; nothing in this method mutates it away.
   *
   * [Wave B5 / F18-29] Also returns the exact set of exchange order ids this
   * pass raised (or reasserted) a `RECON_ORPHAN_CANCEL_AMBIGUOUS` finding for.
   * `reconcileAccount` uses it to suppress the generic `RECON_ORPHAN_VENUE_ORDER`
   * finding `detectOrphanVenueOrders` would otherwise ALSO raise for the same
   * orphan when it is still currently visible — the sticky finding already
   * expresses the stronger fact ("a cancel for this order has an unestablished
   * outcome and durably blocks"), and the generic one ("an active venue order
   * has no proven local lineage") adds no information an operator does not
   * already have from the sticky one. This is presentation-only: it removes a
   * duplicate finding ROW, never the blocking behavior itself — the sticky
   * finding this set is built from still exists, still counts toward
   * `blockingFindingCount`, and is still F18-25-sticky regardless of whether
   * the venue currently returns the order.
   *
   * [Wave C1 / F18-06] Also returns the set of exchange order ids currently
   * `CANCEL_AMBIGUOUS_RESOLVED` — durably resolved by an explicit operator
   * decision (`orphan-resolution.ts`). Nothing here pushes a finding for
   * them: an operator resolution is, by construction, the ONLY way an
   * exchange order id ever reaches that state, and reaching it is precisely
   * what "the ambiguity no longer blocks" means (§F18-06). `reconcileAccount`
   * uses this set for exactly one purpose — recognizing when a currently-
   * visible venue order is the SAME exchange order id a PRIOR resolution
   * covered, so it can raise the stronger `RECON_ORPHAN_REAPPEARED_AFTER_RESOLUTION`
   * finding instead of quietly treating it as either an ordinary fresh orphan
   * or, worse, as still covered by the old resolution. The resolution itself
   * is never reopened, mutated, or reinterpreted by this — it stays exactly
   * as it was recorded, permanently auditable.
   */
  async #recoverOrphanCancelClaims(
    lease: LiveReconciliationLease,
    reconciliationAuthorization: unknown,
    accountId: string,
  ): Promise<{
    readonly findings: readonly LiveReconciliationFinding[];
    readonly stickyAmbiguousExchangeOrderIds: ReadonlySet<string>;
    readonly resolvedExchangeOrderIds: ReadonlySet<string>;
  }> {
    const findings: LiveReconciliationFinding[] = [];
    const stickyAmbiguousExchangeOrderIds = new Set<string>();
    const resolvedExchangeOrderIds = new Set<string>();
    const orphans = await this.#repository.loadOrphanOrders(accountId);
    for (const orphan of orphans) {
      if (orphan.cancelState === 'CANCEL_CLAIMED') {
        if (!orphan.cancelWireArmed) {
          await this.#repository.reclaimUnarmedOrphanCancelClaim(lease, reconciliationAuthorization, orphan.exchangeOrderId, orphan.cancelGeneration);
          continue;
        }
        await this.#repository.completeOrphanCancellation(
          lease, reconciliationAuthorization, orphan.exchangeOrderId, orphan.cancelGeneration,
          'CANCEL_AMBIGUOUS', 'LIVE_RECONCILIATION_CRASH_RECOVERY_WIRE_ARMED',
        );
        findings.push(stickyOrphanCancelAmbiguousFinding(orphan.pair, orphan.exchangeOrderId, orphan.cancelGeneration, 'LIVE_RECONCILIATION_CRASH_RECOVERY_WIRE_ARMED'));
        stickyAmbiguousExchangeOrderIds.add(orphan.exchangeOrderId);
        continue;
      }
      if (orphan.cancelState === 'CANCEL_AMBIGUOUS') {
        // [F18-25] Sticky regardless of generation gap or current evidence.
        findings.push(stickyOrphanCancelAmbiguousFinding(orphan.pair, orphan.exchangeOrderId, orphan.cancelGeneration, orphan.cancelFaultCode));
        stickyAmbiguousExchangeOrderIds.add(orphan.exchangeOrderId);
        continue;
      }
      if (orphan.cancelState === 'CANCEL_AMBIGUOUS_RESOLVED') {
        resolvedExchangeOrderIds.add(orphan.exchangeOrderId);
      }
    }
    return Object.freeze({ findings: Object.freeze(findings), stickyAmbiguousExchangeOrderIds, resolvedExchangeOrderIds });
  }

  async #applyPositionEffect(lease: LiveReconciliationLease, authorization: unknown, effect: LivePositionReconciliationEffect): Promise<void> {
    if (effect.kind === 'NONE') return;
    if (effect.kind === 'CLEAR_OWNERSHIP') {
      await this.#repository.clearPositionOwnership(lease, authorization, effect.pair);
      return;
    }
    await this.#repository.applyPositionOwnership(lease, authorization, {
      pair: effect.pair,
      shares: effect.shares,
      instrumentSpecSnapshotId: effect.instrumentSpecSnapshotId,
      materializeSingleOwner: effect.materializeSingleOwner,
      nowMs: this.#clock.nowMs(),
    });
  }

  /**
   * Records every orphan durably, then cancels at most the policy-permitted
   * number of them — each behind its own durable claim taken BEFORE the wire
   * call (§9.7).
   */
  async #handleOrphans(
    lease: LiveReconciliationLease,
    authorization: unknown,
    accountId: string,
    orphans: readonly import('./types').LiveVenueOrderEvidence[],
  ): Promise<readonly LiveReconciliationFinding[]> {
    const findings: LiveReconciliationFinding[] = [];
    for (const orphan of orphans) {
      await this.#repository.recordOrphanOrder(lease, orphan, this.#clock.nowMs());
    }

    const port = this.#orphanCancellation;
    const policy = this.#orphanPolicy;
    if (port === null || policy === null || !policy.accountAllowlist.includes(accountId)) {
      // Cleanup off or this account not allowlisted: the orphan finding already
      // blocks the account. Nothing is cancelled and nothing pretends to be
      // healthy (§9 final paragraph).
      findings.push(buildFinding({
        category: 'ORPHAN',
        code: 'RECON_ORPHAN_CLEANUP_DISABLED',
        evidence: {
          reason: 'Orphan venue orders exist and automatic cancellation is disabled or this account is not allowlisted',
          orphanCount: orphans.length,
        },
      }));
      return Object.freeze(findings);
    }

    let attempted = 0;
    for (const orphan of orphans) {
      if (attempted >= policy.maxCancellationsPerRun) break;

      const claim = await this.#repository.claimOrphanCancellation(lease, authorization, orphan.exchangeOrderId, this.#clock.nowMs());
      if (claim.kind === 'NOT_CLAIMABLE') {
        // §9.8: an ambiguous orphan cancel is NEVER resent, including after a
        // restart. [P18 Wave B4 / F18-25] Its blocking finding is NOT pushed
        // here: `#recoverOrphanCancelClaims`, which runs earlier in this same
        // `reconcileAccount` generation, already reasserts it unconditionally
        // for every durably `CANCEL_AMBIGUOUS` orphan regardless of whether
        // fresh evidence redetects it here — pushing it again from this
        // evidence-dependent branch too would only inflate the blocking count
        // with a duplicate of the exact same fact.
        continue;
      }

      attempted += 1;
      const generation = claim.record.cancelGeneration;

      // [P18 Wave B4 / F18-26] The durable pre-wire checkpoint, mirroring
      // `armDispatchWire`/`armCancelWire` in the live order service exactly:
      // committing this BEFORE the HTTP call means a worker whose
      // reconciliation generation was superseded since the claim above sends
      // ZERO wire requests — the arm itself is refused, fenced out, before the
      // gateway is ever reached — and a crash after this point is
      // unambiguously "the wire call may have been sent" (recovered via
      // `#recoverOrphanCancelClaims` as `CANCEL_AMBIGUOUS`, never resent)
      // rather than "never armed, safe to reclaim". Before this fix, the claim
      // above left `cancelWireArmed=false` all the way through the HTTP call,
      // so a crash between the request leaving this process and the response
      // being durably recorded was indistinguishable from "never sent" and the
      // unarmed-reclaim path would resend it on the next run.
      await this.#repository.armOrphanCancelWire(lease, authorization, orphan.exchangeOrderId, generation);

      const result = await port.cancelVenueOrder({
        exchangeOrderId: orphan.exchangeOrderId,
        pair: orphan.pair,
        timeoutMs: this.#requestTimeoutMs,
      });

      if (result.kind === 'CANCELLED') {
        await this.#repository.completeOrphanCancellation(lease, authorization, orphan.exchangeOrderId, generation, 'CANCEL_ACKNOWLEDGED', null);
        continue;
      }
      if (result.kind === 'REJECTED' || result.kind === 'PRE_DISPATCH_FAILURE') {
        await this.#repository.completeOrphanCancellation(lease, authorization, orphan.exchangeOrderId, generation, 'CANCEL_REJECTED', result.reasonCode);
        continue;
      }
      // [P18 Wave B4 / F18-25] Uses the SAME finding shape
      // `#recoverOrphanCancelClaims` reasserts every later generation
      // (`stickyOrphanCancelAmbiguousFinding`), built from the durable
      // `cancelFaultCode` this same call just persisted — not the raw
      // `result.reasonCode` — so the very first discovery and every
      // subsequent reassertion produce byte-identical evidence and dedupe to
      // ONE row (§16), rather than the first discovery minting a
      // differently-worded row that then sits alongside a second "reasserted"
      // row forever.
      await this.#repository.completeOrphanCancellation(lease, authorization, orphan.exchangeOrderId, generation, 'CANCEL_AMBIGUOUS', 'LIVE_ORPHAN_CANCEL_AMBIGUOUS');
      findings.push(stickyOrphanCancelAmbiguousFinding(orphan.pair, orphan.exchangeOrderId, generation, 'LIVE_ORPHAN_CANCEL_AMBIGUOUS'));
    }
    return Object.freeze(findings);
  }

  async #completeWithFindings(
    lease: LiveReconciliationLease,
    rawFindings: readonly LiveReconciliationFinding[],
    snapshotSha256: string,
  ): Promise<LiveReconciliationOutcome> {
    const findings = sortFindings(lease.accountId, rawFindings);
    await this.#repository.persistFindings(lease, findings, this.#clock.nowMs());
    const blockingFindingCount = countBlocking(findings);
    const proof = new LiveReconciliationCompletionProof(COMPLETION_PROOF_ISSUER, {
      accountId: lease.accountId,
      runId: lease.runId,
      generation: lease.generation,
      snapshotSha256,
      findingSha256s: findings.map((finding) => findingSha256(lease.accountId, finding)),
    });
    const state = await this.#repository.completeRun(lease, proof, this.#clock.nowMs());
    const status = state.status;
    logger.info(
      { accountId: lease.accountId, generation: lease.generation, status, blockingFindingCount },
      'Live reconciliation completed',
    );
    return Object.freeze({
      kind: 'COMPLETED' as const,
      result: Object.freeze({
        accountId: lease.accountId,
        runId: lease.runId,
        generation: lease.generation,
        status,
        findings,
        blockingFindingCount,
        snapshotSha256,
        state,
      }),
    });
  }
}

/**
 * An order whose true fill is unknown, so no ownership proof may rest on it.
 *
 * `DISPATCH_RESERVED` with no exchange id is a crash between claim and
 * response; `SUBMISSION_AMBIGUOUS` is an unestablished create; and
 * `RECONCILIATION_REQUIRED` is a Phase17 terminal contradiction. None of them
 * has a fill this system is entitled to treat as final.
 */
export function isUnresolvedForOwnership(order: LiveDurableOrderView): boolean {
  return order.state === 'SUBMISSION_AMBIGUOUS'
    || order.state === 'RECONCILIATION_REQUIRED'
    || (order.state === 'DISPATCH_RESERVED' && order.exchangeOrderId === null);
}

/**
 * Builds the durable record for a uniquely-proven ambiguous-create resolution.
 *
 * Pure, and deliberately conservative about what it writes: the exchange order
 * id, the exact venue fill figures, the venue status and the provider event
 * time. It never lowers a cumulative fill, and the caller has already proven
 * the transition is one `LIVE_RECONCILIATION_TRANSITIONS` permits.
 */
export function buildResolvedOrderState(
  current: LiveOrderStateRecord,
  observation: LiveOrderObservation,
  targetState: LiveOrderStateName,
): LiveOrderStateRecord {
  const ordered = liveDecimal(canonicalLiveDecimalString(current.orderedQuantity, 'orderedQuantity'));
  const filled = liveDecimal(canonicalLiveDecimalString(observation.cumulativeFilledQuantity, 'cumulativeFilledQuantity'));
  const recorded = liveDecimal(canonicalLiveDecimalString(current.cumulativeFilledQuantity, 'cumulativeFilledQuantity'));
  if (filled.lessThan(recorded)) {
    throw new LiveExecutionError('LIVE_FILL_INVALID', 'Reconciliation may not decrease a durable cumulative fill', {
      details: { intentId: current.intentId },
    });
  }
  if (filled.greaterThan(ordered)) {
    throw new LiveExecutionError('LIVE_FILL_INVALID', 'Reconciliation observed a fill above the ordered quantity', {
      details: { intentId: current.intentId },
    });
  }
  if (!liveDecimal(canonicalLiveDecimalString(observation.orderedQuantity, 'orderedQuantity')).equals(ordered)) {
    throw new LiveExecutionError('LIVE_ORDER_IDENTITY_MISMATCH', 'Reconciliation observation reports a different ordered quantity', {
      details: { intentId: current.intentId },
    });
  }
  return Object.freeze({
    ...current,
    state: targetState,
    exchangeOrderId: observation.exchangeOrderId,
    cumulativeFilledQuantity: filled.toFixed(),
    remainingQuantity: ordered.minus(filled).toFixed(),
    averageFillPrice: observation.averageFillPrice,
    lastExchangeStatus: observation.exchangeStatus,
    lastProviderEventTimeMs: current.lastProviderEventTimeMs === null
      ? observation.providerEventTimeMs
      : Math.max(current.lastProviderEventTimeMs, observation.providerEventTimeMs),
    // The Phase17 ambiguity fault is cleared only because authoritative
    // evidence proved the outcome; nothing else may clear it.
    faultCode: null,
    // [P18 Wave A2 / F18-14] The order is leaving DISPATCH_RESERVED for good,
    // so any wire-arm proof it carried is no longer meaningful.
    dispatchWireArmed: false,
    revision: current.revision + 1,
  });
}

Object.freeze(LiveReconciliationCompletionProof.prototype);
Object.freeze(LiveReconciliationCompletionProof);

// Completion proof validation must keep using this module's lexical class and
// private-field reader even when loaded through CommonJS.
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const [name, value] of Object.entries({
    SystemReconciliationClock,
    LiveReconciliationCompletionProof,
    LiveReconciliationService,
    isUnresolvedForOwnership,
    buildResolvedOrderState,
  })) {
    if (Object.getOwnPropertyDescriptor(module.exports, name)?.configurable !== false) {
      Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
    }
  }
  Object.freeze(module.exports);
}
