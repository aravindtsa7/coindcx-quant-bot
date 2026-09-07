import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BacktestDecimal, BacktestEngine, type BacktestActionBatch, type BacktestEquitySnapshot, type BacktestEvaluationContext, type BacktestOrderSnapshot, type BacktestPositionSide } from '../../../src/backtest';
import { createCanonicalCandle1m } from '../../../src/market-data/models';
import {
  InMemoryStrategyDecisionSink,
  InMemoryStrategyDispatchAuditSink,
  StrategyBacktestParticipantAdapter,
  StrategyError,
  StrategyReadonlyMap,
  buildStrategyBacktestParticipantIdentity,
  createStrategyBacktestIndicatorBindings,
  emaTrendV1Definition,
  strategyActionBatchSha256,
  type StrategyKernel,
} from '../../../src/strategies';
import { config as backtestConfig } from '../backtest/helpers';
import { BASE, PAIR, bootstrap, indicatorPoint } from './helpers';

function kernel(): StrategyKernel {
  return emaTrendV1Definition.createKernel({ pair: PAIR, parameters: { timeframeMinutes: 1, fastPeriod: 2, slowPeriod: 3, priceSource: 'CLOSE' }, indicatorBootstrapIdentity: bootstrap(1) });
}

function candle() {
  return createCanonicalCandle1m({
    pair: PAIR, openTimeMs: BASE, open: '100', high: '100', low: '100', close: '100', volume: '1', quoteVolume: null,
    source: 'REST_HISTORICAL', finalizedAtMs: BASE + 60_000, providerEventTimeMs: null, generationId: null,
  });
}

function context(
  fast: string | null,
  slow: string | null,
  side: BacktestPositionSide = 'FLAT',
  quantity = '0',
  openOrders: readonly BacktestOrderSnapshot[] = [],
): BacktestEvaluationContext {
  const bar = candle();
  return Object.freeze({
    simulationTimeMs: bar.closeTimeExclusiveMs,
    latestClosed1mCandle: bar,
    latestClosedCandleByTimeframe: new StrategyReadonlyMap([[1, bar]]),
    candlesClosedAtThisTimestamp: Object.freeze([bar]),
    latestIndicatorPointByKey: new StrategyReadonlyMap([
      ['ema.fast', indicatorPoint(1, bar.closeTimeExclusiveMs, fast)],
      ['ema.slow', indicatorPoint(1, bar.closeTimeExclusiveMs, slow)],
    ]),
    currentPosition: Object.freeze({
      side, quantity: new BacktestDecimal(quantity), averageEntryPrice: side === 'FLAT' ? null : new BacktestDecimal('100'),
      markPrice: new BacktestDecimal('100'), unrealizedGrossPnl: new BacktestDecimal('0'),
    }),
    accountEquity: Object.freeze({}) as BacktestEquitySnapshot,
    openOrders,
  });
}

async function evaluation(fast: string | null, slow: string | null, side: BacktestPositionSide, quantity: string) {
  const strategy = kernel();
  const decisions = new InMemoryStrategyDecisionSink();
  const dispatches = new InMemoryStrategyDispatchAuditSink();
  const adapter = new StrategyBacktestParticipantAdapter({ kernel: strategy, fixedResearchQuantity: '2.00', decisionSink: decisions, dispatchSink: dispatches });
  const batch = await adapter.onEvaluation(context(fast, slow, side, quantity));
  return { strategy, decisions, dispatches, batch };
}

