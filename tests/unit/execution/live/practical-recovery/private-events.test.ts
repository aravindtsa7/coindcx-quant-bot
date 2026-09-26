import { describe, expect, it } from 'vitest';
import {
  PRACTICAL_PRIVATE_BINDABLE_STATES,
  PRACTICAL_PRIVATE_NOISE_EVENT_TYPES,
  bindPracticalPrivateStream,
  classifyPracticalPrivateEvent,
  practicalPrivateStreamReadiness,
  practicalStreamHealthTrip,
} from '../../../../../src/execution/live/practical-recovery/private-events';

const envelope = (eventType: string, overrides: Record<string, unknown> = {}) => ({
  stream: 'PRIVATE_ACCOUNT', generationId: 3, eventType, receivedAtMs: 1, payload: {}, ...overrides,
});
/** What the REAL CoinDCX adapter can at best show: connected, join sent, AUTH_JOIN_SENT, no reconnect, and NO provider confirmation. */
const JOIN_SENT = { state: 'AUTH_JOIN_SENT', generationId: 3, connected: true, authJoinSent: true, invalidEventCount: 2, reconciliationRequired: false };
const CONFIRMATION = { source: 'PROVIDER', incarnation: 3, confirmedAtMs: 500 };
/** A deterministic PROVEN_READY snapshot: the same, plus a provider confirmation for incarnation 3. */
const HEALTH = { ...JOIN_SENT, subscriptionConfirmation: CONFIRMATION };
const BINDING = { incarnation: 3, state: 'AUTH_JOIN_SENT', invalidEventCount: 2, confirmedAtMs: 500 };

describe('private event classification: revoke-only, fail closed', () => {
  it.each([
    ['PRIVATE_ORDER_UPDATE_NOTIFICATION', 'STATE_CHANGE', 'PRIVATE_STATE_EVENT'],
    ['PRIVATE_POSITION_UPDATE_NOTIFICATION', 'STATE_CHANGE', 'PRIVATE_STATE_EVENT'],
    ['PRIVATE_BALANCE_CHANGE_NOTIFICATION', 'STATE_CHANGE', 'PRIVATE_STATE_EVENT'],
    ['PRIVATE_STREAM_DISCONNECTED', 'LIFECYCLE', 'WS_DISCONNECTED'],
    ['PRIVATE_RECONCILIATION_REQUIRED', 'LIFECYCLE', 'WS_RECONNECTED'],
    ['PRIVATE_STREAM_CONNECTED', 'LIFECYCLE', 'STREAM_INCARNATION_CHANGED'],
    ['SOMETHING_NEW_FROM_COINDCX', 'UNKNOWN', 'UNKNOWN_PRIVATE_EVENT'],
    ['PUBLIC_CANDLE_UPDATE', 'UNKNOWN', 'UNKNOWN_PRIVATE_EVENT'],
  ])('%s trips (%s / %s)', (eventType, category, reason) => {
    expect(classifyPracticalPrivateEvent(envelope(eventType), 3)).toEqual({ kind: 'TRIP', category, reason });
  });

  it('a ping-timeout disconnect is reported as WS_PING_TIMEOUT', () => {
    expect(classifyPracticalPrivateEvent(envelope('PRIVATE_STREAM_DISCONNECTED', { payload: { reason: 'PING_TIMEOUT' } }), 3))
      .toMatchObject({ kind: 'TRIP', reason: 'WS_PING_TIMEOUT' });
  });

  it('an event from another incarnation (older or newer) trips as an incarnation change, whatever its type', () => {
    for (const generationId of [2, 4]) {
      expect(classifyPracticalPrivateEvent(envelope('PRIVATE_ORDER_UPDATE_NOTIFICATION', { generationId }), 3))
        .toEqual({ kind: 'TRIP', category: 'LIFECYCLE', reason: 'STREAM_INCARNATION_CHANGED' });
    }
  });

  it.each([
    ['null', null],
    ['a string', 'PRIVATE_ORDER_UPDATE_NOTIFICATION'],
    ['another stream', envelope('PRIVATE_ORDER_UPDATE_NOTIFICATION', { stream: 'PUBLIC_FUTURES' })],
    ['a non-string type', envelope('x', { eventType: 7 })],
    ['a malformed incarnation', envelope('PRIVATE_ORDER_UPDATE_NOTIFICATION', { generationId: -1 })],
  ])('a malformed envelope (%s) is an UNKNOWN private event', (_label, value) => {
    expect(classifyPracticalPrivateEvent(value, 3)).toEqual({ kind: 'TRIP', category: 'UNKNOWN', reason: 'UNKNOWN_PRIVATE_EVENT' });
  });

  it('the reviewed noise list is empty: NO private event is currently treated as safety-irrelevant', () => {
    expect(PRACTICAL_PRIVATE_NOISE_EVENT_TYPES).toEqual([]);
    expect(Object.isFrozen(PRACTICAL_PRIVATE_NOISE_EVENT_TYPES)).toBe(true);
  });
});

