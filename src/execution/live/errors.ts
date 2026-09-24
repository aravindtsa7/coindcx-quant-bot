/**
 * Phase17 live-execution fault taxonomy.
 *
 * Deliberately separate from `PaperEngineFailureCode` (`src/execution/errors.ts`):
 * a paper fault and a live fault are never interchangeable, and no `catch`
 * clause anywhere can accidentally treat one as the other. Every code below is
 * emitted by exactly one deterministic decision point, so an operator reading a
 * log line can name the exact refusal without reading application state.
 *
 * SECURITY (P17-I15): `details` is the ONLY structured payload ever attached to
 * a live-execution error. Two guarantees apply, both at construction time:
 *   1. `assertCredentialFree` REFUSES any details object (at any depth) whose
 *      key is one the shared logger classifies as sensitive — an API key,
 *      secret, signature, authorization header, token or password. A developer
 *      who tries to attach one gets a hard failure, not a redacted log line.
 *   2. What survives that check is additionally passed through the shared
 *      `redactSensitiveData` redactor, so the stored details can never differ
 *      from what the logger would have been willing to emit.
 * Errors are therefore safe to log, serialize, and snapshot.
 *
 * Deliberately NOT applied: a heuristic on VALUE shape. Identity digests,
 * intent ids and strategy hashes are long opaque strings too, so a shape rule
 * would reject legitimate diagnostics while adding no real protection — the
 * call sites never place credential material in details, and the key rule plus
 * the shared redactor are the repository's established mechanism.
 */
import { isSensitiveKey, redactSensitiveData } from '../../monitoring/logger';

export type LiveExecutionFailureCode =
  /** Live mutation is not enabled by application configuration (default). */
  | 'LIVE_EXECUTION_DISABLED'
  /** Authority is absent, forged, paper-issued, or bound to a different intent/account/pair. */
  | 'LIVE_AUTHORITY_INVALID'
  /** Phase18 has not supplied authoritative durable position ownership for CLOSE. */
  | 'LIVE_POSITION_NOT_AVAILABLE'
  /** The intent itself is malformed: bad decimal syntax, missing field, unsupported semantics. */
  | 'LIVE_INTENT_INVALID'
  /** A durable record already binds this identity to different economic content. */
  | 'LIVE_INTENT_CONFLICT'
  /** Another dispatch path already claimed this intent; this path must not mutate. */
  | 'LIVE_DISPATCH_ALREADY_CLAIMED'
  /** The exchange explicitly refused the order. Terminal, never retried here. */
  | 'LIVE_ORDER_REJECTED'
  /** The exchange response failed schema validation at the adapter boundary. */
  | 'LIVE_ORDER_RESPONSE_INVALID'
  /** A validated response describes a different order than the one dispatched. */
  | 'LIVE_ORDER_IDENTITY_MISMATCH'
  /** A state transition that the frozen state machine forbids. */
  | 'LIVE_ORDER_STATE_CONFLICT'
  /** Fill arithmetic violated an invariant (negative, over-fill, regression). */
  | 'LIVE_FILL_INVALID'
  /** A create-order mutation may or may not have reached CoinDCX. Fails closed. */
  | 'LIVE_SUBMISSION_AMBIGUOUS'
  /** A cancel mutation may or may not have reached CoinDCX. Fails closed. */
  | 'LIVE_CANCEL_AMBIGUOUS'
  /** The instrument's authoritative constraints reject this quantity/price. */
  | 'LIVE_INSTRUMENT_CONSTRAINT'
  /** Post-only / time-in-force semantics the verified CoinDCX contract cannot guarantee. */
  | 'LIVE_UNSUPPORTED_EXECUTION_SEMANTICS'
  /** Transport/provider failure that is provably pre-dispatch (nothing was sent). */
  | 'LIVE_PROVIDER_ERROR'
  /** Exact-decimal handling failed (non-finite, unrepresentable, malformed). */
  | 'LIVE_NUMERIC_FAILURE'
  /** A value exceeded the persisted DECIMAL(36,18) envelope. */
  | 'LIVE_OVERFLOW'
  /** Durable persistence refused or could not prove the outcome of a write. */
  | 'LIVE_PERSISTENCE_FAULT'
  /**
   * [F17-R03] A durable row contradicts its own sealed integrity digest, or a
   * projection row contradicts the immutable intent it was derived from. This
   * is never an application-state outcome: it means the database no longer
   * holds the content Phase17 wrote, so no authoritative read may be trusted
   * and no mutation may proceed from it.
   */
  | 'LIVE_DURABLE_INTEGRITY_VIOLATION'
  /**
   * [Phase18 §3/§18] The account has no CURRENT successful startup
   * reconciliation, so no live mutation may be authorized for it. This is the
   * default for every account in every new runtime — it is what a restart
   * means — and it is never satisfied by a healthy result from a previous
   * process generation.
   */
  | 'LIVE_RECONCILIATION_REQUIRED'
  /**
   * [Phase18 §4] A reconciliation worker tried to commit against a generation
   * that a newer owner has already fenced out. The stale worker's result is
   * discarded; it never overwrites the newer owner's.
   */
  | 'LIVE_RECONCILIATION_STALE_GENERATION'
  /**
   * [Phase18 §5/§13/§14] Provider evidence could not be established as
   * authoritative: incomplete pagination, contradictory duplicate records,
   * impossible causal ordering, or an identity outside the requested scope.
   * Absence in such a read is never proof of non-existence.
   */
  | 'LIVE_RECONCILIATION_EVIDENCE_INVALID'
  /**
   * [Phase18 §6/§10/§12] Reconciliation established a fact that no automatic
   * resolution can safely act on. The finding is durable and the account stays
   * mutation-blocked until a human resolves it.
   */
  | 'LIVE_RECONCILIATION_MANUAL_REVIEW_REQUIRED'
  /**
   * [Phase18 §9] An orphan-order cancellation was attempted and its outcome
   * could not be established. It is never resent on the strength of a restart.
   */
  | 'LIVE_ORPHAN_CANCEL_AMBIGUOUS'
  /**
   * [Phase18 Wave C1 / F18-06] An orphan-ambiguity resolution request is
   * absent, forged, or not a genuine instance minted by this codebase's own
   * factory. Never satisfied by a plain object, however orphan-resolution-
   * shaped it looks.
   */
  | 'LIVE_ORPHAN_RESOLUTION_INVALID'
  /**
   * [Phase18 Wave C1 / F18-06] An orphan-ambiguity resolution targeted a
   * durable orphan revision that has since moved — either a concurrent
   * resolution won first, or an unrelated durable write (a fresh
   * observation, a crash-recovery transition) changed the row. The stale
   * request is refused; nothing is mutated.
   */
  | 'LIVE_ORPHAN_RESOLUTION_STALE_REVISION'
  /**
   * [Phase18 Wave C1 / F18-06] An orphan-ambiguity resolution was attempted
   * against an orphan whose durable cancellation is not currently
   * `CANCEL_AMBIGUOUS` — already resolved, never claimed, or resolved by a
   * concurrent request that committed first.
   */
  | 'LIVE_ORPHAN_RESOLUTION_NOT_AMBIGUOUS'
  /**
   * [Phase18 Wave C1 / F18-06] This exact ambiguous cancellation attempt
   * (account, exchange order id, cancel generation) already carries a
   * durable resolution. A resolution is minted exactly once per attempt;
   * this is the deterministic outcome for a duplicate/replayed request.
   */
  | 'LIVE_ORPHAN_RESOLUTION_ALREADY_RESOLVED';

