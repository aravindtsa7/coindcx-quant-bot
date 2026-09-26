/**
 * Phase 18B Checkpoint B: the private-stream SAFETY TRIPWIRE.
 *
 * REVOKE-ONLY. The tripwire's one durable capability is
 * `PracticalRevocationPort.invalidate` (a Stage 1A invalidation through the
 * Stage 1B1 repository). It cannot start or finish a certification, cannot
 * issue or persist a certificate, and cannot mark anything healthy. A stream
 * that stays quiet grants nothing; a reconnect grants nothing. The stream can
 * only take authority away.
 *
 * A WATCH binds to exactly one private-stream incarnation, and only while that
 * incarnation is PROVEN_READY (`bindPracticalPrivateStream`): connected, no
 * unresolved reconnect, the authenticated join sent, AND a provider-originated
 * subscription confirmation for that incarnation. AUTH_JOIN_SENT alone is
 * UNPROVEN and refuses; the existing CoinDCX adapter is always UNPROVEN.
 * Readiness is only a PRECONDITION: binding grants nothing. From then on, the
 * first of these trips it:
 *   - any private event not on the reviewed noise list (currently none):
 *     lifecycle, order/position/balance state change, unknown or malformed
 *     (`classifyPracticalPrivateEvent`);
 *   - at a health check: a different incarnation, any loss of PROVEN_READY
 *     (disconnect, RECONCILIATION_REQUIRED, lost join, confirmation gone or
 *     replaced), a dropped malformed event (invalid-event count changed), or
 *     any stream state change (`practicalStreamHealthTrip`);
 *   - a fault inside classification itself (fail closed).
 * A trip is STICKY for the watch: nothing un-trips it. Only a NEW watch on a
 * PROVEN_READY incarnation can start over (a new incarnation starts UNPROVEN),
 * and a certification bound to the tripped watch can never succeed.
 *
 * On a trip the tripwire DURABLY invalidates the account at once (CERTIFYING
 * or CERTIFIED_IDLE -> QUARANTINED; an issued certificate is revoked), so an
 * invalidation always wins over a concurrent certificate issuance: whichever
 * transaction commits first, the account ends quarantined with no usable
 * certificate. A failed revocation is retried, then reported; the trip stays
 * sticky (so nothing new is certified) and any certificate still expires
 * within its absolute lifetime.
 *
 * STICKY TRIP LIFECYCLE. A trip OUTLIVES its watch: neither `arm()` nor
 * `disarm()` clears it, and `arm()` REFUSES while it stands (TRIPPED), so a
 * failed durable revocation can never be forgotten by re-arming on the same
 * incarnation. The ONLY way to clear it is `releaseTrip(trip, durableLoad)`,
 * which requires every durable revocation to have settled AND the caller's
 * fresh Stage 1B1 read to PROVE that no practical authority remains
 * (`practicalDurableSafetyProblem`: a valid FOUND read, no current
 * certificate, not CERTIFIED_IDLE, not CERTIFYING, no mutation lease). An
 * unreadable, NOT_FOUND, or MALFORMED read proves nothing and keeps the trip.
 * Releasing a trip grants nothing: a new watch still needs a PROVEN_READY
 * stream, a fresh Phase 18 generation, and a full certification.
 *
 * No private payload is logged or persisted.
 */
import { PracticalPersistenceError, type PracticalAccountLoad } from '../practical-persistence/ports';
import type { PracticalInvalidationReason } from '../practical/types';
import type { PracticalPrivateStreamEnvelope, PracticalPrivateStreamSource, PracticalRecoveryClock, PracticalRevocationPort } from './ports';
import {
  bindPracticalPrivateStream,
  classifyPracticalPrivateEvent,
  practicalStreamHealthTrip,
  type PracticalStreamBinding,
  type PracticalStreamBindingResult,
} from './private-events';

/** Durable revocation attempts per trip (the repository itself already retries deadlocks). */
export const PRACTICAL_REVOCATION_MAX_ATTEMPTS = 3;