describe('P18B-B-04 positive readiness: AUTH_JOIN_SENT is NOT readiness', () => {
  it('AUTH_JOIN_SENT alone (connected, join sent, no reconnect, no provider confirmation) is UNPROVEN and cannot bind', () => {
    expect(practicalPrivateStreamReadiness(JOIN_SENT)).toEqual({ kind: 'UNPROVEN', reason: 'NO_PROVIDER_CONFIRMATION' });
    expect(practicalPrivateStreamReadiness({ ...JOIN_SENT, subscriptionConfirmation: null })).toEqual({ kind: 'UNPROVEN', reason: 'NO_PROVIDER_CONFIRMATION' });
    expect(bindPracticalPrivateStream(JOIN_SENT)).toEqual({ kind: 'NOT_READY', readiness: 'UNPROVEN', reason: 'NO_PROVIDER_CONFIRMATION' });
  });

  it('PROVEN_READY needs a provider confirmation for EXACTLY this incarnation, and binds to it', () => {
    expect(practicalPrivateStreamReadiness(HEALTH)).toEqual({ kind: 'PROVEN_READY', incarnation: 3, confirmedAtMs: 500 });
    expect(bindPracticalPrivateStream(HEALTH)).toEqual({ kind: 'BOUND', binding: BINDING });
    expect(PRACTICAL_PRIVATE_BINDABLE_STATES).toEqual(['AUTH_JOIN_SENT']);
  });

  it('readiness of incarnation N never authorizes N+1 (or N-1)', () => {
    for (const incarnation of [2, 4]) {
      expect(practicalPrivateStreamReadiness({ ...HEALTH, subscriptionConfirmation: { ...CONFIRMATION, incarnation } }))
        .toEqual({ kind: 'UNPROVEN', reason: 'CONFIRMATION_FOR_OTHER_INCARNATION' });
    }
    // A reconnect: incarnation 4 carrying incarnation 3's confirmation.
    expect(practicalPrivateStreamReadiness({ ...HEALTH, generationId: 4 })).toEqual({ kind: 'UNPROVEN', reason: 'CONFIRMATION_FOR_OTHER_INCARNATION' });
  });

  it.each([
    ['a non-provider source', { ...CONFIRMATION, source: 'CLIENT' }],
    ['a missing incarnation', { source: 'PROVIDER', confirmedAtMs: 1 }],
    ['an unsafe time', { ...CONFIRMATION, confirmedAtMs: 1.5 }],
    ['a string', 'joined'],
    ['true', true],
  ])('a malformed confirmation (%s) is UNPROVEN', (_label, subscriptionConfirmation) => {
    expect(practicalPrivateStreamReadiness({ ...HEALTH, subscriptionConfirmation })).toEqual({ kind: 'UNPROVEN', reason: 'CONFIRMATION_MALFORMED' });
  });

  it.each([
    ['RECONCILIATION_REQUIRED (state and sticky flag)', { state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true }, { kind: 'RECONCILIATION_REQUIRED' }],
    ['the RECONCILIATION_REQUIRED state alone', { state: 'RECONCILIATION_REQUIRED' }, { kind: 'RECONCILIATION_REQUIRED' }],
    ['the sticky flag alone', { reconciliationRequired: true }, { kind: 'RECONCILIATION_REQUIRED' }],
    ['a NEW incarnation after a reconnect (confirmed or not)', { generationId: 4, reconciliationRequired: true, subscriptionConfirmation: { ...CONFIRMATION, incarnation: 4 } }, { kind: 'RECONCILIATION_REQUIRED' }],
    ['disconnected', { connected: false }, { kind: 'DISCONNECTED' }],
    ['join not sent', { authJoinSent: false }, { kind: 'UNPROVEN', reason: 'JOIN_NOT_SENT' }],
    ['connected, join not yet sent', { state: 'CONNECTED', authJoinSent: false }, { kind: 'UNPROVEN', reason: 'JOIN_NOT_SENT' }],
    ['CONNECTED with a stale join flag', { state: 'CONNECTED' }, { kind: 'UNPROVEN', reason: 'STATE_NOT_READY' }],
    ['degraded', { state: 'DEGRADED' }, { kind: 'UNPROVEN', reason: 'STATE_NOT_READY' }],
    ['reconnect wait', { state: 'RECONNECT_WAIT' }, { kind: 'UNPROVEN', reason: 'STATE_NOT_READY' }],
    ['no incarnation yet', { generationId: 0 }, { kind: 'UNPROVEN', reason: 'NO_INCARNATION' }],
    ['a snapshot without the reconciliation flag', { reconciliationRequired: undefined }, { kind: 'UNPROVEN', reason: 'HEALTH_MALFORMED' }],
  ])('%s -> not PROVEN_READY, cannot bind', (_label, change, readiness) => {
    const health = { ...HEALTH, ...change };
    expect(practicalPrivateStreamReadiness(health)).toEqual(readiness);
    expect(bindPracticalPrivateStream(health)).toMatchObject({ kind: 'NOT_READY', readiness: readiness.kind });
  });

  it('an unreadable snapshot is UNPROVEN', () => {
    expect(practicalPrivateStreamReadiness(null)).toEqual({ kind: 'UNPROVEN', reason: 'HEALTH_MALFORMED' });
    expect(bindPracticalPrivateStream(undefined)).toEqual({ kind: 'NOT_READY', readiness: 'UNPROVEN', reason: 'HEALTH_MALFORMED' });
  });
});

