import { Decimal } from '../core/decimal/decimal';
import { CoinRegistrationError, NotFoundError } from '../core/errors/app-error';
import { logger } from '../monitoring/logger';
import { assertValidLifecycleTransition } from './lifecycle';
import {
  CoinLifecycleState,
  CoinProfile,
  CoinRuntime,
  DiscoveredCoinRuntime,
  InstrumentMetadata,
  UndiscoveredDisabledCoinRuntime,
} from './types';
import { canonicalizeUnderlying } from './validation';

function cloneDecimal(d: Decimal | null): Decimal | null {
  return d ? new Decimal(d.toString()) : null;
}

/**
 * Deep clones a CoinProfile, ensuring all nested arrays, objects, and Decimals
 * are detached from caller references and deeply frozen.
 */
export function deepCloneProfile(profile: CoinProfile): CoinProfile {
  return Object.freeze({
    underlying: profile.underlying,
    enabled: profile.enabled,
    dataEnabled: profile.dataEnabled,
    researchEnabled: profile.researchEnabled,
    paperEnabled: profile.paperEnabled,
    shadowEnabled: profile.shadowEnabled,
    liveEnabled: profile.liveEnabled,
    timeframes: Object.freeze([...profile.timeframes]),
    strategyAssignments: Object.freeze(
      profile.strategyAssignments.map((s) =>
        Object.freeze({
          strategyId: s.strategyId,
          enabled: s.enabled,
          parameterProfileId: s.parameterProfileId,
        })
      )
    ),
    riskProfileId: profile.riskProfileId,
    defaultLeverage: cloneDecimal(profile.defaultLeverage),
    configuredAbsoluteMaxLeverage: cloneDecimal(profile.configuredAbsoluteMaxLeverage),
  });
}

/**
 * Deep clones an InstrumentMetadata, ensuring all nested arrays, tier objects,
 * and Decimals are detached from caller references and deeply frozen.
 */
export function deepCloneInstrument(
  instrument: InstrumentMetadata | null
): InstrumentMetadata | null {
  if (!instrument) return null;

  return Object.freeze({
    pair: instrument.pair,
    underlying: instrument.underlying,
    status: instrument.status,
    kind: instrument.kind,
    settlement: instrument.settlement,
    settleCurrency: instrument.settleCurrency,
    quoteCurrency: instrument.quoteCurrency,
    positionCurrency: instrument.positionCurrency,
    marginCurrency: 'INR',
    unitContractValue: new Decimal(instrument.unitContractValue.toString()),
    priceIncrement: new Decimal(instrument.priceIncrement.toString()),
    quantityIncrement: new Decimal(instrument.quantityIncrement.toString()),
    minTradeSize: new Decimal(instrument.minTradeSize.toString()),
    minPrice: new Decimal(instrument.minPrice.toString()),
    maxPrice: new Decimal(instrument.maxPrice.toString()),
    minQuantity: new Decimal(instrument.minQuantity.toString()),
    maxQuantity: new Decimal(instrument.maxQuantity.toString()),
    minNotional: new Decimal(instrument.minNotional.toString()),
    legacyMaxNotionalIgnored: cloneDecimal(instrument.legacyMaxNotionalIgnored),
    maxMarketOrderQuantity: cloneDecimal(instrument.maxMarketOrderQuantity),

    makerFeePercent: new Decimal(instrument.makerFeePercent.toString()),
    takerFeePercent: new Decimal(instrument.takerFeePercent.toString()),
    safetyPercentage: cloneDecimal(instrument.safetyPercentage),
    fundingFrequency: instrument.fundingFrequency,
    expiryTimeMs: instrument.expiryTimeMs,
    exitOnly: instrument.exitOnly,
    timeInForceOptions: Object.freeze([...instrument.timeInForceOptions]),
    supportedOrderTypes: Object.freeze([...instrument.supportedOrderTypes]),
    dynamicPositionLeverageTiers: Object.freeze(
      instrument.dynamicPositionLeverageTiers.map((t) =>
        Object.freeze({
          leverage: new Decimal(t.leverage.toString()),
          maxPositionSizeUsdt: new Decimal(t.maxPositionSizeUsdt.toString()),
        })
      )
    ),
    dynamicSafetyMarginTiers: Object.freeze(
      instrument.dynamicSafetyMarginTiers.map((t) =>
        Object.freeze({
          positionSizeThresholdUsdt: new Decimal(t.positionSizeThresholdUsdt.toString()),
          maintenanceMarginPercent: new Decimal(t.maintenanceMarginPercent.toString()),
        })
      )
    ),
  });
}

interface InternalUndiscoveredDisabledRecord {
  readonly status: 'UNDISCOVERED_DISABLED';
  readonly profile: CoinProfile;
  readonly instrument: null;
  lifecycle: 'DISABLED';
  readonly entryEligibility: 'CONFIG_DISABLED';
}

