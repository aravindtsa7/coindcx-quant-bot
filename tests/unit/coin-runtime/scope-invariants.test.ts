import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CoinDcxDiscoveryClient,
  CoinProfile,
  CoinRegistry,
  CoinRuntimeBootstrapService,
} from '../../../src/coin-runtime';
import { Decimal } from '../../../src/core/decimal/decimal';
import { InrFuturesInstrument } from '../../../src/integration/coindcx/models';

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

describe('Phase 3 Architectural Scope & Non-Mutation Invariants', () => {
  it('43. proves production source contains zero mutating order/execution paths', () => {
    const srcDir = join(process.cwd(), 'src');
    const files = getAllTypeScriptFiles(srcDir);

    const mutatingPatterns = [
      'orders/create',
      'orders/edit',
      'orders/cancel',
      'cancel_all',
      'update_leverage',
      'add_margin',
      'remove_margin',
      'positions/exit',
      'create_tpsl',
      'wallets/transfer',
    ];

    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf8');
      for (const pattern of mutatingPatterns) {
        expect(
          content.includes(pattern),
          `Prohibited mutating pattern '${pattern}' detected in production file '${filePath}'`
        ).toBe(false);
      }
    }
  });

  it('44. proves production source contains zero WebSocket or Socket.IO implementations', () => {
    const srcDir = join(process.cwd(), 'src');
    const files = getAllTypeScriptFiles(srcDir);

    const forbiddenLibraries = ['socket.io', 'socket.io-client', 'ws'];

    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf8');
      for (const lib of forbiddenLibraries) {
        // Ensure no import statement references these libraries
        const importRegex = new RegExp(`from\\s+['"]${lib}['"]|require\\(['"]${lib}['"]\\)`);
        expect(
          importRegex.test(content),
          `Prohibited network library '${lib}' imported in production file '${filePath}'`
        ).toBe(false);
      }
    }
  });

  it('45. proves core runtime implementation contains zero hardcoded pair symbols or coin switches', () => {
    const runtimeDir = join(process.cwd(), 'src', 'coin-runtime');
    const files = getAllTypeScriptFiles(runtimeDir);

    const hardcodedPairs = ['B-BTC_USDT', 'B-ETH_USDT'];
    const coinSpecificSwitches = [
      '=== "BTC"',
      '=== \'BTC\'',
      '=== "ETH"',
      '=== \'ETH\'',
      'case "BTC"',
      'case \'BTC\'',
      'case "ETH"',
      'case \'ETH\'',
    ];

    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf8');
      for (const pair of hardcodedPairs) {
        expect(
          content.includes(pair),
          `Hardcoded pair '${pair}' found in core coin-runtime file '${filePath}'`
        ).toBe(false);
      }

      for (const branch of coinSpecificSwitches) {
        expect(
          content.includes(branch),
          `Coin-specific branch '${branch}' found in core coin-runtime file '${filePath}'`
        ).toBe(false);
      }
    }
  });

  it('46. proves adding fake XRP config requires zero changes to core runtime implementation', async () => {
    const xrpProfile: CoinProfile = {
      underlying: 'XRP',
      enabled: true,
      dataEnabled: true,
      researchEnabled: true,
      paperEnabled: false,
      shadowEnabled: false,
      liveEnabled: false,
      timeframes: ['1m', '5m', '15m'],
      strategyAssignments: [],
      riskProfileId: 'DEFAULT_SAFE',
      defaultLeverage: new Decimal(2),
      configuredAbsoluteMaxLeverage: new Decimal(10),
    };

    const mockXrpInstrument: InrFuturesInstrument = {
      pair: 'B-XRP_USDT',
      underlyingCurrency: 'XRP',
      status: 'active',
      kind: 'perpetual',
      settlement: null,
      settleCurrency: 'INR',
      quoteCurrency: 'USDT',
      positionCurrency: 'USDT',
      marginCurrency: 'INR',
      unitContractValue: new Decimal('1'),
      priceIncrement: new Decimal('0.0001'),
      quantityIncrement: new Decimal('1'),
      minTradeSize: new Decimal('1'),
      minPrice: new Decimal('0.1'),
      maxPrice: new Decimal('100'),
      minQuantity: new Decimal('1'),
      maxQuantity: new Decimal('100000'),
      minNotional: new Decimal('100'),
      maxNotional: null,
      maxMarketOrderQuantity: null,
      makerFeePercent: new Decimal('0.02'),
      takerFeePercent: new Decimal('0.05'),
      safetyPercentage: null,
      fundingFrequency: 8,
      expiryTimeMs: null,
      exitOnly: false,
      timeInForceOptions: ['GTC'],
      supportedOrderTypes: ['limit_order'],
      dynamicPositionLeverageTiers: [
        { leverage: new Decimal(10), maxPositionSizeUsdt: new Decimal(25000) },
      ],
      dynamicSafetyMarginTiers: [],
      legacyMaxLeverageLongIgnored: null,
      legacyMaxLeverageShortIgnored: null,
      raw: {},
    };

    const registry = new CoinRegistry();
    const mockClient: CoinDcxDiscoveryClient = {
      async findActiveInrPerpetualByUnderlying(underlying: string) {
        if (underlying === 'XRP') return mockXrpInstrument;
        return null;
      },
    };

    const bootstrapService = new CoinRuntimeBootstrapService(mockClient, registry);
    const result = await bootstrapService.bootstrap([xrpProfile]);

    expect(result.successful.length).toBe(1);
    expect(result.failures.length).toBe(0);

    const xrpRuntime = registry.getByUnderlying('XRP');
    expect(xrpRuntime.profile.underlying).toBe('XRP');
    expect(xrpRuntime.instrument).not.toBeNull();
    expect(xrpRuntime.instrument?.pair).toBe('B-XRP_USDT');
    expect(xrpRuntime.lifecycle).toBe('DISCOVERED');
    expect(xrpRuntime.entryEligibility).toBe('ELIGIBLE');
  });

  it('proves core runtime implementation contains zero fabricated placeholder strings (e.g. UNRESOLVED-)', () => {
    const runtimeDir = join(process.cwd(), 'src', 'coin-runtime');
    const files = getAllTypeScriptFiles(runtimeDir);

    const forbiddenPlaceholders = ['UNRESOLVED-', 'fake-pair', 'DUMMY'];

    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf8');
      for (const placeholder of forbiddenPlaceholders) {
        expect(
          content.includes(placeholder),
          `Forbidden fabricated placeholder '${placeholder}' found in core coin-runtime file '${filePath}'`
        ).toBe(false);
      }
    }
  });
});


