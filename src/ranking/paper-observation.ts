import { deepFreezeRanking, rankingAscii } from './core';
import { rankNormalizeDecimalString } from './numeric';
import { P15_ECONOMIC_LIMITATION } from './policy';
import {
  RANKING_SCHEMA_VERSION,
  type RankingEconomicStatus,
  type RankingFundingCapability,
  type RankingFundingCapabilityReason,
  type RankingMaxLifecycle,
  type RankingPaperEconomicStatus,
  type RankingPnlLabel,
  type StrategyRankingRun,
  type StrategyRankingRunSet,
} from './types';

/**
 * Phase14 paper observation view - strictly separate, strictly non-authoritative.
 *
 * ## Why this is a decorator and not an input
 *
 * Phase14 paper economics are funding-excluded
 * (`FUNDING_UNSUPPORTED` / `COINDCX_PROVIDER_EVIDENCE_INCOMPLETE`), so a paper
 * PnL number is not an economic performance signal and must never influence an
 * authoritative rank. Phase15 does not enforce that with a policy weight of
 * zero or a test-only convention - it enforces it STRUCTURALLY:
 *
 *  - `rankStrategyCandidates` has no parameter through which any paper value
 *    can be supplied;
 *  - the ranking core computes `compositeScore`, `rank`, `rankingRunId`,
 *    `rankingResultSha256`, `rankingRunSha256` and `rankingRunSetSha256`, and
 *    deep-freezes them, before any observation exists; and
 *  - this module only WRAPS that already-sealed evidence. It re-emits the
 *    authoritative run set by reference and adds a sibling observation map.
 *
 * Changing a paper PnL therefore cannot change a composite score, a rank or a
 * ranking identity, because no such value ever reaches the code that computes
 * them.
 *
 * ## Lineage
 *
 * A `PaperObservationView` may claim `OBSERVED` only when it carries the
 * durable Phase14 identifiers that prove the observation belongs to THIS
 * candidate. `bindPaperObservation` re-checks that binding against the
 * authoritative ranked identity and downgrades a mismatch to
 * `LINEAGE_UNPROVEN` rather than attaching a foreign observation.
 *
 * Phase15 V1 ships the contract and the binding check but NO Phase14 durable
 * reader: `src/ranking/**` may not import `src/execution/**` (the Phase15
 * architecture gate counts a type-only import as a real edge), and adding a
 * read-only Phase14 repository adapter is outside Phase15's analytical scope.
 * Consequently a paper observation is operator/adapter-supplied observational
 * metadata, never authority - which is exactly how it is labelled below.
 */

export type PaperObservationStatus = 'OBSERVED' | 'NOT_OBSERVED' | 'LINEAGE_UNPROVEN';
export type PaperReconciliationStatus = 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN';

/**
 * Declared candidate lineage metadata. In Phase 15 V1, this is caller-declared /
 * non-authoritative metadata, not proven durable facts, as Phase 15 intentionally
 * has no Phase 14 durable reader.
 */
export interface PaperObservationLineage {
  readonly accountId: string;
  /** `PaperAccount.revision` as a decimal string (the durable value is a BigInt). */
  readonly accountRevision: string;
  readonly executionPolicySnapshotId: string;
  readonly instrumentEconomicsSnapshotId: string;
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
}

/** Declared mechanical, non-economic observation metrics (non-authoritative observational metadata). Nothing here is a performance metric. */
export interface PaperMechanicalHealth {
  readonly reconciliationStatus: PaperReconciliationStatus;
  readonly observationDurationMs: number;
  readonly fillCount: number;
  readonly closedTradeCount: number;
  readonly runtimeFaultCount: number;
}

/**
 * A funding-excluded observational number. The type itself carries the label
 * and the `authoritative: false` marker, so the value cannot be displayed or
 * serialized without its disclaimer.
 */
