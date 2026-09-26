import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../../src/core/time/clock';
import { PracticalPersistenceError } from '../../../../../src/execution/live/practical-persistence/ports';
import {
  PRACTICAL_REVOCATION_MAX_ATTEMPTS,
  PracticalPrivateStreamTripwire,
  practicalDurableSafetyProblem,
  type PracticalRevocationResult,
  type PracticalTrip,
} from '../../../../../src/execution/live/practical-recovery/tripwire';
import type { PracticalRevocationPort } from '../../../../../src/execution/live/practical-recovery/ports';
import { FakePrivateStream, T0 } from './support';

/** A fresh Stage 1B1 read that PROVES no practical authority remains. */
const SAFE_ACCOUNT = { state: 'QUARANTINED', currentCertificate: null, currentLease: null, leasedCertificate: null, fence: { mode: { kind: 'IDLE' } } };
const SAFE = { kind: 'FOUND', account: SAFE_ACCOUNT };

function harness(revoke: PracticalRevocationPort['invalidate'] = async () => ({ account: {} as never, reviewEpisodeId: null })) {
  const clock = new FakeClock(T0);
  const stream = new FakePrivateStream();
  const revocations: string[] = [];
  const trips: PracticalTrip[] = [];
  const results: PracticalRevocationResult[] = [];
  const tripwire = new PracticalPrivateStreamTripwire({
    accountId: 'account-1',
    source: stream,
    revocation: {
      invalidate: async (input) => {
        revocations.push(input.reason);
        return revoke(input);
      },
    },
    clock,
    hooks: { onTrip: (trip) => trips.push(trip), onRevocation: (_trip, result) => results.push(result) },
  });
  return { clock, stream, tripwire, revocations, trips, results };
}

