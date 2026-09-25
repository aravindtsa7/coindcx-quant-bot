/**
 * Phase 18B practical live-safety policy (Stage 1A).
 *
 * Two kinds of numbers live here, and the types keep them apart:
 *
 *   1. SAFETY CEILINGS — implementation-owned local operational policy, frozen
 *      in code. Configuration may only TIGHTEN them (a shorter certificate
 *      lifetime, more passes, longer spans, spacing and dwells). Any value that
 *      would loosen one, or is malformed, disables Tier B entirely; it is never
 *      clamped or defaulted.
 *   2. TIMING CANDIDATES — per-read duration, per-pass window, and inter-read
 *      gap. These are SHADOW-CALIBRATION CANDIDATES, not provider guarantees
 *      and not frozen values: Stage 2 shadow mode measures real CoinDCX
 *      latency and skew before they are fixed. They are not configurable in
 *      Stage 1A.
 *
 * None of these values is a CoinDCX guarantee.
 *
 * Parsing configuration and issuing authority are SEPARATE:
 *   - `evaluatePracticalLiveSafetyConfig` parses an explicit configuration
 *     record passed in by the caller (this module never reads process state)
 *     into plain frozen DATA. Its result is not authority: nothing accepts it
 *     in place of an enablement.
 *   - `issuePracticalLiveSafetyEnablement` is the only path that constructs a
 *     genuine, non-forgeable `PracticalLiveSafetyEnablement`. It is NOT
 *     exported from the practical barrel, and in Stage 1A nothing in `src/`
 *     references it: an architecture test pins its production importer set to
 *     exactly empty, so the future trusted composition root can only be added
 *     as an explicit, reviewed entry.
 *
 * Stage 1A permits only the Stage-5a action set: CANCEL. OPEN is disabled until Stage 5b, and CLOSE until a venue-enforced
 * reduce-only capability has been confirmed by CoinDCX AND verified — no
 * configuration key can enable either.
 */
import {
  PracticalLiveSafetyError,
  isPositiveSafeInteger,
  isPracticalMutationAction,
  type PracticalMutationAction,
} from './types';

// ---------------------------------------------------------------------------
// Safety ceilings (local operational policy; configuration may only tighten)
// ---------------------------------------------------------------------------

export interface PracticalSafetyCeilings {
  /** MAXIMUM absolute certificate lifetime from issuance. Non-renewable. */
  readonly certificateLifetimeMs: number;
  /** MINIMUM consecutive agreeing passes for one certification. */
  readonly minimumPasses: number;
  /** MINIMUM time from the first to the last certifying pass. */
  readonly minimumCertificationSpanMs: number;
  /** MINIMUM spacing between consecutive certifying passes. */
  readonly minimumPassSpacingMs: number;
  /** MINIMUM quiet dwell after issuance before the FIRST mutation of a quarantine episode. */
  readonly firstMutationDwellMs: number;
  /** MINIMUM quiet dwell after issuance before any other mutation. */
  readonly postIssuanceDwellMs: number;
}

/** Which direction "tighter" is for each ceiling. */
const CEILING_DIRECTION: Readonly<Record<keyof PracticalSafetyCeilings, 'AT_MOST' | 'AT_LEAST'>> = Object.freeze({
  certificateLifetimeMs: 'AT_MOST',
  minimumPasses: 'AT_LEAST',
  minimumCertificationSpanMs: 'AT_LEAST',
  minimumPassSpacingMs: 'AT_LEAST',
  firstMutationDwellMs: 'AT_LEAST',
  postIssuanceDwellMs: 'AT_LEAST',
});

/** The Stage-5 implementation-owned ceilings. Frozen; never loosened by configuration. */
export const PRACTICAL_SAFETY_CEILINGS: PracticalSafetyCeilings = Object.freeze({
  certificateLifetimeMs: 120_000,
  minimumPasses: 3,
  minimumCertificationSpanMs: 30_000,
  minimumPassSpacingMs: 10_000,
  firstMutationDwellMs: 60_000,
  postIssuanceDwellMs: 15_000,
});

