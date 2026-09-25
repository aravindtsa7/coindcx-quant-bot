/**
 * Phase 18B practical account state machine (Stage 1A).
 *
 * Pure: one function computes the next state from the current state and one
 * typed event, and throws for anything not in the allowed table. A state is
 * only a label: reaching CERTIFIED_IDLE grants nothing by itself (a mutation
 * additionally needs a genuine, unexpired, correctly bound
 * `PracticalRecoveryCertificate` and a fence lease), and no transition
 * produces, implies, or names strict account continuity.
 *
 * FAIL-CLOSED FALLBACK. A caller that catches a transition failure must use
 * `practicalStateAfterTransitionFailure(current)`. It must never hard-code a
 * state. That rule keeps MANUAL_REVIEW_REQUIRED sticky, so a failed or
 * illegal event can never be used to leave manual review. It sends any
 * unknown or malformed current state to MANUAL_REVIEW_REQUIRED, never to the
 * certifiable QUARANTINED. The same rule governs startup
 * (`practicalAccountStateOnStartup`): an unknown, corrupt, or future durable
 * state is never read as certifiable.
 *
 * STAGE 1B INTEGRATION CONTRACT (documented only; no persistence here):
 *   - wherever persistence or the runtime catches a practical transition
 *     failure, it persists `practicalStateAfterTransitionFailure(current)`.
 *     It MUST NOT write QUARANTINED directly;
 *   - if the durable state row itself is malformed or unknown, Stage 1B
 *     creates (or retains) a MANUAL_REVIEW_REQUIRED episode with a fresh
 *     durable reviewEpisodeId. Certification can restart only after the
 *     normal account + episode-bound, one-shot OPERATOR_RESOLUTION.
 *
 *   startup/restart           -> null: QUARANTINED; MANUAL_REVIEW_REQUIRED: sticky;
 *                                other known states: QUARANTINED; unknown/malformed: MANUAL_REVIEW_REQUIRED
 *   QUARANTINED               -> CERTIFYING
 *   CERTIFYING                -> CERTIFIED_IDLE | PROVIDER_UNAVAILABLE | MANUAL_REVIEW_REQUIRED | QUARANTINED
 *   PROVIDER_UNAVAILABLE      -> QUARANTINED | MANUAL_REVIEW_REQUIRED
 *   CERTIFIED_IDLE            -> MUTATING | QUARANTINED (revoke/expiry) | MANUAL_REVIEW_REQUIRED
 *   MUTATING                  -> QUARANTINED after ANY outcome, or IMMEDIATELY on an invalidation
 *                                (MANUAL_REVIEW_REQUIRED when its severity is MANUAL_REVIEW)
 *   MANUAL_REVIEW_REQUIRED    -> QUARANTINED only via a genuine, one-shot operator resolution
 *                                bound to this account AND the current review episode
 *
 * An invalidation whose severity is MANUAL_REVIEW goes straight to
 * MANUAL_REVIEW_REQUIRED from any state, never merely to QUARANTINED.
 *
 * Account SAFETY STATE and the mutation FENCE are separate concerns. An
 * invalidation while MUTATING moves the safety state immediately, so the
 * severity is durable the moment the state is persisted: it never waits in
 * caller memory for a later event, and a restart cannot lose it (startup keeps
 * MANUAL_REVIEW_REQUIRED). The in-flight mutation's lease stays held in the
 * fence (`fence.ts`) until its outcome is durably recorded; recording that
 * outcome and releasing the lease is the fence/persistence layer's job in
 * Stage 1B. MUTATION_OUTCOME_RECORDED here is monotone: from MUTATING it
 * yields QUARANTINED, and after an invalidation already moved the account to
 * QUARANTINED or MANUAL_REVIEW_REQUIRED it leaves that state unchanged. It
 * never downgrades a state and never restores CERTIFIED_IDLE. (The
 * certificate is already consumed at lease time, so no authority survives
 * either way.)
 */
import { classifyPracticalInvalidation, practicalStateForSeverity } from './invalidation';
import {
  PRACTICAL_MUTATION_OUTCOMES,
  PracticalLiveSafetyError,
  isExactId,
  isPracticalAccountStateName,
  type PracticalAccountStateName,
  type PracticalInvalidationReason,
  type PracticalMutationOutcome,
} from './types';

