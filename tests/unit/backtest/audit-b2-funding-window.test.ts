import { describe, expect, it } from 'vitest';
import {
  BacktestDecimal, BacktestEngine, InMemoryBacktestSink, canonicalJson,
  computeBacktestFundingScheduleContentSha256, deriveBacktestFundingScheduleForWindow,
  type BacktestFundingEvent, type BacktestFundingSchedule,
} from '../../../src/backtest';
import { BASE, PAIR, ScriptedParticipant, candle, config } from './helpers';

const MINUTE = 60_000;
const START = BASE + MINUTE;
const END = BASE + 5 * MINUTE;
function event(time: number, rate = '0.01'): BacktestFundingEvent {
  return { fundingTimeMs: time, fundingRate: new BacktestDecimal(rate), referencePrice: new BacktestDecimal('100') };
}
function source(events: readonly BacktestFundingEvent[]): BacktestFundingSchedule {
  return { sourceId: 'verified-btc-funding-v1', fidelity: 'VERIFIED_SCHEDULE', contentSha256: computeBacktestFundingScheduleContentSha256(events), events };
}
async function replay(authoritative: BacktestFundingSchedule, side: 'BUY' | 'SELL' | 'FLAT' = 'BUY', close = false) {
  const participant = new ScriptedParticipant(side === 'FLAT' ? [] : [
    { submitOrders: [{ pair: PAIR, type: 'MARKET', side, quantity: '1' }] },
    ...(close ? [{ submitOrders: [{ pair: PAIR, type: 'MARKET' as const, side: side === 'BUY' ? 'SELL' as const : 'BUY' as const, quantity: '1', reduceOnly: true }] }] : []),
  ]);
  const sink = new InMemoryBacktestSink();
  const schedule = deriveBacktestFundingScheduleForWindow(authoritative, START, END);
  const result = await new BacktestEngine(config(Array.from({ length: 7 }, (_, index) => candle(index)), participant, {
    fundingSchedule: schedule, evaluationFromInclusiveMs: START, evaluationToExclusiveMs: END, replayToExclusiveMs: END,
  }), sink).run();
  if (result.terminalStatus !== 'COMPLETED') throw new Error(result.terminalError);
  return { result, events: sink.events, participant, schedule };
}

