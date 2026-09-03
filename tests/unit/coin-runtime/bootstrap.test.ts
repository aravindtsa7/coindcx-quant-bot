import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CoinDcxDiscoveryClient,
  CoinProfile,
  CoinRegistry,
  CoinRuntimeBootstrapService,
  DiscoveredCoinRuntime,
  UndiscoveredDisabledCoinRuntime,
} from '../../../src/coin-runtime';
import { Decimal } from '../../../src/core/decimal/decimal';
import { AppError, NotFoundError } from '../../../src/core/errors/app-error';
import { InrFuturesInstrument } from '../../../src/integration/coindcx/models';
import { createRootLogger } from '../../../src/monitoring/logger';

describe('CoinRuntimeBootstrapService & Discovery Invariants', () => {
  function createMockInstrument(
    pair: string,
    underlying: string,
    overrides?: Partial<InrFuturesInstrument>
  ): InrFuturesInstrument {
    return {
      pair,
      underlyingCurrency: underlying,
      status: 'active',
      kind: 'perpetual',
      settlement: null,
      settleCurrency: 'INR',
      quoteCurrency: 'USDT',
      positionCurrency: 'USDT',
      marginCurrency: 'INR',
      unitContractValue: new Decimal('0.001'),
      priceIncrement: new Decimal('0.5'),
      quantityIncrement: new Decimal('0.001'),
      minTradeSize: new Decimal('0.001'),
      minPrice: new Decimal('1000'),
      maxPrice: new Decimal('500000'),
      minQuantity: new Decimal('0.001'),
      maxQuantity: new Decimal('100'),
      minNotional: new Decimal('100'),
      maxNotional: null,
      maxMarketOrderQuantity: null,
      makerFeePercent: new Decimal('0.02'),
      takerFeePercent: new Decimal('0.05'),
      safetyPercentage: null,
      fundingFrequency: 8,
      expiryTimeMs: null,
      exitOnly: false,
      timeInForceOptions: ['GTC', 'IOC'],
      supportedOrderTypes: ['limit_order', 'market_order'],
      dynamicPositionLeverageTiers: [
        { leverage: new Decimal(20), maxPositionSizeUsdt: new Decimal(50000) },
        { leverage: new Decimal(10), maxPositionSizeUsdt: new Decimal(100000) },
      ],
      dynamicSafetyMarginTiers: [
        { positionSizeThresholdUsdt: new Decimal(50000), maintenanceMarginPercent: new Decimal('2.5') },
      ],
      legacyMaxLeverageLongIgnored: new Decimal(100),
      legacyMaxLeverageShortIgnored: new Decimal(100),
      raw: {},
      ...overrides,
    };
  }

  const btcProfile: CoinProfile = {
    underlying: 'BTC',
    enabled: true,
    dataEnabled: true,
    researchEnabled: true,
    paperEnabled: false,
    shadowEnabled: false,
    liveEnabled: false,
    timeframes: ['1m', '5m'],
    strategyAssignments: [],
    riskProfileId: 'DEFAULT_SAFE',
    defaultLeverage: new Decimal(1),
    configuredAbsoluteMaxLeverage: new Decimal(20),
  };

  const ethProfile: CoinProfile = {
    underlying: 'ETH',
    enabled: true,
    dataEnabled: true,
    researchEnabled: true,
    paperEnabled: false,
    shadowEnabled: false,
    liveEnabled: false,
    timeframes: ['1m', '5m'],
    strategyAssignments: [],
    riskProfileId: 'DEFAULT_SAFE',
    defaultLeverage: new Decimal(1),
    configuredAbsoluteMaxLeverage: new Decimal(20),
  };

  const solProfile: CoinProfile = {
    underlying: 'SOL',
    enabled: true,
    dataEnabled: true,
    researchEnabled: true,
    paperEnabled: false,
    shadowEnabled: false,
    liveEnabled: false,
    timeframes: ['1m', '5m'],
    strategyAssignments: [],
    riskProfileId: 'DEFAULT_SAFE',
    defaultLeverage: new Decimal(1),
    configuredAbsoluteMaxLeverage: new Decimal(10),
  };

  it('1-5. DISABLED TRUTH: disabled undiscovered coin has instrument === null and zero fabricated metadata', async () => {
    const registry = new CoinRegistry();
    let networkCalls = 0;
    const mockClient: CoinDcxDiscoveryClient = {
      async findActiveInrPerpetualByUnderlying() {
        networkCalls++;
        return null;
      },
    };

    const disabledXrpProfile: CoinProfile = {
      underlying: 'XRP',
      enabled: false,
      dataEnabled: false,
      researchEnabled: false,
      paperEnabled: false,
      shadowEnabled: false,
      liveEnabled: false,
      timeframes: ['1m'],
      strategyAssignments: [],
      riskProfileId: 'DEFAULT_SAFE',
      defaultLeverage: null,
      configuredAbsoluteMaxLeverage: null,
    };

    const bootstrapService = new CoinRuntimeBootstrapService(mockClient, registry);
    const result = await bootstrapService.bootstrap([disabledXrpProfile]);

    expect(result.successful.length).toBe(1);
    expect(networkCalls).toBe(0); // Bypassed network discovery

    // 1. instrument === null
    const xrp = registry.getByUnderlying('XRP') as UndiscoveredDisabledCoinRuntime;
    expect(xrp.status).toBe('UNDISCOVERED_DISABLED');
    expect(xrp.instrument).toBeNull();
    expect(xrp.lifecycle).toBe('DISABLED');
    expect(xrp.entryEligibility).toBe('CONFIG_DISABLED');

    // 2. No fake pair exists
    expect(registry.hasPair('UNRESOLVED-XRP')).toBe(false);
    expect(registry.hasPair('B-XRP_USDT')).toBe(false);

    // 3. getByPair throws NotFoundError
    expect(() => registry.getByPair('UNRESOLVED-XRP')).toThrow(NotFoundError);

    // 5. Does not contain fabricated constraints
    expect('priceIncrement' in (xrp as unknown as Record<string, unknown>)).toBe(false);
    expect('minTradeSize' in (xrp as unknown as Record<string, unknown>)).toBe(false);
  });

  it('7, 8, 9. REACTIVATION: rediscovery can reactivate a disabled coin; failure leaves state untouched', async () => {
    const registry = new CoinRegistry();
    let returnValidSol = false;

    const mockClient: CoinDcxDiscoveryClient = {
      async findActiveInrPerpetualByUnderlying(underlying: string) {
        if (underlying === 'SOL' && returnValidSol) {
          return createMockInstrument('B-SOL_USDT', 'SOL');
        }
        return null;
      },
    };

    const bootstrapService = new CoinRuntimeBootstrapService(mockClient, registry);

    // 1. Initially bootstrap disabled SOL
    const disabledSolProfile: CoinProfile = {
      ...solProfile,
      enabled: false,
      dataEnabled: false,
      researchEnabled: false,
    };
    await bootstrapService.bootstrap([disabledSolProfile]);

    const initial = registry.getByUnderlying('SOL');
    expect(initial.status).toBe('UNDISCOVERED_DISABLED');
    expect(initial.instrument).toBeNull();
    expect(registry.hasPair('B-SOL_USDT')).toBe(false);

    // 8. Attempt rediscovery when network discovery fails
    await expect(bootstrapService.reactivate({ ...solProfile, enabled: true })).rejects.toThrow();
    // Verify disabled runtime remains completely unchanged
    const afterFailed = registry.getByUnderlying('SOL');
    expect(afterFailed.status).toBe('UNDISCOVERED_DISABLED');
    expect(afterFailed.instrument).toBeNull();
    expect(registry.hasPair('B-SOL_USDT')).toBe(false);

    // 7 & 9. Now allow rediscovery to succeed
    returnValidSol = true;
    const reactivated = await bootstrapService.reactivate({ ...solProfile, enabled: true });

    expect(reactivated.status).toBe('DISCOVERED');
    expect(reactivated.lifecycle).toBe('DISCOVERED');
    expect(reactivated.entryEligibility).toBe('ELIGIBLE');
    expect(reactivated.instrument).not.toBeNull();
    expect(reactivated.instrument?.pair).toBe('B-SOL_USDT');

    // 9. Pair index was installed atomically
    expect(registry.hasPair('B-SOL_USDT')).toBe(true);
    expect(registry.getByPair('B-SOL_USDT').profile.underlying).toBe('SOL');
  });

  it('generically discovers BTC, ETH, and fake SOL without hardcoded pairs', async () => {
    const registry = new CoinRegistry();
    const mockClient: CoinDcxDiscoveryClient = {
      async findActiveInrPerpetualByUnderlying(underlying: string) {
        if (underlying === 'BTC') return createMockInstrument('B-BTC_USDT', 'BTC');
        if (underlying === 'ETH') return createMockInstrument('B-ETH_USDT', 'ETH');
        if (underlying === 'SOL') return createMockInstrument('B-SOL_USDT', 'SOL');
        return null;
      },
    };

    const bootstrapService = new CoinRuntimeBootstrapService(mockClient, registry);
    const result = await bootstrapService.bootstrap([btcProfile, ethProfile, solProfile]);

    expect(result.failures.length).toBe(0);
    expect(result.successful.length).toBe(3);

    const solRuntime = registry.getByUnderlying('SOL') as DiscoveredCoinRuntime;
    expect(solRuntime.status).toBe('DISCOVERED');
    expect(solRuntime.instrument.pair).toBe('B-SOL_USDT');
    expect(solRuntime.entryEligibility).toBe('ELIGIBLE');
  });

  it('FAILURE ISOLATION: proves failure to discover ETH leaves BTC runtime intact and valid', async () => {
    const registry = new CoinRegistry();
    const mockClient: CoinDcxDiscoveryClient = {
      async findActiveInrPerpetualByUnderlying(underlying: string) {
        if (underlying === 'BTC') return createMockInstrument('B-BTC_USDT', 'BTC');
        if (underlying === 'ETH') return null;
        return null;
      },
    };

    const bootstrapService = new CoinRuntimeBootstrapService(mockClient, registry);
    const result = await bootstrapService.bootstrap([btcProfile, ethProfile]);

    expect(result.successful.length).toBe(1);
    expect(result.failures.length).toBe(1);
    expect(result.successful[0]!.profile.underlying).toBe('BTC');
    expect(result.failures[0]!.underlying).toBe('ETH');
    expect(result.failures[0]!.category).toBe('DISCOVERY_FAILED');

    expect(registry.hasUnderlying('BTC')).toBe(true);
    expect(registry.hasUnderlying('ETH')).toBe(false);
  });

  it('ATOMICITY: failed coin is not partially registered', async () => {
    const registry = new CoinRegistry();
    const mockClient: CoinDcxDiscoveryClient = {
      async findActiveInrPerpetualByUnderlying() {
        throw new Error('Network timeout during discovery');
      },
    };

    const bootstrapService = new CoinRuntimeBootstrapService(mockClient, registry);
    const result = await bootstrapService.bootstrap([btcProfile]);

    expect(result.successful.length).toBe(0);
    expect(result.failures.length).toBe(1);
    expect(registry.size).toBe(0);
    expect(registry.hasUnderlying('BTC')).toBe(false);
  });

  it('31-40. FAIL-CLOSED ENTRY ELIGIBILITY: rejects all invalid/non-positive constraints', async () => {
    const testCases: { name: string; override: Partial<InrFuturesInstrument>; expected: string }[] = [
      { name: 'zero priceIncrement', override: { priceIncrement: new Decimal(0) }, expected: 'INVALID_INSTRUMENT_METADATA' },
      { name: 'zero quantityIncrement', override: { quantityIncrement: new Decimal(0) }, expected: 'INVALID_INSTRUMENT_METADATA' },
      { name: 'zero minTradeSize', override: { minTradeSize: new Decimal(0) }, expected: 'INVALID_INSTRUMENT_METADATA' },
      { name: 'zero minPrice', override: { minPrice: new Decimal(0) }, expected: 'INVALID_INSTRUMENT_METADATA' },
      { name: 'maxPrice < minPrice', override: { minPrice: new Decimal(100), maxPrice: new Decimal(50) }, expected: 'INVALID_INSTRUMENT_METADATA' },
      { name: 'zero minNotional', override: { minNotional: new Decimal(0) }, expected: 'INVALID_INSTRUMENT_METADATA' },
      { name: 'maxQuantity < minQuantity', override: { minQuantity: new Decimal(10), maxQuantity: new Decimal(5) }, expected: 'INVALID_INSTRUMENT_METADATA' },
      { name: 'inactive status', override: { status: 'suspended' }, expected: 'INSTRUMENT_INACTIVE' },
      { name: 'exit_only true', override: { exitOnly: true }, expected: 'EXIT_ONLY' },
      { name: 'valid instrument', override: {}, expected: 'ELIGIBLE' },
    ];

    for (const tc of testCases) {
      const mockClient: CoinDcxDiscoveryClient = {
        async findActiveInrPerpetualByUnderlying() {
          return createMockInstrument('B-BTC_USDT', 'BTC', tc.override);
        },
      };

      const testRegistry = new CoinRegistry();
      const service = new CoinRuntimeBootstrapService(mockClient, testRegistry);
      await service.bootstrap([btcProfile]);

      const runtime = testRegistry.getByUnderlying('BTC');
      expect(runtime.entryEligibility, `Failed test case: ${tc.name}`).toBe(tc.expected);
    }
  });

  it('P3-F007. MAX_NOTIONAL SEMANTICS: provider-ignored max_notional has ZERO influence on entry eligibility', async () => {
    // A. maxNotional = 0, all authoritative fields valid -> ELIGIBLE
    const instA = createMockInstrument('B-BTC_USDT', 'BTC', {
      minNotional: new Decimal(100),
      maxNotional: new Decimal(0),
    });
    const registryA = new CoinRegistry();
    const clientA: CoinDcxDiscoveryClient = {
      async findActiveInrPerpetualByUnderlying() {
        return instA;
      },
    };
    await new CoinRuntimeBootstrapService(clientA, registryA).bootstrap([btcProfile]);
    const runtimeA = registryA.getByUnderlying('BTC');
    expect(runtimeA.entryEligibility).toBe('ELIGIBLE');

    // B. maxNotional positive but < minNotional, all authoritative fields valid -> ELIGIBLE
    const instB = createMockInstrument('B-BTC_USDT', 'BTC', {
      minNotional: new Decimal(100),
      maxNotional: new Decimal(10), // Lower than minNotional, but provider-ignored!
    });
    const registryB = new CoinRegistry();
    const clientB: CoinDcxDiscoveryClient = {
      async findActiveInrPerpetualByUnderlying() {
        return instB;
      },
    };
    await new CoinRuntimeBootstrapService(clientB, registryB).bootstrap([btcProfile]);
    const runtimeB = registryB.getByUnderlying('BTC');
    expect(runtimeB.entryEligibility).toBe('ELIGIBLE');

    // C. maxNotional normal positive -> ELIGIBLE
    const instC = createMockInstrument('B-BTC_USDT', 'BTC', {
      minNotional: new Decimal(100),
      maxNotional: new Decimal(100000),
    });
    const registryC = new CoinRegistry();
    const clientC: CoinDcxDiscoveryClient = {
      async findActiveInrPerpetualByUnderlying() {
        return instC;
      },
    };
    await new CoinRuntimeBootstrapService(clientC, registryC).bootstrap([btcProfile]);
    const runtimeC = registryC.getByUnderlying('BTC');
    expect(runtimeC.entryEligibility).toBe('ELIGIBLE');

    // D. Changing only maxNotional does not change eligibility
    expect(runtimeA.entryEligibility).toBe(runtimeB.entryEligibility);
    expect(runtimeB.entryEligibility).toBe(runtimeC.entryEligibility);

    // E. Runtime mapping preserves exact Decimal value as legacyMaxNotionalIgnored
    expect(runtimeA.instrument?.legacyMaxNotionalIgnored).toEqual(new Decimal(0));
    expect(runtimeB.instrument?.legacyMaxNotionalIgnored).toEqual(new Decimal(10));
    expect(runtimeC.instrument?.legacyMaxNotionalIgnored).toEqual(new Decimal(100000));
  });

  it('P3-F007-F. proves no source comments or documentation refer to maxNotional as authoritative, unbounded, or ceiling', () => {
    const filesToAudit = [
      join(process.cwd(), 'src', 'coin-runtime', 'instrument-mapper.ts'),
      join(process.cwd(), 'src', 'coin-runtime', 'types.ts'),
      join(process.cwd(), 'src', 'coin-runtime', 'registry.ts'),
      join(process.cwd(), 'src', 'coin-runtime', 'bootstrap.ts'),
      join(process.cwd(), 'docs', 'COIN_RUNTIME_LAYER.md'),
    ];

    const forbiddenPhrases = [
      'authoritative maxNotional',
      'authoritative max_notional',
      'unbounded sentinel',
      'risk ceiling',
      'unbounded',
      'unconstrained',
    ];

    for (const filePath of filesToAudit) {
      const content = readFileSync(filePath, 'utf8').toLowerCase();
      for (const phrase of forbiddenPhrases) {
        expect(
          content.includes(phrase.toLowerCase()),
          `Forbidden phrase '${phrase}' found in '${filePath}'`
        ).toBe(false);
      }
    }
  });

  it('41, 42, 43. BOOTSTRAP LOGGER & ERROR SAFETY: caught canary is NEVER in failure or actual Pino stream', async () => {
    const logChunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logChunks.push(chunk.toString('utf8'));
        callback();
      },
    });

    const testLogger = createRootLogger({
      destination: stream,
      level: 'trace',
    });

    const registry = new CoinRegistry();
    const canary = 'SUPER_SECRET_BOOTSTRAP_LOG_CANARY';

    const mockClient: CoinDcxDiscoveryClient = {
      async findActiveInrPerpetualByUnderlying() {
        throw new Error(`Crash with secret canary: ${canary}`);
      },
    };

    const bootstrapService = new CoinRuntimeBootstrapService(mockClient, registry, testLogger);
    const result = await bootstrapService.bootstrap([btcProfile]);

    expect(result.failures.length).toBe(1);
    const failure = result.failures[0]!;

    // 41. Failure message must NOT contain the canary
    expect(failure.message).not.toContain(canary);
    expect(failure.message).toBe('Coin instrument discovery failed');

    // 42. Actual serialized Pino log output must NOT contain the canary
    const serializedLogs = logChunks.join('\n');
    expect(serializedLogs).not.toContain(canary);

    // 43. Raw error object is NOT attached
    expect('rawError' in (failure as unknown as Record<string, unknown>)).toBe(false);
    expect('err' in (failure as unknown as Record<string, unknown>)).toBe(false);
    expect('stack' in (failure as unknown as Record<string, unknown>)).toBe(false);
  });

  it('P3-F005-R. REACTIVATE ERROR & LOGGER SAFETY: canary is NEVER in returned error, details, or Pino stream', async () => {
    const logChunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logChunks.push(chunk.toString('utf8'));
        callback();
      },
    });

    const testLogger = createRootLogger({
      destination: stream,
      level: 'trace',
    });

    const registry = new CoinRegistry();

    // Register initial disabled XRP
    const disabledXrpProfile: CoinProfile = {
      underlying: 'XRP',
      enabled: false,
      dataEnabled: false,
      researchEnabled: false,
      paperEnabled: false,
      shadowEnabled: false,
      liveEnabled: false,
      timeframes: ['1m'],
      strategyAssignments: [],
      riskProfileId: 'DEFAULT_SAFE',
      defaultLeverage: null,
      configuredAbsoluteMaxLeverage: null,
    };

    registry.register({
      status: 'UNDISCOVERED_DISABLED',
      profile: disabledXrpProfile,
      instrument: null,
      lifecycle: 'DISABLED',
      entryEligibility: 'CONFIG_DISABLED',
    });

    const canary = 'SUPER_SECRET_REACTIVATE_PROVIDER_CANARY';
    const mockClient: CoinDcxDiscoveryClient = {
      async findActiveInrPerpetualByUnderlying() {
        throw new Error(`Provider network fault with secret token: ${canary}`);
      },
    };

    const bootstrapService = new CoinRuntimeBootstrapService(mockClient, registry, testLogger);

    // Call reactivate and verify safe error
    try {
      await bootstrapService.reactivate({ ...disabledXrpProfile, enabled: true });
      expect.unreachable('Should have thrown AppError');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;

      // Rejected error message contains NO canary
      expect(appErr.message).not.toContain(canary);
      expect(appErr.message).toBe('Coin instrument discovery failed');

      // Details and serialized toJSON() contain NO canary
      expect(JSON.stringify(appErr.details)).not.toContain(canary);
      expect(JSON.stringify(appErr.toJSON())).not.toContain(canary);

      // Raw Error is NOT retained
      expect('rawError' in (appErr as unknown as Record<string, unknown>)).toBe(false);
      expect('err' in (appErr.details ?? {})).toBe(false);
      expect('stack' in (appErr.details ?? {})).toBe(false);
    }

    // Serialized Pino logger output contains NO canary
    const serializedLogs = logChunks.join('\n');
    expect(serializedLogs).not.toContain(canary);

    // Existing registry state remains strictly UNCHANGED
    const currentXrp = registry.getByUnderlying('XRP');
    expect(currentXrp.status).toBe('UNDISCOVERED_DISABLED');
    expect(currentXrp.instrument).toBeNull();
    expect(currentXrp.lifecycle).toBe('DISABLED');
    expect(registry.hasPair('B-XRP_USDT')).toBe(false);
  });
});
