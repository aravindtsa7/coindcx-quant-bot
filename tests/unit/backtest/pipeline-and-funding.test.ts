import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SmaKernel } from '../../../src/indicators/sma';
import type { IndicatorCandle, IndicatorKernel, IndicatorPoint } from '../../../src/indicators/types';
import {
  BacktestDecimal,
  BacktestEngine,
  BacktestError,
  InMemoryBacktestSink,
  canonicalJson,
  sha256CanonicalJson,
  type BacktestRunResult,
} from '../../../src/backtest';
import { BASE, candle, config, ScriptedParticipant } from './helpers';

function completed(outcome: Awaited<ReturnType<BacktestEngine['run']>>): BacktestRunResult {
  expect(outcome.terminalStatus).toBe('COMPLETED');
  if (outcome.terminalStatus !== 'COMPLETED') throw new Error(outcome.terminalError);
  return outcome;
}

function market(side: 'BUY' | 'SELL', reduceOnly = false) {
  return { pair: 'B-BTC_INR', type: 'MARKET' as const, side, quantity: '1', reduceOnly };
}

describe('Phase 9 ranges, HTF, and real indicators', () => {
  it('enforces four half-open boundaries and evaluation inclusivity/exclusivity', async () => {
    const participant = new ScriptedParticipant();
    const candles = [candle(0), candle(1), candle(2), candle(3)];
    completed(await new BacktestEngine(config(candles, participant, {
      evaluationFromInclusiveMs: BASE + 120_000,
      evaluationToExclusiveMs: BASE + 180_000,
    })).run());
    expect(participant.contexts.map((context) => context.simulationTimeMs)).toEqual([BASE + 120_000]);
  });

  it.each([
    { bootstrapFromInclusiveMs: BASE - 60_000 },
    { evaluationFromInclusiveMs: BASE + 180_000, evaluationToExclusiveMs: BASE + 180_000 },
    { evaluationToExclusiveMs: BASE + 240_000 },
    { replayToExclusiveMs: BASE + 240_000 },
  ])('rejects invalid range edges', (override) => {
    const candles = [candle(0), candle(1), candle(2)];
    expect(() => new BacktestEngine(config(candles, new ScriptedParticipant(), override))).toThrowError(BacktestError);
  });

  it('rejects a common HTF bootstrap misalignment', () => {
    const candles = [candle(0), candle(1), candle(2), candle(3)];
    expect(() => new BacktestEngine(config(candles, new ScriptedParticipant(), {
      bootstrapFromInclusiveMs: BASE + 60_000,
      evaluationFromInclusiveMs: BASE + 120_000,
      configuredTimeframes: [2],
    }))).toThrowError(BacktestError);
  });

  it('derives real exact HTFs in ascending order and never exposes an incomplete candle', async () => {
    const participant = new ScriptedParticipant();
    const sink = new InMemoryBacktestSink();
    const candles = Array.from({ length: 6 }, (_, index) => candle(index));
    completed(await new BacktestEngine(config(candles, participant, { configuredTimeframes: [3, 2] }), sink).run());
    const simultaneous = sink.events
      .filter((event) => event.type === 'CANDLE_CLOSED' && event.eventTimeMs === BASE + 360_000)
      .map((event) => event.payload.timeframeMinutes);
    expect(simultaneous).toEqual([1, 2, 3]);
    const firstContext = participant.contexts[0]!;
    expect(firstContext.candlesClosedAtThisTimestamp.map((item) => 'timeframeMinutes' in item ? item.timeframeMinutes : 1)).toEqual([1]);
    const secondContext = participant.contexts[1]!;
    expect(secondContext.candlesClosedAtThisTimestamp.map((item) => 'timeframeMinutes' in item ? item.timeframeMinutes : 1)).toEqual([1, 2]);
  });

  it('feeds real Phase 8 kernels from their exact origins and preserves warmup null', async () => {
    const participant = new ScriptedParticipant();
    const sink = new InMemoryBacktestSink();
    const candles = [
      candle(0, { close: '100' }), candle(1, { close: '102' }),
      candle(2, { close: '104' }), candle(3, { close: '106' }),
    ];
    const oneMinute = new SmaKernel({ pair: 'B-BTC_INR', timeframeMinutes: 1, bootstrapStartOpenTimeMs: BASE, period: 2 });
    const twoMinute = new SmaKernel({ pair: 'B-BTC_INR', timeframeMinutes: 2, bootstrapStartOpenTimeMs: BASE, period: 2 });
    completed(await new BacktestEngine(config(candles, participant, {
      configuredTimeframes: [2],
      indicatorBindings: [
        { key: 'sma-1m', timeframeMinutes: 1, kernel: oneMinute },
        { key: 'sma-2m', timeframeMinutes: 2, kernel: twoMinute },
      ],
    }), sink).run());
    const onePoints = sink.events.filter((event) => event.type === 'INDICATOR_UPDATED' && event.entityId === 'sma-1m');
    expect(onePoints.map((event) => event.payload.value)).toEqual([null, '101', '103', '105']);
    const twoPoints = sink.events.filter((event) => event.type === 'INDICATOR_UPDATED' && event.entityId === 'sma-2m');
    expect(twoPoints.map((event) => event.payload.value)).toEqual([null, '104']);
  });

  it('terminates the run when an indicator kernel fails', async () => {
    const kernel: IndicatorKernel<string> = {
      segment: { pair: 'B-BTC_INR', timeframeMinutes: 1, indicatorType: 'FAIL', parameters: {}, bootstrapStartOpenTimeMs: BASE },
      isTerminated: false,
      update(_input: IndicatorCandle): IndicatorPoint<string> { throw new Error('terminal fixture'); },
    };
    const outcome = await new BacktestEngine(config([candle(0), candle(1)], new ScriptedParticipant(), {
      indicatorBindings: [{ key: 'failure', timeframeMinutes: 1, kernel }],
    })).run();
    expect(outcome).toMatchObject({ terminalStatus: 'FAILED', errorCode: 'INDICATOR_FAILURE' });
  });
});

