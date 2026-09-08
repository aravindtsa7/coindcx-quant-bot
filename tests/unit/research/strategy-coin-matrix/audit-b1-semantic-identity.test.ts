import { describe, expect, it } from 'vitest';
import { InMemoryBacktestDatasetSource, canonicalJson } from '../../../../src/backtest';
import { createCanonicalCandle1m } from '../../../../src/market-data/models';
import { InMemoryMatrixCompletedResultCache } from '../../../../src/research/strategy-coin-matrix';
import { executeWithGitSourceVerifier } from '../../../../src/research/strategy-coin-matrix/executor';
import { planWithGitSourceVerifier } from '../../../../src/research/strategy-coin-matrix/planner';
import { candles, ControlledGitVerifier, datasetManifest, matrixInput, registry, resources } from './helpers';

function resource(pair: string, representation: 'plain' | 'padded' | 'changed') {
  const rows = candles(pair).map((row) => createCanonicalCandle1m({ ...row,
    open: representation === 'padded' ? `${row.open.value}.000000000000000000` : row.open,
    volume: representation === 'changed' ? '10.000000000000000001' : representation === 'padded' ? '10.000000000000000000' : '10',
    quoteVolume: representation === 'padded' ? '100.000000000000000000' : '100',
  }));
  return { ...resources(pair), datasetManifest: datasetManifest(rows), datasetSource: new InMemoryBacktestDatasetSource(`b1-${pair}`, rows) };
}

describe('Audit B1 downstream matrix identity', () => {
  it('preserves completed cell/run/result identities and cache compatibility for equivalent BTC/ETH evidence', async () => {
    const execute = async (representation: 'plain' | 'padded' | 'changed') => {
      const pairResources = ['BTC-INR', 'ETH-INR'].map((pair) => resource(pair, representation));
      const dependencies = { registry: registry(), pairResources };
      const plan = await planWithGitSourceVerifier(matrixInput(pairResources), dependencies, new ControlledGitVerifier());
      const result = await executeWithGitSourceVerifier(plan, dependencies, { workerCount: 2 }, new ControlledGitVerifier());
      expect(result.status).toBe('COMPLETED');
      expect(result.completedCells).toBe(8);
      return { plan, result, dependencies };
    };
    const plain = await execute('plain'); const padded = await execute('padded');
    expect(padded.plan).toEqual(plain.plan);
    expect(canonicalJson(padded.result)).toBe(canonicalJson(plain.result));
    const cache = new InMemoryMatrixCompletedResultCache(plain.result.cellResults);
    const cached = await executeWithGitSourceVerifier(padded.plan, { ...padded.dependencies, cache }, {}, new ControlledGitVerifier());
    expect(canonicalJson(cached)).toBe(canonicalJson(plain.result));
    const changed = await execute('changed');
    expect(changed.plan.matrixPlanId).not.toBe(plain.plan.matrixPlanId);
    expect(changed.result.matrixResultSha256).not.toBe(plain.result.matrixResultSha256);
    for (const [index, cell] of changed.result.cellResults.entries()) {
      expect(cell.matrixCellId).not.toBe(plain.result.cellResults[index]?.matrixCellId);
      expect(cell.outcome?.resultSha256).not.toBe(plain.result.cellResults[index]?.outcome?.resultSha256);
      expect(await cache.get(cell.matrixCellId)).toBeNull();
    }
  });
});
