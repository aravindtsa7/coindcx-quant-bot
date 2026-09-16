import { InMemoryBacktestDatasetSource } from '../../../src/backtest';
import { sha256CanonicalJson } from '../../../src/backtest/canonical-json';
import {
  isAuthoritativeRankingRun, isAuthoritativeRankingRunSet,
  rankStrategyCandidates, type StrategyRankingCandidateSubject,
} from '../../../src/ranking/engine';
import { computeRankingRunSha256 } from '../../../src/ranking/identity';
import type { RankingRunAuthority } from '../../../src/ranking/persistence/ranking-repository';
import { P15_COMPONENT_IDS, P15_RANKING_POLICY_ID } from '../../../src/ranking/policy';
import type {
  RankingCandidateEvidence, RankingComponentId, RankingComponentMetric, RankingComponentMetrics,
  RankedStrategyRankingResult, StrategyRankingRun, StrategyRankingRunSet,
} from '../../../src/ranking/types';
import { executeResearchValidationWithGitSourceVerifier } from '../../../src/research/research-validation/executor';
import { planResearchValidationWithGitSourceVerifier } from '../../../src/research/research-validation/planner';
import type { ResearchValidationPlanInput, ResearchValidationPlanResult } from '../../../src/research/research-validation/types';
import { candles, ControlledGitVerifier, datasetManifest, registry, resources } from '../research/strategy-coin-matrix/helpers';
import { validationInput } from '../research/research-validation/helpers';

/**
 * Fixtures for the PURE Phase15 ranking core.
 *
 * These build `RankingCandidateEvidence` directly, exercising normalization,
 * composite scoring, tie-breaking and identity without paying for a full
 * Phase12 research run. They are NOT an authority bypass: `src/ranking/index.ts`
 * does not re-export the core, so no production caller can reach it this way.
 * The authority path itself is proved separately, against a genuine Phase12
 * executor result, in `authority.test.ts`.
 */

export const TEST_PLAN_ID = 'f'.repeat(64);

export type MetricSpec = Partial<Record<RankingComponentId, string | null>>;

/** Neutral baseline: every required component present and identical. */
export const BASE_METRICS: Readonly<Record<RankingComponentId, string>> = Object.freeze({
  SHARPE: '1',
  SORTINO: '1',
  MAX_DRAWDOWN: '10',
  PROFIT_FACTOR: '1.5',
  EXPECTANCY: '100',
  OOS_CONSISTENCY: '1',
  PARAMETER_ROBUSTNESS: '0.9',
});

export interface EvidenceOptions {
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion?: string;
  readonly parameterHash?: string;
  readonly metrics?: MetricSpec;
  readonly validationPlanId?: string;
  readonly validationSubjectResultSha256?: string;
}

export function buildEvidence(options: EvidenceOptions): RankingCandidateEvidence {
  const strategyVersion = options.strategyVersion ?? '1.0.0';
  const parameterHash = options.parameterHash ?? sha256CanonicalJson({ p: options.strategyId, pair: options.pair });
  const validationSubjectId = sha256CanonicalJson({
    pair: options.pair, strategyId: options.strategyId, strategyVersion, parameterHash,
  });
  const metrics: Partial<Record<RankingComponentId, RankingComponentMetric>> = {};
  for (const componentId of P15_COMPONENT_IDS) {
    const override = options.metrics?.[componentId];
    const value = override === undefined ? BASE_METRICS[componentId] : override;
    metrics[componentId] = value === null
      ? { status: 'UNAVAILABLE', reason: 'METRIC_NOT_VALUE', detail: `${componentId}:INSUFFICIENT_DATA:TEST` }
      : { status: 'VALUE', value };
  }
  return {
    identity: {
      pair: options.pair,
      strategyId: options.strategyId,
      strategyVersion,
      parameterHash,
      validationSubjectId,
      validationPlanId: options.validationPlanId ?? TEST_PLAN_ID,
      validationSubjectResultSha256: options.validationSubjectResultSha256 ?? sha256CanonicalJson({ subject: validationSubjectId }),
    },
    metrics: metrics as RankingComponentMetrics,
  };
}

/** Deterministic, seedless permutation used to prove input-order independence. */
export function rotate<T>(values: readonly T[], by: number): readonly T[] {
  if (values.length === 0) return values;
  const offset = ((by % values.length) + values.length) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

export function everyPermutation<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length <= 1) return [values];
  const output: T[][] = [];
  values.forEach((value, index) => {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const tail of everyPermutation(rest)) output.push([value, ...tail]);
  });
  return output;
}

/**
 * The REAL ranking-engine authority verifier, for constructing a
 * `StrategyRankingRepository` in tests exactly the way production composition
 * (`src/ranking/index.ts`) does. Using anything else (a hand-authored
 * always-true stub, for instance) would test a repository nobody's production
 * code actually builds.
 */
export function testAuthority(): RankingRunAuthority {
  return { isAuthoritativeRankingRun, isAuthoritativeRankingRunSet };
}

/**
 * A structurally-valid, self-hashed, self-frozen forged run/run-set - never
 * engine output. Shared by every test that needs to demonstrate a forged,
 * self-consistent object (correct hash, correct policy IDs, correct economic
 * firewall) that nonetheless never touched genuine Phase12 evidence.
 */
