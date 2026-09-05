import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runPrivateWsSmoke,
  runPublicWsSmoke,
} from '../../../../scripts/coindcx-ws-smoke';
import { CANONICAL_AUTH_BODY } from '../../../../src/integration/coindcx/websocket/private-stream';
import {
  FakeCoinDcxSocket,
  FakeCoinDcxSocketFactory,
} from '../../../../src/integration/coindcx/websocket/socket-adapter';

describe('CoinDCX WebSocket — Private Auth Smoke Test Contract & Safety Invariants', () => {
  const CANARY_API_KEY = 'CANARY_WS_API_KEY_SECRET_12345';
  const CANARY_API_SECRET = 'CANARY_WS_API_SECRET_HEX_67890';
  const CANARY_POSITION_ID = 'CANARY_POS_RECORD_99999';
  const CANARY_ORDER_ID = 'CANARY_ORDER_RECORD_88888';
  const CANARY_BALANCE_AMOUNT = '987654321.12';

  const smokeScriptPath = path.resolve(__dirname, '../../../../scripts/coindcx-ws-smoke.ts');
  const smokeScriptContent = fs.readFileSync(smokeScriptPath, 'utf8');

  let logs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: string | number | null | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    logs = [];
    originalExitCode = process.exitCode;
    process.exitCode = 0;

    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    process.exitCode = originalExitCode as number | undefined;
    vi.useRealTimers();
  });

  // 1. no --auth => public-only behavior
  it('1. no --auth => public-only behavior (never starts private stream or uses credentials)', () => {
    expect(typeof runPublicWsSmoke).toBe('function');
    // Proves script defaults to public when --auth is absent
    expect(smokeScriptContent).toContain("process.argv.includes('--auth')");
    expect(smokeScriptContent).toContain('runPublicWsSmoke()');
    expect(smokeScriptContent).toContain('credentialsUsed=false');
    expect(smokeScriptContent).toContain('privateSocketStarted=false');

    // runPublicWsSmoke does not construct or reference CoinDcxPrivateAccountStream
    const publicFnMatch = smokeScriptContent.match(/export async function runPublicWsSmoke\(\)[\s\S]*?^}/m);
    expect(publicFnMatch).not.toBeNull();
    const publicFnBody = publicFnMatch![0];
    expect(publicFnBody).not.toContain('CoinDcxPrivateAccountStream');
    expect(publicFnBody).toContain('credentialsUsed=false');
    expect(publicFnBody).toContain('privateSocketStarted=false');
  });

  // 2. --auth => private smoke path becomes eligible
  it('2. --auth => private smoke path becomes eligible strictly via command-line argument', () => {
    expect(smokeScriptContent.replace(/\r\n/g, '\n')).toContain("if (isAuth) {\n    await runPrivateWsSmoke();\n  } else {\n    await runPublicWsSmoke();\n  }");
    // Strict invariant: no bypass via environment variables
    expect(smokeScriptContent).not.toContain('ENABLE_AUTHENTICATED_SMOKE');
    expect(smokeScriptContent).not.toContain('SAFE_TO_RUN_PRIVATE_WS_SMOKE');
  });

  // 3. credentials are never printed
  it('3. credentials are never printed anywhere in stdout, stderr, or structured summaries', async () => {
    const socketFactory = new FakeCoinDcxSocketFactory();

    const smokePromise = runPrivateWsSmoke({
      apiKey: CANARY_API_KEY,
      apiSecret: CANARY_API_SECRET,
      socketFactory,
      timeoutMs: 2000,
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(2000);
    await smokePromise;

    const allOutput = logs.join('\n');
    expect(allOutput).not.toContain(CANARY_API_KEY);
    expect(allOutput).not.toContain(CANARY_API_SECRET);
    expect(allOutput).toContain('credentialsLoaded=true');
    expect(allOutput).toContain('credentialsPrinted=false');
  });

  // 4. auth signature is never printed
  it('4. auth signature is never printed in stdout, stderr, or structured summaries', async () => {
    const expectedSig = crypto
      .createHmac('sha256', CANARY_API_SECRET)
      .update(CANONICAL_AUTH_BODY, 'utf8')
      .digest('hex');

    const socketFactory = new FakeCoinDcxSocketFactory();

    const smokePromise = runPrivateWsSmoke({
      apiKey: CANARY_API_KEY,
      apiSecret: CANARY_API_SECRET,
      socketFactory,
      timeoutMs: 2000,
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(2000);
    await smokePromise;

    const allOutput = logs.join('\n');
    expect(allOutput).not.toContain(expectedSig);
    expect(allOutput).toContain('authJoinSent=true');
    expect(allOutput).toContain('authAckObserved=not_applicable');
    expect(allOutput).not.toContain('authenticated=true');
  });

  // 5. private payload is never printed
  it('5. private payload is never printed; events are counted and schema-validated only', async () => {
    const socketFactory = new FakeCoinDcxSocketFactory();

    const smokePromise = runPrivateWsSmoke({
      apiKey: CANARY_API_KEY,
      apiSecret: CANARY_API_SECRET,
      socketFactory,
      timeoutMs: 2000,
      pollIntervalMs: 100,
    });

    // Advance 500ms and inject valid private events with canary payloads
    await vi.advanceTimersByTimeAsync(500);
    const socket = socketFactory.latestSocket!;

    socket.trigger('df-position-update', [
      {
        id: CANARY_POSITION_ID,
        pair: 'B-BTC_USDT',
        active_pos: '1.25',
        avg_price: '52000.5',
        liquidation_price: '45000.0',
        locked_margin: '5200.0',
        leverage: 10,
        mark_price: '52010.0',
        maintenance_margin: '520.0',
        updated_at: 1700000050000,
        margin_type: 'isolated',
        margin_currency_short_name: 'INR',
        settlement_currency_avg_price: '89.5',
      },
    ]);

    socket.trigger('df-order-update', [
      {
        id: CANARY_ORDER_ID,
        pair: 'B-BTC_USDT',
        side: 'buy',
        status: 'open',
        order_type: 'limit_order',
        leverage: 10,
        price: '51000',
        avg_price: '0',
        total_quantity: '0.1',
        remaining_quantity: '0.1',
        cancelled_quantity: '0',
        fee_amount: '0',
        created_at: 1700000050000,
        updated_at: 1700000050000,
        margin_currency_short_name: 'INR',
      },
    ]);

    socket.trigger('balance-update', [
      {
        id: 'bal-1',
        balance: CANARY_BALANCE_AMOUNT,
        locked_balance: '1000.00',
        currency_short_name: 'INR',
      },
    ]);

    await vi.advanceTimersByTimeAsync(1500);
    await smokePromise;

    const allOutput = logs.join('\n');
    // None of the private record payloads or identifiers should appear
    expect(allOutput).not.toContain(CANARY_POSITION_ID);
    expect(allOutput).not.toContain(CANARY_ORDER_ID);
    expect(allOutput).not.toContain(CANARY_BALANCE_AMOUNT);
    expect(allOutput).not.toContain('52000.5');
    expect(allOutput).not.toContain('51000');

    // Count is accurately recorded
    expect(allOutput).toContain('privateEventsObserved=3');
    expect(allOutput).toContain('[PRIVATE EVENT #1]');
    expect(allOutput).toContain('[PRIVATE EVENT #2]');
    expect(allOutput).toContain('[PRIVATE EVENT #3]');
    expect(process.exitCode).toBe(0);
  });

  // 6. no mutation API is invoked
  it('6. no mutation API is invoked (read-only transport smoke invariant)', async () => {
    // Verify script does not import or call order placement or mutation APIs
    expect(smokeScriptContent).not.toContain('createOrder');
    expect(smokeScriptContent).not.toContain('cancelOrder');
    expect(smokeScriptContent).not.toContain('setLeverage');
    expect(smokeScriptContent).not.toContain('closePosition');
    expect(smokeScriptContent).not.toContain('transferFunds');

    const socketFactory = new FakeCoinDcxSocketFactory();

    const smokePromise = runPrivateWsSmoke({
      apiKey: CANARY_API_KEY,
      apiSecret: CANARY_API_SECRET,
      socketFactory,
      timeoutMs: 1000,
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await smokePromise;

    const socket = socketFactory.latestSocket!;
    // Socket only emits 'join' (and optionally 'ping')
    const emittedEvents = socket.emitted.map((e) => e.event);
    for (const evt of emittedEvents) {
      expect(['join', 'ping']).toContain(evt);
    }

    const allOutput = logs.join('\n');
    expect(allOutput).toContain('mutationAttempted=false');
  });

  // 7. idle account with zero private events can still PASS after successful join
  it('7. idle account with zero private events can still PASS after successful join', async () => {
    const socketFactory = new FakeCoinDcxSocketFactory();

    const smokePromise = runPrivateWsSmoke({
      apiKey: CANARY_API_KEY,
      apiSecret: CANARY_API_SECRET,
      socketFactory,
      timeoutMs: 2000,
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(2000);
    await smokePromise;

    const allOutput = logs.join('\n');
    expect(process.exitCode).toBe(0);
    expect(allOutput).toContain('=== PRIVATE AUTH TRANSPORT SMOKE COMPLETE: SUCCESS ===');
    expect(allOutput).toContain('mode=PRIVATE_AUTH_TRANSPORT_SMOKE');
    expect(allOutput).toContain('privateConnectedEver=true');
    expect(allOutput).toContain('generationId=1');
    expect(allOutput).toContain('authJoinSent=true');
    expect(allOutput).toContain('authAckObserved=not_applicable');
    expect(allOutput).toContain('privateEventsObserved=0');
    expect(allOutput).toContain('connected=false');
    expect(allOutput).toContain('state=STOPPED');
  });

  // 8. failure path exits nonzero
  describe('8. failure path exits nonzero', () => {
    it('8a. missing credentials in environment exits nonzero with safe summary', async () => {
      const originalKey = process.env.COINDCX_API_KEY;
      const originalSecret = process.env.COINDCX_API_SECRET;
      delete process.env.COINDCX_API_KEY;
      delete process.env.COINDCX_API_SECRET;

      try {
        await runPrivateWsSmoke({ socketFactory: new FakeCoinDcxSocketFactory() });

        expect(process.exitCode).toBe(1);
        const allOutput = logs.join('\n');
        expect(allOutput).toContain('credentialsLoaded=false');
        expect(allOutput).toContain('credentialsPrinted=false');
        expect(allOutput).toContain('=== PRIVATE AUTH TRANSPORT SMOKE FAILED ===');
      } finally {
        if (originalKey !== undefined) process.env.COINDCX_API_KEY = originalKey;
        if (originalSecret !== undefined) process.env.COINDCX_API_SECRET = originalSecret;
      }
    });

    it('8b. socket connection error exits nonzero', async () => {
      class FailingSocket extends FakeCoinDcxSocket {
        public override connect(): void {
          this.connected = false;
          // Trigger connect error asynchronously
          setTimeout(() => {
            this.trigger('connect_error', new Error('Connection refused'));
          }, 10);
        }
      }

      class FailingSocketFactory extends FakeCoinDcxSocketFactory {
        public override createSocket(): FakeCoinDcxSocket {
          const s = new FailingSocket();
          this.createdSockets.push(s);
          return s;
        }
      }

      const smokePromise = runPrivateWsSmoke({
        apiKey: CANARY_API_KEY,
        apiSecret: CANARY_API_SECRET,
        socketFactory: new FailingSocketFactory(),
        timeoutMs: 1000,
        pollIntervalMs: 50,
      });

      await vi.advanceTimersByTimeAsync(100);
      await smokePromise;

      expect(process.exitCode).toBe(1);
      const allOutput = logs.join('\n');
      expect(allOutput).toContain('=== PRIVATE AUTH TRANSPORT SMOKE FAILED ===');
      expect(allOutput).toContain('state=STOPPED');
    });

    it('8c. deterministic transport disconnect during observation window exits nonzero', async () => {
      const socketFactory = new FakeCoinDcxSocketFactory();

      const smokePromise = runPrivateWsSmoke({
        apiKey: CANARY_API_KEY,
        apiSecret: CANARY_API_SECRET,
        socketFactory,
        timeoutMs: 2000,
        pollIntervalMs: 50,
      });

      // Socket connects and join is sent
      await vi.advanceTimersByTimeAsync(200);
      const socket = socketFactory.latestSocket!;

      // Simulate abrupt transport close during observation window
      socket.connected = false;
      socket.trigger('disconnect', 'transport close');

      // Poll interval detects disconnected state immediately
      await vi.advanceTimersByTimeAsync(100);
      await smokePromise;

      expect(process.exitCode).toBe(1);
      const allOutput = logs.join('\n');
      expect(allOutput).toContain('=== PRIVATE AUTH TRANSPORT SMOKE FAILED ===');
      expect(allOutput).toContain('state=STOPPED');
    });
  });

  // 9. all timers cleaned
  it('9. all timers are cleaned on both success and failure paths', async () => {
    const socketFactory = new FakeCoinDcxSocketFactory();

    // Success run
    const successPromise = runPrivateWsSmoke({
      apiKey: CANARY_API_KEY,
      apiSecret: CANARY_API_SECRET,
      socketFactory,
      timeoutMs: 1000,
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await successPromise;

    // Guaranteed zero active timers remaining in the runtime
    expect(vi.getTimerCount()).toBe(0);

    // Failure run
    const failPromise = runPrivateWsSmoke({
      apiKey: '',
      apiSecret: '',
      socketFactory: new FakeCoinDcxSocketFactory(),
    });
    await failPromise;
    expect(vi.getTimerCount()).toBe(0);
  });

  // 10. final stop occurs
  it('10. final stop occurs leaving connected=false and state=STOPPED', async () => {
    const socketFactory = new FakeCoinDcxSocketFactory();

    const smokePromise = runPrivateWsSmoke({
      apiKey: CANARY_API_KEY,
      apiSecret: CANARY_API_SECRET,
      socketFactory,
      timeoutMs: 1000,
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await smokePromise;

    const socket = socketFactory.latestSocket!;
    expect(socket.connected).toBe(false);
    expect(socket.disconnectCalls).toBeGreaterThanOrEqual(1);

    const allOutput = logs.join('\n');
    expect(allOutput).toContain('connected=false');
    expect(allOutput).toContain('state=STOPPED');
  });

  it('script contract: strictly avoids process.exit() and relies solely on process.exitCode', () => {
    expect(smokeScriptContent).not.toMatch(/process\.exit\s*\(/);
    expect(smokeScriptContent).toContain('process.exitCode = 0');
    expect(smokeScriptContent).toContain('process.exitCode = 1');
  });
});
