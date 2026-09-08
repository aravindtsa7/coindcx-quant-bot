import { describe, expect, it } from 'vitest';
import { InMemoryBacktestDatasetSource, canonicalJson } from '../../../../src/backtest';
import { createCanonicalCandle1m } from '../../../../src/market-data/models';
import { executeResearchValidationWithGitSourceVerifier } from '../../../../src/research/research-validation/executor';
import { planResearchValidationWithGitSourceVerifier } from '../../../../src/research/research-validation/planner';
import { candles, ControlledGitVerifier, datasetManifest, registry, resources } from '../strategy-coin-matrix/helpers';
import { validationInput } from './helpers';

describe('Audit B1 downstream validation evidence identity', () => {
  it('preserves genuine Phase9/11/12 evidence and research identity for formatting changes, but separates a 1e-18 delta', async () => {
    const execute = async (representation: 'plain' | 'padded' | 'changed') => {
      const rows = candles('BTC-INR', 4 * 24 * 60).map((row) => createCanonicalCandle1m({ ...row,
        open: representation === 'padded' ? '100.000000000000000000' : '100',
        volume: representation === 'changed' ? '10.000000000000000001' : representation === 'padded' ? '10.000000000000000000' : '10',
        quoteVolume: representation === 'padded' ? '100.000000000000000000' : '100',
      }));
      const resource = { ...resources('BTC-INR'), datasetManifest: datasetManifest(rows), datasetSource: new InMemoryBacktestDatasetSource('b1-validation', rows) };
      const dependencies = { registry: registry(), pairResources: [resource] };
      const plan = await planResearchValidationWithGitSourceVerifier(validationInput([resource]), dependencies, new ControlledGitVerifier());
      const result = await executeResearchValidationWithGitSourceVerifier(plan, dependencies, {}, new ControlledGitVerifier());
      expect(result.status).toBe('COMPLETED');
      const evidence = result.subjectResults[0]?.foldResults.find((fold) => fold.kind === 'OOS')?.evidence;
      expect(evidence).toBeDefined();
      expect(evidence?.phase9EventLedgerSha256).toBe(evidence?.observedEventLedgerSha256);
      return { plan, result, evidence };
    };
    const plain = await execute('plain'); const padded = await execute('padded');
    expect(padded.plan).toEqual(plain.plan);
    expect(padded.evidence).toEqual(plain.evidence);
    expect(canonicalJson(padded.result)).toBe(canonicalJson(plain.result));
    const changed = await execute('changed');
    expect(changed.plan).not.toEqual(plain.plan);
    expect(changed.evidence?.runId).not.toBe(plain.evidence?.runId);
    expect(changed.evidence?.resultSha256).not.toBe(plain.evidence?.resultSha256);
    expect(changed.evidence?.validationEvidenceSha256).not.toBe(plain.evidence?.validationEvidenceSha256);
    expect(changed.result.validationResultSha256).not.toBe(plain.result.validationResultSha256);
  }, 60_000);
});
