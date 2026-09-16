import { describe, expect, it } from 'vitest';
import { InMemoryBacktestDatasetSource } from '../../../src/backtest';
import { sha256CanonicalJson } from '../../../src/backtest/canonical-json';
import { executeResearchValidationWithGitSourceVerifier } from '../../../src/research/research-validation/executor';
import { planResearchValidationWithGitSourceVerifier } from '../../../src/research/research-validation/planner';
import type { ResearchValidationPlanInput, ResearchValidationPlanResult, StrategyValidationRecord } from '../../../src/research/research-validation/types';
import { deriveAuthoritativeRankingEvidence } from '../../../src/ranking/evidence';
import { rankStrategyCandidates, type StrategyRankingCandidateSubject } from '../../../src/ranking/engine';
import { RankingError } from '../../../src/ranking/errors';
import { candles, ControlledGitVerifier, datasetManifest, registry, resources } from '../research/strategy-coin-matrix/helpers';
import { validationInput } from '../research/research-validation/helpers';

// P15 §2/§16 — ranking authority. Every scenario below is backed by ONE REAL
// Phase12 research run, so the PASSED verdicts, subject identities, metric
// values and result hashes are genuine Phase12 output rather than a fixture
// invented for this test. Phase15 reuses the existing Phase12 approval
// authority (`issueResearchApprovalOrigin`) and adds no weaker parallel path.

const DAY = 86_400_000;
const BASE = 1_704_067_200_000;
const PAIR = 'BTC-INR';

interface Fixture {
  readonly result: ResearchValidationPlanResult;
  readonly passed: readonly StrategyValidationRecord[];
  readonly subjects: readonly StrategyRankingCandidateSubject[];
}

function subjectOf(record: StrategyValidationRecord): StrategyRankingCandidateSubject {
  return { pair: record.pair, strategyId: record.strategyId, strategyVersion: record.strategyVersion, parameterHash: record.parameterHash };
}

async function runValidation(
  mutate: (input: ResearchValidationPlanInput) => ResearchValidationPlanInput,
  days = 10,
): Promise<ResearchValidationPlanResult> {
  const rows = candles(PAIR, days * 24 * 60);
  const base = resources(PAIR);
  const resource = { ...base, datasetManifest: datasetManifest(rows), datasetSource: new InMemoryBacktestDatasetSource('p15-ranking-memory', rows) };
  const definitions = registry();
  const deps = { registry: definitions, pairResources: [resource] };

  // Two EMA_TREND parameter candidates, so Phase12 can actually compute the
  // optional `parameterNeighborhoodSensitivity` statistic P15 requires.
  const seed = mutate({
    ...validationInput([resource]),
    strategies: [{
      strategyId: 'EMA_TREND', strategyVersion: '1.0.0',
      candidateSpace: { strategyId: 'EMA_TREND', strategyVersion: '1.0.0', dimensions: { timeframeMinutes: [1], fastPeriod: [1], slowPeriod: [2, 3], priceSource: ['CLOSE'] } },
    }],
    validationWindow: { startMs: BASE + DAY, endExclusiveMs: BASE + 7 * DAY },
    walkForward: { policyId: 'P12_WALK_FORWARD_V1', trainDays: 2, testDays: 2, stepDays: 2, embargoDays: 0 },
    holdout: { holdoutStartMs: BASE + 5 * DAY, holdoutEndExclusiveMs: BASE + 7 * DAY, exposureDeclaration: 'UNSEEN_BY_OPERATOR' },
  });

  // Plan once to learn the real parameterHashes, then re-plan with each
  // candidate declared as the other's parameter neighbour.
  const probe = await planResearchValidationWithGitSourceVerifier(seed, deps, new ControlledGitVerifier());
  const hashes = [...new Set(probe.subjects.map((subject) => subject.parameterHash))];
  const input: ResearchValidationPlanInput = {
    ...seed,
    parameterNeighborhoods: hashes.map((targetParameterHash) => ({
      targetParameterHash,
      adjacentNeighborParameterHashes: hashes.filter((hash) => hash !== targetParameterHash),
    })),
  };
  const finalized = await planResearchValidationWithGitSourceVerifier(input, deps, new ControlledGitVerifier());
  return executeResearchValidationWithGitSourceVerifier(finalized, deps, {}, new ControlledGitVerifier());
}

