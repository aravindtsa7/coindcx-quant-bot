import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../../src/core/decimal/decimal';
import { validateAndNormalizeCandleEvent } from '../../../../src/integration/coindcx/websocket/schemas';
import { CoinDcxPublicFuturesStream } from '../../../../src/integration/coindcx/websocket/public-stream';
import { CoinDcxStreamEnvelope, PublicCandleUpdatePayload } from '../../../../src/integration/coindcx/websocket/types';
import { createTestStreamContext } from './test-helpers';

function makeRawCandle(overrides: Record<string, unknown> = {}) {
  const { data: dataOverrides, ...rootOverrides } = overrides;
  const candleOverride =
    Array.isArray(dataOverrides) && dataOverrides[0] ? (dataOverrides[0] as Record<string, unknown>) : {};

  return {
    data: [
      {
        open: '50000.12345678',
        high: '50500.99999999',
        low: '49800.00000001',
        close: '50250.55555555',
        volume: '123.456789',
        quote_volume: '6172839.45',
        open_time: 1700000000,
        close_time: 1700000059.999,
        pair: 'B-BTC_USDT',
        duration: '1m',
        symbol: 'BTCUSDT',
        ...candleOverride,
      },
    ],
    Ets: 1700000055000,
    i: '1m',
    channel: 'B-BTC_USDT_1m-futures',
    pr: 'futures',
    ...rootOverrides,
  };
}

