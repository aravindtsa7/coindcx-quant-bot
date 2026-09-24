/**
 * Orphan-order cleanup policy (§9).
 *
 * Automatic cancellation of a venue order this system cannot account for is the
 * single most dangerous thing Phase18 can do, so it is gated by a policy object
 * that DEFAULTS TO DISABLED and that no call site can flip by passing a flag:
 * the only input is a configuration record, exactly as Phase17's
 * `resolveLiveExecutionGate` works.
 *
 * Every one of the brief's nine conditions is enforced somewhere explicit:
 *   1. approved transport — the port's only implementation wraps the Phase17
 *      `CoinDcxFuturesOrderGateway` (`ports.ts`, and the composition root);
 *   2. exact venue identity — `cancelVenueOrder` takes an exchange order id and
 *      nothing else;
 *   3. current reconciliation ownership — the service passes its lease, and the
 *      repository revalidates the generation inside the claim transaction;
 *   4. explicit configuration — `resolveOrphanCleanupPolicy` below;
 *   5. default disabled — an absent or malformed flag yields DISABLED;
 *   6. account allowlist — `permitsAccount`;
 *   7. durable claim before the mutation — `claimOrphanCancellation`;
 *   8. ambiguous outcome becomes reconciliation-required — the service records
 *      `CANCEL_AMBIGUOUS` plus a blocking finding and never retries it;
 *   9. no real mutation in tests — the port is injected, and the Phase18 suites
 *      use a fake that records calls instead of making them.
 */
import { LiveExecutionError } from '../errors';

export type OrphanCleanupDisabledReason =
  | 'NOT_EXPLICITLY_ENABLED'
  | 'MALFORMED_ENABLE_FLAG'
  | 'EMPTY_ACCOUNT_ALLOWLIST'
  | 'MALFORMED_MAX_PER_RUN';

export interface OrphanCleanupPolicyRecord {
  readonly accountAllowlist: readonly string[];
  /**
   * Hard ceiling on cancellations one run may attempt. Bounds blast radius.
   * Always a safe integer in `[1, MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING]`:
   * the policy constructor refuses anything else.
   */
  readonly maxCancellationsPerRun: number;
}

/** Conservative default: at most a handful of cancellations in any single run. */
export const DEFAULT_MAX_ORPHAN_CANCELLATIONS_PER_RUN = 5;

/**
 * [Wave C2 / F18-10] Implementation-owned hard ceiling. Configuration may
 * choose any value from 1 up to this and nothing above it, ever. It is not a
 * default: it is the most orphan cancellations ANY configuration may authorize
 * in one run, so a misconfiguration (or a digit string long enough to overflow
 * to `Infinity`) can never turn the per-run bound into "cancel everything".
 *
 * 20 is 4x the default, and caps a single run's worst-case sequential
 * cancel wire time at 20 x the 15 s default request timeout (5 minutes).
 * Orphans beyond the ceiling are not lost: each stays durably recorded and
 * blocking, and the next run attempts the next batch.
 */
export const MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING = 20;

/** [Wave C2 / F18-10] The one numeric invariant every per-run ceiling satisfies. */
export function isValidMaxOrphanCancellationsPerRun(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING;
}

const ORPHAN_POLICY_ISSUER = Symbol('P18 orphan cleanup policy issuer');

/** Non-forgeable proof that configuration genuinely enabled orphan cancellation. */
export class OrphanCleanupPolicy {
  readonly #record: OrphanCleanupPolicyRecord;

  public constructor(issuer: symbol, record: OrphanCleanupPolicyRecord) {
    if (issuer !== ORPHAN_POLICY_ISSUER) {
      throw new LiveExecutionError(
        'LIVE_EXECUTION_DISABLED',
        'Only the genuine configuration gate may issue an orphan cleanup policy',
      );
    }
    // [Wave C2 / F18-10] Read once, validate, and store exactly the value
    // validated, so no issued policy can ever carry a non-finite, fractional,
    // non-positive, unsafe, or over-ceiling limit.
    const maxCancellationsPerRun: unknown = record.maxCancellationsPerRun;
    if (!isValidMaxOrphanCancellationsPerRun(maxCancellationsPerRun)) {
      throw new LiveExecutionError(
        'LIVE_EXECUTION_DISABLED',
        'maxCancellationsPerRun must be a safe positive integer within the implementation-owned ceiling',
        { details: { ceiling: MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING } },
      );
    }
    this.#record = Object.freeze({
      accountAllowlist: Object.freeze([...record.accountAllowlist]),
      maxCancellationsPerRun,
    });
    Object.freeze(this);
  }

  public static read(value: unknown): OrphanCleanupPolicyRecord | null {
    return value !== null && typeof value === 'object' && #record in value ? value.#record : null;
  }

  public permitsAccount(accountId: string): boolean {
    return this.#record.accountAllowlist.includes(accountId);
  }

  public get maxCancellationsPerRun(): number {
    return this.#record.maxCancellationsPerRun;
  }
}
Object.freeze(OrphanCleanupPolicy.prototype);
Object.freeze(OrphanCleanupPolicy);

