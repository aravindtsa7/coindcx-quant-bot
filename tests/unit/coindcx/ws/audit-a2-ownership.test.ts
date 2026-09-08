import { afterEach, describe, expect, it } from 'vitest';
import { CoinDcxPublicFuturesStream } from '../../../../src/integration/coindcx/websocket/public-stream';
import { CoinDcxPrivateAccountStream } from '../../../../src/integration/coindcx/websocket/private-stream';
import { CoinDcxSocketError } from '../../../../src/core/errors/app-error';
import { createTestStreamContext } from './test-helpers';

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
const intents = [{ underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true, requiresTrades: false }];

for (const kind of ['public', 'private'] as const) {
  function context(sync = false) {
    const ctx = createTestStreamContext(); ctx.socketFactory.autoConnectSynchronously = sync;
    const stream = kind === 'public' ? new CoinDcxPublicFuturesStream(ctx)
      : new CoinDcxPrivateAccountStream({ ...ctx, apiKey: 'test-key', apiSecret: 'test-secret' });
    stops.push(() => stream.stop());
    const start = () => stream instanceof CoinDcxPublicFuturesStream ? stream.start(intents) : stream.start();
    return { ...ctx, stream, start };
  }

  describe(`Audit A2 ${kind} connection ownership`, () => {
    it('pending start is canceled by stop twice, with no resources left', async () => {
      const c = context(); const outcome = c.start().catch(error => error as Error);
      const socket = c.socketFactory.latestSocket!;
      c.stream.stop(); c.stream.stop();
      expect(await outcome).toBeInstanceOf(CoinDcxSocketError);
      expect(c.stream.state).toBe('STOPPED');
      expect(socket.getTotalListenerCount()).toBe(0);
      expect(c.scheduler.activeTimerCount).toBe(0);
      expect(c.scheduler.activeIntervalCount).toBe(0);
    });

    it.each(['disconnect', 'error', 'connect_error'])('pending attempt settles when %s supersedes it, and reconnect succeeds', async event => {
      const c = context(); const outcome = c.start().catch(error => error as Error);
      const old = c.socketFactory.latestSocket!;
      const lateConnect = [...old.listeners.get('connect')!][0]!;
      old.trigger(event, 'transport close');
      expect(await outcome).toBeInstanceOf(CoinDcxSocketError);
      expect(old.getTotalListenerCount()).toBe(0);
      // Even before the next generation exists, a disposed socket no longer owns callbacks.
      lateConnect(); expect(c.stream.state).toBe('RECONNECT_WAIT');
      c.scheduler.runAllTimers(); const current = c.socketFactory.latestSocket!;
      expect(current).not.toBe(old); current.trigger('connect');
      await c.start(); expect(c.stream.connected).toBe(true);
      expect(c.scheduler.activeIntervalCount).toBe(1);
    });

    it('start-stop-start discards late old connect/error/close callbacks and heartbeat', async () => {
      const c = context(); const oldResult = c.start().catch(error => error as Error);
      const old = c.socketFactory.latestSocket!;
      const late = ['connect', 'connect_error', 'error', 'disconnect'].map(event => [...old.listeners.get(event)!][0]!);
      c.stream.stop(); const currentStart = c.start(); const current = c.socketFactory.latestSocket!;
      expect(await oldResult).toBeInstanceOf(CoinDcxSocketError);
      current.trigger('connect'); await currentStart;
      const generation = c.stream.generationId;
      for (const callback of late) callback('late');
      expect(c.stream.generationId).toBe(generation); expect(c.stream.connected).toBe(true);
      expect(c.scheduler.activeTimerCount).toBe(0); expect(c.scheduler.activeIntervalCount).toBe(1);
      expect(old.emitted).toHaveLength(0);
    });

    it('stop from CONNECTED subscriber cancels startup and prevents joins/heartbeat/remaining dispatch', async () => {
      const c = context(true); let laterSubscriberCalls = 0;
      c.stream.subscribe(event => { if (event.eventType.endsWith('_STREAM_CONNECTED')) c.stream.stop(); });
      c.stream.subscribe(() => laterSubscriberCalls++);
      await expect(c.start()).rejects.toMatchObject({ code: 'COINDCX_SOCKET_ERROR', details: { reason: 'CANCELLED' } });
      expect(c.stream.state).toBe('STOPPED'); expect(c.stream.connected).toBe(false);
      expect(c.socketFactory.latestSocket?.emitted).toHaveLength(0);
      expect(c.scheduler.activeTimerCount).toBe(0); expect(c.scheduler.activeIntervalCount).toBe(0);
      expect(laterSubscriberCalls).toBe(0);
    });

    it('stop/start from CONNECTED cannot let old continuation overwrite replacement ownership', async () => {
      const c = context(true); let restarted = false; let replacement: Promise<void> | undefined;
      c.stream.subscribe(event => {
        if (!restarted && event.eventType.endsWith('_STREAM_CONNECTED')) {
          restarted = true; c.stream.stop(); replacement = c.start();
        }
      });
      await expect(c.start()).rejects.toBeInstanceOf(CoinDcxSocketError);
      await replacement;
      expect(c.socketFactory.createdSockets).toHaveLength(2);
      expect(c.socketFactory.createdSockets[0]?.emitted).toHaveLength(0);
      expect(c.socketFactory.createdSockets[1]?.emitted.filter(e => e.event === 'join')).toHaveLength(1);
      expect(c.stream.connected).toBe(true);
      expect(c.scheduler.activeTimerCount).toBe(0); expect(c.scheduler.activeIntervalCount).toBe(1);
    });

    it('stop from DISCONNECTED subscriber prevents reconnect scheduling', async () => {
      const c = context(true); await c.start();
      c.stream.subscribe(event => { if (event.eventType.endsWith('_STREAM_DISCONNECTED')) c.stream.stop(); });
      c.socketFactory.latestSocket!.trigger('disconnect', 'transport close');
      expect(c.stream.state).toBe('STOPPED');
      expect(c.scheduler.activeTimerCount).toBe(0); expect(c.scheduler.activeIntervalCount).toBe(0);
    });

    it('an old heartbeat callback cannot tear down the new generation heartbeat', async () => {
      const c = context(true); await c.start();
      const oldPing = [...c.scheduler.intervals.values()][0]!.callback;
      c.stream.stop(); await c.start(); oldPing();
      expect(c.scheduler.activeIntervalCount).toBe(1);
      expect(c.stream.connected).toBe(true);
    });

    it('stop from reconnect reconciliation subscriber prevents all following connect work', async () => {
      const c = context(true); await c.start();
      if (kind === 'public') c.socketFactory.latestSocket!.trigger('candlestick', {
        data: [{ open: '100', high: '120', low: '90', close: '100', volume: '1', quote_volume: '100',
          open_time: 1700000000, close_time: 1700000059.999, pair: 'B-BTC_USDT', duration: '1m' }],
        Ets: 1700000050000, i: '1m', channel: 'B-BTC_USDT_1m-futures', pr: 'futures',
      });
      c.stream.subscribe(event => { if (event.eventType === 'PUBLIC_STREAM_RECOVERY_REQUIRED' || event.eventType === 'PRIVATE_RECONCILIATION_REQUIRED') c.stream.stop(); });
      c.socketFactory.latestSocket!.trigger('disconnect', 'transport close');
      c.scheduler.runAllTimers(); await Promise.resolve();
      expect(c.stream.state).toBe('STOPPED');
      expect(c.socketFactory.latestSocket?.emitted).toHaveLength(0);
      expect(c.scheduler.activeIntervalCount).toBe(0); expect(c.scheduler.activeTimerCount).toBe(0);
    });
  });
}
