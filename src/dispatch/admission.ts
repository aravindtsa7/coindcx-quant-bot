import { canonicalDecimalString, evidenceContentSha256, riskDecimal, sha256CanonicalJson, RiskEngine, type PendingExposureState } from '../risk';
import type { RiskCalc } from '../risk/decimal';
import { KeyedSerialQueue } from './serial-queue';
import type { AdmissionOutcome, AdmissionRecord, AdmissionRequest, PortfolioExposureSnapshot, ReleaseOutcome } from './types';

type LiveAdmissionConsumptionOutcome =
  | { readonly status: 'CONSUMED' | 'ALREADY_CONSUMED_SAME_INTENT' }
  | { readonly status: 'UNAVAILABLE' };

interface LiveCoordinatorChannel {
  readonly admit: (request: AdmissionRequest) => Promise<AdmissionOutcome>;
  readonly consume: (accountId: string, admissionId: string, intentId: string) => Promise<LiveAdmissionConsumptionOutcome>;
  /** [F17-R04] Read-only cardinality of live consumption markers; see `liveAdmissionConsumptionCardinality`. */
  readonly consumptionCardinality: () => number;
}

/**
 * Module-private channels are installed only by the genuine class constructor.
 * Live execution never invokes a caller-overridable public method: a plain
 * object, subclass override, proxy, or structurally compatible test double has
 * no channel and therefore cannot manufacture trusted admission facts.
 */
const LIVE_COORDINATOR_CHANNELS = new WeakMap<object, LiveCoordinatorChannel>();

type KnownPending = Extract<PendingExposureState, { readonly status: 'KNOWN' }>;
/**
 * `decision` is `null` only for an entry populated by `restore()` (P14-D) that
 * this process has not yet itself re-evaluated — every entry produced by a
 * genuine `#admitLocked` evaluation always carries a real decision.
 */
interface Entry {
  readonly record: AdmissionRecord;
  readonly decision: Extract<AdmissionOutcome, { readonly status: 'ADMITTED' }>['decision'] | null;
  /**
   * [F17-R04] The Phase17 intent that has consumed this admission's capacity in
   * THIS process, or `null`. Deliberately a field of the admission entry rather
   * than a separate map keyed by `admissionId`: an independent map would be a
   * second, unpruned lifetime that grows once per consumed admission forever,
   * whereas this state is created, replaced and discarded with the entry that
   * owns it and can never outlive or outnumber it. Consumption markers are
   * therefore strictly bounded by the admission population itself, and
   * `restoreAuthoritative` — which is the only path that evicts admission
   * entries — evicts them together with the entry in a single step.
   *
   * Restart does not repopulate this: the durable authority is Phase17's
   * `live_admission_consumption` table (`PRIMARY KEY(admission_id)` plus
   * `UNIQUE(intent_id)`), which refuses a second consumer regardless of what
   * this process remembers. Nothing is fabricated here to fill that gap.
   */
  readonly consumedByIntentId: string | null;
}

/** A durably-restored admission attempt lacks the full original `RiskDecision`
 * (P14-C's `PaperReservation` persists only its identity-relevant subset,
 * never the full decision content — nothing here is fabricated to fill the
 * gap). `latestDecisionSequence` must be computed from every historical
 * attempt for the instance (any status), not only currently-`ADMITTED` ones —
 * a prior rejection never advances it, but a prior admission always did,
 * regardless of its outcome since. */
export interface AdmissionSequenceWatermark {
  readonly strategyInstanceId: string;
  readonly latestDecisionSequence: number;
}

/** [F14-04] The highest `AdmissionRecord.generation` ever durably used for one
 * `sourceStrategyDecisionId`, independent of that attempt's current status —
 * a RELEASED or CONSUMED row still occupies its generation number forever
 * (V2.1's own frozen `@@unique([accountId, riskDecisionId, generation])`
 * constraint already assumes this). Restoring only currently-ADMITTED rows
 * (as `admittedRecords` does) would silently forget a released/consumed
 * generation and let a fresh retry after restart reuse it. */
export interface AdmissionGenerationWatermark {
  readonly sourceStrategyDecisionId: string;
  readonly highestGeneration: number;
}

/**
 * [P14-D BLK-01] Internal-only capability gating account-fault marking and
 * authoritative fault-recovery replacement. Deliberately NOT exported from
 * `src/dispatch/index.ts` — only a file that imports this module directly
 * (`src/execution/persistence/restore.ts`/`paper-account-session.ts`) can
 * obtain it. This is not a general public reset/clear API: no barrel consumer
 * can erase or replace an account's pending admission state through it, and
 * `markAccountFaulted`/`restoreAuthoritative` both throw if called without
 * this exact token.
 */
