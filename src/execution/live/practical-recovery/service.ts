/**
 * Phase 18B Checkpoint B (Stage 1C): the READ-ONLY practical recovery and
 * certification engine.
 *
 * It drives one credential-bound account through the Stage 1A states:
 *
 *   QUARANTINED -> CERTIFYING -> CERTIFIED_IDLE          (a certificate)
 *   CERTIFYING  -> PROVIDER_UNAVAILABLE                  (provider unavailable or timed out)
 *   CERTIFYING  -> QUARANTINED | MANUAL_REVIEW_REQUIRED  (any other failure, by Stage 1A severity)
 *   PROVIDER_UNAVAILABLE -> QUARANTINED                  (only after a successful identity probe)
 *   CERTIFYING | CERTIFIED_IDLE -> QUARANTINED           (private-stream tripwire, immediately)
 *
 * READ-ONLY WITH RESPECT TO THE VENUE. The engine's only venue access is the
 * read-only `PracticalVenueReadPort`. It cannot create, cancel, or close an
 * order, cannot arm or dispatch anything, and holds no Stage 1B2 lease
 * operation (`PracticalRecoveryPersistence` omits them). A certificate it
 * issues is PRACTICAL_RECOVERY evidence (`provesAccountContinuity: false`);
 * it never becomes, and is never presented as, Phase 18 strict continuity.
 *
 * THE ONE CERTIFICATE ISSUER IMPORTER. This module is the single reviewed
 * production importer of `issuePracticalRecoveryCertificate` (pinned by an
 * architecture test). It issues only after EVERY rule holds, then persists the
 * certificate and finishes certification in the one existing Stage 1B1
 * transaction (`finishCertification`). No other code path issues, and the
 * issued object is returned only to this module's caller.
 *
 * WHAT A CERTIFICATION REQUIRES (all of it, or nothing is issued):
 *   - a genuine Tier-B enablement that permits the account;
 *   - an ARMED private-stream watch, bound only while the stream's exact
 *     incarnation is PROVEN_READY (a PROVIDER-confirmed active subscription:
 *     AUTH_JOIN_SENT alone is UNPROVEN, and RECONCILIATION_REQUIRED or
 *     DISCONNECTED cannot arm), whose incarnation never changes, which stays
 *     PROVEN_READY (every stream checkpoint re-derives readiness; any loss
 *     trips), and which never trips for the whole run. Silence is evidence
 *     only on a PROVEN_READY stream. The existing CoinDCX adapter has no
 *     provider confirmation, is always UNPROVEN, and therefore cannot support
 *     a certification (fail closed; see `./private-events.ts`);
 *   - a Phase 18 reconciliation generation G of THIS runtime epoch, HEALTHY,
 *     claimed AFTER the watch was armed (so every Phase 18 read happened
 *     under the watch) and newer than the fence's generation; G must not
 *     change during the run, and the certificate and fence bind to G;
 *   - the durable fence: QUARANTINED + IDLE, taken to CERTIFYING with a fresh
 *     runId (the Stage 1B1 compare-and-set; a stale epoch, run, revision, or
 *     generation loses);
 *   - the observation passes (`./observation.ts`): each pass is the
 *     bracketed read sequence identity, O1 P1 O2 P2 O3, identity, with every
 *     read complete (all pages), O1 == O2 == O3, P1 == P2, and both identity
 *     reads the configured account; at least the ceiling's pass count,
 *     spacing, and span; and every pass's state digest exactly equal.
 *
 * TIMING: TWO KINDS, NEVER CONFUSED (`./timing.ts`).
 *   - PROVISIONAL, UNCALIBRATED PRE-SHADOW HARD OPERATIONAL CEILINGS stop a
 *     read or a pass from hanging and fail closed (READ_HARD_TIMEOUT,
 *     PASS_HARD_CEILING_EXCEEDED).
 *   - CALIBRATION CANDIDATES (Stage 1A PRACTICAL_TIMING_CANDIDATES, 3 s read /
 *     15 s pass / 2 s between reads) are measured and reported as
 *     `...CandidateExceeded` telemetry ONLY. Exceeding one never fails
 *     anything and is never reported as a provider violation.
 * The pass count, span, spacing, and certificate lifetime are the Stage 1A
 * hard safety ceilings from the enablement, enforced unchanged.
 *
 * CONCURRENCY AND RESTART. The durable Stage 1B1 fence is the only lock: no
 * in-memory flag is authoritative. Two runs racing for one account: exactly
 * one takes CERTIFYING, the other gets LOST_RACE with no durable change. A
 * run from a dead runtime epoch can never finish (the fence was adopted by
 * the new epoch), and a restart never trusts an in-memory certificate:
 * adoption resets CERTIFYING and revokes any issued certificate.
 *
 * ASYNC BOUNDARIES. Every await is a point where the world may change. After
 * the certificate commit the stream, then the Phase 18 generation (itself an
 * await), then the stream AGAIN are revalidated before CERTIFIED; the
 * authority monitor re-derives the stream after its Phase 18 read before
 * CERTIFICATE_STILL_VALID. Any failure durably revokes (confirmed) and
 * returns a no-authority outcome. None of this makes the provider state
 * atomic; Stage 1B2 must still revalidate immediately before arming.
 *
 * STICKY TRIPS AND THE DURABLE-SAFETY HOLD. A tripwire trip, or a revocation
 * this service could not CONFIRM durably, blocks the service (no watch, no
 * certification, never STILL_VALID) until `resetAfterRevocation` proves from
 * fresh Stage 1B1 state that no practical authority remains. `startWatch`,
 * `stopWatch`, and stream silence never clear either. `stopWatch` is
 * fail-closed: it durably revokes an ISSUED certificate BEFORE it stops
 * observing, and refuses (keeps observing) when it cannot.
 */
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../../../monitoring/logger';
import {
  issuePracticalRecoveryCertificate,
  revokePracticalRecoveryCertificate,
  type PracticalCertificationEvidenceSummary,
  type PracticalRecoveryCertificate,
} from '../practical/certificate';
import type { PracticalFenceExpectation } from '../practical/fence';
import {
  PRACTICAL_TIMING_CANDIDATES,
  PracticalLiveSafetyEnablement,
  requirePracticalLiveSafetyEnablement,
  type PracticalSafetyCeilings,
  type PracticalTimingCandidate,
  type PracticalTimingCandidates,
} from '../practical/policy';
import { PracticalLiveSafetyError, isExactId, isPositiveSafeInteger, type PracticalInvalidationReason } from '../practical/types';
import {
  PracticalPersistenceError,
  type PracticalAccountLoad,
  type PracticalAccountSnapshot,
  type PracticalCertificationFailure,
} from '../practical-persistence/ports';
import { isProviderAccountFingerprint } from '../reconciliation/account-identity';
import {
  PRACTICAL_PASS_READ_PLAN,
  assemblePracticalPass,
  evaluatePracticalCertificationEvidence,
  observeIdentityRead,
  observeOrderRead,
  observePositionRead,
  practicalBracketDisagreement,
  type PracticalCertificationFailureCode,
  type PracticalObservationPass,
  type PracticalReadContent,
  type PracticalReadObservation,
} from './observation';
import type {
  PracticalPrivateStreamSource,
  PracticalReconciliationStateReader,
  PracticalReconciliationStateView,
  PracticalRecoveryClock,
  PracticalRecoveryPersistence,
  PracticalRecoveryScheduler,
  PracticalVenueReadPort,
} from './ports';
import { recordSafely, type PracticalObservationReadKind, type PracticalPassReadSlot, type PracticalRecoveryTelemetry } from './telemetry';
import { PRACTICAL_RECOVERY_HARD_CEILINGS, practicalCandidateExceeded, type PracticalRecoveryHardCeilings } from './timing';
import { PracticalPrivateStreamTripwire, practicalDurableSafetyProblem, type PracticalTrip, type PracticalTripwireWatch } from './tripwire';

const logger = createChildLogger('execution:live:practical-recovery');

/** Durable release attempts for a failed run's fence. */
const RELEASE_MAX_ATTEMPTS = 3;
/** Stage 1B1 `live_practical_account_fence.run_id` is VARCHAR(64). */
const RUN_ID_MAX_LENGTH = 64;

const NO_TELEMETRY: PracticalRecoveryTelemetry = Object.freeze({ record: () => undefined });

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** Why a certification did not start. Nothing durable changed (except where stated). */
export type PracticalCertificationIneligibility =
  | 'TIER_B_NOT_ENABLED_FOR_ACCOUNT'
  | 'ACCOUNT_NOT_INITIALIZED'
  | 'ACCOUNT_MALFORMED'
  | 'FENCE_NOT_ADOPTED_BY_THIS_RUNTIME'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'ALREADY_CERTIFIED'
  | 'CERTIFICATION_IN_PROGRESS'
  | 'MUTATION_LEASE_HELD'
  | 'NO_ACTIVE_WATCH'
  | 'WATCH_TRIPPED'
  /** A required durable revocation has not been CONFIRMED: blocked until `resetAfterRevocation` proves durable safety. */
  | 'DURABLE_SAFETY_UNCONFIRMED'
  | 'PROVIDER_STILL_UNAVAILABLE'
  /** The identity probe saw a DIFFERENT account: the account was durably sent to manual review. */
  | 'ACCOUNT_IDENTITY_MISMATCH'
  | 'RECONCILIATION_STATE_UNAVAILABLE'
  | 'RECONCILIATION_NOT_HEALTHY'
  | 'RECONCILIATION_OTHER_RUNTIME'
  | 'RECONCILIATION_GENERATION_NOT_AFTER_WATCH'
  | 'RECONCILIATION_GENERATION_NOT_NEWER_THAN_FENCE';

