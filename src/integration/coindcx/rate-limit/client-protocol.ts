/**
 * M2 W1: client half of the grant protocol (design V3 §2.2–§2.4). Pure; the caller supplies its own monotonic time.
 *
 * One-use: a grant is either USED (marked synchronously by `checkStart`, before the caller creates the request) or
 * VOIDED (only ever from UNUSED). The two transitions are mutually exclusive, so a NOT_STARTED report is irrevocable
 * and a USED grant can never later be voided. After USE the caller creates the request and reports STARTED, even if
 * request creation throws (conservative).
 *
 * Pinned limit: `checkStart` limits when the CHECK can pass. Process suspension between the check and request
 * creation can delay the actual start without bound; the coordinator therefore keeps the charge uncertain until STARTED.
 */
import type { BudgetScope } from './config';
import type { BudgetOperation, Grant } from './scheduler';

export type HeldGrantState = 'UNUSED' | 'USED' | 'VOIDED';
export interface HeldGrant { readonly grant: Grant; readonly receivedAtMs: number; readonly state: HeldGrantState }
export interface ClientGrantBook { readonly grants: Readonly<Record<string, HeldGrant>> }
export type VoidReason = 'SESSION_CLOSED' | 'EPOCH_CHANGED' | 'LOCAL_DEADLINE_PASSED' | 'REVOKED' | 'LOCAL_STOP' | 'LOCAL_BLOCK' | 'SESSION_MISMATCH';
export type NotStartedReport = Readonly<{ kind: 'NOT_STARTED'; grantId: string; reason: VoidReason }>;
export interface StartContext {
  readonly sessionId: string;
  readonly sessionOpen: boolean;
  readonly epoch: string;
  /** Operator STOP known locally (applies to non-hook mutations). */
  readonly knownStop: boolean;
  /** Scopes known locally to be blocked (applies to everything except a probe of the current generation). */
  readonly knownBlockedScopes: readonly BudgetScope[];
}
export type StartCheck =
  | Readonly<{ kind: 'USE'; book: ClientGrantBook }>
  | Readonly<{ kind: 'VOID'; book: ClientGrantBook; report: NotStartedReport }>
  | Readonly<{ kind: 'REFUSED'; book: ClientGrantBook; reason: 'UNKNOWN_GRANT' | 'ALREADY_USED' | 'ALREADY_VOIDED' }>;

export const emptyGrantBook = (): ClientGrantBook => Object.freeze({ grants: Object.freeze({}) });
const put = (book: ClientGrantBook, held: HeldGrant): ClientGrantBook => Object.freeze({ grants: Object.freeze({ ...book.grants, [held.grant.grantId]: Object.freeze(held) }) });
const isMutation = (operation: BudgetOperation): boolean => operation === 'CREATE' || operation === 'CANCEL';

/** Record receipt (local monotonic time). A grant for another session or epoch is voided at once. */
export function receiveGrant(book: ClientGrantBook, localNowMs: number, grant: Grant, current: { readonly sessionId: string; readonly epoch: string }): Readonly<{ book: ClientGrantBook; report: NotStartedReport | null }> {
  if (book.grants[grant.grantId] !== undefined) return Object.freeze({ book, report: null }); // duplicate delivery: idempotent
  const mismatch = grant.sessionId !== current.sessionId || grant.epoch !== current.epoch;
  const next = put(book, { grant, receivedAtMs: localNowMs, state: mismatch ? 'VOIDED' : 'UNUSED' });
  return Object.freeze({ book: next, report: mismatch ? Object.freeze({ kind: 'NOT_STARTED', grantId: grant.grantId, reason: 'SESSION_MISMATCH' }) : null });
}

/** The synchronous start check at the last dispatch boundary. USE marks the grant used before returning. */
export function checkStart(book: ClientGrantBook, localNowMs: number, grantId: string, context: StartContext): StartCheck {
  const held = book.grants[grantId];
  if (held === undefined) return Object.freeze({ kind: 'REFUSED', book, reason: 'UNKNOWN_GRANT' });
  if (held.state === 'USED') return Object.freeze({ kind: 'REFUSED', book, reason: 'ALREADY_USED' });
  if (held.state === 'VOIDED') return Object.freeze({ kind: 'REFUSED', book, reason: 'ALREADY_VOIDED' });
  const { grant } = held;
  let reason: VoidReason | null = null;
  if (!context.sessionOpen || context.sessionId !== grant.sessionId) reason = 'SESSION_CLOSED';
  else if (context.epoch !== grant.epoch) reason = 'EPOCH_CHANGED';
  else if (localNowMs > held.receivedAtMs + grant.ttlMs) reason = 'LOCAL_DEADLINE_PASSED';
  else if (context.knownStop && isMutation(grant.operation) && !grant.viaHook) reason = 'LOCAL_STOP';
  else if (grant.operation !== 'PROBE' && context.knownBlockedScopes.includes(grant.scope)) reason = 'LOCAL_BLOCK';
  if (reason !== null) return voidGrant(book, held, reason);
  return Object.freeze({ kind: 'USE', book: put(book, { ...held, state: 'USED' }) });
}

function voidGrant(book: ClientGrantBook, held: HeldGrant, reason: VoidReason): StartCheck {
  return Object.freeze({ kind: 'VOID', book: put(book, { ...held, state: 'VOIDED' }), report: Object.freeze({ kind: 'NOT_STARTED', grantId: held.grant.grantId, reason }) });
}

/** A revoke voids an UNUSED grant (NOT_STARTED). A USED grant cannot be revoked; nothing is reported. */
export function revokeGrant(book: ClientGrantBook, grantId: string): Readonly<{ book: ClientGrantBook; report: NotStartedReport | null }> {
  const held = book.grants[grantId];
  if (held === undefined || held.state !== 'UNUSED') return Object.freeze({ book, report: null });
  const result = voidGrant(book, held, 'REVOKED');
  return Object.freeze({ book: result.book, report: result.kind === 'VOID' ? result.report : null });
}

/**
 * On session loss: void every UNUSED grant of that session, then build the reconnect inventory. Every entry is an
 * explicit per-grant statement (`used` / `voided`); the coordinator releases nothing for grants that are not listed.
 */
export function closeSessionAndInventory(book: ClientGrantBook, sessionId: string): Readonly<{ book: ClientGrantBook; inventory: Readonly<{ used: readonly string[]; voided: readonly string[] }> }> {
  let next = book;
  for (const held of Object.values(book.grants)) if (held.grant.sessionId === sessionId && held.state === 'UNUSED') next = put(next, { ...held, state: 'VOIDED' });
  const ofSession = Object.values(next.grants).filter((held) => held.grant.sessionId === sessionId);
  return Object.freeze({
    book: next,
    inventory: Object.freeze({
      used: Object.freeze(ofSession.filter((held) => held.state === 'USED').map((held) => held.grant.grantId).sort()),
      voided: Object.freeze(ofSession.filter((held) => held.state === 'VOIDED').map((held) => held.grant.grantId).sort()),
    }),
  });
}
