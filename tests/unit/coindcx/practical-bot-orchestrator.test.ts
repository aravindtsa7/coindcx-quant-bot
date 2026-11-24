import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mapInstrumentToMetadata } from '../../../src/coin-runtime';
import { parseBotArguments } from '../../../scripts/run-coindcx-bot';
import { readBotShadowCapital } from '../../../scripts/coindcx-bot-shadow-state';
import { Decimal } from '../../../src/core/decimal/decimal';
import { CoinDcxProviderError } from '../../../src/core/errors/app-error';
import { providerAccountFingerprint } from '../../../src/execution/live/reconciliation/account-identity';
import { CoinDcxClient } from '../../../src/integration/coindcx/client';
import { FakeClock } from '../../../src/integration/coindcx/clock';
import { PracticalBotOrchestrator, type PracticalBotOptions, type PracticalBotCandleQuery, type PracticalBotExecutionRequest } from '../../../src/integration/coindcx/live/practical-bot-orchestrator';
import { BOT_RISK_SOURCES, createBotRiskPolicy, createBotInteriorLeverageSnapshot, readBotSettlementConversion, type PracticalBotRiskState } from '../../../src/integration/coindcx/live/practical-bot-evaluation';
import { createBotShadowRiskState } from '../../../src/integration/coindcx/live/practical-bot-shadow-risk';
import { evaluateRisk, evidenceContentSha256, sha256CanonicalJson, type RiskEvaluationContext } from '../../../src/risk';
import { LosslessNumber } from 'lossless-json';
import { makeAccount, makeExposure, makePair, makeTiers, makeSettlement, makeEntry, seal } from '../risk/helpers';
import type { InrFuturesOrder, InrFuturesPosition } from '../../../src/integration/coindcx/models';
import { CoinDcxPrivateAccountStream } from '../../../src/integration/coindcx/websocket/private-stream';
import { instrument, profile } from './audit-a2-helpers';

afterEach(() => { vi.restoreAllMocks(); });

function removeShadowTestDirectory(directory: string): void {
  const resolved = fs.realpathSync(directory);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !/^coindcx-bot-shadow-/.test(path.basename(resolved))) throw new Error('TEST_CLEANUP_PATH_REFUSED');
  fs.rmSync(resolved, { recursive: true });
}

function setup(overrides: Partial<PracticalBotOptions> = {}) {
  const client = Object.assign(new CoinDcxClient(), { getCandles: vi.fn(async (_query: PracticalBotCandleQuery) => [{
    pair: 'B-BTC_USDT', openTimeMs: Math.floor(Date.now() / 60_000) * 60_000 - 60_000,
    open: new Decimal('100'), high: new Decimal('101'), low: new Decimal('99'), close: new Decimal('100.125'),
    volume: new Decimal('5'), quoteVolume: null,
  }]) });
  const discoveredInstrument = (coin: string) => ({
    ...instrument(coin), unitContractValue: new Decimal('0.001'), priceIncrement: new Decimal(1), quantityIncrement: new Decimal(1),
    minQuantity: new Decimal(1), maxQuantity: new Decimal(10000), minTradeSize: new Decimal(1), minNotional: new Decimal(1),
    dynamicPositionLeverageTiers: [{ leverage: new Decimal('20'), maxPositionSizeUsdt: new Decimal('5000') }],
  });
  const discovery = vi.spyOn(client, 'findActiveInrPerpetualByUnderlying').mockImplementation(async coin => discoveredInstrument(coin));
  const refresh = vi.spyOn(client, 'getInrFuturesInstrument').mockImplementation(async pair => discoveredInstrument(pair.slice(2).split('_')[0]!));
  const identity = vi.spyOn(client, 'getUserInfoSafe').mockResolvedValue({ authenticated: true, coindcxId: 'PRIVATE_ACCOUNT_ID' });
  const orders = vi.spyOn(client, 'listInrFuturesOrders').mockResolvedValue([]);
  const positions = vi.spyOn(client, 'listInrFuturesPositions').mockResolvedValue([]);
  const wallet = vi.spyOn(client, 'getInrFuturesWallet').mockResolvedValue({ id: 'PRIVATE_WALLET_ID', currency: 'INR',
    lockedInitialMargin: new Decimal(0), legacyBalanceIgnored: new Decimal('999999999'), crossOrderMargin: null, crossUserMargin: null });
  const start = vi.spyOn(CoinDcxPrivateAccountStream.prototype, 'start').mockResolvedValue();
  const stop = vi.spyOn(CoinDcxPrivateAccountStream.prototype, 'stop');
  const execute = vi.fn<(request: PracticalBotExecutionRequest) => Promise<import('../../../src/integration/coindcx/live/practical-bot-orchestrator').PracticalBotExecutionResult>>(
    async () => ({ status: 'REFUSED', ordersSubmitted: 0, reasonCode: 'TEST_REFUSAL' }));
  const gateway = vi.fn(() => ({ execute }));
  const options: PracticalBotOptions = { client, profiles: [profile('BTC'), profile('ETH'), profile('SOL')],
    coins: ['BTC'], intervalMs: 0, createLiveExecutor: gateway,
    readSettlementConversion: async () => {
      const now = overrides.clock?.nowMs() ?? Date.now();
      return readBotSettlementConversion([{ symbol: 'USDTINR', margin_currency_short_name: 'INR', target_currency_short_name: 'USDT',
        conversion_price: '90', last_updated_at: now - 1000 }], now);
    }, ...overrides };
  return { client, discovery, refresh, identity, orders, positions, wallet, start, stop, gateway, execute, options };
}