// Operator resolution: the only exit from MANUAL_REVIEW_REQUIRED.
//
// The minting boundary (`mintPracticalManualReviewResolution`) is INTERNAL. It
// is not exported from the practical barrel, and in Stage 1A nothing in `src/`
// references it: an architecture test pins its production importer set to
// exactly empty. Operator authentication and approval are not designed yet.
// The future trusted operator-resolution adapter that owns that channel is the
// one exception still to be reviewed, and it must be added explicitly.
//
// EPISODE BINDING. A resolution clears one account's one review episode.
// STAGE 1B MUST: (a) create a new durable reviewEpisodeId every time an account
// ENTERS MANUAL_REVIEW_REQUIRED; (b) load the CURRENT durable reviewEpisodeId
// under the same trusted persistence boundary (the same locked
// read/transaction) that applies OPERATOR_RESOLUTION and persists the result;
// (c) never take the episode from the resolution or the operator's request.

// ---------------------------------------------------------------------------
// Operator resolution (the only exit from MANUAL_REVIEW_REQUIRED)
// ---------------------------------------------------------------------------

export interface PracticalManualReviewResolutionRecord {
  readonly accountId: string;
  /**
   * The specific durable manual-review EPISODE this resolution clears. A
   * resolution can clear only that episode, never a later review of the same
   * account, so an unused resolution from an old review has no effect on a
   * new one.
   */
  readonly reviewEpisodeId: string;
  readonly resolutionId: string;
  /**
   * Caller-asserted operator label for audit. It is NOT an authenticated
   * identity; authenticating who may resolve is a later-stage decision.
   */
  readonly assertedBy: string;
  readonly note: string;
}

const RESOLUTION_ISSUER = Object.freeze({ purpose: 'p18b-manual-review-resolution' });

/**
 * An explicit, non-structural, ONE-SHOT operator resolution for one account
 * AND one review episode. It can only move MANUAL_REVIEW_REQUIRED to
 * QUARANTINED — i.e. restart certification from scratch. It never grants
 * mutation authority.
 */
export class PracticalManualReviewResolution {
  readonly #record: PracticalManualReviewResolutionRecord;
  #used = false;

  public constructor(issuer: unknown, record: PracticalManualReviewResolutionRecord) {
    if (issuer !== RESOLUTION_ISSUER) {
      throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'A manual-review resolution may only be minted by mintPracticalManualReviewResolution');
    }
    this.#record = Object.freeze({ ...record });
    Object.freeze(this);
  }

  public static read(value: unknown): PracticalManualReviewResolutionRecord | null {
    if (!(value instanceof PracticalManualReviewResolution)) return null;
    try {
      return value.#record;
    } catch {
      return null;
    }
  }

  /** Marks the resolution used. Throws if it was used before (no replay). */
  public static consume(value: PracticalManualReviewResolution): PracticalManualReviewResolutionRecord {
    const record = PracticalManualReviewResolution.read(value);
    if (record === null) {
      throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'Not a genuine manual-review resolution');
    }
    if (value.#used) {
      throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'This manual-review resolution was already used', { resolutionId: record.resolutionId });
    }
    value.#used = true;
    return record;
  }
}
Object.freeze(PracticalManualReviewResolution.prototype);
Object.freeze(PracticalManualReviewResolution);

/**
 * INTERNAL MINT BOUNDARY: validates and mints an explicit operator resolution.
 * Every field must be a non-empty exact string. Not exported from the barrel,
 * with production importers pinned to none (see the header).
 */
export function mintPracticalManualReviewResolution(input: PracticalManualReviewResolutionRecord): PracticalManualReviewResolution {
  for (const [field, value] of Object.entries({
    accountId: input.accountId,
    reviewEpisodeId: input.reviewEpisodeId,
    resolutionId: input.resolutionId,
    assertedBy: input.assertedBy,
    note: input.note,
  })) {
    if (!isExactId(value)) {
      throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', `Manual-review resolution field ${field} must be a non-empty exact string`);
    }
  }
  return new PracticalManualReviewResolution(RESOLUTION_ISSUER, {
    accountId: input.accountId,
    reviewEpisodeId: input.reviewEpisodeId,
    resolutionId: input.resolutionId,
    assertedBy: input.assertedBy,
    note: input.note,
  });
}

// ---------------------------------------------------------------------------
// Events and the transition table
// ---------------------------------------------------------------------------