/**
 * Sanity upper bounds for any configured value. For a MINIMUM they cap how
 * far configuration may tighten it, so an overflowing value cannot silently
 * turn "tighter" into "never certifies"; for the lifetime MAXIMUM it is only
 * an overflow guard (anything above the ceiling is already a loosening).
 * Exceeding one is malformed (Tier B disabled).
 */
const TIGHTENING_LIMITS: Readonly<Record<keyof PracticalSafetyCeilings, number>> = Object.freeze({
  certificateLifetimeMs: 86_400_000,
  minimumPasses: 20,
  minimumCertificationSpanMs: 600_000,
  minimumPassSpacingMs: 120_000,
  firstMutationDwellMs: 3_600_000,
  postIssuanceDwellMs: 3_600_000,
});

/** True only when every field is a positive safe integer within its tightening limit. */
function isWellFormedCeilings(candidate: PracticalSafetyCeilings): boolean {
  return (Object.keys(CEILING_DIRECTION) as (keyof PracticalSafetyCeilings)[]).every((key) => {
    const value: unknown = candidate[key];
    return isPositiveSafeInteger(value) && value <= TIGHTENING_LIMITS[key];
  });
}

/** True only when `candidate` is well formed AND at least as strict as the implementation ceilings on every field. */
export function isAtLeastAsStrictAsCeilings(candidate: PracticalSafetyCeilings): boolean {
  if (!isWellFormedCeilings(candidate)) return false;
  return (Object.keys(CEILING_DIRECTION) as (keyof PracticalSafetyCeilings)[]).every((key) =>
    CEILING_DIRECTION[key] === 'AT_MOST'
      ? candidate[key] <= PRACTICAL_SAFETY_CEILINGS[key]
      : candidate[key] >= PRACTICAL_SAFETY_CEILINGS[key]);
}

// ---------------------------------------------------------------------------
// Timing candidates (NOT frozen; NOT provider guarantees; NOT configurable yet)
// ---------------------------------------------------------------------------

/** A timing threshold that is still awaiting Stage-2 shadow calibration. */
export interface PracticalTimingCandidate {
  readonly valueMs: number;
  readonly status: 'SHADOW_CALIBRATION_CANDIDATE';
  readonly providerGuarantee: false;
}

export interface PracticalTimingCandidates {
  readonly readDuration: PracticalTimingCandidate;
  readonly passWindow: PracticalTimingCandidate;
  readonly interReadGap: PracticalTimingCandidate;
}

function candidate(valueMs: number): PracticalTimingCandidate {
  return Object.freeze({ valueMs, status: 'SHADOW_CALIBRATION_CANDIDATE' as const, providerGuarantee: false as const });
}

/**
 * Initial candidates from the reviewed design. Local assumptions only, to be
 * replaced by values derived from Stage-2 measurements before any enforcement.
 */
export const PRACTICAL_TIMING_CANDIDATES: PracticalTimingCandidates = Object.freeze({
  readDuration: candidate(3_000),
  passWindow: candidate(15_000),
  interReadGap: candidate(2_000),
});

// ---------------------------------------------------------------------------
// Rollout stage and action permission
// ---------------------------------------------------------------------------

/**
 * Stage 1A knows exactly one mutation-capable stage: 5a, cancel-only. There is
 * no configuration value that selects anything else.
 */
export type PracticalRolloutStage = 'STAGE_5A_CANCEL_ONLY';

/** Every rollout stage Stage 1A recognizes. Anything else is refused for every action. */
export const PRACTICAL_ROLLOUT_STAGES = Object.freeze(['STAGE_5A_CANCEL_ONLY'] as const);

export function isPracticalRolloutStage(value: unknown): value is PracticalRolloutStage {
  return typeof value === 'string' && (PRACTICAL_ROLLOUT_STAGES as readonly string[]).includes(value);
}

