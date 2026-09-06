import { describe, expect, it } from 'vitest';
import {
  BacktestDecimal,
  BacktestEngine,
  InMemoryBacktestSink,
  sha256CanonicalJson,
  type BacktestOrderIntent,
  type BacktestRunResult,
} from '../../../src/backtest';
import { BASE, candle, config, ScriptedParticipant } from './helpers';

function market(side: 'BUY' | 'SELL', quantity = '1', reduceOnly = false): BacktestOrderIntent {
  return { pair: 'B-BTC_INR', type: 'MARKET', side, quantity, reduceOnly };
}

function completed(outcome: Awaited<ReturnType<BacktestEngine['run']>>): BacktestRunResult {
  expect(outcome.terminalStatus).toBe('COMPLETED');
  if (outcome.terminalStatus !== 'COMPLETED') throw new Error(outcome.terminalError);
  return outcome;
}

describe('Phase 9 causal execution', () => {
  it.each([
    ['BUY', '100.3'],
    ['SELL', '99.7'],
  ] as const)('fills a %s market order at next open with adverse spread/slippage and taker fee', async (side, fillPrice) => {
    const participant = new ScriptedParticipant([{ submitOrders: [market(side)] }, {}]);
    const sink = new InMemoryBacktestSink();
    const result = completed(await new BacktestEngine(config([candle(0), candle(1), candle(2)], participant), sink).run());
    const fill = sink.events.find((event) => event.type === 'ORDER_FILLED');
    expect(fill?.eventTimeMs).toBe(BASE + 60_000);
    expect(fill?.payload.fillPrice).toBe(fillPrice);
    expect(fill?.payload.feeClass).toBe('TAKER');
    expect(fill?.payload.spreadCostAttribution).toBe('0.1');
    expect(fill?.payload.slippageCostAttribution).toBe('0.2');
    expect(result.totalFills).toBe(1);
    expect(result.financialSummary.takerFees.value).toBe(side === 'BUY' ? '0.2006' : '0.1994');
  });

  it('proves same-timestamp next-bar causality by event sequence', async () => {
    const participant = new ScriptedParticipant([{ submitOrders: [market('BUY')] }]);
    const sink = new InMemoryBacktestSink();
    completed(await new BacktestEngine(config([candle(0, { open: '80', high: '110', low: '70' }), candle(1, { open: '100' })], participant), sink).run());
    const evaluation = sink.events.find((event) => event.type === 'EVALUATION_COMPLETED');
    const fill = sink.events.find((event) => event.type === 'ORDER_FILLED');
    expect(evaluation?.eventTimeMs).toBe(BASE + 60_000);
    expect(fill?.eventTimeMs).toBe(BASE + 60_000);
    expect(evaluation!.sequence).toBeLessThan(fill!.sequence);
    expect(fill?.payload.rawReferencePrice).toBe('100');
  });

  it('processes multiple market orders at one open by order sequence', async () => {
    const participant = new ScriptedParticipant([{ submitOrders: [market('BUY'), market('SELL')] }]);
    const sink = new InMemoryBacktestSink();
    completed(await new BacktestEngine(config([candle(0), candle(1)], participant), sink).run());
    const fills = sink.events.filter((event) => event.type === 'ORDER_FILLED');
    expect(fills.map((event) => event.payload.orderSequence)).toEqual([1, 2]);
  });

  it('fails closed when a market execution price is not positive', async () => {
    const participant = new ScriptedParticipant([{ submitOrders: [market('BUY')] }]);
    const result = await new BacktestEngine(config([candle(0), candle(1, { open: '0', high: '1', low: '0', close: '1' })], participant)).run();
    expect(result).toMatchObject({ terminalStatus: 'FAILED', errorCode: 'BACKTEST_NUMERIC_FAILURE' });
  });

  it('fails closed when a gap-through stop computes a non-positive execution price', async () => {
    const participant = new ScriptedParticipant([{ submitOrders: [{ pair: 'B-BTC_INR', type: 'STOP_MARKET', side: 'SELL', quantity: '1', stopPrice: '95' }] }]);
    const result = await new BacktestEngine(config([
      candle(0), candle(1, { open: '0', high: '100', low: '0', close: '0' }),
    ], participant)).run();
    expect(result).toMatchObject({ terminalStatus: 'FAILED', errorCode: 'BACKTEST_NUMERIC_FAILURE' });
  });
});