describe('practical bot safety and observation', () => {
  function candles(pair: string, direction: 'UP' | 'DOWN' | 'FLAT' = 'UP', count = 60) {
    const start = Math.floor(Date.now() / 60_000) * 60_000 - count * 60_000;
    return Array.from({ length: count }, (_, index) => {
      const price = new Decimal(direction === 'UP' ? 100 + index : direction === 'DOWN' ? 200 - index : 100);
      return { pair, openTimeMs: start + index * 60_000, open: price, high: price.plus(1), low: price.minus(1), close: price,
        volume: new Decimal(1), quoteVolume: null };
    });
  }

  function authoritativeState(request: Parameters<NonNullable<PracticalBotOptions['readRiskState']>>[0]): PracticalBotRiskState {
    const now = request.evaluationTimeMs;
    const retime = <T extends { provenance: { sourceId: string; sourceTimeMs: number | null; observedAtMs: number; contentSha256: string } }>(value: T, sourceId: string): T =>
      seal({ ...value, provenance: { ...value.provenance, sourceId, sourceTimeMs: now, observedAtMs: now } });
    const accountId = request.accountFingerprint!;
    const pair = makePair();
    return {
      accountSnapshot: retime({ ...makeAccount(), accountId }, BOT_RISK_SOURCES.accountRiskSourceId),
      exposureSnapshot: retime({ ...makeExposure(), accountId }, BOT_RISK_SOURCES.exposureSourceId),
      pairSnapshot: retime({ ...pair, maxNotional: null, pair: request.pair, instrumentSpecSnapshotId: request.instrumentSpecSnapshotId,
        ownership: { status: 'RECONCILED', positionState: 'FLAT', accountId, pair: request.pair, positionId: null, instanceOwnership: [] } }, BOT_RISK_SOURCES.pairRiskSourceId),
      leverageTierSnapshot: retime({ ...makeTiers(), pair: request.pair }, BOT_RISK_SOURCES.leverageTierSourceId),
      settlementRateSnapshot: retime(makeSettlement(), BOT_RISK_SOURCES.conversionSourceId),
      entryStopProposal: retime({ ...makeEntry(request.strategyDecision), stopPriceUsdt: request.strategyDecision.targetExposure === 'SHORT' ? '110' : '90' }, BOT_RISK_SOURCES.pairRiskSourceId),
    };
  }

  it.each([['ema-trend', 'UP', 'LONG'], ['ema-trend', 'DOWN', 'SHORT'], ['ema-trend', 'FLAT', 'FLAT'], ['rsi-momentum', 'UP', 'LONG']] as const)(
    'evaluates canonical %s indicators over %s candles to %s without sending orders', async (strategy, direction, signal) => {
      const s = setup({ strategy, apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET' });
      s.client.getCandles.mockImplementation(async query => candles(query.pair, direction));
      const report = await new PracticalBotOrchestrator(s.options).run();
      const summary = report.cycles[0]?.pairSummaries[0];
      expect(summary?.signal).toBe(signal);
      expect(summary?.strategyDecision?.status).toBe('READY');
      expect(summary?.riskDecision).not.toBeNull();
      expect(summary?.riskDecision?.action).toBe(signal === 'FLAT' ? 'NO_CHANGE' : 'OPEN');
      expect(summary?.riskDecision?.status).toBe('REJECTED');
      expect(summary?.riskReasonCodes.length).toBeGreaterThan(0);
      expect(report.ordersSubmitted).toBe(0);
      expect(s.execute).not.toHaveBeenCalled();
    });

  it('records the exact M7 decision and preserves its INR policy cap', async () => {
    let context: RiskEvaluationContext | undefined;
    const s = setup({ apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET', mode: 'TINY_LIVE', confirmLive: true,
      readRiskState: async request => authoritativeState(request) });
    s.client.getCandles.mockImplementation(async query => candles(query.pair));
    s.execute.mockImplementation(async request => { context = request.context; return { status: 'REFUSED', ordersSubmitted: 0, reasonCode: 'TEST_REFUSAL' }; });
    const report = await new PracticalBotOrchestrator(s.options).run();
    const decision = report.cycles[0]?.pairSummaries[0]?.riskDecision;
    expect(decision).toMatchObject({ status: 'ACCEPTED', action: 'OPEN' });
    expect(context).toBeDefined();
    expect(decision).toEqual(evaluateRisk(createBotRiskPolicy('B-BTC_USDT', '500'), context!));
    if (decision?.status !== 'ACCEPTED') throw new Error('EXPECTED_ACCEPTED_DECISION');
    expect(new Decimal(decision.approved.approvedNotionalInr).lte(500)).toBe(true);
  });

  it('blocks a confirmed tiny live run when REST observations do not converge', async () => {
    const s = setup({ mode: 'TINY_LIVE', confirmLive: true, apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET',
      readRiskState: async request => authoritativeState(request) });
    s.orders.mockRejectedValue(new Error('incomplete'));
    s.client.getCandles.mockImplementation(async query => candles(query.pair));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.account.status).toBe('UNRESOLVED');
    expect(report.gatewayConstructed).toBe(false);
    expect(s.gateway).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
    expect(report.ordersSubmitted).toBe(0);
  });

  it('records M7 approval in shadow without constructing an exchange executor', async () => {
    const s = setup({ apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET', readRiskState: async request => authoritativeState(request) });
    s.client.getCandles.mockImplementation(async query => candles(query.pair));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.cycles[0]?.pairSummaries[0]?.riskDecision).toMatchObject({ status: 'ACCEPTED', action: 'OPEN' });
    expect(s.gateway).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
    expect(report.ordersSubmitted).toBe(0);
  });

  it('accepts all three pairs with operator-funded durable shadow capital despite long inter-pair waits', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coindcx-bot-shadow-'));
    const clock = new FakeClock(Date.now());
    const s = setup({ clock, equityInr: '5000', mode: 'SHADOW', coins: ['BTC', 'ETH', 'SOL'], apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET',
      readRiskState: async request => {
        const capital = readBotShadowCapital(directory, request.accountFingerprint!, '5000', clock.nowMs());
        return createBotShadowRiskState({ capital, instrument: request.instrument, instrumentObservedAtMs: request.instrumentObservedAtMs,
          evaluationTimeMs: clock.nowMs(), settlement: request.settlementRateSnapshot, positions: request.positions, allowOfflineFlat: false });
      } });
    s.client.getCandles.mockImplementation(async query => { clock.advance(61_000); return candles(query.pair, query.pair.includes('ETH') ? 'DOWN' : 'UP'); });
    try {
      const report = await new PracticalBotOrchestrator(s.options).run();
      expect(report.status).toBe('COMPLETED');
      expect(report.cycles[0]!.pairSummaries.map(row => row.pair)).toEqual(['B-BTC_USDT', 'B-ETH_USDT', 'B-SOL_USDT']);
      for (const summary of report.cycles[0]!.pairSummaries) {
        expect(summary.riskDecision).toMatchObject({ status: 'ACCEPTED', action: 'OPEN' });
        expect(summary.riskDecision!.auditTrail).toHaveLength(13);
        expect(summary.riskDecision!.auditTrail.every(step => step.outcome === 'PASS')).toBe(true);
        expect(new Decimal(summary.sizing!.targetQuantity).gt(0)).toBe(true);
        expect(new Decimal(summary.sizing!.targetNotionalInr).gt(0)).toBe(true);
        expect(new Decimal(summary.sizing!.targetNotionalInr).lte('500')).toBe(true);
        expect(summary.sizing!.finalLeverage).toBe('1');
        expect(summary.riskEvidence).toMatchObject({ scope: 'OPERATOR_SHADOW', equityInr: '5000', availableMarginInr: '5000', pendingReservationCount: 0 });
      }
      expect(s.refresh).toHaveBeenCalledTimes(3);
      expect(report.ordersSubmitted).toBe(0);
      expect(s.gateway).not.toHaveBeenCalled();
      expect(s.execute).not.toHaveBeenCalled();
    } finally { removeShadowTestDirectory(directory); }
  });

  it('refuses operator shadow capital as tiny-live risk authority', async () => {
    const s = setup({ mode: 'TINY_LIVE', confirmLive: true, equityInr: '5000', apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET',
      readRiskState: async request => ({ ...authoritativeState(request), scope: 'OPERATOR_SHADOW' }) });
    s.client.getCandles.mockImplementation(async query => candles(query.pair));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.cycles[0]!.pairSummaries[0]!.riskDecision).toBeNull();
    expect(report.ordersSubmitted).toBe(0);
    expect(s.execute).not.toHaveBeenCalled();
  });

  it('retains exchange minimum-notional rejection with a fully populated operator shadow account', async () => {
    const s = setup({ equityInr: '5000', apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET', readRiskState: async request => {
      const state = authoritativeState(request);
      return { accountSnapshot: state.accountSnapshot, exposureSnapshot: state.exposureSnapshot, settlementRateSnapshot: state.settlementRateSnapshot,
        leverageTierSnapshot: state.leverageTierSnapshot! };
    } });
    s.refresh.mockImplementation(async pair => ({ ...(await s.client.findActiveInrPerpetualByUnderlying(pair.slice(2).split('_')[0]!))!, minNotional: new Decimal('60') }));
    s.client.getCandles.mockImplementation(async query => candles(query.pair));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.cycles[0]!.pairSummaries[0]!.riskReasonCodes).toContain('MIN_NOTIONAL_NOT_MET');
    expect(report.cycles[0]!.pairSummaries[0]!.sizing).toBeNull();
    expect(report.ordersSubmitted).toBe(0);
  });

  it.each(['UP', 'DOWN'] as const)('sizes a %s shadow signal using the closed candle stop and reconciled flat ownership', async direction => {
    const s = setup({ apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET', readRiskState: async request => {
      const state = authoritativeState(request);
      // Exercise production derivation of pair/ownership and proposal rather than supplying test versions of them.
      return { accountSnapshot: state.accountSnapshot, exposureSnapshot: state.exposureSnapshot,
        leverageTierSnapshot: state.leverageTierSnapshot!, settlementRateSnapshot: state.settlementRateSnapshot };
    } });
    s.client.getCandles.mockImplementation(async query => candles(query.pair, direction));
    const report = await new PracticalBotOrchestrator(s.options).run();
    const summary = report.cycles[0]!.pairSummaries[0]!;
    const decision = summary.riskDecision;
    expect(decision).toMatchObject({ status: 'ACCEPTED', action: 'OPEN' });
    if (decision?.status !== 'ACCEPTED' || decision.action !== 'OPEN') throw new Error('EXPECTED_ACCEPTED_OPEN');
    expect(decision.auditTrail).toHaveLength(13);
    expect(decision.auditTrail.every(step => step.outcome === 'PASS')).toBe(true);
    expect(new Decimal(decision.approved.approvedQuantity).gt(0)).toBe(true);
    expect(new Decimal(decision.approved.approvedNotionalInr).gt(0)).toBe(true);
    expect(new Decimal(decision.approved.approvedNotionalInr).lte(500)).toBe(true);
    expect(decision.approved.approvedLeverage).toBe('1');
    expect(decision.capsApplied.finalLeverage).toEqual({ status: 'RESOLVED', value: '1' });
    expect(summary.riskEvidence?.ownershipStatus).toBe('RECONCILED');
    const proposal = summary.riskEvidence!.entryStopProposal!;
    expect(proposal.entryPriceUsdt).toBe(direction === 'UP' ? '159' : '141');
    expect(proposal.stopPriceUsdt).toBe(direction === 'UP' ? '157' : '143');
    expect(proposal.provenance.contentSha256).toBe(evidenceContentSha256(proposal));
    expect(report.ordersSubmitted).toBe(0);
    expect(s.gateway).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
  });

  it('reads wallet each cycle without promoting the ignored balance into account equity or fabricating pending reservations', async () => {
    const s = setup({ cycles: 2, apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET' });
    s.client.getCandles.mockImplementation(async query => candles(query.pair));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(s.wallet).toHaveBeenCalledTimes(2);
    expect(report.cycles[0]?.wallet).toMatchObject({ status: 'OBSERVED', accountRiskSnapshotAvailable: false,
      reasonCode: 'ACCOUNT_EQUITY_AND_HISTORY_NOT_EXPOSED' });
    const summary = report.cycles[0]!.pairSummaries[0]!;
    expect(summary.riskReasonCodes).toContain('ACCOUNT_STATE_UNAVAILABLE');
    expect(summary.riskReasonCodes).toContain('PENDING_EXPOSURE_UNKNOWN');
    expect(summary.riskReasonCodes).not.toContain('EXPOSURE_STATE_UNAVAILABLE');
    expect(summary.riskReasonCodes).not.toContain('SETTLEMENT_RATE_UNAVAILABLE');
    expect(summary.riskReasonCodes).not.toContain('INVALID_ENTRY_PRICE');
    expect(summary.riskReasonCodes).not.toContain('POSITION_OWNERSHIP_UNRECONCILED');
    expect(summary.riskEvidence).toMatchObject({ accountSnapshotAvailable: false, exposureSnapshotAvailable: true,
      pendingState: 'UNKNOWN', tierSemanticsStatus: 'SEMANTICS_UNVERIFIED' });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_WALLET_ID|999999999|PRIVATE_KEY|PRIVATE_SECRET|PRIVATE_ACCOUNT_ID/);
    expect(report.ordersSubmitted).toBe(0);
  });

  it('fails closed on conversion and wallet errors without reflecting provider messages', async () => {
    const s = setup({ apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET', readSettlementConversion: async () => { throw new Error('PRIVATE_SECRET'); } });
    s.wallet.mockRejectedValue(new Error('PRIVATE_ACCOUNT_ID'));
    s.client.getCandles.mockImplementation(async query => candles(query.pair));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.cycles[0]?.wallet.reasonCode).toBe('INR_WALLET_READ_FAILED');
    expect(report.cycles[0]?.settlementReadError).toBe('SETTLEMENT_CONVERSION_READ_FAILED');
    expect(report.cycles[0]?.pairSummaries[0]?.riskReasonCodes).toContain('SETTLEMENT_RATE_UNAVAILABLE');
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_SECRET|PRIVATE_ACCOUNT_ID/);
    expect(s.execute).not.toHaveBeenCalled();
  });

  it('evaluates after an awaited projection read without making stale evidence fresh', async () => {
    const clock = new FakeClock(Date.now());
    const s = setup({ clock, apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET', readRiskState: async request => {
      const state = authoritativeState(request);
      clock.advance(11_000);
      return state;
    } });
    s.client.getCandles.mockImplementation(async query => candles(query.pair));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.cycles[0]?.pairSummaries[0]?.riskReasonCodes).toContain('ACCOUNT_STATE_STALE');
    expect(s.execute).not.toHaveBeenCalled();
  });

  it('refetches aged metadata before fetching the entry candle, preserving the actual fetch timestamp', async () => {
    const clock = new FakeClock(Date.now());
    const s = setup({ clock, apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET', readSettlementConversion: async () => {
      clock.advance(61_000); // Account pagination or the limiter can outlive the discovery freshness window.
      return readBotSettlementConversion([{ symbol: 'USDTINR', margin_currency_short_name: 'INR', target_currency_short_name: 'USDT',
        conversion_price: '90', last_updated_at: clock.nowMs() - 1000 }], clock.nowMs());
    } });
    const fresh = (await s.client.findActiveInrPerpetualByUnderlying('BTC'))!;
    const refresh = vi.spyOn(s.client, 'getInrFuturesInstrument').mockImplementation(async () => { clock.advance(20_000); return fresh; });
    s.client.getCandles.mockImplementation(async query => candles(query.pair));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(s.client.getCandles.mock.invocationCallOrder[0]!);
    const reasons = report.cycles[0]!.pairSummaries[0]!.riskReasonCodes;
    expect(reasons).not.toContain('LEVERAGE_TIERS_STALE');
    expect(reasons).not.toContain('INVALID_ENTRY_PRICE');
    expect(reasons).toContain('EXPOSURE_STATE_STALE'); // Old account evidence was not re-stamped.
    expect(report.ordersSubmitted).toBe(0);
  });

  it('refuses a risk projection that changes the discovered contract multiplier', async () => {
    const s = setup({ apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET', readRiskState: async request => {
      const state = authoritativeState(request);
      return { ...state, pairSnapshot: seal({ ...state.pairSnapshot!, contractMultiplier: '999' }) };
    } });
    s.client.getCandles.mockImplementation(async query => candles(query.pair));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.cycles[0]?.pairSummaries[0]?.riskReasonCodes).toEqual(['INSTRUMENT_SPEC_MISMATCH']);
    expect(s.execute).not.toHaveBeenCalled();
  });

  it('never dispatches an M7-rejected decision in tiny live', async () => {
    const s = setup({ mode: 'TINY_LIVE', confirmLive: true, apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET' });
    s.client.getCandles.mockImplementation(async query => candles(query.pair));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.cycles[0]?.pairSummaries[0]?.riskDecision?.status).toBe('REJECTED');
    expect(s.execute).not.toHaveBeenCalled();
  });

  it('halts all further dispatch after an ambiguous live result', async () => {
    const s = setup({ mode: 'TINY_LIVE', confirmLive: true, apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET', coins: ['BTC', 'ETH'],
      readRiskState: async request => authoritativeState(request) });
    s.client.getCandles.mockImplementation(async query => candles(query.pair));
    s.execute.mockResolvedValue({ status: 'AMBIGUOUS', ordersSubmitted: 1, reasonCode: 'EXECUTION_OUTCOME_UNESTABLISHED' });
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(s.execute).toHaveBeenCalledOnce();
    expect(report.ordersSubmitted).toBe(1);
    expect(report.status).toBe('DEGRADED');
    expect(report.cycles[0]?.pairSummaries[1]?.execution.status).toBe('BLOCKED');
  });

  it('does not replay strategy candles or dispatch a decision twice over overlapping cycles', async () => {
    const s = setup({ cycles: 2, apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET' });
    s.client.getCandles.mockImplementation(async query => candles(query.pair));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.cycles[0]?.pairSummaries[0]?.strategyDecision).toEqual(report.cycles[1]?.pairSummaries[0]?.strategyDecision);
    expect(s.execute).not.toHaveBeenCalled();
  });

  it('uses the injected clock for the closed 60-minute candle window', async () => {
    const clock = new FakeClock(1_700_000_123_456);
    const s = setup({ clock, mode: 'DRY_RUN' });
    const report = await new PracticalBotOrchestrator(s.options).run();
    const minute = Math.floor(clock.nowMs() / 60_000) * 60_000;
    expect(s.client.getCandles).toHaveBeenCalledWith({ pair: 'B-BTC_USDT', from: minute - 3_600_000, to: minute - 1, resolution: '1' });
    expect(report.cycles[0]).toMatchObject({ from: minute - 3_600_000, to: minute - 1 });
  });

  it('reports the failing private endpoint and HTTP status without guessing a cause or exposing error data', async () => {
    const s = setup({ apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET' });
    s.identity.mockRejectedValue(new CoinDcxProviderError('PRIVATE_SECRET', 422, { path: '/exchange/v1/users/info', rawBody: 'PRIVATE_ACCOUNT_ID' }));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.account.error).toBe('USER_INFO_HTTP_422');
    expect(report.account.status).toBe('UNRESOLVED');
    expect(s.orders).not.toHaveBeenCalled();
    expect(s.positions).not.toHaveBeenCalled();
    expect(s.start).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_KEY|PRIVATE_SECRET|PRIVATE_ACCOUNT_ID/);
  });

  it('defaults to shadow and skips private reads without credentials', async () => {
    const s = setup();
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report).toMatchObject({ mode: 'SHADOW', status: 'COMPLETED', maxInr: '500', gatewayConstructed: false, ordersSubmitted: 0 });
    expect(report.account.status).toBe('SKIPPED_NO_CREDENTIALS');
    expect(report.cycles[0]?.markets[0]).toMatchObject({ latestClose: '100.125', candleCount: 1, maxLeverage: '20' });
    expect(s.client.getCandles).toHaveBeenCalledWith(expect.objectContaining({ resolution: '1', pair: 'B-BTC_USDT' }));
    expect(s.identity).not.toHaveBeenCalled();
    expect(s.start).not.toHaveBeenCalled();
    expect(s.gateway).not.toHaveBeenCalled();
  });

  it('refuses tiny live without the explicit confirmation before any I/O', () => {
    const s = setup({ mode: 'TINY_LIVE' });
    expect(() => new PracticalBotOrchestrator(s.options)).toThrow('TINY_LIVE_REQUIRES_EXPLICIT_CONFIRM_FLAG');
    expect(s.discovery).not.toHaveBeenCalled();
    expect(s.gateway).not.toHaveBeenCalled();
  });

  it('dry run never reads private accounts or constructs a gateway even with credentials and confirmation', async () => {
    const s = setup({ mode: 'DRY_RUN', confirmLive: true, apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET' });
    expect((await new PracticalBotOrchestrator(s.options).run()).account.status).toBe('SKIPPED_DRY_RUN');
    expect(s.identity).not.toHaveBeenCalled();
    expect(s.orders).not.toHaveBeenCalled();
    expect(s.start).not.toHaveBeenCalled();
    expect(s.gateway).not.toHaveBeenCalled();
  });

  it('hashes complete two-pass observations and returns only the account fingerprint', async () => {
    const s = setup({ apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET', confirmLive: true });
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.account).toMatchObject({ status: 'OBSERVED_CONVERGENCE', fingerprint: providerAccountFingerprint('PRIVATE_ACCOUNT_ID'), provesAccountContinuity: false });
    expect(report.account.passes).toHaveLength(2);
    expect(report.account.records).toEqual({ orders: [], positions: [], truncated: false });
    expect(report.account.passes.every(p => p.observedAtMs !== undefined && p.readLatencyMs !== undefined && p.readLatencyMs >= 0)).toBe(true);
    expect(s.orders).toHaveBeenCalledTimes(4);
    expect(s.positions).toHaveBeenCalledTimes(2);
    expect(s.stop).toHaveBeenCalledOnce();
    expect(s.gateway).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_KEY|PRIVATE_SECRET|PRIVATE_ACCOUNT_ID/);
  });

  it('bounds retained read-only records without changing complete-read convergence hashes', async () => {
    const s = setup({ apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET' });
    const orders = Array.from({ length: 501 }, (_, i) => ({ exchangeOrderId: `o-${String(i).padStart(4, '0')}`, pair: 'B-BTC_USDT',
      side: 'BUY' as const, venueStatus: 'open', orderedQuantity: '1', filledQuantity: '0', remainingQuantity: '1', cancelledQuantity: '0',
      averageFillPrice: null, price: '100', wireOrderType: 'limit_order', leverage: '1', providerCreatedAtMs: 1, providerEventTimeMs: 2, clientOrderId: null }));
    const models: InrFuturesOrder[] = orders.map(o => ({ id: o.exchangeOrderId, pair: o.pair, side: 'buy', status: 'open', orderType: 'limit_order',
      priceUsdt: new Decimal(100), stopPriceUsdt: null, avgPriceUsdt: null, totalQuantity: new Decimal(1), remainingQuantity: new Decimal(1), cancelledQuantity: null,
      feeAmountUsdt: null, settlementCurrencyConversionPriceInrPerUsdt: null, makerFeePercent: null, takerFeePercent: null, leverage: new Decimal(1),
      stage: null, positionMarginType: null, marginCurrency: 'INR', createdAtMs: 1, updatedAtMs: 2, clientOrderId: null }));
    s.orders.mockImplementation(async request => request.side === 'buy' ? models.slice((Number(request.page) - 1) * 100, Number(request.page) * 100) : []);
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.account.status).toBe('OBSERVED_CONVERGENCE');
    expect(report.account.records?.orders).toHaveLength(500); expect(report.account.records?.truncated).toBe(true);
    expect(report.account.passes[0]).toMatchObject({ orderCount: 501, ordersSha256: sha256CanonicalJson(orders) });
    expect(report.ordersSubmitted).toBe(0); expect(report.account.provesAccountContinuity).toBe(false);
  });

  it('never treats two identical incomplete reads as convergence', async () => {
    const s = setup({ apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET' });
    s.orders.mockRejectedValue(new Error('PRIVATE_SECRET'));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.status).toBe('DEGRADED');
    expect(report.account.status).toBe('UNRESOLVED');
    expect(report.account.passes.every(pass => !pass.complete)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SECRET');
    expect(s.stop).toHaveBeenCalledOnce();
  });

  it('marks changing position observations unresolved', async () => {
    const s = setup({ apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET' });
    const zero = new Decimal(0);
    const position: InrFuturesPosition = {
      id: 'position-1', pair: 'B-BTC_USDT', activePositionQuantity: new Decimal(1), inactiveBuyQuantity: zero,
      inactiveSellQuantity: zero, avgPriceUsdt: new Decimal(100), liquidationPriceUsdt: null,
      lockedMarginUsdt: zero, lockedUserMarginUsdt: zero, lockedOrderMarginUsdt: zero, maintenanceMarginUsdt: null,
      markPriceUsdt: null, takeProfitTriggerPriceUsdt: null, stopLossTriggerPriceUsdt: null,
      leverage: new Decimal(1), marginType: 'isolated', settlementCurrencyAvgPriceInrPerUsdt: null, marginCurrency: 'INR', updatedAtMs: 1,
    };
    s.positions.mockResolvedValueOnce([]).mockResolvedValueOnce([position]).mockResolvedValueOnce([]);
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.account.status).toBe('UNRESOLVED');
    expect(report.account.passes[0]?.positionsSha256).not.toBe(report.account.passes[1]?.positionsSha256);
  });

  it('does not attribute an existing venue position to the currently selected strategy', async () => {
    const s = setup({ apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET' });
    const zero = new Decimal(0);
    const updatedAtMs = Date.now();
    s.positions.mockImplementation(async request => request?.page === '1' ? [{ id: 'position-1', pair: 'B-BTC_USDT',
      activePositionQuantity: new Decimal(1), inactiveBuyQuantity: zero, inactiveSellQuantity: zero,
      avgPriceUsdt: new Decimal(100), liquidationPriceUsdt: null, lockedMarginUsdt: zero, lockedUserMarginUsdt: zero,
      lockedOrderMarginUsdt: zero, maintenanceMarginUsdt: null, markPriceUsdt: null, takeProfitTriggerPriceUsdt: null,
      stopLossTriggerPriceUsdt: null, leverage: new Decimal(1), marginType: 'isolated', settlementCurrencyAvgPriceInrPerUsdt: null,
      marginCurrency: 'INR', updatedAtMs }] : []);
    s.client.getCandles.mockImplementation(async query => candles(query.pair, 'DOWN'));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.account.status).toBe('OBSERVED_CONVERGENCE');
    const summary = report.cycles[0]!.pairSummaries[0]!;
    expect(summary.riskEvidence?.ownershipStatus).toBe('UNRECONCILED');
    expect(summary.riskEvidence?.exposureSnapshotAvailable).toBe(false);
    expect(summary.riskReasonCodes).toContain('POSITION_OWNERSHIP_UNRECONCILED');
    expect(report.ordersSubmitted).toBe(0);
  });

  it('stops the stream even when startup fails and reports the failure safely', async () => {
    const s = setup({ apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET' });
    s.start.mockRejectedValue(new Error('PRIVATE_SECRET'));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report.status).toBe('DEGRADED');
    expect(report.account.error).toBe('PRIVATE_STREAM_START_FAILED');
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SECRET');
    expect(s.stop).toHaveBeenCalledOnce();
  });

  it('constructs the injected gateway only for explicitly confirmed tiny live and submits nothing', async () => {
    const s = setup({ mode: 'TINY_LIVE', confirmLive: true, apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET' });
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(s.gateway).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ gatewayConstructed: true, ordersSubmitted: 0 });
  });

  it('isolates discovery and candle failures without reflecting raw errors', async () => {
    const s = setup({ coins: ['BTC', 'ETH'] });
    s.discovery.mockRejectedValueOnce(new Error('PRIVATE_SECRET'));
    s.client.getCandles.mockRejectedValueOnce(new Error('PRIVATE_KEY'));
    const report = await new PracticalBotOrchestrator(s.options).run();
    expect(report).toMatchObject({ status: 'DEGRADED', discovery: { failures: [{ underlying: 'BTC', category: 'DISCOVERY_FAILED' }] } });
    expect(report.cycles[0]?.markets[0]?.status).toBe('UNAVAILABLE');
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_KEY|PRIVATE_SECRET/);
  });

  it('aborts the cycle delay promptly and cleans up the stream', async () => {
    const controller = new AbortController();
    const s = setup({ apiKey: 'PRIVATE_KEY', apiSecret: 'PRIVATE_SECRET', cycles: 10, intervalMs: 60_000, signal: controller.signal });
    const running = new PracticalBotOrchestrator(s.options).run();
    const timer = setTimeout(() => { controller.abort(); }, 20);
    try {
      const report = await running;
      expect(report.status).toBe('STOPPED');
      expect(report.cycles).toHaveLength(1);
      expect(s.stop).toHaveBeenCalled();
    } finally { clearTimeout(timer); }
  });

  it('uses configured profiles by default and rejects unknown requested coins', async () => {
    const s = setup();
    const { coins: _coins, ...options } = s.options;
    expect((await new PracticalBotOrchestrator(options).run()).requestedCoins).toEqual(['BTC', 'ETH', 'SOL']);
    await expect(new PracticalBotOrchestrator({ ...options, coins: ['UNKNOWN'] }).run()).rejects.toThrow('REQUESTED_COIN_PROFILE_NOT_FOUND');
  });

  it('parses CLI defaults and rejects malformed flags and nonpositive cycle counts', () => {
    expect(parseBotArguments([], {})).toEqual({ mode: 'SHADOW', strategy: 'ema-trend', confirmLive: false, coins: ['BTC', 'ETH', 'SOL'], cycles: 1, intervalMs: 5000, maxInr: '500', equityInr: '5000' });
    expect(parseBotArguments(['--mode', 'tiny-live', '--confirm-live', '--equity-inr', '5000'], {}).confirmLive).toBe(true);
    expect(parseBotArguments([], { COINDCX_AUTHORITATIVE_EQUITY_INR: '7500' }).equityInr).toBe('7500');
    expect(parseBotArguments(['--equity-inr', '5000'], { COINDCX_AUTHORITATIVE_EQUITY_INR: '7500' }).equityInr).toBe('5000');
    expect(() => parseBotArguments(['--mode', 'tiny-live', '--confirm-live'], {})).toThrow('TINY_LIVE_REQUIRES_EXPLICIT_EQUITY_INR');
    expect(() => parseBotArguments(['--mode', 'tiny-live'], {})).toThrow('TINY_LIVE_REQUIRES_EXPLICIT_CONFIRM_FLAG');
    expect(() => parseBotArguments(['--equity-inr', '0'], {})).toThrow('INVALID_EQUITY_INR');
    expect(() => parseBotArguments(['--equity-inr', 'NaN'], {})).toThrow('INVALID_EQUITY_INR');
    expect(() => parseBotArguments(['--mode', 'invalid'])).toThrow('INVALID_BOT_MODE');
    expect(() => parseBotArguments(['--cycles', 'NaN'])).toThrow('INVALID_CYCLES');
    expect(() => parseBotArguments(['--unknown'])).toThrow();
    const s = setup();
    expect(() => new PracticalBotOrchestrator({ ...s.options, cycles: 0 })).toThrow('INVALID_CYCLES');
    expect(() => new PracticalBotOrchestrator({ ...s.options, maxInr: '-1' })).toThrow('INVALID_MAX_INR');
  });
});

describe('practical bot settlement evidence', () => {
  const observedAtMs = 1_700_000_000_000;
  const record = { symbol: 'USDTINR', margin_currency_short_name: 'INR', target_currency_short_name: 'USDT',
    conversion_price: new LosslessNumber('89.1234567890123456789'), last_updated_at: new LosslessNumber(String(observedAtMs - 1000)) };
  it('preserves decimal precision, provider time and content seal', () => {
    const snapshot = readBotSettlementConversion([record], observedAtMs);
    expect(snapshot.rateInrPerUsdt).toBe('89.1234567890123456789');
    expect(snapshot.provenance).toMatchObject({ sourceId: BOT_RISK_SOURCES.conversionSourceId,
      sourceTimeMs: observedAtMs - 1000, observedAtMs });
    expect(snapshot.provenance.contentSha256).toBe(evidenceContentSha256(snapshot));
  });
  it.each([null, [], [record, record], [{ ...record, conversion_price: '0' }], [{ ...record, conversion_price: 'NaN' }],
    [{ ...record, margin_currency_short_name: 'USDT' }], [{ ...record, last_updated_at: observedAtMs + 1 }],
    [{ ...record, last_updated_at: '9007199254740993' }]])('refuses malformed, ambiguous or future conversion evidence %#', value => {
    expect(() => readBotSettlementConversion(value, observedAtMs)).toThrow('INVALID_SETTLEMENT_CONVERSION');
  });
});

describe('operator shadow durable capital and bounded tier evidence', () => {
  const accountFingerprint = 'a'.repeat(64);
  const observedAtMs = 1_700_000_000_000;
  it('preserves the durable high-water mark and active reservations across reopening', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coindcx-bot-shadow-'));
    try {
      const original = readBotShadowCapital(directory, accountFingerprint, '5000', observedAtMs);
      expect(original.equityInr).toBe('5000');
      const file = path.join(directory, `bot-shadow-capital-${accountFingerprint}.json`);
      const capital = { ...original, peakEquityInr: '6000', reservations: [{ reservationId: 'active', pair: 'B-ETH_USDT', strategyInstanceId: 'other-instance',
        strategyId: 'other-strategy', strategyVersion: '1', parameterHash: 'b'.repeat(64), direction: 'SHORT' as const,
        notionalInr: '200', marginInr: '100', status: 'ADMITTED' as const }] };
      const content = { format: 'BOT_OPERATOR_SHADOW_CAPITAL_V1', capital };
      fs.writeFileSync(file, JSON.stringify({ ...content, contentSha256: sha256CanonicalJson(content) }));
      const reopened = readBotShadowCapital(directory, accountFingerprint, '5000', observedAtMs + 1000);
      expect(reopened.peakEquityInr).toBe('6000');
      const discovered = mapInstrumentToMetadata({ ...instrument('BTC'), dynamicPositionLeverageTiers: [{ leverage: new Decimal(20), maxPositionSizeUsdt: new Decimal(5000) }] }, 'BTC');
      const state = createBotShadowRiskState({ capital: reopened, instrument: discovered, instrumentObservedAtMs: observedAtMs + 1000,
        evaluationTimeMs: observedAtMs + 1000, settlement: null, positions: [], allowOfflineFlat: false });
      expect(state.accountSnapshot?.availableMarginInr).toBe('4900');
      expect(state.accountSnapshot?.peakEquityInr).toBe('6000');
      expect(state.exposureSnapshot?.pending).toMatchObject({ status: 'KNOWN', pendingReservationCount: 1, globalPendingNotionalInr: '200',
        pairPendingNotionalInr: { 'B-ETH_USDT': '200' }, pendingDirectionalNotionalInr: { longInr: '0', shortInr: '200' } });
      expect(state.accountSnapshot?.provenance.contentSha256).toBe(evidenceContentSha256(state.accountSnapshot!));
      expect(() => readBotShadowCapital(directory, accountFingerprint, '7500', observedAtMs + 1000)).toThrow('SHADOW_EQUITY_BASELINE_MISMATCH');
    } finally { removeShadowTestDirectory(directory); }
  });
  it('fails closed on corrupted durable capital instead of silently creating an empty pending book', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coindcx-bot-shadow-'));
    try {
      readBotShadowCapital(directory, accountFingerprint, '5000', observedAtMs);
      const file = path.join(directory, `bot-shadow-capital-${accountFingerprint}.json`);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { capital: { equityInr: string } };
      raw.capital.equityInr = '10000';
      fs.writeFileSync(file, JSON.stringify(raw));
      expect(() => readBotShadowCapital(directory, accountFingerprint, '5000', observedAtMs + 1000)).toThrow('SHADOW_CAPITAL_INVALID');
      fs.writeFileSync(file, '{');
      expect(() => readBotShadowCapital(directory, accountFingerprint, '5000', observedAtMs + 1000)).toThrow('SHADOW_CAPITAL_INVALID');
    } finally { removeShadowTestDirectory(directory); }
  });
  it('limits tier coverage strictly below the smallest published boundary and keeps the real fetch time', () => {
    const metadata = mapInstrumentToMetadata({ ...instrument('BTC'), dynamicPositionLeverageTiers: [
      { leverage: new Decimal(10), maxPositionSizeUsdt: new Decimal(10000) }, { leverage: new Decimal(100), maxPositionSizeUsdt: new Decimal(1000) }] }, 'BTC');
    const tier = createBotInteriorLeverageSnapshot(metadata, observedAtMs);
    expect(tier.tiers).toHaveLength(1);
    expect(tier.tiers[0]).toMatchObject({ lowerNotionalUsdt: '0', upperNotionalUsdt: '500', maxLeverage: '100' });
    expect(tier.provenance.observedAtMs).toBe(observedAtMs);
    expect(tier.provenance.contentSha256).toBe(evidenceContentSha256(tier));
    expect(() => createBotInteriorLeverageSnapshot({ ...metadata, dynamicPositionLeverageTiers: [] }, observedAtMs)).toThrow('INVALID_LEVERAGE_TIERS');
  });
});
