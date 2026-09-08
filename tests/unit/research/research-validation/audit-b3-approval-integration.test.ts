import { describe, expect, it, vi } from 'vitest';
import { BacktestCalcDecimal, InMemoryBacktestDatasetSource, canonicalJson, type BacktestRunResult } from '../../../../src/backtest';
import { createCanonicalCandle1m } from '../../../../src/market-data/models';
import { ValidationEvidenceCollector } from '../../../../src/research/research-validation/evidence-collector';
import { executeResearchValidationWithGitSourceVerifier } from '../../../../src/research/research-validation/executor';
import { planResearchValidationWithGitSourceVerifier } from '../../../../src/research/research-validation/planner';
import { calculateMaxDrawdown } from '../../../../src/research/research-validation/metrics';
import { BASE, candles, ControlledGitVerifier, datasetManifest, registry } from '../strategy-coin-matrix/helpers';
import { fundedResource, fundingEvent } from '../strategy-coin-matrix/audit-b2-helpers';
import { validationInput } from './helpers';

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('Audit B3 genuine research approval correction', () => {
  it('reproduces individually sub-0.0035% OOS drawdowns and rejects their continuous aggregate breach', async () => {
    const rows = candles('BTC-INR', 5 * 24 * 60).map((row, index) => {
      const price = new BacktestCalcDecimal('100').plus(new BacktestCalcDecimal(index).times('0.0000000001')).toFixed();
      return createCanonicalCandle1m({ ...row, open: price, high: price, low: price, close: price });
    });
    const funding = [2, 3].flatMap((day) => [
      fundingEvent(BASE + day * DAY + HOUR, '-0.144'),
      fundingEvent(BASE + day * DAY + 2 * HOUR, '0.2878'),
      fundingEvent(BASE + day * DAY + 3 * HOUR, '-0.0002'),
    ]);
    const resource = { ...fundedResource('BTC-INR', funding, rows.length), datasetManifest: datasetManifest(rows), datasetSource: new InMemoryBacktestDatasetSource('b3-genuine-drawdown', rows) };
    const dependencies = { registry: registry(), pairResources: [resource] };
    const original = validationInput([resource]);
    const input = { ...original, validationWindow: { startMs: BASE + DAY, endExclusiveMs: BASE + 5 * DAY },
      holdout: { ...original.holdout, holdoutStartMs: BASE + 4 * DAY, holdoutEndExclusiveMs: BASE + 5 * DAY },
      thresholds: { ...original.thresholds, maxOosDrawdownPercent: '0.0035' },
    };
    const finalized = await planResearchValidationWithGitSourceVerifier(input, dependencies, new ControlledGitVerifier());
    expect(finalized.folds).toHaveLength(2);
    const beforeHashes = new Map<string, string>();
    const finalize = ValidationEvidenceCollector.prototype.finalize;
    const observer = vi.spyOn(ValidationEvidenceCollector.prototype, 'finalize').mockImplementation(function (this: ValidationEvidenceCollector, outcome: BacktestRunResult) {
      const before = canonicalJson(outcome);
      beforeHashes.set(outcome.runId, outcome.resultSha256);
      const evidence = finalize.call(this, outcome);
      expect(canonicalJson(outcome)).toBe(before);
      expect(evidence.resultSha256).toBe(outcome.resultSha256);
      return evidence;
    });
    try {
      const result = await executeResearchValidationWithGitSourceVerifier(finalized, dependencies, {}, new ControlledGitVerifier());
      expect(result.status).toBe('COMPLETED');
      const subject = result.subjectResults[0]!;
      const oos = subject.foldResults.filter((fold) => fold.kind === 'OOS');
      expect(oos).toHaveLength(2);
      for (const fold of oos) {
        expect(fold.evidence).not.toBeNull();
        expect(new BacktestCalcDecimal(fold.evidence!.maxDrawdownPercent).lessThan('0.0035')).toBe(true);
        expect(fold.evidence!.maxDrawdownPercent.startsWith('0.002877')).toBe(true);
      }
      const aggregate = subject.aggregateOosMetrics.maxDrawdownPercent;
      expect(aggregate.status).toBe('VALUE');
      if (aggregate.status !== 'VALUE') throw new Error('Missing aggregate drawdown');
      expect(new BacktestCalcDecimal(aggregate.value).greaterThan('0.0035')).toBe(true);
      expect(aggregate.value.startsWith('0.004313')).toBe(true);
      expect(subject.gateEvaluations.find((gate) => gate.gateId === 'GATE-05')?.status).toBe('FAIL');
      expect(subject.verdict).toBe('FAILED');
      expect(result.passedSubjects).toBe(0);
      // Independent check: reconstruct scaled chronological points from retained
      // genuine evidence and feed the standalone drawdown calculator.
      let carried = new BacktestCalcDecimal(1);
      const continuous: string[] = [];
      for (const fold of oos) {
        const evidence = fold.evidence!;
        const scale = carried.div(evidence.baselineEquity);
        for (const point of evidence.equityPath) {
          carried = new BacktestCalcDecimal(point.equity).times(scale);
          continuous.push(carried.toFixed());
        }
        expect(evidence.resultSha256).toBe(beforeHashes.get(evidence.runId));
      }
      expect(calculateMaxDrawdown(continuous).percent).toEqual(aggregate);
      console.log('B3 genuine OOS proof', JSON.stringify({ foldDrawdowns: oos.map((fold) => fold.evidence!.maxDrawdownPercent), aggregateDrawdown: aggregate.value, gate05: 'FAIL', verdict: subject.verdict }));
    } finally { observer.mockRestore(); }
  }, 60_000);
});
