import { describe, expect, it } from 'vitest';
import { CoinDcxPrivateAccountStream } from '../../../../src/integration/coindcx/websocket/private-stream';
import { CoinDcxPublicFuturesStream } from '../../../../src/integration/coindcx/websocket/public-stream';
import { CoinDcxStreamEnvelope } from '../../../../src/integration/coindcx/websocket/types';
import { createTestStreamContext } from './test-helpers';

const SAMPLE_VALID_CANDLE = {
  data: [
    {
      open: '50000.0',
      high: '50100.0',
      low: '49900.0',
      close: '50050.0',
      volume: '10.5',
      quote_volume: '525000',
      open_time: 1700000000,
      close_time: 1700000059.999,
      pair: 'B-BTC_USDT',
      duration: '1m',
    },
  ],
  Ets: 1700000050000,
  i: '1m',
  channel: 'B-BTC_USDT_1m-futures',
  pr: 'futures',
};

const SAMPLE_VALID_POSITION = [
  {
    id: 'pos-1',
    pair: 'B-BTC_USDT',
    active_pos: '1.5',
    avg_price: '50000',
    liquidation_price: '45000',
    locked_margin: '5000',
    leverage: 10,
    mark_price: '50010',
    maintenance_margin: '500',
    updated_at: 1700000050000,
    margin_type: 'isolated',
    margin_currency_short_name: 'INR',
    settlement_currency_avg_price: '89.0',
  },
];

