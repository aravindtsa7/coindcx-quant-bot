import pino from 'pino';
import {
  CoinConfigError,
  CoinDiscoveryError,
  CoinRegistrationError,
} from '../core/errors/app-error';
import { InrFuturesInstrument } from '../integration/coindcx/models';
import { logger as defaultLogger } from '../monitoring/logger';
import { determineEntryEligibility, mapInstrumentToMetadata } from './instrument-mapper';
import { CoinRegistry } from './registry';
import {
  CoinBootstrapFailure,
  CoinBootstrapFailureCategory,
  CoinBootstrapResult,
  CoinEntryEligibility,
  CoinProfile,
  CoinRuntime,
  DiscoveredCoinRuntime,
  InstrumentMetadata,
  UndiscoveredDisabledCoinRuntime,
} from './types';
import {
  canonicalizeUnderlying,
  validateCoinProfile,
  validateCoinProfiles,
} from './validation';

/**
 * Minimal interface for CoinDCX discovery required by the bootstrap service.
 * Decouples bootstrap service from concrete transport implementation.
 */
export interface CoinDcxDiscoveryClient {
  findActiveInrPerpetualByUnderlying(
    underlying: string
  ): Promise<InrFuturesInstrument | null>;
}

/**
 * Deterministic safe failure messages by category.
 * Prevents reflection of untrusted raw provider error messages or secret leaks into logs/results.
 */
const FAILURE_MESSAGES: Readonly<Record<CoinBootstrapFailureCategory, string>> = Object.freeze({
  CONFIG_ERROR: 'Coin runtime configuration validation failed',
  DISCOVERY_FAILED: 'Coin instrument discovery failed',
  MAPPING_FAILED: 'Coin instrument mapping failed',
  REGISTRATION_FAILED: 'Coin runtime registration failed',
  ELIGIBILITY_FAILED: 'Coin instrument eligibility validation failed',
});

/**
 * Service responsible for bootstrapping and reactivating CoinRuntime containers from
 * configuration profiles and generic CoinDCX exchange instrument discovery.
 *
 * Invariant Guarantees:
 * - Failure isolation: One coin's discovery failure never corrupts or aborts other coins.
 * - Atomicity per coin: Incomplete or failed discovery never results in partial registration.
 * - Zero fabricated exchange truth: Disabled undiscovered coins have instrument === null.
 * - Reactivation requires real network rediscovery; ordinary lifecycle transitions cannot exit DISABLED.
 * - Safe error model: Untrusted caught error messages, stacks, or secrets are never reflected into logs or results.
 */
export class CoinRuntimeBootstrapService {
  readonly #discoveryClient: CoinDcxDiscoveryClient;
  readonly #registry: CoinRegistry;
  readonly #logger: pino.Logger;

  constructor(
    discoveryClient: CoinDcxDiscoveryClient,
    registry: CoinRegistry = new CoinRegistry(),
    serviceLogger: pino.Logger = defaultLogger
  ) {
    this.#discoveryClient = discoveryClient;
    this.#registry = registry;
    this.#logger = serviceLogger;
  }

  public get registry(): CoinRegistry {
    return this.#registry;
  }

  /**
   * Bootstraps all supplied coin profiles against CoinDCX instrument discovery.
   */
  public async bootstrap(
    profiles: readonly CoinProfile[]
  ): Promise<CoinBootstrapResult> {
    this.#logger.info(
      { profileCount: profiles.length },
      'Starting Coin Runtime bootstrap process'
    );

    const validatedProfiles = validateCoinProfiles(profiles);
    const successful: CoinRuntime[] = [];
    const failures: CoinBootstrapFailure[] = [];
    const seenPairs = new Set<string>();

