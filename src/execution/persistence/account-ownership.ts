import { PaperPersistenceError } from './errors';

const OWNERSHIP_ISSUER = Symbol('P14-D paper account ownership');

/**
 * The fencing-token capability (V2 §16/§18). `PaperAccount` has no persisted
 * "current owner id" column (P14-C schema is frozen and unchanged) — safety
 * comes entirely from the monotonic `fence` value: acquisition always
 * increments it, and every ownership-sensitive write re-verifies (inside the
 * same DB transaction, under `SELECT ... FOR UPDATE`) that the caller's held
 * `fence` still equals the row's current `owner_fence` before mutating. A
 * stale holder's fence can never again match after a newer acquisition has
 * occurred — this is the classic "fencing token" pattern, not a time-based
 * lease (P14-C has no lease-expiry column, so none is implemented here; see
 * `PaperAccountRepository` doc comment).
 */
export interface PaperAccountOwnershipRecord {
  readonly accountId: string;
  readonly fence: bigint;
}

/**
 * Runtime capability, never a public data value. Non-forgeable via the same
 * private-field + symbol-gated-issuer pattern already established by
 * `PaperOpenExecutionAuthority`/`PaperCloseExecutionAuthority`
 * (`src/execution/open-authority.ts`/`close-authority.ts`) — a caller-shaped
 * lookalike object is not an instance of this class and `.read()` returns
 * `null` for it. Only `PaperAccountRepository.acquireOwnership` may construct
 * one.
 */
export class PaperAccountOwnership {
  readonly #record: PaperAccountOwnershipRecord;
  public constructor(issuer: symbol, record: PaperAccountOwnershipRecord) {
    if (issuer !== OWNERSHIP_ISSUER) throw new PaperPersistenceError('NOT_OWNER', 'Only PaperAccountRepository.acquireOwnership may issue account ownership');
    this.#record = Object.freeze({ ...record });
    Object.freeze(this);
  }
  public static read(value: unknown): PaperAccountOwnershipRecord | null {
    return value !== null && typeof value === 'object' && #record in value ? value.#record : null;
  }
}
Object.freeze(PaperAccountOwnership.prototype);
Object.freeze(PaperAccountOwnership);

/** Internal-only issuer accessor — not exported from the module barrel. */
export function issueAccountOwnership(record: PaperAccountOwnershipRecord): PaperAccountOwnership {
  return new PaperAccountOwnership(OWNERSHIP_ISSUER, record);
}
