import { describe, expect, it } from 'vitest';
import {
  canonicalizeUnderlying,
  CoinProfile,
  validateCoinProfile,
  validateCoinProfiles,
} from '../../../src/coin-runtime';
import { Decimal } from '../../../src/core/decimal/decimal';
import { CoinConfigError } from '../../../src/core/errors/app-error';

describe('Coin Profile Validation & Canonicalization', () => {
  const validBtcProfile: CoinProfile = {
    underlying: 'BTC',
    enabled: true,
    dataEnabled: true,
    researchEnabled: true,
    paperEnabled: false,
    shadowEnabled: false,
    liveEnabled: false,
    timeframes: ['1m', '5m', '15m', '1h'],
    strategyAssignments: [
      { strategyId: 'TREND_MOMENTUM_1', enabled: true, parameterProfileId: 'DEFAULT' },
    ],
    riskProfileId: 'DEFAULT_SAFE',
    defaultLeverage: new Decimal(1),
    configuredAbsoluteMaxLeverage: new Decimal(20),
  };

  const validEthProfile: CoinProfile = {
    underlying: 'ETH',
    enabled: true,
    dataEnabled: true,
    researchEnabled: true,
    paperEnabled: false,
    shadowEnabled: false,
    liveEnabled: false,
    timeframes: ['1m', '5m', '15m', '1h'],
    strategyAssignments: [],
    riskProfileId: 'DEFAULT_SAFE',
    defaultLeverage: new Decimal(2),
    configuredAbsoluteMaxLeverage: new Decimal(15),
  };

  it('1. accepts valid BTC profile and returns frozen object', () => {
    const validated = validateCoinProfile(validBtcProfile);
    expect(validated.underlying).toBe('BTC');
    expect(validated.enabled).toBe(true);
    expect(validated.dataEnabled).toBe(true);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.timeframes)).toBe(true);
  });

  it('2. accepts valid ETH profile', () => {
    const validated = validateCoinProfile(validEthProfile);
    expect(validated.underlying).toBe('ETH');
    expect(validated.riskProfileId).toBe('DEFAULT_SAFE');
  });

  it('3. canonicalizes lowercase and untrimmed underlying symbols', () => {
    expect(canonicalizeUnderlying('btc')).toBe('BTC');
    expect(canonicalizeUnderlying('  eth  ')).toBe('ETH');
    expect(canonicalizeUnderlying('sol')).toBe('SOL');
    expect(canonicalizeUnderlying('1000pepe')).toBe('1000PEPE');

    const profile = validateCoinProfile({
      ...validBtcProfile,
      underlying: '  btc  ',
    });
    expect(profile.underlying).toBe('BTC');
  });

  it('4. rejects duplicate canonical underlying symbols in collections', () => {
    const profiles = [
      validBtcProfile,
      { ...validBtcProfile, underlying: 'btc' }, // duplicate canonical symbol
    ];
    expect(() => validateCoinProfiles(profiles)).toThrow(CoinConfigError);
    expect(() => validateCoinProfiles(profiles)).toThrow(/Duplicate canonical underlying/);
  });

  it('5. rejects invalid underlying symbols (empty, whitespace, non-alphanumeric, too long)', () => {
    expect(() => canonicalizeUnderlying('')).toThrow(CoinConfigError);
    expect(() => canonicalizeUnderlying('   ')).toThrow(CoinConfigError);
    expect(() => canonicalizeUnderlying('BTC-USD')).toThrow(CoinConfigError);
    expect(() => canonicalizeUnderlying('BTC/INR')).toThrow(CoinConfigError);
    expect(() => canonicalizeUnderlying('TOOLONGASSETNAMEEXCEEDINGTWENTYCHARS')).toThrow(CoinConfigError);
  });

  it('6. rejects dataEnabled=true when mandatory 1m timeframe is missing (Invariant 6)', () => {
    const no1mProfile: CoinProfile = {
      ...validBtcProfile,
      dataEnabled: true,
      timeframes: ['5m', '15m'], // Missing 1m!
    };
    expect(() => validateCoinProfile(no1mProfile)).toThrow(CoinConfigError);
    expect(() => validateCoinProfile(no1mProfile)).toThrow(/mandatory '1m'/);
  });

  it('7. rejects disabled coin with active runtime flags (dependent flags require enabled=true)', () => {
    const disabledWithData: CoinProfile = {
      ...validBtcProfile,
      enabled: false,
      dataEnabled: true,
    };
    expect(() => validateCoinProfile(disabledWithData)).toThrow(CoinConfigError);
    expect(() => validateCoinProfile(disabledWithData)).toThrow(/dataEnabled=true but enabled=false/);

    const disabledWithResearch: CoinProfile = {
      ...validBtcProfile,
      enabled: false,
      researchEnabled: true,
    };
    expect(() => validateCoinProfile(disabledWithResearch)).toThrow(CoinConfigError);

    const disabledWithPaper: CoinProfile = {
      ...validBtcProfile,
      enabled: false,
      paperEnabled: true,
    };
    expect(() => validateCoinProfile(disabledWithPaper)).toThrow(CoinConfigError);

    const disabledWithLive: CoinProfile = {
      ...validBtcProfile,
      enabled: false,
      liveEnabled: true,
    };
    expect(() => validateCoinProfile(disabledWithLive)).toThrow(CoinConfigError);
  });

  it('8. rejects duplicate timeframes within a profile', () => {
    const duplicateTf: CoinProfile = {
      ...validBtcProfile,
      timeframes: ['1m', '5m', '1m'],
    };
    expect(() => validateCoinProfile(duplicateTf)).toThrow(CoinConfigError);
    expect(() => validateCoinProfile(duplicateTf)).toThrow(/duplicate timeframes/);
  });

  it('9. rejects duplicate strategy assignments within a profile', () => {
    const duplicateStrategy: CoinProfile = {
      ...validBtcProfile,
      strategyAssignments: [
        { strategyId: 'EMA_CROSS', enabled: true, parameterProfileId: '1' },
        { strategyId: 'EMA_CROSS', enabled: false, parameterProfileId: '2' },
      ],
    };
    expect(() => validateCoinProfile(duplicateStrategy)).toThrow(CoinConfigError);
    expect(() => validateCoinProfile(duplicateStrategy)).toThrow(/duplicate strategy assignments/);
  });

  it('10. rejects empty or whitespace-only riskProfileId', () => {
    const emptyRisk: CoinProfile = {
      ...validBtcProfile,
      riskProfileId: '   ',
    };
    expect(() => validateCoinProfile(emptyRisk)).toThrow(CoinConfigError);
  });

  it('11. rejects non-positive or non-finite leverage configurations', () => {
    const zeroLeverage: CoinProfile = {
      ...validBtcProfile,
      defaultLeverage: new Decimal(0),
    };
    expect(() => validateCoinProfile(zeroLeverage)).toThrow(CoinConfigError);

    const negativeMaxLeverage: CoinProfile = {
      ...validBtcProfile,
      configuredAbsoluteMaxLeverage: new Decimal(-5),
    };
    expect(() => validateCoinProfile(negativeMaxLeverage)).toThrow(CoinConfigError);
  });

  it('12. rejects defaultLeverage exceeding configuredAbsoluteMaxLeverage', () => {
    const invalidLeverage: CoinProfile = {
      ...validBtcProfile,
      defaultLeverage: new Decimal(25),
      configuredAbsoluteMaxLeverage: new Decimal(20),
    };
    expect(() => validateCoinProfile(invalidLeverage)).toThrow(CoinConfigError);
    expect(() => validateCoinProfile(invalidLeverage)).toThrow(/cannot exceed configuredAbsoluteMaxLeverage/);
  });

  it('13. preserves exact Decimal precision for leverage and accepts null leverage bounds', () => {
    const preciseLeverage: CoinProfile = {
      ...validBtcProfile,
      defaultLeverage: new Decimal('3.5'),
      configuredAbsoluteMaxLeverage: new Decimal('12.75'),
    };
    const validated = validateCoinProfile(preciseLeverage);
    expect(validated.defaultLeverage).toEqual(new Decimal('3.5'));
    expect(validated.configuredAbsoluteMaxLeverage).toEqual(new Decimal('12.75'));

    const nullLeverage: CoinProfile = {
      ...validBtcProfile,
      defaultLeverage: null,
      configuredAbsoluteMaxLeverage: null,
    };
    const validatedNull = validateCoinProfile(nullLeverage);
    expect(validatedNull.defaultLeverage).toBeNull();
    expect(validatedNull.configuredAbsoluteMaxLeverage).toBeNull();
  });

  it('loads and validates DEFAULT_COIN_PROFILES via loadCoinProfiles()', async () => {
    const { loadCoinProfiles, DEFAULT_COIN_PROFILES } = await import('../../../src/app/config/coins');
    const profiles = loadCoinProfiles();
    expect(profiles.length).toBe(2);
    expect(profiles[0]!.underlying).toBe('BTC');
    expect(profiles[1]!.underlying).toBe('ETH');
    expect(DEFAULT_COIN_PROFILES.length).toBe(2);
  });
});