describe('Phase 9 funding ordering and signs', () => {
  it.each([
    ['BUY', '0.01', '-1'],
    ['SELL', '0.01', '1'],
    ['BUY', '-0.01', '1'],
  ] as const)('applies signed funding to a surviving %s position', async (side, rate, expected) => {
    const participant = new ScriptedParticipant([{ submitOrders: [market(side)] }, {}]);
    const fundingTimeMs = BASE + 120_000;
    const events = [{ fundingTimeMs, fundingRate: new BacktestDecimal(rate), referencePrice: new BacktestDecimal('100') }];
    const sink = new InMemoryBacktestSink();
    const result = completed(await new BacktestEngine(config([candle(0), candle(1)], participant, {
      fundingSchedule: {
        sourceId: 'signed-funding', contentSha256: sha256CanonicalJson(events), fidelity: 'TEST_ONLY', events,
      },
    }), sink).run());
    expect(result.financialSummary.fundingPnl.value).toBe(expected);
    expect(sink.events.filter((event) => event.type === 'FUNDING_APPLIED')).toHaveLength(1);
  });

  it('emits funding while flat before evaluation and evaluation sees it applied', async () => {
    const participant = new ScriptedParticipant([{ submitOrders: [market('BUY')] }]);
    const fundingTimeMs = BASE + 60_000;
    const events = [{ fundingTimeMs, fundingRate: new BacktestDecimal('0.01'), referencePrice: new BacktestDecimal('100') }];
    const sink = new InMemoryBacktestSink();
    completed(await new BacktestEngine(config([candle(0), candle(1)], participant, {
      fundingSchedule: { sourceId: 'flat-funding', contentSha256: sha256CanonicalJson(events), fidelity: 'TEST_ONLY', events },
    }), sink).run());
    const funding = sink.events.find((event) => event.type === 'FUNDING_APPLIED')!;
    const accepted = sink.events.find((event) => event.type === 'ORDER_ACCEPTED')!;
    expect(funding.payload).toMatchObject({ fundingPnl: '0', positionSide: 'FLAT' });
    expect(funding.sequence).toBeLessThan(accepted.sequence);
    expect(participant.contexts[0]?.accountEquity.fundingPnl.value).toBe('0');
  });

  it('makes newly applied nonzero funding visible to evaluation at the same close timestamp', async () => {
    const participant = new ScriptedParticipant([{ submitOrders: [market('BUY')] }, {}]);
    const fundingTimeMs = BASE + 120_000;
    const fundingEvents = [{ fundingTimeMs, fundingRate: new BacktestDecimal('0.01'), referencePrice: new BacktestDecimal('100') }];
    const sink = new InMemoryBacktestSink();
    completed(await new BacktestEngine(config([candle(0), candle(1), candle(2)], participant, {
      fundingSchedule: { sourceId: 'visible-funding', contentSha256: sha256CanonicalJson(fundingEvents), fidelity: 'TEST_ONLY', events: fundingEvents },
    }), sink).run());
    expect(participant.contexts.find((context) => context.simulationTimeMs === fundingTimeMs)?.accountEquity.fundingPnl.value).toBe('-1');
    const funding = sink.events.find((event) => event.type === 'FUNDING_APPLIED')!;
    const evaluation = sink.events.find((event) => event.type === 'EVALUATION_COMPLETED' && event.eventTimeMs === fundingTimeMs)!;
    expect(funding.sequence).toBeLessThan(evaluation.sequence);
  });

  it('does not charge funding after the position closed', async () => {
    const participant = new ScriptedParticipant([
      { submitOrders: [market('BUY')] },
      { submitOrders: [market('SELL', true)] },
      {},
    ]);
    const fundingTimeMs = BASE + 180_000;
    const events = [{ fundingTimeMs, fundingRate: new BacktestDecimal('0.01'), referencePrice: new BacktestDecimal('100') }];
    const result = completed(await new BacktestEngine(config([candle(0), candle(1), candle(2)], participant, {
      fundingSchedule: { sourceId: 'closed-funding', contentSha256: sha256CanonicalJson(events), fidelity: 'TEST_ONLY', events },
    })).run());
    expect(result.financialSummary.fundingPnl.value).toBe('0');
    expect(result.terminalPosition).toBeNull();
  });

  it('accepts funding exactly at replayTo and rejects bootstrap/outside/duplicate schedule events', async () => {
    const candles = [candle(0), candle(1)];
    const replayEvent = [{ fundingTimeMs: BASE + 120_000, fundingRate: new BacktestDecimal('0.01'), referencePrice: new BacktestDecimal('100') }];
    const result = completed(await new BacktestEngine(config(candles, new ScriptedParticipant(), {
      fundingSchedule: { sourceId: 'edge', contentSha256: sha256CanonicalJson(replayEvent), fidelity: 'TEST_ONLY', events: replayEvent },
    })).run());
    expect(result.financialSummary.fundingPnl.value).toBe('0');

    for (const badTimes of [[BASE], [BASE + 180_000], [BASE + 60_000, BASE + 60_000]]) {
      const badEvents = badTimes.map((fundingTimeMs) => ({ fundingTimeMs, fundingRate: new BacktestDecimal('0'), referencePrice: new BacktestDecimal('100') }));
      expect(() => new BacktestEngine(config(candles, new ScriptedParticipant(), {
        fundingSchedule: { sourceId: 'bad-edge', contentSha256: sha256CanonicalJson(badEvents), fidelity: 'TEST_ONLY', events: badEvents },
      }))).toThrowError(BacktestError);
    }
  });

  it('rejects a funding schedule whose supplied content hash does not bind its events', () => {
    const candles = [candle(0), candle(1)];
    const events = [{ fundingTimeMs: BASE + 60_000, fundingRate: new BacktestDecimal('0.01'), referencePrice: new BacktestDecimal('100') }];
    expect(() => new BacktestEngine(config(candles, new ScriptedParticipant(), {
      fundingSchedule: { sourceId: 'forged-funding', contentSha256: '0'.repeat(64), fidelity: 'TEST_ONLY', events },
    }))).toThrowError(BacktestError);
  });
});

