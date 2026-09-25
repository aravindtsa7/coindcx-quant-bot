import { describe, expect, it } from 'vitest';
import {
  adoptPracticalFenceForNewRuntime,
  beginPracticalCertification,
  beginPracticalMutationLease,
  finishPracticalCertification,
  initialPracticalFence,
  releasePracticalMutationLease,
  type PracticalAccountFence,
  type PracticalFenceExpectation,
} from '../../../../../src/execution/live/practical';

// Pure compare-and-set domain: no locking, persistence, or clock.

const ACCOUNT = 'account-live-1';
const EPOCH = 'epoch-a';

function expect_(fence: PracticalAccountFence, overrides: Partial<PracticalFenceExpectation> = {}): PracticalFenceExpectation {
  return { accountId: fence.accountId, runtimeEpoch: fence.runtimeEpoch, reconciliationGeneration: fence.reconciliationGeneration, revision: fence.revision, ...overrides };
}

const fresh = () => initialPracticalFence({ accountId: ACCOUNT, runtimeEpoch: EPOCH, reconciliationGeneration: 5 });
const LEASE = { leaseId: 'lease-1', certificateId: 'c'.repeat(64), action: 'CANCEL' as const };

describe('transitions', () => {
  it('starts IDLE at revision 0', () => {
    expect(fresh()).toEqual({ accountId: ACCOUNT, runtimeEpoch: EPOCH, reconciliationGeneration: 5, revision: 0, mode: { kind: 'IDLE' } });
    expect(Object.isFrozen(fresh())).toBe(true);
  });

  it('IDLE -> CERTIFYING -> IDLE, adopting the forward generation, revision +1 each step', () => {
    const idle = fresh();
    const certifying = beginPracticalCertification(idle, expect_(idle), 'run-1');
    expect(certifying).toMatchObject({ revision: 1, mode: { kind: 'CERTIFYING', runId: 'run-1' } });
    const done = finishPracticalCertification(certifying, expect_(certifying), 'run-1', 8);
    expect(done).toMatchObject({ revision: 2, reconciliationGeneration: 8, mode: { kind: 'IDLE' } });
    expect(idle.mode.kind).toBe('IDLE'); // inputs are never mutated
  });

  it('IDLE -> MUTATION_LEASED -> IDLE', () => {
    const idle = fresh();
    const leased = beginPracticalMutationLease(idle, expect_(idle), LEASE);
    expect(leased).toMatchObject({ revision: 1, mode: { kind: 'MUTATION_LEASED', ...LEASE } });
    expect(releasePracticalMutationLease(leased, expect_(leased), 'lease-1')).toMatchObject({ revision: 2, mode: { kind: 'IDLE' } });
  });
});

describe('mutual exclusion and a single lease', () => {
  it('certification cannot begin while a mutation lease is held', () => {
    const leased = beginPracticalMutationLease(fresh(), expect_(fresh()), LEASE);
    expect(() => beginPracticalCertification(leased, expect_(leased), 'run-1')).toThrow(/PRACTICAL_FENCE_CONFLICT/);
  });

  it('a mutation lease cannot begin while certifying', () => {
    const certifying = beginPracticalCertification(fresh(), expect_(fresh()), 'run-1');
    expect(() => beginPracticalMutationLease(certifying, expect_(certifying), LEASE)).toThrow(/PRACTICAL_FENCE_CONFLICT/);
  });

  it('exactly one lease: a second lease (any action) is refused', () => {
    const leased = beginPracticalMutationLease(fresh(), expect_(fresh()), LEASE);
    for (const action of ['OPEN', 'CANCEL', 'CLOSE'] as const) {
      expect(() => beginPracticalMutationLease(leased, expect_(leased), { ...LEASE, leaseId: 'lease-2', action })).toThrow(/only one is allowed/);
    }
  });

  it('two workers racing from the same revision: the second compare-and-set fails', () => {
    const idle = fresh();
    const winner = beginPracticalMutationLease(idle, expect_(idle), LEASE);
    // The loser still holds the revision-0 view; applied to the winner's record it fails on the revision.
    expect(() => beginPracticalCertification(winner, expect_(idle), 'run-1')).toThrow(/PRACTICAL_FENCE_BINDING_MISMATCH/);
  });

  it('another certification cannot take a certifying fence; a foreign run or lease cannot finish or release it', () => {
    const certifying = beginPracticalCertification(fresh(), expect_(fresh()), 'run-1');
    expect(() => beginPracticalCertification(certifying, expect_(certifying), 'run-2')).toThrow(/PRACTICAL_FENCE_CONFLICT/);
    expect(() => finishPracticalCertification(certifying, expect_(certifying), 'run-2', 6)).toThrow(/does not own/);
    const leased = beginPracticalMutationLease(fresh(), expect_(fresh()), LEASE);
    expect(() => releasePracticalMutationLease(leased, expect_(leased), 'lease-2')).toThrow(/does not own/);
  });

  it('refuses unknown actions and malformed ids', () => {
    expect(() => beginPracticalMutationLease(fresh(), expect_(fresh()), { ...LEASE, action: 'MODIFY' as never })).toThrow(/Unknown mutation action/);
    expect(() => beginPracticalMutationLease(fresh(), expect_(fresh()), { ...LEASE, leaseId: '' })).toThrow(/PRACTICAL_FENCE_BINDING_MISMATCH/);
  });
});