export type OrphanCleanupResolution =
  | { readonly status: 'DISABLED'; readonly reason: OrphanCleanupDisabledReason }
  | { readonly status: 'ENABLED'; readonly policy: OrphanCleanupPolicy };

/** Exactly the configuration keys this gate reads. Nothing else influences it. */
export interface OrphanCleanupConfigInput {
  readonly LIVE_ORPHAN_CANCELLATION_ENABLED?: string | undefined;
  readonly LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST?: string | undefined;
  readonly LIVE_ORPHAN_CANCELLATION_MAX_PER_RUN?: string | undefined;
}

/**
 * [Wave C2 / F18-10] The sole parser for `LIVE_ORPHAN_CANCELLATION_MAX_PER_RUN`.
 * Absent (`undefined` or the empty string, exactly as the enable flag treats
 * them) takes the conservative default. Otherwise only canonical decimal
 * digits are accepted: no sign, no leading zero, no whitespace, no exponent,
 * no fraction. The length check runs BEFORE any numeric conversion, so a digit
 * string long enough to overflow (`Number('9'.repeat(400))` is `Infinity`)
 * never reaches `Number` at all. Returns null for every rejected input.
 */
function parseMaxCancellationsPerRun(raw: unknown): number | null {
  if (raw === undefined || raw === '') return DEFAULT_MAX_ORPHAN_CANCELLATIONS_PER_RUN;
  if (typeof raw !== 'string') return null;
  if (raw.length > String(MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING).length || !/^[1-9]\d*$/.test(raw)) return null;
  const value = Number(raw);
  return isValidMaxOrphanCancellationsPerRun(value) ? value : null;
}

function parseList(raw: string | undefined): readonly string[] {
  if (typeof raw !== 'string') return Object.freeze([]);
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return Object.freeze([...new Set(entries)].sort());
}

/**
 * The sole orphan-cleanup decision. Pure: no process state, no clock, no
 * filesystem. Only the exact lowercase literal `true` enables; every near-miss
 * (`TRUE`, `1`, `yes`, ` true `) is malformed, never a silent enable — the same
 * rule Phase17's live gate applies.
 */
export function resolveOrphanCleanupPolicy(config: OrphanCleanupConfigInput): OrphanCleanupResolution {
  const rawFlag = config.LIVE_ORPHAN_CANCELLATION_ENABLED;
  if (rawFlag === undefined || rawFlag === '' || rawFlag === 'false') {
    return Object.freeze({ status: 'DISABLED' as const, reason: 'NOT_EXPLICITLY_ENABLED' as const });
  }
  if (rawFlag !== 'true') {
    return Object.freeze({ status: 'DISABLED' as const, reason: 'MALFORMED_ENABLE_FLAG' as const });
  }

  const accountAllowlist = parseList(config.LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST);
  if (accountAllowlist.length === 0) {
    return Object.freeze({ status: 'DISABLED' as const, reason: 'EMPTY_ACCOUNT_ALLOWLIST' as const });
  }

  // A malformed or out-of-range ceiling does not silently fall back to the
  // default or clamp to the hard ceiling: an operator who tried to set a bound
  // gets the safe answer (cleanup off), not a guess. [Wave C2 / F18-10] Before
  // this, any all-digit string passed, including ones that overflow to
  // `Infinity`, which made the per-run bound in the service unreachable.
  const maxCancellationsPerRun = parseMaxCancellationsPerRun(config.LIVE_ORPHAN_CANCELLATION_MAX_PER_RUN);
  if (maxCancellationsPerRun === null) {
    return Object.freeze({ status: 'DISABLED' as const, reason: 'MALFORMED_MAX_PER_RUN' as const });
  }

  return Object.freeze({
    status: 'ENABLED' as const,
    policy: new OrphanCleanupPolicy(ORPHAN_POLICY_ISSUER, { accountAllowlist, maxCancellationsPerRun }),
  });
}