export type PracticalCertificationOutcome =
  | {
      readonly kind: 'CERTIFIED';
      readonly runId: string;
      /** The genuine in-memory certificate; its durable twin is the authority. */
      readonly certificate: PracticalRecoveryCertificate;
      readonly summary: PracticalCertificationEvidenceSummary;
      readonly account: PracticalAccountSnapshot;
    }
  | { readonly kind: 'NOT_ELIGIBLE'; readonly reason: PracticalCertificationIneligibility }
  /** Another run owns the fence, or the fence moved: this run changed nothing. */
  | { readonly kind: 'LOST_RACE'; readonly reason: string }
  | {
      readonly kind: 'FAILED';
      readonly runId: string;
      readonly failure: PracticalCertificationFailureCode;
      readonly durableFailure: PracticalCertificationFailure;
      /** Whether the fence was released (CERTIFYING -> IDLE). False only when the release itself failed or was stale. */
      readonly released: boolean;
      readonly account: PracticalAccountSnapshot | null;
    }
  /** The private-stream tripwire invalidated the account during the run or at issuance: the invalidation won. */
  | {
      readonly kind: 'SUPERSEDED';
      readonly runId: string;
      readonly reason: PracticalInvalidationReason;
      readonly account: PracticalAccountSnapshot | null;
    };

export type PracticalStartupOutcome =
  /**
   * The account is durably NON-AUTHORITATIVE (proven from a fresh FOUND read:
   * no current certificate). `REVOKED_CERTIFICATE`: a same-runtime ISSUED
   * certificate had no trusted in-memory provenance and was durably revoked.
   */
  | { readonly kind: 'READY'; readonly account: PracticalAccountSnapshot; readonly action: 'CREATED' | 'ADOPTED' | 'UNCHANGED' | 'EXPIRED_CERTIFICATE' | 'REVOKED_CERTIFICATE' }
  /** Startup could not PROVE the account non-authoritative (unreadable state, failed revocation): NOT ready; the service is held. */
  | { readonly kind: 'BLOCKED_DURABLE_SAFETY_UNCONFIRMED'; readonly problem: string }
  | { readonly kind: 'MANUAL_REVIEW_REQUIRED'; readonly reviewEpisodeId: string }
  /** A MUTATION_LEASED fence from another runtime: its wire state must be resolved by Stage 1B2 first. */
  | { readonly kind: 'BLOCKED_MUTATION_LEASE_HELD'; readonly account: PracticalAccountSnapshot };

export type PracticalWatchOutcome =
  | { readonly kind: 'WATCHING'; readonly watch: PracticalTripwireWatch; readonly reconciliationGenerationAtArm: number }
  | { readonly kind: 'NOT_READY'; readonly reason: string };

export type PracticalAuthorityCheck =
  | { readonly kind: 'NO_OUTSTANDING_CERTIFICATE'; readonly tripped: boolean }
  | { readonly kind: 'CERTIFICATE_STILL_VALID' }
  | { readonly kind: 'CERTIFICATE_EXPIRED' }
  | { readonly kind: 'CERTIFICATE_REVOKED'; readonly reason: PracticalInvalidationReason }
  /**
   * The certificate must end but the durable revocation could not be
   * CONFIRMED (persistence failed or is unreadable). It is NOT valid: the
   * service is blocked (no watch, no certification, never STILL_VALID) until
   * `resetAfterRevocation` proves durable safety.
   */
  | { readonly kind: 'REVOCATION_UNCONFIRMED'; readonly reason: PracticalInvalidationReason }
  /**
   * NOT_FOUND while this service never held or watched for authority: there
   * is nothing to monitor. This is not a proof of anything (it is never
   * NO_OUTSTANDING_CERTIFICATE); `recoverAtStartup` initializes the account.
   */
  | { readonly kind: 'ACCOUNT_NOT_INITIALIZED' };

export type PracticalStopWatchOutcome =
  /** Observation stopped; `revokedCertificate` says whether an ISSUED certificate was durably revoked first. */
  | { readonly kind: 'STOPPED'; readonly revokedCertificate: boolean }
  /**
   * Refused: stopping would leave an ISSUED certificate unobserved and it
   * could not be durably revoked (or durable state could not be read). The
   * watch KEEPS observing (a trip still revokes) and the service is blocked.
   */
  | {
      readonly kind: 'REFUSED_AUTHORITY_OUTSTANDING';
      readonly problem:
        | 'PERSISTENCE_UNAVAILABLE'
        | 'REVOCATION_UNCONFIRMED'
        | 'DURABLE_STATE_MALFORMED'
        | 'DURABLE_STATE_NOT_FOUND'
        | 'CERTIFICATION_IN_PROGRESS'
        | 'MUTATION_LEASE_HELD';
    };

export type PracticalResetOutcome =
  | { readonly kind: 'NOTHING_TO_RESET' }
  /** Durable state PROVED that no practical authority remains: the trip/hold is cleared. Nothing is granted. */
  | { readonly kind: 'RESET' }
  /** Not proven safe: the trip/hold stays. */
  | { readonly kind: 'KEPT'; readonly problem: string };

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PracticalRecoveryServiceDependencies {
  /** The one account the credentials behind the venue port and stream act on. */
  readonly accountId: string;
  /** This runtime's epoch (the same value the Phase 18 runtime identity carries). */
  readonly runtimeEpoch: string;
  /** Configured provider trading-account fingerprint (lowercase 64-hex). */
  readonly expectedProviderAccountFingerprint: string;
  /** A genuine configuration-issued Tier-B enablement (Stage 1A). Data look-alikes are refused. */
  readonly enablement: unknown;
  readonly persistence: PracticalRecoveryPersistence;
  readonly venue: PracticalVenueReadPort;
  readonly reconciliation: PracticalReconciliationStateReader;
  readonly privateStream: PracticalPrivateStreamSource;
  readonly clock: PracticalRecoveryClock;
  readonly scheduler: PracticalRecoveryScheduler;
  readonly telemetry?: PracticalRecoveryTelemetry | undefined;
  /** Shadow-calibration candidates (telemetry markers only). Defaults to Stage 1A's PRACTICAL_TIMING_CANDIDATES. */
  readonly timing?: PracticalTimingCandidates | undefined;
  readonly newRunId?: (() => string) | undefined;
}

function isTimingCandidate(value: unknown): value is PracticalTimingCandidate {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate['status'] === 'SHADOW_CALIBRATION_CANDIDATE' && candidate['providerGuarantee'] === false && isPositiveSafeInteger(candidate['valueMs']);
}

function configurationError(message: string): never {
  throw new PracticalLiveSafetyError('PRACTICAL_POLICY_INVALID', message);
}

/** Maps a certification failure to the durable Stage 1A outcome. */
export function practicalDurableFailureFor(failure: PracticalCertificationFailureCode, tripReason: PracticalInvalidationReason | null): PracticalCertificationFailure {
  const invalidated = (reason: PracticalInvalidationReason): PracticalCertificationFailure => Object.freeze({ kind: 'INVALIDATED' as const, reason });
  switch (failure) {
    case 'PROVIDER_UNAVAILABLE':
    case 'READ_HARD_TIMEOUT':
      return Object.freeze({ kind: 'PROVIDER_UNAVAILABLE' as const });
    case 'PAGINATION_INCOMPLETE':
      return invalidated('INCOMPLETE_PAGINATION');
    case 'MALFORMED_RESPONSE':
      return invalidated('PROVIDER_SCHEMA_ERROR');
    case 'ACCOUNT_FINGERPRINT_MISMATCH':
      return invalidated('ACCOUNT_IDENTITY_MISMATCH');
    case 'ACCOUNT_IDENTITY_UNAVAILABLE':
      return invalidated('ACCOUNT_IDENTITY_MISSING');
    case 'CLOCK_ANOMALY':
      return invalidated('CLOCK_ANOMALY');
    case 'STREAM_CHANGED':
      return invalidated(tripReason ?? 'UNKNOWN_PRIVATE_EVENT');
    case 'GENERATION_CHANGED':
      return invalidated('GENERATION_CHANGED');
    // Disagreement (inside a pass or across passes), a pass over its hard
    // ceiling, unmet timing, and every internal refusal: the evidence is not
    // usable now. Quarantine and re-certify. (Stage 1A has no narrower reason.)
    default:
      return invalidated('EVIDENCE_STALE');
  }
}

/** Sentinel for a bounded read that did not finish in time. */
const READ_TIMED_OUT: unique symbol = Symbol('P18B practical read timed out');