export type PracticalTransitionEvent =
  | { readonly kind: 'CERTIFICATION_STARTED' }
  | { readonly kind: 'CERTIFICATION_SUCCEEDED' }
  | { readonly kind: 'PROVIDER_UNAVAILABLE' }
  | { readonly kind: 'PROVIDER_RECOVERED' }
  | { readonly kind: 'MUTATION_LEASED' }
  | { readonly kind: 'MUTATION_OUTCOME_RECORDED'; readonly outcome: PracticalMutationOutcome }
  | { readonly kind: 'INVALIDATED'; readonly reason: PracticalInvalidationReason }
  | {
      readonly kind: 'OPERATOR_RESOLUTION';
      /** The account whose state is being transitioned (from trusted durable state). */
      readonly accountId: string;
      /**
       * The CURRENT manual-review episode, as recorded in trusted durable state.
       * Stage 1B must load it under the same trusted persistence boundary
       * (the same locked read/transaction) that then applies this transition.
       * It must never come from the resolution itself or from the operator's
       * request.
       */
      readonly reviewEpisodeId: string;
      readonly resolution: PracticalManualReviewResolution;
    };

/** Every (from -> to) pair any event may produce. Anything else is illegal. */
export const PRACTICAL_ALLOWED_TRANSITIONS: Readonly<Record<PracticalAccountStateName, readonly PracticalAccountStateName[]>> = Object.freeze({
  QUARANTINED: Object.freeze<PracticalAccountStateName[]>(['QUARANTINED', 'CERTIFYING', 'MANUAL_REVIEW_REQUIRED']),
  CERTIFYING: Object.freeze<PracticalAccountStateName[]>(['CERTIFIED_IDLE', 'PROVIDER_UNAVAILABLE', 'MANUAL_REVIEW_REQUIRED', 'QUARANTINED']),
  PROVIDER_UNAVAILABLE: Object.freeze<PracticalAccountStateName[]>(['QUARANTINED', 'MANUAL_REVIEW_REQUIRED']),
  CERTIFIED_IDLE: Object.freeze<PracticalAccountStateName[]>(['MUTATING', 'QUARANTINED', 'MANUAL_REVIEW_REQUIRED']),
  MUTATING: Object.freeze<PracticalAccountStateName[]>(['QUARANTINED', 'MANUAL_REVIEW_REQUIRED']),
  MANUAL_REVIEW_REQUIRED: Object.freeze<PracticalAccountStateName[]>(['MANUAL_REVIEW_REQUIRED', 'QUARANTINED']),
});

function illegal(from: PracticalAccountStateName, event: PracticalTransitionEvent): never {
  throw new PracticalLiveSafetyError('PRACTICAL_ILLEGAL_TRANSITION', `Event ${event.kind} is not permitted from ${from}`, { from, event: event.kind });
}

/**
 * The state every runtime starts in, given the durable state a previous
 * process left (null = no prior row). Accepts untrusted runtime data. A
 * restart NEVER resumes a certified or mutating state, NEVER clears a manual
 * review, and NEVER reads an unknown, malformed, or future durable value as
 * certifiable. Such a value starts in MANUAL_REVIEW_REQUIRED (`undefined` and
 * `''` included, since neither is an explicit "no row").
 */
export function practicalAccountStateOnStartup(durable: unknown): PracticalAccountStateName {
  // Only a genuinely absent row (null) means "never seen": start QUARANTINED.
  if (durable === null) return 'QUARANTINED';
  return practicalStateAfterTransitionFailure(durable);
}

/**
 * The explicit fail-closed state to adopt when a transition fails (throws) or
 * cannot be applied. Pure; grants NO authority.
 *   - MANUAL_REVIEW_REQUIRED       -> MANUAL_REVIEW_REQUIRED (sticky: a failure never clears a review)
 *   - any other known state        -> QUARANTINED
 *   - unknown / malformed / future -> MANUAL_REVIEW_REQUIRED (never silently certifiable)
 */
export function practicalStateAfterTransitionFailure(current: unknown): Extract<PracticalAccountStateName, 'QUARANTINED' | 'MANUAL_REVIEW_REQUIRED'> {
  if (!isPracticalAccountStateName(current)) return 'MANUAL_REVIEW_REQUIRED';
  return current === 'MANUAL_REVIEW_REQUIRED' ? 'MANUAL_REVIEW_REQUIRED' : 'QUARANTINED';
}

