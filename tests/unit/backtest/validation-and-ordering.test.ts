import { describe, expect, it } from 'vitest';
import {
  BacktestDecimal,
  BacktestEngine,
  BacktestError,
  InMemoryBacktestDatasetSource,
  InMemoryBacktestSink,
  computeBacktestInstrumentSpecSnapshotId,
  sha256CanonicalJson,
  type BacktestEngineConfig,
  type BacktestInstrumentSpec,
  type BacktestOrderIntent,
  type BacktestRunResult,
} from '../../../src/backtest';
import { BASE, candle, config, ScriptedParticipant } from './helpers';

function completed(outcome: Awaited<ReturnType<BacktestEngine['run']>>): BacktestRunResult {
  expect(outcome.terminalStatus).toBe('COMPLETED');
  if (outcome.terminalStatus !== 'COMPLETED') throw new Error(outcome.terminalError);
  return outcome;
}

function spec(base: BacktestInstrumentSpec, changes: Partial<Omit<BacktestInstrumentSpec, 'instrumentSpecSnapshotId'>>): BacktestInstrumentSpec {
  const values = { ...base, ...changes };
  return { ...values, instrumentSpecSnapshotId: computeBacktestInstrumentSpecSnapshotId(values) };
}

async function rejected(intent: BacktestOrderIntent, overrides: Partial<BacktestEngineConfig> = {}) {
  const candles = [candle(0), candle(1)];
  const sink = new InMemoryBacktestSink();
  const result = completed(await new BacktestEngine(config(candles, new ScriptedParticipant([{ submitOrders: [intent] }]), overrides), sink).run());
  return { result, event: sink.events.find((item) => item.type === 'ORDER_REJECTED') };
}

describe('Phase 9 instrument and cost validation', () => {
  it.each([
    [{ pair: 'B-ETH_INR', type: 'MARKET', side: 'BUY', quantity: '1' }, 'INSTRUMENT_CONSTRAINT_VIOLATION'],
    [{ pair: 'B-BTC_INR', type: 'MARKET', side: 'BUY', quantity: '1.0005' }, 'INSTRUMENT_CONSTRAINT_VIOLATION'],
    [{ pair: 'B-BTC_INR', type: 'POST_ONLY_LIMIT', side: 'BUY', quantity: '1', limitPrice: '99.999' }, 'INSTRUMENT_CONSTRAINT_VIOLATION'],
    [{ pair: 'B-BTC_INR', type: 'POST_ONLY_LIMIT', side: 'BUY', quantity: '1' }, 'ORDER_INVALID'],
    [{ pair: 'B-BTC_INR', type: 'STOP_MARKET', side: 'BUY', quantity: '1', stopPrice: '0' }, 'INSTRUMENT_CONSTRAINT_VIOLATION'],
  ] as const)('rejects invalid order constraint %#', async (intent, code) => {
    const outcome = await rejected(intent);
    expect(outcome.result.totalFills).toBe(0);
    expect(outcome.event?.payload.code).toBe(code);
  });

  it('enforces minQuantity and minTradeSize independently', async () => {
    const base = config([candle(0), candle(1)]).instrumentSpec;
    const minQuantity = await rejected(
      { pair: 'B-BTC_INR', type: 'MARKET', side: 'BUY', quantity: '0.5' },
      { instrumentSpec: spec(base, { minQuantity: new BacktestDecimal('1'), minTradeSize: new BacktestDecimal('0.1') }) },
    );
    const minTrade = await rejected(
      { pair: 'B-BTC_INR', type: 'MARKET', side: 'BUY', quantity: '0.5' },
      { instrumentSpec: spec(base, { minQuantity: new BacktestDecimal('0.1'), minTradeSize: new BacktestDecimal('1') }) },
    );
    expect(minQuantity.event?.payload.code).toBe('INSTRUMENT_CONSTRAINT_VIOLATION');
    expect(minTrade.event?.payload.code).toBe('INSTRUMENT_CONSTRAINT_VIOLATION');
  });

  it('performs a conservative post-only minimum-notional precheck', async () => {
    const base = config([candle(0), candle(1)]).instrumentSpec;
    const outcome = await rejected(
      { pair: 'B-BTC_INR', type: 'POST_ONLY_LIMIT', side: 'BUY', quantity: '0.01', limitPrice: '90' },
      { instrumentSpec: spec(base, { minNotional: new BacktestDecimal('1') }) },
    );
    expect(outcome.event?.payload.code).toBe('INSTRUMENT_CONSTRAINT_VIOLATION');
  });

  it('rejects a forged instrument snapshot hash', () => {
    const candles = [candle(0), candle(1)];
    expect(() => new BacktestEngine(config(candles, new ScriptedParticipant(), {
      instrumentSpec: { ...config(candles).instrumentSpec, instrumentSpecSnapshotId: '0'.repeat(64) },
    }))).toThrowError(BacktestError);
  });

  it.each([
    { halfSpreadBps: '9000', marketSlippageBps: '1000' },
    { halfSpreadBps: '9000', stopSlippageBps: '1000' },
    { makerFeeRate: '-0.1' },
  ])('rejects invalid exact cost models', (changes) => {
    const candles = [candle(0), candle(1)];
    const base = config(candles).costModel;
    const costModel = {
      ...base,
      ...(changes.halfSpreadBps === undefined ? {} : { halfSpreadBps: new BacktestDecimal(changes.halfSpreadBps) }),
      ...(changes.marketSlippageBps === undefined ? {} : { marketSlippageBps: new BacktestDecimal(changes.marketSlippageBps) }),
      ...(changes.stopSlippageBps === undefined ? {} : { stopSlippageBps: new BacktestDecimal(changes.stopSlippageBps) }),
      ...(changes.makerFeeRate === undefined ? {} : { makerFeeRate: new BacktestDecimal(changes.makerFeeRate) }),
    };
    expect(() => new BacktestEngine(config(candles, new ScriptedParticipant(), { costModel }))).toThrowError(BacktestError);
  });
});

