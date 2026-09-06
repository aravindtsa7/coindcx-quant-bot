import { describe, expect, it } from 'vitest';
import {
  BacktestDecimal,
  BacktestEngine,
  InMemoryBacktestSink,
  sha256CanonicalJson,
  type BacktestEvent,
  type BacktestEventSink,
} from '../../../src/backtest';
import { BASE, candle, config, ScriptedParticipant } from './helpers';

describe('Phase 9 immutable boundaries and fail-closed sink', () => {
  it('defensively copies funding arrays and cost configuration at construction', async () => {
    const fundingEvents = [{ fundingTimeMs: BASE + 120_000, fundingRate: new BacktestDecimal('0.01'), referencePrice: new BacktestDecimal('100') }];
    const costModel = { ...config([candle(0), candle(1)]).costModel };
    const engine = new BacktestEngine(config([candle(0), candle(1)], new ScriptedParticipant([{ submitOrders: [{ pair: 'B-BTC_INR', type: 'MARKET', side: 'BUY', quantity: '1' }] }]), {
      costModel,
      fundingSchedule: { sourceId: 'immutable', contentSha256: sha256CanonicalJson(fundingEvents), fidelity: 'TEST_ONLY', events: fundingEvents },
    }));
    fundingEvents.length = 0;
    (costModel as { takerFeeRate: BacktestDecimal }).takerFeeRate = new BacktestDecimal('0.9');
    const result = await engine.run();
    expect(result.terminalStatus).toBe('COMPLETED');
    if (result.terminalStatus !== 'COMPLETED') throw new Error(result.terminalError);
    expect(result.financialSummary.fundingPnl.value).toBe('-1');
    expect(result.financialSummary.takerFees.value).toBe('0.2006');
    expect(Object.isFrozen(engine.manifest)).toBe(true);
    expect(Object.isFrozen(engine.manifest.costModel)).toBe(true);
  });

  it('does not expose mutable maps, order state, or account state to evaluation', async () => {
    let mapMutationPossible = false;
    const participant = {
      onEvaluation(context: Parameters<ScriptedParticipant['onEvaluation']>[0]) {
        mapMutationPossible = typeof (context.latestClosedCandleByTimeframe as unknown as { set?: unknown }).set === 'function';
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.openOrders)).toBe(true);
        expect(() => { (context.currentPosition as { side: string }).side = 'SHORT'; }).toThrow();
        return {};
      },
    };
    await new BacktestEngine(config([candle(0), candle(1)], participant)).run();
    expect(mapMutationPossible).toBe(false);
  });

  it('emits deeply immutable event copies whose later mutation cannot change the ledger hash', async () => {
    const sink = new InMemoryBacktestSink();
    const outcome = await new BacktestEngine(config([candle(0), candle(1)]), sink).run();
    expect(outcome.terminalStatus).toBe('COMPLETED');
    const event = sink.events[0]!;
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(() => { (event.payload as Record<string, unknown>).datasetId = 'mutated'; }).toThrow();
  });

  it('halts with FAILED and publishes no completed hashes when the sink fails', async () => {
    let writes = 0;
    const sink: BacktestEventSink = {
      write(_event: BacktestEvent) {
        writes++;
        if (writes === 3) throw new Error('storage unavailable');
      },
    };
    const outcome = await new BacktestEngine(config([candle(0), candle(1)]), sink).run();
    expect(outcome).toMatchObject({ terminalStatus: 'FAILED', isValid: false, errorCode: 'BACKTEST_RUN_FAILED' });
    expect('eventLedgerSha256' in outcome).toBe(false);
    expect('resultSha256' in outcome).toBe(false);
  });

  it('exposes terminal COMPLETED and FAILED lifecycle states', async () => {
    const complete = new BacktestEngine(config([candle(0), candle(1)]));
    expect(complete.state).toBe('CREATED');
    await complete.run();
    expect(complete.state).toBe('COMPLETED');

    const failed = new BacktestEngine(config([candle(0), candle(1)]), { write() { throw new Error('fail'); } });
    await failed.run();
    expect(failed.state).toBe('FAILED');
  });
});