export type PracticalActionRefusal =
  | 'UNKNOWN_ROLLOUT_STAGE'
  | 'UNKNOWN_MUTATION_ACTION'
  | 'OPEN_DISABLED_UNTIL_STAGE_5B'
  | 'CLOSE_REQUIRES_VERIFIED_REDUCE_ONLY';

export type PracticalActionPermission =
  | { readonly permitted: true }
  | { readonly permitted: false; readonly reason: PracticalActionRefusal };

/**
 * Whether a venue-enforced reduce-only capability has been confirmed by the
 * provider AND verified. Stage 1A has no path that sets it: it is a type-level
 * `false`, not a configuration value.
 */
export const VERIFIED_REDUCE_ONLY_CAPABILITY = false as const;

function refuse(reason: PracticalActionRefusal): PracticalActionPermission {
  return Object.freeze({ permitted: false as const, reason });
}

/**
 * The action permission for a rollout stage. The stage is validated at
 * runtime FIRST: an unknown, malformed, or future stage is refused for EVERY
 * action and is never mapped to Stage 5a. Then an unknown action is refused.
 */
export function practicalActionPermission(stage: PracticalRolloutStage, action: PracticalMutationAction): PracticalActionPermission {
  if (!isPracticalRolloutStage(stage)) return refuse('UNKNOWN_ROLLOUT_STAGE');
  if (!isPracticalMutationAction(action)) return refuse('UNKNOWN_MUTATION_ACTION');
  switch (action) {
    case 'CANCEL':
      return Object.freeze({ permitted: true as const });
    case 'OPEN':
      // An automatic OPEN with no automatic exit is not acceptable exposure;
      // OPEN is enabled only together with CLOSE (Stage 5b).
      return refuse('OPEN_DISABLED_UNTIL_STAGE_5B');
    case 'CLOSE':
      return refuse('CLOSE_REQUIRES_VERIFIED_REDUCE_ONLY');
    default:
      return refuse('UNKNOWN_MUTATION_ACTION');
  }
}

// ---------------------------------------------------------------------------
// Non-forgeable enablement
// ---------------------------------------------------------------------------

export interface PracticalLiveSafetyEnablementRecord {
  readonly accountAllowlist: readonly string[];
  readonly ceilings: PracticalSafetyCeilings;
  readonly stage: PracticalRolloutStage;
}

const ENABLEMENT_ISSUER = Symbol('P18B practical live safety enablement issuer');

/** Non-forgeable proof that configuration genuinely enabled Tier B for an allowlist. */
export class PracticalLiveSafetyEnablement {
  readonly #record: PracticalLiveSafetyEnablementRecord;

  public constructor(issuer: symbol, record: PracticalLiveSafetyEnablementRecord) {
    if (issuer !== ENABLEMENT_ISSUER) {
      throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'Only the internal Tier-B issuance boundary may issue enablement');
    }
    const ceilings = Object.freeze({ ...record.ceilings });
    if (!isAtLeastAsStrictAsCeilings(ceilings)) {
      throw new PracticalLiveSafetyError('PRACTICAL_POLICY_INVALID', 'Tier-B ceilings may only tighten the implementation-owned safety ceilings');
    }
    this.#record = Object.freeze({
      accountAllowlist: Object.freeze([...record.accountAllowlist]),
      ceilings,
      stage: 'STAGE_5A_CANCEL_ONLY' as const,
    });
    Object.freeze(this);
  }

  /** The record of a GENUINE enablement, or null for a clone, structural fake, or prototype-only object. */
  public static read(value: unknown): PracticalLiveSafetyEnablementRecord | null {
    if (!(value instanceof PracticalLiveSafetyEnablement)) return null;
    try {
      return value.#record;
    } catch {
      return null;
    }
  }

  public permitsAccount(accountId: string): boolean {
    return this.#record.accountAllowlist.includes(accountId);
  }

  public get ceilings(): PracticalSafetyCeilings {
    return this.#record.ceilings;
  }

  public get stage(): PracticalRolloutStage {
    return this.#record.stage;
  }

  public actionPermission(action: PracticalMutationAction): PracticalActionPermission {
    return practicalActionPermission(this.#record.stage, action);
  }
}
Object.freeze(PracticalLiveSafetyEnablement.prototype);
Object.freeze(PracticalLiveSafetyEnablement);