export interface PracticalTripwireWatch {
  readonly accountId: string;
  readonly binding: PracticalStreamBinding;
  readonly armedAtMs: number;
}

export interface PracticalTrip {
  readonly reason: PracticalInvalidationReason;
  readonly category: 'LIFECYCLE' | 'STATE_CHANGE' | 'UNKNOWN';
  readonly source: 'EVENT' | 'HEALTH_CHECK' | 'CLASSIFIER_FAULT';
  readonly atMs: number;
  readonly incarnation: number;
}

export type PracticalRevocationResult =
  | { readonly kind: 'REVOKED' }
  /** The account has no durable practical rows, or they are malformed/latched: there is no authority to revoke. */
  | { readonly kind: 'NOTHING_TO_REVOKE'; readonly code: string }
  | { readonly kind: 'FAILED'; readonly failure: string };

export interface PracticalTripwireHooks {
  /** Synchronous notification of a new trip (telemetry, in-memory certificate revocation). Must not throw; it is guarded. */
  readonly onTrip?: (trip: PracticalTrip) => void;
  /** Outcome of the durable revocation for a trip. Guarded. */
  readonly onRevocation?: (trip: PracticalTrip, result: PracticalRevocationResult) => void;
}

export type PracticalTripwireArmResult =
  | { readonly kind: 'ARMED'; readonly watch: PracticalTripwireWatch }
  /** A prior trip stands: nothing re-arms until durable safety is proven (`releaseTrip`). */
  | { readonly kind: 'TRIPPED'; readonly trip: PracticalTrip }
  | {
      readonly kind: 'NOT_READY';
      readonly readiness: Extract<PracticalStreamBindingResult, { kind: 'NOT_READY' }>['readiness'];
      readonly reason: Extract<PracticalStreamBindingResult, { kind: 'NOT_READY' }>['reason'];
    };

/** Why durable Stage 1B1 state does NOT prove that no practical authority remains. */
export type PracticalDurableSafetyProblem =
  | 'PERSISTENCE_UNREADABLE'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_MALFORMED'
  | 'CERTIFICATE_OUTSTANDING'
  | 'CERTIFIED'
  | 'CERTIFYING'
  | 'MUTATION_LEASE_HELD';

/**
 * Pure: whether a fresh Stage 1B1 load PROVES that no practical authority
 * remains (null) or why it does not. Fail closed: anything but a valid FOUND
 * read with no certificate, no certification in progress, and no lease is a
 * problem.
 */
export function practicalDurableSafetyProblem(load: unknown): PracticalDurableSafetyProblem | null {
  if (typeof load !== 'object' || load === null) return 'PERSISTENCE_UNREADABLE';
  const read = load as PracticalAccountLoad;
  if (read.kind === 'NOT_FOUND') return 'ACCOUNT_NOT_FOUND';
  if (read.kind === 'MALFORMED') return 'ACCOUNT_MALFORMED';
  if (read.kind !== 'FOUND' || typeof read.account !== 'object' || read.account === null) return 'PERSISTENCE_UNREADABLE';
  const account = read.account;
  if (account.currentCertificate !== null) return 'CERTIFICATE_OUTSTANDING';
  if (account.state === 'CERTIFIED_IDLE') return 'CERTIFIED';
  if (account.state === 'CERTIFYING' || account.fence.mode.kind === 'CERTIFYING') return 'CERTIFYING';
  if (account.state === 'MUTATING' || account.fence.mode.kind === 'MUTATION_LEASED' || account.currentLease !== null || account.leasedCertificate !== null) return 'MUTATION_LEASE_HELD';
  return null;
}

export type PracticalTripReleaseResult =
  | { readonly kind: 'RELEASED' }
  | { readonly kind: 'KEPT'; readonly problem: PracticalDurableSafetyProblem | 'NOT_THE_CURRENT_TRIP' | 'REVOCATION_IN_FLIGHT' };

