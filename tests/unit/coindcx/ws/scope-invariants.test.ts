import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CoinDcxStreamCoordinator } from '../../../../src/integration/coindcx/websocket/coordinator';
import { FakeCoinDcxSocketFactory } from '../../../../src/integration/coindcx/websocket/socket-adapter';

function getAllTypeScriptFiles(dir: string, fileList: string[] = []): string[] {
  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = join(dir, file);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      getAllTypeScriptFiles(fullPath, fileList);
    } else if (file.endsWith('.ts')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

describe('CoinDCX WebSocket — Scope Invariants & Architectural Boundaries', () => {
  const wsDir = join(process.cwd(), 'src', 'integration', 'coindcx', 'websocket');
  const wsFiles = getAllTypeScriptFiles(wsDir);

  it('83. WebSocket layer contains NO order placement or cancellation methods', () => {
    const prohibitedOrderPatterns = [
      'orders/create',
      'orders/cancel',
      'createOrder',
      'cancelOrder',
      'placeOrder',
      'cancel_all',
    ];

    for (const filePath of wsFiles) {
      const content = readFileSync(filePath, 'utf8');
      for (const pattern of prohibitedOrderPatterns) {
        expect(
          content.includes(pattern),
          `Prohibited order method/route '${pattern}' found in WebSocket layer '${filePath}'`
        ).toBe(false);
      }
    }
  });

  it('84. WebSocket layer contains NO leverage mutation methods', () => {
    const prohibitedLeveragePatterns = [
      'update_leverage',
      'setLeverage',
      'changeLeverage',
      'modifyLeverage',
    ];

    for (const filePath of wsFiles) {
      const content = readFileSync(filePath, 'utf8');
      for (const pattern of prohibitedLeveragePatterns) {
        expect(
          content.includes(pattern),
          `Prohibited leverage mutation '${pattern}' found in WebSocket layer '${filePath}'`
        ).toBe(false);
      }
    }
  });

  it('85. WebSocket layer contains NO position exit methods', () => {
    const prohibitedExitPatterns = [
      'positions/exit',
      'closePosition',
      'exitPosition',
      'liquidatePosition',
    ];

    for (const filePath of wsFiles) {
      const content = readFileSync(filePath, 'utf8');
      for (const pattern of prohibitedExitPatterns) {
        expect(
          content.includes(pattern),
          `Prohibited position exit method '${pattern}' found in WebSocket layer '${filePath}'`
        ).toBe(false);
      }
    }
  });

  it('86. WebSocket layer contains NO wallet transfer methods', () => {
    const prohibitedTransferPatterns = [
      'wallets/transfer',
      'transferFunds',
      'withdraw',
      'deposit',
      'create_transfer',
    ];

    for (const filePath of wsFiles) {
      const content = readFileSync(filePath, 'utf8');
      for (const pattern of prohibitedTransferPatterns) {
        expect(
          content.includes(pattern),
          `Prohibited wallet transfer method '${pattern}' found in WebSocket layer '${filePath}'`
        ).toBe(false);
      }
    }
  });

  it('87. WebSocket layer does NOT import or reference Risk Engine', () => {
    const prohibitedRiskPatterns = [
      'risk-engine',
      'RiskEngine',
      'margin-calculator',
      'MarginCalculator',
      'liquidation-buffer',
    ];

    for (const filePath of wsFiles) {
      const content = readFileSync(filePath, 'utf8');
      for (const pattern of prohibitedRiskPatterns) {
        expect(
          content.includes(pattern),
          `Prohibited risk engine reference '${pattern}' found in WebSocket layer '${filePath}'`
        ).toBe(false);
      }
    }
  });

  it('88. WebSocket layer does NOT persist candle rows to database directly', () => {
    const prohibitedDbPatterns = [
      '@prisma/client',
      'prisma.',
      'candle.create',
      'candle.upsert',
      'candle.createMany',
    ];

    for (const filePath of wsFiles) {
      const content = readFileSync(filePath, 'utf8');
      for (const pattern of prohibitedDbPatterns) {
        expect(
          content.includes(pattern),
          `Prohibited database persistence reference '${pattern}' found in WebSocket layer '${filePath}'`
        ).toBe(false);
      }
    }
  });

  it('89. WebSocket layer does NOT trigger Strategy Engine or generate signals', () => {
    const prohibitedStrategyPatterns = [
      'strategy-engine',
      'StrategyEngine',
      'generateSignal',
      'evaluateSignal',
      'onSignal',
    ];

    for (const filePath of wsFiles) {
      const content = readFileSync(filePath, 'utf8');
      for (const pattern of prohibitedStrategyPatterns) {
        expect(
          content.includes(pattern),
          `Prohibited strategy engine reference '${pattern}' found in WebSocket layer '${filePath}'`
        ).toBe(false);
      }
    }
  });

  it('90. WebSocket layer does NOT mutate account state directly (emits notifications only)', () => {
    const prohibitedMutationPatterns = [
      'updateAccount',
      'mutateBalance',
      'calculateEquity',
      'deriveEquity',
      'equity =',
    ];

    for (const filePath of wsFiles) {
      const content = readFileSync(filePath, 'utf8');
      for (const pattern of prohibitedMutationPatterns) {
        expect(
          content.includes(pattern),
          `Prohibited account mutation reference '${pattern}' found in WebSocket layer '${filePath}'`
        ).toBe(false);
      }
    }
  });

  it('91. WebSocket layer does NOT reference Binance, Bybit, or any other exchange', () => {
    const prohibitedExchanges = [
      'binance',
      'bybit',
      'okx',
      'deribit',
      'kucoin',
      'bitget',
    ];

    for (const filePath of wsFiles) {
      const content = readFileSync(filePath, 'utf8').toLowerCase();
      for (const exchange of prohibitedExchanges) {
        expect(
          content.includes(exchange),
          `Prohibited foreign exchange reference '${exchange}' found in WebSocket layer '${filePath}'`
        ).toBe(false);
      }
    }
  });

  it('92. Public stream instance is shared, private stream instance is dedicated', async () => {
    const socketFactory = new FakeCoinDcxSocketFactory();
    const coordinator = new CoinDcxStreamCoordinator({
      publicConfig: { socketFactory },
      privateConfig: {
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        socketFactory,
      },
    });

    // Public stream is ONE instance shared across all coins
    expect(coordinator.publicStream).toBeDefined();
    expect(typeof coordinator.publicStream.syncSubscriptions).toBe('function');

    // Private stream is NOT auto-started by default
    expect(coordinator.privateStream).toBeNull();

    // After startPrivate, dedicated private stream is initialized and distinct from public stream
    await coordinator.startPrivate();
    expect(coordinator.privateStream).not.toBeNull();
    expect(coordinator.publicStream).not.toBe(coordinator.privateStream);
    expect(coordinator.privateStream!.connected).toBe(true);

    coordinator.stopAll();
  });
});