export type PracticalLiveSafetyDisabledReason =
  | 'NOT_EXPLICITLY_ENABLED'
  | 'MALFORMED_ENABLE_FLAG'
  | 'EMPTY_ACCOUNT_ALLOWLIST'
  | 'MALFORMED_CEILING'
  | 'CEILING_WOULD_LOOSEN';

/**
 * The parsed configuration. Plain frozen DATA, not authority: presenting an
 * ELIGIBLE evaluation (or any look-alike) where an enablement is required is
 * refused, because only a genuine `PracticalLiveSafetyEnablement` passes
 * `PracticalLiveSafetyEnablement.read`.
 */
export type PracticalLiveSafetyConfigEvaluation =
  | { readonly status: 'DISABLED'; readonly reason: PracticalLiveSafetyDisabledReason }
  | {
      readonly status: 'ELIGIBLE';
      readonly accountAllowlist: readonly string[];
      readonly ceilings: PracticalSafetyCeilings;
      readonly stage: PracticalRolloutStage;
    };

/** The internal issuer's result: disabled, or a genuine enablement. */
export type PracticalLiveSafetyResolution =
  | { readonly status: 'DISABLED'; readonly reason: PracticalLiveSafetyDisabledReason }
  | { readonly status: 'ENABLED'; readonly enablement: PracticalLiveSafetyEnablement };

/**
 * Exactly the configuration keys this gate reads. The ceiling keys are
 * optional and may only tighten. There is NO key for the rollout stage, the
 * reduce-only capability, the timing candidates, or the strict/practical gate.
 */
export interface PracticalLiveSafetyConfigInput {
  readonly LIVE_PRACTICAL_SAFETY_ENABLED?: string | undefined;
  readonly LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST?: string | undefined;
  readonly LIVE_PRACTICAL_CERTIFICATE_LIFETIME_MS?: string | undefined;
  readonly LIVE_PRACTICAL_MIN_PASSES?: string | undefined;
  readonly LIVE_PRACTICAL_MIN_CERTIFICATION_SPAN_MS?: string | undefined;
  readonly LIVE_PRACTICAL_MIN_PASS_SPACING_MS?: string | undefined;
  readonly LIVE_PRACTICAL_FIRST_MUTATION_DWELL_MS?: string | undefined;
  readonly LIVE_PRACTICAL_POST_ISSUANCE_DWELL_MS?: string | undefined;
}

const CEILING_CONFIG_KEYS: Readonly<Record<keyof PracticalSafetyCeilings, keyof PracticalLiveSafetyConfigInput>> = Object.freeze({
  certificateLifetimeMs: 'LIVE_PRACTICAL_CERTIFICATE_LIFETIME_MS',
  minimumPasses: 'LIVE_PRACTICAL_MIN_PASSES',
  minimumCertificationSpanMs: 'LIVE_PRACTICAL_MIN_CERTIFICATION_SPAN_MS',
  minimumPassSpacingMs: 'LIVE_PRACTICAL_MIN_PASS_SPACING_MS',
  firstMutationDwellMs: 'LIVE_PRACTICAL_FIRST_MUTATION_DWELL_MS',
  postIssuanceDwellMs: 'LIVE_PRACTICAL_POST_ISSUANCE_DWELL_MS',
});

/**
 * Canonical positive decimal digits only (no sign, leading zero, whitespace,
 * exponent, or fraction). The length check runs before numeric conversion, so
 * an overflowing digit string never reaches `Number`. `undefined`/'' means
 * "use the implementation ceiling".
 */
