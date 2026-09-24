/**
 * [P18 Wave C1 / F18-06] Durable orphan cancellation ambiguity resolution.
 *
 * Wave B made a durable orphan `CANCEL_AMBIGUOUS` cancellation sticky and
 * fail-closed (F18-25, `service.ts`'s `#recoverOrphanCancelClaims`): it
 * reasserts a blocking finding every generation, regardless of whether the
 * venue currently returns the order, and nothing automatic ever clears it.
 * That is correct — it must never be inferred from venue absence, a restart,
 * a generation change, or a generic admin boolean — but it left no
 * authoritative in-band way for a human to ever resolve one. This module is
 * that recovery path, and ONLY that recovery path: it does not touch
 * `LiveReconciliationAuthorization`, does not require a reconciliation lease,
 * and does not authorize any live mutation. Live-mutation authorization is
 * governed exclusively by `requireCurrentReconciliation` (`barrier.ts`,
 * §F18-27/F18-28) and is completely unaffected by anything here.
 *
 * THE CAPABILITY, deliberately separate from reconciliation authority
 * (§9/§10 of the task this module answers): `OrphanAmbiguityResolutionRequest`
 * is a distinct, unforgeable, opaque value, minted only by
 * `mintOrphanAmbiguityResolutionRequest` below, following the exact same
 * issuer-object / private-field pattern `LiveRuntimeIdentity` (`barrier.ts`)
 * and `LiveReconciliationAuthorization` (`repository.ts`) already use
 * elsewhere in this codebase. A plain object, a prototype clone, or a
 * `Object.create`-based structural fake all fail `.read()`.
 *
 * THE BINDING: a request is bound, at mint time and forever after, to one
 * exact `(accountId, exchangeOrderId, expectedRevision)` triple. The
 * repository method that consumes it (`resolveOrphanCancelAmbiguity`,
 * `repository.ts`) reads ONLY the identity carried inside the request object
 * — never a separately-supplied `accountId`/`exchangeOrderId` argument — so
 * there is no code path through which a request minted for one orphan could
 * ever be applied against a different one. `expectedRevision` is Phase18's
 * existing optimistic-concurrency token: a request minted against a stale
 * revision is refused deterministically, exactly like every other durable
 * Phase18 write.
 *
 * WHAT `resolvedBy` IS, AND IS NOT (§F18-31): `resolvedBy` is currently a
 * caller-asserted audit label. This module provides the domain/persistence
 * resolution primitive only; it does not authenticate an operator identity,
 * because no operator-facing transport/authentication surface exists in this
 * phase (no HTTP route, no CLI, no dashboard, no production caller). A
 * genuinely-minted `OrphanAmbiguityResolutionRequest` proves only that a
 * structurally genuine resolution request was minted inside this domain API
 * with the supplied audit label — it is NOT proof that an authenticated
 * operator approved the action, and must never be described or treated as
 * such. Any future HTTP/CLI/dashboard/operator transport MUST authenticate
 * and authorize the operator first, then derive `resolvedBy` from that
 * trusted principal rather than accepting an arbitrary caller-supplied
 * identity string.
 *
 * WHAT A RESOLUTION MAY NEVER DO: fabricate an economic fact. The two
 * outcomes below (`ACKNOWLEDGED_NO_RETRY`, `CONFIRMED_CANCELLED`) are the
 * minimum vocabulary this domain actually needs — see the doc comment on
 * `LiveOrphanCancelResolutionOutcome` in `prisma/schema.prisma` for why no
 * broader set (fills, PnL, ownership, position state) is representable here
 * at all. A resolution never writes to `live_order`, `live_position`, or any
 * ownership table; it writes to exactly two places, in one transaction: the
 * durable audit row (`live_orphan_cancel_resolution`) and the orphan's own
 * `cancel_state` (`live_orphan_venue_order`).
 */
import { LiveExecutionError } from '../errors';
import type { LiveOrphanCancelResolutionOutcomeName } from './types';

const MAX_RESOLVED_BY_LENGTH = 128;
const MAX_NOTE_LENGTH = 512;

const ORPHAN_RESOLUTION_REQUEST_ISSUER = Object.freeze({ purpose: 'orphan-ambiguity-resolution-request' });

export interface OrphanAmbiguityResolutionRequestRecord {
  readonly accountId: string;
  readonly exchangeOrderId: string;
  /** The exact durable orphan revision this request was minted against. */
  readonly expectedRevision: number;
  readonly outcome: LiveOrphanCancelResolutionOutcomeName;
  /**
   * Bounded, caller-asserted audit label (e.g. "ops:jane"). NOT an
   * authenticated operator identity — no operator-auth transport exists in
   * this phase, so nothing here verifies who actually supplied this string.
   * Never a credential; never used to derive order/account identity. See the
   * module-level "§F18-31" doc comment above for the full boundary.
   */
  readonly resolvedBy: string;
  /** Bounded, optional free-text reference. Never provider evidence. */
  readonly note: string | null;
}