export interface FundingExcludedObservationalValue {
  readonly label: RankingPnlLabel;
  readonly authoritative: false;
  readonly affectsCompositeScore: false;
  readonly value: string;
}

export interface PaperObservedView {
  readonly schemaVersion: typeof RANKING_SCHEMA_VERSION;
  readonly status: 'OBSERVED';
  readonly economicStatus: RankingEconomicStatus;
  readonly fundingCapability: RankingFundingCapability;
  readonly fundingCapabilityReason: RankingFundingCapabilityReason;
  readonly fundingApplied: false;
  readonly paperEconomicStatus: RankingPaperEconomicStatus;
  readonly maxLifecycle: RankingMaxLifecycle;
  readonly promotionEligible: false;
  readonly lineage: PaperObservationLineage;
  readonly mechanicalHealth: PaperMechanicalHealth;
  /**
   * Funding-excluded, non-authoritative observational economics. Displayed for
   * operators only; provably not a ranking input.
   */
  readonly nonAuthoritativeFundingExcluded: Readonly<Record<string, FundingExcludedObservationalValue>>;
}

export interface PaperUnobservedView {
  readonly schemaVersion: typeof RANKING_SCHEMA_VERSION;
  readonly status: 'NOT_OBSERVED' | 'LINEAGE_UNPROVEN';
  readonly economicStatus: RankingEconomicStatus;
  readonly maxLifecycle: RankingMaxLifecycle;
  readonly promotionEligible: false;
  readonly reason: string;
}

export type PaperObservationView = PaperObservedView | PaperUnobservedView;

function unobserved(status: 'NOT_OBSERVED' | 'LINEAGE_UNPROVEN', reason: string): PaperUnobservedView {
  return deepFreezeRanking({
    schemaVersion: RANKING_SCHEMA_VERSION,
    status,
    economicStatus: P15_ECONOMIC_LIMITATION.economicStatus,
    maxLifecycle: P15_ECONOMIC_LIMITATION.maxLifecycle,
    promotionEligible: false as const,
    reason,
  });
}

export const PAPER_OBSERVATION_NOT_OBSERVED: PaperObservationView = unobserved('NOT_OBSERVED', 'NO_PAPER_RUNTIME_OBSERVATION');

export interface BuildPaperObservationInput {
  readonly lineage: PaperObservationLineage;
  readonly mechanicalHealth: PaperMechanicalHealth;
  /** Optional funding-excluded observational economics, keyed by display name. */
  readonly fundingExcludedValues?: Readonly<Record<string, string>>;
}

/**
 * Builds an `OBSERVED` view. Every supplied economic value is wrapped in the
 * funding-excluded, non-authoritative envelope; there is no way to submit an
 * unlabelled economic number.
 */
export function buildPaperObservationView(input: BuildPaperObservationInput): PaperObservationView {
  const health = input.mechanicalHealth;
  if (
    !Number.isSafeInteger(health.observationDurationMs) || health.observationDurationMs < 0
    || !Number.isSafeInteger(health.fillCount) || health.fillCount < 0
    || !Number.isSafeInteger(health.closedTradeCount) || health.closedTradeCount < 0
    || !Number.isSafeInteger(health.runtimeFaultCount) || health.runtimeFaultCount < 0
  ) {
    return unobserved('LINEAGE_UNPROVEN', 'MECHANICAL_HEALTH_NOT_DURABLY_PROVABLE');
  }
  const entries = Object.entries(input.fundingExcludedValues ?? {})
    .sort(([left], [right]) => rankingAscii(left, right));
  const wrapped: Record<string, FundingExcludedObservationalValue> = {};
  for (const [key, value] of entries) {
    // Even a non-authoritative display value must be a real canonical decimal;
    // Phase15 never carries an unparseable "number" forward as if it were one.
    let canonical: string;
    try {
      canonical = rankNormalizeDecimalString(value);
    } catch {
      return unobserved('LINEAGE_UNPROVEN', `OBSERVATIONAL_VALUE_NOT_CANONICAL:${key}`);
    }
    wrapped[key] = {
      label: P15_ECONOMIC_LIMITATION.pnlLabel,
      authoritative: false,
      affectsCompositeScore: false,
      value: canonical,
    };
  }
  return deepFreezeRanking({
    schemaVersion: RANKING_SCHEMA_VERSION,
    status: 'OBSERVED' as const,
    economicStatus: P15_ECONOMIC_LIMITATION.economicStatus,
    fundingCapability: P15_ECONOMIC_LIMITATION.fundingCapability,
    fundingCapabilityReason: P15_ECONOMIC_LIMITATION.fundingCapabilityReason,
    fundingApplied: false as const,
    paperEconomicStatus: P15_ECONOMIC_LIMITATION.paperEconomicStatus,
    maxLifecycle: P15_ECONOMIC_LIMITATION.maxLifecycle,
    promotionEligible: false as const,
    lineage: { ...input.lineage },
    mechanicalHealth: { ...health },
    nonAuthoritativeFundingExcluded: wrapped,
  });
}

