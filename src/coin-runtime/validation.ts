import { z } from 'zod';
import { Decimal } from '../core/decimal/decimal';
import { CoinConfigError } from '../core/errors/app-error';
import {
  CoinProfile,
  StrategyAssignment,
  Timeframe,
  VALID_TIMEFRAMES,
} from './types';

const UNDERLYING_SYMBOL_REGEX = /^[A-Z0-9]{1,20}$/;

/**
 * Validates and canonicalizes an underlying asset symbol.
 * Trims whitespace, converts to uppercase, and verifies format.
 */
export function canonicalizeUnderlying(raw: string): string {
  if (!raw || typeof raw !== 'string') {
    throw new CoinConfigError('Underlying symbol must be a non-empty string', {
      raw,
    });
  }

  const canonical = raw.trim().toUpperCase();

  if (canonical.length === 0) {
    throw new CoinConfigError('Underlying symbol cannot be empty or whitespace only', {
      raw,
    });
  }

  if (!UNDERLYING_SYMBOL_REGEX.test(canonical)) {
    throw new CoinConfigError(
      `Underlying symbol '${canonical}' does not match expected alphanumeric pattern /^[A-Z0-9]{1,20}$/`,
      { canonical, raw }
    );
  }

  return canonical;
}

const StrategyAssignmentSchema = z.object({
  strategyId: z.string().trim().min(1, 'strategyId must be a non-empty string'),
  enabled: z.boolean(),
  parameterProfileId: z.string().trim().min(1).nullable(),
});

/**
 * Zod schema for validating raw coin profile input.
 */
export const CoinProfileInputSchema = z
  .object({
    underlying: z.string().trim().min(1),
    enabled: z.boolean(),
    dataEnabled: z.boolean(),
    researchEnabled: z.boolean(),
    paperEnabled: z.boolean(),
    shadowEnabled: z.boolean(),
    liveEnabled: z.boolean(),
    timeframes: z
      .array(z.enum(VALID_TIMEFRAMES as [Timeframe, ...Timeframe[]]))
      .min(1, 'At least one timeframe must be specified'),
    strategyAssignments: z.array(StrategyAssignmentSchema),
    riskProfileId: z
      .string()
      .trim()
      .min(1, 'riskProfileId must be a non-empty string'),
    defaultLeverage: z.custom<Decimal | null>(
      (val) => val === null || val instanceof Decimal,
      { message: 'defaultLeverage must be a Decimal instance or null' }
    ),
    configuredAbsoluteMaxLeverage: z.custom<Decimal | null>(
      (val) => val === null || val instanceof Decimal,
      { message: 'configuredAbsoluteMaxLeverage must be a Decimal instance or null' }
    ),
  })
  .strict();

export type CoinProfileInput = z.infer<typeof CoinProfileInputSchema>;

/**
 * Validates a single CoinProfile against all Phase 3 invariant rules.
 */