export const ACCOUNT_FAULT_RECOVERY_CAPABILITY = Symbol('P14-D account-fault-recovery capability (internal, non-barrel)');

function assertFaultRecoveryCapability(capability: unknown): void {
  if (capability !== ACCOUNT_FAULT_RECOVERY_CAPABILITY) {
    throw new Error('RiskAdmissionCoordinator: invalid account-fault-recovery capability — this is an internal-only operation');
  }
}

/**
 * [C-F07] The single authoritative, account-serialized admission owner sitting
 * between `RiskEngine.evaluateRisk` and any future Phase 14 consumer.
 *
 * Scope (see the Wave C3 report's Restart Contract section): this coordinator
 * guarantees deterministic transactional admission for the lifetime of this
 * process/instance only. It holds no database and survives no restart —
 * `docs/RISK_LEVERAGE_ENGINE.md` §15 explicitly defers implementing the pending-
 * exposure adapter, and does not promise restart-survivable reservations anywhere;
 * that promise is not made here either. Persistent rehydration of admitted
 * capacity across a process restart is an explicit Phase 14 prerequisite, not
 * something this correction wave claims to solve.
 *
 * [P14-D BLK-01] Per-account fault tracking (`#faultedAccounts`) guards
 * against a durable-persistence failure occurring after this coordinator has
 * already mutated its in-memory admission state for that account (see
 * `PaperAdmissionBridge`): once faulted, `admit`/`release`/`restore` all
 * fail closed for that account until `restoreAuthoritative` — reachable only
 * via the internal capability above — atomically replaces its projection
 * from a freshly re-read, fence-verified durable snapshot. Other accounts are
 * never affected by one account's fault.
 */
export class RiskAdmissionCoordinator {
  readonly #queues = new KeyedSerialQueue<string>();
  readonly #byAccountAndDecision = new Map<string, Map<string, Entry>>();
  readonly #byAdmissionId = new Map<string, Entry>();
  readonly #latestAdmittedSequence = new Map<string, Map<string, number>>();
  /** [F14-04] accountId -> sourceStrategyDecisionId -> highest generation ever
   * durably used, restored independently of any live pending-exposure entry
   * (see `AdmissionGenerationWatermark`). */
  readonly #latestGeneration = new Map<string, Map<string, number>>();
  readonly #faultedAccounts = new Set<string>();