describe('Phase 9 terminal state and deterministic lineage', () => {
  it('leaves an open position and resting order unresolved without synthetic terminal events', async () => {
    const participant = new ScriptedParticipant([
      { submitOrders: [market('BUY'), { pair: 'B-BTC_INR', type: 'POST_ONLY_LIMIT', side: 'SELL', quantity: '1', limitPrice: '120' }] },
    ]);
    const sink = new InMemoryBacktestSink();
    const result = completed(await new BacktestEngine(config([candle(0), candle(1)], participant), sink).run());
    expect(result.terminalPosition?.side).toBe('LONG');
    expect(result.terminalOpenOrders).toHaveLength(1);
    expect(result.terminalOpenOrders[0]?.state).toBe('OPEN');
    expect(sink.events.filter((event) => event.type === 'ORDER_CANCELLED')).toHaveLength(0);
    expect(result.totalFills).toBe(1);
  });

  it('produces identical IDs, events, event framing hash, and result hash twice', async () => {
    const candles = [candle(0), candle(1), candle(2)];
    const sinkA = new InMemoryBacktestSink();
    const sinkB = new InMemoryBacktestSink();
    const a = completed(await new BacktestEngine(config(candles, new ScriptedParticipant([{ submitOrders: [market('BUY')] }])), sinkA).run());
    const b = completed(await new BacktestEngine(config(candles, new ScriptedParticipant([{ submitOrders: [market('BUY')] }])), sinkB).run());
    expect(a).toEqual(b);
    expect(sinkA.events).toEqual(sinkB.events);
    expect(sinkA.events.find((event) => event.type === 'ORDER_FILLED')?.entityId).toBe(sinkB.events.find((event) => event.type === 'ORDER_FILLED')?.entityId);
    const hash = createHash('sha256');
    for (const event of sinkA.events) hash.update(Buffer.from(`${canonicalJson(event)}\n`, 'utf8'));
    expect(hash.digest('hex')).toBe(a.eventLedgerSha256);
    const { resultSha256: _excluded, ...payload } = a;
    expect(sha256CanonicalJson(payload)).toBe(a.resultSha256);
  });
});