interface InternalDiscoveredRecord {
  readonly status: 'DISCOVERED';
  readonly profile: CoinProfile;
  readonly instrument: InstrumentMetadata;
  lifecycle: CoinLifecycleState;
  readonly entryEligibility: DiscoveredCoinRuntime['entryEligibility'];
}

type InternalCoinRecord = InternalDiscoveredRecord | InternalUndiscoveredDisabledRecord;

function createRuntimeSnapshot(record: InternalCoinRecord): CoinRuntime {
  const clonedProfile = deepCloneProfile(record.profile);

  if (record.status === 'UNDISCOVERED_DISABLED' || record.instrument === null) {
    const snapshot: UndiscoveredDisabledCoinRuntime = Object.freeze({
      status: 'UNDISCOVERED_DISABLED',
      profile: clonedProfile,
      instrument: null,
      lifecycle: 'DISABLED',
      entryEligibility: 'CONFIG_DISABLED',
    });
    return snapshot;
  }

  const clonedInstrument = deepCloneInstrument(record.instrument)!;
  const snapshot: DiscoveredCoinRuntime = Object.freeze({
    status: 'DISCOVERED',
    profile: clonedProfile,
    instrument: clonedInstrument,
    lifecycle: record.lifecycle,
    entryEligibility: record.entryEligibility,
  });
  return snapshot;
}

/**
 * In-memory registry managing isolated, canonical CoinRuntime containers.
 *
 * Immutability & Index Invariants:
 * - Deep cloning at registration and query boundaries; caller mutations can never alter internal truth.
 * - Undiscovered disabled coins have instrument === null and are NEVER indexed in #byPair.
 * - Discovered coins with validated exchange pairs are indexed in both #byUnderlying and #byPair.
 * - Mutating any returned snapshot or its nested arrays/objects throws a TypeError in strict mode
 *   and has zero effect on registry state.
 * - Index consistency: getByUnderlying and getByPair describe the exact same logical runtime.
 */
export class CoinRegistry {
  readonly #byUnderlying = new Map<string, InternalCoinRecord>();
  readonly #byPair = new Map<string, InternalDiscoveredRecord>();

  /**
   * Registers a newly constructed CoinRuntime.
   * Atomic operation: rejects duplicate underlyings or duplicate pairs.
   */
  public register(runtime: CoinRuntime): void {
    const canonicalUnderlying = canonicalizeUnderlying(runtime.profile.underlying);

    if (this.#byUnderlying.has(canonicalUnderlying)) {
      throw new CoinRegistrationError(
        `Coin with underlying symbol '${canonicalUnderlying}' is already registered`,
        { underlying: canonicalUnderlying }
      );
    }

    const clonedProfile = deepCloneProfile(runtime.profile);

    if (runtime.instrument === null) {
      // Undiscovered disabled coin: register in underlying index only. No fake pair index.
      const record: InternalUndiscoveredDisabledRecord = {
        status: 'UNDISCOVERED_DISABLED',
        profile: clonedProfile,
        instrument: null,
        lifecycle: 'DISABLED',
        entryEligibility: 'CONFIG_DISABLED',
      };
      this.#byUnderlying.set(canonicalUnderlying, record);
      logger.info(
        { underlying: canonicalUnderlying, lifecycle: 'DISABLED' },
        'Registered undiscovered disabled coin runtime'
      );
      return;
    }

    // Discovered runtime with authoritative exchange instrument
    const pair = runtime.instrument.pair.trim();

    if (this.#byPair.has(pair)) {
      throw new CoinRegistrationError(
        `Coin with instrument pair '${pair}' is already registered`,
        { underlying: canonicalUnderlying, pair }
      );
    }

    const clonedInstrument = deepCloneInstrument(runtime.instrument)!;
    const record: InternalDiscoveredRecord = {
      status: 'DISCOVERED',
      profile: clonedProfile,
      instrument: clonedInstrument,
      lifecycle: runtime.lifecycle,
      entryEligibility: runtime.entryEligibility,
    };

    this.#byUnderlying.set(canonicalUnderlying, record);
    this.#byPair.set(pair, record);

    logger.info(
      {
        underlying: canonicalUnderlying,
        pair,
        lifecycle: record.lifecycle,
        entryEligibility: record.entryEligibility,
      },
      'Coin runtime registered in CoinRegistry'
    );
  }