    for (const profile of validatedProfiles) {
      const canonicalUnderlying = canonicalizeUnderlying(profile.underlying);

      try {
        if (!profile.enabled) {
          // Undiscovered disabled coin: NO fabricated instrument metadata.
          // Truthful representation: instrument === null, no fake pair index.
          const disabledRuntime: UndiscoveredDisabledCoinRuntime = Object.freeze({
            status: 'UNDISCOVERED_DISABLED',
            profile,
            instrument: null,
            lifecycle: 'DISABLED',
            entryEligibility: 'CONFIG_DISABLED',
          });

          this.#registry.register(disabledRuntime);
          successful.push(disabledRuntime);
          this.#logger.info(
            { underlying: canonicalUnderlying },
            'Registered configured disabled undiscovered coin'
          );
          continue;
        }

        // 1. Generic discovery via Phase 2 client
        this.#logger.debug(
          { underlying: canonicalUnderlying },
          'Discovering active INR perpetual instrument for coin'
        );
        let discovered: InrFuturesInstrument | null = null;
        try {
          discovered = await this.#discoveryClient.findActiveInrPerpetualByUnderlying(
            canonicalUnderlying
          );
        } catch {
          throw new CoinDiscoveryError(
            `Coin discovery failed for underlying '${canonicalUnderlying}'`,
            { underlying: canonicalUnderlying }
          );
        }

        if (!discovered) {
          throw new CoinDiscoveryError(
            `No active INR perpetual futures instrument found for underlying '${canonicalUnderlying}'`,
            { underlying: canonicalUnderlying }
          );
        }

        // 2. Map normalized Phase 2 model into runtime InstrumentMetadata
        const instrument = mapInstrumentToMetadata(discovered, canonicalUnderlying);

        // 3. Global duplicate pair safety
        if (seenPairs.has(instrument.pair) || this.#registry.hasPair(instrument.pair)) {
          throw new CoinRegistrationError(
            `Resolved instrument pair '${instrument.pair}' for '${canonicalUnderlying}' is already assigned to another coin`,
            { underlying: canonicalUnderlying, pair: instrument.pair }
          );
        }
        seenPairs.add(instrument.pair);

        // 4. Determine static entry eligibility (fail closed)
        const entryEligibility = determineEntryEligibility(profile, instrument);

        // 5. Build runtime container (starts in DISCOVERED state)
        const runtime: DiscoveredCoinRuntime = Object.freeze({
          status: 'DISCOVERED',
          profile,
          instrument,
          lifecycle: 'DISCOVERED',
          entryEligibility,
        });

        // 6. Atomic registration
        this.#registry.register(runtime);
        successful.push(runtime);

        this.#logger.info(
          {
            underlying: canonicalUnderlying,
            pair: instrument.pair,
            lifecycle: runtime.lifecycle,
            entryEligibility: runtime.entryEligibility,
          },
          'Successfully bootstrapped coin runtime'
        );
      } catch (err) {
        const category: CoinBootstrapFailureCategory =
          err instanceof CoinDiscoveryError
            ? 'DISCOVERY_FAILED'
            : err instanceof CoinRegistrationError
              ? 'REGISTRATION_FAILED'
              : 'MAPPING_FAILED';

        const safeMessage = FAILURE_MESSAGES[category];

        // Safe error logging: never reflect raw caught error messages or potential secrets
        this.#logger.error(
          {
            underlying: canonicalUnderlying,
            category,
          },
          safeMessage
        );

        failures.push(
          Object.freeze({
            underlying: canonicalUnderlying,
            category,
            message: safeMessage,
          })
        );
      }
    }

    this.#logger.info(
      {
        total: profiles.length,
        successfulCount: successful.length,
        failureCount: failures.length,
      },
      'Coin Runtime bootstrap process finished'
    );

    return Object.freeze({
      successful: Object.freeze(successful),
      failures: Object.freeze(failures),
    });
  }

  /**
   * Dedicated reactivation/rediscovery operation for a disabled or newly enabled coin.
   *
   * Invariant Guarantees:
   * - Queries real CoinDCX discovery; never bypasses discovery via simple label change.
   * - If rediscovery fails, existing registry state remains completely untouched.
   * - If rediscovery succeeds, atomically updates registry and installs pair mapping.
   * - Safe error boundary: catches and suppresses untrusted error messages, stacks, and secrets,
   *   emitting deterministic categorized AppErrors without attaching raw Error objects.
   */
  public async reactivate(profile: CoinProfile): Promise<CoinRuntime> {
    const rawUnderlying =
      profile && typeof profile.underlying === 'string' ? profile.underlying : 'UNKNOWN';
    let canonicalUnderlying = rawUnderlying;
    try {
      canonicalUnderlying = canonicalizeUnderlying(rawUnderlying);
    } catch {
      // Retain rawUnderlying if canonicalization fails
    }

    // Phase 1: Validation
    let validatedProfile: CoinProfile;
    try {
      validatedProfile = validateCoinProfile(profile);
      if (!validatedProfile.enabled) {
        throw new Error('Profile disabled');
      }
    } catch {
      const category: CoinBootstrapFailureCategory = 'CONFIG_ERROR';
      const safeMessage = FAILURE_MESSAGES[category];
      this.#logger.error({ underlying: canonicalUnderlying, category }, safeMessage);
      throw new CoinConfigError(safeMessage, { underlying: canonicalUnderlying, category });
    }

    // Phase 2: Generic Discovery
    let discovered: InrFuturesInstrument | null = null;
    try {
      this.#logger.info(
        { underlying: canonicalUnderlying },
        'Attempting network rediscovery for coin reactivation'
      );
      discovered = await this.#discoveryClient.findActiveInrPerpetualByUnderlying(
        canonicalUnderlying
      );
      if (!discovered) {
        throw new Error('Instrument not found');
      }
    } catch {
      const category: CoinBootstrapFailureCategory = 'DISCOVERY_FAILED';
      const safeMessage = FAILURE_MESSAGES[category];
      this.#logger.error({ underlying: canonicalUnderlying, category }, safeMessage);
      throw new CoinDiscoveryError(safeMessage, { underlying: canonicalUnderlying, category });
    }

    // Phase 3: Mapping
    let instrument: InstrumentMetadata;
    try {
      instrument = mapInstrumentToMetadata(discovered, canonicalUnderlying);
    } catch {
      const category: CoinBootstrapFailureCategory = 'MAPPING_FAILED';
      const safeMessage = FAILURE_MESSAGES[category];
      this.#logger.error({ underlying: canonicalUnderlying, category }, safeMessage);
      throw new CoinDiscoveryError(safeMessage, { underlying: canonicalUnderlying, category });
    }

    // Phase 4: Static Eligibility
    let entryEligibility: CoinEntryEligibility;
    try {
      entryEligibility = determineEntryEligibility(validatedProfile, instrument);
    } catch {
      const category: CoinBootstrapFailureCategory = 'ELIGIBILITY_FAILED';
      const safeMessage = FAILURE_MESSAGES[category];
      this.#logger.error({ underlying: canonicalUnderlying, category }, safeMessage);
      throw new CoinRegistrationError(safeMessage, { underlying: canonicalUnderlying, category });
    }

    // Phase 5: Atomic Registration / Replacement
    try {
      const runtime: DiscoveredCoinRuntime = Object.freeze({
        status: 'DISCOVERED',
        profile: validatedProfile,
        instrument,
        lifecycle: 'DISCOVERED',
        entryEligibility,
      });

      return this.#registry.replaceOrRegisterDiscovered(runtime);
    } catch {
      const category: CoinBootstrapFailureCategory = 'REGISTRATION_FAILED';
      const safeMessage = FAILURE_MESSAGES[category];
      this.#logger.error({ underlying: canonicalUnderlying, category }, safeMessage);
      throw new CoinRegistrationError(safeMessage, { underlying: canonicalUnderlying, category });
    }
  }
}
