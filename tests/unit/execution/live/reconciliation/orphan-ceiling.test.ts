import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_ORPHAN_CANCELLATIONS_PER_RUN,
  LiveReconciliationService,
  MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING,
  OrphanCleanupPolicy,
  isValidMaxOrphanCancellationsPerRun,
  resolveOrphanCleanupPolicy,
  type LiveOrphanCancellationPort,
  type LiveOrphanCancelResult,
} from '../../../../../src/execution/live/reconciliation';
import { newLiveRuntimeIdentity } from '../../../../../src/execution/live/reconciliation/barrier';
import { InMemoryLiveExecutionRepository } from '../helpers';
import { InMemoryReconciliationRepository } from './in-memory-repository';
import {
  EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
  ACCOUNT,
  FakeEvidenceProvider,
  FakeOrphanCancellation,
  FixedClock,
  RUNTIME_IDENTITY,
  evidenceSet,
  venueOrder,
} from './helpers';

// [Wave C2 / F18-10] The orphan-cancellation per-run ceiling
// (`LIVE_ORPHAN_CANCELLATION_MAX_PER_RUN`) used to accept any all-digit string
// and convert it with `Number`, so a long enough digit string became
// `Infinity` and the service's `attempted >= maxCancellationsPerRun` bound
// could never be reached. It also had no upper bound at all. The ceiling is
// now a safe integer in [1, MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING], checked
// once at the configuration gate and again by the policy constructor, and the
// service accepts only a genuine, configuration-issued policy.

function resolveWithMax(max: unknown) {
  return resolveOrphanCleanupPolicy({
    LIVE_ORPHAN_CANCELLATION_ENABLED: 'true',
    LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST: ACCOUNT,
    LIVE_ORPHAN_CANCELLATION_MAX_PER_RUN: max as string | undefined,
  });
}

function expectRejected(max: unknown): void {
  const resolution = resolveWithMax(max);
  expect(resolution.status).toBe('DISABLED');
  expect(resolution.status === 'DISABLED' && resolution.reason).toBe('MALFORMED_MAX_PER_RUN');
}

function acceptedLimit(max: unknown): number {
  const resolution = resolveWithMax(max);
  if (resolution.status !== 'ENABLED') throw new Error(`expected ${String(max)} to be accepted`);
  return resolution.policy.maxCancellationsPerRun;
}

