import { describe, expect, it } from 'vitest';
import { CoinDcxPrivateAccountStream } from '../../../../src/integration/coindcx/websocket/private-stream';
import { CoinDcxPublicFuturesStream } from '../../../../src/integration/coindcx/websocket/public-stream';
import { createTestStreamContext } from './test-helpers';

describe('CoinDCX WebSocket — Resource Leak Safety', () => {
  it('77. 100 reconnect generations do not accumulate listeners', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([
      { underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
    ]);

    for (let i = 0; i < 100; i++) {
      const activeSocket = ctx.socketFactory.latestSocket!;
      activeSocket.trigger('disconnect', 'transport close');
      ctx.scheduler.runAllTimers();
    }

    expect(stream.generationId).toBe(101);
    expect(ctx.socketFactory.createdSockets).toHaveLength(101);

    // Verify all old sockets (0 to 99) have zero listeners remaining and disconnect was called
    for (let i = 0; i < 100; i++) {
      const oldSocket = ctx.socketFactory.createdSockets[i]!;
      expect(oldSocket.getTotalListenerCount()).toBe(0);
      expect(oldSocket.disconnectCalls).toBeGreaterThanOrEqual(1);
    }

    // Only current socket has active listeners, exactly the 5 registered handlers
    const currentSocket = ctx.socketFactory.latestSocket!;
    expect(currentSocket.getTotalListenerCount()).toBe(5);
    expect(currentSocket.getListenerCount('connect')).toBe(1);
    expect(currentSocket.getListenerCount('disconnect')).toBe(1);
    expect(currentSocket.getListenerCount('connect_error')).toBe(1);
    expect(currentSocket.getListenerCount('error')).toBe(1);
    expect(currentSocket.getListenerCount('candlestick')).toBe(1);

    // Timers bounded: zero reconnect timers pending, exactly 1 ping interval active
    expect(ctx.scheduler.activeTimerCount).toBe(0);
    expect(ctx.scheduler.activeIntervalCount).toBe(1);

    stream.stop();
  });

  it('78. old sockets have listeners cleanly removed upon generation transition', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: 'key',
      apiSecret: 'secret',
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start();
    const s1 = ctx.socketFactory.latestSocket!;
    expect(s1.getTotalListenerCount()).toBeGreaterThan(0);

    s1.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();

    // s1 listeners must be zero
    expect(s1.getTotalListenerCount()).toBe(0);

    stream.stop();
  });

  it('79. at most one reconnect timer exists at any point in time', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    const s1 = ctx.socketFactory.latestSocket!;

    // Repeated triggers from same failing socket
    s1.trigger('disconnect', 'transport close');
    s1.trigger('disconnect', 'transport error');
    s1.trigger('error', new Error('err'));

    expect(ctx.scheduler.activeTimerCount).toBe(1);

    stream.stop();
  });

  it('80. at most one ping interval timer exists per current generation', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    expect(ctx.scheduler.activeIntervalCount).toBe(1);

    // Reconnect to gen 2
    ctx.socketFactory.latestSocket!.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();

    expect(ctx.scheduler.activeIntervalCount).toBe(1);

    stream.stop();
  });

  it('81. at most one connect timeout timer per attempt and cleared upon connection', async () => {
    const ctx = createTestStreamContext();
    ctx.socketFactory.autoConnectSynchronously = false;

    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
      connectTimeoutMs: 5000,
    });

    const startPromise = stream.start([]);
    // While connecting, exactly one timeout timer is registered
    expect(ctx.scheduler.activeTimerCount).toBe(1);

    // Complete connection
    ctx.socketFactory.latestSocket!.trigger('connect');
    await startPromise;

    // Timeout timer must be cancelled immediately
    expect(ctx.scheduler.activeTimerCount).toBe(0);

    stream.stop();
  });

  it('82. stop leaves zero timers and zero intervals in scheduler', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    const s1 = ctx.socketFactory.latestSocket!;
    s1.trigger('disconnect', 'transport close');

    // Currently in reconnect wait with pending timer
    expect(ctx.scheduler.activeTimerCount).toBe(1);

    stream.stop();

    expect(ctx.scheduler.activeTimerCount).toBe(0);
    expect(ctx.scheduler.activeIntervalCount).toBe(0);
    expect(stream.state).toBe('STOPPED');
  });
});