  /**
   * Atomically installs or replaces a discovered coin runtime (e.g. following network rediscovery).
   * Ensures pair indexes remain strictly synchronized.
   */
  public replaceOrRegisterDiscovered(runtime: DiscoveredCoinRuntime): CoinRuntime {
    const canonicalUnderlying = canonicalizeUnderlying(runtime.profile.underlying);
    const newPair = runtime.instrument.pair.trim();

    const existingPairRecord = this.#byPair.get(newPair);
    if (
      existingPairRecord &&
      canonicalizeUnderlying(existingPairRecord.profile.underlying) !== canonicalUnderlying
    ) {
      throw new CoinRegistrationError(
        `Instrument pair '${newPair}' is already registered to another coin '${existingPairRecord.profile.underlying}'`,
        { underlying: canonicalUnderlying, pair: newPair }
      );
    }

    const existingRecord = this.#byUnderlying.get(canonicalUnderlying);
    if (existingRecord && existingRecord.instrument !== null) {
      const oldPair = existingRecord.instrument.pair.trim();
      if (oldPair !== newPair) {
        this.#byPair.delete(oldPair);
      }
    }

    const clonedProfile = deepCloneProfile(runtime.profile);
    const clonedInstrument = deepCloneInstrument(runtime.instrument)!;

    const record: InternalDiscoveredRecord = {
      status: 'DISCOVERED',
      profile: clonedProfile,
      instrument: clonedInstrument,
      lifecycle: runtime.lifecycle,
      entryEligibility: runtime.entryEligibility,
    };

    this.#byUnderlying.set(canonicalUnderlying, record);
    this.#byPair.set(newPair, record);

    logger.info(
      {
        underlying: canonicalUnderlying,
        pair: newPair,
        lifecycle: record.lifecycle,
        entryEligibility: record.entryEligibility,
      },
      'Installed/rediscovered coin runtime in CoinRegistry'
    );

    return createRuntimeSnapshot(record);
  }

  /**
   * Retrieves an immutable, deeply cloned snapshot of a coin runtime by underlying symbol.
   */
  public getByUnderlying(underlying: string): CoinRuntime {
    const canonical = canonicalizeUnderlying(underlying);
    const record = this.#byUnderlying.get(canonical);
    if (!record) {
      throw new NotFoundError(`Coin runtime not found for underlying '${underlying}'`, {
        underlying: canonical,
      });
    }
    return createRuntimeSnapshot(record);
  }

  /**
   * Retrieves an immutable, deeply cloned snapshot of a discovered coin runtime by pair.
   * Throws NotFoundError for undiscovered coins or unknown pairs.
   */
  public getByPair(pair: string): DiscoveredCoinRuntime {
    const normalizedPair = pair.trim();
    const record = this.#byPair.get(normalizedPair);
    if (!record) {
      throw new NotFoundError(`Coin runtime not found for instrument pair '${pair}'`, {
        pair: normalizedPair,
      });
    }
    return createRuntimeSnapshot(record) as DiscoveredCoinRuntime;
  }

  /**
   * Returns true if a runtime exists for the canonical underlying.
   */
  public hasUnderlying(underlying: string): boolean {
    try {
      const canonical = canonicalizeUnderlying(underlying);
      return this.#byUnderlying.has(canonical);
    } catch {
      return false;
    }
  }

  /**
   * Returns true if a discovered runtime exists for the instrument pair.
   */
  public hasPair(pair: string): boolean {
    return this.#byPair.has(pair.trim());
  }

  /**
   * Lists all registered coin runtimes, deterministically sorted alphabetically by underlying.
   */
  public list(): readonly CoinRuntime[] {
    const records = Array.from(this.#byUnderlying.values());
    records.sort((a, b) => a.profile.underlying.localeCompare(b.profile.underlying));
    return Object.freeze(records.map(createRuntimeSnapshot));
  }

  /**
   * Lists all enabled coin runtimes, deterministically sorted alphabetically by underlying.
   */
  public listEnabled(): readonly CoinRuntime[] {
    return Object.freeze(
      this.list().filter((runtime) => runtime.profile.enabled)
    );
  }

  /**
   * Transitions an active coin's lifecycle to a new valid state.
   *
   * Invariant Guarantees:
   * - Cannot transition out of DISABLED (requires external rediscovery).
   * - Transition to LIVE strictly validates profile.liveEnabled === true.
   * - Caller cannot mutate state through returned snapshots.
   */
  public transitionLifecycle(
    underlying: string,
    nextState: CoinLifecycleState
  ): CoinRuntime {
    const canonical = canonicalizeUnderlying(underlying);
    const record = this.#byUnderlying.get(canonical);
    if (!record) {
      throw new NotFoundError(`Coin runtime not found for underlying '${underlying}'`, {
        underlying: canonical,
      });
    }

    const previousState = record.lifecycle;
    assertValidLifecycleTransition(
      previousState,
      nextState,
      canonical,
      record.profile.liveEnabled
    );

    record.lifecycle = nextState;

    logger.info(
      {
        underlying: canonical,
        pair: record.instrument ? record.instrument.pair : null,
        fromLifecycle: previousState,
        toLifecycle: nextState,
      },
      'Coin lifecycle state transitioned'
    );

    return createRuntimeSnapshot(record);
  }

  /**
   * Returns count of registered runtimes.
   */
  public get size(): number {
    return this.#byUnderlying.size;
  }

  /**
   * Clears all registrations (useful in test suites).
   */
  public clear(): void {
    this.#byUnderlying.clear();
    this.#byPair.clear();
  }
}