/**
 * Uncloneable, single-target proof of one operator's resolution decision.
 *
 * The constructor is hostile to direct/prototype/Reflect use: only this
 * module owns the issuer object, exactly like `LiveRuntimeIdentity` and
 * `LiveReconciliationAuthorization`.
 */
export class OrphanAmbiguityResolutionRequest {
  readonly #record: OrphanAmbiguityResolutionRequestRecord;

  public constructor(issuer: unknown, record: OrphanAmbiguityResolutionRequestRecord) {
    if (issuer !== ORPHAN_RESOLUTION_REQUEST_ISSUER) {
      throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_INVALID', 'An orphan ambiguity resolution request may only be minted by mintOrphanAmbiguityResolutionRequest');
    }
    this.#record = Object.freeze({ ...record });
    Object.freeze(this);
  }

  public static read(value: unknown): OrphanAmbiguityResolutionRequestRecord | null {
    if (!(value instanceof OrphanAmbiguityResolutionRequest)) return null;
    try {
      return value.#record;
    } catch {
      return null;
    }
  }
}
Object.freeze(OrphanAmbiguityResolutionRequest.prototype);
Object.freeze(OrphanAmbiguityResolutionRequest);

/** Internal adapter reader, mirroring `readLiveRuntimeEpoch`'s shape. */
export function readOrphanAmbiguityResolutionRequest(value: unknown): OrphanAmbiguityResolutionRequestRecord | null {
  return OrphanAmbiguityResolutionRequest.read(value);
}

/**
 * The ONLY way to mint a genuine resolution request.
 *
 * Validates shape and bounds eagerly, at mint time, so a malformed request
 * fails immediately at the call site that built it rather than deep inside a
 * database transaction. This is the operator-facing boundary (§19 of the
 * task this module answers): every free-form input is length-bounded here,
 * and `note` is never interpreted as anything but opaque bounded text — it is
 * never parsed, never used to derive identity, and never written into any
 * reconciliation finding's evidence.
 */
export function mintOrphanAmbiguityResolutionRequest(input: {
  readonly accountId: string;
  readonly exchangeOrderId: string;
  readonly expectedRevision: number;
  readonly outcome: LiveOrphanCancelResolutionOutcomeName;
  readonly resolvedBy: string;
  readonly note?: string | null;
}): OrphanAmbiguityResolutionRequest {
  if (typeof input.accountId !== 'string' || input.accountId.length === 0) {
    throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_INVALID', 'A resolution request requires a non-empty accountId');
  }
  if (typeof input.exchangeOrderId !== 'string' || input.exchangeOrderId.length === 0) {
    throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_INVALID', 'A resolution request requires a non-empty exchangeOrderId');
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_INVALID', 'A resolution request requires a non-negative safe-integer expectedRevision');
  }
  if (input.outcome !== 'ACKNOWLEDGED_NO_RETRY' && input.outcome !== 'CONFIRMED_CANCELLED') {
    throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_INVALID', 'A resolution request requires a recognized outcome', {
      details: { outcome: typeof input.outcome === 'string' ? input.outcome : typeof input.outcome },
    });
  }
  if (typeof input.resolvedBy !== 'string' || input.resolvedBy.length === 0 || input.resolvedBy.length > MAX_RESOLVED_BY_LENGTH) {
    throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_INVALID', 'A resolution request requires a non-empty, bounded resolvedBy identity', {
      details: { maxLength: MAX_RESOLVED_BY_LENGTH },
    });
  }
  const note = input.note ?? null;
  if (note !== null && (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH)) {
    throw new LiveExecutionError('LIVE_ORPHAN_RESOLUTION_INVALID', 'A resolution note must be a bounded string when supplied', {
      details: { maxLength: MAX_NOTE_LENGTH },
    });
  }

  return new OrphanAmbiguityResolutionRequest(ORPHAN_RESOLUTION_REQUEST_ISSUER, {
    accountId: input.accountId,
    exchangeOrderId: input.exchangeOrderId,
    expectedRevision: input.expectedRevision,
    outcome: input.outcome,
    resolvedBy: input.resolvedBy,
    note,
  });
}

// The production composition imports these bindings from CommonJS output.
// Make that namespace non-replaceable so a caller cannot preload this module,
// retain a genuine request, and monkey-patch the factory to replay/forge one.
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const [name, value] of Object.entries({
    OrphanAmbiguityResolutionRequest,
    readOrphanAmbiguityResolutionRequest,
    mintOrphanAmbiguityResolutionRequest,
  })) {
    if (Object.getOwnPropertyDescriptor(module.exports, name)?.configurable !== false) {
      Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
    }
  }
  Object.freeze(module.exports);
}