  public constructor() {
    LIVE_COORDINATOR_CHANNELS.set(this, Object.freeze({
      admit: (request: AdmissionRequest) => this.#queues.enqueue(request.accountId, () => this.#admitLocked(request)),
      consume: (accountId: string, admissionId: string, intentId: string) => this.#queues.enqueue(accountId, () => this.#consumeForLiveLocked(accountId, admissionId, intentId)),
      consumptionCardinality: () => {
        let total = 0;
        for (const entry of this.#byAdmissionId.values()) if (entry.consumedByIntentId !== null) total += 1;
        return total;
      },
    }));
  }

  public admit(request: AdmissionRequest): Promise<AdmissionOutcome> {
    return this.#queues.enqueue(request.accountId, () => this.#admitLocked(request));
  }

  public release(accountId: string, admissionId: string): Promise<ReleaseOutcome> {
    return this.#queues.enqueue(accountId, () => this.#releaseLocked(accountId, admissionId));
  }

  /** Read-only — safe to call from anywhere; cannot be used to mutate or bypass anything. */
  public isAccountFaulted(accountId: string): boolean {
    return this.#faultedAccounts.has(accountId);
  }

  /**
   * [P14-D BLK-01] Marks `accountId` FAULTED: every subsequent `admit`/
   * `release`/`restore` for it fails closed until `restoreAuthoritative`
   * clears the fault. Called only when a durable-persistence outcome is
   * ambiguous or known-failed AFTER this coordinator already mutated its
   * in-memory state for that account (`PaperAdmissionBridge`,
   * `PaperAccountSession`) — never for a clean rejection that mutated
   * nothing. Requires the internal capability token; not a general-purpose
   * reset.
   */
  public markAccountFaulted(capability: unknown, accountId: string): Promise<void> {
    assertFaultRecoveryCapability(capability);
    return this.#queues.enqueue(accountId, () => { this.#faultedAccounts.add(accountId); });
  }

  /**
   * [P14-D BLK-01] Authoritative fault-recovery replacement (V2-D §5): the
   * ONLY way to bring a FAULTED account back to usable state. Validates the
   * entire batch first (identical rules to `restore`), then atomically
   * replaces this account's in-memory projection in one step — never merges,
   * never partially mutates while validating — and only then clears the
   * fault flag. Unlike `restore`, this succeeds even when the account
   * already holds in-memory state (that is precisely the recovery case: the
   * prior, possibly-partial state is discarded wholesale in favor of the
   * freshly re-read durable truth). Requires the internal capability token —
   * arbitrary callers cannot invoke this to erase pending risk.
   */
  public restoreAuthoritative(
    capability: unknown, accountId: string,
    admittedRecords: readonly AdmissionRecord[], sequenceWatermarks: readonly AdmissionSequenceWatermark[],
    generationWatermarks: readonly AdmissionGenerationWatermark[] = [],
  ): Promise<void> {
    assertFaultRecoveryCapability(capability);
    return this.#queues.enqueue(accountId, () => this.#restoreAuthoritativeLocked(accountId, admittedRecords, sequenceWatermarks, generationWatermarks));
  }

  /**
   * [P14-D] Internal/startup-only restoration of durable pending admission
   * state (V2 §18) — NOT a general public minting surface. Valid only while
   * this account has no in-memory admission state yet (a fresh coordinator,
   * or an account never previously touched in this process); throws
   * otherwise, since restoring into a live account's state could silently
   * fork or double-count capacity. Every restored record's `accountId` must
   * match; a duplicate `sourceStrategyDecisionId` within one restore batch is
   * a malformed-durable-state error, never silently deduplicated. Records
   * with `status !== 'ADMITTED'` are rejected — restore only ever re-seeds
   * currently-pending capacity (V2 §20), never resurrects a released/consumed
   * admission's capacity. Callers (P14-D) must complete this before this
   * account may accept any new `admit()` call.
   */
  public restore(
    accountId: string, admittedRecords: readonly AdmissionRecord[], sequenceWatermarks: readonly AdmissionSequenceWatermark[],
    generationWatermarks: readonly AdmissionGenerationWatermark[] = [],
  ): Promise<void> {
    return this.#queues.enqueue(accountId, () => this.#restoreLocked(accountId, admittedRecords, sequenceWatermarks, generationWatermarks));
  }

  #restoreLocked(
    accountId: string, admittedRecords: readonly AdmissionRecord[], sequenceWatermarks: readonly AdmissionSequenceWatermark[],
    generationWatermarks: readonly AdmissionGenerationWatermark[],
  ): void {
    if (this.#faultedAccounts.has(accountId)) {
      throw new Error(`RiskAdmissionCoordinator.restore: account ${accountId} is FAULTED — use authoritative recovery restore, not ordinary restore`);
    }
    if (this.#byAccountAndDecision.has(accountId) || this.#latestAdmittedSequence.has(accountId)) {
      throw new Error(`RiskAdmissionCoordinator.restore: account ${accountId} already has in-memory admission state — restore is startup-only`);
    }
    const { byDecision, byAdmissionIdEntries, bySequence, byGeneration } = this.#validateRestoreBatch(accountId, admittedRecords, sequenceWatermarks, generationWatermarks);
    // All-or-nothing: only commit into the live maps after every record/watermark has validated.
    this.#byAccountAndDecision.set(accountId, byDecision);
    for (const [admissionId, entry] of byAdmissionIdEntries) this.#byAdmissionId.set(admissionId, entry);
    this.#latestAdmittedSequence.set(accountId, bySequence);
    this.#latestGeneration.set(accountId, byGeneration);
  }