describe('the tripwire can only revoke', () => {
  it('arming binds the current incarnation; a quiet stream grants and changes nothing', async () => {
    const { stream, tripwire, revocations } = harness();
    const armed = tripwire.arm();
    expect(armed).toMatchObject({ kind: 'ARMED', watch: { accountId: 'account-1', binding: { incarnation: 1, invalidEventCount: 0 } } });
    expect(tripwire.check()).toBeNull();
    await tripwire.settled();
    expect(revocations).toEqual([]);
    expect(stream.listenerCount).toBe(1);
  });

  it('refuses to bind a stream that is not connected with the join sent', () => {
    const { stream, tripwire } = harness();
    stream.health = { ...stream.health, connected: false };
    expect(tripwire.arm()).toEqual({ kind: 'NOT_READY', readiness: 'DISCONNECTED', reason: 'DISCONNECTED' });
    expect(tripwire.watch).toBeNull();
    expect(stream.listenerCount).toBe(0);
  });

  it.each([
    ['an order update', 'PRIVATE_ORDER_UPDATE_NOTIFICATION', 'PRIVATE_STATE_EVENT'],
    ['a position update', 'PRIVATE_POSITION_UPDATE_NOTIFICATION', 'PRIVATE_STATE_EVENT'],
    ['a balance change', 'PRIVATE_BALANCE_CHANGE_NOTIFICATION', 'PRIVATE_STATE_EVENT'],
    ['a disconnect', 'PRIVATE_STREAM_DISCONNECTED', 'WS_DISCONNECTED'],
    ['an unknown event', 'MYSTERY', 'UNKNOWN_PRIVATE_EVENT'],
  ])('%s trips once, durably invalidates once, and stays tripped', async (_label, eventType, reason) => {
    const { stream, tripwire, revocations, trips } = harness();
    tripwire.arm();
    stream.emit(eventType);
    stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    await tripwire.settled();
    expect(trips.map((trip) => trip.reason)).toEqual([reason]);
    expect(revocations).toEqual([reason]);
    expect(tripwire.trip).toMatchObject({ reason, source: 'EVENT', incarnation: 1 });
    expect(tripwire.check()).toMatchObject({ reason });
    expect(stream.listenerCount).toBe(0);
  });

  it('refuses to bind while join delivery is uncertain, or while a reconnect is unresolved', () => {
    const { stream, tripwire } = harness();
    stream.health = { ...stream.health, state: 'CONNECTED', authJoinSent: false };
    expect(tripwire.arm()).toEqual({ kind: 'NOT_READY', readiness: 'UNPROVEN', reason: 'JOIN_NOT_SENT' });
    stream.health = { ...stream.health, state: 'RECONCILIATION_REQUIRED', authJoinSent: true, reconciliationRequired: true };
    expect(tripwire.arm()).toEqual({ kind: 'NOT_READY', readiness: 'RECONCILIATION_REQUIRED', reason: 'RECONCILIATION_REQUIRED' });
    expect(tripwire.watch).toBeNull();
    expect(stream.listenerCount).toBe(0);
  });

  it('AUTH_JOIN_SENT alone (the real adapter\'s best state) is UNPROVEN: the tripwire refuses to arm', () => {
    const { stream, tripwire } = harness();
    stream.unprove();
    expect(stream.getHealthSnapshot()).toMatchObject({ state: 'AUTH_JOIN_SENT', connected: true, authJoinSent: true, reconciliationRequired: false });
    expect(tripwire.arm()).toEqual({ kind: 'NOT_READY', readiness: 'UNPROVEN', reason: 'NO_PROVIDER_CONFIRMATION' });
    expect(tripwire.watch).toBeNull();
    expect(stream.listenerCount).toBe(0);
  });

  it('a new incarnation starts UNPROVEN: incarnation 1\'s readiness never carries over; only its own confirmation proves it', () => {
    const { stream, tripwire } = harness();
    stream.reconnect();
    // Even if a future adapter resolved the reconnect, the new incarnation has no confirmation of its own.
    stream.health = { ...stream.health, state: 'AUTH_JOIN_SENT', reconciliationRequired: false };
    expect(tripwire.arm()).toEqual({ kind: 'NOT_READY', readiness: 'UNPROVEN', reason: 'NO_PROVIDER_CONFIRMATION' });
    stream.health = { ...stream.health, subscriptionConfirmation: { source: 'PROVIDER', incarnation: 1, confirmedAtMs: 1 } };
    expect(tripwire.arm()).toEqual({ kind: 'NOT_READY', readiness: 'UNPROVEN', reason: 'CONFIRMATION_FOR_OTHER_INCARNATION' });
    stream.confirmSubscription(5);
    expect(tripwire.arm()).toMatchObject({ kind: 'ARMED', watch: { binding: { incarnation: 2, confirmedAtMs: 5 } } });
  });

  it('a reconnect trips; the stream is then unusable: re-arming on the NEW incarnation is refused (RECONCILIATION_REQUIRED)', async () => {
    const { stream, tripwire, revocations } = harness();
    tripwire.arm();
    stream.reconnect();
    await tripwire.settled();
    expect(tripwire.trip?.reason).toBe('WS_DISCONNECTED');
    expect(tripwire.check()).not.toBeNull();
    expect(stream.getHealthSnapshot()).toMatchObject({ generationId: 2, state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true });
    // The trip stands: re-arming is refused outright.
    const trip = tripwire.trip!;
    expect(tripwire.arm()).toEqual({ kind: 'TRIPPED', trip });
    // Even once durable safety is proven and the trip released, the reconnected stream is unusable.
    expect(tripwire.releaseTrip(trip, SAFE)).toEqual({ kind: 'RELEASED' });
    expect(tripwire.arm()).toEqual({ kind: 'NOT_READY', readiness: 'RECONCILIATION_REQUIRED', reason: 'RECONCILIATION_REQUIRED' });
    expect(tripwire.watch).toBeNull();
    expect(revocations).toEqual(['WS_DISCONNECTED']);
  });

  it.each([
    ['a new incarnation without any event', { generationId: 2 }, 'STREAM_INCARNATION_CHANGED'],
    ['a silent move to RECONCILIATION_REQUIRED', { state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true }, 'WS_RECONNECTED'],
    ['a lost join', { authJoinSent: false }, 'WS_JOIN_FAILED'],
    ['readiness lost: the provider confirmation disappears', { subscriptionConfirmation: null }, 'WS_JOIN_FAILED'],
    ['readiness replaced: a new subscription attempt', { subscriptionConfirmation: { source: 'PROVIDER' as const, incarnation: 1, confirmedAtMs: 999 } }, 'WS_JOIN_FAILED'],
    ['a silent disconnect', { connected: false }, 'WS_DISCONNECTED'],
    ['a malformed private event the stream dropped', { invalidEventCount: 1 }, 'UNKNOWN_PRIVATE_EVENT'],
  ])('health check: %s trips', async (_label, change, reason) => {
    const { stream, tripwire, revocations } = harness();
    tripwire.arm();
    stream.health = { ...stream.health, ...change };
    expect(tripwire.check()).toMatchObject({ reason, source: 'HEALTH_CHECK' });
    await tripwire.settled();
    expect(revocations).toEqual([reason]);
  });

  it('a classifier or snapshot fault fails closed', async () => {
    const { stream, tripwire } = harness();
    tripwire.arm();
    stream.getHealthSnapshot = () => { throw new Error('boom'); };
    expect(tripwire.check()).toMatchObject({ reason: 'UNKNOWN_PRIVATE_EVENT' });
  });

  it('an event from a watch that was replaced cannot trip the new watch', async () => {
    const { stream, tripwire, trips } = harness();
    tripwire.arm();
    const oldListenerFires = () => stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    tripwire.disarm();
    oldListenerFires();
    expect(trips).toEqual([]);
  });
});