export class PracticalPrivateStreamTripwire {
  readonly #accountId: string;
  readonly #source: PracticalPrivateStreamSource;
  readonly #revocation: PracticalRevocationPort;
  readonly #clock: PracticalRecoveryClock;
  readonly #hooks: PracticalTripwireHooks;

  #watch: PracticalTripwireWatch | null = null;
  #trip: PracticalTrip | null = null;
  #unsubscribe: (() => void) | null = null;
  #revocations: Promise<void> = Promise.resolve();
  #revocationsInFlight = 0;

  public constructor(input: {
    readonly accountId: string;
    readonly source: PracticalPrivateStreamSource;
    readonly revocation: PracticalRevocationPort;
    readonly clock: PracticalRecoveryClock;
    readonly hooks?: PracticalTripwireHooks;
  }) {
    this.#accountId = input.accountId;
    this.#source = input.source;
    this.#revocation = input.revocation;
    this.#clock = input.clock;
    this.#hooks = input.hooks ?? {};
  }

  /** The current watch, or null. A tripped watch is still returned (with `trip` set) until re-armed or disarmed. */
  public get watch(): PracticalTripwireWatch | null {
    return this.#watch;
  }

  /** The sticky trip, or null. It outlives its watch until `releaseTrip` proves durable safety. */
  public get trip(): PracticalTrip | null {
    return this.#trip;
  }