  /**
   * [P14-D BLK-01] Fault-recovery counterpart to `#restoreLocked`: identical
   * validation, but always replaces (never rejects on non-empty state) and
   * clears the fault flag only after a fully-validated batch has been built.
   * Old entries for this account (and only this account) are removed from
   * `#byAdmissionId` before the replacement batch is inserted, so a stale
   * pre-fault admissionId can never linger as a phantom live entry.
   */
  #restoreAuthoritativeLocked(
    accountId: string, admittedRecords: readonly AdmissionRecord[], sequenceWatermarks: readonly AdmissionSequenceWatermark[],
    generationWatermarks: readonly AdmissionGenerationWatermark[],
  ): void {
    const { byDecision, byAdmissionIdEntries, bySequence, byGeneration } = this.#validateRestoreBatch(accountId, admittedRecords, sequenceWatermarks, generationWatermarks);
    const previous = this.#byAccountAndDecision.get(accountId);
    if (previous !== undefined) {
      for (const entry of previous.values()) this.#byAdmissionId.delete(entry.record.admissionId);
    }
    this.#byAccountAndDecision.set(accountId, byDecision);
    for (const [admissionId, entry] of byAdmissionIdEntries) this.#byAdmissionId.set(admissionId, entry);
    this.#latestAdmittedSequence.set(accountId, bySequence);
    this.#latestGeneration.set(accountId, byGeneration);
    this.#faultedAccounts.delete(accountId);
  }

  /** Shared validation for `restore`/`restoreAuthoritative` — builds a fully-validated replacement batch without mutating any live map. */
  #validateRestoreBatch(
    accountId: string, admittedRecords: readonly AdmissionRecord[], sequenceWatermarks: readonly AdmissionSequenceWatermark[],
    generationWatermarks: readonly AdmissionGenerationWatermark[],
  ): {
    readonly byDecision: Map<string, Entry>; readonly byAdmissionIdEntries: Array<readonly [string, Entry]>;
    readonly bySequence: Map<string, number>; readonly byGeneration: Map<string, number>;
  } {
    const byDecision = new Map<string, Entry>();
    const byAdmissionIdEntries: Array<readonly [string, Entry]> = [];
    // [F14-04] Every historically-durable generation for a sourceStrategyDecisionId
    // must be known before any fresh admit() is allowed to allocate the next one —
    // seeded first from every currently-ADMITTED record's own generation (still
    // live pending exposure), then raised further by the explicit historical
    // watermarks below (RELEASED/CONSUMED rows, which restore no pending exposure
    // but must still be known so a retry never reuses their generation number).
    const byGeneration = new Map<string, number>();
    for (const record of admittedRecords) {
      if (record.accountId !== accountId) {
        throw new Error(`RiskAdmissionCoordinator.restore: record accountId ${record.accountId} does not match ${accountId}`);
      }
      if (record.status !== 'ADMITTED') {
        throw new Error(`RiskAdmissionCoordinator.restore: record ${record.admissionId} is not ADMITTED — only currently-pending capacity may be restored`);
      }
      if (byDecision.has(record.sourceStrategyDecisionId)) {
        throw new Error(`RiskAdmissionCoordinator.restore: duplicate sourceStrategyDecisionId ${record.sourceStrategyDecisionId} in restore batch`);
      }
      // [F17-R04] A restored admission carries no process-local consumption
      // marker: the durable `live_admission_consumption` row is the authority
      // after a restart, and inventing a marker here would fabricate state.
      const entry: Entry = { record, decision: null, consumedByIntentId: null };
      byDecision.set(record.sourceStrategyDecisionId, entry);
      byAdmissionIdEntries.push([record.admissionId, entry]);
      byGeneration.set(record.sourceStrategyDecisionId, record.generation);
    }
    const bySequence = new Map<string, number>();
    for (const watermark of sequenceWatermarks) {
      if (!Number.isSafeInteger(watermark.latestDecisionSequence) || watermark.latestDecisionSequence < 0) {
        throw new Error(`RiskAdmissionCoordinator.restore: malformed sequence watermark for ${watermark.strategyInstanceId}`);
      }
      if (bySequence.has(watermark.strategyInstanceId)) {
        throw new Error(`RiskAdmissionCoordinator.restore: duplicate watermark for strategyInstanceId ${watermark.strategyInstanceId}`);
      }
      bySequence.set(watermark.strategyInstanceId, watermark.latestDecisionSequence);
    }
    for (const watermark of generationWatermarks) {
      if (!Number.isSafeInteger(watermark.highestGeneration) || watermark.highestGeneration < 1) {
        throw new Error(`RiskAdmissionCoordinator.restore: malformed generation watermark for ${watermark.sourceStrategyDecisionId}`);
      }
      const current = byGeneration.get(watermark.sourceStrategyDecisionId) ?? 0;
      if (watermark.highestGeneration > current) byGeneration.set(watermark.sourceStrategyDecisionId, watermark.highestGeneration);
    }
    return { byDecision, byAdmissionIdEntries, bySequence, byGeneration };
  }

  #admitLocked(request: AdmissionRequest): AdmissionOutcome {
    const { accountId, policy, context } = request;
    if (this.#faultedAccounts.has(accountId)) {
      throw new Error(`RiskAdmissionCoordinator: account ${accountId} is FAULTED — authoritative restore required before further admission`);
    }
    const decision = context.candidate.strategyDecision;
    const instanceId = decision.strategyInstanceId;

    // Idempotent duplicate: the same Phase 10 decisionId, still admitted, returns
    // the original grant unchanged rather than evaluating (and possibly
    // re-consuming capacity) a second time.
    const existing = this.#byAccountAndDecision.get(accountId)?.get(decision.decisionId);
    if (existing?.record.status === 'ADMITTED') {
      if (existing.decision !== null) {
        return { status: 'ADMITTED', decision: existing.decision, admission: existing.record };
      }
      // Restored (P14-D) entry this process has never itself evaluated: the
      // durable record already proves genuine prior admission, but the full
      // decision was never persisted (nothing is fabricated to fill that
      // gap). RiskEngine is pure/deterministic (zero I/O) — re-running it
      // here both reconstructs the real decision object and proves this
      // resubmission genuinely agrees with what was durably recorded, before
      // ever trusting it. A mismatch is a hard conflict, never a silent
      // fresh generation, while the restored admission remains ADMITTED.
      const reconfirmed = new RiskEngine(policy).evaluateRisk(this.#overlayPending(accountId, context, decision.decisionId));
      if (reconfirmed.status !== 'ACCEPTED' || reconfirmed.action !== 'OPEN' || reconfirmed.riskDecisionId !== existing.record.riskDecisionId) {
        throw new Error('RiskAdmissionCoordinator: restored admission disagrees with fresh re-evaluation — refusing to silently fork a generation while the prior admission remains ADMITTED');
      }
      const healedEntry: Entry = { record: existing.record, decision: reconfirmed, consumedByIntentId: existing.consumedByIntentId };
      this.#byAccountAndDecision.get(accountId)?.set(decision.decisionId, healedEntry);
      this.#byAdmissionId.set(existing.record.admissionId, healedEntry);
      return { status: 'ADMITTED', decision: reconfirmed, admission: existing.record };
    }

    // Older-after-newer: ordered by StrategyDecision.decisionSequence (a strict,
    // never-reused per-instance counter — no two distinct decisions from a genuine
    // kernel can ever share one), never by evaluationTimeMs/wall clock. A prior
    // rejection does not advance this watermark — only a genuine admission does.
    // Strictly-less-than (not <=) so a released admission's own decisionId can be
    // re-submitted at its original sequence without being misread as stale.
    const latestAdmittedSequence = this.#latestAdmittedSequence.get(accountId)?.get(instanceId) ?? 0;
    if (decision.decisionSequence < latestAdmittedSequence) {
      return { status: 'STALE_DECISION_SEQUENCE', strategyInstanceId: instanceId, decisionSequence: decision.decisionSequence, latestAdmittedSequence };
    }

    // Authoritative pending truth for this evaluation = whatever external/base
    // pending the caller supplied, plus every currently-ADMITTED grant this
    // coordinator itself holds for this account — obtained fresh, inside this
    // synchronous critical section, immediately before evaluation.
    const overlaid = this.#overlayPending(accountId, context);
    const riskDecision = new RiskEngine(policy).evaluateRisk(overlaid);

    if (riskDecision.status === 'REJECTED') return { status: 'REJECTED', decision: riskDecision };
    if (riskDecision.action === 'CLOSE') return { status: 'ACCEPTED_NO_CAPACITY_OWNERSHIP', decision: riskDecision };
    if (riskDecision.action !== 'OPEN') throw new Error('Admission coordinator received a non-OPEN, non-CLOSE accepted decision');

    const direction = decision.targetExposure;
    if (direction !== 'LONG' && direction !== 'SHORT') throw new Error('Accepted OPEN decision requires a directional targetExposure');
    // [F14-04] The next generation must exceed every generation this exact
    // sourceStrategyDecisionId has EVER durably used — not merely the current
    // live (in-memory) entry's generation, which restore() never repopulates
    // for a RELEASED/CONSUMED attempt (only ADMITTED rows restore a live
    // entry). `#latestGeneration` is restored independently of live pending
    // exposure precisely so a post-restart retry can never reuse a released
    // generation's number.
    const priorLiveGeneration = this.#byAccountAndDecision.get(accountId)?.get(decision.decisionId)?.record.generation ?? 0;
    const priorHistoricalGeneration = this.#latestGeneration.get(accountId)?.get(decision.decisionId) ?? 0;
    const generation = Math.max(priorLiveGeneration, priorHistoricalGeneration) + 1;
    const record: AdmissionRecord = Object.freeze({
      admissionId: sha256CanonicalJson({
        accountId, riskDecisionId: riskDecision.riskDecisionId, strategyInstanceId: instanceId, pair: decision.pair,
        approvedNotionalInr: riskDecision.approved.approvedNotionalInr, approvedMarginInr: riskDecision.approved.estimatedInitialMarginInr, generation,
      }),
      generation, accountId, riskDecisionId: riskDecision.riskDecisionId, sourceStrategyDecisionId: decision.decisionId,
      strategyInstanceId: instanceId, strategyId: decision.strategyId, strategyVersion: decision.strategyVersion, parameterHash: decision.parameterHash,
      pair: decision.pair, decisionSequence: decision.decisionSequence, direction,
      approvedNotionalInr: riskDecision.approved.approvedNotionalInr, approvedMarginInr: riskDecision.approved.estimatedInitialMarginInr, status: 'ADMITTED',
    });
    const entry: Entry = { record, decision: riskDecision, consumedByIntentId: null };

    let byDecision = this.#byAccountAndDecision.get(accountId);
    if (byDecision === undefined) { byDecision = new Map(); this.#byAccountAndDecision.set(accountId, byDecision); }
    byDecision.set(decision.decisionId, entry);
    this.#byAdmissionId.set(record.admissionId, entry);
    let bySequence = this.#latestAdmittedSequence.get(accountId);
    if (bySequence === undefined) { bySequence = new Map(); this.#latestAdmittedSequence.set(accountId, bySequence); }
    bySequence.set(instanceId, decision.decisionSequence);
    let byGeneration = this.#latestGeneration.get(accountId);
    if (byGeneration === undefined) { byGeneration = new Map(); this.#latestGeneration.set(accountId, byGeneration); }
    byGeneration.set(decision.decisionId, generation);

    return { status: 'ADMITTED', decision: riskDecision, admission: record };
  }

  #releaseLocked(accountId: string, admissionId: string): ReleaseOutcome {
    if (this.#faultedAccounts.has(accountId)) {
      throw new Error(`RiskAdmissionCoordinator: account ${accountId} is FAULTED — authoritative restore required before further release`);
    }
    const entry = this.#byAdmissionId.get(admissionId);
    if (entry?.record.accountId !== accountId) return { status: 'UNKNOWN_ADMISSION' };
    if (entry.record.status === 'RELEASED') return { status: 'ALREADY_RELEASED', admission: entry.record };
    // [F17-R04] Release replaces the entry, so the consumption marker is
    // carried forward rather than silently dropped: releasing capacity must
    // never make an already-consumed admission look freshly consumable.
    const releasedEntry: Entry = { decision: entry.decision, consumedByIntentId: entry.consumedByIntentId, record: Object.freeze({ ...entry.record, status: 'RELEASED' as const }) };
    this.#byAdmissionId.set(admissionId, releasedEntry);
    this.#byAccountAndDecision.get(accountId)?.set(entry.record.sourceStrategyDecisionId, releasedEntry);
    return { status: 'RELEASED', admission: releasedEntry.record };
  }

  /**
   * [F17-R04] Records the process-local half of live allocation consumption ON
   * the admission entry, so it adds no independently-growing structure. The
   * replacement entry is written to both maps that hold entries, exactly as
   * `#releaseLocked` does, because the two maps share entry objects by
   * reference and must never disagree about consumption.
   */
  #consumeForLiveLocked(accountId: string, admissionId: string, intentId: string): LiveAdmissionConsumptionOutcome {
    if (this.#faultedAccounts.has(accountId)) return { status: 'UNAVAILABLE' };
    const entry = this.#byAdmissionId.get(admissionId);
    if (entry?.record.accountId !== accountId || entry.record.status !== 'ADMITTED') return { status: 'UNAVAILABLE' };
    if (entry.consumedByIntentId === intentId) return { status: 'ALREADY_CONSUMED_SAME_INTENT' };
    if (entry.consumedByIntentId !== null) return { status: 'UNAVAILABLE' };
    const consumedEntry: Entry = { record: entry.record, decision: entry.decision, consumedByIntentId: intentId };
    this.#byAdmissionId.set(admissionId, consumedEntry);
    this.#byAccountAndDecision.get(accountId)?.set(entry.record.sourceStrategyDecisionId, consumedEntry);
    return { status: 'CONSUMED' };
  }

  /**
   * `excludeDecisionId` exists only for the P14-D restore self-heal path
   * (see `#admitLocked`): a restored entry re-evaluating itself must see
   * exactly the pending exposure its ORIGINAL admission saw — which never
   * included itself, since it did not yet exist in this map at that time.
   * Without this exclusion, re-confirmation would double-count the entry's
   * own notional against itself and could never agree with the original
   * evaluation. The normal (non-restore) call site never passes this,
   * because a genuinely new decisionId is never yet present in the map
   * either, making the two cases already equivalent for every other path.
   */
  #overlayPending(accountId: string, context: AdmissionRequest['context'], excludeDecisionId?: string): AdmissionRequest['context'] {
    const exposureSnapshot = context.exposureSnapshot as PortfolioExposureSnapshot | null;
    if (exposureSnapshot === null) return context;
    const admitted = [...(this.#byAccountAndDecision.get(accountId)?.entries() ?? [])]
      .filter(([decisionId]) => decisionId !== excludeDecisionId)
      .map(([, entry]) => entry.record).filter((record) => record.status === 'ADMITTED');
    // Overlaying pending changes the snapshot's content, so its evidence hash must be
    // resealed with it — RiskEngine's own snapshot-provenance check independently
    // recomputes and verifies this hash, and would otherwise reject the overlay as
    // tampered evidence (a stale contentSha256 no longer matching the new content).
    const withPending = { ...exposureSnapshot, pending: buildPending(exposureSnapshot.pending, admitted) };
    const resealed = { ...withPending, provenance: { ...withPending.provenance, contentSha256: evidenceContentSha256(withPending) } };
    return { ...context, exposureSnapshot: resealed };
  }
}

/**
 * Authenticated Phase13 admission entry point reserved for live execution.
 * Besides proving the coordinator instance, it binds every account-bearing
 * input and the instrument identity before returning the genuine outcome.
 */
export async function admitForLiveExecution(coordinator: unknown, request: AdmissionRequest): Promise<AdmissionOutcome> {
  const channel = coordinator !== null && typeof coordinator === 'object' ? LIVE_COORDINATOR_CHANNELS.get(coordinator) : undefined;
  if (channel === undefined) throw new Error('RiskAdmissionCoordinator: live admission requires a genuine coordinator instance');
  const { accountId, context } = request;
  if (context.accountSnapshot?.accountId !== accountId) throw new Error('RiskAdmissionCoordinator: live risk account does not match execution account');
  if (context.exposureSnapshot?.accountId !== accountId) throw new Error('RiskAdmissionCoordinator: live exposure account does not match execution account');
  if (context.pairSnapshot.ownership.status !== 'RECONCILED' || context.pairSnapshot.ownership.accountId !== accountId) {
    throw new Error('RiskAdmissionCoordinator: live instrument ownership does not match execution account');
  }
  if (context.candidate.pair !== context.pairSnapshot.pair
      || context.candidate.instrumentSpecSnapshotId !== context.pairSnapshot.instrumentSpecSnapshotId) {
    throw new Error('RiskAdmissionCoordinator: live risk instrument identity mismatch');
  }
  const outcome = await channel.admit(request);
  if (outcome.status === 'ADMITTED' && (outcome.admission.accountId !== accountId
      || outcome.admission.pair !== context.pairSnapshot.pair
      || outcome.admission.riskDecisionId !== outcome.decision.riskDecisionId)) {
    throw new Error('RiskAdmissionCoordinator: authenticated live admission lineage mismatch');
  }
  return outcome;
}

/** Atomic process-local half of durable live allocation consumption. */
export async function consumeLiveAdmissionForIntent(
  coordinator: unknown, accountId: string, admissionId: string, intentId: string,
): Promise<LiveAdmissionConsumptionOutcome> {
  const channel = coordinator !== null && typeof coordinator === 'object' ? LIVE_COORDINATOR_CHANNELS.get(coordinator) : undefined;
  if (channel === undefined) return { status: 'UNAVAILABLE' };
  return channel.consume(accountId, admissionId, intentId);
}

/**
 * [F17-R04] How many admission entries currently carry a live consumption
 * marker. Read-only and channel-gated: it mutates nothing, grants nothing, and
 * cannot be used to clear, forge or transfer a consumption. It exists so the
 * boundedness claim in `Entry.consumedByIntentId` is a measurable property
 * rather than an assertion — the returned count can never exceed the number of
 * admission entries this coordinator holds, and falls to zero for an account
 * whose entries `restoreAuthoritative` replaces.
 *
 * Deliberately NOT re-exported from `src/dispatch/index.ts`, for the same
 * reason as `ACCOUNT_FAULT_RECOVERY_CAPABILITY`: it is an internal diagnostic,
 * not part of the barrel's supported surface.
 */
export function liveAdmissionConsumptionCardinality(coordinator: unknown): number {
  const channel = coordinator !== null && typeof coordinator === 'object' ? LIVE_COORDINATOR_CHANNELS.get(coordinator) : undefined;
  if (channel === undefined) throw new Error('RiskAdmissionCoordinator: consumption cardinality requires a genuine coordinator instance');
  return channel.consumptionCardinality();
}

Object.freeze(RiskAdmissionCoordinator.prototype);
Object.freeze(RiskAdmissionCoordinator);

// Pin the CommonJS authority entry points to their lexical implementations.
// This is stronger than freezing a mutable value export: the properties are
// non-configurable accessors and live consumers do not trust a replaceable DTO
// reader from the module namespace.
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const [name, value] of Object.entries({ RiskAdmissionCoordinator, admitForLiveExecution, consumeLiveAdmissionForIntent, liveAdmissionConsumptionCardinality })) {
    if (Object.getOwnPropertyDescriptor(module.exports, name)?.configurable !== false) {
      Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
    }
  }
  Object.freeze(module.exports);
}