describe('health checks trip on any observable change, including any loss of PROVEN_READY', () => {
  it('an unchanged PROVEN_READY snapshot is not a trip (and is not evidence either)', () => {
    expect(practicalStreamHealthTrip(HEALTH, BINDING)).toBeNull();
  });

  it.each([
    ['a new incarnation', { generationId: 4 }, 'STREAM_INCARNATION_CHANGED'],
    ['a new incarnation, even one with its own confirmation', { generationId: 4, subscriptionConfirmation: { ...CONFIRMATION, incarnation: 4 } }, 'STREAM_INCARNATION_CHANGED'],
    ['a disconnect', { connected: false }, 'WS_DISCONNECTED'],
    ['entering RECONCILIATION_REQUIRED (state and flag)', { state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true }, 'WS_RECONNECTED'],
    ['the sticky reconciliation flag alone', { reconciliationRequired: true }, 'WS_RECONNECTED'],
    ['the RECONCILIATION_REQUIRED state alone', { state: 'RECONCILIATION_REQUIRED' }, 'WS_RECONNECTED'],
    ['a lost join', { authJoinSent: false }, 'WS_JOIN_FAILED'],
    ['the provider confirmation disappearing (back to AUTH_JOIN_SENT alone)', { subscriptionConfirmation: null }, 'WS_JOIN_FAILED'],
    ['a malformed confirmation', { subscriptionConfirmation: { source: 'CLIENT', incarnation: 3, confirmedAtMs: 500 } }, 'WS_JOIN_FAILED'],
    ['a replaced confirmation (a new subscription attempt)', { subscriptionConfirmation: { ...CONFIRMATION, confirmedAtMs: 900 } }, 'WS_JOIN_FAILED'],
    ['a malformed private event the stream dropped', { invalidEventCount: 3 }, 'UNKNOWN_PRIVATE_EVENT'],
    ['a degraded stream', { state: 'DEGRADED' }, 'UNKNOWN_PRIVATE_EVENT'],
    ['any other state change', { state: 'RECONNECT_WAIT' }, 'WS_DISCONNECTED'],
  ])('%s -> %s', (_label, change, reason) => {
    expect(practicalStreamHealthTrip({ ...HEALTH, ...change }, BINDING)).toBe(reason);
  });

  it('an unreadable snapshot trips', () => {
    expect(practicalStreamHealthTrip(undefined, BINDING)).toBe('UNKNOWN_PRIVATE_EVENT');
  });
});