/**
 * MUTATION_OUTCOME_RECORDED. Legal only for an account whose mutation is in
 * flight, or was until an invalidation moved the state. Monotone: it never
 * downgrades the state and never restores CERTIFIED_IDLE.
 */
function outcomeTarget(
  from: PracticalAccountStateName,
  event: Extract<PracticalTransitionEvent, { kind: 'MUTATION_OUTCOME_RECORDED' }>,
): PracticalAccountStateName {
  if (from !== 'MUTATING' && from !== 'QUARANTINED' && from !== 'MANUAL_REVIEW_REQUIRED') return illegal(from, event);
  // A malformed outcome is itself a reason for review, never a pass.
  if (!(PRACTICAL_MUTATION_OUTCOMES as readonly string[]).includes(event.outcome)) return 'MANUAL_REVIEW_REQUIRED';
  return from === 'MANUAL_REVIEW_REQUIRED' ? 'MANUAL_REVIEW_REQUIRED' : 'QUARANTINED';
}

/**
 * OPERATOR_RESOLUTION. Requires a GENUINE, unused resolution whose accountId
 * AND reviewEpisodeId both exactly equal the current durable values. Any
 * mismatch is refused without consuming the resolution.
 */
function operatorResolutionTarget(
  from: PracticalAccountStateName,
  event: Extract<PracticalTransitionEvent, { kind: 'OPERATOR_RESOLUTION' }>,
): PracticalAccountStateName {
  if (from !== 'MANUAL_REVIEW_REQUIRED') return illegal(from, event);
  const record = PracticalManualReviewResolution.read(event.resolution);
  if (record === null) {
    throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'Manual review may only be left through a genuine resolution');
  }
  if (!isExactId(event.accountId) || record.accountId !== event.accountId) {
    throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'The resolution is for a different account', { field: 'accountId' });
  }
  if (!isExactId(event.reviewEpisodeId) || record.reviewEpisodeId !== event.reviewEpisodeId) {
    throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'The resolution is for a different manual-review episode', { field: 'reviewEpisodeId' });
  }
  PracticalManualReviewResolution.consume(event.resolution);
  return 'QUARANTINED';
}

function target(from: PracticalAccountStateName, event: PracticalTransitionEvent): PracticalAccountStateName {
  switch (event.kind) {
    case 'CERTIFICATION_STARTED':
      return from === 'QUARANTINED' ? 'CERTIFYING' : illegal(from, event);
    case 'CERTIFICATION_SUCCEEDED':
      return from === 'CERTIFYING' ? 'CERTIFIED_IDLE' : illegal(from, event);
    case 'PROVIDER_UNAVAILABLE':
      return from === 'CERTIFYING' ? 'PROVIDER_UNAVAILABLE' : illegal(from, event);
    case 'PROVIDER_RECOVERED':
      return from === 'PROVIDER_UNAVAILABLE' ? 'QUARANTINED' : illegal(from, event);
    case 'MUTATION_LEASED':
      return from === 'CERTIFIED_IDLE' ? 'MUTATING' : illegal(from, event);
    case 'MUTATION_OUTCOME_RECORDED':
      return outcomeTarget(from, event);
    case 'INVALIDATED': {
      // Immediate, from every state including MUTATING. MANUAL_REVIEW is sticky.
      if (from === 'MANUAL_REVIEW_REQUIRED') return 'MANUAL_REVIEW_REQUIRED';
      return practicalStateForSeverity(classifyPracticalInvalidation(event.reason));
    }
    case 'OPERATOR_RESOLUTION':
      return operatorResolutionTarget(from, event);
    default:
      return illegal(from, event);
  }
}

/** The pure transition function. Throws for anything outside the allowed table. */
export function transitionPracticalAccountState(from: PracticalAccountStateName, event: PracticalTransitionEvent): PracticalAccountStateName {
  if (!isPracticalAccountStateName(from)) {
    throw new PracticalLiveSafetyError('PRACTICAL_ILLEGAL_TRANSITION', 'Unknown practical account state', { from: String(from) });
  }
  const to = target(from, event);
  if (!PRACTICAL_ALLOWED_TRANSITIONS[from].includes(to)) illegal(from, event);
  return to;
}
