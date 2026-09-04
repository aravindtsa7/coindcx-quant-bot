import { describe, expect, it } from 'vitest';
import { calculateBackoffWithJitter } from '../../../../src/integration/coindcx/websocket/backoff';
import { CoinDcxPrivateAccountStream } from '../../../../src/integration/coindcx/websocket/private-stream';
import { CoinDcxPublicFuturesStream } from '../../../../src/integration/coindcx/websocket/public-stream';
import { ProductionCoinDcxSocket } from '../../../../src/integration/coindcx/websocket/socket-adapter';
import { createTestStreamContext } from './test-helpers';

describe('CoinDCX WebSocket — Connection Core', () => {
  it('1. public start creates exactly one socket', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    expect(ctx.socketFactory.createdSockets).toHaveLength(1);
    expect(stream.connected).toBe(true);
    expect(stream.state).toBe('STREAMING');
    stream.stop();
  });

  it('2. public repeated start single-flight joins the same physical attempt', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    // Run 3 concurrent start calls
    const [p1, p2, p3] = [stream.start([]), stream.start([]), stream.start([])];
    await Promise.all([p1, p2, p3]);

    expect(ctx.socketFactory.createdSockets).toHaveLength(1);
    stream.stop();
  });

  it('3. private start creates exactly one socket', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start();
    expect(ctx.socketFactory.createdSockets).toHaveLength(1);
    expect(stream.connected).toBe(true);
    expect(stream.state).toBe('AUTH_JOIN_SENT');
    stream.stop();
  });

  it('4. private repeated start single-flight', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await Promise.all([stream.start(), stream.start(), stream.start()]);
    expect(ctx.socketFactory.createdSockets).toHaveLength(1);
    stream.stop();
  });

  it('5. public and private sockets are completely independent', async () => {
    const ctx = createTestStreamContext();
    const pubStream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });
    const privStream = new CoinDcxPrivateAccountStream({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await pubStream.start([]);
    await privStream.start();

    expect(ctx.socketFactory.createdSockets).toHaveLength(2);
    expect(ctx.socketFactory.createdSockets[0]).not.toBe(ctx.socketFactory.createdSockets[1]);

    // Public disconnect does not affect private
    ctx.socketFactory.createdSockets[0]!.disconnect();
    expect(pubStream.connected).toBe(false);
    expect(privStream.connected).toBe(true);

    pubStream.stop();
    privStream.stop();
  });

  it('6. connect timeout disposes socket and transitions state', async () => {
    const ctx = createTestStreamContext();
    ctx.socketFactory.autoConnectSynchronously = false;
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
      connectTimeoutMs: 5000,
    });

    // Disable auto-connect to simulate network hang
    const startPromise = stream.start([]);
    startPromise.catch(() => {});

    // Trigger timeout
    ctx.scheduler.runAllTimers();

    await expect(startPromise).rejects.toThrow('SOCKET_CONNECT_TIMEOUT');
    expect(stream.connected).toBe(false);
    expect(stream.state).toBe('RECONNECT_WAIT');

    stream.stop();
  });

  it('7. reconnect timer single-flight (disconnect and error from same gen schedule one retry)', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    const socket = ctx.socketFactory.latestSocket!;

    // Emit both disconnect and error
    socket.trigger('disconnect', 'transport close');
    socket.trigger('error', new Error('test-error'));

    // Should only have 1 active reconnect timer in scheduler
    expect(ctx.scheduler.activeTimerCount).toBe(1);
    expect(stream.state).toBe('RECONNECT_WAIT');

    stream.stop();
  });

  it('8. exponential backoff is strictly bounded by maxDelayMs', () => {
    const config = { minDelayMs: 500, baseDelayMs: 1000, maxDelayMs: 30000, factor: 2 };
    for (let attempt = 0; attempt < 50; attempt++) {
      const delay = calculateBackoffWithJitter(attempt, config, () => 1.0);
      expect(delay).toBeLessThanOrEqual(30000);
      expect(delay).toBeGreaterThanOrEqual(500);
    }
  });

  it('9. jitter is deterministic with injected RNG', () => {
    const config = { minDelayMs: 500, baseDelayMs: 1000, maxDelayMs: 30000, factor: 2 };
    // Attempt 1: raw = 2000, range = 1500
    const delayMin = calculateBackoffWithJitter(1, config, () => 0.0);
    expect(delayMin).toBe(500);

    const delayMid = calculateBackoffWithJitter(1, config, () => 0.5);
    expect(delayMid).toBe(500 + Math.floor(0.5 * 1500));

    const delayMax = calculateBackoffWithJitter(1, config, () => 1.0);
    expect(delayMax).toBe(2000);
  });

  it('10. successful baseline resets reconnect attempt count', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    const s1 = ctx.socketFactory.latestSocket!;
    s1.trigger('disconnect', 'transport error');
    expect(stream.getHealthSnapshot().reconnectAttempt).toBe(1);

    // Let reconnect timer fire
    ctx.scheduler.runAllTimers();
    expect(stream.connected).toBe(true);
    // After baseline achieved, reconnectAttempt resets to 0
    expect(stream.getHealthSnapshot().reconnectAttempt).toBe(0);

    stream.stop();
  });

  it('11. stop cancels pending reconnect timer and halts retry loop', async () => {
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

    stream.stop();
    expect(ctx.scheduler.activeTimerCount).toBe(0);
    expect(stream.state).toBe('STOPPED');

    // Running timers should produce zero new sockets
    ctx.scheduler.runAllTimers();
    expect(ctx.socketFactory.createdSockets).toHaveLength(1);
  });

  it('12. stale disconnect callback from old socket cannot trigger reconnect', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    const gen1Socket = ctx.socketFactory.latestSocket!;

    // Reconnect to generation 2
    gen1Socket.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);

    // Now fake gen 1 fires another disconnect late
    gen1Socket.trigger('disconnect', 'transport error');
    // Generation 2 must not be disrupted
    expect(stream.generationId).toBe(2);
    expect(stream.connected).toBe(true);
    expect(ctx.scheduler.activeTimerCount).toBe(0);

    stream.stop();
  });

  it('13. repeated stop is idempotent', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    stream.stop();
    stream.stop();
    stream.stop();

    expect(stream.state).toBe('STOPPED');
    expect(stream.connected).toBe(false);
  });

  it('14. restart after stop creates a fresh generation', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([]);
    expect(stream.generationId).toBe(1);

    stream.stop();
    expect(stream.generationId).toBe(2);

    await stream.start([]);
    expect(stream.generationId).toBe(3);
    expect(stream.connected).toBe(true);
    expect(ctx.socketFactory.createdSockets).toHaveLength(2);

    stream.stop();
  });

  it('15. production adapter removes exact listener without affecting unrelated listeners', () => {
    const prodSocket = new ProductionCoinDcxSocket('wss://stream.coindcx.com', { autoConnect: false });
    const raw = prodSocket.getRawSocketForTesting();
    // Simulate connected state on raw Socket.IO client without network
    (raw as unknown as { connected: boolean }).connected = true;

    let aCount = 0;
    let bCount = 0;
    const listenerA = () => {
      aCount++;
    };
    const listenerB = () => {
      bCount++;
    };

    prodSocket.on('candlestick', listenerA);
    prodSocket.on('candlestick', listenerB);

    // Emit event 1 via raw Socket.IO onevent
    (raw as unknown as { onevent: (packet: { data: unknown[] }) => void }).onevent({
      data: ['candlestick', { price: '100' }],
    });

    expect(aCount).toBe(1);
    expect(bCount).toBe(1);

    // Remove only listener A
    prodSocket.off('candlestick', listenerA);

    // Emit event 2
    (raw as unknown as { onevent: (packet: { data: unknown[] }) => void }).onevent({
      data: ['candlestick', { price: '200' }],
    });

    // Listener A received NOTHING more, Listener B received second event
    expect(aCount).toBe(1);
    expect(bCount).toBe(2);

    // Cleanup
    prodSocket.off('candlestick', listenerB);
  });

  it('16. connecting socket timeout triggers unconditional disposal and disconnect call on public stream', async () => {
    const ctx = createTestStreamContext();
    ctx.socketFactory.autoConnectSynchronously = false;

    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
      connectTimeoutMs: 5000,
    });

    const startPromise = stream.start([]);
    expect(stream.state).toBe('CONNECTING');
    const connectingSocket = ctx.socketFactory.latestSocket!;
    const oldConnectListener = Array.from(connectingSocket.listeners.get('connect') || [])[0]!;
    expect(connectingSocket.connected).toBe(false);
    expect(connectingSocket.getTotalListenerCount()).toBeGreaterThan(0);
    expect(connectingSocket.disconnectCalls).toBe(0);

    // Advance fake scheduler to trigger connection timeout
    ctx.scheduler.runAllTimers();
    await expect(startPromise).rejects.toThrow('SOCKET_CONNECT_TIMEOUT');

    // Prove unconditional disposal:
    // 1. disconnect called exactly once
    expect(connectingSocket.disconnectCalls).toBe(1);
    // 2. listeners removed
    expect(connectingSocket.getTotalListenerCount()).toBe(0);
    // 3. connect timeout cleared; only reconnect timer remains
    expect(ctx.scheduler.activeTimerCount).toBe(1);
    // 4. socket reference no longer active
    expect(stream.connected).toBe(false);
    expect(stream.state).toBe('RECONNECT_WAIT');

    // 5. next reconnect can proceed
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);

    // 6. late connect callback from old socket cannot affect current generation
    oldConnectListener();
    expect(stream.getHealthSnapshot().staleGenerationDropCount).toBe(1);

    stream.stop();
  });

  it('17. connecting socket timeout triggers unconditional disposal and disconnect call on private stream', async () => {
    const ctx = createTestStreamContext();
    ctx.socketFactory.autoConnectSynchronously = false;

    const stream = new CoinDcxPrivateAccountStream({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
      connectTimeoutMs: 5000,
    });

    const startPromise = stream.start();
    expect(stream.state).toBe('CONNECTING');
    const connectingSocket = ctx.socketFactory.latestSocket!;
    const oldConnectListener = Array.from(connectingSocket.listeners.get('connect') || [])[0]!;
    expect(connectingSocket.connected).toBe(false);
    expect(connectingSocket.getTotalListenerCount()).toBeGreaterThan(0);
    expect(connectingSocket.disconnectCalls).toBe(0);

    ctx.scheduler.runAllTimers();
    await expect(startPromise).rejects.toThrow('SOCKET_CONNECT_TIMEOUT');

    // Unconditional disposal verified
    expect(connectingSocket.disconnectCalls).toBe(1);
    expect(connectingSocket.getTotalListenerCount()).toBe(0);
    expect(stream.connected).toBe(false);
    expect(stream.state).toBe('RECONNECT_WAIT');

    // Next reconnect can proceed
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);

    // Late connect from old socket is ignored
    oldConnectListener();
    expect(stream.getHealthSnapshot().staleGenerationDropCount).toBe(1);

    stream.stop();
  });
});