describe('Phase 9 OCO global ordering', () => {
  it('merges the selected long OCO stop with independent candidates by global sequence', async () => {
    const participant = new ScriptedParticipant([
      { submitOrders: [{ pair: 'B-BTC_INR', type: 'MARKET', side: 'BUY', quantity: '1' }] },
      { submitOrders: [
        { pair: 'B-BTC_INR', type: 'POST_ONLY_LIMIT', side: 'SELL', quantity: '1', limitPrice: '105', reduceOnly: true, ocoGroupId: 'long-exit' },
        { pair: 'B-BTC_INR', type: 'STOP_MARKET', side: 'BUY', quantity: '1', stopPrice: '102' },
        { pair: 'B-BTC_INR', type: 'STOP_MARKET', side: 'SELL', quantity: '1', stopPrice: '95', reduceOnly: true, ocoGroupId: 'long-exit' },
      ] },
    ]);
    const sink = new InMemoryBacktestSink();
    const result = completed(await new BacktestEngine(config([candle(0), candle(1), candle(2)], participant), sink).run());
    const lastBar = sink.events.filter((event) => event.eventTimeMs === BASE + 180_000 && ['ORDER_FILLED', 'ORDER_CANCELLED'].includes(event.type));
    expect(lastBar.map((event) => [event.type, event.payload.orderSequence])).toEqual([
      ['ORDER_FILLED', 3], ['ORDER_FILLED', 4], ['ORDER_CANCELLED', 2],
    ]);
    expect(result.terminalPosition?.quantity.value).toBe('1');
  });

  it('chooses the adverse upside stop for a short OCO', async () => {
    const participant = new ScriptedParticipant([
      { submitOrders: [{ pair: 'B-BTC_INR', type: 'MARKET', side: 'SELL', quantity: '1' }] },
      { submitOrders: [
        { pair: 'B-BTC_INR', type: 'POST_ONLY_LIMIT', side: 'BUY', quantity: '1', limitPrice: '95', reduceOnly: true, ocoGroupId: 'short-exit' },
        { pair: 'B-BTC_INR', type: 'STOP_MARKET', side: 'BUY', quantity: '1', stopPrice: '105', reduceOnly: true, ocoGroupId: 'short-exit' },
      ] },
    ]);
    const sink = new InMemoryBacktestSink();
    const result = completed(await new BacktestEngine(config([candle(0), candle(1), candle(2)], participant), sink).run());
    const exit = sink.events.filter((event) => event.type === 'ORDER_FILLED')[1];
    expect(exit?.payload.orderSequence).toBe(3);
    expect(result.terminalPosition).toBeNull();
  });
});