let passingFixture: Promise<Fixture> | null = null;
function genuine(): Promise<Fixture> {
  passingFixture ??= (async () => {
    const result = await runValidation((input) => input);
    const passed = result.subjectResults.filter((record) => record.verdict === 'PASSED');
    return { result, passed, subjects: passed.map(subjectOf) };
  })();
  return passingFixture;
}

/** A short window keeps the negative-verdict fixtures cheap; they never need PASSED. */
const SHORT_DAYS = 4;
function short(input: ResearchValidationPlanInput): ResearchValidationPlanInput {
  return {
    ...input,
    validationWindow: { startMs: BASE + DAY, endExclusiveMs: BASE + 4 * DAY },
    walkForward: { policyId: 'P12_WALK_FORWARD_V1', trainDays: 1, testDays: 1, stepDays: 1, embargoDays: 0 },
    holdout: { holdoutStartMs: BASE + 3 * DAY, holdoutEndExclusiveMs: BASE + 4 * DAY, exposureDeclaration: 'UNSEEN_BY_OPERATOR' },
  };
}

let strictFixture: Promise<ResearchValidationPlanResult> | null = null;
function withFailedSubjects(): Promise<ResearchValidationPlanResult> {
  // An unreachable closed-trade floor makes GATE-01 (a pure integer count,
  // always available) FAIL. `subjectVerdict` ranks FAIL above UNAVAILABLE, so
  // every subject terminates FAILED.
  strictFixture ??= runValidation(
    (input) => ({ ...short(input), thresholds: { ...input.thresholds, minOosClosedTrades: 999_999 } }),
    SHORT_DAYS,
  );
  return strictFixture;
}

let thinFixture: Promise<ResearchValidationPlanResult> | null = null;
function withInsufficientSubjects(): Promise<ResearchValidationPlanResult> {
  // `metricPolicy.minDailyObservations` (not the approval threshold) controls
  // whether the daily-return metrics can be COMPUTED at all. Raising it above
  // what the window can supply makes Sharpe/Sortino INSUFFICIENT_DATA, which
  // `metricGate` reports as UNAVAILABLE, terminating INSUFFICIENT_EVIDENCE.
  thinFixture ??= runValidation(
    (input) => ({ ...short(input), metricPolicy: { ...input.metricPolicy, minDailyObservations: 9_999 } }),
    SHORT_DAYS,
  );
  return thinFixture;
}

describe('P15 ranking input authority', () => {
  it('produces a genuine PASSED fixture with real Phase12 identities', async () => {
    const { result, passed } = await genuine();
    expect(result.status).toBe('COMPLETED');
    expect(passed.length).toBeGreaterThan(0);
    for (const record of passed) {
      expect(record.validationSubjectId).toHaveLength(64);
      expect(record.validationSubjectResultSha256).toHaveLength(64);
    }
  }, 120_000);

  it('ranks genuine PASSED subjects and binds the real Phase12 identities into every row', async () => {
    const { result, subjects } = await genuine();
    const runSet = rankStrategyCandidates({ planResult: result, candidates: subjects });
    expect(runSet.nonAuthoritativeCandidates).toEqual([]);
    const run = runSet.runs.find((entry) => entry.pair === PAIR);
    expect(run).toBeDefined();
    expect(run?.validationPlanId).toBe(result.validationPlanId);
    expect(run?.candidateCount).toBe(subjects.length);
    for (const row of run?.results ?? []) {
      const source = result.subjectResults.find((record) => record.validationSubjectId === row.validationSubjectId);
      expect(source).toBeDefined();
      expect(row.validationSubjectResultSha256).toBe(source?.validationSubjectResultSha256);
      expect(row.parameterHash).toBe(source?.parameterHash);
      expect(row.economicStatus).toBe('FUNDING_EXCLUDED');
      expect(row.promotionEligible).toBe(false);
      expect(row.maxLifecycle).toBe('PAPER');
    }
  }, 120_000);

  it('actually RANKS the genuine subjects end-to-end (all seven components resolve)', async () => {
    const { result, subjects } = await genuine();
    const run = rankStrategyCandidates({ planResult: result, candidates: subjects }).runs.find((entry) => entry.pair === PAIR);
    expect(run?.rankedCount).toBe(subjects.length);
    const ranked = (run?.results ?? []).filter((row) => row.status === 'RANKED');
    expect(ranked.length).toBeGreaterThan(0);
    for (const row of ranked) {
      if (row.status !== 'RANKED') throw new Error('narrowing');
      expect(row.componentScores.map((entry) => entry.componentId)).toEqual([
        'SHARPE', 'SORTINO', 'MAX_DRAWDOWN', 'PROFIT_FACTOR', 'EXPECTANCY', 'OOS_CONSISTENCY', 'PARAMETER_ROBUSTNESS',
      ]);
      expect(Number.parseFloat(row.compositeScore)).toBeGreaterThanOrEqual(0);
      expect(Number.parseFloat(row.compositeScore)).toBeLessThanOrEqual(1);
      expect(row.rank).toBeGreaterThanOrEqual(1);
      expect(row.reasonCodes).toEqual(['RANKED', 'FUNDING_EXCLUDED', 'PROMOTION_BLOCKED_FUNDING_EXCLUDED']);
    }
  }, 120_000);

  it('reads component values from the genuine record, not from a caller DTO', async () => {
    const { result, passed, subjects } = await genuine();
    const first = subjects[0];
    const record = passed[0];
    expect(first).toBeDefined();
    if (first === undefined || record === undefined) throw new Error('fixture');
    const evidence = deriveAuthoritativeRankingEvidence(result, first);
    expect(evidence).not.toBeNull();
    const sharpe = evidence?.metrics.SHARPE;
    if (record.aggregateOosMetrics.sharpe.status === 'VALUE') {
      expect(sharpe?.status).toBe('VALUE');
      if (sharpe?.status === 'VALUE') expect(sharpe.value).toBe(record.aggregateOosMetrics.sharpe.value);
    }
    const gate = record.gateEvaluations.find((entry) => entry.gateId === 'GATE-08');
    expect(gate?.gateName).toBe('MIN_OOS_FOLD_PASS_RATIO');
    const consistency = evidence?.metrics.OOS_CONSISTENCY;
    if (consistency?.status === 'VALUE') expect(consistency.value).toBe(gate?.observedValue);
  }, 120_000);
});