describe('Audit B2 effective funding schedule contract', () => {
  it.each([
    ['start - 1ms', START - 1, 'INVALID'], ['exact start', START, 'EXCLUDED'], ['start + 1ms', START + 1, 'INVALID'],
    ['end - 1ms', END - 1, 'INVALID'], ['exact end', END, 'INCLUDED'], ['end + 1ms', END + 1, 'INVALID'],
  ] as const)('%s respects the frozen minute-close precision contract', (_label, time, expected) => {
    const authoritative = source([event(time)]);
    if (expected === 'INVALID') expect(() => deriveBacktestFundingScheduleForWindow(authoritative, START, END)).toThrow();
    else expect(deriveBacktestFundingScheduleForWindow(authoritative, START, END).events).toHaveLength(expected === 'INCLUDED' ? 1 : 0);
  });

  it('partitions adjacent close-time windows without duplicate boundary ownership', () => {
    const times = [START - MINUTE, START, START + MINUTE, END - MINUTE, END, END + MINUTE];
    const authoritative = source(times.map((time) => event(time)));
    const a = deriveBacktestFundingScheduleForWindow(authoritative, START, END);
    const b = deriveBacktestFundingScheduleForWindow(authoritative, END, END + 3 * MINUTE);
    expect(a.events.map((item) => item.fundingTimeMs)).toEqual([START + MINUTE, END - MINUTE, END]);
    expect(b.events.map((item) => item.fundingTimeMs)).toEqual([END + MINUTE]);
    expect([...a.events, ...b.events].filter((item) => item.fundingTimeMs === END)).toHaveLength(1);
    expect(authoritative.events.map((item) => item.fundingTimeMs)).toEqual(times);
    expect(a.sourceId).toBe(authoritative.sourceId);
    expect(a.fidelity).toBe(authoritative.fidelity);
    expect(Object.isFrozen(a.events)).toBe(true);
    expect(a).toEqual(deriveBacktestFundingScheduleForWindow(authoritative, START, END));
  });

  it.each(['duplicate', 'reordered', 'unaligned', 'zero-price', 'negative-price', 'nonfinite-rate', 'bad-hash', 'bad-source', 'bad-fidelity'] as const)('rejects %s authoritative evidence even wholly outside the effective window', (kind) => {
    const future = event(END + MINUTE);
    let events = [future];
    if (kind === 'duplicate') events = [future, future];
    if (kind === 'reordered') events = [event(END + 2 * MINUTE), future];
    if (kind === 'unaligned') events = [event(END + 1)];
    if (kind === 'zero-price' || kind === 'negative-price') events = [{ ...future, referencePrice: new BacktestDecimal(kind === 'zero-price' ? '0' : '-1') }];
    let authoritative = source(events);
    if (kind === 'nonfinite-rate') authoritative = { ...authoritative, events: [{ ...future, fundingRate: 'NaN' as unknown as BacktestDecimal }] };
    if (kind === 'bad-hash') authoritative = { ...authoritative, contentSha256: '0'.repeat(64) };
    if (kind === 'bad-source') authoritative = { ...authoritative, sourceId: '' };
    if (kind === 'bad-fidelity') authoritative = { ...authoritative, fidelity: 'UNKNOWN' as BacktestFundingSchedule['fidelity'] };
    expect(() => deriveBacktestFundingScheduleForWindow(authoritative, START, END)).toThrow();
  });

  it.each(['BUY', 'SELL', 'FLAT'] as const)('applies ordered exact signed funding once for %s exposure, including zero rate', async (side) => {
    const times = [START + MINUTE, START + 2 * MINUTE, END];
    const result = await replay(source([event(times[0]!, '0.01'), event(times[1]!, '-0.005'), event(times[2]!, '0')]), side);
    const applied = result.events.filter((item) => item.type === 'FUNDING_APPLIED');
    expect(applied.map((item) => item.eventTimeMs)).toEqual(times);
    expect(result.result.financialSummary.fundingPnl.value).toBe(side === 'BUY' ? '-0.5' : side === 'SELL' ? '0.5' : '0');
    expect(result.participant.contexts[0]?.accountEquity.fundingPnl.value).toBe('0');
    expect(result.participant.contexts.find((context) => context.simulationTimeMs === times[0])?.accountEquity.fundingPnl.value).toBe(side === 'BUY' ? '-1' : side === 'SELL' ? '1' : '0');
  });

  it('charges no funding after exposure closes', async () => {
    const result = await replay(source([event(START + 2 * MINUTE)]), 'BUY', true);
    expect(result.result.financialSummary.fundingPnl.value).toBe('0');
    expect(result.events.find((item) => item.type === 'FUNDING_APPLIED')?.payload.positionSide).toBe('FLAT');
  });

  it('binds a 1e-18 in-window rate delta but excludes future rate changes from earlier run identity and account state', async () => {
    const baseline = source([event(START + MINUTE), event(END + MINUTE)]);
    const inside = source([event(START + MINUTE, '0.010000000000000001'), event(END + MINUTE)]);
    const outside = source([event(START + MINUTE), event(END + MINUTE, '0.010000000000000001')]);
    const a = await replay(baseline); const b = await replay(inside); const c = await replay(outside);
    expect(b.result.financialSummary.fundingPnl.value).toBe('-1.0000000000000001');
    expect(a.result.financialSummary.fundingPnl.value).toBe('-1');
    expect(b.result.runId).not.toBe(a.result.runId);
    expect(b.result.resultSha256).not.toBe(a.result.resultSha256);
    expect(c.result).toEqual(a.result);
    expect(c.events).toEqual(a.events);
    expect(c.participant.contexts).toEqual(a.participant.contexts);
    expect(outside.contentSha256).not.toBe(baseline.contentSha256);
    expect(c.schedule.contentSha256).toBe(a.schedule.contentSha256);
  });

  it('preserves empty schedules and rejects an unsliced source at the direct Phase9 boundary', async () => {
    expect((await replay(source([]))).result.financialSummary.fundingPnl.value).toBe('0');
    expect(() => new BacktestEngine(config([candle(0), candle(1)], new ScriptedParticipant(), { fundingSchedule: source([event(END + MINUTE)]) }))).toThrow();
  });

  it('preserves decimal representation and UTC/restart identity through serialized authoritative evidence', async () => {
    const authoritative = source([event(START + MINUTE, '0.000000000000000001'), event(END + MINUTE)]);
    const serialized = JSON.parse(JSON.stringify(authoritative)) as { sourceId: string; contentSha256: string; fidelity: BacktestFundingSchedule['fidelity']; events: { fundingTimeMs: number; fundingRate: string; referencePrice: string }[] };
    const restored = { ...serialized, events: serialized.events.map((item) => ({ ...item, fundingRate: new BacktestDecimal(item.fundingRate), referencePrice: new BacktestDecimal(item.referencePrice) })) };
    const previous = process.env.TZ;
    try {
      const outputs: string[] = [];
      for (const zone of ['UTC', 'Asia/Kolkata', 'America/New_York']) {
        process.env.TZ = zone;
        const run = await replay(restored);
        outputs.push(canonicalJson({ result: run.result, events: run.events }));
        expect(run.schedule.events[0]?.fundingRate.value).toBe('0.000000000000000001');
      }
      expect(new Set(outputs).size).toBe(1);
      expect(restored).toEqual(authoritative);
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
});