function parseCeiling(raw: unknown, fallback: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || raw.length > 10 || !/^[1-9]\d*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function parseList(raw: string | undefined): readonly string[] {
  if (typeof raw !== 'string') return Object.freeze([]);
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return Object.freeze([...new Set(entries)].sort());
}

/**
 * Parses the Tier-B configuration into DATA. Grants nothing. Pure: no process
 * state, no clock, no filesystem — `process.env` can only reach it because a
 * caller passes a record in. Only the exact lowercase literal `true` is
 * eligible; any near-miss is malformed. A malformed or loosening ceiling makes
 * Tier B ineligible outright.
 */
export function evaluatePracticalLiveSafetyConfig(config: PracticalLiveSafetyConfigInput): PracticalLiveSafetyConfigEvaluation {
  const disabled = (reason: PracticalLiveSafetyDisabledReason): PracticalLiveSafetyConfigEvaluation =>
    Object.freeze({ status: 'DISABLED' as const, reason });

  const rawFlag = config.LIVE_PRACTICAL_SAFETY_ENABLED;
  if (rawFlag === undefined || rawFlag === '' || rawFlag === 'false') return disabled('NOT_EXPLICITLY_ENABLED');
  if (rawFlag !== 'true') return disabled('MALFORMED_ENABLE_FLAG');

  const accountAllowlist = parseList(config.LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST);
  if (accountAllowlist.length === 0) return disabled('EMPTY_ACCOUNT_ALLOWLIST');

  const values: Partial<Record<keyof PracticalSafetyCeilings, number>> = {};
  for (const key of Object.keys(CEILING_CONFIG_KEYS) as (keyof PracticalSafetyCeilings)[]) {
    const parsed = parseCeiling(config[CEILING_CONFIG_KEYS[key]], PRACTICAL_SAFETY_CEILINGS[key]);
    if (parsed === null) return disabled('MALFORMED_CEILING');
    values[key] = parsed;
  }
  const ceilings = Object.freeze({ ...values }) as PracticalSafetyCeilings;
  if (!isWellFormedCeilings(ceilings)) return disabled('MALFORMED_CEILING');
  if (!isAtLeastAsStrictAsCeilings(ceilings)) return disabled('CEILING_WOULD_LOOSEN');

  return Object.freeze({ status: 'ELIGIBLE' as const, accountAllowlist, ceilings, stage: 'STAGE_5A_CANCEL_ONLY' as const });
}

/**
 * INTERNAL ISSUANCE BOUNDARY: the only path that mints a genuine Tier-B
 * enablement. It re-parses the configuration itself and never accepts a
 * pre-evaluated record, so every parse check always runs. Not exported from
 * the practical barrel; its production importers are pinned to exactly none
 * in Stage 1A. The future trusted composition root that owns configuration is
 * the one exception still to be reviewed.
 */
export function issuePracticalLiveSafetyEnablement(config: PracticalLiveSafetyConfigInput): PracticalLiveSafetyResolution {
  const evaluation = evaluatePracticalLiveSafetyConfig(config);
  if (evaluation.status === 'DISABLED') return evaluation;
  return Object.freeze({
    status: 'ENABLED' as const,
    enablement: new PracticalLiveSafetyEnablement(ENABLEMENT_ISSUER, {
      accountAllowlist: evaluation.accountAllowlist,
      ceilings: evaluation.ceilings,
      stage: evaluation.stage,
    }),
  });
}

/** Throws unless `value` is a genuine configuration-issued enablement. */
export function requirePracticalLiveSafetyEnablement(value: unknown): PracticalLiveSafetyEnablementRecord {
  const record = PracticalLiveSafetyEnablement.read(value);
  if (record === null) {
    throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'Tier-B operations require a genuine issued enablement (configuration data is not authority)');
  }
  return record;
}