describe('Phase 9 identity, fidelity, and verification safety', () => {
  it('emits nothing before full dataset verification succeeds', async () => {
    const truth = [candle(0), candle(1)];
    const sink = new InMemoryBacktestSink();
    const outcome = await new BacktestEngine(config(truth, new ScriptedParticipant(), {
      datasetSource: new InMemoryBacktestDatasetSource('bad-content', [candle(0), candle(1, { close: '101' })]),
    }), sink).run();
    expect(outcome.terminalStatus).toBe('FAILED');
    expect(sink.events).toHaveLength(0);
  });

  it('fails when the immutable source identity check changes between passes', async () => {
    const candles = [candle(0), candle(1)];
    const memory = new InMemoryBacktestDatasetSource('switching', candles);
    let checks = 0;
    const source = {
      sourceIdentity: 'switching', immutable: true as const,
      getRange: memory.getRange.bind(memory),
      assertIdentity() { checks++; if (checks >= 3) throw new Error('snapshot changed'); },
    };
    const outcome = await new BacktestEngine(config(candles, new ScriptedParticipant(), { datasetSource: source })).run();
    expect(outcome).toMatchObject({ terminalStatus: 'FAILED', errorCode: 'DATASET_IDENTITY_MISMATCH' });
  });

  it('reports every frozen fidelity limitation explicitly', async () => {
    const result = completed(await new BacktestEngine(config([candle(0), candle(1)])).run());
    expect(result.fidelity).toEqual({
      marketDataFidelity: 'CANONICAL_1M', executionFidelity: 'CONSERVATIVE_1M_OHLCV',
      partialFillModel: 'NOT_MODELED_PHASE9', queueModel: 'NOT_MODELED_PHASE9', riskEngine: 'NOT_APPLIED_PHASE9',
      leverageModel: 'NOT_MODELED_PHASE9', liquidationModel: 'NOT_MODELED_PHASE9', fundingFidelity: 'TEST_ONLY',
    });
  });

  it('changes runId for range, slippage, instrument identity, participant hash, and initial equity', () => {
    const candles = [candle(0), candle(1), candle(2)];
    const baseConfig = config(candles);
    const base = new BacktestEngine(baseConfig).runId;
    const changed = [
      new BacktestEngine(config(candles, new ScriptedParticipant(), { evaluationFromInclusiveMs: BASE + 120_000 })).runId,
      new BacktestEngine(config(candles, new ScriptedParticipant(), { costModel: { ...baseConfig.costModel, stopSlippageBps: new BacktestDecimal('31') } })).runId,
      new BacktestEngine(config(candles, new ScriptedParticipant(), { instrumentSpec: spec(baseConfig.instrumentSpec, { minNotional: new BacktestDecimal('2') }) })).runId,
      new BacktestEngine(config(candles, new ScriptedParticipant(), { participantIdentity: { ...baseConfig.participantIdentity, parameterHash: sha256CanonicalJson({ changed: true }) } })).runId,
      new BacktestEngine(config(candles, new ScriptedParticipant(), { initialEquity: new BacktestDecimal('10001') })).runId,
    ];
    expect(changed.every((runId) => runId !== base)).toBe(true);
  });

  it('fully processes the final source candle at replayTo without evaluating there', async () => {
    const participant = new ScriptedParticipant();
    const sink = new InMemoryBacktestSink();
    const candles = [candle(0), candle(1)];
    const result = completed(await new BacktestEngine(config(candles, participant), sink).run());
    expect(participant.contexts.map((context) => context.simulationTimeMs)).toEqual([BASE + 60_000]);
    expect(sink.events.some((event) => event.type === 'CANDLE_CLOSED' && event.eventTimeMs === BASE + 120_000)).toBe(true);
    expect(result.timeRange.replayToExclusiveMs).toBe(BASE + 120_000);
  });

  it('keeps prefix-causal evaluation snapshots unchanged when only future candles change', async () => {
    const prefix = [candle(0), candle(1)];
    const aParticipant = new ScriptedParticipant([{ submitOrders: [{ pair: 'B-BTC_INR', type: 'MARKET', side: 'BUY', quantity: '1' }] }, {}]);
    const bParticipant = new ScriptedParticipant([{ submitOrders: [{ pair: 'B-BTC_INR', type: 'MARKET', side: 'BUY', quantity: '1' }] }, {}]);
    const aSink = new InMemoryBacktestSink();
    const bSink = new InMemoryBacktestSink();
    completed(await new BacktestEngine(config([...prefix, candle(2, { open: '100', high: '110', low: '90', close: '100' })], aParticipant), aSink).run());
    completed(await new BacktestEngine(config([...prefix, candle(2, { open: '500', high: '900', low: '400', close: '800' })], bParticipant), bSink).run());
    expect(aParticipant.contexts.slice(0, 2).map((context) => canonicalContext(context))).toEqual(
      bParticipant.contexts.slice(0, 2).map((context) => canonicalContext(context)),
    );
    const prefixFills = (sink: InMemoryBacktestSink) => sink.events
      .filter((event) => event.type === 'ORDER_FILLED' && event.eventTimeMs <= BASE + 120_000)
      .map((event) => {
        const { fillId: _fillId, orderId: _orderId, ...causalPayload } = event.payload;
        return { eventTimeMs: event.eventTimeMs, payload: causalPayload };
      });
    expect(prefixFills(aSink)).toEqual(prefixFills(bSink));
  });
});

function canonicalContext(context: Parameters<ScriptedParticipant['onEvaluation']>[0]) {
  return {
    simulationTimeMs: context.simulationTimeMs,
    candle: context.latestClosed1mCandle.close.value,
    position: context.currentPosition,
    account: context.accountEquity,
    orders: context.openOrders,
  };
}
