import { describe, expect, it } from 'vitest';
import {
  CoinProfile,
  CoinRegistry,
  DiscoveredCoinRuntime,
  InstrumentMetadata,
  Timeframe,
  UndiscoveredDisabledCoinRuntime,
} from '../../../src/coin-runtime';
import { Decimal } from '../../../src/core/decimal/decimal';
import { CoinRegistrationError, NotFoundError } from '../../../src/core/errors/app-error';

// Genuinely mutable test types for caller-owned fixture testing
interface MutableCoinProfile extends Omit<CoinProfile, 'timeframes' | 'strategyAssignments'> {
  enabled: boolean;
  timeframes: Timeframe[];
  strategyAssignments: { strategyId: string; enabled: boolean; parameterProfileId: string | null }[];
}

interface MutableInstrumentMetadata
  extends Omit<
    InstrumentMetadata,
    | 'pair'
    | 'timeInForceOptions'
    | 'supportedOrderTypes'
    | 'dynamicPositionLeverageTiers'
    | 'dynamicSafetyMarginTiers'
  > {
  pair: string;
  timeInForceOptions: string[];
  supportedOrderTypes: string[];
  dynamicPositionLeverageTiers: { leverage: Decimal; maxPositionSizeUsdt: Decimal }[];
  dynamicSafetyMarginTiers: { positionSizeThresholdUsdt: Decimal; maintenanceMarginPercent: Decimal }[];
}

interface MutableTarget {
  lifecycle: string;
  profile: {
    enabled: boolean;
    timeframes: string[];
    strategyAssignments: { strategyId: string; enabled: boolean; parameterProfileId: string | null }[];
  };
  instrument: {
    pair: string;
    timeInForceOptions: string[];
    supportedOrderTypes: string[];
    dynamicPositionLeverageTiers: { leverage: Decimal; maxPositionSizeUsdt: Decimal }[];
    dynamicSafetyMarginTiers: { positionSizeThresholdUsdt: Decimal; maintenanceMarginPercent: Decimal }[];
  };
}