function buildPending(base: PendingExposureState, admitted: readonly AdmissionRecord[]): KnownPending {
  const known: KnownPending | null = base.status === 'KNOWN' ? base : null;
  let global = riskDecimal(known?.globalPendingNotionalInr ?? '0');
  let long = riskDecimal(known?.pendingDirectionalNotionalInr.longInr ?? '0');
  let short = riskDecimal(known?.pendingDirectionalNotionalInr.shortInr ?? '0');
  let count = known?.pendingReservationCount ?? 0;
  const pairTotals = new Map<string, RiskCalc>(Object.entries(known?.pairPendingNotionalInr ?? {}).map(([key, value]) => [key, riskDecimal(value)]));
  const strategyTotals = new Map<string, RiskCalc>(Object.entries(known?.strategyPendingNotionalInr ?? {}).map(([key, value]) => [key, riskDecimal(value)]));
  const instanceTotals = new Map<string, { notional: RiskCalc; count: number; strategyId: string; strategyVersion: string; parameterHash: string }>();
  for (const reservation of known?.instancePendingReservations ?? []) {
    instanceTotals.set(reservation.strategyInstanceId, {
      notional: riskDecimal(reservation.pendingNotionalInr), count: reservation.pendingReservationCount,
      strategyId: reservation.strategyId, strategyVersion: reservation.strategyVersion, parameterHash: reservation.parameterHash,
    });
  }
  for (const record of admitted) {
    global = global.plus(record.approvedNotionalInr);
    pairTotals.set(record.pair, (pairTotals.get(record.pair) ?? riskDecimal('0')).plus(record.approvedNotionalInr));
    strategyTotals.set(record.strategyId, (strategyTotals.get(record.strategyId) ?? riskDecimal('0')).plus(record.approvedNotionalInr));
    const priorInstance = instanceTotals.get(record.strategyInstanceId);
    instanceTotals.set(record.strategyInstanceId, {
      notional: (priorInstance?.notional ?? riskDecimal('0')).plus(record.approvedNotionalInr), count: (priorInstance?.count ?? 0) + 1,
      strategyId: record.strategyId, strategyVersion: record.strategyVersion, parameterHash: record.parameterHash,
    });
    if (record.direction === 'LONG') long = long.plus(record.approvedNotionalInr); else short = short.plus(record.approvedNotionalInr);
    count += 1;
  }
  const canonical = (value: RiskCalc): string => canonicalDecimalString(value.toFixed());
  return {
    status: 'KNOWN', globalPendingNotionalInr: canonical(global),
    pairPendingNotionalInr: Object.fromEntries([...pairTotals].map(([key, value]) => [key, canonical(value)])),
    strategyPendingNotionalInr: Object.fromEntries([...strategyTotals].map(([key, value]) => [key, canonical(value)])),
    instancePendingReservations: [...instanceTotals].map(([strategyInstanceId, entry]) => ({
      strategyInstanceId, strategyId: entry.strategyId, strategyVersion: entry.strategyVersion, parameterHash: entry.parameterHash,
      pendingNotionalInr: canonical(entry.notional), pendingReservationCount: entry.count,
    })),
    pendingReservationCount: count,
    pendingDirectionalNotionalInr: { longInr: canonical(long), shortInr: canonical(short) },
  };
}