describe('Phase 9 post-only and stop execution', () => {
  it.each([
    ['BUY', '100', { open: '100', high: '105', low: '95' }],
    ['SELL', '100', { open: '100', high: '105', low: '95' }],
  ] as const)('rejects marketable post-only %s orders against raw open', async (side, limitPrice, bar) => {
    const participant = new ScriptedParticipant([{ submitOrders: [{ pair: 'B-BTC_INR', type: 'POST_ONLY_LIMIT', side, quantity: '1', limitPrice }] }]);
    const sink = new InMemoryBacktestSink();
    completed(await new BacktestEngine(config([candle(0), candle(1, bar)], participant), sink).run());
    expect(sink.events.some((event) => event.type === 'ORDER_REJECTED' && event.payload.rejectionCode === 'POST_ONLY_WOULD_TAKE')).toBe(true);
    expect(sink.events.some((event) => event.type === 'ORDER_FILLED')).toBe(false);
  });

  it.each([
    ['BUY', { open: '101', high: '102', low: '100' }, 0],
    ['BUY', { open: '101', high: '102', low: '99.99' }, 1],
    ['SELL', { open: '99', high: '100', low: '98' }, 0],
    ['SELL', { open: '99', high: '100.01', low: '98' }, 1],
  ] as const)('applies strict penetration for %s post-only limits', async (side, bar, expectedFills) => {
    const participant = new ScriptedParticipant([{ submitOrders: [{ pair: 'B-BTC_INR', type: 'POST_ONLY_LIMIT', side, quantity: '1', limitPrice: '100' }] }]);
    const sink = new InMemoryBacktestSink();
    const result = completed(await new BacktestEngine(config([candle(0), candle(1, bar)], participant), sink).run());
    expect(result.totalFills).toBe(expectedFills);
    if (expectedFills === 1) {
      const fill = sink.events.find((event) => event.type === 'ORDER_FILLED');
      expect(fill?.payload.fillPrice).toBe('100');
      expect(fill?.payload.feeClass).toBe('MAKER');
      expect(fill?.payload.spreadCostAttribution).toBe('0');
      expect(result.financialSummary.makerFees.value).toBe('0.1');
    }
  });

  it.each([
    ['BUY', '105', { open: '100', high: '105', low: '99' }, '105.42'],
    ['SELL', '95', { open: '100', high: '101', low: '95' }, '94.62'],
    ['BUY', '105', { open: '110', high: '112', low: '109', close: '110' }, '110.44'],
    ['SELL', '95', { open: '90', high: '91', low: '89', close: '90' }, '89.64'],
  ] as const)('executes %s stops with normal or gap-through reference', async (side, stopPrice, bar, expectedPrice) => {
    const participant = new ScriptedParticipant([{ submitOrders: [{ pair: 'B-BTC_INR', type: 'STOP_MARKET', side, quantity: '1', stopPrice }] }]);
    const sink = new InMemoryBacktestSink();
    completed(await new BacktestEngine(config([candle(0), candle(1, bar)], participant), sink).run());
    const fill = sink.events.find((event) => event.type === 'ORDER_FILLED');
    expect(fill?.payload.fillPrice).toBe(expectedPrice);
    expect(fill?.payload.feeClass).toBe('TAKER');
  });

  it('fills a previously resting limit at its original limit through a later gap', async () => {
    const participant = new ScriptedParticipant([
      { submitOrders: [{ pair: 'B-BTC_INR', type: 'POST_ONLY_LIMIT', side: 'BUY', quantity: '1', limitPrice: '95' }] },
      {},
    ]);
    const sink = new InMemoryBacktestSink();
    completed(await new BacktestEngine(config([
      candle(0), candle(1, { open: '100', high: '101', low: '96' }), candle(2, { open: '90', high: '92', low: '89', close: '90' }),
    ], participant), sink).run());
    expect(sink.events.find((event) => event.type === 'ORDER_FILLED')?.payload.fillPrice).toBe('95');
  });
});