export interface RankingRunObservationView {
  readonly schemaVersion: typeof RANKING_SCHEMA_VERSION;
  /** The untouched, already-sealed authoritative ranking evidence. */
  readonly ranking: StrategyRankingRunSet;
  /** Keyed by `validationSubjectId`; present for every authoritative result. */
  readonly paperObservations: Readonly<Record<string, PaperObservationView>>;
  readonly economicStatus: RankingEconomicStatus;
  readonly promotionEligible: false;
  readonly maxLifecycle: RankingMaxLifecycle;
  /** Restated for any consumer reading only this wrapper. */
  readonly paperObservationAffectsRanking: false;
}

function lineageMatches(view: PaperObservationView, run: StrategyRankingRun, validationSubjectId: string): boolean {
  if (view.status !== 'OBSERVED') return true;
  const result = run.results.find((entry) => entry.validationSubjectId === validationSubjectId);
  if (result === undefined) return false;
  const { lineage } = view;
  return lineage.pair === result.pair
    && lineage.strategyId === result.strategyId
    && lineage.strategyVersion === result.strategyVersion
    && lineage.parameterHash === result.parameterHash;
}

/**
 * Attaches paper observations to a completed ranking run set.
 *
 * The authoritative `ranking` value is re-emitted BY REFERENCE: the same frozen
 * object, with the same `compositeScore`, `rank`, `rankingRunId`,
 * `rankingResultSha256`, `rankingRunSha256` and `rankingRunSetSha256` it had
 * before this call. An observation whose declared lineage does not match the
 * ranked candidate's authoritative identity is downgraded to
 * `LINEAGE_UNPROVEN` instead of being attached.
 */
export function attachPaperObservations(
  ranking: StrategyRankingRunSet,
  observations: Readonly<Record<string, PaperObservationView>> = {},
): RankingRunObservationView {
  const attached: Record<string, PaperObservationView> = {};
  for (const run of ranking.runs) {
    for (const result of run.results) {
      const candidate = observations[result.validationSubjectId];
      if (candidate === undefined) {
        attached[result.validationSubjectId] = PAPER_OBSERVATION_NOT_OBSERVED;
        continue;
      }
      attached[result.validationSubjectId] = lineageMatches(candidate, run, result.validationSubjectId)
        ? candidate
        : unobserved('LINEAGE_UNPROVEN', 'PAPER_LINEAGE_IDENTITY_MISMATCH');
    }
  }
  return Object.freeze({
    schemaVersion: RANKING_SCHEMA_VERSION,
    ranking,
    paperObservations: Object.freeze(attached),
    economicStatus: P15_ECONOMIC_LIMITATION.economicStatus,
    promotionEligible: false as const,
    maxLifecycle: P15_ECONOMIC_LIMITATION.maxLifecycle,
    paperObservationAffectsRanking: false as const,
  });
}
