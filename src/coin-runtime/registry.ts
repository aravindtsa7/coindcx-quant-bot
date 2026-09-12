import { Decimal } from '../core/decimal/decimal';
import { CoinLifecycleError, CoinRegistrationError, NotFoundError } from '../core/errors/app-error';
import { logger } from '../monitoring/logger';
import { assertProductionLifecycleTransitionAuthorized, assertValidLifecycleTransition } from './lifecycle';
import { assertDataInitializationMetadata, DataReadinessInstrumentReader } from './data-readiness';
import { determineEntryEligibility, mapInstrumentToMetadata } from './instrument-mapper';
import { createSubscriptionIntent } from './subscription-intent';
import {
  CoinLifecycleState,
  CoinDataReadinessProof,
  CoinDataReadinessRecord,
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
  dataReadiness?: CoinDataReadinessRecord;
}

interface IssuedReadiness {
  readonly record: InternalDiscoveredRecord;
  readonly instrument: InstrumentMetadata;
  promotedRecord?: InternalDiscoveredRecord;
  promotedOperationRevision?: number;
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
    ...(record.dataReadiness ? { dataReadiness: record.dataReadiness } : {}),
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
  readonly #revisions = new Map<string, number>();
  readonly #lifecycleRevisions = new Map<string, number>();
  readonly #readinessProofs = new WeakMap<CoinDataReadinessProof, IssuedReadiness>();
  readonly #changeListeners = new Set<() => void>();

