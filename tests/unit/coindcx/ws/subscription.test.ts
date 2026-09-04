import { describe, expect, it } from 'vitest';
import { CoinRuntime, MarketDataSubscriptionIntent } from '../../../../src/coin-runtime/types';
import { createSubscriptionIntent } from '../../../../src/coin-runtime/subscription-intent';
import {
  buildFuturesCandleChannel,
  buildFuturesTradeChannel,
  matchesFuturesCandleChannel,
} from '../../../../src/integration/coindcx/websocket/channel-builder';
import { CoinDcxPublicFuturesStream } from '../../../../src/integration/coindcx/websocket/public-stream';
import { createTestStreamContext } from './test-helpers';
import { Decimal } from '../../../../src/core/decimal/decimal';

describe('CoinDCX WebSocket — Public Subscription Management', () => {
  it('24. BTC + ETH subscription results in one socket and exactly two joins', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    const intents: MarketDataSubscriptionIntent[] = [
      { underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
      { underlying: 'ETH', pair: 'B-ETH_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
    ];

    await stream.start(intents);

    expect(ctx.socketFactory.createdSockets).toHaveLength(1);
    const socket = ctx.socketFactory.latestSocket!;

    const joins = socket.emitted.filter((e) => e.event === 'join');
    expect(joins).toHaveLength(2);
    expect(joins).toEqual([
      { event: 'join', args: [{ channelName: 'B-BTC_USDT_1m-futures' }] },
      { event: 'join', args: [{ channelName: 'B-ETH_USDT_1m-futures' }] },
    ]);

    expect(stream.getHealthSnapshot().activeSubscriptionCount).toBe(2);
    stream.stop();
  });

  it('25. fake SOL adds channel with zero core changes (modular onboarding proof)', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    const solIntent: MarketDataSubscriptionIntent = {
      underlying: 'SOL',
      pair: 'B-SOL_USDT',
      requiresOneMinuteCandles: true,
      requiresTrades: false,
    };

    await stream.start([solIntent]);
    const socket = ctx.socketFactory.latestSocket!;

    const joins = socket.emitted.filter((e) => e.event === 'join');
    expect(joins).toHaveLength(1);
    expect(joins[0]!.args[0]).toEqual({ channelName: 'B-SOL_USDT_1m-futures' });

    stream.stop();
  });

  it('26. duplicate intent for the same pair/channel is cleanly deduped', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    const duplicateIntents: MarketDataSubscriptionIntent[] = [
      { underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
      { underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
    ];

    await stream.start(duplicateIntents);
    const socket = ctx.socketFactory.latestSocket!;

    const joins = socket.emitted.filter((e) => e.event === 'join');
    expect(joins).toHaveLength(1);
    expect(stream.getHealthSnapshot().activeSubscriptionCount).toBe(1);

    stream.stop();
  });

  it('27. removed intent emits leave without reconnecting the socket', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([
      { underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
      { underlying: 'ETH', pair: 'B-ETH_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
    ]);

    const socket = ctx.socketFactory.latestSocket!;
    expect(stream.getHealthSnapshot().activeSubscriptionCount).toBe(2);

    // Sync subscriptions removing ETH
    stream.syncSubscriptions([
      { underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
    ]);

    const leaves = socket.emitted.filter((e) => e.event === 'leave');
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.args[0]).toEqual({ channelName: 'B-ETH_USDT_1m-futures' });
    expect(stream.getHealthSnapshot().activeSubscriptionCount).toBe(1);
    // Still generation 1, socket did not reconnect
    expect(stream.generationId).toBe(1);

    stream.stop();
  });

  it('28. subscription intent change during reconnect wait uses the newest set', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([
      { underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
      { underlying: 'ETH', pair: 'B-ETH_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
    ]);

    const s1 = ctx.socketFactory.latestSocket!;
    s1.trigger('disconnect', 'transport close');
    expect(stream.state).toBe('RECONNECT_WAIT');

    // While reconnect timer is pending, subscription intents change (SOL added, ETH removed)
    stream.syncSubscriptions([
      { underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
      { underlying: 'SOL', pair: 'B-SOL_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
    ]);

    // Let reconnect timer fire
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);

    const s2 = ctx.socketFactory.latestSocket!;
    const s2Joins = s2.emitted.filter((e) => e.event === 'join');

    // Must have BTC and SOL joins, NOT ETH
    expect(s2Joins).toHaveLength(2);
    expect(s2Joins).toEqual([
      { event: 'join', args: [{ channelName: 'B-BTC_USDT_1m-futures' }] },
      { event: 'join', args: [{ channelName: 'B-SOL_USDT_1m-futures' }] },
    ]);

    stream.stop();
  });

  it('29. disabled runtime creates no channel', () => {
    const disabledRuntime = {
      status: 'UNDISCOVERED_DISABLED' as const,
      profile: {
        underlying: 'BTC',
        enabled: false,
        dataEnabled: true,
        researchEnabled: false,
        paperEnabled: false,
        shadowEnabled: false,
        liveEnabled: false,
        timeframes: ['1m'] as const,
        strategyAssignments: [],
        riskProfileId: 'SAFE',
        defaultLeverage: new Decimal(1),
        configuredAbsoluteMaxLeverage: new Decimal(20),
      },
      instrument: null,
      lifecycle: 'DISABLED' as const,
      entryEligibility: 'CONFIG_DISABLED' as const,
    };

    const intent = createSubscriptionIntent(disabledRuntime);
    expect(intent).toBeNull();
  });

  it('30. undiscovered runtime creates no channel', () => {
    const undiscoveredRuntime = {
      status: 'UNDISCOVERED_DISABLED' as const,
      profile: {
        underlying: 'BTC',
        enabled: true,
        dataEnabled: true,
        researchEnabled: false,
        paperEnabled: false,
        shadowEnabled: false,
        liveEnabled: false,
        timeframes: ['1m'] as const,
        strategyAssignments: [],
        riskProfileId: 'SAFE',
        defaultLeverage: new Decimal(1),
        configuredAbsoluteMaxLeverage: new Decimal(20),
      },
      instrument: null,
      lifecycle: 'DISABLED' as const,
      entryEligibility: 'CONFIG_DISABLED' as const,
    };

    const intent = createSubscriptionIntent(undiscoveredRuntime);
    expect(intent).toBeNull();
  });

  it('31. proves zero hardcoded BTC/ETH pairs exist in public-stream.ts', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const content = fs.readFileSync(
      path.resolve(__dirname, '../../../../src/integration/coindcx/websocket/public-stream.ts'),
      'utf8'
    );

    expect(content.includes('B-BTC_USDT')).toBe(false);
    expect(content.includes('B-ETH_USDT')).toBe(false);
  });

  it('32. only canonical 1m requested by default when dataEnabled is true', () => {
    const runtime = {
      status: 'DISCOVERED' as const,
      profile: {
        underlying: 'BTC',
        enabled: true,
        dataEnabled: true,
        researchEnabled: false,
        paperEnabled: false,
        shadowEnabled: false,
        liveEnabled: false,
        timeframes: ['1m', '5m', '15m'] as const,
        strategyAssignments: [],
        riskProfileId: 'SAFE',
        defaultLeverage: new Decimal(1),
        configuredAbsoluteMaxLeverage: new Decimal(20),
      },
      instrument: {
        pair: 'B-BTC_USDT',
        status: 'active',
        marginCurrency: 'INR' as const,
        unitContractValue: new Decimal(1),
        priceIncrement: new Decimal('0.5'),
        quantityIncrement: new Decimal('0.001'),
        minTradeSize: new Decimal('0.001'),
        minPrice: new Decimal(1),
        maxPrice: new Decimal(1000000),
        minQuantity: new Decimal('0.001'),
        maxQuantity: new Decimal(100),
        minNotional: new Decimal(100),
        maxMarketOrderQuantity: new Decimal(50),
        makerFeePercent: new Decimal('0.02'),
        takerFeePercent: new Decimal('0.05'),
        exitOnly: false,
        dynamicPositionLeverageTiers: [],
        dynamicSafetyMarginTiers: [],
        legacyMaxNotionalIgnored: null,
      },
      lifecycle: 'DISCOVERED' as const,
      entryEligibility: 'ELIGIBLE' as const,
    };

    const intent = createSubscriptionIntent(runtime as unknown as CoinRuntime);
    expect(intent).not.toBeNull();
    expect(intent!.requiresOneMinuteCandles).toBe(true);
    expect(intent!.requiresTrades).toBe(false);
  });

  it('33. channel builder enforces format and interval invariants', () => {
    expect(buildFuturesCandleChannel('B-BTC_USDT', '1m')).toBe('B-BTC_USDT_1m-futures');
    expect(buildFuturesTradeChannel('B-BTC_USDT')).toBe('B-BTC_USDT@trades-futures');

    // Invalid interval
    expect(() => buildFuturesCandleChannel('B-BTC_USDT', '5m')).toThrow('strictly supports \'1m\'');

    // Invalid / empty pair
    expect(() => buildFuturesCandleChannel('')).toThrow('non-empty string');
    expect(() => buildFuturesCandleChannel('BTC_USDT')).toThrow('Invalid CoinDCX Futures pair format');
    expect(() => buildFuturesTradeChannel('')).toThrow('non-empty string');
    expect(() => buildFuturesTradeChannel('BTC_USDT')).toThrow('Invalid CoinDCX Futures pair format');

    // Matching helper
    expect(matchesFuturesCandleChannel('B-BTC_USDT_1m-futures', 'B-BTC_USDT')).toBe(true);
    expect(matchesFuturesCandleChannel('B-ETH_USDT_1m-futures', 'B-BTC_USDT')).toBe(false);
    expect(matchesFuturesCandleChannel('', 'B-BTC_USDT')).toBe(false);
    expect(matchesFuturesCandleChannel('B-BTC_USDT_1m-futures', '')).toBe(false);
  });
});
