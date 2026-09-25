import { describe, expect, it } from 'vitest';
import {
  PRACTICAL_INVALIDATION_REASONS,
  PRACTICAL_INVALIDATION_SEVERITY,
  classifyPracticalInvalidation,
  practicalStateForSeverity,
  strictestPracticalSeverity,
} from '../../../../../src/execution/live/practical';

// Pure classification: no side effects.

const REQUIRED_REASONS = [
  'WS_DISCONNECTED', 'WS_RECONNECTED', 'WS_JOIN_FAILED', 'WS_PING_TIMEOUT', 'PRIVATE_STATE_EVENT', 'UNKNOWN_PRIVATE_EVENT',
  'PROVIDER_READ_ERROR', 'PROVIDER_SCHEMA_ERROR', 'INCOMPLETE_PAGINATION', 'ACCOUNT_IDENTITY_MISSING', 'ACCOUNT_IDENTITY_MISMATCH',
  'GENERATION_CHANGED', 'RUNTIME_EPOCH_CHANGED', 'STREAM_INCARNATION_CHANGED', 'PREFLIGHT_MISMATCH', 'POST_MUTATION_MISMATCH',
  'AMBIGUOUS_CREATE', 'AMBIGUOUS_CANCEL', 'DUPLICATE_CLIENT_ORDER_ID', 'ORPHAN_ORDER', 'UNEXPLAINED_POSITION', 'ECONOMICS_MISMATCH',
  'UNKNOWN_VENUE_STATUS', 'EVIDENCE_STALE', 'CLOCK_ANOMALY', 'CONFIG_CHANGED', 'CERTIFICATE_EXPIRED', 'CERTIFICATE_CONSUMED',
] as const;

const MANUAL_REVIEW = [
  'ACCOUNT_IDENTITY_MISMATCH', 'POST_MUTATION_MISMATCH', 'CLIENT_ORDER_ID_MULTIPLE_MATCHES', 'ORPHAN_ORDER', 'UNEXPLAINED_POSITION',
  'VENUE_INITIATED_CHANGE', 'ECONOMICS_MISMATCH', 'ORDER_IDENTITY_CONFLICT', 'UNKNOWN_VENUE_STATUS', 'RECOVERY_ESCALATION_THRESHOLD',
] as const;

describe('coverage', () => {
  it('declares every reason the design requires', () => {
    for (const reason of REQUIRED_REASONS) expect(PRACTICAL_INVALIDATION_REASONS).toContain(reason);
  });

  it('every declared reason has exactly one explicit severity, and the table has no extras', () => {
    expect(Object.keys(PRACTICAL_INVALIDATION_SEVERITY).sort()).toEqual([...PRACTICAL_INVALIDATION_REASONS].sort());
    for (const reason of PRACTICAL_INVALIDATION_REASONS) {
      expect(['QUARANTINE', 'MANUAL_REVIEW']).toContain(PRACTICAL_INVALIDATION_SEVERITY[reason]);
    }
    expect(Object.isFrozen(PRACTICAL_INVALIDATION_SEVERITY)).toBe(true);
  });
});

describe('severity', () => {
  it.each(MANUAL_REVIEW)('%s (identity / orphan / unexplained position / conflict-like) escalates to MANUAL_REVIEW', (reason) => {
    expect(classifyPracticalInvalidation(reason)).toBe('MANUAL_REVIEW');
  });

  it('every other reason — disconnect, read, pagination, staleness, binding, ordinary ambiguity — quarantines', () => {
    const quarantining = PRACTICAL_INVALIDATION_REASONS.filter((reason) => !(MANUAL_REVIEW as readonly string[]).includes(reason));
    expect(quarantining).toEqual(expect.arrayContaining([
      'WS_DISCONNECTED', 'WS_RECONNECTED', 'WS_JOIN_FAILED', 'WS_PING_TIMEOUT', 'PRIVATE_STATE_EVENT', 'UNKNOWN_PRIVATE_EVENT',
      'PROVIDER_READ_ERROR', 'PROVIDER_SCHEMA_ERROR', 'INCOMPLETE_PAGINATION', 'EVIDENCE_STALE', 'CLOCK_ANOMALY',
      'GENERATION_CHANGED', 'RUNTIME_EPOCH_CHANGED', 'STREAM_INCARNATION_CHANGED', 'CONFIG_CHANGED',
      'CERTIFICATE_EXPIRED', 'CERTIFICATE_CONSUMED', 'AMBIGUOUS_CREATE', 'AMBIGUOUS_CANCEL', 'DUPLICATE_CLIENT_ORDER_ID',
    ]));
    for (const reason of quarantining) expect(classifyPracticalInvalidation(reason)).toBe('QUARANTINE');
  });

  it('unknown or malformed input fails closed to MANUAL_REVIEW', () => {
    for (const value of ['SOMETHING_NEW', '', 'ws_disconnected', null, undefined, 42, {}]) {
      expect(classifyPracticalInvalidation(value)).toBe('MANUAL_REVIEW');
    }
  });

  it('maps severities to states and MANUAL_REVIEW dominates combinations (an empty list is malformed)', () => {
    expect(practicalStateForSeverity('QUARANTINE')).toBe('QUARANTINED');
    expect(practicalStateForSeverity('MANUAL_REVIEW')).toBe('MANUAL_REVIEW_REQUIRED');
    expect(strictestPracticalSeverity(['WS_DISCONNECTED', 'PROVIDER_READ_ERROR'])).toBe('QUARANTINE');
    expect(strictestPracticalSeverity(['WS_DISCONNECTED', 'ORPHAN_ORDER'])).toBe('MANUAL_REVIEW');
    expect(strictestPracticalSeverity([])).toBe('MANUAL_REVIEW');
  });
});