describe('[F18-10] the per-run orphan cancellation ceiling', () => {
  it('has an explicit hard ceiling above the default', () => {
    expect(MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING).toBe(20);
    expect(DEFAULT_MAX_ORPHAN_CANCELLATIONS_PER_RUN).toBe(5);
    expect(DEFAULT_MAX_ORPHAN_CANCELLATIONS_PER_RUN).toBeLessThanOrEqual(MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING);
  });

  const DANGEROUS_STRINGS: readonly string[] = [
    'Infinity', '-Infinity', '+Infinity', 'infinity', 'NaN', 'nan',
    '1e309', '1E309', '1e3', '2e1', '1e1', '5e0',
    '0', '00', '-0', '05', '-1', '-5', '+5',
    '1.5', '5.0', '5.', '.5', '0x10', '0b11', '0o7', '1_0', '5n',
    '999999999999999999999999999',
    String(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER + 1), '9007199254740993',
    '9'.repeat(400), `1${'0'.repeat(308)}`,
    ' ', '   ', '\t', '\n', ' 5', '5 ', ' 5 ',
    'five', 'abc', '5abc', 'true', 'null', 'undefined',
    String(MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING + 1), '100', '1000000',
  ];

  it.each(DANGEROUS_STRINGS)('rejects the configured string %j (cleanup stays off; never a default, a clamp, or Infinity)', (raw) => {
    expectRejected(raw);
  });

  const DANGEROUS_NON_STRINGS: readonly unknown[] = [
    Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN,
    // eslint-disable-next-line no-loss-of-precision -- the literal 1e309 deliberately overflows to Infinity
    1e309, 0, -0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1,
    5, 20, null, true, false, {}, [], [5], 5n,
  ];

  it.each(DANGEROUS_NON_STRINGS.map((value) => [value]))('rejects a non-string configuration value %s rather than silently defaulting', (value) => {
    expectRejected(value);
  });

  it('takes the conservative default only when the key is absent (undefined or empty, as for the enable flag)', () => {
    expect(acceptedLimit(undefined)).toBe(DEFAULT_MAX_ORPHAN_CANCELLATIONS_PER_RUN);
    expect(acceptedLimit('')).toBe(DEFAULT_MAX_ORPHAN_CANCELLATIONS_PER_RUN);
    const unset = resolveOrphanCleanupPolicy({
      LIVE_ORPHAN_CANCELLATION_ENABLED: 'true',
      LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST: ACCOUNT,
    });
    expect(unset.status === 'ENABLED' && unset.policy.maxCancellationsPerRun).toBe(DEFAULT_MAX_ORPHAN_CANCELLATIONS_PER_RUN);
  });

  it.each([
    ['1', 1],
    ['3', 3],
    ['5', 5],
    ['10', 10],
    ['19', 19],
    [String(MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING), MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING],
  ] as const)('accepts the valid configured value %s', (raw, expected) => {
    expect(acceptedLimit(raw)).toBe(expected);
  });

  it('is deterministic at the boundary: the ceiling is accepted and ceiling + 1 is rejected', () => {
    expect(acceptedLimit(String(MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING))).toBe(MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING);
    expectRejected(String(MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING + 1));
  });

  it('never lets a malformed ceiling enable cleanup even when every other key is valid', () => {
    for (const raw of DANGEROUS_STRINGS) {
      expect(resolveWithMax(raw).status, raw).toBe('DISABLED');
    }
  });

  it('exposes one numeric invariant that every issued policy satisfies', () => {
    for (const value of [1, 5, MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING]) {
      expect(isValidMaxOrphanCancellationsPerRun(value)).toBe(true);
    }
    for (const value of [
      0, -0, -1, 1.5, MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING + 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
      Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, '5', null, undefined, 5n,
    ]) {
      expect(isValidMaxOrphanCancellationsPerRun(value), String(value)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The service's consumption boundary
// ---------------------------------------------------------------------------

function serviceDependencies(orphanPolicy: unknown, port: LiveOrphanCancellationPort) {
  return {
    repository: new InMemoryReconciliationRepository(),
    executionRepository: new InMemoryLiveExecutionRepository(),
    evidenceProvider: new FakeEvidenceProvider(evidenceSet()),
    runtimeIdentity: RUNTIME_IDENTITY,
    credentialAccountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
    clock: new FixedClock(),
    orphanPolicy: orphanPolicy as OrphanCleanupPolicy,
    orphanCancellation: port,
  };
}

describe('[F18-10] the service reads the ceiling only from a genuine policy', () => {
  it.each([
    ['a structural look-alike with an Infinity ceiling', { permitsAccount: () => true, maxCancellationsPerRun: Number.POSITIVE_INFINITY }],
    ['a structural look-alike with a huge ceiling', { permitsAccount: () => true, maxCancellationsPerRun: 1_000_000, accountAllowlist: [ACCOUNT] }],
    ['an object on the genuine prototype without the private record', Object.create(OrphanCleanupPolicy.prototype) as unknown],
  ])('refuses %s at construction', (_label, forged) => {
    expect(() => new LiveReconciliationService(serviceDependencies(forged, new FakeOrphanCancellation())))
      .toThrow(/LIVE_EXECUTION_DISABLED/);
  });

  it('still accepts the genuine configuration-issued policy', () => {
    const resolution = resolveWithMax('3');
    if (resolution.status !== 'ENABLED') throw new Error('expected enabled policy');
    expect(() => new LiveReconciliationService(serviceDependencies(resolution.policy, new FakeOrphanCancellation()))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The ceiling actually caps work, per reconciliation run
// ---------------------------------------------------------------------------

const ORPHAN_COUNT = MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING + 5;
const manyOrphans = evidenceSet({
  orders: Array.from({ length: ORPHAN_COUNT }, (_, i) => venueOrder({ exchangeOrderId: `stranger-${String(i).padStart(2, '0')}` })),
});

function orphanService(options: {
  readonly max: string | undefined;
  readonly port: LiveOrphanCancellationPort;
  readonly reconciliation?: InMemoryReconciliationRepository;
  readonly execution?: InMemoryLiveExecutionRepository;
  readonly fresh?: boolean;
}) {
  const resolution = resolveWithMax(options.max);
  if (resolution.status !== 'ENABLED') throw new Error('expected enabled policy');
  const reconciliation = options.reconciliation ?? new InMemoryReconciliationRepository();
  const execution = options.execution ?? new InMemoryLiveExecutionRepository();
  const service = new LiveReconciliationService({
    repository: reconciliation,
    executionRepository: execution,
    evidenceProvider: new FakeEvidenceProvider(manyOrphans),
    runtimeIdentity: options.fresh === true ? newLiveRuntimeIdentity() : RUNTIME_IDENTITY,
    credentialAccountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
    clock: new FixedClock(),
    orphanPolicy: resolution.policy,
    orphanCancellation: options.port,
  });
  return { service, reconciliation, execution };
}

/** Records every call; throws (simulating a process crash after the wire request left) on the chosen call. */
class CrashingOrphanCancellation implements LiveOrphanCancellationPort {
  public readonly attempts: string[] = [];
  readonly #crashOnCall: number;

  public constructor(crashOnCall: number) {
    this.#crashOnCall = crashOnCall;
  }

  public async cancelVenueOrder(request: { readonly exchangeOrderId: string }): Promise<LiveOrphanCancelResult> {
    this.attempts.push(request.exchangeOrderId);
    if (this.attempts.length === this.#crashOnCall) throw new Error('simulated crash after the cancel left the process');
    return { kind: 'CANCELLED' };
  }
}

function ids(port: FakeOrphanCancellation): string[] {
  return port.attempts.map((attempt) => attempt.exchangeOrderId);
}

describe('[F18-10] a valid ceiling bounds the wire cancels one reconciliation run may initiate', () => {
  it.each([
    ['1', 1],
    ['3', 3],
    [undefined, DEFAULT_MAX_ORPHAN_CANCELLATIONS_PER_RUN],
    [String(MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING), MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING],
  ] as const)('with limit %s and more eligible orphans than that, initiates exactly the limit', async (max, expected) => {
    const port = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    const { service, reconciliation } = orphanService({ max, port });
    await service.reconcileAccount(ACCOUNT);

    expect(port.attempts).toHaveLength(expected);
    expect(new Set(ids(port)).size).toBe(expected);
    const orphans = await reconciliation.loadOrphanOrders(ACCOUNT);
    // Every orphan is still durably recorded; only the permitted number were claimed.
    expect(orphans).toHaveLength(ORPHAN_COUNT);
    expect(orphans.filter((orphan) => orphan.cancelState !== 'NONE')).toHaveLength(expected);
  });

  it('keeps each later run within the same per-run limit and never resends an already-cancelled orphan', async () => {
    const port = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    const { service } = orphanService({ max: '3', port });

    await service.reconcileAccount(ACCOUNT);
    expect(port.attempts).toHaveLength(3);
    await service.reconcileAccount(ACCOUNT);
    expect(port.attempts).toHaveLength(6);
    expect(new Set(ids(port)).size).toBe(6);
  });

  it('bounds ambiguous outcomes too: at most the limit become sticky CANCEL_AMBIGUOUS in a run, and none is ever resent', async () => {
    const port = new FakeOrphanCancellation({ kind: 'AMBIGUOUS', reasonCode: 'TIMEOUT' });
    const { service, reconciliation } = orphanService({ max: '2', port });

    const first = await service.reconcileAccount(ACCOUNT);
    expect(port.attempts).toHaveLength(2);
    if (first.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(first.result.status).toBe('MANUAL_REVIEW_REQUIRED');

    await service.reconcileAccount(ACCOUNT);
    expect(port.attempts).toHaveLength(4);
    expect(new Set(ids(port)).size).toBe(4);
    const ambiguous = (await reconciliation.loadOrphanOrders(ACCOUNT)).filter((orphan) => orphan.cancelState === 'CANCEL_AMBIGUOUS');
    expect(ambiguous).toHaveLength(4);
  });

  it('a crash mid-run and a restart neither exceed the per-run limit nor resend the in-flight cancel', async () => {
    const reconciliation = new InMemoryReconciliationRepository();
    const execution = new InMemoryLiveExecutionRepository();
    const crashing = new CrashingOrphanCancellation(2);
    const first = orphanService({ max: '3', port: crashing, reconciliation, execution });

    await expect(first.service.reconcileAccount(ACCOUNT)).rejects.toThrow(/simulated crash/);
    expect(crashing.attempts).toHaveLength(2);
    const [acknowledged, inFlight] = crashing.attempts;

    // A NEW process (new epoch) over the same durable state.
    const port = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    const second = orphanService({ max: '3', port, reconciliation, execution, fresh: true });
    const outcome = await second.service.reconcileAccount(ACCOUNT);

    expect(port.attempts).toHaveLength(3);
    expect(ids(port)).not.toContain(acknowledged);
    expect(ids(port)).not.toContain(inFlight);
    expect(new Set([...crashing.attempts, ...ids(port)]).size).toBe(5);
    const orphans = await reconciliation.loadOrphanOrders(ACCOUNT);
    expect(orphans.find((orphan) => orphan.exchangeOrderId === inFlight)?.cancelState).toBe('CANCEL_AMBIGUOUS');
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.findings.map((finding) => finding.code)).toContain('RECON_ORPHAN_CANCEL_AMBIGUOUS');
    expect(outcome.result.status).not.toBe('HEALTHY');
  });

  it('an invalid ceiling issues no policy, so no cancellation capability reaches the service at all', async () => {
    for (const raw of ['9'.repeat(400), '1e309', 'Infinity', String(MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING + 1)]) {
      const resolution = resolveWithMax(raw);
      expect(resolution.status, raw).toBe('DISABLED');
    }
    // What the composition root builds in that case: no policy, so cleanup is
    // off and the orphans block the account instead of being cancelled.
    const port = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    const service = new LiveReconciliationService({
      repository: new InMemoryReconciliationRepository(),
      executionRepository: new InMemoryLiveExecutionRepository(),
      evidenceProvider: new FakeEvidenceProvider(manyOrphans),
      runtimeIdentity: RUNTIME_IDENTITY,
      credentialAccountId: ACCOUNT, expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
      clock: new FixedClock(),
      orphanCancellation: port,
    });
    const outcome = await service.reconcileAccount(ACCOUNT);
    expect(port.attempts).toEqual([]);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.status).not.toBe('HEALTHY');
    expect(outcome.result.findings.map((finding) => finding.code)).toContain('RECON_ORPHAN_CLEANUP_DISABLED');
  });
});