describe('CoinDCX WebSocket — Generation Isolation', () => {
  it('15. generation increments on new public connection', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    expect(stream.generationId).toBe(1);

    const s1 = ctx.socketFactory.latestSocket!;
    s1.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();

    expect(stream.generationId).toBe(2);
    expect(ctx.socketFactory.createdSockets).toHaveLength(2);
    stream.stop();
  });

  it('16. generation increments on new private connection independently', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: 'key',
      apiSecret: 'secret',
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start();
    expect(stream.generationId).toBe(1);

    const s1 = ctx.socketFactory.latestSocket!;
    s1.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();

    expect(stream.generationId).toBe(2);
    expect(ctx.socketFactory.createdSockets).toHaveLength(2);
    stream.stop();
  });

  it('17. old public candle event is dropped (Section 33 stale-generation proof)', async () => {
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
      {
        underlying: 'BTC',
        pair: 'B-BTC_USDT',
        requiresOneMinuteCandles: true,
        requiresTrades: false,
      },
    ]);
    const gen1Socket = ctx.socketFactory.latestSocket!;
    // Preserve the callback closure from gen 1 before listeners could be detached
    const gen1CandleListener = Array.from(gen1Socket.listeners.get('candlestick') || [])[0]!;
    expect(gen1CandleListener).toBeDefined();

    // Disconnect gen 1 and reconnect to gen 2
    gen1Socket.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);

    const gen2Socket = ctx.socketFactory.latestSocket!;
    expect(gen2Socket).not.toBe(gen1Socket);

    // Gen 1 listener emits a valid candle late
    gen1CandleListener(SAMPLE_VALID_CANDLE);

    // Expected: dropped, zero received envelopes, stale drops incremented
    expect(receivedEnvelopes).toHaveLength(0);
    expect(stream.getHealthSnapshot().staleGenerationDropCount).toBe(1);

    // Gen 2 emits same candle: accepted
    gen2Socket.trigger('candlestick', SAMPLE_VALID_CANDLE);
    expect(receivedEnvelopes).toHaveLength(1);
    expect(receivedEnvelopes[0]!.generationId).toBe(2);

    stream.stop();
  });

  it('18. old private event is dropped when emitted on stale generation', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: 'key',
      apiSecret: 'secret',
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    const receivedEnvelopes: CoinDcxStreamEnvelope<unknown>[] = [];
    stream.subscribe((env) => {
      if (env.eventType === 'PRIVATE_POSITION_UPDATE_NOTIFICATION') {
        receivedEnvelopes.push(env);
      }
    });

    await stream.start();
    const gen1Socket = ctx.socketFactory.latestSocket!;
    const gen1PosListener = Array.from(gen1Socket.listeners.get('df-position-update') || [])[0]!;

    gen1Socket.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);

    // Stale generation 1 listener fires
    gen1PosListener(SAMPLE_VALID_POSITION);
    expect(receivedEnvelopes).toHaveLength(0);
    expect(stream.getHealthSnapshot().staleGenerationDropCount).toBe(1);

    // Current gen 2 fires: accepted
    const gen2Socket = ctx.socketFactory.latestSocket!;
    gen2Socket.trigger('df-position-update', SAMPLE_VALID_POSITION);
    expect(receivedEnvelopes).toHaveLength(1);
    expect(receivedEnvelopes[0]!.generationId).toBe(2);

    stream.stop();
  });

  it('19. stale connect callback ignored', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    const gen1Socket = ctx.socketFactory.latestSocket!;
    const gen1ConnectListener = Array.from(gen1Socket.listeners.get('connect') || [])[0]!;

    // Reconnect to gen 2
    gen1Socket.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);

    // Stale connect callback invoked
    gen1ConnectListener();
    expect(stream.getHealthSnapshot().staleGenerationDropCount).toBe(1);

    stream.stop();
  });

  it('20. stale error callback ignored', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    const gen1Socket = ctx.socketFactory.latestSocket!;
    const gen1ErrorListener = Array.from(gen1Socket.listeners.get('error') || [])[0]!;

    gen1Socket.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);

    gen1ErrorListener(new Error('stale error'));
    expect(stream.getHealthSnapshot().staleGenerationDropCount).toBe(1);

    stream.stop();
  });

  it('21. stale reconnect timer callback ignored', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    const s1 = ctx.socketFactory.latestSocket!;
    s1.trigger('disconnect', 'transport close');
    expect(ctx.scheduler.activeTimerCount).toBe(1);

    // Before timer fires, caller stops stream (invalidates generation to 2)
    stream.stop();
    expect(ctx.scheduler.activeTimerCount).toBe(0);

    // Re-start creates generation 3
    await stream.start([]);
    expect(stream.generationId).toBe(3);

    stream.stop();
  });

  it('22. stale ping timer cannot emit on disconnected socket', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
      pingIntervalMs: 25000,
    });

    await stream.start([]);
    const s1 = ctx.socketFactory.latestSocket!;

    // Trigger ping interval on active socket
    ctx.scheduler.triggerIntervals();
    expect(s1.emitted.filter((e) => e.event === 'ping')).toHaveLength(1);

    // Disconnect and advance to generation 2
    s1.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);

    // Old socket s1 should NOT receive any more ping emits
    ctx.scheduler.triggerIntervals();
    expect(s1.emitted.filter((e) => e.event === 'ping')).toHaveLength(1);

    stream.stop();
  });

  it('23. stale generation cannot update health freshness', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([
      {
        underlying: 'BTC',
        pair: 'B-BTC_USDT',
        requiresOneMinuteCandles: true,
        requiresTrades: false,
      },
    ]);
    const gen1Socket = ctx.socketFactory.latestSocket!;
    const gen1CandleListener = Array.from(gen1Socket.listeners.get('candlestick') || [])[0]!;

    // Advance to generation 2
    gen1Socket.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();

    ctx.clock.setTime(1700000099999);
    // Stale generation 1 listener fires with new timestamp
    gen1CandleListener(SAMPLE_VALID_CANDLE);

    // lastValidEventReceivedAtMs should NOT be updated to 1700000099999
    expect(stream.getHealthSnapshot().lastValidEventReceivedAtMs).toBeNull();

    stream.stop();
  });

  it('24. EXACT RACE: public manual start cancels stale timer and allows generation 2 recovery to schedule generation 3', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    // 1. Generation 1 starts
    await stream.start([]);
    expect(stream.generationId).toBe(1);
    const gen1Socket = ctx.socketFactory.latestSocket!;

    // 2. Generation 1 fails -> Reconnect timer T1 scheduled
    gen1Socket.trigger('disconnect', 'transport close');
    expect(stream.state).toBe('RECONNECT_WAIT');
    expect(ctx.scheduler.activeTimerCount).toBe(1);

    // 3. Before T1 fires, manual start/connect requested
    // 4. T1 cancelled/inactivated, Generation 2 begins
    const startPromise = stream.start([]);
    expect(stream.generationId).toBe(2);
    expect(stream.state).toBe('STREAMING');
    expect(ctx.scheduler.activeTimerCount).toBe(0); // T1 cancelled!
    await startPromise;

    const gen2Socket = ctx.socketFactory.latestSocket!;

    // 6. Generation 2 fails
    gen2Socket.trigger('disconnect', 'transport error');
    // 7. T2 is scheduled
    expect(stream.state).toBe('RECONNECT_WAIT');
    expect(ctx.scheduler.activeTimerCount).toBe(1);

    // 8. Advance fake clock through old T1 time and T2 time
    ctx.scheduler.advanceTime(35000);

    // 9. No stale callback suppressed T2; T2 fires and generation 3 begins
    expect(stream.generationId).toBe(3);
    expect(stream.connected).toBe(true);
    expect(stream.state).toBe('STREAMING');

    stream.stop();
  });

  it('25. EXACT RACE: private manual start cancels stale timer and avoids permanent disconnect', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    // Gen 1 starts
    await stream.start();
    expect(stream.generationId).toBe(1);
    const gen1Socket = ctx.socketFactory.latestSocket!;

    // Gen 1 fails -> T1 scheduled
    gen1Socket.trigger('disconnect', 'transport close');
    expect(stream.state).toBe('RECONNECT_WAIT');
    expect(ctx.scheduler.activeTimerCount).toBe(1);

    // Manual start before T1 fires
    await stream.start();
    expect(stream.generationId).toBe(2);
    expect(stream.connected).toBe(true);

    const gen2Socket = ctx.socketFactory.latestSocket!;

    // Gen 2 fails -> T2 scheduled
    gen2Socket.trigger('disconnect', 'transport error');
    expect(stream.state).toBe('RECONNECT_WAIT');
    expect(ctx.scheduler.activeTimerCount).toBe(1);

    // Advance clock: T2 fires and generation 3 connects
    ctx.scheduler.advanceTime(35000);
    expect(stream.generationId).toBe(3);
    expect(stream.connected).toBe(true);

    stream.stop();
  });

  it('26. RECONNECT ATOMICITY: disconnect + connect_error in same generation creates exactly one reconnect timer', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    const s1 = ctx.socketFactory.latestSocket!;

    // Trigger both disconnect and connect_error on the same generation
    s1.trigger('disconnect', 'transport close');
    s1.trigger('connect_error');
    s1.trigger('error', new Error('fail'));

    // Must be exactly one reconnect timer
    expect(ctx.scheduler.activeTimerCount).toBe(1);

    stream.stop();
  });

  it('27. RECONNECT ATOMICITY: stop cancels current reconnect timer and prevents subsequent socket creation', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    const s1 = ctx.socketFactory.latestSocket!;
    s1.trigger('disconnect', 'transport close');

    expect(ctx.scheduler.activeTimerCount).toBe(1);
    const totalSocketsBeforeStop = ctx.socketFactory.createdSockets.length;

    stream.stop();
    expect(ctx.scheduler.activeTimerCount).toBe(0);

    // Advance fake scheduler into the future
    ctx.scheduler.advanceTime(60000);

    // No new socket created after stop
    expect(ctx.socketFactory.createdSockets).toHaveLength(totalSocketsBeforeStop);
    expect(stream.state).toBe('STOPPED');
  });

  it('28. RECONNECT ATOMICITY: stable baseline resets reconnect timer ownership and attempt counter', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    const s1 = ctx.socketFactory.latestSocket!;
    s1.trigger('disconnect', 'transport close');

    // Run reconnect timer to transition to gen 2
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);
    expect(stream.connected).toBe(true);

    // Baseline established: reconnectAttempt should be 0
    expect(stream.getHealthSnapshot().reconnectAttempt).toBe(0);
    expect(ctx.scheduler.activeTimerCount).toBe(0);

    stream.stop();
  });
});