  /**
   * Binds a NEW watch to the stream's current incarnation, replacing any
   * previous UNTRIPPED watch. REFUSES while a trip stands (TRIPPED): a trip is
   * never erased by re-arming. Refuses unless the current incarnation is
   * PROVEN_READY (a provider-confirmed subscription; AUTH_JOIN_SENT alone is
   * UNPROVEN). Binding is never evidence of health and grants nothing.
   */
  public arm(): PracticalTripwireArmResult {
    const standing = this.#trip;
    if (standing !== null) return Object.freeze({ kind: 'TRIPPED' as const, trip: standing });
    this.disarm();
    const bound = bindPracticalPrivateStream(this.#readHealth());
    if (bound.kind === 'NOT_READY') return Object.freeze({ kind: 'NOT_READY' as const, readiness: bound.readiness, reason: bound.reason });
    const watch = Object.freeze({ accountId: this.#accountId, binding: bound.binding, armedAtMs: this.#clock.nowMs() });
    this.#watch = watch;
    this.#unsubscribe = this.#source.subscribe((envelope) => this.#onEnvelope(watch, envelope));
    // Anything that changed between the health read and the subscription is caught here.
    this.check();
    return Object.freeze({ kind: 'ARMED' as const, watch });
  }

  /** Stops observing. Never clears a trip. */
  public disarm(): void {
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = null;
    this.#watch = null;
    if (unsubscribe !== null) {
      try {
        unsubscribe();
      } catch {
        // Nothing to undo: the watch is already gone.
      }
    }
  }

  /**
   * Health check against the binding. Trips (durably) on any change. Returns
   * the watch's sticky trip, or null when no trip has occurred. Null is not
   * evidence of anything.
   */
  public check(): PracticalTrip | null {
    const watch = this.#watch;
    if (watch === null) return null;
    if (this.#trip !== null) return this.#trip;
    let reason: PracticalInvalidationReason | null;
    try {
      reason = practicalStreamHealthTrip(this.#readHealth(), watch.binding);
    } catch {
      reason = 'UNKNOWN_PRIVATE_EVENT';
    }
    if (reason !== null) this.#fire(watch, reason, reason === 'UNKNOWN_PRIVATE_EVENT' ? 'UNKNOWN' : 'LIFECYCLE', 'HEALTH_CHECK');
    return this.#trip;
  }

  /** Resolves once every durable revocation started so far has finished (successfully or not). */
  public settled(): Promise<void> {
    return this.#revocations;
  }

  /**
   * The ONLY way to clear a standing trip: `trip` must be the current trip,
   * no revocation may still be in flight, and `durableLoad` (the caller's
   * fresh Stage 1B1 read) must prove that no practical authority remains.
   * Anything else keeps the trip. Clearing grants nothing.
   */
  public releaseTrip(trip: PracticalTrip, durableLoad: unknown): PracticalTripReleaseResult {
    const keep = (problem: Extract<PracticalTripReleaseResult, { kind: 'KEPT' }>['problem']): PracticalTripReleaseResult => Object.freeze({ kind: 'KEPT' as const, problem });
    if (this.#trip === null || this.#trip !== trip) return keep('NOT_THE_CURRENT_TRIP');
    if (this.#revocationsInFlight !== 0) return keep('REVOCATION_IN_FLIGHT');
    let problem: PracticalDurableSafetyProblem | null;
    try {
      problem = practicalDurableSafetyProblem(durableLoad);
    } catch {
      problem = 'PERSISTENCE_UNREADABLE';
    }
    if (problem !== null) return keep(problem);
    this.disarm();
    this.#trip = null;
    return Object.freeze({ kind: 'RELEASED' as const });
  }

  #readHealth(): unknown {
    try {
      return this.#source.getHealthSnapshot();
    } catch {
      return null;
    }
  }

  #onEnvelope(watch: PracticalTripwireWatch, envelope: PracticalPrivateStreamEnvelope): void {
    if (this.#watch !== watch || this.#trip !== null) return;
    try {
      const classification = classifyPracticalPrivateEvent(envelope, watch.binding.incarnation);
      if (classification.kind === 'TRIP') this.#fire(watch, classification.reason, classification.category, 'EVENT');
    } catch {
      this.#fire(watch, 'UNKNOWN_PRIVATE_EVENT', 'UNKNOWN', 'CLASSIFIER_FAULT');
    }
  }

  #fire(watch: PracticalTripwireWatch, reason: PracticalInvalidationReason, category: PracticalTrip['category'], source: PracticalTrip['source']): void {
    if (this.#watch !== watch || this.#trip !== null) return;
    const trip: PracticalTrip = Object.freeze({ reason, category, source, atMs: this.#clock.nowMs(), incarnation: watch.binding.incarnation });
    this.#trip = trip;
    // One revocation per watch: stop listening; the trip is sticky.
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = null;
    if (unsubscribe !== null) {
      try {
        unsubscribe();
      } catch {
        // Ignore: the trip is already recorded.
      }
    }
    try {
      this.#hooks.onTrip?.(trip);
    } catch {
      // Hooks are observational.
    }
    this.#revocationsInFlight += 1;
    this.#revocations = this.#revocations.then(() => this.#revoke(trip)).finally(() => {
      this.#revocationsInFlight -= 1;
    });
  }

  async #revoke(trip: PracticalTrip): Promise<void> {
    let result: PracticalRevocationResult = Object.freeze({ kind: 'FAILED' as const, failure: 'NOT_ATTEMPTED' });
    for (let attempt = 1; attempt <= PRACTICAL_REVOCATION_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.#revocation.invalidate({ accountId: this.#accountId, reason: trip.reason, nowMs: this.#clock.nowMs() });
        result = Object.freeze({ kind: 'REVOKED' as const });
        break;
      } catch (error) {
        if (error instanceof PracticalPersistenceError
          && (error.code === 'PRACTICAL_PERSISTENCE_NOT_FOUND' || error.code === 'PRACTICAL_PERSISTENCE_MALFORMED' || error.code === 'PRACTICAL_PERSISTENCE_LATCHED')) {
          result = Object.freeze({ kind: 'NOTHING_TO_REVOKE' as const, code: error.code });
          break;
        }
        result = Object.freeze({ kind: 'FAILED' as const, failure: error instanceof PracticalPersistenceError ? error.code : 'UNEXPECTED_ERROR' });
      }
    }
    try {
      this.#hooks.onRevocation?.(trip, result);
    } catch {
      // Hooks are observational.
    }
  }
}
