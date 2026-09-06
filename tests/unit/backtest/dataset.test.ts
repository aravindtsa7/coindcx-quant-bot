import { describe, expect, it } from 'vitest';
import {
  BacktestEngine,
  InMemoryBacktestDatasetSource,
  PagedBacktestDatasetSource,
} from '../../../src/backtest';
import { candle, config, manifest, ScriptedParticipant, PAIR } from './helpers';

describe('Phase 9 verified dataset binding', () => {
  it('accepts the exact Phase 7 manifest and performs full verification plus replay reads', async () => {
    const candles = [candle(0), candle(1), candle(2)];
    const calls: Array<readonly [number, number]> = [];
    const memory = new InMemoryBacktestDatasetSource('stable-v1', candles);
    const source = new PagedBacktestDatasetSource('stable-v1', {
      getLatestCanonicalCandle: async () => candles[2] ?? null,
      getRange: async (pair, from, to) => {
        calls.push([from, to]);
        return memory.getRange(pair, from, to);
      },
    });
    const outcome = await new BacktestEngine(config(candles, new ScriptedParticipant(), { datasetSource: source, verificationPageMinutes: 1 })).run();
    expect(outcome.terminalStatus).toBe('COMPLETED');
    expect(calls.length).toBe(6);
  });

  it('rejects manifest A paired with stream B and content hash mismatch', async () => {
    const a = [candle(0), candle(1), candle(2)];
    const b = [candle(0), candle(1, { close: '101' }), candle(2)];
    const outcome = await new BacktestEngine(config(a, new ScriptedParticipant(), {
      datasetSource: new InMemoryBacktestDatasetSource('stream-b', b),
    })).run();
    expect(outcome).toMatchObject({ terminalStatus: 'FAILED', isValid: false, errorCode: 'DATASET_IDENTITY_MISMATCH' });
    expect('resultSha256' in outcome).toBe(false);
  });

  it('rejects a corrupted datasetId', async () => {
    const candles = [candle(0), candle(1)];
    const bad = { ...manifest(candles), datasetId: '0'.repeat(64) };
    const outcome = await new BacktestEngine(config(candles, new ScriptedParticipant(), { datasetManifest: bad })).run();
    expect(outcome).toMatchObject({ terminalStatus: 'FAILED', errorCode: 'DATASET_IDENTITY_MISMATCH' });
  });

  it.each([
    ['gap', [candle(0), candle(2)], 'DATASET_GAP'],
    ['duplicate', [candle(0), candle(1), candle(1), candle(2)], 'DATASET_ORDER_VIOLATION'],
    ['backward', [candle(0), candle(2), candle(1)], 'DATASET_GAP'],
  ])('rejects a %s stream', async (_name, stream, code) => {
    const truth = [candle(0), candle(1), candle(2)];
    const base = config(truth);
    const source = {
      sourceIdentity: 'malformed-v1', immutable: true as const,
      getRange: async () => stream,
    };
    const outcome = await new BacktestEngine({ ...base, datasetSource: source }).run();
    expect(outcome).toMatchObject({ terminalStatus: 'FAILED', errorCode: code });
  });

  it('rejects pair substitution and incorrect manifest boundaries/counts', async () => {
    const truth = [candle(0), candle(1), candle(2)];
    const wrongPair = [candle(0, {}, 'B-ETH_INR'), candle(1, {}, 'B-ETH_INR'), candle(2, {}, 'B-ETH_INR')];
    const pairOutcome = await new BacktestEngine(config(truth, new ScriptedParticipant(), {
      datasetSource: { sourceIdentity: 'wrong-pair', immutable: true, getRange: async () => wrongPair },
    })).run();
    expect(pairOutcome).toMatchObject({ errorCode: 'DATASET_IDENTITY_MISMATCH' });
    const baseManifest = manifest(truth);
    const countOutcome = await new BacktestEngine(config(truth, new ScriptedParticipant(), {
      datasetManifest: { ...baseManifest, actualCandleCount: 2 },
    })).run();
    expect(countOutcome).toMatchObject({ errorCode: 'DATASET_IDENTITY_MISMATCH' });
    expect(baseManifest.pair).toBe(PAIR);
  });

  it('verifies the complete manifest even when replay is a smaller slice', async () => {
    const truth = [candle(0), candle(1), candle(2), candle(3)];
    const corruptedOutsideReplay = [candle(0, { close: '99' }), candle(1), candle(2), candle(3)];
    const outcome = await new BacktestEngine(config(truth, new ScriptedParticipant(), {
      datasetSource: new InMemoryBacktestDatasetSource('corrupt-before-replay', corruptedOutsideReplay),
      bootstrapFromInclusiveMs: truth[1]!.openTimeMs,
      evaluationFromInclusiveMs: truth[2]!.openTimeMs,
    })).run();
    expect(outcome).toMatchObject({ errorCode: 'DATASET_IDENTITY_MISMATCH' });
  });

  it('classifies a genuinely backward row as an order violation', async () => {
    const truth = [candle(0), candle(1), candle(2)];
    const backward = [candle(0), candle(1), candle(0), candle(2)];
    const outcome = await new BacktestEngine(config(truth, new ScriptedParticipant(), {
      datasetSource: { sourceIdentity: 'backward', immutable: true, getRange: async () => backward },
    })).run();
    expect(outcome).toMatchObject({ errorCode: 'DATASET_ORDER_VIOLATION' });
  });

  it('detects source substitution during Pass 2 with the Pass 1 replay-byte proof', async () => {
    const truth = [candle(0), candle(1), candle(2)];
    const substituted = [candle(0), candle(1, { close: '101' }), candle(2)];
    let reads = 0;
    const source = {
      sourceIdentity: 'toctou-source', immutable: true as const,
      getRange: async () => (++reads === 1 ? truth : substituted),
    };
    const outcome = await new BacktestEngine(config(truth, new ScriptedParticipant(), { datasetSource: source })).run();
    expect(outcome).toMatchObject({ terminalStatus: 'FAILED', errorCode: 'DATASET_IDENTITY_MISMATCH' });
    expect('resultSha256' in outcome).toBe(false);
  });

  it('rejects structurally invalid OHLC even when values use canonical decimals', async () => {
    const truth = [candle(0), candle(1)];
    const invalid = { ...candle(1), high: candle(1).low, low: candle(1).high };
    const source = {
      sourceIdentity: 'bad-structure', immutable: true as const,
      getRange: async () => [truth[0]!, invalid] as typeof truth,
    };
    const outcome = await new BacktestEngine(config(truth, new ScriptedParticipant(), { datasetSource: source })).run();
    expect(outcome).toMatchObject({ errorCode: 'DATASET_ORDER_VIOLATION' });
  });
});