describe('durable revocation', () => {
  it('a transient failure is retried; a persistent one is reported and the trip stays sticky', async () => {
    let failures = 1;
    const retried = harness(async () => {
      if (failures-- > 0) throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_FAULT', 'db down');
      return { account: {} as never, reviewEpisodeId: null };
    });
    retried.tripwire.arm();
    retried.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    await retried.tripwire.settled();
    expect(retried.revocations).toHaveLength(2);
    expect(retried.results).toEqual([{ kind: 'REVOKED' }]);

    const failing = harness(async () => { throw new Error('db down'); });
    failing.tripwire.arm();
    failing.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    await failing.tripwire.settled();
    expect(failing.revocations).toHaveLength(PRACTICAL_REVOCATION_MAX_ATTEMPTS);
    expect(failing.results).toEqual([{ kind: 'FAILED', failure: 'UNEXPECTED_ERROR' }]);
    expect(failing.tripwire.trip).not.toBeNull();
  });

  it('an absent, malformed, or latched account has nothing to revoke (no retry storm)', async () => {
    for (const code of ['PRACTICAL_PERSISTENCE_NOT_FOUND', 'PRACTICAL_PERSISTENCE_MALFORMED', 'PRACTICAL_PERSISTENCE_LATCHED'] as const) {
      const { stream, tripwire, revocations, results } = harness(async () => { throw new PracticalPersistenceError(code, 'x'); });
      tripwire.arm();
      stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
      await tripwire.settled();
      expect(revocations).toHaveLength(1);
      expect(results).toEqual([{ kind: 'NOTHING_TO_REVOKE', code }]);
    }
  });
});