describe('Phase 9 cancellation, OCO, and reduce-only', () => {
  it('makes cancellation accepted at T win before the next bar gap-through', async () => {
    let orderId = '';
    const participant = new ScriptedParticipant([
      { submitOrders: [{ pair: 'B-BTC_INR', type: 'POST_ONLY_LIMIT', side: 'BUY', quantity: '1', limitPrice: '95' }] },
      { get cancelOrderIds() { return [orderId]; } },
    ]);
    const sink = new InMemoryBacktestSink();
    const engine = new BacktestEngine(config([
      candle(0), candle(1, { open: '100', low: '96' }), candle(2, { open: '90', low: '85' }),
    ], {
      onEvaluation(context) {
        const batch = participant.onEvaluation(context);
        orderId = context.openOrders[0]?.orderId ?? orderId;
        return batch;
      },
    }), sink);
    completed(await engine.run());
    const accepted = sink.events.find((event) => event.type === 'ORDER_CANCELLATION_ACCEPTED');
    const cancelled = sink.events.find((event) => event.type === 'ORDER_CANCELLED');
    expect(accepted?.eventTimeMs).toBe(BASE + 120_000);
    expect(cancelled?.eventTimeMs).toBe(BASE + 120_000);
    expect(accepted!.sequence).toBeLessThan(cancelled!.sequence);
    expect(sink.events.some((event) => event.type === 'ORDER_FILLED')).toBe(false);
  });

  it('chooses the adverse long stop, then immediately cancels its OCO sibling', async () => {
    const participant = new ScriptedParticipant([
      { submitOrders: [market('BUY')] },
      { submitOrders: [
        { pair: 'B-BTC_INR', type: 'POST_ONLY_LIMIT', side: 'SELL', quantity: '1', limitPrice: '105', reduceOnly: true, ocoGroupId: 'exit' },
        { pair: 'B-BTC_INR', type: 'STOP_MARKET', side: 'SELL', quantity: '1', stopPrice: '95', reduceOnly: true, ocoGroupId: 'exit' },
      ] },
    ]);
    const sink = new InMemoryBacktestSink();
    completed(await new BacktestEngine(config([candle(0), candle(1), candle(2, { open: '100', high: '110', low: '90' })], participant), sink).run());
    const relevant = sink.events.filter((event) => event.eventTimeMs === BASE + 180_000 && ['ORDER_FILLED', 'ORDER_CANCELLED'].includes(event.type));
    expect(relevant.map((event) => event.type)).toEqual(['ORDER_FILLED', 'ORDER_CANCELLED']);
    expect(relevant[0]?.payload.orderSequence).toBe(3);
    expect(relevant[1]?.payload.orderSequence).toBe(2);
  });

  it('rejects reduce-only while flat, same-side, and excess quantities as whole orders', async () => {
    const flatSink = new InMemoryBacktestSink();
    completed(await new BacktestEngine(config([candle(0), candle(1)], new ScriptedParticipant([
      { submitOrders: [market('SELL', '1', true)] },
    ])), flatSink).run());
    expect(flatSink.events.some((event) => event.type === 'ORDER_REJECTED' && event.payload.code === 'ORDER_INVALID')).toBe(true);

    const participant = new ScriptedParticipant([
      { submitOrders: [market('BUY')] },
      { submitOrders: [market('BUY', '0.5', true), market('SELL', '2', true)] },
    ]);
    const sink = new InMemoryBacktestSink();
    const result = completed(await new BacktestEngine(config([candle(0), candle(1), candle(2)], participant), sink).run());
    expect(result.totalFills).toBe(1);
    expect(result.terminalPosition?.side).toBe('LONG');
    expect(result.terminalPosition?.quantity.value).toBe('1');
  });

  it('executes a smaller all-or-none reduce-only fill as a partial position reduction', async () => {
    const participant = new ScriptedParticipant([
      { submitOrders: [market('BUY', '2')] },
      { submitOrders: [market('SELL', '1', true)] },
    ]);
    const sink = new InMemoryBacktestSink();
    const result = completed(await new BacktestEngine(config([candle(0), candle(1), candle(2)], participant), sink).run());
    expect(result.terminalPosition?.side).toBe('LONG');
    expect(result.terminalPosition?.quantity.value).toBe('1');
    expect(result.totalClosedTrades).toBe(1);
    expect(sink.events.filter((event) => event.type === 'TRADE_CLOSED')).toHaveLength(1);
    expect(sink.events.find((event) => event.type === 'TRADE_CLOSED')?.payload.closingQuantity).toBe('1');
  });

  it('revalidates reduce-only orders at fill-time and rejects whole order when earlier same-bar fill reduces position', async () => {
    const participant = new ScriptedParticipant([
      { submitOrders: [market('BUY', '5')] },
      { submitOrders: [market('SELL', '3'), market('SELL', '5', true)] },
    ]);
    const sink = new InMemoryBacktestSink();
    const result = completed(await new BacktestEngine(config([candle(0), candle(1), candle(2)], participant), sink).run());

    expect(result.terminalPosition?.side).toBe('LONG');
    expect(result.terminalPosition?.quantity.value).toBe('2');
    expect(result.totalFills).toBe(2);

    const acceptedB = sink.events.find(
      (event) => event.type === 'ORDER_ACCEPTED' && event.payload.orderSequence === 3,
    );
    expect(acceptedB).toBeDefined();
    expect(acceptedB?.payload.reduceOnly).toBe(true);
    expect(acceptedB?.payload.quantity).toBe('5');

    const fillA = sink.events.find(
      (event) => event.type === 'ORDER_FILLED' && event.payload.orderSequence === 2,
    );
    expect(fillA).toBeDefined();
    expect(fillA?.payload.side).toBe('SELL');
    expect(fillA?.payload.quantity).toBe('3');

    const rejectedB = sink.events.find(
      (event) => event.type === 'ORDER_REJECTED' && event.payload.orderSequence === 3,
    );
    expect(rejectedB).toBeDefined();
    expect(rejectedB?.payload.rejectionCode).toBe('ORDER_INVALID');
    expect(rejectedB?.payload.message).toBe('Reduce-only order became invalid before fill');
    expect(rejectedB?.payload.state).toBe('REJECTED');

    // Execution causality: fill of Order A strictly preceded fill-time rejection of Order B
    expect(fillA!.sequence).toBeLessThan(rejectedB!.sequence);

    // Order B was never filled and incurred no fees
    const fillsB = sink.events.filter(
      (event) => event.type === 'ORDER_FILLED' && event.payload.orderSequence === 3,
    );
    expect(fillsB).toHaveLength(0);

    // Mirror: SHORT position with reduce-only Order A and Order B
    const shortParticipant = new ScriptedParticipant([
      { submitOrders: [market('SELL', '5')] },
      { submitOrders: [market('BUY', '3', true), market('BUY', '5', true)] },
    ]);
    const shortSink = new InMemoryBacktestSink();
    const shortResult = completed(await new BacktestEngine(config([candle(0), candle(1), candle(2)], shortParticipant), shortSink).run());

    expect(shortResult.terminalPosition?.side).toBe('SHORT');
    expect(shortResult.terminalPosition?.quantity.value).toBe('2');
    expect(shortResult.totalFills).toBe(2);

    const shortRejectedB = shortSink.events.find(
      (event) => event.type === 'ORDER_REJECTED' && event.payload.orderSequence === 3,
    );
    expect(shortRejectedB).toBeDefined();
    expect(shortRejectedB?.payload.rejectionCode).toBe('ORDER_INVALID');
    expect(shortRejectedB?.payload.message).toBe('Reduce-only order became invalid before fill');

    const shortFillsB = shortSink.events.filter(
      (event) => event.type === 'ORDER_FILLED' && event.payload.orderSequence === 3,
    );
    expect(shortFillsB).toHaveLength(0);
  });

  it('enforces fill-time minNotional without mutating the position', async () => {
    const participant = new ScriptedParticipant([{ submitOrders: [market('BUY', '0.01')] }]);
    const sink = new InMemoryBacktestSink();
    const result = completed(await new BacktestEngine(config([candle(0), candle(1, { open: '10', high: '11', low: '9', close: '10' })], participant, {
      instrumentSpec: {
        ...config([candle(0), candle(1)]).instrumentSpec,
        minNotional: new BacktestDecimal('1'),
      },
    }), sink).run());
    expect(result.totalFills).toBe(0);
    expect(result.terminalPosition).toBeNull();
    expect(sink.events.some((event) => event.type === 'ORDER_REJECTED' && event.payload.rejectionCode === 'INSTRUMENT_CONSTRAINT_VIOLATION')).toBe(true);
  });

  it('bounds active orders and binds maxOpenOrders into run identity', async () => {
    const candles = [candle(0), candle(1)];
    const orders = [
      { pair: 'B-BTC_INR', type: 'POST_ONLY_LIMIT', side: 'BUY', quantity: '1', limitPrice: '90' },
      { pair: 'B-BTC_INR', type: 'POST_ONLY_LIMIT', side: 'BUY', quantity: '1', limitPrice: '80' },
    ] as const;
    const sink = new InMemoryBacktestSink();
    const limited = new BacktestEngine(config(candles, new ScriptedParticipant([{ submitOrders: orders }]), { maxOpenOrders: 1 }), sink);
    const defaulted = new BacktestEngine(config(candles));
    const result = completed(await limited.run());
    expect(result.terminalOpenOrders).toHaveLength(1);
    expect(sink.events.some((event) => event.type === 'ORDER_REJECTED' && event.payload.message === 'maxOpenOrders exceeded')).toBe(true);
    expect(limited.runId).not.toBe(defaulted.runId);
  });

  it('changes run identity for meaningful cost and funding hashes', () => {
    const candles = [candle(0), candle(1)];
    const base = new BacktestEngine(config(candles));
    const fee = new BacktestEngine(config(candles, new ScriptedParticipant(), {
      costModel: { ...config(candles).costModel, makerFeeRate: new BacktestDecimal('0.002') },
    }));
    const fundingEvents = [{ fundingTimeMs: BASE + 60_000, fundingRate: new BacktestDecimal('0.01'), referencePrice: new BacktestDecimal('100') }];
    const funding = new BacktestEngine(config(candles, new ScriptedParticipant(), {
      fundingSchedule: { ...config(candles).fundingSchedule, contentSha256: sha256CanonicalJson(fundingEvents), events: fundingEvents },
    }));
    expect(new Set([base.runId, fee.runId, funding.runId]).size).toBe(3);
  });
});