describe('epoch, generation, account, and revision bindings', () => {
  it.each([
    ['epoch mismatch', { runtimeEpoch: 'epoch-b' }, /runtime epoch/],
    ['generation mismatch', { reconciliationGeneration: 6 }, /reconciliation generation/],
    ['account mismatch', { accountId: 'account-live-2' }, /different account/],
    ['stale revision', { revision: 3 }, /stale compare-and-set/],
  ])('%s is refused for every operation', (_label, override, message) => {
    const idle = fresh();
    expect(() => beginPracticalCertification(idle, expect_(idle, override), 'run-1')).toThrow(message);
    expect(() => beginPracticalMutationLease(idle, expect_(idle, override), LEASE)).toThrow(message);
    const certifying = beginPracticalCertification(idle, expect_(idle), 'run-1');
    expect(() => finishPracticalCertification(certifying, expect_(certifying, override), 'run-1', 6)).toThrow(message);
    const leased = beginPracticalMutationLease(idle, expect_(idle), LEASE);
    expect(() => releasePracticalMutationLease(leased, expect_(leased, override), 'lease-1')).toThrow(message);
  });

  // Phase 18 contract: every reconciliation run claims current_generation + 1
  // first, so a genuine certification always ends on a strictly newer one.
  it('a certification finishing on the SAME generation is refused', () => {
    const certifying = beginPracticalCertification(fresh(), expect_(fresh()), 'run-1');
    expect(() => finishPracticalCertification(certifying, expect_(certifying), 'run-1', 5))
      .toThrow(expect.objectContaining({ code: 'PRACTICAL_FENCE_BINDING_MISMATCH', message: expect.stringMatching(/strictly after/) }));
  });

  it('a certification finishing on a LOWER generation is refused', () => {
    const certifying = beginPracticalCertification(fresh(), expect_(fresh()), 'run-1');
    expect(() => finishPracticalCertification(certifying, expect_(certifying), 'run-1', 4)).toThrow(/strictly after/);
  });

  it('a certification finishing on a STRICTLY higher generation is accepted', () => {
    const certifying = beginPracticalCertification(fresh(), expect_(fresh()), 'run-1');
    expect(finishPracticalCertification(certifying, expect_(certifying), 'run-1', 6)).toMatchObject({ reconciliationGeneration: 6, mode: { kind: 'IDLE' } });
  });

  it('a refused finish leaves the fence CERTIFYING (the caller retries, or a new runtime adopts it)', () => {
    const certifying = beginPracticalCertification(fresh(), expect_(fresh()), 'run-1');
    expect(() => finishPracticalCertification(certifying, expect_(certifying), 'run-1', 5)).toThrow();
    expect(certifying.mode).toEqual({ kind: 'CERTIFYING', runId: 'run-1' });
  });
});

describe('adoption by a new runtime epoch', () => {
  it('IDLE or an abandoned CERTIFYING is reset to IDLE under the new epoch', () => {
    const certifying = beginPracticalCertification(fresh(), expect_(fresh()), 'run-dead');
    const adopted = adoptPracticalFenceForNewRuntime(certifying, { accountId: ACCOUNT, previousRuntimeEpoch: EPOCH, revision: certifying.revision }, 'epoch-b');
    expect(adopted).toMatchObject({ runtimeEpoch: 'epoch-b', revision: certifying.revision + 1, mode: { kind: 'IDLE' } });
  });

  it('a lease left by a previous runtime is refused (its wire-arm state must be resolved first)', () => {
    const leased = beginPracticalMutationLease(fresh(), expect_(fresh()), LEASE);
    expect(() => adoptPracticalFenceForNewRuntime(leased, { accountId: ACCOUNT, previousRuntimeEpoch: EPOCH, revision: leased.revision }, 'epoch-b'))
      .toThrow(/PRACTICAL_FENCE_CONFLICT/);
  });

  it('refuses the same epoch, a wrong previous epoch, or a stale revision', () => {
    const idle = fresh();
    expect(() => adoptPracticalFenceForNewRuntime(idle, { accountId: ACCOUNT, previousRuntimeEpoch: EPOCH, revision: 0 }, EPOCH)).toThrow(/different exact identifier/);
    expect(() => adoptPracticalFenceForNewRuntime(idle, { accountId: ACCOUNT, previousRuntimeEpoch: 'epoch-x', revision: 0 }, 'epoch-b')).toThrow(/previous runtime epoch/);
    expect(() => adoptPracticalFenceForNewRuntime(idle, { accountId: ACCOUNT, previousRuntimeEpoch: EPOCH, revision: 9 }, 'epoch-b')).toThrow(/stale/);
  });
});

