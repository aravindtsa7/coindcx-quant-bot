import { describe, expect, it } from 'vitest';
import {
  CoinProfile,
  createSubscriptionIntent,
  createSubscriptionIntents,
  DiscoveredCoinRuntime,
  InstrumentMetadata,
  Timeframe,
  UndiscoveredDisabledCoinRuntime,
} from '../../../src/coin-runtime';
import { Decimal } from '../../../src/core/decimal/decimal';

describe('Market Data Subscription Intent Invariants', () => {
  const mockInstrument: InstrumentMetadata = Object.freeze({
    pair: 'B-BTC_USDT',
    underlying: 'BTC',
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
    timeInForceOptions: Object.freeze(['GTC']),
    supportedOrderTypes: Object.freeze(['limit_order']),
    dynamicPositionLeverageTiers: Object.freeze([]),
    dynamicSafetyMarginTiers: Object.freeze([]),
  });

  const btcTimeframes: readonly Timeframe[] = Object.freeze(['1m', '5m']);
  const ethTimeframes: readonly Timeframe[] = Object.freeze(['1m']);

  const activeBtcProfile: CoinProfile = Object.freeze({
    underlying: 'BTC',
    enabled: true,
    dataEnabled: true,
    researchEnabled: true,
    paperEnabled: false,
    shadowEnabled: false,
    liveEnabled: false,
    timeframes: btcTimeframes,
    strategyAssignments: Object.freeze([]),
    riskProfileId: 'DEFAULT_SAFE',
    defaultLeverage: new Decimal(1),
    configuredAbsoluteMaxLeverage: new Decimal(20),
  });

  const disabledEthProfile: CoinProfile = Object.freeze({
    underlying: 'ETH',
    enabled: false,
    dataEnabled: false,
    researchEnabled: false,
    paperEnabled: false,
    shadowEnabled: false,
    liveEnabled: false,
    timeframes: ethTimeframes,
    strategyAssignments: Object.freeze([]),
    riskProfileId: 'DEFAULT_SAFE',
    defaultLeverage: null,
    configuredAbsoluteMaxLeverage: null,
  });

  const btcRuntime: DiscoveredCoinRuntime = Object.freeze({
    status: 'DISCOVERED',
    profile: activeBtcProfile,
    instrument: mockInstrument,
    lifecycle: 'DISCOVERED',
    entryEligibility: 'ELIGIBLE',
  });

  const undiscoveredXrpRuntime: UndiscoveredDisabledCoinRuntime = Object.freeze({
    status: 'UNDISCOVERED_DISABLED',
    profile: { ...disabledEthProfile, underlying: 'XRP' },
    instrument: null,
    lifecycle: 'DISABLED',
    entryEligibility: 'CONFIG_DISABLED',
  });

  const disabledDiscoveredEthRuntime: DiscoveredCoinRuntime = Object.freeze({
    status: 'DISCOVERED',
    profile: disabledEthProfile,
    instrument: { ...mockInstrument, pair: 'B-ETH_USDT', underlying: 'ETH' },
    lifecycle: 'DISABLED',
    entryEligibility: 'CONFIG_DISABLED',
  });

  it('dataEnabled=true with valid instrument generates subscription intent with requiresOneMinuteCandles=true', () => {
    const intent = createSubscriptionIntent(btcRuntime);
    expect(intent).not.toBeNull();
    expect(intent?.underlying).toBe('BTC');
    expect(intent?.pair).toBe('B-BTC_USDT');
    expect(intent?.requiresOneMinuteCandles).toBe(true);
    expect(intent?.requiresTrades).toBe(false);
  });

  it('4. undiscovered disabled coin (instrument === null) produces null subscription intent (zero fake pairs emitted)', () => {
    const intent = createSubscriptionIntent(undiscoveredXrpRuntime);
    expect(intent).toBeNull();
  });

  it('disabled discovered coin produces null subscription intent', () => {
    const intent = createSubscriptionIntent(disabledDiscoveredEthRuntime);
    expect(intent).toBeNull();
  });

  it('collection helper createSubscriptionIntents filters out nulls and returns active intents', () => {
    const intents = createSubscriptionIntents([
      btcRuntime,
      undiscoveredXrpRuntime,
      disabledDiscoveredEthRuntime,
    ]);
    expect(intents.length).toBe(1);
    expect(intents[0]!.underlying).toBe('BTC');
    expect(intents[0]!.pair).toBe('B-BTC_USDT');
  });
});