/** Codes whose meaning is "the exchange may hold an order we cannot account for". */
export const LIVE_AMBIGUOUS_CODES: readonly LiveExecutionFailureCode[] = Object.freeze([
  'LIVE_SUBMISSION_AMBIGUOUS',
  'LIVE_CANCEL_AMBIGUOUS',
  'LIVE_ORPHAN_CANCEL_AMBIGUOUS',
]);

function assertCredentialFreeValue(key: string, value: unknown, path: string): void {
  if (isSensitiveKey(key)) {
    throw new Error(`LiveExecutionError details may not carry credential-bearing key '${path}'`);
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      assertCredentialFreeValue(childKey, childValue, `${path}.${childKey}`);
    }
  }
}

/** Throws if any key or value in `details` could carry credential material (P17-I15). */
export function assertCredentialFree(details: Readonly<Record<string, unknown>> | undefined): void {
  if (details === undefined) return;
  for (const [key, value] of Object.entries(details)) assertCredentialFreeValue(key, value, key);
}

export class LiveExecutionError extends Error {
  public readonly code: LiveExecutionFailureCode;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(
    code: LiveExecutionFailureCode,
    message: string,
    options?: { readonly details?: Readonly<Record<string, unknown>>; readonly cause?: unknown },
  ) {
    super(`[${code}] ${message}`, options?.cause === undefined ? undefined : { cause: options.cause });
    assertCredentialFree(options?.details);
    this.name = 'LiveExecutionError';
    this.code = code;
    this.details = options?.details === undefined ? undefined : Object.freeze(redactSensitiveData({ ...options.details }));
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** True when this fault means the exchange may hold an order this process cannot account for. */
  public get isAmbiguous(): boolean {
    return LIVE_AMBIGUOUS_CODES.includes(this.code);
  }

  public toJSON(): { readonly code: LiveExecutionFailureCode; readonly message: string; readonly details?: Readonly<Record<string, unknown>> } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function liveIntentInvalid(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new LiveExecutionError('LIVE_INTENT_INVALID', message, details === undefined ? undefined : { details });
}

export function liveNumericFailure(message: string): never {
  throw new LiveExecutionError('LIVE_NUMERIC_FAILURE', message);
}
