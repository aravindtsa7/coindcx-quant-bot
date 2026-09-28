import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { LiveExecutionError } from '../../../../../src/execution/live/errors';
import {
  PRACTICAL_CLASSIFIED_PRE_WRITE_CLAIM_FAILURE_CODES,
  classifyPracticalReconciliationMismatch,
  isClassifiedPreWriteClaimFailure,
  practicalCancelDwellMs,
} from '../../../../../src/execution/live/practical-mutation/preflight';
import { PRACTICAL_SAFETY_CEILINGS } from '../../../../../src/execution/live/practical/policy';

// [P18B Stage 1B2 Wave 2B1] The pure preflight decisions: the deterministic reconciliation mapping
// (R0 -> A -> B -> C, first match wins) and the EXACT classified pre-write claim failure set.

const EXPECTED = Object.freeze({ accountId: 'acct-w2b1', runtimeEpoch: 'epoch-now', reconciliationGeneration: 7 });
const HEALTHY = Object.freeze({
  accountId: 'acct-w2b1', status: 'HEALTHY', currentGeneration: 7, currentRunId: 'run-7', currentRuntimeEpoch: 'epoch-now',
  healthyGeneration: 7, blockingFindingCount: 0,
});

describe('classifyPracticalReconciliationMismatch: every rule alone', () => {
  it('the exact healthy row maps to null (and only it)', () => {
    expect(classifyPracticalReconciliationMismatch({ ...HEALTHY }, EXPECTED)).toBeNull();
  });

  it('R0: missing, not a plain record, or not EXACTLY the account -> PREFLIGHT_MISMATCH', () => {
    for (const row of [null, undefined, 'row', 7, [], [HEALTHY], Object.create({ ...HEALTHY }), { ...HEALTHY, accountId: 'ACCT-W2B1' },
      { ...HEALTHY, accountId: 'acct-w2b1 ' }, { ...HEALTHY, accountId: undefined }, { ...HEALTHY, accountId: 1 }]) {
      expect(classifyPracticalReconciliationMismatch(row, EXPECTED), JSON.stringify(row)).toBe('PREFLIGHT_MISMATCH');
    }
  });

  it('A: the current runtime epoch is not exactly this process epoch -> RUNTIME_EPOCH_CHANGED (null and case variants included)', () => {
    for (const currentRuntimeEpoch of [null, undefined, 'epoch-old', 'EPOCH-NOW', 'epoch-now ', '']) {
      expect(classifyPracticalReconciliationMismatch({ ...HEALTHY, currentRuntimeEpoch }, EXPECTED), String(currentRuntimeEpoch)).toBe('RUNTIME_EPOCH_CHANGED');
    }
  });

  it('B: a malformed or moved generation -> GENERATION_CHANGED', () => {
    for (const change of [
      { currentGeneration: 8 }, { healthyGeneration: 6 }, { currentGeneration: 8, healthyGeneration: 8 }, { healthyGeneration: null },
      { currentGeneration: '7' }, { currentGeneration: 7.5 }, { healthyGeneration: 7n }, { currentGeneration: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(classifyPracticalReconciliationMismatch({ ...HEALTHY, ...change }, EXPECTED), JSON.stringify(change, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))).toBe('GENERATION_CHANGED');
    }
  });

  it('C: not HEALTHY, blocking findings, or a null / malformed / over-long run id -> PREFLIGHT_MISMATCH', () => {
    for (const change of [
      { status: 'RUNNING' }, { status: 'UNHEALTHY' }, { status: 'MANUAL_REVIEW_REQUIRED' }, { status: 'healthy' }, { status: 'RECONCILIATION_REQUIRED' },
      { blockingFindingCount: 1 }, { blockingFindingCount: '0' }, { blockingFindingCount: null },
      { currentRunId: null }, { currentRunId: '' }, { currentRunId: ' run-7' }, { currentRunId: 'r'.repeat(65) }, { currentRunId: 7 },
    ]) {
      expect(classifyPracticalReconciliationMismatch({ ...HEALTHY, ...change }, EXPECTED), JSON.stringify(change)).toBe('PREFLIGHT_MISMATCH');
    }
    expect(classifyPracticalReconciliationMismatch({ ...HEALTHY, currentRunId: 'r'.repeat(64) }, EXPECTED)).toBeNull();
  });
});

describe('classifyPracticalReconciliationMismatch: deterministic precedence R0 -> A -> B -> C', () => {
  const EPOCH = { currentRuntimeEpoch: 'epoch-old' };
  const GENERATION = { currentGeneration: 8, healthyGeneration: 7 };
  const STATUS = { status: 'RUNNING', blockingFindingCount: 2, currentRunId: null };

  it.each([
    ['R0 + A + B + C', { accountId: 'other', ...EPOCH, ...GENERATION, ...STATUS }, 'PREFLIGHT_MISMATCH'],
    ['A + B + C', { ...EPOCH, ...GENERATION, ...STATUS }, 'RUNTIME_EPOCH_CHANGED'],
    ['A + B', { ...EPOCH, ...GENERATION }, 'RUNTIME_EPOCH_CHANGED'],
    ['A + C', { ...EPOCH, ...STATUS }, 'RUNTIME_EPOCH_CHANGED'],
    ['B + C (a run in flight: RUNNING with a bumped generation)', { ...GENERATION, ...STATUS }, 'GENERATION_CHANGED'],
    ['C only', { ...STATUS }, 'PREFLIGHT_MISMATCH'],
  ] as const)('%s', (_name, change, reason) => {
    expect(classifyPracticalReconciliationMismatch({ ...HEALTHY, ...change }, EXPECTED)).toBe(reason);
  });

  it('is pure: the row and the expectation are not modified', () => {
    const row = { ...HEALTHY, currentGeneration: 8 };
    const snapshot = JSON.stringify(row);
    classifyPracticalReconciliationMismatch(row, EXPECTED);
    expect(JSON.stringify(row)).toBe(snapshot);
  });
});

describe('isClassifiedPreWriteClaimFailure: EXACTLY three genuine Phase 17 codes', () => {
  it('the set is exactly LIVE_INTENT_INVALID, LIVE_AUTHORITY_INVALID, LIVE_ORDER_IDENTITY_MISMATCH', () => {
    expect([...PRACTICAL_CLASSIFIED_PRE_WRITE_CLAIM_FAILURE_CODES]).toEqual(['LIVE_INTENT_INVALID', 'LIVE_AUTHORITY_INVALID', 'LIVE_ORDER_IDENTITY_MISMATCH']);
    expect(Object.isFrozen(PRACTICAL_CLASSIFIED_PRE_WRITE_CLAIM_FAILURE_CODES)).toBe(true);
    for (const code of PRACTICAL_CLASSIFIED_PRE_WRITE_CLAIM_FAILURE_CODES) {
      expect(isClassifiedPreWriteClaimFailure(new LiveExecutionError(code, 'refused')), code).toBe(true);
    }
  });

  it('never classifies an integrity or persistence fault, another Phase 17 code, a database error, or a structural look-alike', () => {
    for (const error of [
      new LiveExecutionError('LIVE_DURABLE_INTEGRITY_VIOLATION', 'tampered'),
      new LiveExecutionError('LIVE_PERSISTENCE_FAULT', 'unreadable'),
      new LiveExecutionError('LIVE_ORDER_STATE_CONFLICT', 'moved'),
      new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'fence'),
      new Prisma.PrismaClientKnownRequestError('deadlock', { code: 'P2034', clientVersion: 'test' }),
      new Error('LIVE_INTENT_INVALID'),
      { code: 'LIVE_INTENT_INVALID' },
      Object.assign(Object.create(LiveExecutionError.prototype), {}),
      null, undefined, 'LIVE_INTENT_INVALID',
    ]) {
      expect(isClassifiedPreWriteClaimFailure(error), String((error as { code?: unknown } | null)?.code ?? error)).toBe(false);
    }
  });

  it('refuses a subclass instance even with a classified code (exact class prototype only)', () => {
    class Subclass extends LiveExecutionError {}
    expect(isClassifiedPreWriteClaimFailure(new Subclass('LIVE_INTENT_INVALID', 'x'))).toBe(false);
  });
});

describe('practicalCancelDwellMs', () => {
  it('is the stricter of the first-mutation and post-issuance dwell ceilings', () => {
    expect(practicalCancelDwellMs(PRACTICAL_SAFETY_CEILINGS)).toBe(60_000);
    expect(practicalCancelDwellMs({ ...PRACTICAL_SAFETY_CEILINGS, firstMutationDwellMs: 60_000, postIssuanceDwellMs: 90_000 })).toBe(90_000);
  });
});
