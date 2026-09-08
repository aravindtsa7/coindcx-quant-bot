import { describe, expect, it } from 'vitest';
import { BacktestEngine, InMemoryBacktestSink, canonicalJson } from '../../../src/backtest';
import { createCanonicalCandle1m } from '../../../src/market-data/models';
import { canonicalHashDecimal } from '../../../src/market-data/historical';
import { canonicalFixedPointIdentity } from '../../../src/market-data/fixed-point-identity';
import { candle, config, ScriptedParticipant } from './helpers';

const fields = ['open', 'high', 'low', 'close', 'volume', 'quoteVolume'] as const;
function rows(suffix = '', changedField?: typeof fields[number], largeVolume = false) {
  return Array.from({ length: 6 }, (_, index) => {
    const values = { open: '100', high: '110', low: '90', close: '100', volume: largeVolume ? '999999999999999999' : '100', quoteVolume: '100' };
    for (const field of fields) values[field] += index === 2 && field === changedField ? '.000000000000000001' : suffix;
    return createCanonicalCandle1m({ ...candle(index), ...values });
  });
}
async function run(evidence: ReturnType<typeof rows>) {
  const sink = new InMemoryBacktestSink();
  const participant = new ScriptedParticipant([
    { submitOrders: [{ pair: evidence[0]!.pair, type: 'MARKET', side: 'BUY', quantity: '1' }] },
    { submitOrders: [{ pair: evidence[0]!.pair, type: 'MARKET', side: 'SELL', quantity: '1', reduceOnly: true }] },
  ]);
  const result = await new BacktestEngine(config(evidence, participant, { configuredTimeframes: [2, 3] }), sink).run();
  if (result.terminalStatus !== 'COMPLETED') throw new Error(result.terminalError);
  return { result, events: sink.events };
}

describe('Audit B1 canonical replay financial identity', () => {
  it('gives 100, 100.0 and 100.000000000000000000 identical datasets, runs, 1m/HTF events and results', async () => {
    const baseline = await run(rows());
    expect(baseline.result.totalFills).toBe(2);
    for (const suffix of ['.0', '.000000000000000000']) {
      const equivalent = await run(rows(suffix));
      expect(equivalent.result.datasetId).toBe(baseline.result.datasetId);
      expect(equivalent.result.runId).toBe(baseline.result.runId);
      expect(equivalent.events).toEqual(baseline.events);
      expect(equivalent.result.eventLedgerSha256).toBe(baseline.result.eventLedgerSha256);
      expect(equivalent.result.resultSha256).toBe(baseline.result.resultSha256);
      expect(canonicalJson(equivalent.result)).toBe(canonicalJson(baseline.result));
    }
  });

  it.each(fields)('a 1e-18 material change in %s changes dataset, run, event payload and result identity', async (field) => {
    const baseline = await run(rows());
    const changed = await run(rows('', field));
    expect(changed.result.datasetId).not.toBe(baseline.result.datasetId);
    expect(changed.result.runId).not.toBe(baseline.result.runId);
    expect(changed.result.eventLedgerSha256).not.toBe(baseline.result.eventLedgerSha256);
    expect(changed.result.resultSha256).not.toBe(baseline.result.resultSha256);
    // Compare payloads independently of the changed runId envelope.
    const canonicalEvents = (events: typeof changed.events) => events.filter((event) => event.type === 'CANDLE_CLOSED' && event.payload.timeframeMinutes === 1);
    expect(canonicalEvents(changed.events)[2]?.payload[field]).not.toBe(canonicalEvents(baseline.events)[2]?.payload[field]);
  });

  it('normalizes HTF aggregate volumes exceeding the canonical 1m precision bound without narrowing them', async () => {
    const baseline = await run(rows('', undefined, true));
    const equivalent = await run(rows('.000000000000000000', undefined, true));
    expect(equivalent.events).toEqual(baseline.events);
    expect(equivalent.result.resultSha256).toBe(baseline.result.resultSha256);
    expect(baseline.events.some((event) => event.type === 'CANDLE_CLOSED' && event.payload.volume === '2999999999999999997')).toBe(true);
  });

  it('shares Phase7 zero and trailing-zero semantics, retaining fixed-point validation', () => {
    for (const value of ['0', '-0', '-0.000', '000100.000', '0.000000000000000001', '999999999999999999.999999999999999999']) {
      expect(canonicalFixedPointIdentity(value)).toBe(canonicalHashDecimal(value));
    }
    expect(canonicalFixedPointIdentity('-0.000')).toBe('0');
    expect(() => canonicalFixedPointIdentity('1e-18')).toThrow();
    expect(() => canonicalHashDecimal('1000000000000000000')).toThrow();
  });

  it('retains identical replay bytes under UTC, Asia/Kolkata and America/New_York', async () => {
    const previous = process.env.TZ;
    try {
      const outputs: string[] = [];
      for (const zone of ['UTC', 'Asia/Kolkata', 'America/New_York']) {
        process.env.TZ = zone;
        outputs.push(canonicalJson(await run(rows('.000000000000000000'))));
      }
      expect(new Set(outputs).size).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
