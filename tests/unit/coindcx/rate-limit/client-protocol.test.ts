import { describe, expect, it } from 'vitest';
import { checkStart, closeSessionAndInventory, emptyGrantBook, receiveGrant, revokeGrant, type Grant, type StartContext } from '../../../../src/integration/coindcx/rate-limit';

// M2 W1 client half of the protocol: one-use grants, irrevocable voids, explicit inventories.
const grant = (id: string, overrides: Partial<Grant> = {}): Grant => ({ epoch: 'E1', sessionId: 'S1', grantId: id, requestId: id, ttlMs: 2000, operation: 'READ', scope: 'API_AUTH', viaHook: false, probeGen: null, ...overrides });
const ctx = (overrides: Partial<StartContext> = {}): StartContext => ({ sessionId: 'S1', sessionOpen: true, epoch: 'E1', knownStop: false, knownBlockedScopes: [], ...overrides });
const held = (g: Grant, at = 0) => receiveGrant(emptyGrantBook(), at, g, { sessionId: 'S1', epoch: 'E1' }).book;

describe('M2 W1 client grant protocol', () => {
  it('a grant is used once; USE and VOID are mutually exclusive', () => {
    const used = checkStart(held(grant('a')), 100, 'a', ctx());
    expect(used.kind).toBe('USE');
    expect(checkStart(used.book, 101, 'a', ctx())).toMatchObject({ kind: 'REFUSED', reason: 'ALREADY_USED' });
    expect(revokeGrant(used.book, 'a').report).toBeNull(); // a used grant can never be voided
    const voided = revokeGrant(held(grant('b')), 'b');
    expect(voided.report).toEqual({ kind: 'NOT_STARTED', grantId: 'b', reason: 'REVOKED' });
    expect(checkStart(voided.book, 1, 'b', ctx())).toMatchObject({ kind: 'REFUSED', reason: 'ALREADY_VOIDED' });
  });

  it('the relative deadline limits the check only; late, stale-epoch, closed-session, stopped and blocked checks void', () => {
    expect(checkStart(held(grant('a')), 2000, 'a', ctx()).kind).toBe('USE');
    const cases: Array<[Partial<StartContext>, Grant, number, string]> = [
      [{}, grant('a'), 2001, 'LOCAL_DEADLINE_PASSED'],
      [{ epoch: 'E2' }, grant('a'), 1, 'EPOCH_CHANGED'],
      [{ sessionOpen: false }, grant('a'), 1, 'SESSION_CLOSED'],
      [{ knownStop: true }, grant('a', { operation: 'CREATE' }), 1, 'LOCAL_STOP'],
      [{ knownBlockedScopes: ['API_AUTH'] }, grant('a'), 1, 'LOCAL_BLOCK'],
    ];
    for (const [context, g, now, reason] of cases) expect(checkStart(held(g), now, 'a', ctx(context))).toMatchObject({ kind: 'VOID', report: { kind: 'NOT_STARTED', grantId: 'a', reason } });
    expect(checkStart(held(grant('h', { operation: 'CANCEL', viaHook: true })), 1, 'h', ctx({ knownStop: true })).kind).toBe('USE');
    expect(checkStart(held(grant('p', { operation: 'PROBE', probeGen: 3 })), 1, 'p', ctx({ knownBlockedScopes: ['API_AUTH'] })).kind).toBe('USE');
  });

  it('a grant for another session or epoch is voided on receipt; duplicate delivery is idempotent', () => {
    const r = receiveGrant(emptyGrantBook(), 0, grant('a', { epoch: 'E0' }), { sessionId: 'S1', epoch: 'E1' });
    expect(r.report).toEqual({ kind: 'NOT_STARTED', grantId: 'a', reason: 'SESSION_MISMATCH' });
    const book = held(grant('b'));
    expect(receiveGrant(book, 5, grant('b'), { sessionId: 'S1', epoch: 'E1' }).book).toBe(book);
  });

  it('the reconnect inventory lists explicit used and voided grants of the closed session only', () => {
    let book = held(grant('used'));
    book = receiveGrant(book, 0, grant('unused'), { sessionId: 'S1', epoch: 'E1' }).book;
    book = receiveGrant(book, 0, grant('other', { sessionId: 'S2' }), { sessionId: 'S2', epoch: 'E1' }).book;
    book = (checkStart(book, 1, 'used', ctx()) as Extract<ReturnType<typeof checkStart>, { kind: 'USE' }>).book;
    const closed = closeSessionAndInventory(book, 'S1');
    expect(closed.inventory).toEqual({ used: ['used'], voided: ['unused'] });
    expect(closed.book.grants.unused!.state).toBe('VOIDED');
    expect(closed.book.grants.other!.state).toBe('UNUSED');
    expect(closeSessionAndInventory(emptyGrantBook(), 'S1').inventory).toEqual({ used: [], voided: [] });
  });
});