describe('P15 adversarial authority', () => {
  it('refuses a byte-for-byte caller-fabricated plan result (fake PASSED)', async () => {
    const { result, subjects } = await genuine();
    const forged = JSON.parse(JSON.stringify(result)) as ResearchValidationPlanResult;
    expect(forged).toEqual(result);
    const runSet = rankStrategyCandidates({ planResult: forged, candidates: subjects });
    expect(runSet.runs).toEqual([]);
    expect(runSet.nonAuthoritativeCandidates).toHaveLength(subjects.length);
    for (const row of runSet.nonAuthoritativeCandidates) {
      expect(row.status).toBe('NOT_ELIGIBLE');
      expect(row.reasonCodes).toContain('VALIDATION_SUBJECT_NOT_AUTHORITATIVE');
    }
  }, 120_000);

  it('refuses a coordinated metric + result-hash substitution (fake Sharpe with a recomputed hash)', async () => {
    const { result, passed, subjects } = await genuine();
    const record = passed[0];
    const first = subjects[0];
    if (record === undefined || first === undefined) throw new Error('fixture');
    const clone = JSON.parse(JSON.stringify(result)) as ResearchValidationPlanResult;
    const target = clone.subjectResults.find((entry) => entry.validationSubjectId === record.validationSubjectId);
    if (target === undefined) throw new Error('fixture');
    // Inflate the Sharpe AND recompute `validationSubjectResultSha256` exactly
    // the way the Phase12 executor does, so the forgery is internally
    // self-consistent.
    const mutable = target as unknown as Record<string, unknown>;
    mutable['aggregateOosMetrics'] = { ...record.aggregateOosMetrics, sharpe: { status: 'VALUE', value: '99' } };
    const { validationSubjectResultSha256: _drop, ...rest } = target;
    mutable['validationSubjectResultSha256'] = sha256CanonicalJson(rest);
    expect(target.validationSubjectResultSha256).not.toBe(record.validationSubjectResultSha256);

    expect(deriveAuthoritativeRankingEvidence(clone, first)).toBeNull();
    const runSet = rankStrategyCandidates({ planResult: clone, candidates: subjects });
    expect(runSet.runs).toEqual([]);
  }, 120_000);

  it('refuses a tampered candidate identity (wrong parameterHash, pair, strategyId, strategyVersion)', async () => {
    const { result, subjects } = await genuine();
    const first = subjects[0];
    if (first === undefined) throw new Error('fixture');
    const tampered: readonly StrategyRankingCandidateSubject[] = [
      { ...first, parameterHash: 'b'.repeat(64) },
      { ...first, pair: 'ETH-INR' },
      { ...first, strategyId: 'NOT_A_REAL_STRATEGY' },
      { ...first, strategyVersion: '999.0.0' },
    ];
    for (const candidate of tampered) {
      expect(deriveAuthoritativeRankingEvidence(result, candidate)).toBeNull();
    }
    const runSet = rankStrategyCandidates({ planResult: result, candidates: tampered });
    expect(runSet.runs).toEqual([]);
    expect(runSet.nonAuthoritativeCandidates).toHaveLength(4);
  }, 120_000);

  it('refuses a wholly fabricated validation subject', async () => {
    const { result } = await genuine();
    const runSet = rankStrategyCandidates({
      planResult: result,
      candidates: [{ pair: 'SOL-INR', strategyId: 'NOTHING', strategyVersion: '1.0.0', parameterHash: 'c'.repeat(64) }],
    });
    expect(runSet.runs).toEqual([]);
    expect(runSet.nonAuthoritativeCandidates[0]?.reasonCodes).toContain('VALIDATION_SUBJECT_NOT_AUTHORITATIVE');
  }, 120_000);

  it('cannot be attacked by mutating the genuine result in place (deep-frozen)', async () => {
    const { result, passed } = await genuine();
    const record = passed[0];
    if (record === undefined) throw new Error('fixture');
    expect(() => { (record as unknown as { verdict: string }).verdict = 'FAILED'; }).toThrow();
    expect(() => { (record.aggregateOosMetrics as unknown as Record<string, unknown>)['sharpe'] = { status: 'VALUE', value: '99' }; }).toThrow();
    expect(() => { (result.subjectResults as unknown as StrategyValidationRecord[]).push(record); }).toThrow();
  }, 120_000);

  it('excludes FAILED subjects from the ranked universe', async () => {
    const strict = await withFailedSubjects();
    expect(strict.subjectResults.length).toBeGreaterThan(0);
    expect(strict.subjectResults.every((record) => record.verdict === 'FAILED')).toBe(true);
    const runSet = rankStrategyCandidates({ planResult: strict, candidates: strict.subjectResults.map(subjectOf) });
    expect(runSet.runs).toEqual([]);
    expect(runSet.nonAuthoritativeCandidates).toHaveLength(strict.subjectResults.length);
  }, 120_000);

  it('excludes INSUFFICIENT_EVIDENCE subjects from the ranked universe', async () => {
    const thin = await withInsufficientSubjects();
    expect(thin.subjectResults.length).toBeGreaterThan(0);
    expect(thin.subjectResults.every((record) => record.verdict === 'INSUFFICIENT_EVIDENCE')).toBe(true);
    const runSet = rankStrategyCandidates({ planResult: thin, candidates: thin.subjectResults.map(subjectOf) });
    expect(runSet.runs).toEqual([]);
  }, 120_000);

  it('rejects an empty declared universe explicitly rather than emitting a fake ranking', async () => {
    const { result } = await genuine();
    expect(() => rankStrategyCandidates({ planResult: result, candidates: [] })).toThrow(RankingError);
    expect(() => rankStrategyCandidates({ planResult: result, candidates: [] })).toThrow(/EMPTY_RANKING_UNIVERSE/);
  }, 120_000);

  it('rejects a duplicate declared candidate deterministically', async () => {
    const { result, subjects } = await genuine();
    const first = subjects[0];
    if (first === undefined) throw new Error('fixture');
    expect(() => rankStrategyCandidates({ planResult: result, candidates: [first, { ...first }] })).toThrow(/DUPLICATE_RANKING_CANDIDATE/);
  }, 120_000);

  it('is deterministic across repeated calls and input permutations of a genuine result', async () => {
    const { result, subjects } = await genuine();
    const baseline = rankStrategyCandidates({ planResult: result, candidates: subjects });
    expect(rankStrategyCandidates({ planResult: result, candidates: subjects }).rankingRunSetSha256).toBe(baseline.rankingRunSetSha256);
    expect(rankStrategyCandidates({ planResult: result, candidates: [...subjects].reverse() }).rankingRunSetSha256).toBe(baseline.rankingRunSetSha256);
  }, 120_000);
});
