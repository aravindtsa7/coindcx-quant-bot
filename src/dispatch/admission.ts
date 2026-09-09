import { canonicalDecimalString, evidenceContentSha256, riskDecimal, sha256CanonicalJson, RiskEngine, type PendingExposureState } from '../risk';
import type { RiskCalc } from '../risk/decimal';
import { KeyedSerialQueue } from './serial-queue';
import type { AdmissionOutcome, AdmissionRecord, AdmissionRequest, PortfolioExposureSnapshot, ReleaseOutcome } from './types';

type KnownPending = Extract<PendingExposureState, { readonly status: 'KNOWN' }>;
interface Entry { readonly record: AdmissionRecord; readonly decision: Extract<AdmissionOutcome, { readonly status: 'ADMITTED' }>['decision']; }

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
 */
export class RiskAdmissionCoordinator {
  readonly #queues = new KeyedSerialQueue<string>();
  readonly #byAccountAndDecision = new Map<string, Map<string, Entry>>();
  readonly #byAdmissionId = new Map<string, Entry>();
  readonly #latestAdmittedSequence = new Map<string, Map<string, number>>();

  public admit(request: AdmissionRequest): Promise<AdmissionOutcome> {
    return this.#queues.enqueue(request.accountId, () => this.#admitLocked(request));
  }

  public release(accountId: string, admissionId: string): Promise<ReleaseOutcome> {
    return this.#queues.enqueue(accountId, () => this.#releaseLocked(accountId, admissionId));
  }

  #admitLocked(request: AdmissionRequest): AdmissionOutcome {
    const { accountId, policy, context } = request;
    const decision = context.candidate.strategyDecision;
    const instanceId = decision.strategyInstanceId;

    // Idempotent duplicate: the same Phase 10 decisionId, still admitted, returns
    // the original grant unchanged rather than evaluating (and possibly
    // re-consuming capacity) a second time.
    const existing = this.#byAccountAndDecision.get(accountId)?.get(decision.decisionId);
    if (existing?.record.status === 'ADMITTED') {
      return { status: 'ADMITTED', decision: existing.decision, admission: existing.record };
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
    const generation = (this.#byAccountAndDecision.get(accountId)?.get(decision.decisionId)?.record.generation ?? 0) + 1;
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
    const entry: Entry = { record, decision: riskDecision };

    let byDecision = this.#byAccountAndDecision.get(accountId);
    if (byDecision === undefined) { byDecision = new Map(); this.#byAccountAndDecision.set(accountId, byDecision); }
    byDecision.set(decision.decisionId, entry);
    this.#byAdmissionId.set(record.admissionId, entry);
    let bySequence = this.#latestAdmittedSequence.get(accountId);
    if (bySequence === undefined) { bySequence = new Map(); this.#latestAdmittedSequence.set(accountId, bySequence); }
    bySequence.set(instanceId, decision.decisionSequence);

    return { status: 'ADMITTED', decision: riskDecision, admission: record };
  }

  #releaseLocked(accountId: string, admissionId: string): ReleaseOutcome {
    const entry = this.#byAdmissionId.get(admissionId);
    if (entry?.record.accountId !== accountId) return { status: 'UNKNOWN_ADMISSION' };
    if (entry.record.status === 'RELEASED') return { status: 'ALREADY_RELEASED', admission: entry.record };
    const releasedEntry: Entry = { decision: entry.decision, record: Object.freeze({ ...entry.record, status: 'RELEASED' as const }) };
    this.#byAdmissionId.set(admissionId, releasedEntry);
    this.#byAccountAndDecision.get(accountId)?.set(entry.record.sourceStrategyDecisionId, releasedEntry);
    return { status: 'RELEASED', admission: releasedEntry.record };
  }

  #overlayPending(accountId: string, context: AdmissionRequest['context']): AdmissionRequest['context'] {
    const exposureSnapshot = context.exposureSnapshot as PortfolioExposureSnapshot | null;
    if (exposureSnapshot === null) return context;
    const admitted = [...(this.#byAccountAndDecision.get(accountId)?.values() ?? [])]
      .map((entry) => entry.record).filter((record) => record.status === 'ADMITTED');
    // Overlaying pending changes the snapshot's content, so its evidence hash must be
    // resealed with it — RiskEngine's own snapshot-provenance check independently
    // recomputes and verifies this hash, and would otherwise reject the overlay as
    // tampered evidence (a stale contentSha256 no longer matching the new content).
    const withPending = { ...exposureSnapshot, pending: buildPending(exposureSnapshot.pending, admitted) };
    const resealed = { ...withPending, provenance: { ...withPending.provenance, contentSha256: evidenceContentSha256(withPending) } };
    return { ...context, exposureSnapshot: resealed };
  }
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