describe('CoinRegistry & Deep Immutability Boundary Invariants', () => {
  // Deliberately UN-FROZEN, MUTABLE caller-owned fixture factory (Section 23)
  function createMutableFixture(
    underlying = 'BTC',
    pair = 'B-BTC_USDT'
  ): { profile: MutableCoinProfile; instrument: MutableInstrumentMetadata } {
    const timeframes: Timeframe[] = ['1m', '5m'];
    const strategyAssignments = [
      { strategyId: 'STRAT_ALPHA', enabled: true, parameterProfileId: 'DEFAULT' },
    ];
    const timeInForceOptions = ['GTC', 'IOC'];
    const supportedOrderTypes = ['limit_order', 'market_order'];
    const dynamicPositionLeverageTiers = [
      { leverage: new Decimal(20), maxPositionSizeUsdt: new Decimal(50000) },
      { leverage: new Decimal(10), maxPositionSizeUsdt: new Decimal(100000) },
    ];
    const dynamicSafetyMarginTiers = [
      { positionSizeThresholdUsdt: new Decimal(50000), maintenanceMarginPercent: new Decimal('2.5') },
    ];

    const profile: MutableCoinProfile = {
      underlying,
      enabled: true,
      dataEnabled: true,
      researchEnabled: true,
      paperEnabled: false,
      shadowEnabled: false,
      liveEnabled: false,
      timeframes,
      strategyAssignments,
      riskProfileId: 'DEFAULT_SAFE',
      defaultLeverage: new Decimal(1),
      configuredAbsoluteMaxLeverage: new Decimal(20),
    };

    const instrument: MutableInstrumentMetadata = {
      pair,
      underlying,
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
      legacyMaxNotionalIgnored: null,
      maxMarketOrderQuantity: null,

      makerFeePercent: new Decimal('0.02'),
      takerFeePercent: new Decimal('0.05'),
      safetyPercentage: null,
      fundingFrequency: 8,
      expiryTimeMs: null,
      exitOnly: false,
      timeInForceOptions,
      supportedOrderTypes,
      dynamicPositionLeverageTiers,
      dynamicSafetyMarginTiers,
    };

    return { profile, instrument };
  }

  it('registers discovered BTC and ETH and tracks registry size', () => {
    const registry = new CoinRegistry();
    const btc = createMutableFixture('BTC', 'B-BTC_USDT');
    const eth = createMutableFixture('ETH', 'B-ETH_USDT');

    registry.register({
      status: 'DISCOVERED',
      profile: btc.profile,
      instrument: btc.instrument,
      lifecycle: 'DISCOVERED',
      entryEligibility: 'ELIGIBLE',
    });
    expect(registry.size).toBe(1);

    registry.register({
      status: 'DISCOVERED',
      profile: eth.profile,
      instrument: eth.instrument,
      lifecycle: 'DISCOVERED',
      entryEligibility: 'ELIGIBLE',
    });
    expect(registry.size).toBe(2);
  });

  it('retrieves runtime by canonicalized and case-insensitive underlying symbol', () => {
    const registry = new CoinRegistry();
    const btc = createMutableFixture('BTC', 'B-BTC_USDT');
    registry.register({
      status: 'DISCOVERED',
      profile: btc.profile,
      instrument: btc.instrument,
      lifecycle: 'DISCOVERED',
      entryEligibility: 'ELIGIBLE',
    });

    expect(registry.hasUnderlying('BTC')).toBe(true);
    expect(registry.hasUnderlying('btc')).toBe(true);
    expect(registry.hasUnderlying('  Btc  ')).toBe(true);
    expect(registry.hasUnderlying('SOL')).toBe(false);

    const fromUpper = registry.getByUnderlying('BTC');
    const fromLower = registry.getByUnderlying('btc');
    expect(fromUpper.profile.underlying).toBe('BTC');
    expect(fromLower.profile.underlying).toBe('BTC');
  });

  it('retrieves runtime by instrument pair', () => {
    const registry = new CoinRegistry();
    const btc = createMutableFixture('BTC', 'B-BTC_USDT');
    registry.register({
      status: 'DISCOVERED',
      profile: btc.profile,
      instrument: btc.instrument,
      lifecycle: 'DISCOVERED',
      entryEligibility: 'ELIGIBLE',
    });

    expect(registry.hasPair('B-BTC_USDT')).toBe(true);
    expect(registry.hasPair('B-ETH_USDT')).toBe(false);

    const retrieved = registry.getByPair('B-BTC_USDT');
    expect(retrieved.instrument.pair).toBe('B-BTC_USDT');
    expect(retrieved.profile.underlying).toBe('BTC');
  });

  it('strictly rejects duplicate underlying symbols (case-insensitive)', () => {
    const registry = new CoinRegistry();
    const btc = createMutableFixture('BTC', 'B-BTC_USDT');
    registry.register({
      status: 'DISCOVERED',
      profile: btc.profile,
      instrument: btc.instrument,
      lifecycle: 'DISCOVERED',
      entryEligibility: 'ELIGIBLE',
    });

    const duplicateBtc = createMutableFixture('btc', 'B-BTC_ANOTHER');
    expect(() =>
      registry.register({
        status: 'DISCOVERED',
        profile: duplicateBtc.profile,
        instrument: duplicateBtc.instrument,
        lifecycle: 'DISCOVERED',
        entryEligibility: 'ELIGIBLE',
      })
    ).toThrow(CoinRegistrationError);
  });

  it('28 & 29. strictly rejects duplicate real pairs and leaves original indexes intact', () => {
    const registry = new CoinRegistry();
    const btc = createMutableFixture('BTC', 'B-BTC_USDT');
    registry.register({
      status: 'DISCOVERED',
      profile: btc.profile,
      instrument: btc.instrument,
      lifecycle: 'DISCOVERED',
      entryEligibility: 'ELIGIBLE',
    });

    const conflictingEth = createMutableFixture('ETH', 'B-BTC_USDT'); // Colliding pair!
    expect(() =>
      registry.register({
        status: 'DISCOVERED',
        profile: conflictingEth.profile,
        instrument: conflictingEth.instrument,
        lifecycle: 'DISCOVERED',
        entryEligibility: 'ELIGIBLE',
      })
    ).toThrow(CoinRegistrationError);

    // Verify original BTC registration and pair index remain completely intact
    expect(registry.size).toBe(1);
    expect(registry.hasUnderlying('BTC')).toBe(true);
    expect(registry.hasPair('B-BTC_USDT')).toBe(true);
    expect(registry.getByPair('B-BTC_USDT').profile.underlying).toBe('BTC');
    expect(registry.hasUnderlying('ETH')).toBe(false);
  });

  it('lists registered runtimes in deterministic alphabetical order', () => {
    const registry = new CoinRegistry();
    const btc = createMutableFixture('BTC', 'B-BTC_USDT');
    const eth = createMutableFixture('ETH', 'B-ETH_USDT');

    // Register ETH first, then BTC
    registry.register({
      status: 'DISCOVERED',
      profile: eth.profile,
      instrument: eth.instrument,
      lifecycle: 'DISCOVERED',
      entryEligibility: 'ELIGIBLE',
    });
    registry.register({
      status: 'DISCOVERED',
      profile: btc.profile,
      instrument: btc.instrument,
      lifecycle: 'DISCOVERED',
      entryEligibility: 'ELIGIBLE',
    });

    const list = registry.list();
    expect(list.length).toBe(2);
    expect(list[0]!.profile.underlying).toBe('BTC');
    expect(list[1]!.profile.underlying).toBe('ETH');
  });

  it('24, 25, 26. CALLER OWNERSHIP: mutating caller-owned objects AFTER register() does NOT alter registry state', () => {
    const registry = new CoinRegistry();
    const fixture = createMutableFixture('BTC', 'B-BTC_USDT');

    registry.register({
      status: 'DISCOVERED',
      profile: fixture.profile,
      instrument: fixture.instrument,
      lifecycle: 'DISCOVERED',
      entryEligibility: 'ELIGIBLE',
    });

    // Mutate caller-owned profile and instrument structures directly without any type casts
    fixture.profile.enabled = false;
    fixture.profile.timeframes.push('15m');
    fixture.profile.strategyAssignments[0]!.strategyId = 'MUTATED_STRATEGY';
    fixture.instrument.pair = 'B-MUTATED_PAIR';
    fixture.instrument.timeInForceOptions.push('FOK');
    fixture.instrument.supportedOrderTypes.push('stop_limit');
    fixture.instrument.dynamicPositionLeverageTiers[0]!.leverage = new Decimal(999);
    fixture.instrument.dynamicSafetyMarginTiers[0]!.maintenanceMarginPercent = new Decimal(99);

    // Retrieve fresh snapshot from registry
    const snapshot = registry.getByUnderlying('BTC') as DiscoveredCoinRuntime;
    expect(snapshot.profile.enabled).toBe(true);
    expect(snapshot.profile.timeframes).toEqual(['1m', '5m']);
    expect(snapshot.profile.strategyAssignments[0]!.strategyId).toBe('STRAT_ALPHA');
    expect(snapshot.instrument.pair).toBe('B-BTC_USDT');
    expect(snapshot.instrument.timeInForceOptions).toEqual(['GTC', 'IOC']);
    expect(snapshot.instrument.supportedOrderTypes).toEqual(['limit_order', 'market_order']);
    expect(snapshot.instrument.dynamicPositionLeverageTiers[0]!.leverage).toEqual(new Decimal(20));
    expect(snapshot.instrument.dynamicSafetyMarginTiers[0]!.maintenanceMarginPercent).toEqual(
      new Decimal('2.5')
    );

    // Pair index in registry remains for B-BTC_USDT, not mutated pair
    expect(registry.hasPair('B-BTC_USDT')).toBe(true);
    expect(registry.hasPair('B-MUTATED_PAIR')).toBe(false);
  });

  it('13-23. DEEP IMMUTABILITY: mutating returned snapshots throws or leaves registry state completely unaltered', () => {
    const registry = new CoinRegistry();
    const fixture = createMutableFixture('BTC', 'B-BTC_USDT');

    registry.register({
      status: 'DISCOVERED',
      profile: fixture.profile,
      instrument: fixture.instrument,
      lifecycle: 'DISCOVERED',
      entryEligibility: 'ELIGIBLE',
    });

    const snapshot = registry.getByUnderlying('BTC') as DiscoveredCoinRuntime;
    const target = snapshot as unknown as MutableTarget;

    // Mutating frozen snapshot properties throws TypeError in strict mode
    expect(() => {
      target.lifecycle = 'LIVE';
    }).toThrow(TypeError);

    expect(() => {
      target.profile.enabled = false;
    }).toThrow(TypeError);

    expect(() => {
      target.profile.timeframes.push('1h');
    }).toThrow(TypeError);

    expect(() => {
      target.profile.strategyAssignments.push({
        strategyId: 'X',
        enabled: true,
        parameterProfileId: null,
      });
    }).toThrow(TypeError);

    expect(() => {
      target.profile.strategyAssignments[0]!.strategyId = 'MUTATED';
    }).toThrow(TypeError);

    expect(() => {
      target.instrument.pair = 'B-CORRUPTED_USDT';
    }).toThrow(TypeError);

    expect(() => {
      target.instrument.timeInForceOptions.push('FOK');
    }).toThrow(TypeError);

    expect(() => {
      target.instrument.supportedOrderTypes.push('trailing_stop');
    }).toThrow(TypeError);

    expect(() => {
      target.instrument.dynamicPositionLeverageTiers.push({
        leverage: new Decimal(1),
        maxPositionSizeUsdt: new Decimal(1),
      });
    }).toThrow(TypeError);

    expect(() => {
      target.instrument.dynamicPositionLeverageTiers[0]!.leverage = new Decimal(50);
    }).toThrow(TypeError);

    expect(() => {
      target.instrument.dynamicSafetyMarginTiers[0]!.maintenanceMarginPercent =
        new Decimal(100);
    }).toThrow(TypeError);

    // 23. Verify registry internal state and pair index remain 100% consistent
    const freshSnapshot = registry.getByUnderlying('BTC') as DiscoveredCoinRuntime;
    expect(freshSnapshot.lifecycle).toBe('DISCOVERED');
    expect(freshSnapshot.profile.enabled).toBe(true);
    expect(freshSnapshot.instrument.pair).toBe('B-BTC_USDT');
    expect(registry.getByPair('B-BTC_USDT').profile.underlying).toBe('BTC');
    expect(registry.hasPair('B-CORRUPTED_USDT')).toBe(false);
  });

  it('27. PAIR INDEX: undiscovered disabled coin with instrument === null is NEVER indexed in #byPair', () => {
    const registry = new CoinRegistry();
    const disabledProfile: CoinProfile = {
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

    const disabledRuntime: UndiscoveredDisabledCoinRuntime = {
      status: 'UNDISCOVERED_DISABLED',
      profile: disabledProfile,
      instrument: null,
      lifecycle: 'DISABLED',
      entryEligibility: 'CONFIG_DISABLED',
    };

    registry.register(disabledRuntime);

    expect(registry.hasUnderlying('XRP')).toBe(true);
    const retrieved = registry.getByUnderlying('XRP');
    expect(retrieved.status).toBe('UNDISCOVERED_DISABLED');
    expect(retrieved.instrument).toBeNull();

    // Must NOT have any pair index
    expect(registry.hasPair('UNRESOLVED-XRP')).toBe(false);
    expect(registry.hasPair('B-XRP_USDT')).toBe(false);
    expect(() => registry.getByPair('UNRESOLVED-XRP')).toThrow(NotFoundError);
  });

  it('30. INDEX CONSISTENCY: lifecycle transition preserves consistent pair and underlying indexes', () => {
    const registry = new CoinRegistry();
    const btc = createMutableFixture('BTC', 'B-BTC_USDT');
    registry.register({
      status: 'DISCOVERED',
      profile: btc.profile,
      instrument: btc.instrument,
      lifecycle: 'DISCOVERED',
      entryEligibility: 'ELIGIBLE',
    });

    registry.transitionLifecycle('BTC', 'DATA_LOADING');

    const byUnderlying = registry.getByUnderlying('BTC');
    const byPair = registry.getByPair('B-BTC_USDT');

    expect(byUnderlying.lifecycle).toBe('DATA_LOADING');
    expect(byPair.lifecycle).toBe('DATA_LOADING');
    expect(byUnderlying.instrument?.pair).toBe(byPair.instrument.pair);
  });

  it('atomically replaces undiscovered runtime with discovered runtime on rediscovery', () => {
    const registry = new CoinRegistry();
    const disabledProfile: CoinProfile = {
      underlying: 'SOL',
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
      profile: disabledProfile,
      instrument: null,
      lifecycle: 'DISABLED',
      entryEligibility: 'CONFIG_DISABLED',
    });

    expect(registry.hasPair('B-SOL_USDT')).toBe(false);

    // Rediscovery installs real instrument
    const solDiscovered = createMutableFixture('SOL', 'B-SOL_USDT');
    registry.replaceOrRegisterDiscovered({
      status: 'DISCOVERED',
      profile: { ...solDiscovered.profile, enabled: true },
      instrument: solDiscovered.instrument,
      lifecycle: 'DISCOVERED',
      entryEligibility: 'ELIGIBLE',
    });

    expect(registry.hasPair('B-SOL_USDT')).toBe(true);
    const runtime = registry.getByPair('B-SOL_USDT');
    expect(runtime.status).toBe('DISCOVERED');
    expect(runtime.instrument.pair).toBe('B-SOL_USDT');
    expect(runtime.lifecycle).toBe('DISCOVERED');
  });
});
