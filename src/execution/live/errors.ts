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
  | 'LIVE_DURABLE_INTEGRITY_VIOLATION';

/** Codes whose meaning is "the exchange may hold an order we cannot account for". */
export const LIVE_AMBIGUOUS_CODES: readonly LiveExecutionFailureCode[] = Object.freeze([
  'LIVE_SUBMISSION_AMBIGUOUS',
  'LIVE_CANCEL_AMBIGUOUS',
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