export function forgeSelfConsistentRunSet(rankingRunId: string): { run: StrategyRankingRun; runSet: StrategyRankingRunSet } {
  const rawRun = {
    rankingRunId,
    schemaVersion: 1,
    rankingPolicyId: P15_RANKING_POLICY_ID,
    rankingPolicyVersion: 'P15_RANKING_V1' as const,
    pair: 'BTC-INR',
    validationPlanId: 'e'.repeat(64),
    candidateCount: 0,
    rankedCount: 0,
    economicStatus: 'FUNDING_EXCLUDED' as const,
    promotionEligible: false as const,
    maxLifecycle: 'PAPER' as const,
    results: Object.freeze([]),
  };
  const runHash = computeRankingRunSha256(rawRun as unknown as Omit<StrategyRankingRun, 'rankingRunSha256'>);
  const run = Object.freeze({ ...rawRun, rankingRunSha256: runHash }) as unknown as StrategyRankingRun;
  const rawRunSet = {
    schemaVersion: 1,
    rankingPolicyId: rawRun.rankingPolicyId,
    rankingPolicyVersion: 'P15_RANKING_V1' as const,
    validationPlanId: rawRun.validationPlanId,
    runs: Object.freeze([run]),
    nonAuthoritativeCandidates: Object.freeze([]),
  };
  const runSet = Object.freeze({ ...rawRunSet, rankingRunSetSha256: 'placeholder-not-checked-by-authority' }) as unknown as StrategyRankingRunSet;
  return { run, runSet };
}

export function runForPair(runSet: StrategyRankingRunSet, pair: string): StrategyRankingRun {
  const run = runSet.runs.find((entry) => entry.pair === pair);
  if (run === undefined) throw new Error(`No ranking run for pair ${pair}`);
  return run;
}

export function rankedResults(run: StrategyRankingRun): readonly RankedStrategyRankingResult[] {
  return run.results.filter((entry): entry is RankedStrategyRankingResult => entry.status === 'RANKED');
}

export function rankOrder(run: StrategyRankingRun): readonly string[] {
  return rankedResults(run).map((entry) => entry.strategyId);
}

const DAY = 86_400_000;
const BASE = 1_704_067_200_000;
const DAYS = 10;

function makePairResources(pair: string) {
  const rows = candles(pair, DAYS * 24 * 60);
  const base = resources(pair);
  return {
    ...base,
    datasetManifest: datasetManifest(rows),
    datasetSource: new InMemoryBacktestDatasetSource(`p15-${pair}`, rows),
  };
}

export interface GenuineRankingFixture {
  readonly planResult: ResearchValidationPlanResult;
  readonly candidates: readonly StrategyRankingCandidateSubject[];
  readonly runSet: StrategyRankingRunSet;
}

let cachedFixturePromise: Promise<GenuineRankingFixture> | null = null;

export function getGenuineRankingFixture(): Promise<GenuineRankingFixture> {
  if (cachedFixturePromise !== null) return cachedFixturePromise;
  cachedFixturePromise = (async () => {
    const resBtc = makePairResources('BTC-INR');
    const resEth = makePairResources('ETH-INR');
    const deps = { registry: registry(), pairResources: [resBtc, resEth] };
    const baseInput = validationInput([resBtc, resEth]);

    const seed: ResearchValidationPlanInput = {
      ...baseInput,
      strategies: [{
        strategyId: 'EMA_TREND',
        strategyVersion: '1.0.0',
        candidateSpace: {
          strategyId: 'EMA_TREND',
          strategyVersion: '1.0.0',
          dimensions: { timeframeMinutes: [1], fastPeriod: [1], slowPeriod: [2, 3], priceSource: ['CLOSE'] },
        },
      }],
      validationWindow: { startMs: BASE + DAY, endExclusiveMs: BASE + 7 * DAY },
      walkForward: { policyId: 'P12_WALK_FORWARD_V1', trainDays: 2, testDays: 2, stepDays: 2, embargoDays: 0 },
      holdout: { holdoutStartMs: BASE + 5 * DAY, holdoutEndExclusiveMs: BASE + 7 * DAY, exposureDeclaration: 'UNSEEN_BY_OPERATOR' },
    };

    const probe = await planResearchValidationWithGitSourceVerifier(seed, deps, new ControlledGitVerifier());
    const btcSubjects = probe.subjects.filter((s) => s.pair === 'BTC-INR');
    const targetHash = btcSubjects[0]?.parameterHash;
    const neighborHash = btcSubjects[1]?.parameterHash;
    const parameterNeighborhoods = targetHash && neighborHash
      ? [{ targetParameterHash: targetHash, adjacentNeighborParameterHashes: [neighborHash] }]
      : [];

    const input: ResearchValidationPlanInput = {
      ...seed,
      parameterNeighborhoods,
    };

    const finalized = await planResearchValidationWithGitSourceVerifier(input, deps, new ControlledGitVerifier());
    const planResult = await executeResearchValidationWithGitSourceVerifier(finalized, deps, {}, new ControlledGitVerifier());

    const passedSubjects = planResult.subjectResults.filter((rec) => rec.verdict === 'PASSED');
    const candidates: StrategyRankingCandidateSubject[] = passedSubjects.map((rec) => ({
      pair: rec.pair,
      strategyId: rec.strategyId,
      strategyVersion: rec.strategyVersion,
      parameterHash: rec.parameterHash,
    }));

    const runSet = rankStrategyCandidates({ planResult, candidates });
    return { planResult, candidates, runSet };
  })();
  return cachedFixturePromise;
}

export async function getGenuineRankingRunSet(): Promise<StrategyRankingRunSet> {
  const fixture = await getGenuineRankingFixture();
  return fixture.runSet;
}