describe('Phase 10 backtest adapter reconciliation and audit', () => {
  it('audits WARMING and returns no action', async () => {
    const result = await evaluation(null, null, 'LONG', '3');
    expect(result.batch.submitOrders).toEqual([]);
    expect(result.decisions.decisions).toHaveLength(1);
    expect(result.dispatches.records).toEqual([expect.objectContaining({ dispatchStatus: 'WARMING_NO_ACTION', actionBatchSha256: null })]);
  });

  it.each([
    ['2', '2', 'LONG', '3', 'SELL', '3', true],
    ['2', '2', 'SHORT', '3', 'BUY', '3', true],
    ['2', '1', 'FLAT', '0', 'BUY', '2', false],
    ['1', '2', 'FLAT', '0', 'SELL', '2', false],
    ['2', '1', 'SHORT', '3', 'BUY', '5', false],
    ['1', '2', 'LONG', '3', 'SELL', '5', false],
  ] as const)('maps target/current exposure into one exact market action', async (fast, slow, current, quantity, orderSide, orderQuantity, reduceOnly) => {
    const result = await evaluation(fast, slow, current, quantity);
    expect(result.batch.submitOrders).toEqual([{ pair: PAIR, type: 'MARKET', side: orderSide, quantity: orderQuantity, reduceOnly }]);
    expect(result.dispatches.records[0]).toMatchObject({ dispatchStatus: 'ACTION_BATCH_RETURNED', actionBatchSha256: strategyActionBatchSha256(result.batch) });
    expect(result.decisions.decisions).toHaveLength(1);
  });

  it.each([
    ['2', '1', 'LONG'],
    ['1', '2', 'SHORT'],
    ['2', '2', 'FLAT'],
  ] as const)('returns READY_NO_ACTION when target %s/%s already matches %s', async (fast, slow, current) => {
    const result = await evaluation(fast, slow, current, current === 'FLAT' ? '0' : '3');
    expect(result.batch.submitOrders).toEqual([]);
    expect(result.dispatches.records[0]).toMatchObject({ dispatchStatus: 'READY_NO_ACTION', actionBatchSha256: null });
  });

  it('computes actionBatchSha256 independently over the exact returned canonical batch', async () => {
    const result = await evaluation('2', '1', 'FLAT', '0');
    const canonical = `{"submitOrders":[{"pair":"${PAIR}","quantity":"2","reduceOnly":false,"side":"BUY","type":"MARKET"}]}`;
    const expected = createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
    expect(result.dispatches.records[0]?.actionBatchSha256).toBe(expected);
    const changed = Object.freeze({ submitOrders: Object.freeze([{ pair: PAIR, type: 'MARKET' as const, side: 'BUY' as const, quantity: '3', reduceOnly: false }]) });
    expect(strategyActionBatchSha256(changed)).not.toBe(expected);
    expect(strategyActionBatchSha256(result.batch)).toBe(strategyActionBatchSha256(result.batch));
    expect(result.batch.submitOrders?.[0]).not.toHaveProperty('orderId');
  });

  it('fails closed on decision sink failure before reconciliation or dispatch', async () => {
    const strategy = kernel();
    const dispatches = new InMemoryStrategyDispatchAuditSink();
    const adapter = new StrategyBacktestParticipantAdapter({
      kernel: strategy, fixedResearchQuantity: '2', dispatchSink: dispatches,
      decisionSink: { writeDecision: () => { throw new Error('audit unavailable'); } },
    });
    await expect(adapter.onEvaluation(context('2', '1'))).rejects.toThrow('audit unavailable');
    expect(dispatches.records).toEqual([]);
  });

  it('audits the decision then rejects active unresolved orders', async () => {
    const strategy = kernel();
    const decisions = new InMemoryStrategyDecisionSink();
    const dispatches = new InMemoryStrategyDispatchAuditSink();
    const adapter = new StrategyBacktestParticipantAdapter({ kernel: strategy, fixedResearchQuantity: '2', decisionSink: decisions, dispatchSink: dispatches });
    await expect(adapter.onEvaluation(context('2', '1', 'FLAT', '0', [{} as BacktestOrderSnapshot])))
      .rejects.toEqual(expect.objectContaining({ code: 'STRATEGY_BACKTEST_ADAPTER_BUSY' }));
    expect(decisions.decisions).toHaveLength(1);
    expect(dispatches.records).toEqual([expect.objectContaining({ dispatchStatus: 'ADAPTER_REJECTED' })]);
  });

  it('persists a legitimate WARMING decision before active-order rejection and emits zero action', async () => {
    const strategy = kernel();
    const decisions = new InMemoryStrategyDecisionSink();
    const dispatches = new InMemoryStrategyDispatchAuditSink();
    const timeline: string[] = [];
    const adapter = new StrategyBacktestParticipantAdapter({
      kernel: strategy,
      fixedResearchQuantity: '2',
      decisionSink: {
        writeDecision: (decision) => {
          timeline.push(`decision:${decision.decisionId}`);
          decisions.writeDecision(decision);
        },
      },
      dispatchSink: {
        writeDispatch: (record) => {
          timeline.push(`dispatch:${record.dispatchStatus}:${record.decisionId}`);
          dispatches.writeDispatch(record);
        },
      },
    });
    const activeOrder: BacktestOrderSnapshot = Object.freeze({
      orderId: 'existing-open-order',
      orderSequence: 1,
      pair: PAIR,
      type: 'POST_ONLY_LIMIT',
      side: 'BUY',
      quantity: new BacktestDecimal('1'),
      limitPrice: new BacktestDecimal('99'),
      stopPrice: null,
      reduceOnly: false,
      ocoGroupId: null,
      state: 'OPEN',
      submittedAtMs: BASE,
      rejectionCode: null,
    });
    const warmingWithActiveOrder = context(null, null, 'FLAT', '0', Object.freeze([activeOrder]));
    let returnedBatch: BacktestActionBatch | undefined;
    let failure: unknown;

    try {
      returnedBatch = await adapter.onEvaluation(warmingWithActiveOrder);
    } catch (error) {
      failure = error;
      timeline.push('failure');
    }

    expect(warmingWithActiveOrder.openOrders).toEqual([activeOrder]);
    expect(returnedBatch).toBeUndefined();
    expect(failure).toEqual(expect.objectContaining({ code: 'STRATEGY_BACKTEST_ADAPTER_BUSY' }));
    expect(decisions.decisions).toHaveLength(1);
    const decision = decisions.decisions[0]!;
    expect(decision).toMatchObject({ status: 'WARMING', targetExposure: null });
    expect(dispatches.records).toEqual([
      expect.objectContaining({ decisionId: decision.decisionId, dispatchStatus: 'ADAPTER_REJECTED', actionBatchSha256: null }),
    ]);
    expect(dispatches.records.map((record) => record.dispatchStatus)).not.toContain('WARMING_NO_ACTION');
    expect(dispatches.records.map((record) => record.dispatchStatus)).not.toContain('ACTION_BATCH_RETURNED');
    expect(timeline).toEqual([
      `decision:${decision.decisionId}`,
      `dispatch:ADAPTER_REJECTED:${decision.decisionId}`,
      'failure',
    ]);
  });

  it('does not evaluate or increment when the trigger timeframe did not close', async () => {
    const strategy = emaTrendV1Definition.createKernel({ pair: PAIR, parameters: { timeframeMinutes: 5, fastPeriod: 2, slowPeriod: 3, priceSource: 'CLOSE' }, indicatorBootstrapIdentity: bootstrap(5) });
    const decisions = new InMemoryStrategyDecisionSink();
    const dispatches = new InMemoryStrategyDispatchAuditSink();
    const adapter = new StrategyBacktestParticipantAdapter({ kernel: strategy, fixedResearchQuantity: '2', decisionSink: decisions, dispatchSink: dispatches });
    const noTriggerContext = context('2', '1');
    expect(await adapter.onEvaluation(noTriggerContext)).toEqual({ submitOrders: [] });
    expect(decisions.decisions).toEqual([]);
    expect(dispatches.records).toEqual([]);
    expect(strategy.evaluate({
      pair: PAIR,
      evaluationTimeMs: BASE + 300_000,
      triggerClosedCandle: Object.freeze({ pair: PAIR, timeframeMinutes: 5, openTimeMs: BASE, closeTimeExclusiveMs: BASE + 300_000, open: '100', high: '100', low: '100', close: '100', volume: '1', quoteVolume: null }),
      latestClosedCandleByTimeframe: new StrategyReadonlyMap([[5, Object.freeze({ pair: PAIR, timeframeMinutes: 5, openTimeMs: BASE, closeTimeExclusiveMs: BASE + 300_000, open: '100', high: '100', low: '100', close: '100', volume: '1', quoteVolume: null })]]),
      candlesClosedAtThisTimestamp: Object.freeze([Object.freeze({ pair: PAIR, timeframeMinutes: 5, openTimeMs: BASE, closeTimeExclusiveMs: BASE + 300_000, open: '100', high: '100', low: '100', close: '100', volume: '1', quoteVolume: null })]),
      latestIndicatorPointByAlias: new StrategyReadonlyMap([
        ['ema.fast', indicatorPoint(5, BASE + 300_000, '2')],
        ['ema.slow', indicatorPoint(5, BASE + 300_000, '1')],
      ]),
    }).decisionSequence).toBe(1);
  });

  it('uses the exact same kernel instance rather than adapter evaluation logic', async () => {
    const strategy = kernel();
    const decisions = new InMemoryStrategyDecisionSink();
    const adapter = new StrategyBacktestParticipantAdapter({ kernel: strategy, fixedResearchQuantity: '2', decisionSink: decisions });
    expect(adapter.kernel).toBe(strategy);
    await adapter.onEvaluation(context('2', '1'));
    expect(decisions.decisions[0]).toMatchObject({ strategyInstanceId: strategy.strategyInstanceId, targetExposure: 'LONG', reasonCodes: ['EMA_FAST_ABOVE_SLOW'] });
  });

  it('replays decision, dispatch and action identities deterministically', async () => {
    const left = await evaluation('2', '1', 'SHORT', '3');
    const right = await evaluation('2', '1', 'SHORT', '3');
    expect(left.decisions.decisions).toEqual(right.decisions.decisions);
    expect(left.dispatches.records).toEqual(right.dispatches.records);
    expect(left.batch).toEqual(right.batch);
  });

  it('binds fixed research quantity to Phase 9 participant and run identity only', () => {
    const strategy = kernel();
    const one = buildStrategyBacktestParticipantIdentity({ kernel: strategy, fixedResearchQuantity: '1.0', gitCommitHash: 'b513552' });
    const two = buildStrategyBacktestParticipantIdentity({ kernel: strategy, fixedResearchQuantity: '2', gitCommitHash: 'b513552' });
    expect(one.parameterHash).not.toBe(two.parameterHash);
    const bars = [candle(), createCanonicalCandle1m({ pair: PAIR, openTimeMs: BASE + 60_000, open: '100', high: '100', low: '100', close: '100', volume: '1', quoteVolume: null, source: 'REST_HISTORICAL', finalizedAtMs: BASE + 120_000, providerEventTimeMs: null, generationId: null })];
    const participant = { onEvaluation: () => ({}) };
    const runOne = new BacktestEngine(backtestConfig(bars, participant, { participantIdentity: one }));
    const runTwo = new BacktestEngine(backtestConfig(bars, participant, { participantIdentity: two }));
    expect(runOne.runId).not.toBe(runTwo.runId);
    expect(strategy.parameterHash).toBe(kernel().parameterHash);
    expect(strategy.strategyInstanceId).toBe(kernel().strategyInstanceId);
  });

  it('runs the adapter and genuine strategy bindings through the real Phase 9 engine', async () => {
    const strategy = kernel();
    const decisions = new InMemoryStrategyDecisionSink();
    const dispatches = new InMemoryStrategyDispatchAuditSink();
    const adapter = new StrategyBacktestParticipantAdapter({ kernel: strategy, fixedResearchQuantity: '1', decisionSink: decisions, dispatchSink: dispatches });
    const bars = ['100', '110', '120', '130'].map((close, index) => createCanonicalCandle1m({
      pair: PAIR, openTimeMs: BASE + index * 60_000, open: close, high: close, low: close, close, volume: '1', quoteVolume: null,
      source: 'REST_HISTORICAL', finalizedAtMs: BASE + (index + 1) * 60_000, providerEventTimeMs: null, generationId: null,
    }));
    const participantIdentity = buildStrategyBacktestParticipantIdentity({ kernel: strategy, fixedResearchQuantity: '1', gitCommitHash: 'b513552' });
    const engine = new BacktestEngine(backtestConfig(bars, adapter, {
      participantIdentity,
      indicatorBindings: createStrategyBacktestIndicatorBindings(strategy),
    }));
    const result = await engine.run();
    expect(result).toMatchObject({ terminalStatus: 'COMPLETED', isValid: true });
    expect(decisions.decisions.length).toBeGreaterThan(1);
    expect(decisions.decisions.some((decision) => decision.status === 'READY')).toBe(true);
    expect(dispatches.records).toHaveLength(decisions.decisions.length);
  });

  it('rejects invalid fixed quantities without native-number parsing', () => {
    const strategy = kernel();
    expect(() => new StrategyBacktestParticipantAdapter({ kernel: strategy, fixedResearchQuantity: '0', decisionSink: new InMemoryStrategyDecisionSink() })).toThrowError(StrategyError);
    expect(() => new StrategyBacktestParticipantAdapter({ kernel: strategy, fixedResearchQuantity: ' 2', decisionSink: new InMemoryStrategyDecisionSink() })).toThrowError(StrategyError);
  });
});