interface CertificationRun {
  readonly runId: string;
  readonly expected: PracticalFenceExpectation;
  readonly generation: number;
  readonly watch: PracticalTripwireWatch;
  lastNowMs: number;
  clockAnomaly: boolean;
}

interface OutstandingCertificate {
  readonly certificate: PracticalRecoveryCertificate;
  readonly issuedAtMs: number;
  /** The exact watch the certificate was issued under. */
  readonly watch: PracticalTripwireWatch;
}

interface WatchContext {
  readonly watch: PracticalTripwireWatch;
  readonly reconciliationGenerationAtArm: number;
}

class RunAbort extends Error {
  public constructor(public readonly failure: PracticalCertificationFailureCode, public readonly tripReason: PracticalInvalidationReason | null) {
    super(`P18B certification aborted: ${failure}`);
  }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class PracticalRecoveryService {
  readonly #accountId: string;
  readonly #runtimeEpoch: string;
  readonly #fingerprint: string;
  readonly #enablement: PracticalLiveSafetyEnablement;
  readonly #ceilings: PracticalSafetyCeilings;
  readonly #persistence: PracticalRecoveryPersistence;
  readonly #venue: PracticalVenueReadPort;
  readonly #reconciliation: PracticalReconciliationStateReader;
  readonly #clock: PracticalRecoveryClock;
  readonly #scheduler: PracticalRecoveryScheduler;
  readonly #telemetry: PracticalRecoveryTelemetry;
  /** Calibration candidates: telemetry markers only. */
  readonly #timing: PracticalTimingCandidates;
  /** Hard operational ceilings: fail closed. */
  readonly #hard: PracticalRecoveryHardCeilings = PRACTICAL_RECOVERY_HARD_CEILINGS;
  readonly #newRunId: () => string;
  readonly #tripwire: PracticalPrivateStreamTripwire;

  #watch: WatchContext | null = null;
  #outstanding: OutstandingCertificate | null = null;
  /**
   * DURABLE-SAFETY HOLD: a revocation this service needed could not be
   * CONFIRMED durably (so an ISSUED certificate may physically remain). While
   * it stands the service treats every certificate as unusable: no watch, no
   * certification, never CERTIFICATE_STILL_VALID. Only `resetAfterRevocation`
   * (a durable safety proof) clears it.
   */
  #hold: { readonly reason: PracticalInvalidationReason } | null = null;
  /** Our own run whose fence release failed; retried before the next certification. */
  #unreleased: { readonly run: CertificationRun; readonly failure: PracticalCertificationFailure } | null = null;

  public constructor(dependencies: PracticalRecoveryServiceDependencies) {
    if (!isExactId(dependencies.accountId)) configurationError('accountId must be a non-empty exact string');
    if (!isExactId(dependencies.runtimeEpoch) || dependencies.runtimeEpoch.length > 64) configurationError('runtimeEpoch must be an exact string of at most 64 characters');
    if (!isProviderAccountFingerprint(dependencies.expectedProviderAccountFingerprint)) configurationError('expectedProviderAccountFingerprint must be a lowercase 64-hex fingerprint');
    const enablement = requirePracticalLiveSafetyEnablement(dependencies.enablement);
    const timing = dependencies.timing ?? PRACTICAL_TIMING_CANDIDATES;
    if (!isTimingCandidate(timing.readDuration) || !isTimingCandidate(timing.passWindow) || !isTimingCandidate(timing.interReadGap)) {
      configurationError('Timing values must be SHADOW_CALIBRATION_CANDIDATE values (never provider guarantees)');
    }
    this.#accountId = dependencies.accountId;
    this.#runtimeEpoch = dependencies.runtimeEpoch;
    this.#fingerprint = dependencies.expectedProviderAccountFingerprint;
    this.#enablement = dependencies.enablement as PracticalLiveSafetyEnablement;
    this.#ceilings = enablement.ceilings;
    this.#persistence = dependencies.persistence;
    this.#venue = dependencies.venue;
    this.#reconciliation = dependencies.reconciliation;
    this.#clock = dependencies.clock;
    this.#scheduler = dependencies.scheduler;
    this.#telemetry = dependencies.telemetry ?? NO_TELEMETRY;
    this.#timing = Object.freeze({ ...timing });
    this.#newRunId = dependencies.newRunId ?? randomUUID;
    const persistence = dependencies.persistence;
    this.#tripwire = new PracticalPrivateStreamTripwire({
      accountId: dependencies.accountId,
      source: dependencies.privateStream,
      // REVOKE-ONLY: the tripwire gets invalidation and nothing else.
      revocation: Object.freeze({ invalidate: (input: Parameters<PracticalRecoveryPersistence['invalidate']>[0]) => persistence.invalidate(input) }),
      clock: dependencies.clock,
      hooks: {
        onTrip: (trip) => this.#onTrip(trip),
        onRevocation: (trip, result) => {
          if (result.kind === 'FAILED') {
            recordSafely(this.#telemetry, { type: 'P18B_REVOCATION_FAILED', accountId: this.#accountId, reason: trip.reason, failure: result.failure });
            logger.error({ accountId: this.#accountId, reason: trip.reason, failure: result.failure }, 'P18B tripwire could not durably revoke; the trip stays sticky and any certificate still expires');
          }
        },
      },
    });
  }

  /** Resolves once every tripwire revocation started so far has finished. */
  public settled(): Promise<void> {
    return this.#tripwire.settled();
  }

  // ----- startup ------------------------------------------------------------

  /**
   * Brings the durable account under this runtime. STARTUP NEVER GRANTS OR
   * PRESERVES PRACTICAL AUTHORITY: at startup there is no trusted in-memory
   * watch or issuance provenance, so no certificate survives, whether or not
   * the runtime epoch changed.
   *   - NOT_FOUND -> initialize QUARANTINED;
   *   - MALFORMED -> latch into durable manual review (nothing repaired);
   *   - ANY mutation lease (MUTATING, a MUTATION_LEASED fence, a current
   *     lease, or a leased certificate), in ANY runtime epoch ->
   *     BLOCKED_MUTATION_LEASE_HELD (Stage 1B2 must resolve it);
   *   - a fence of another runtime epoch -> Stage 1A adoption (CERTIFYING is
   *     abandoned to IDLE, an issued certificate is revoked);
   *   - the SAME runtime epoch while CERTIFYING (state or fence) -> BLOCKED
   *     (CERTIFICATION_IN_PROGRESS): startup does not own the old run and no
   *     reviewed primitive abandons a same-epoch certification; a later
   *     runtime epoch's adoption resolves it;
   *   - the SAME runtime epoch with an ISSUED certificate -> past its absolute
   *     expiry: EXPIRED; otherwise durably REVOKED (EVIDENCE_STALE: its watch
   *     and provenance are gone) and confirmed.
   * READY is returned only after a FRESH, valid FOUND read shows no current
   * certificate. An unreadable state or an unconfirmed revocation returns
   * BLOCKED_DURABLE_SAFETY_UNCONFIRMED (never READY) and holds the service.
   */
  public async recoverAtStartup(): Promise<PracticalStartupOutcome> {
    // No watch or issuance provenance survives: an in-memory certificate of an earlier lifetime is revoked, not merely forgotten.
    this.#revokeOutstanding('EVIDENCE_STALE', this.#clock.nowMs());
    this.#tripwire.disarm();
    this.#watch = null;
    const blocked = (problem: string): PracticalStartupOutcome => {
      this.#setHold('EVIDENCE_STALE');
      return Object.freeze({ kind: 'BLOCKED_DURABLE_SAFETY_UNCONFIRMED' as const, problem });
    };
    let action: 'CREATED' | 'ADOPTED' | 'UNCHANGED' | 'EXPIRED_CERTIFICATE' | 'REVOKED_CERTIFICATE' = 'UNCHANGED';
    try {
      const nowMs = this.#clock.nowMs();
      const load = await this.#persistence.loadAccount(this.#accountId);
      if (load.kind === 'NOT_FOUND') {
        const created = await this.#persistence.initializeAccount({ accountId: this.#accountId, runtimeEpoch: this.#runtimeEpoch, reconciliationGeneration: 0, nowMs });
        if (created.kind !== 'CREATED') return this.recoverAtStartup();
        action = 'CREATED';
      } else if (load.kind === 'MALFORMED') {
        const latched = await this.#persistence.escalateMalformedAccount({ accountId: this.#accountId, detectingRuntimeEpoch: this.#runtimeEpoch, nowMs });
        return Object.freeze({ kind: 'MANUAL_REVIEW_REQUIRED' as const, reviewEpisodeId: latched.reviewEpisodeId });
      } else if (load.kind === 'FOUND') {
        const account = load.account;
        // Any lease, in ANY runtime epoch: never READY.
        if (practicalDurableSafetyProblem(load) === 'MUTATION_LEASE_HELD') return Object.freeze({ kind: 'BLOCKED_MUTATION_LEASE_HELD' as const, account });
        if (account.fence.runtimeEpoch !== this.#runtimeEpoch) {
          await this.#persistence.adoptForNewRuntime({
            accountId: this.#accountId,
            previousRuntimeEpoch: account.fence.runtimeEpoch,
            expectedFenceRevision: account.fence.revision,
            newRuntimeEpoch: this.#runtimeEpoch,
            nowMs,
          });
          action = 'ADOPTED';
        } else if (account.state === 'CERTIFYING' || account.fence.mode.kind === 'CERTIFYING') {
          // SAME runtime epoch: a run of an earlier lifetime owns the fence. Do not invent ownership of it.
          return blocked('CERTIFICATION_IN_PROGRESS');
        } else if (account.currentCertificate !== null && nowMs >= account.currentCertificate.expiresAtMs) {
          await this.#persistence.expireCertificate({ accountId: this.#accountId, certificateId: account.currentCertificate.certificateId, trustedNowMs: nowMs });
          action = 'EXPIRED_CERTIFICATE';
        } else if (account.currentCertificate !== null) {
          // SAME runtime epoch, unexpired: no trusted watch or provenance survives a service restart. Revoke it.
          if (!(await this.#ensureRevoked(account.currentCertificate.certificateId, 'EVIDENCE_STALE'))) return blocked('REVOCATION_UNCONFIRMED');
          action = 'REVOKED_CERTIFICATE';
        }
      } else {
        return blocked('PERSISTENCE_UNREADABLE');
      }
      // Final gate: a FRESH, valid read must show the account non-authoritative.
      const final = await this.#persistence.loadAccount(this.#accountId);
      if (final.kind === 'MALFORMED') return this.recoverAtStartup();
      if (final.kind !== 'FOUND') return blocked('ACCOUNT_NOT_FOUND_AFTER_RECOVERY');
      if (final.account.currentCertificate !== null || final.account.state === 'CERTIFIED_IDLE') return blocked('CERTIFICATE_OUTSTANDING');
      const finalProblem = practicalDurableSafetyProblem(final);
      if (finalProblem === 'MUTATION_LEASE_HELD') return Object.freeze({ kind: 'BLOCKED_MUTATION_LEASE_HELD' as const, account: final.account });
      if (finalProblem !== null) return blocked(finalProblem === 'CERTIFYING' ? 'CERTIFICATION_IN_PROGRESS' : finalProblem);
      if (final.account.state === 'MANUAL_REVIEW_REQUIRED' && final.account.currentReviewEpisode !== null) {
        return Object.freeze({ kind: 'MANUAL_REVIEW_REQUIRED' as const, reviewEpisodeId: final.account.currentReviewEpisode.reviewEpisodeId });
      }
      return Object.freeze({ kind: 'READY' as const, account: final.account, action });
    } catch {
      return blocked('PERSISTENCE_UNREADABLE');
    }
  }

  // ----- the private-stream watch ------------------------------------------

  /**
   * Arms a watch on the private stream's CURRENT incarnation and records the
   * Phase 18 generation at arm time. A later certification must use a Phase 18
   * generation claimed AFTER this. An active, untripped watch is kept as is.
   * NEVER clears a trip or a durable-safety hold: after either, only
   * `resetAfterRevocation` (a durable safety proof) allows a new watch.
   */
  public async startWatch(): Promise<PracticalWatchOutcome> {
    if (this.#hold !== null) return Object.freeze({ kind: 'NOT_READY' as const, reason: 'DURABLE_SAFETY_UNCONFIRMED' });
    if (this.#tripwire.trip !== null) return Object.freeze({ kind: 'NOT_READY' as const, reason: 'WATCH_TRIPPED_RESET_REQUIRED' });
    const current = this.#watch;
    if (current !== null && this.#tripwire.watch === current.watch && this.#tripwire.check() === null) {
      return Object.freeze({ kind: 'WATCHING' as const, watch: current.watch, reconciliationGenerationAtArm: current.reconciliationGenerationAtArm });
    }
    this.#watch = null;
    const armed = this.#tripwire.arm();
    if (armed.kind === 'TRIPPED') return Object.freeze({ kind: 'NOT_READY' as const, reason: 'WATCH_TRIPPED_RESET_REQUIRED' });
    if (armed.kind === 'NOT_READY') return Object.freeze({ kind: 'NOT_READY' as const, reason: `STREAM_${armed.reason}` });
    let state: PracticalReconciliationStateView;
    try {
      state = await this.#reconciliation.loadState(this.#accountId);
    } catch {
      this.#tripwire.disarm();
      return Object.freeze({ kind: 'NOT_READY' as const, reason: 'RECONCILIATION_STATE_UNAVAILABLE' });
    }
    if (typeof state !== 'object' || state === null) {
      this.#tripwire.disarm();
      return Object.freeze({ kind: 'NOT_READY' as const, reason: 'RECONCILIATION_STATE_UNAVAILABLE' });
    }
    // The baseline is load-bearing (a certification needs a generation claimed AFTER it): it must be EXACTLY this account's row.
    if (state.accountId !== this.#accountId) {
      this.#tripwire.disarm();
      return Object.freeze({ kind: 'NOT_READY' as const, reason: 'RECONCILIATION_ACCOUNT_MISMATCH' });
    }
    if (!Number.isSafeInteger(state.currentGeneration) || state.currentGeneration < 0) {
      this.#tripwire.disarm();
      return Object.freeze({ kind: 'NOT_READY' as const, reason: 'RECONCILIATION_STATE_UNAVAILABLE' });
    }
    if (this.#tripwire.watch !== armed.watch || this.#tripwire.check() !== null) {
      return Object.freeze({ kind: 'NOT_READY' as const, reason: 'WATCH_TRIPPED_WHILE_ARMING' });
    }
    this.#watch = Object.freeze({ watch: armed.watch, reconciliationGenerationAtArm: state.currentGeneration });
    return Object.freeze({ kind: 'WATCHING' as const, watch: armed.watch, reconciliationGenerationAtArm: state.currentGeneration });
  }

  /**
   * FAIL-CLOSED graceful stop. Stopping observation must never leave a usable
   * certificate unobserved. The watch is disarmed ONLY after a valid FOUND
   * read proves no outstanding practical authority, or after an ISSUED
   * current certificate was DURABLY revoked and confirmed. Everything else is
   * REFUSED and the watch keeps observing (so a trip still revokes):
   *   - a thrown/unreadable read;
   *   - MALFORMED durable state (also sets the durable-safety hold);
   *   - an unexpected NOT_FOUND (also sets the hold: absence of rows is not a
   *     proof that no authority exists);
   *   - a revocation that cannot be confirmed (hold);
   *   - a certification in progress (CERTIFYING state or fence): a run owns
   *     the durable fence and could still persist a certificate;
   *   - a mutation lease (authority this read-only core does not own).
   * The final decision is `practicalDurableSafetyProblem` over a FOUND read
   * (re-read after any revocation). A refusal never disarms and never clears
   * a trip or a hold.
   * A stop never clears a trip. (A hard crash is different: the next runtime
   * epoch's adoption revokes any issued certificate.)
   */
  public async stopWatch(): Promise<PracticalStopWatchOutcome> {
    let load: PracticalAccountLoad;
    try {
      load = await this.#persistence.loadAccount(this.#accountId);
    } catch {
      return Object.freeze({ kind: 'REFUSED_AUTHORITY_OUTSTANDING' as const, problem: 'PERSISTENCE_UNAVAILABLE' as const });
    }
    const refuse = (problem: Extract<PracticalStopWatchOutcome, { kind: 'REFUSED_AUTHORITY_OUTSTANDING' }>['problem']): PracticalStopWatchOutcome =>
      Object.freeze({ kind: 'REFUSED_AUTHORITY_OUTSTANDING' as const, problem });
    if (load.kind === 'MALFORMED') {
      this.#setHold('EVIDENCE_STALE');
      return refuse('DURABLE_STATE_MALFORMED');
    }
    if (load.kind !== 'FOUND') {
      this.#setHold('EVIDENCE_STALE');
      return refuse('DURABLE_STATE_NOT_FOUND');
    }
    let revokedCertificate = false;
    let current: PracticalAccountLoad = load;
    if (load.account.currentCertificate !== null) {
      await this.#tripwire.settled();
      if (!(await this.#ensureRevoked(load.account.currentCertificate.certificateId, 'STREAM_INCARNATION_CHANGED'))) {
        return refuse('REVOCATION_UNCONFIRMED');
      }
      revokedCertificate = true;
      try {
        current = await this.#persistence.loadAccount(this.#accountId);
      } catch {
        return refuse('PERSISTENCE_UNAVAILABLE');
      }
    }
    switch (practicalDurableSafetyProblem(current)) {
      case null:
        break;
      case 'CERTIFYING':
        return refuse('CERTIFICATION_IN_PROGRESS');
      case 'MUTATION_LEASE_HELD':
        return refuse('MUTATION_LEASE_HELD');
      case 'ACCOUNT_MALFORMED':
        this.#setHold('EVIDENCE_STALE');
        return refuse('DURABLE_STATE_MALFORMED');
      case 'ACCOUNT_NOT_FOUND':
        this.#setHold('EVIDENCE_STALE');
        return refuse('DURABLE_STATE_NOT_FOUND');
      case 'PERSISTENCE_UNREADABLE':
        return refuse('PERSISTENCE_UNAVAILABLE');
      default:
        // CERTIFICATE_OUTSTANDING / CERTIFIED: authority still present.
        this.#setHold('STREAM_INCARNATION_CHANGED');
        return refuse('REVOCATION_UNCONFIRMED');
    }
    this.#revokeOutstanding('STREAM_INCARNATION_CHANGED', this.#clock.nowMs());
    this.#tripwire.disarm();
    this.#watch = null;
    return Object.freeze({ kind: 'STOPPED' as const, revokedCertificate });
  }

  /**
   * The EXPLICIT safe reset after a trip or a durable-safety hold. It first
   * makes sure any ISSUED current certificate is durably revoked, then clears
   * the trip/hold ONLY if a fresh Stage 1B1 read PROVES that no practical
   * authority remains (`practicalDurableSafetyProblem`: a valid FOUND read,
   * no current certificate, not CERTIFIED_IDLE, not CERTIFYING, no lease).
   * Unreadable, NOT_FOUND, or MALFORMED state keeps everything blocked. A
   * reset grants NOTHING: a new watch needs a PROVEN_READY stream, and a new
   * certificate needs a fresh Phase 18 generation and a full certification.
   */
  public async resetAfterRevocation(): Promise<PracticalResetOutcome> {
    const trip = this.#tripwire.trip;
    const hold = this.#hold;
    if (trip === null && hold === null) return Object.freeze({ kind: 'NOTHING_TO_RESET' as const });
    const reason = trip === null ? hold!.reason : trip.reason;
    await this.#tripwire.settled();
    await this.#retryUnreleased();
    let load: PracticalAccountLoad;
    try {
      load = await this.#persistence.loadAccount(this.#accountId);
      if (load.kind === 'FOUND' && load.account.currentCertificate !== null) {
        await this.#ensureRevoked(load.account.currentCertificate.certificateId, reason);
        load = await this.#persistence.loadAccount(this.#accountId);
      }
    } catch {
      return Object.freeze({ kind: 'KEPT' as const, problem: 'PERSISTENCE_UNREADABLE' });
    }
    const problem = practicalDurableSafetyProblem(load);
    if (problem !== null) return Object.freeze({ kind: 'KEPT' as const, problem });
    if (trip !== null) {
      const released = this.#tripwire.releaseTrip(trip, load);
      if (released.kind === 'KEPT') return Object.freeze({ kind: 'KEPT' as const, problem: released.problem });
    }
    this.#hold = null;
    this.#revokeOutstanding(reason, this.#clock.nowMs());
    this.#tripwire.disarm();
    this.#watch = null;
    return Object.freeze({ kind: 'RESET' as const });
  }

  // ----- certification -------------------------------------------------------

  public async certifyAccount(): Promise<PracticalCertificationOutcome> {
    await this.#retryUnreleased();
    const notEligible = (reason: PracticalCertificationIneligibility): PracticalCertificationOutcome => Object.freeze({ kind: 'NOT_ELIGIBLE' as const, reason });

    if (!this.#enablement.permitsAccount(this.#accountId)) return notEligible('TIER_B_NOT_ENABLED_FOR_ACCOUNT');
    if (this.#hold !== null) return notEligible('DURABLE_SAFETY_UNCONFIRMED');
    if (this.#tripwire.trip !== null) return notEligible('WATCH_TRIPPED');
    const context = this.#watch;
    if (context === null || this.#tripwire.watch !== context.watch) return notEligible('NO_ACTIVE_WATCH');
    if (this.#tripwire.check() !== null) return notEligible('WATCH_TRIPPED');

    const load = await this.#persistence.loadAccount(this.#accountId);
    if (load.kind === 'NOT_FOUND') return notEligible('ACCOUNT_NOT_INITIALIZED');
    if (load.kind === 'MALFORMED') return notEligible('ACCOUNT_MALFORMED');
    let account = load.account;
    if (account.fence.runtimeEpoch !== this.#runtimeEpoch) return notEligible('FENCE_NOT_ADOPTED_BY_THIS_RUNTIME');
    if (account.fence.mode.kind === 'MUTATION_LEASED' || account.state === 'MUTATING') return notEligible('MUTATION_LEASE_HELD');
    if (account.state === 'MANUAL_REVIEW_REQUIRED') return notEligible('MANUAL_REVIEW_REQUIRED');
    if (account.state === 'CERTIFIED_IDLE') return notEligible('ALREADY_CERTIFIED');
    if (account.state === 'CERTIFYING' || account.fence.mode.kind === 'CERTIFYING') return notEligible('CERTIFICATION_IN_PROGRESS');

    // Phase 18 eligibility first: nothing durable changes (not even leaving PROVIDER_UNAVAILABLE) for an attempt that cannot run.
    const reconciliation = await this.#readReconciliation();
    if (reconciliation === null) return notEligible('RECONCILIATION_STATE_UNAVAILABLE');
    const eligibility = this.#reconciliationEligibility(reconciliation, context, account.fence.reconciliationGeneration);
    if (eligibility !== null) return notEligible(eligibility);
    const generation = reconciliation.currentGeneration;

    if (account.state === 'PROVIDER_UNAVAILABLE') {
      const probe = await this.#probeProvider();
      if (probe === 'MISMATCH') {
        await this.#persistence.invalidate({ accountId: this.#accountId, reason: 'ACCOUNT_IDENTITY_MISMATCH', nowMs: this.#clock.nowMs() });
        return notEligible('ACCOUNT_IDENTITY_MISMATCH');
      }
      if (probe === 'UNAVAILABLE') return notEligible('PROVIDER_STILL_UNAVAILABLE');
      account = await this.#persistence.recordProviderRecovered({ accountId: this.#accountId, nowMs: this.#clock.nowMs() });
    }
    if (account.state !== 'QUARANTINED' || account.fence.mode.kind !== 'IDLE') return notEligible('CERTIFICATION_IN_PROGRESS');
    if (this.#tripwire.check() !== null) return notEligible('WATCH_TRIPPED');

    const runId = this.#newRunId();
    if (!isExactId(runId) || runId.length > RUN_ID_MAX_LENGTH) configurationError('The generated certification runId is not an exact identifier that fits the fence');
    const expectedIdle: PracticalFenceExpectation = {
      accountId: this.#accountId,
      runtimeEpoch: account.fence.runtimeEpoch,
      reconciliationGeneration: account.fence.reconciliationGeneration,
      revision: account.fence.revision,
    };
    let certifying: PracticalAccountSnapshot;
    try {
      certifying = await this.#persistence.startCertification({ accountId: this.#accountId, expected: expectedIdle, runId, nowMs: this.#clock.nowMs() });
    } catch (error) {
      // The durable fence refused: another run or a newer state won. Nothing changed.
      if (error instanceof PracticalLiveSafetyError || error instanceof PracticalPersistenceError) {
        return Object.freeze({ kind: 'LOST_RACE' as const, reason: error.code });
      }
      throw error;
    }
    const run: CertificationRun = {
      runId,
      expected: {
        accountId: this.#accountId,
        runtimeEpoch: certifying.fence.runtimeEpoch,
        reconciliationGeneration: certifying.fence.reconciliationGeneration,
        revision: certifying.fence.revision,
      },
      generation,
      watch: context.watch,
      lastNowMs: this.#clock.nowMs(),
      clockAnomaly: false,
    };
    return this.#runCertification(run);
  }

  /**
   * REVOKE-ONLY authority monitor for an outstanding certificate: expires it
   * at its absolute expiry, and revokes it when the watch tripped, the watched
   * incarnation is gone, the clock ran before issuance, the certificate is
   * not the one issued under the current watch, a durable-safety hold stands,
   * or the Phase 18 generation it is bound to is no longer the current HEALTHY
   * one. The Phase 18 read is an ASYNC BOUNDARY: the stream, the watch, and
   * the binding are re-derived AFTER it, immediately before any
   * CERTIFICATE_STILL_VALID. It never extends, renews, or re-issues anything.
   */
  public async monitorAuthority(): Promise<PracticalAuthorityCheck> {
    this.#tripwire.check();
    await this.#tripwire.settled();
    let load: PracticalAccountLoad;
    try {
      load = await this.#persistence.loadAccount(this.#accountId);
    } catch {
      return this.#authorityUnconfirmed(this.#tripwire.trip?.reason ?? 'EVIDENCE_STALE');
    }
    // Only a valid FOUND read can prove "no outstanding certificate".
    if (load.kind === 'MALFORMED') return this.#authorityUnconfirmed(this.#tripwire.trip?.reason ?? 'EVIDENCE_STALE');
    if (load.kind !== 'FOUND') {
      const everAuthorityBearing = this.#outstanding !== null || this.#watch !== null || this.#tripwire.watch !== null || this.#tripwire.trip !== null || this.#hold !== null;
      if (everAuthorityBearing) return this.#authorityUnconfirmed(this.#tripwire.trip?.reason ?? 'EVIDENCE_STALE');
      return Object.freeze({ kind: 'ACCOUNT_NOT_INITIALIZED' as const });
    }
    if (load.account.state !== 'CERTIFIED_IDLE' || load.account.currentCertificate === null) {
      return Object.freeze({ kind: 'NO_OUTSTANDING_CERTIFICATE' as const, tripped: this.#tripwire.trip !== null });
    }
    const certificate = load.account.currentCertificate;
    const nowMs = this.#clock.nowMs();
    const ageMs = Math.max(0, nowMs - certificate.issuedAtMs);
    if (nowMs >= certificate.expiresAtMs) {
      try {
        await this.#persistence.expireCertificate({ accountId: this.#accountId, certificateId: certificate.certificateId, trustedNowMs: nowMs });
      } catch {
        return this.#authorityUnconfirmed('CERTIFICATE_EXPIRED');
      }
      this.#revokeOutstanding('CERTIFICATE_EXPIRED', nowMs);
      recordSafely(this.#telemetry, { type: 'P18B_AUTHORITY_ENDED', accountId: this.#accountId, reason: 'CERTIFICATE_EXPIRED', certificateAgeMs: ageMs });
      return Object.freeze({ kind: 'CERTIFICATE_EXPIRED' as const });
    }
    let reason = this.#authorityProblem(certificate, nowMs);
    if (reason === null) {
      const state = await this.#readReconciliation();
      if (state === null
        || state.status !== 'HEALTHY'
        || state.currentGeneration !== certificate.reconciliationGeneration
        || state.healthyGeneration !== certificate.reconciliationGeneration
        || state.currentRuntimeEpoch !== this.#runtimeEpoch) {
        reason = 'GENERATION_CHANGED';
      }
      // The Phase 18 read was an async boundary: anything may have tripped during it.
      if (reason === null) reason = this.#authorityProblem(certificate, this.#clock.nowMs());
    }
    if (reason === null) return Object.freeze({ kind: 'CERTIFICATE_STILL_VALID' as const });
    await this.#tripwire.settled();
    const revoked = await this.#ensureRevoked(certificate.certificateId, reason);
    this.#revokeOutstanding(reason, nowMs);
    recordSafely(this.#telemetry, { type: 'P18B_AUTHORITY_ENDED', accountId: this.#accountId, reason, certificateAgeMs: ageMs });
    return revoked
      ? Object.freeze({ kind: 'CERTIFICATE_REVOKED' as const, reason })
      : Object.freeze({ kind: 'REVOCATION_UNCONFIRMED' as const, reason });
  }

  /**
   * Synchronous authority predicates over the current in-memory view,
   * re-derived on every call (the stream check re-derives readiness and trips
   * on any change). Null only when every one holds.
   */
  #authorityProblem(certificate: { readonly certificateId: string; readonly issuedAtMs: number; readonly streamIncarnation: number }, nowMs: number): PracticalInvalidationReason | null {
    if (nowMs < certificate.issuedAtMs) return 'CLOCK_ANOMALY';
    if (this.#hold !== null) return this.#hold.reason;
    const context = this.#watch;
    if (context === null || this.#tripwire.watch !== context.watch) return this.#tripwire.trip?.reason ?? 'STREAM_INCARNATION_CHANGED';
    const trip = this.#tripwire.check();
    if (trip !== null) return trip.reason;
    if (context.watch.binding.incarnation !== certificate.streamIncarnation) return 'STREAM_INCARNATION_CHANGED';
    const outstanding = this.#outstanding;
    // Only the certificate THIS service issued under THIS watch can still be valid.
    if (outstanding === null || outstanding.certificate.certificateId !== certificate.certificateId || outstanding.watch !== context.watch) return 'EVIDENCE_STALE';
    return null;
  }

  /** The durable state could not be read or changed: no authority is claimed, and the service is blocked. */
  #authorityUnconfirmed(reason: PracticalInvalidationReason): PracticalAuthorityCheck {
    this.#revokeOutstanding(reason, this.#clock.nowMs());
    this.#setHold(reason);
    return Object.freeze({ kind: 'REVOCATION_UNCONFIRMED' as const, reason });
  }

  #setHold(reason: PracticalInvalidationReason): void {
    if (this.#hold === null) this.#hold = Object.freeze({ reason });
  }

  /**
   * Durably revokes `certificateId` (Stage 1A invalidation) and CONFIRMS it
   * from a fresh read: true only when a valid read shows it is no longer the
   * current certificate. Anything else (failed writes, unreadable or
   * ambiguous state) sets the durable-safety hold and returns false.
   */
  async #ensureRevoked(certificateId: string, reason: PracticalInvalidationReason): Promise<boolean> {
    for (let attempt = 0; attempt <= RELEASE_MAX_ATTEMPTS; attempt += 1) {
      try {
        const load = await this.#persistence.loadAccount(this.#accountId);
        if (load.kind !== 'FOUND') break;
        const current = load.account.currentCertificate;
        if (current === null || current.certificateId !== certificateId) return true;
        if (attempt === RELEASE_MAX_ATTEMPTS) break;
        await this.#persistence.invalidate({ accountId: this.#accountId, reason, nowMs: this.#clock.nowMs() });
      } catch {
        // Retried; a persistent fault ends in the hold below.
      }
    }
    this.#setHold(reason);
    recordSafely(this.#telemetry, { type: 'P18B_REVOCATION_FAILED', accountId: this.#accountId, reason, failure: 'REVOCATION_UNCONFIRMED' });
    logger.error({ accountId: this.#accountId, reason }, 'P18B could not confirm a durable certificate revocation; the service is blocked until durable safety is proven');
    return false;
  }

  // ----- the run -------------------------------------------------------------

  async #runCertification(run: CertificationRun): Promise<PracticalCertificationOutcome> {
    const passes: PracticalObservationPass[] = [];
    try {
      for (let index = 1; index <= this.#ceilings.minimumPasses; index += 1) {
        if (index > 1) await this.#pauseBeforePass(run, passes, index);
        this.#guardStream(run);
        const pass = await this.#observePass(run, index);
        passes.push(pass);
        const hardCeilingExceeded = pass.durationMs > this.#hard.passDurationMs;
        recordSafely(this.#telemetry, {
          type: 'P18B_PASS',
          runId: run.runId,
          passIndex: index,
          durationMs: pass.durationMs,
          observationSkewMs: pass.observationSkewMs,
          maxInterReadGapMs: pass.maxInterReadGapMs,
          complete: pass.complete,
          failure: pass.failure,
          bracketDisagreement: pass.bracketDisagreement,
          stateDigestPrefix: pass.stateDigest === null ? null : pass.stateDigest.slice(0, 12),
          passCandidateExceeded: practicalCandidateExceeded(pass.durationMs, this.#timing.passWindow),
          interReadGapCandidateExceeded: practicalCandidateExceeded(pass.maxInterReadGapMs, this.#timing.interReadGap),
          hardCeilingExceeded,
        });
        if (pass.bracketDisagreement !== null) {
          recordSafely(this.#telemetry, { type: 'P18B_DISAGREEMENT', runId: run.runId, passIndex: index, reason: pass.bracketDisagreement });
        }
        if (run.clockAnomaly) throw new RunAbort('CLOCK_ANOMALY', null);
        if (!pass.complete) throw new RunAbort(pass.failure ?? 'MALFORMED_RESPONSE', null);
        if (hardCeilingExceeded) throw new RunAbort('PASS_HARD_CEILING_EXCEEDED', null);
        this.#guardStream(run);
        await this.#guardGeneration(run);
        if (pass.stateDigest !== passes[0]!.stateDigest) {
          recordSafely(this.#telemetry, { type: 'P18B_DISAGREEMENT', runId: run.runId, passIndex: index, reason: 'STATE_DIGEST_DIFFERS' });
          throw new RunAbort('OBSERVATION_DISAGREEMENT', null);
        }
      }

      const bindings = {
        accountId: this.#accountId,
        providerAccountFingerprint: this.#fingerprint,
        runtimeEpoch: this.#runtimeEpoch,
        reconciliationGeneration: run.generation,
        streamIncarnation: run.watch.binding.incarnation,
      };
      const evaluation = evaluatePracticalCertificationEvidence({ ...bindings, runId: run.runId }, passes, this.#ceilings);
      if (evaluation.kind === 'REJECTED') throw new RunAbort(evaluation.failure, null);

      // Final gates immediately before issuance: stream, THEN the generation (an await), THEN the stream AGAIN.
      this.#guardStream(run);
      await this.#guardGeneration(run);
      this.#guardStream(run);
      const issuedAtMs = this.#tick(run);
      if (run.clockAnomaly) throw new RunAbort('CLOCK_ANOMALY', null);

      let certificate: PracticalRecoveryCertificate;
      try {
        certificate = issuePracticalRecoveryCertificate({ enablement: this.#enablement, bindings, evidence: evaluation.summary, issuedAtMs });
      } catch {
        throw new RunAbort('ISSUANCE_REFUSED', null);
      }
      return await this.#persistIssued(run, certificate, evaluation.summary, issuedAtMs, passes.length);
    } catch (error) {
      const abort = error instanceof RunAbort ? error : null;
      if (abort === null) logger.error({ accountId: this.#accountId, runId: run.runId, failure: error instanceof Error ? error.name : 'UNKNOWN' }, 'P18B certification run failed unexpectedly');
      return this.#failRun(run, abort === null ? 'UNEXPECTED_ERROR' : abort.failure, abort === null ? null : abort.tripReason, passes);
    }
  }

  /**
   * finishCertification in the one Stage 1B1 transaction; an invalidation
   * that commits first wins. The commit is an ASYNC BOUNDARY: after it, the
   * stream is re-checked, THEN the Phase 18 generation (itself async), THEN
   * the stream AGAIN, and only then may CERTIFIED be returned. Any failure
   * durably revokes the just-persisted certificate (confirmed, else the
   * durable-safety hold), revokes the in-memory one, and returns SUPERSEDED.
   * This does not make the provider state atomic; Stage 1B2 still needs its
   * own final pre-arm revalidation.
   */
  async #persistIssued(
    run: CertificationRun,
    certificate: PracticalRecoveryCertificate,
    summary: PracticalCertificationEvidenceSummary,
    issuedAtMs: number,
    passCount: number,
  ): Promise<PracticalCertificationOutcome> {
    this.#outstanding = Object.freeze({ certificate, issuedAtMs, watch: run.watch });
    let account: PracticalAccountSnapshot;
    try {
      account = await this.#persistence.finishCertification({
        accountId: this.#accountId,
        expected: run.expected,
        runId: run.runId,
        resultingGeneration: run.generation,
        certificate,
        nowMs: issuedAtMs,
      });
    } catch {
      // Normally rolled back with nothing persisted. The in-memory certificate is never usable either way.
      this.#revokeOutstanding('EVIDENCE_STALE', issuedAtMs);
      const trip = this.#tripwire.trip;
      const outcome = trip !== null && this.#tripwire.watch === run.watch
        ? await this.#failRun(run, 'STREAM_CHANGED', trip.reason, [], 'SUPERSEDED')
        : await this.#failRun(run, 'PERSISTENCE_REFUSED', null, []);
      // If the transaction in fact committed (e.g. the connection failed after COMMIT), the durable
      // certificate has no in-memory holder any more: revoke it durably (confirmed) rather than leave it ISSUED.
      await this.#ensureRevoked(certificate.certificateId, 'EVIDENCE_STALE');
      return outcome;
    }
    // Post-persistence revalidation: stream, THEN generation (async), THEN stream again.
    const problem = await this.#postPersistenceProblem(run);
    if (problem !== null) {
      await this.#tripwire.settled();
      this.#revokeOutstanding(problem.reason, this.#clock.nowMs());
      await this.#ensureRevoked(certificate.certificateId, problem.reason);
      recordSafely(this.#telemetry, {
        type: 'P18B_CERTIFICATION',
        runId: run.runId,
        outcome: 'SUPERSEDED',
        failure: problem.failure,
        passCount,
        certificationSpanMs: summary.certificationSpanMs,
        minimumObservedPassSpacingMs: summary.minimumObservedPassSpacingMs,
      });
      return Object.freeze({ kind: 'SUPERSEDED' as const, runId: run.runId, reason: problem.reason, account: await this.#loadSnapshot() });
    }
    recordSafely(this.#telemetry, {
      type: 'P18B_CERTIFICATION',
      runId: run.runId,
      outcome: 'CERTIFIED',
      failure: null,
      passCount,
      certificationSpanMs: summary.certificationSpanMs,
      minimumObservedPassSpacingMs: summary.minimumObservedPassSpacingMs,
    });
    return Object.freeze({ kind: 'CERTIFIED' as const, runId: run.runId, certificate, summary, account });
  }

  /** Releases the run's fence with the mapped Stage 1A failure (zero or one durable change). */
  async #failRun(
    run: CertificationRun,
    failure: PracticalCertificationFailureCode,
    tripReason: PracticalInvalidationReason | null,
    passes: readonly PracticalObservationPass[],
    kind: 'FAILED' | 'SUPERSEDED' = 'FAILED',
  ): Promise<PracticalCertificationOutcome> {
    const trip = this.#tripwire.trip !== null && this.#tripwire.watch === run.watch ? this.#tripwire.trip : null;
    // A tripwire invalidation that already happened decides the reason.
    const effectiveFailure = trip !== null ? 'STREAM_CHANGED' : failure;
    const effectiveTripReason = trip !== null ? trip.reason : tripReason;
    const durableFailure = practicalDurableFailureFor(effectiveFailure, effectiveTripReason);
    await this.#tripwire.settled();
    const release = await this.#release(run, durableFailure);
    recordSafely(this.#telemetry, {
      type: 'P18B_CERTIFICATION',
      runId: run.runId,
      outcome: trip !== null || kind === 'SUPERSEDED' ? 'SUPERSEDED' : 'FAILED',
      failure: effectiveFailure,
      passCount: passes.length,
      certificationSpanMs: null,
      minimumObservedPassSpacingMs: null,
    });
    if (trip !== null || kind === 'SUPERSEDED') {
      return Object.freeze({ kind: 'SUPERSEDED' as const, runId: run.runId, reason: effectiveTripReason ?? 'UNKNOWN_PRIVATE_EVENT', account: release.account });
    }
    return Object.freeze({
      kind: 'FAILED' as const,
      runId: run.runId,
      failure: effectiveFailure,
      durableFailure,
      released: release.released,
      account: release.account,
    });
  }

  async #release(run: CertificationRun, failure: PracticalCertificationFailure): Promise<{ readonly released: boolean; readonly account: PracticalAccountSnapshot | null }> {
    for (let attempt = 1; attempt <= RELEASE_MAX_ATTEMPTS; attempt += 1) {
      try {
        const account = await this.#persistence.failCertification({
          accountId: this.#accountId,
          expected: run.expected,
          runId: run.runId,
          resultingGeneration: run.generation,
          failure,
          nowMs: this.#clock.nowMs(),
        });
        if (this.#unreleased !== null && this.#unreleased.run.runId === run.runId) this.#unreleased = null;
        return { released: true, account };
      } catch (error) {
        // A stale run (the fence was adopted, finished, or moved by someone else) must not retry: it owns nothing.
        if (error instanceof PracticalLiveSafetyError || (error instanceof PracticalPersistenceError && error.code !== 'PRACTICAL_PERSISTENCE_FAULT')) {
          if (this.#unreleased !== null && this.#unreleased.run.runId === run.runId) this.#unreleased = null;
          return { released: false, account: await this.#loadSnapshot() };
        }
      }
    }
    this.#unreleased = Object.freeze({ run, failure });
    logger.error({ accountId: this.#accountId, runId: run.runId }, 'P18B certification fence release failed; it is retried before the next certification');
    return { released: false, account: null };
  }

  async #retryUnreleased(): Promise<void> {
    const pending = this.#unreleased;
    if (pending !== null) await this.#release(pending.run, pending.failure);
  }

  // ----- one pass --------------------------------------------------------------

  /**
   * One bracketed pass: identity, O1 P1 O2 P2 O3, identity, back to back
   * (no deliberate pause inside a pass: a tight bracket is the point), with
   * the stream checked between reads. Stops at the first failed read or the
   * first bracket disagreement: a partial pass never counts.
   */
  async #observePass(run: CertificationRun, index: number): Promise<PracticalObservationPass> {
    const reads: PracticalReadObservation[] = [];
    // The adapter may ignore this; the engine enforces the HARD read timeout itself.
    const timeoutMs = this.#hard.readTimeoutMs;
    const steps: Readonly<Record<PracticalObservationReadKind, { readonly call: () => Promise<unknown>; readonly observe: (value: unknown) => PracticalReadContent }>> = {
      IDENTITY: {
        call: () => this.#venue.readAccountIdentity({ accountId: this.#accountId, timeoutMs }),
        observe: (value) => observeIdentityRead(value, this.#fingerprint),
      },
      // Account-wide: an empty pair list never narrows the read (the port may only read wider).
      ORDERS: { call: () => this.#venue.readOrders({ accountId: this.#accountId, pairs: [], timeoutMs }), observe: observeOrderRead },
      POSITIONS: { call: () => this.#venue.readPositions({ accountId: this.#accountId, timeoutMs }), observe: observePositionRead },
    };
    for (const [position, planned] of PRACTICAL_PASS_READ_PLAN.entries()) {
      if (position > 0) this.#guardStream(run);
      const step = steps[planned.kind];
      const read = await this.#timedRead(run, index, planned.slot, planned.kind, step.call, step.observe);
      reads.push(read);
      if (read.failure !== null || practicalBracketDisagreement(reads) !== null) break;
    }
    return assemblePracticalPass(index, reads);
  }

  async #timedRead(
    run: CertificationRun,
    passIndex: number,
    slot: PracticalPassReadSlot,
    kind: PracticalObservationReadKind,
    call: () => Promise<unknown>,
    observe: (value: unknown) => PracticalReadContent,
  ): Promise<PracticalReadObservation> {
    const startedAtMs = this.#tick(run);
    let result: PracticalReadContent;
    try {
      result = observe(await this.#withTimeout(call, this.#hard.readTimeoutMs));
    } catch (error) {
      result = Object.freeze({ failure: error === READ_TIMED_OUT ? 'READ_HARD_TIMEOUT' as const : 'PROVIDER_UNAVAILABLE' as const, pagesRead: null, complete: false, contentDigest: null });
    }
    const endedAtMs = this.#tick(run);
    const failure = run.clockAnomaly && result.failure === null ? 'CLOCK_ANOMALY' as const : result.failure;
    const observation: PracticalReadObservation = Object.freeze({
      slot,
      kind,
      startedAtMs,
      endedAtMs,
      latencyMs: endedAtMs - startedAtMs,
      failure,
      pagesRead: result.pagesRead,
      complete: failure === null && result.complete,
      contentDigest: failure === null ? result.contentDigest : null,
    });
    recordSafely(this.#telemetry, {
      type: 'P18B_READ',
      runId: run.runId,
      passIndex,
      slot,
      read: kind,
      latencyMs: observation.latencyMs,
      outcome: failure ?? 'OK',
      pagesRead: observation.pagesRead,
      complete: observation.complete,
      readCandidateExceeded: practicalCandidateExceeded(observation.latencyMs, this.#timing.readDuration),
      hardTimeout: failure === 'READ_HARD_TIMEOUT',
    });
    return observation;
  }

  #withTimeout(call: () => Promise<unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const handle = this.#scheduler.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(READ_TIMED_OUT);
      }, timeoutMs);
      const settle = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        this.#scheduler.clearTimeout(handle);
        outcome();
      };
      let pending: Promise<unknown>;
      try {
        pending = call();
      } catch (error) {
        settle(() => reject(error));
        return;
      }
      Promise.resolve(pending).then((value) => settle(() => resolve(value)), (error: unknown) => settle(() => reject(error)));
    });
  }

  // ----- pacing and guards ----------------------------------------------------

  /**
   * The pause BETWEEN passes: the next pass starts no earlier than the
   * previous pass's end plus the spacing ceiling, and the LAST pass starts no
   * earlier than the first pass's start plus the span ceiling (so the span is
   * met). There is no pause inside a pass.
   */
  async #pauseBeforePass(run: CertificationRun, passes: readonly PracticalObservationPass[], index: number): Promise<void> {
    const previous = passes[passes.length - 1]!;
    let target = previous.endedAtMs + this.#ceilings.minimumPassSpacingMs;
    if (index === this.#ceilings.minimumPasses) target = Math.max(target, passes[0]!.startedAtMs + this.#ceilings.minimumCertificationSpanMs);
    await this.#pause(target - this.#tick(run));
    const startMs = this.#tick(run);
    recordSafely(this.#telemetry, { type: 'P18B_PASS_SPACING', runId: run.runId, afterPassIndex: index - 1, spacingMs: startMs - previous.endedAtMs });
    if (run.clockAnomaly) throw new RunAbort('CLOCK_ANOMALY', null);
  }

  #pause(delayMs: number): Promise<void> {
    if (!(delayMs > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      this.#scheduler.setTimeout(resolve, delayMs);
    });
  }

  /** Local time for the run; a clock that runs backwards (or is malformed) marks the run anomalous. */
  #tick(run: CertificationRun): number {
    const nowMs = this.#clock.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs < run.lastNowMs) {
      run.clockAnomaly = true;
      return run.lastNowMs;
    }
    run.lastNowMs = nowMs;
    return nowMs;
  }

  /** The run's exact watch, re-checked (readiness re-derived; any change trips). Null when it still holds. */
  #streamProblem(run: CertificationRun): PracticalInvalidationReason | null {
    if (this.#tripwire.watch !== run.watch) return this.#tripwire.trip?.reason ?? 'STREAM_INCARNATION_CHANGED';
    const trip = this.#tripwire.check();
    return trip === null ? null : trip.reason;
  }

  #guardStream(run: CertificationRun): void {
    const reason = this.#streamProblem(run);
    if (reason !== null) throw new RunAbort('STREAM_CHANGED', reason);
  }

  /** The run's exact Phase 18 generation, runtime, and HEALTHY state, re-read. Async. */
  async #generationProblem(run: CertificationRun): Promise<'GENERATION_CHANGED' | null> {
    const state = await this.#readReconciliation();
    if (state === null
      || state.currentGeneration !== run.generation
      || state.healthyGeneration !== run.generation
      || state.status !== 'HEALTHY'
      || state.currentRuntimeEpoch !== this.#runtimeEpoch) {
      return 'GENERATION_CHANGED';
    }
    return null;
  }

  async #guardGeneration(run: CertificationRun): Promise<void> {
    if ((await this.#generationProblem(run)) !== null) throw new RunAbort('GENERATION_CHANGED', null);
  }

  /** After the certificate commit: stream, THEN generation (an await), THEN stream AGAIN, then the hold. */
  async #postPersistenceProblem(run: CertificationRun): Promise<{ readonly reason: PracticalInvalidationReason; readonly failure: PracticalCertificationFailureCode } | null> {
    const streamBefore = this.#streamProblem(run);
    if (streamBefore !== null) return { reason: streamBefore, failure: 'STREAM_CHANGED' };
    const generation = await this.#generationProblem(run);
    if (generation !== null) return { reason: generation, failure: 'GENERATION_CHANGED' };
    const streamAfter = this.#streamProblem(run);
    if (streamAfter !== null) return { reason: streamAfter, failure: 'STREAM_CHANGED' };
    if (this.#hold !== null) return { reason: this.#hold.reason, failure: 'PERSISTENCE_REFUSED' };
    return null;
  }

  #reconciliationEligibility(state: PracticalReconciliationStateView, context: WatchContext, fenceGeneration: number): PracticalCertificationIneligibility | null {
    if (state.status !== 'HEALTHY' || state.healthyGeneration !== state.currentGeneration || !isPositiveSafeInteger(state.currentGeneration)) {
      return 'RECONCILIATION_NOT_HEALTHY';
    }
    if (state.currentRuntimeEpoch !== this.#runtimeEpoch) return 'RECONCILIATION_OTHER_RUNTIME';
    // Claimed after the watch armed: every read of that Phase 18 run happened under the watch.
    if (state.currentGeneration <= context.reconciliationGenerationAtArm) return 'RECONCILIATION_GENERATION_NOT_AFTER_WATCH';
    // Stage 1A: a certification must finish on a generation strictly after the fence's.
    if (state.currentGeneration <= fenceGeneration) return 'RECONCILIATION_GENERATION_NOT_NEWER_THAN_FENCE';
    return null;
  }

  async #readReconciliation(): Promise<PracticalReconciliationStateView | null> {
    try {
      const state = await this.#reconciliation.loadState(this.#accountId);
      if (typeof state !== 'object' || state === null || state.accountId !== this.#accountId) return null;
      return state;
    } catch {
      return null;
    }
  }

  /** One identity read, used to leave PROVIDER_UNAVAILABLE. A probe is not certification evidence. */
  async #probeProvider(): Promise<'OK' | 'MISMATCH' | 'UNAVAILABLE'> {
    try {
      const read = await this.#withTimeout(
        () => this.#venue.readAccountIdentity({ accountId: this.#accountId, timeoutMs: this.#hard.readTimeoutMs }),
        this.#hard.readTimeoutMs,
      );
      const observed = observeIdentityRead(read, this.#fingerprint);
      if (observed.failure === null) return 'OK';
      return observed.failure === 'ACCOUNT_FINGERPRINT_MISMATCH' ? 'MISMATCH' : 'UNAVAILABLE';
    } catch {
      return 'UNAVAILABLE';
    }
  }

  async #loadSnapshot(): Promise<PracticalAccountSnapshot | null> {
    try {
      const load = await this.#persistence.loadAccount(this.#accountId);
      return load.kind === 'FOUND' ? load.account : null;
    } catch {
      return null;
    }
  }

  // ----- tripwire hooks (revoke-only) -----------------------------------------

  #onTrip(trip: PracticalTrip): void {
    const outstanding = this.#outstanding;
    recordSafely(this.#telemetry, {
      type: 'P18B_TRIPWIRE',
      accountId: this.#accountId,
      reason: trip.reason,
      incarnation: trip.incarnation,
      certificateAgeMs: outstanding === null ? null : Math.max(0, trip.atMs - outstanding.issuedAtMs),
    });
    this.#revokeOutstanding(trip.reason, trip.atMs);
  }

  /** In-memory mirror only: the durable revocation is the authority. */
  #revokeOutstanding(reason: PracticalInvalidationReason, nowMs: number): void {
    const outstanding = this.#outstanding;
    this.#outstanding = null;
    if (outstanding === null) return;
    try {
      revokePracticalRecoveryCertificate(outstanding.certificate, reason, Math.max(nowMs, 0));
    } catch {
      // Already terminal, or an unusable time: it can never become usable either way.
    }
  }
}
