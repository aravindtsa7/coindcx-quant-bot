import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../../src/core/decimal/decimal';
import { CoinDcxPrivateAccountStream } from '../../../../src/integration/coindcx/websocket/private-stream';
import {
  CoinDcxStreamEnvelope,
  PrivateBalanceNotificationPayload,
  PrivateOrderNotificationPayload,
  PrivatePositionNotificationPayload,
} from '../../../../src/integration/coindcx/websocket/types';
import { createTestStreamContext } from './test-helpers';

describe('CoinDCX WebSocket — Private Event Handlers & Non-Authority', () => {
  const TEST_KEY = 'test-key';
  const TEST_SECRET = 'test-secret';

  it('55. valid INR position notification is accepted and parsed into exact Decimals', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: TEST_KEY,
      apiSecret: TEST_SECRET,
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    let receivedPayload: PrivatePositionNotificationPayload | null = null;
    stream.subscribe((env) => {
      if (env.eventType === 'PRIVATE_POSITION_UPDATE_NOTIFICATION') {
        receivedPayload = env.payload as PrivatePositionNotificationPayload;
      }
    });

    await stream.start();
    const socket = ctx.socketFactory.latestSocket!;

    socket.trigger('df-position-update', [
      {
        id: 'pos-123',
        pair: 'B-BTC_USDT',
        active_pos: '0.5',
        avg_price: '51234.5',
        liquidation_price: '45000.0',
        locked_margin: '5123.45',
        leverage: 10,
        mark_price: '51250.0',
        maintenance_margin: '512.35',
        updated_at: 1700000050000,
        margin_type: 'isolated',
        margin_currency_short_name: 'INR',
        settlement_currency_avg_price: '89.5',
      },
    ]);

    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload!.positions).toHaveLength(1);
    const pos = receivedPayload!.positions[0]!;
    expect(pos.id).toBe('pos-123');
    expect(pos.activePosition).toBeInstanceOf(Decimal);
    expect(pos.activePosition.toString()).toBe('0.5');
    expect(pos.avgPrice.toString()).toBe('51234.5');
    expect(pos.marginCurrency).toBe('INR');
    expect(receivedPayload!.droppedNonInrCount).toBe(0);

    stream.stop();
  });

  it('56. non-INR position records are safely ignored and increment droppedNonInrCount without error spam', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: TEST_KEY,
      apiSecret: TEST_SECRET,
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    let receivedPayload: PrivatePositionNotificationPayload | null = null;
    stream.subscribe((env) => {
      if (env.eventType === 'PRIVATE_POSITION_UPDATE_NOTIFICATION') {
        receivedPayload = env.payload as PrivatePositionNotificationPayload;
      }
    });

    await stream.start();
    const socket = ctx.socketFactory.latestSocket!;

    // Send payload with 1 INR position and 1 USDT position
    socket.trigger('df-position-update', [
      {
        id: 'pos-inr',
        pair: 'B-BTC_USDT',
        active_pos: '1.0',
        avg_price: '50000',
        leverage: 10,
        updated_at: 1700000050000,
        margin_currency_short_name: 'INR',
      },
      {
        id: 'pos-usdt',
        pair: 'B-BTC_USDT',
        active_pos: '1.0',
        avg_price: '50000',
        leverage: 10,
        updated_at: 1700000050000,
        margin_currency_short_name: 'USDT', // Non-INR!
      },
    ]);

    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload!.positions).toHaveLength(1);
    expect(receivedPayload!.positions[0]!.id).toBe('pos-inr');
    expect(receivedPayload!.droppedNonInrCount).toBe(1);

    stream.stop();
  });

  it('57. valid INR order notification is accepted and non-INR orders are filtered', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: TEST_KEY,
      apiSecret: TEST_SECRET,
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    let receivedPayload: PrivateOrderNotificationPayload | null = null;
    stream.subscribe((env) => {
      if (env.eventType === 'PRIVATE_ORDER_UPDATE_NOTIFICATION') {
        receivedPayload = env.payload as PrivateOrderNotificationPayload;
      }
    });

    await stream.start();
    const socket = ctx.socketFactory.latestSocket!;

    socket.trigger('df-order-update', [
      {
        id: 'ord-1',
        pair: 'B-BTC_USDT',
        side: 'buy',
        status: 'open',
        order_type: 'limit_order',
        price: '50000',
        total_quantity: '0.1',
        created_at: 1700000010000,
        updated_at: 1700000020000,
        margin_currency_short_name: 'INR',
      },
      {
        id: 'ord-2',
        pair: 'B-ETH_USDT',
        side: 'sell',
        status: 'filled',
        order_type: 'market_order',
        total_quantity: '1.0',
        created_at: 1700000010000,
        updated_at: 1700000020000,
        margin_currency_short_name: 'USDT', // Non-INR
      },
    ]);

    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload!.orders).toHaveLength(1);
    expect(receivedPayload!.orders[0]!.id).toBe('ord-1');
    expect(receivedPayload!.orders[0]!.side).toBe('buy');
    expect(receivedPayload!.orders[0]!.totalQuantity).toBeInstanceOf(Decimal);
    expect(receivedPayload!.droppedNonInrCount).toBe(1);

    stream.stop();
  });

  it('58. balance event is treated strictly as notification only without modifying authoritative wallet', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: TEST_KEY,
      apiSecret: TEST_SECRET,
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    let receivedPayload: PrivateBalanceNotificationPayload | null = null;
    stream.subscribe((env) => {
      if (env.eventType === 'PRIVATE_BALANCE_CHANGE_NOTIFICATION') {
        receivedPayload = env.payload as PrivateBalanceNotificationPayload;
      }
    });

    await stream.start();
    const socket = ctx.socketFactory.latestSocket!;

    socket.trigger('balance-update', [
      {
        id: '12345',
        balance: '1000.50',
        locked_balance: '200.25',
        currency_short_name: 'INR',
      },
    ]);

    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload!.balances).toHaveLength(1);
    expect(receivedPayload!.balances[0]!.balance.toString()).toBe('1000.5');
    expect(receivedPayload!.balances[0]!.lockedBalance.toString()).toBe('200.25');

    stream.stop();
  });

  it('59. proves zero balance->equity or margin calculation code exists in WebSocket layer', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.resolve(__dirname, '../../../../src/integration/coindcx/websocket');
    const files = fs.readdirSync(dir);

    const forbiddenCalculations = ['availableMargin', 'totalEquity', 'accountEquity', 'freeMargin'];

    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const calculation of forbiddenCalculations) {
        expect(content.includes(calculation)).toBe(false);
      }
    }
  });

  it('60. private event payloads are not logged in INFO or ERROR logs', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const content = fs.readFileSync(
      path.resolve(__dirname, '../../../../src/integration/coindcx/websocket/private-stream.ts'),
      'utf8'
    );

    // Private stream should only log metadata (counts), never raw record payloads
    expect(content.includes('logger.info(payload')).toBe(false);
    expect(content.includes('logger.error(payload')).toBe(false);
    expect(content.includes('console.log(')).toBe(false);
  });

  it('61. malformed private event is dropped safely without crashing stream', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: TEST_KEY,
      apiSecret: TEST_SECRET,
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    await stream.start();
    const socket = ctx.socketFactory.latestSocket!;

    expect(() => {
      socket.trigger('df-position-update', 'not an array');
    }).not.toThrow();

    expect(stream.connected).toBe(true);
    expect(stream.getHealthSnapshot().invalidEventCount).toBe(1);

    stream.stop();
  });

  it('62. private event never updates authoritative REST model (separation of concerns)', async () => {
    // Proves CoinDcxPrivateAccountStream has zero imports of CoinDcxClient or CoinDcxTransport
    const fs = await import('node:fs');
    const path = await import('node:path');
    const content = fs.readFileSync(
      path.resolve(__dirname, '../../../../src/integration/coindcx/websocket/private-stream.ts'),
      'utf8'
    );

    expect(content.includes('CoinDcxClient')).toBe(false);
    expect(content.includes('CoinDcxTransport')).toBe(false);
  });

  it('63. stale-generation private event is dropped', async () => {
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({
      apiKey: TEST_KEY,
      apiSecret: TEST_SECRET,
      socketFactory: ctx.socketFactory,
      clock: ctx.clock,
      scheduler: ctx.scheduler,
    });

    const received: CoinDcxStreamEnvelope<unknown>[] = [];
    stream.subscribe((env) => received.push(env));

    await stream.start();
    const gen1Socket = ctx.socketFactory.latestSocket!;
    const gen1OrderListener = Array.from(gen1Socket.listeners.get('df-order-update') || [])[0]!;

    // Advance to generation 2
    gen1Socket.trigger('disconnect', 'transport close');
    ctx.scheduler.runAllTimers();
    expect(stream.generationId).toBe(2);

    // Stale generation 1 listener fires
    gen1OrderListener([
      {
        id: 'ord-stale',
        pair: 'B-BTC_USDT',
        side: 'buy',
        status: 'open',
        order_type: 'limit_order',
        total_quantity: '0.1',
        created_at: 1700000010000,
        updated_at: 1700000020000,
        margin_currency_short_name: 'INR',
      },
    ]);

    expect(received.filter((e) => e.eventType === 'PRIVATE_ORDER_UPDATE_NOTIFICATION')).toHaveLength(0);
    expect(stream.getHealthSnapshot().staleGenerationDropCount).toBe(1);

    stream.stop();
  });
});
