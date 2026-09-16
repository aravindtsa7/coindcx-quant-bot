import { issueResearchApprovalOrigin, ResearchApprovalOrigin } from '../research/research-validation/approval-authority';
import type { ResearchApprovalSubject } from '../research/research-validation/approval-authority';
import type {
  ResearchValidationPlanResult,
  StrategyValidationRecord,
  ValidationGateEvaluation,
  ValidationMetric,
  ValidationMetrics,
} from '../research/research-validation/types';
import { RankingError } from './errors';
import { rankNormalizeDecimalString } from './numeric';
import { P15_RANKING_V1 } from './policy';
import type {
  RankingCandidateEvidence,
  RankingComponentId,
  RankingComponentMetric,
  RankingComponentMetrics,
  RankingComponentPolicy,
} from './types';

/**
 * Phase15 authoritative input adapter.
 *
 * There is exactly one way into the ranking engine and it is the EXISTING
 * Phase12 approval authority (`issueResearchApprovalOrigin`), which:
 *
 *  - refuses any `ResearchValidationPlanResult` object the Phase12 executor did
 *    not itself construct (WeakSet-tracked genuine origin), including a
 *    byte-for-byte structural clone with correctly recomputed hashes;
 *  - recomputes `validationSubjectId` from the caller's declared
 *    `{ pair, strategyId, strategyVersion, parameterHash }` and requires an
 *    exact match against a record actually present in the genuine result; and
 *  - requires that record's terminal verdict to be exactly `PASSED`.
 *
 * Phase15 adds no weaker parallel validation path. `FAILED` and
 * `INSUFFICIENT_EVIDENCE` subjects are refused by the same call that refuses a
 * forged one, and Phase15 deliberately does not report WHICH of those three it
 * was: distinguishing them would require reading fields of an object whose
 * genuineness has not been proven.
 *
 * Metric values are then read out of the SAME genuine, deep-frozen record the
 * origin was issued from - never from a caller-supplied DTO - so a coordinated
 * "tampered metric + recomputed hash" substitution has nothing to substitute
 * into.
 */

function metricsField(metrics: ValidationMetrics, metric: string): ValidationMetric | undefined {
  return (metrics as unknown as Readonly<Record<string, ValidationMetric | undefined>>)[metric];
}

function subjectMetricField(record: StrategyValidationRecord, metric: string): ValidationMetric | undefined {
  return (record as unknown as Readonly<Record<string, ValidationMetric | undefined>>)[metric];
}

function fromValidationMetric(metric: ValidationMetric | undefined, label: string): RankingComponentMetric {
  if (metric === undefined) {
    return Object.freeze({ status: 'UNAVAILABLE' as const, reason: 'METRIC_ABSENT' as const, detail: label });
  }
  if (metric.status !== 'VALUE') {
    // UNDEFINED / INSUFFICIENT_DATA are never coerced to zero.
    return Object.freeze({ status: 'UNAVAILABLE' as const, reason: 'METRIC_NOT_VALUE' as const, detail: `${label}:${metric.status}:${metric.reason}` });
  }
  return canonicalizeOrUnavailable(metric.value, label);
}

function fromGate(gates: readonly ValidationGateEvaluation[], gateId: string, gateName: string): RankingComponentMetric {
  const gate = gates.find((entry) => entry.gateId === gateId);
  if (gate === undefined) {
    return Object.freeze({ status: 'UNAVAILABLE' as const, reason: 'METRIC_ABSENT' as const, detail: gateId });
  }
  if (gate.gateName !== gateName) {
    return Object.freeze({ status: 'UNAVAILABLE' as const, reason: 'GATE_UNAVAILABLE' as const, detail: `${gateId}:NAME_MISMATCH:${gate.gateName}` });
  }
  if (gate.status !== 'PASS' && gate.status !== 'FAIL') {
    return Object.freeze({ status: 'UNAVAILABLE' as const, reason: 'GATE_UNAVAILABLE' as const, detail: `${gateId}:${gate.status}` });
  }
  if (typeof gate.observedValue !== 'string') {
    return Object.freeze({ status: 'UNAVAILABLE' as const, reason: 'METRIC_NON_CANONICAL' as const, detail: `${gateId}:OBSERVED_VALUE_NOT_DECIMAL` });
  }
  return canonicalizeOrUnavailable(gate.observedValue, gateId);
}

function canonicalizeOrUnavailable(raw: string, label: string): RankingComponentMetric {
  try {
    return Object.freeze({ status: 'VALUE' as const, value: rankNormalizeDecimalString(raw) });
  } catch {
    return Object.freeze({ status: 'UNAVAILABLE' as const, reason: 'METRIC_NON_CANONICAL' as const, detail: label });
  }
}

function readComponent(record: StrategyValidationRecord, component: RankingComponentPolicy): RankingComponentMetric {
  const { source } = component;
  switch (source.kind) {
    case 'AGGREGATE_OOS_METRIC':
      return fromValidationMetric(metricsField(record.aggregateOosMetrics, source.metric), `aggregateOosMetrics.${source.metric}`);
    case 'GATE_OBSERVED_VALUE':
      return fromGate(record.gateEvaluations, source.gateId, source.gateName);
    case 'SUBJECT_METRIC':
      return fromValidationMetric(subjectMetricField(record, source.metric), source.metric);
    default: {
      const exhaustive: never = source;
      throw new RankingError('RANKING_POLICY_INVALID', `Unhandled ranking component source: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Derives authoritative ranking evidence for one declared candidate subject, or
 * `null` when the subject cannot be proven to be a genuine Phase12 `PASSED`
 * subject of `planResult`.
 *
 * This function performs no I/O, reruns no validation, and never mutates
 * `planResult`.
 */
export function deriveAuthoritativeRankingEvidence(
  planResult: ResearchValidationPlanResult,
  subject: ResearchApprovalSubject,
): RankingCandidateEvidence | null {
  const origin = issueResearchApprovalOrigin(planResult, subject);
  if (origin === null) return null;
  const originRecord = ResearchApprovalOrigin.read(origin);
  if (originRecord === null) return null;

  const record = planResult.subjectResults.find((entry) => entry.validationSubjectId === originRecord.validationSubjectId);
  if (record === undefined || record.verdict !== 'PASSED') return null;
  // Defensive: the origin and the record must agree on every identity field
  // before any metric is read out of the record.
  if (
    record.pair !== originRecord.pair
    || record.strategyId !== originRecord.strategyId
    || record.strategyVersion !== originRecord.strategyVersion
    || record.parameterHash !== originRecord.parameterHash
    || record.validationSubjectResultSha256 !== originRecord.validationSubjectResultSha256
  ) {
    return null;
  }

  const metrics: Partial<Record<RankingComponentId, RankingComponentMetric>> = {};
  for (const component of P15_RANKING_V1.components) {
    metrics[component.componentId] = readComponent(record, component);
  }

  return Object.freeze({
    identity: Object.freeze({
      pair: originRecord.pair,
      strategyId: originRecord.strategyId,
      strategyVersion: originRecord.strategyVersion,
      parameterHash: originRecord.parameterHash,
      validationSubjectId: originRecord.validationSubjectId,
      validationPlanId: originRecord.validationPlanId,
      validationSubjectResultSha256: originRecord.validationSubjectResultSha256,
    }),
    metrics: Object.freeze(metrics) as RankingComponentMetrics,
  });
}