  public beginDiscovery(underlying: string): number {
    const key = canonicalizeUnderlying(underlying);
    const revision = (this.#revisions.get(key) ?? 0) + 1;
    this.#revisions.set(key, revision);
    return revision;
  }

  public assertDiscoveryOwner(underlying: string, revision: number): void {
    if (this.#revisions.get(canonicalizeUnderlying(underlying)) !== revision) {
      throw new CoinRegistrationError('Coin discovery operation was superseded', { underlying, reason: 'SUPERSEDED' });
    }
  }

  public subscribeChanges(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => { this.#changeListeners.delete(listener); };
  }

  #notifyChanged(underlying: string, readiness?: CoinDataReadinessProof): void {
    this.beginDiscovery(underlying); // Every lifecycle mutation revokes older async ownership.
    const lifecycleRevision = (this.#lifecycleRevisions.get(underlying) ?? 0) + 1;
    this.#lifecycleRevisions.set(underlying, lifecycleRevision);
    const record = this.#byUnderlying.get(underlying);
    if (record?.status === 'DISCOVERED') {
      delete record.dataReadiness;
      if (readiness) record.dataReadiness = Object.freeze({ lifecycleRevision, evidence: readiness });
    }
    for (const listener of [...this.#changeListeners]) {
      try { listener(); } catch { logger.error('Coin registry change listener failed'); }
    }
  }

  /**
   * Registers a newly constructed CoinRuntime.
   * Atomic operation: rejects duplicate underlyings or duplicate pairs.
   */
  public register(runtime: CoinRuntime): void {
    this.#assertInitialLifecycle(runtime);
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
      this.#notifyChanged(canonicalUnderlying);
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
    this.#notifyChanged(canonicalUnderlying);

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
    this.#assertInitialLifecycle(runtime);
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
    this.#notifyChanged(canonicalUnderlying);

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
    if (nextState === 'DATA_READY') {
      throw new CoinLifecycleError('DATA_READY requires a current registry-issued proof via promoteDataReady');
    }
    const canonical = canonicalizeUnderlying(underlying);
    const record = this.#byUnderlying.get(canonical);
    if (!record) {
      throw new NotFoundError(`Coin runtime not found for underlying '${underlying}'`, {
        underlying: canonical,
      });
    }

    const previousState = record.lifecycle;
    if (previousState === 'DISABLED' && nextState === 'DISABLED') {
      this.#notifyChanged(canonical);
      return createRuntimeSnapshot(record);
    }
    assertProductionLifecycleTransitionAuthorized(
      previousState,
      nextState,
      canonical,
      record.profile.liveEnabled
    );

    record.lifecycle = nextState;
    this.#notifyChanged(canonical);

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
    for (const underlying of this.#revisions.keys()) this.#notifyChanged(underlying);
  }

  #assertInitialLifecycle(runtime: CoinRuntime): void {
    if (runtime.lifecycle !== 'DISCOVERED' && runtime.lifecycle !== 'DISABLED') {
      throw new CoinLifecycleError('Registration must start at DISCOVERED or DISABLED; readiness must be earned');
    }
  }

  /** Executes Phase 3's mandatory initialization; only this path can issue an authentic proof. */
  public async prepareDataReadiness(underlying: string, reader: DataReadinessInstrumentReader): Promise<CoinDataReadinessProof> {
    const key = canonicalizeUnderlying(underlying);
    const record = this.#byUnderlying.get(key);
    if (!record || record.status !== 'DISCOVERED') throw new CoinLifecycleError('Readiness requires a discovered runtime');
    assertValidLifecycleTransition(record.lifecycle, 'DATA_READY', key, record.profile.liveEnabled);
    const operationRevision = this.beginDiscovery(key);
    const lifecycleRevision = this.#lifecycleRevisions.get(key)!;
    const ownsInitialization = () => this.#byUnderlying.get(key) === record &&
      this.#revisions.get(key) === operationRevision && this.#lifecycleRevisions.get(key) === lifecycleRevision;
    const assertOwner = () => {
      if (!ownsInitialization()) throw new CoinLifecycleError('Data initialization was superseded', { underlying: key, reason: 'SUPERSEDED' });
    };
    try {
      const discovered = await reader.getInrFuturesInstrument(record.instrument.pair);
      assertOwner();
      if (discovered.pair !== record.instrument.pair) throw new CoinLifecycleError('Readiness instrument pair does not match the registered pair');
      const metadata = mapInstrumentToMetadata(discovered, key);
      assertDataInitializationMetadata(record.profile, metadata);
      const intent = createSubscriptionIntent({ ...createRuntimeSnapshot(record), instrument: metadata } as DiscoveredCoinRuntime);
      if (!intent || !intent.requiresOneMinuteCandles || intent.pair !== record.instrument.pair) {
        throw new CoinLifecycleError('Mandatory one-minute data intent was not established');
      }
      assertOwner();
      const proof: CoinDataReadinessProof = Object.freeze({
        scope: 'PHASE3_METADATA_AND_DATA_INTENT', underlying: key, pair: metadata.pair,
        lifecycleRevision, operationRevision,
        completedSteps: Object.freeze(['INSTRUMENT_METADATA', 'ONE_MINUTE_DATA_INTENT'] as const),
        subscriptionIntent: intent,
      });
      this.#readinessProofs.set(proof, { record, instrument: deepCloneInstrument(metadata)! });
      return proof;
    } catch {
      assertOwner();
      throw new CoinLifecycleError('Mandatory data initialization failed', { underlying: key, pair: record.instrument.pair, reason: 'INITIALIZATION_FAILED' });
    }
  }

  /** Sole DATA_READY promotion authority. Structural lookalikes and proofs from other registries fail. */
  public promoteDataReady(underlying: string, proof: CoinDataReadinessProof): CoinRuntime {
    const key = canonicalizeUnderlying(underlying);
    const issued = proof && this.#readinessProofs.get(proof);
    const record = this.#byUnderlying.get(key);
    if (!issued || !record || record.status !== 'DISCOVERED' || proof.underlying !== key || proof.pair !== record.instrument.pair) {
      throw new CoinLifecycleError('Missing or mismatched registry-issued readiness proof');
    }
    if (record === issued.promotedRecord && record.lifecycle === 'DATA_READY' && record.dataReadiness?.evidence === proof &&
      this.#revisions.get(key) === issued.promotedOperationRevision) return createRuntimeSnapshot(record);
    if (record !== issued.record || this.#revisions.get(key) !== proof.operationRevision ||
      this.#lifecycleRevisions.get(key) !== proof.lifecycleRevision) {
      throw new CoinLifecycleError('Readiness proof was superseded', { underlying: key, reason: 'SUPERSEDED' });
    }
    assertValidLifecycleTransition(record.lifecycle, 'DATA_READY', key, record.profile.liveEnabled);
    const promoted: InternalDiscoveredRecord = { ...record, lifecycle: 'DATA_READY', instrument: issued.instrument,
      entryEligibility: determineEntryEligibility(record.profile, issued.instrument) };
    this.#byUnderlying.set(key, promoted);
    this.#byPair.set(proof.pair, promoted);
    issued.promotedRecord = promoted;
    issued.promotedOperationRevision = this.#revisions.get(key)! + 1;
    this.#notifyChanged(key, proof);
    return this.getByUnderlying(key); // A synchronous lifecycle subscriber may already have disabled it.
  }
}