export function validateCoinProfile(profile: CoinProfile): CoinProfile {
  const canonicalUnderlying = canonicalizeUnderlying(profile.underlying);

  // Parse using schema for basic type & non-empty requirements
  const parsed = CoinProfileInputSchema.safeParse(profile);
  if (!parsed.success) {
    throw new CoinConfigError(
      `Invalid coin configuration for '${profile.underlying}': ${parsed.error.message}`,
      { issues: parsed.error.issues, underlying: profile.underlying }
    );
  }

  // Dependent flag invariant: dependent active flags mandate enabled = true
  if (profile.dataEnabled && !profile.enabled) {
    throw new CoinConfigError(
      `Coin '${canonicalUnderlying}' has dataEnabled=true but enabled=false. Dependent flags require enabled=true.`,
      { underlying: canonicalUnderlying }
    );
  }
  if (profile.researchEnabled && !profile.enabled) {
    throw new CoinConfigError(
      `Coin '${canonicalUnderlying}' has researchEnabled=true but enabled=false. Dependent flags require enabled=true.`,
      { underlying: canonicalUnderlying }
    );
  }
  if (profile.paperEnabled && !profile.enabled) {
    throw new CoinConfigError(
      `Coin '${canonicalUnderlying}' has paperEnabled=true but enabled=false. Dependent flags require enabled=true.`,
      { underlying: canonicalUnderlying }
    );
  }
  if (profile.shadowEnabled && !profile.enabled) {
    throw new CoinConfigError(
      `Coin '${canonicalUnderlying}' has shadowEnabled=true but enabled=false. Dependent flags require enabled=true.`,
      { underlying: canonicalUnderlying }
    );
  }
  if (profile.liveEnabled && !profile.enabled) {
    throw new CoinConfigError(
      `Coin '${canonicalUnderlying}' has liveEnabled=true but enabled=false. Dependent flags require enabled=true.`,
      { underlying: canonicalUnderlying }
    );
  }

  // Invariant 6: 1m is foundational source of truth. Any coin with dataEnabled=true MUST configure 1m.
  if (profile.dataEnabled && !profile.timeframes.includes('1m')) {
    throw new CoinConfigError(
      `Coin '${canonicalUnderlying}' has dataEnabled=true but timeframes does not include mandatory '1m'`,
      { underlying: canonicalUnderlying, timeframes: profile.timeframes }
    );
  }

  // Duplicate timeframe check
  const timeframeSet = new Set(profile.timeframes);
  if (timeframeSet.size !== profile.timeframes.length) {
    throw new CoinConfigError(
      `Coin '${canonicalUnderlying}' contains duplicate timeframes`,
      { underlying: canonicalUnderlying, timeframes: profile.timeframes }
    );
  }

  // Duplicate strategy assignment check
  const strategyIds = profile.strategyAssignments.map((s) => s.strategyId);
  const strategyIdSet = new Set(strategyIds);
  if (strategyIdSet.size !== strategyIds.length) {
    throw new CoinConfigError(
      `Coin '${canonicalUnderlying}' contains duplicate strategy assignments`,
      { underlying: canonicalUnderlying, strategyIds }
    );
  }

  // Leverage configuration finite positive checks
  if (profile.defaultLeverage !== null) {
    if (
      !profile.defaultLeverage.isFinite() ||
      profile.defaultLeverage.isNaN() ||
      profile.defaultLeverage.lessThanOrEqualTo(0)
    ) {
      throw new CoinConfigError(
        `Coin '${canonicalUnderlying}' defaultLeverage must be a finite positive Decimal`,
        { underlying: canonicalUnderlying, defaultLeverage: profile.defaultLeverage.toString() }
      );
    }
  }

  if (profile.configuredAbsoluteMaxLeverage !== null) {
    if (
      !profile.configuredAbsoluteMaxLeverage.isFinite() ||
      profile.configuredAbsoluteMaxLeverage.isNaN() ||
      profile.configuredAbsoluteMaxLeverage.lessThanOrEqualTo(0)
    ) {
      throw new CoinConfigError(
        `Coin '${canonicalUnderlying}' configuredAbsoluteMaxLeverage must be a finite positive Decimal`,
        {
          underlying: canonicalUnderlying,
          configuredAbsoluteMaxLeverage: profile.configuredAbsoluteMaxLeverage.toString(),
        }
      );
    }
  }

  if (profile.defaultLeverage !== null && profile.configuredAbsoluteMaxLeverage !== null) {
    if (profile.defaultLeverage.greaterThan(profile.configuredAbsoluteMaxLeverage)) {
      throw new CoinConfigError(
        `Coin '${canonicalUnderlying}' defaultLeverage (${profile.defaultLeverage}) cannot exceed configuredAbsoluteMaxLeverage (${profile.configuredAbsoluteMaxLeverage})`,
        {
          underlying: canonicalUnderlying,
          defaultLeverage: profile.defaultLeverage.toString(),
          configuredAbsoluteMaxLeverage: profile.configuredAbsoluteMaxLeverage.toString(),
        }
      );
    }
  }

  return Object.freeze({
    underlying: canonicalUnderlying,
    enabled: profile.enabled,
    dataEnabled: profile.dataEnabled,
    researchEnabled: profile.researchEnabled,
    paperEnabled: profile.paperEnabled,
    shadowEnabled: profile.shadowEnabled,
    liveEnabled: profile.liveEnabled,
    timeframes: Object.freeze([...profile.timeframes]),
    strategyAssignments: Object.freeze(
      profile.strategyAssignments.map((s: StrategyAssignment) =>
        Object.freeze({
          strategyId: s.strategyId,
          enabled: s.enabled,
          parameterProfileId: s.parameterProfileId,
        })
      )
    ),
    riskProfileId: profile.riskProfileId.trim(),
    defaultLeverage: profile.defaultLeverage,
    configuredAbsoluteMaxLeverage: profile.configuredAbsoluteMaxLeverage,
  });
}

/**
 * Validates a collection of coin profiles, guaranteeing global uniqueness across canonical underlyings.
 */
export function validateCoinProfiles(
  profiles: readonly CoinProfile[]
): readonly CoinProfile[] {
  if (!Array.isArray(profiles)) {
    throw new CoinConfigError('Coin profiles collection must be an array');
  }

  const seenUnderlyings = new Set<string>();
  const validatedProfiles: CoinProfile[] = [];

  for (const profile of profiles) {
    const validated = validateCoinProfile(profile);
    if (seenUnderlyings.has(validated.underlying)) {
      throw new CoinConfigError(
        `Duplicate canonical underlying symbol detected in configuration: '${validated.underlying}'`,
        { underlying: validated.underlying }
      );
    }
    seenUnderlyings.add(validated.underlying);
    validatedProfiles.push(validated);
  }

  return Object.freeze(validatedProfiles);
}