describe('CoinDCX WebSocket — Public Candle Wire Validation', () => {
  it('33. valid 1m Futures candle is accepted and normalized', () => {
    const raw = makeRawCandle();
    const result = validateAndNormalizeCandleEvent(raw, 'B-BTC_USDT');

    expect(result.pair).toBe('B-BTC_USDT');
    expect(result.duration).toBe('1m');
    expect(result.open).toBeInstanceOf(Decimal);
    expect(result.open.toString()).toBe('50000.12345678');
    expect(result.high.toString()).toBe('50500.99999999');
    expect(result.low.toString()).toBe('49800.00000001');
    expect(result.close.toString()).toBe('50250.55555555');
    expect(result.volume.toString()).toBe('123.456789');
    expect(result.quoteVolume?.toString()).toBe('6172839.45');
    expect(result.openTimeMs).toBe(1700000000000);
    expect(result.closeTimeMs).toBe(1700000059999);
    expect(result.providerEventTimeMs).toBe(1700000055000);
  });

  it('34. financial strings are preserved as exact Decimal with no binary float rounding', () => {
    const raw = makeRawCandle({
      data: [
        {
          open: '0.000000000000123456789',
          high: '0.000000000000200000000',
          low: '0.000000000000100000000',
          close: '0.000000000000150000000',
        },
      ],
    });
    const result = validateAndNormalizeCandleEvent(raw, 'B-BTC_USDT');
    expect(result.open.toString()).toBe('0.000000000000123456789');
  });

  it('35. malformed decimal string is rejected', () => {
    const raw = makeRawCandle({
      data: [{ open: 'invalid-number' }],
    });
    expect(() => validateAndNormalizeCandleEvent(raw, 'B-BTC_USDT')).toThrow();
  });

  it('36. NaN and Infinity values are strictly rejected', () => {
    const rawNaN = makeRawCandle({
      data: [{ open: 'NaN' }],
    });
    expect(() => validateAndNormalizeCandleEvent(rawNaN, 'B-BTC_USDT')).toThrow();

    const rawInf = makeRawCandle({
      data: [{ open: 'Infinity' }],
    });
    expect(() => validateAndNormalizeCandleEvent(rawInf, 'B-BTC_USDT')).toThrow();
  });

  it('37. wrong product is rejected (spot / s / non-futures)', () => {
    const rawSpot = makeRawCandle({ pr: 'spot' });
    expect(() => validateAndNormalizeCandleEvent(rawSpot, 'B-BTC_USDT')).toThrow(
      "Invalid candle product: 'spot'. Expected 'futures'"
    );

    const rawShortSpot = makeRawCandle({ pr: 's' });
    expect(() => validateAndNormalizeCandleEvent(rawShortSpot, 'B-BTC_USDT')).toThrow(
      "Invalid candle product: 's'. Expected 'futures'"
    );
  });

  it('38. wrong interval is rejected (must be 1m)', () => {
    const raw5m = makeRawCandle({ i: '5m' });
    expect(() => validateAndNormalizeCandleEvent(raw5m, 'B-BTC_USDT')).toThrow(
      "Invalid candle interval: '5m'. Expected '1m'"
    );

    const rawDurationMismatch = makeRawCandle({
      data: [{ duration: '15m' }],
    });
    expect(() => validateAndNormalizeCandleEvent(rawDurationMismatch, 'B-BTC_USDT')).toThrow(
      "Candle duration mismatch: '15m'. Expected '1m'"
    );
  });

  it('39. wrong pair in payload is rejected against subscription pair', () => {
    const raw = makeRawCandle({
      data: [{ pair: 'B-ETH_USDT' }],
    });
    expect(() => validateAndNormalizeCandleEvent(raw, 'B-BTC_USDT')).toThrow(
      "Candle pair 'B-ETH_USDT' does not match expected subscription pair 'B-BTC_USDT'"
    );
  });

  it('40. wrong channel is dropped by public stream without emitting', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    const received: CoinDcxStreamEnvelope<unknown>[] = [];
    stream.subscribe((env) => received.push(env));

    await stream.start([
      { underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
    ]);
    const socket = ctx.socketFactory.latestSocket!;

    // Emit event with unsubscribed channel
    socket.trigger('candlestick', {
      channel: 'B-ETH_USDT_1m-futures',
      data: [{ pair: 'B-ETH_USDT' }],
    });

    expect(received.filter((e) => e.eventType === 'PUBLIC_CANDLE_UPDATE')).toHaveLength(0);
    expect(stream.getHealthSnapshot().unexpectedChannelEventCount).toBe(1);

    stream.stop();
  });

  it('41. invalid OHLC structural relations are rejected', () => {
    // high < low
    expect(() =>
      validateAndNormalizeCandleEvent(
        makeRawCandle({ data: [{ high: '49000', low: '50000', open: '49500', close: '49500' }] }),
        'B-BTC_USDT'
      )
    ).toThrow('Structural OHLC violation: high (49000) < low (50000)');

    // high < open
    expect(() =>
      validateAndNormalizeCandleEvent(
        makeRawCandle({ data: [{ high: '50000', low: '40000', open: '51000', close: '45000' }] }),
        'B-BTC_USDT'
      )
    ).toThrow('Structural OHLC violation: high (50000) < open (51000)');

    // high < close
    expect(() =>
      validateAndNormalizeCandleEvent(
        makeRawCandle({ data: [{ high: '50000', low: '40000', open: '45000', close: '51000' }] }),
        'B-BTC_USDT'
      )
    ).toThrow('Structural OHLC violation: high (50000) < close (51000)');

    // low > open
    expect(() =>
      validateAndNormalizeCandleEvent(
        makeRawCandle({ data: [{ high: '55000', low: '51000', open: '50000', close: '52000' }] }),
        'B-BTC_USDT'
      )
    ).toThrow('Structural OHLC violation: low (51000) > open (50000)');

    // low > close
    expect(() =>
      validateAndNormalizeCandleEvent(
        makeRawCandle({ data: [{ high: '55000', low: '51000', open: '52000', close: '50000' }] }),
        'B-BTC_USDT'
      )
    ).toThrow('Structural OHLC violation: low (51000) > close (50000)');
  });

  it('42. unsafe/negative timestamps are rejected', () => {
    expect(() =>
      validateAndNormalizeCandleEvent(
        makeRawCandle({ data: [{ open_time: -1 }] }),
        'B-BTC_USDT'
      )
    ).toThrow('Invalid timestamp for open_time: -1');

    expect(() =>
      validateAndNormalizeCandleEvent(
        makeRawCandle({ data: [{ open_time: 1700000060, close_time: 1700000000 }] }),
        'B-BTC_USDT'
      )
    ).toThrow('openTimeMs (1700000060000) > closeTimeMs (1700000000000)');
  });

  it('43. provider timestamp is distinct from local receivedAt timestamp', async () => {
    const ctx = createTestStreamContext();
    ctx.clock.setTime(1700000099000); // local clock time

    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    let receivedEnvelope: CoinDcxStreamEnvelope<unknown> | null = null;
    stream.subscribe((env) => {
      if (env.eventType === 'PUBLIC_CANDLE_UPDATE') {
        receivedEnvelope = env;
      }
    });

    await stream.start([
      { underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
    ]);
    const socket = ctx.socketFactory.latestSocket!;

    // Provider Ets is 1700000055000, while local receivedAtMs is 1700000099000
    socket.trigger('candlestick', makeRawCandle({ Ets: 1700000055000 }));

    expect(receivedEnvelope).not.toBeNull();
    expect(receivedEnvelope!.providerTimestampMs).toBe(1700000055000);
    expect(receivedEnvelope!.receivedAtMs).toBe(1700000099000);
    expect(receivedEnvelope!.providerTimestampMs).not.toBe(receivedEnvelope!.receivedAtMs);

    stream.stop();
  });

  it('44. candle is never marked closed by Phase 4 (isClosed strictly false)', () => {
    const raw = makeRawCandle();
    const result = validateAndNormalizeCandleEvent(raw, 'B-BTC_USDT');

    expect(result.isClosed).toBe(false);
    expect((result as PublicCandleUpdatePayload).isClosed).toBe(false);
  });

  it('45. invalid candle event does not crash stream or break connection', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([
      { underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
    ]);
    const socket = ctx.socketFactory.latestSocket!;

    // Send malformed payload on subscribed channel
    expect(() => {
      socket.trigger('candlestick', {
        channel: 'B-BTC_USDT_1m-futures',
        malformed: true,
      });
    }).not.toThrow();

    expect(stream.connected).toBe(true);
    expect(stream.getHealthSnapshot().invalidEventCount).toBe(1);

    stream.stop();
  });

  it('46. real stringified candle wrapper fixture decodes, validates, and normalizes into envelope', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    const receivedEnvelopes: CoinDcxStreamEnvelope<unknown>[] = [];
    stream.subscribe((env) => {
      if (env.eventType === 'PUBLIC_CANDLE_UPDATE') {
        receivedEnvelopes.push(env);
      }
    });

    await stream.start([
      { underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
    ]);
    const socket = ctx.socketFactory.latestSocket!;

    // Representative real live CoinDCX wrapper: outer event contains stringified inner data JSON
    const liveWrapperFixture = {
      channel: 'B-BTC_USDT_1m-futures',
      data: JSON.stringify([
        {
          pair: 'B-BTC_USDT',
          open: '65432.10',
          high: '65500.00',
          low: '65400.00',
          close: '65480.50',
          volume: '10.55',
          quote_volume: '690500.75',
          open_time: 1700000000000,
          close_time: 1700000059999,
          duration: '1m',
        },
      ]),
      Ets: 1700000060123,
      i: '1m',
      pr: 'futures',
    };

    socket.trigger('candlestick', liveWrapperFixture);

    expect(receivedEnvelopes).toHaveLength(1);
    const env = receivedEnvelopes[0]!;
    expect(env.eventType).toBe('PUBLIC_CANDLE_UPDATE');
    expect(env.stream).toBe('PUBLIC_FUTURES');
    expect(env.pair).toBe('B-BTC_USDT');
    expect(env.providerTimestampMs).toBe(1700000060123);

    const payload = env.payload as PublicCandleUpdatePayload;
    expect(payload.pair).toBe('B-BTC_USDT');
    expect(payload.duration).toBe('1m');
    expect(payload.open.toString()).toBe('65432.1');
    expect(payload.high.toString()).toBe('65500');
    expect(payload.low.toString()).toBe('65400');
    expect(payload.close.toString()).toBe('65480.5');
    expect(payload.volume.toString()).toBe('10.55');
    expect(payload.quoteVolume?.toString()).toBe('690500.75');
    expect(payload.openTimeMs).toBe(1700000000000);
    expect(payload.closeTimeMs).toBe(1700000059999);
    expect(payload.isClosed).toBe(false);

    stream.stop();
  });

  it('47. missing quote_volume is normalized to null without fabricating zero', () => {
    const raw = makeRawCandle({
      data: [
        {
          open: '50000',
          high: '50500',
          low: '49800',
          close: '50250',
          volume: '100',
          quote_volume: undefined,
          open_time: 1700000000,
          close_time: 1700000059.999,
          pair: 'B-BTC_USDT',
          duration: '1m',
        },
      ],
    });
    const result = validateAndNormalizeCandleEvent(raw, 'B-BTC_USDT');
    expect(result.quoteVolume).toBeNull();
  });
});