describe('P18B-B-06 the sticky trip lifecycle: only a durable safety proof clears a trip', () => {
  it('arm() and disarm() can NEVER erase a standing trip (the same incarnation and confirmation stay blocked)', async () => {
    const { stream, tripwire, revocations } = harness(async () => { throw new Error('db down'); });
    tripwire.arm();
    stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    await tripwire.settled();
    const trip = tripwire.trip!;
    expect(revocations).toHaveLength(PRACTICAL_REVOCATION_MAX_ATTEMPTS);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(tripwire.arm()).toEqual({ kind: 'TRIPPED', trip });
      tripwire.disarm();
      expect(tripwire.trip).toBe(trip);
    }
    expect(tripwire.watch).toBeNull();
    expect(stream.listenerCount).toBe(0);
  });

  it.each([
    ['an unreadable read', undefined, 'PERSISTENCE_UNREADABLE'],
    ['NOT_FOUND (ambiguous)', { kind: 'NOT_FOUND' }, 'ACCOUNT_NOT_FOUND'],
    ['MALFORMED', { kind: 'MALFORMED', problem: 'FENCE_ROW_INVALID', reviewEpisodeId: null }, 'ACCOUNT_MALFORMED'],
    ['an ISSUED certificate still current', { kind: 'FOUND', account: { ...SAFE_ACCOUNT, state: 'CERTIFIED_IDLE', currentCertificate: { certificateId: 'c-1', status: 'ISSUED' } } }, 'CERTIFICATE_OUTSTANDING'],
    ['CERTIFIED_IDLE', { kind: 'FOUND', account: { ...SAFE_ACCOUNT, state: 'CERTIFIED_IDLE' } }, 'CERTIFIED'],
    ['CERTIFYING (state)', { kind: 'FOUND', account: { ...SAFE_ACCOUNT, state: 'CERTIFYING' } }, 'CERTIFYING'],
    ['CERTIFYING (fence)', { kind: 'FOUND', account: { ...SAFE_ACCOUNT, fence: { mode: { kind: 'CERTIFYING' } } } }, 'CERTIFYING'],
    ['a mutation lease', { kind: 'FOUND', account: { ...SAFE_ACCOUNT, fence: { mode: { kind: 'MUTATION_LEASED' } } } }, 'MUTATION_LEASE_HELD'],
    ['a current lease row', { kind: 'FOUND', account: { ...SAFE_ACCOUNT, currentLease: { leaseId: 'l-1' } } }, 'MUTATION_LEASE_HELD'],
  ])('durable state with %s does not prove safety: the trip is KEPT', async (_label, load, problem) => {
    expect(practicalDurableSafetyProblem(load)).toBe(problem);
    const { stream, tripwire } = harness();
    tripwire.arm();
    stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    await tripwire.settled();
    const trip = tripwire.trip!;
    expect(tripwire.releaseTrip(trip, load)).toEqual({ kind: 'KEPT', problem });
    expect(tripwire.trip).toBe(trip);
    expect(tripwire.arm()).toEqual({ kind: 'TRIPPED', trip });
  });

  it('a release needs THE current trip, and no revocation in flight', async () => {
    let finish!: () => void;
    const { stream, tripwire } = harness(() => new Promise((resolve) => { finish = () => resolve({ account: {} as never, reviewEpisodeId: null }); }));
    tripwire.arm();
    stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    const trip = tripwire.trip!;
    await Promise.resolve();
    expect(tripwire.releaseTrip(trip, SAFE)).toEqual({ kind: 'KEPT', problem: 'REVOCATION_IN_FLIGHT' });
    finish();
    await tripwire.settled();
    expect(tripwire.releaseTrip({ ...trip }, SAFE)).toEqual({ kind: 'KEPT', problem: 'NOT_THE_CURRENT_TRIP' });
    expect(practicalDurableSafetyProblem(SAFE)).toBeNull();
    expect(tripwire.releaseTrip(trip, SAFE)).toEqual({ kind: 'RELEASED' });
    expect(tripwire.trip).toBeNull();
    // Releasing grants nothing: arming is again subject to PROVEN_READY.
    stream.unprove();
    expect(tripwire.arm()).toMatchObject({ kind: 'NOT_READY', reason: 'NO_PROVIDER_CONFIRMATION' });
  });
});
