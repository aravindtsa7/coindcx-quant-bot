import { describe, expect, it } from 'vitest';
import { CoinDcxPrivateAccountStream } from '../../../../src/integration/coindcx/websocket/private-stream';
import { CoinDcxPublicFuturesStream } from '../../../../src/integration/coindcx/websocket/public-stream';
import { CoinDcxStreamEnvelope } from '../../../../src/integration/coindcx/websocket/types';
import { createTestStreamContext } from './test-helpers';

const VALID_CANDLE = {
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

describe('CoinDCX WebSocket — Recovery & Reconciliation Barriers', () => {
  it('64. public reconnect after active market data emits PUBLIC_STREAM_RECOVERY_REQUIRED', async () => {
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
    const s1 = ctx.socketFactory.latestSocket!;

    // Feed valid candle into generation 1
    s1.trigger('candlestick', VALID_CANDLE);
    expect(stream.state).toBe('STREAMING');

    // Disconnect generation 1
    s1.trigger('disconnect', 'transport close');
    expect(stream.state).toBe('RECONNECT_WAIT');

    // Reconnect to generation 2
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);

    // Verify recovery required envelope was dispatched
    const recoveryEnvelopes = received.filter(
      (e) => e.eventType === 'PUBLIC_STREAM_RECOVERY_REQUIRED'
    );
    expect(recoveryEnvelopes).toHaveLength(1);
    expect(stream.isRecoveryRequired).toBe(true);
    expect(stream.state).toBe('RECOVERY_REQUIRED');

    stream.stop();
  });

  it('65. first post-reconnect candle does NOT automatically clear recovery barrier', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPublicFuturesStream({
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start([
      { underlying: 'BTC', pair: 'B-BTC_USDT', requiresOneMinuteCandles: true, requiresTrades: false },
    ]);
    const s1 = ctx.socketFactory.latestSocket!;
    s1.trigger('candlestick', VALID_CANDLE);

    s1.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();
    expect(stream.isRecoveryRequired).toBe(true);

    const s2 = ctx.socketFactory.latestSocket!;
    // Emit new candle on generation 2
    s2.trigger('candlestick', VALID_CANDLE);

    // CRITICAL: Recovery barrier must remain set! Only Phase 5 gap repair can clear it.
    expect(stream.isRecoveryRequired).toBe(true);
    expect(stream.state).toBe('RECOVERY_REQUIRED');
    expect(stream.getHealthSnapshot().recoveryRequired).toBe(true);

    stream.stop();
  });

  it('66. private reconnect emits PRIVATE_RECONCILIATION_REQUIRED', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: 'key',
      apiSecret: 'secret',
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    const received: CoinDcxStreamEnvelope<unknown>[] = [];
    stream.subscribe((env) => received.push(env));

    await stream.start();
    const s1 = ctx.socketFactory.latestSocket!;

    s1.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);

    const reconciliationEnvelopes = received.filter(
      (e) => e.eventType === 'PRIVATE_RECONCILIATION_REQUIRED'
    );
    expect(reconciliationEnvelopes).toHaveLength(1);
    expect(stream.isReconciliationRequired).toBe(true);
    expect(stream.state).toBe('RECONCILIATION_REQUIRED');
    expect(stream.getHealthSnapshot().reconciliationRequired).toBe(true);

    stream.stop();
  });

  it('67. first private event does NOT automatically claim reconciled', async () => {
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

    s1.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();
    expect(stream.isReconciliationRequired).toBe(true);

    const s2 = ctx.socketFactory.latestSocket!;
    s2.trigger('df-position-update', [
      {
        id: 'pos-1',
        pair: 'B-BTC_USDT',
        active_pos: '0',
        avg_price: '0',
        leverage: 10,
        updated_at: 1700000050000,
        margin_currency_short_name: 'INR',
      },
    ]);

    // Private event does NOT clear reconciliation barrier
    expect(stream.isReconciliationRequired).toBe(true);
    expect(stream.state).toBe('RECONCILIATION_REQUIRED');

    stream.stop();
  });

  it('68. proves zero REST gap repair is implemented in Phase 4', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.resolve(__dirname, '../../../../src/integration/coindcx/websocket');
    const files = fs.readdirSync(dir);

    const forbiddenPhrases = ['gapRepair', 'repairGap', 'backfillCandles', 'getCandles'];

    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const phrase of forbiddenPhrases) {
        expect(content.includes(phrase)).toBe(false);
      }
    }
  });

  it('69. proves zero account REST reconciliation is implemented in Phase 4', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.resolve(__dirname, '../../../../src/integration/coindcx/websocket');
    const files = fs.readdirSync(dir);

    const forbiddenPhrases = [
      'reconcileAccount',
      'reconcilePositions',
      'reconcileOrders',
      'reconcileBalances',
    ];

    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const phrase of forbiddenPhrases) {
        expect(content.includes(phrase)).toBe(false);
      }
    }
  });
});