describe('P18B-1A-06: malformed or unknown fence records fail closed before ANY operation', () => {
  const INVALID = /PRACTICAL_FENCE_INVALID/;
  const ADOPT = (fence: PracticalAccountFence) =>
    adoptPracticalFenceForNewRuntime(fence, { accountId: ACCOUNT, previousRuntimeEpoch: EPOCH, revision: fence.revision }, 'epoch-b');

  /** A durable record exactly as a corrupt row might deserialize: nothing normalizes it. */
  const corrupt = (overrides: Record<string, unknown>): PracticalAccountFence =>
    ({ accountId: ACCOUNT, runtimeEpoch: EPOCH, reconciliationGeneration: 5, revision: 3, mode: { kind: 'IDLE' }, ...overrides }) as never;

  /** Every operation, each with its own matching expectation, so only the corruption can refuse it. */
  function everyOperation(fence: PracticalAccountFence): readonly (() => unknown)[] {
    return [
      () => beginPracticalCertification(fence, expect_(fence), 'run-1'),
      () => beginPracticalMutationLease(fence, expect_(fence), LEASE),
      () => finishPracticalCertification(fence, expect_(fence), 'run-1', 99),
      () => releasePracticalMutationLease(fence, expect_(fence), 'lease-1'),
      () => ADOPT(fence),
    ];
  }

  it.each([{ kind: 'BROKEN' }, { kind: 'idle' }, { kind: 'STRICT_HEALTHY' }, {}, { kind: undefined }, null, 'IDLE', [{ kind: 'IDLE' }]])(
    'unknown mode %o refuses certification, lease, finish, release, and adoption (never treated as IDLE)',
    (mode) => {
      for (const operation of everyOperation(corrupt({ mode }))) expect(operation).toThrow(INVALID);
    },
  );

  it('unknown mode refuses begin certification', () => {
    expect(() => beginPracticalCertification(corrupt({ mode: { kind: 'BROKEN' } }), expect_(corrupt({})), 'run-1')).toThrow(INVALID);
  });

  it('unknown mode refuses a mutation lease', () => {
    expect(() => beginPracticalMutationLease(corrupt({ mode: { kind: 'BROKEN' } }), expect_(corrupt({})), LEASE)).toThrow(INVALID);
  });

  it('unknown mode refuses runtime adoption (never reset to IDLE)', () => {
    expect(() => ADOPT(corrupt({ mode: { kind: 'BROKEN' } }))).toThrow(INVALID);
  });

  it.each(['', ' run-1', 'run-1 ', undefined, 7])('malformed CERTIFYING runId %o is refused', (runId) => {
    for (const operation of everyOperation(corrupt({ mode: { kind: 'CERTIFYING', runId } }))) expect(operation).toThrow(INVALID);
  });

  it.each([
    ['leaseId', { leaseId: '' }],
    ['leaseId', { leaseId: ' lease-1' }],
    ['leaseId', { leaseId: 42 }],
    ['certificateId', { certificateId: '' }],
    ['certificateId', { certificateId: 'cert ' }],
    ['certificateId', { certificateId: null }],
    ['action', { action: 'MODIFY' }],
    ['action', { action: 'cancel' }],
    ['action', { action: undefined }],
  ])('malformed MUTATION_LEASED %s is refused (%o)', (_field, override) => {
    for (const operation of everyOperation(corrupt({ mode: { kind: 'MUTATION_LEASED', ...LEASE, ...override } }))) expect(operation).toThrow(INVALID);
  });

  it('a mode with missing or extra fields is refused (no silent normalization)', () => {
    for (const mode of [
      { kind: 'IDLE', runId: 'run-1' },
      { kind: 'CERTIFYING' },
      { kind: 'CERTIFYING', runId: 'run-1', leaseId: 'lease-1' },
      { kind: 'MUTATION_LEASED', leaseId: 'lease-1', action: 'CANCEL' },
      { kind: 'MUTATION_LEASED', ...LEASE, extra: true },
    ]) {
      for (const operation of everyOperation(corrupt({ mode }))) expect(operation).toThrow(INVALID);
    }
  });

  it.each([-1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '5', null])('generation %o is refused', (reconciliationGeneration) => {
    for (const operation of everyOperation(corrupt({ reconciliationGeneration }))) expect(operation).toThrow(INVALID);
  });

  it.each([-1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '3', null])('revision %o is refused', (revision) => {
    for (const operation of everyOperation(corrupt({ revision }))) expect(operation).toThrow(INVALID);
  });

  it.each([
    ['accountId', ''], ['accountId', ' account-live-1'], ['accountId', 1],
    ['runtimeEpoch', ''], ['runtimeEpoch', 'epoch-a '], ['runtimeEpoch', undefined],
  ])('malformed %s %o is refused', (field, value) => {
    const fence = corrupt({ [field]: value });
    expect(() => beginPracticalCertification(fence, expect_(fence), 'run-1')).toThrow(INVALID);
    expect(() => adoptPracticalFenceForNewRuntime(fence, { accountId: fence.accountId, previousRuntimeEpoch: fence.runtimeEpoch, revision: 3 }, 'epoch-b')).toThrow(INVALID);
  });

  it('a record with missing or extra top-level fields, or that is not a plain record, is refused', () => {
    const { mode: _mode, ...withoutMode } = corrupt({});
    for (const fence of [
      withoutMode,
      { ...corrupt({}), leased: true },
      Object.assign(Object.create({ inherited: true }), corrupt({})),
      null,
    ] as never[]) {
      expect(() => beginPracticalCertification(fence, expect_(corrupt({})), 'run-1')).toThrow(INVALID);
    }
  });

  it('a MAX_SAFE_INTEGER revision cannot increment, for any operation', () => {
    const idle = corrupt({ revision: Number.MAX_SAFE_INTEGER });
    expect(() => beginPracticalCertification(idle, expect_(idle), 'run-1')).toThrow(/revision is exhausted/);
    expect(() => beginPracticalMutationLease(idle, expect_(idle), LEASE)).toThrow(/revision is exhausted/);
    expect(() => ADOPT(idle)).toThrow(/revision is exhausted/);
    const certifying = corrupt({ revision: Number.MAX_SAFE_INTEGER, mode: { kind: 'CERTIFYING', runId: 'run-1' } });
    expect(() => finishPracticalCertification(certifying, expect_(certifying), 'run-1', 6)).toThrow(/revision is exhausted/);
    const leased = corrupt({ revision: Number.MAX_SAFE_INTEGER, mode: { kind: 'MUTATION_LEASED', ...LEASE } });
    expect(() => releasePracticalMutationLease(leased, expect_(leased), 'lease-1')).toThrow(/revision is exhausted/);
    // One below the limit still advances to exactly MAX_SAFE_INTEGER.
    const almost = corrupt({ revision: Number.MAX_SAFE_INTEGER - 1 });
    expect(beginPracticalCertification(almost, expect_(almost), 'run-1').revision).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('legitimate IDLE, CERTIFYING, and MUTATION_LEASED records (including plain deserialized ones) behave unchanged', () => {
    const idle = corrupt({});
    const certifying = beginPracticalCertification(idle, expect_(idle), 'run-1');
    expect(certifying).toEqual({ ...idle, revision: 4, mode: { kind: 'CERTIFYING', runId: 'run-1' } });
    expect(finishPracticalCertification(certifying, expect_(certifying), 'run-1', 6)).toEqual({ ...idle, reconciliationGeneration: 6, revision: 5, mode: { kind: 'IDLE' } });
    const leased = beginPracticalMutationLease(idle, expect_(idle), LEASE);
    expect(leased).toEqual({ ...idle, revision: 4, mode: { kind: 'MUTATION_LEASED', ...LEASE } });
    expect(releasePracticalMutationLease(leased, expect_(leased), 'lease-1')).toEqual({ ...idle, revision: 5, mode: { kind: 'IDLE' } });
    expect(ADOPT(idle)).toEqual({ ...idle, runtimeEpoch: 'epoch-b', revision: 4 });
    expect(ADOPT(certifying)).toEqual({ ...idle, runtimeEpoch: 'epoch-b', revision: 5 });
    expect(() => ADOPT(leased)).toThrow(/PRACTICAL_FENCE_CONFLICT/);
    // A JSON round trip (as from a durable row) is accepted as-is.
    const roundTripped = JSON.parse(JSON.stringify(leased)) as PracticalAccountFence;
    expect(releasePracticalMutationLease(roundTripped, expect_(roundTripped), 'lease-1').mode).toEqual({ kind: 'IDLE' });
  });

  it('validation never mutates or repairs the input record', () => {
    const fence = corrupt({ mode: { kind: 'BROKEN' } });
    const before = JSON.stringify(fence);
    expect(() => ADOPT(fence)).toThrow(INVALID);
    expect(JSON.stringify(fence)).toBe(before);
  });
});
