import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LiveReconciliationService,
  accountIdentityFinding,
  providerAccountFingerprint,
  requireCurrentReconciliation,
  requireExpectedProviderAccountFingerprint,
  resolveOrphanCleanupPolicy,
  verifyProviderAccountIdentity,
  type LiveProviderAccountIdentityRead,
} from '../../../../../src/execution/live/reconciliation';
import { currentAccountContinuityCapability } from '../../../../../src/execution/live/reconciliation/barrier';
import { InMemoryLiveExecutionRepository } from '../helpers';
import { InMemoryReconciliationRepository } from './in-memory-repository';
import {
  ACCOUNT,
  EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
  FAKE_COINDCX_ID,
  FakeEvidenceProvider,
  FakeOrphanCancellation,
  FixedClock,
  RUNTIME_IDENTITY,
  evidenceSet,
  venueOrder,
} from './helpers';

// Offline: every provider here is an in-memory fake. No test reaches CoinDCX.

const SUBACCOUNT_COINDCX_ID = 'fake-coindcx-trading-account-2';

function observed(coindcxId: string): LiveProviderAccountIdentityRead {
  return { kind: 'OBSERVED', fingerprint: providerAccountFingerprint(coindcxId) };
}

describe('provider account fingerprint', () => {
  it('is the plain SHA-256 hex of the exact identifier bytes (the same digest the read-only probe reports)', () => {
    expect(providerAccountFingerprint(FAKE_COINDCX_ID)).toBe(createHash('sha256').update(FAKE_COINDCX_ID, 'utf8').digest('hex'));
    expect(EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never normalizes: case, whitespace, and prefix variants are different accounts', () => {
    const base = providerAccountFingerprint(FAKE_COINDCX_ID);
    for (const variant of [FAKE_COINDCX_ID.toUpperCase(), ` ${FAKE_COINDCX_ID}`, `${FAKE_COINDCX_ID} `, FAKE_COINDCX_ID.slice(0, -1)]) {
      expect(providerAccountFingerprint(variant)).not.toBe(base);
    }
  });

  it('refuses an empty identifier', () => {
    expect(() => providerAccountFingerprint('')).toThrow(/LIVE_RECONCILIATION_EVIDENCE_INVALID/);
  });
});

describe('account identity verification (pure)', () => {
  it('expected ID matches -> ACCOUNT_IDENTITY_VERIFIED, which proves nothing beyond account identity', () => {
    const verification = verifyProviderAccountIdentity(EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT, observed(FAKE_COINDCX_ID));
    expect(verification).toEqual({
      kind: 'ACCOUNT_IDENTITY_VERIFIED',
      scope: 'PROVIDER_TRADING_ACCOUNT_AT_READ_TIME',
      provesAccountContinuity: false,
      provesCurrentReconciliation: false,
      provesReconnectContinuity: false,
      provesCredentialGeneration: false,
    });
    expect(accountIdentityFinding(verification)).toBeNull();
    expect(Object.isFrozen(verification)).toBe(true);
  });

  it('a different subaccount coindcx_id -> ACCOUNT_IDENTITY_MISMATCH and a MANUAL_REVIEW finding', () => {
    const verification = verifyProviderAccountIdentity(EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT, observed(SUBACCOUNT_COINDCX_ID));
    expect(verification.kind).toBe('ACCOUNT_IDENTITY_MISMATCH');
    const finding = accountIdentityFinding(verification);
    expect(finding).toMatchObject({ category: 'MANUAL_REVIEW_REQUIRED', code: 'RECON_ACCOUNT_IDENTITY_MISMATCH' });
    // Only fingerprint prefixes are recorded; never a raw identifier, never a full digest.
    const serialized = JSON.stringify(finding);
    expect(serialized).not.toContain(SUBACCOUNT_COINDCX_ID);
    expect(serialized).not.toContain(FAKE_COINDCX_ID);
    expect(serialized).not.toContain(EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT);
  });

  it.each([
    ['a missing/empty coindcx_id', { kind: 'UNAVAILABLE', reason: 'ACCOUNT_IDENTITY_MISSING' }, 'ACCOUNT_IDENTITY_MISSING'],
    ['an unreadable users/info', { kind: 'UNAVAILABLE', reason: 'ACCOUNT_IDENTITY_READ_FAILED' }, 'ACCOUNT_IDENTITY_READ_FAILED'],
    ['a malformed observed fingerprint', { kind: 'OBSERVED', fingerprint: FAKE_COINDCX_ID }, 'OBSERVED_FINGERPRINT_INVALID'],
    ['an uppercase observed fingerprint', { kind: 'OBSERVED', fingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT.toUpperCase() }, 'OBSERVED_FINGERPRINT_INVALID'],
  ] as const)('%s -> ACCOUNT_IDENTITY_UNVERIFIED (fails closed)', (_label, read, reason) => {
    const verification = verifyProviderAccountIdentity(EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT, read);
    expect(verification).toEqual({ kind: 'ACCOUNT_IDENTITY_UNVERIFIED', reason });
    expect(accountIdentityFinding(verification)).toMatchObject({ category: 'AMBIGUOUS', code: 'RECON_ACCOUNT_IDENTITY_UNVERIFIED' });
  });

  it('an invalid configured expectation never verifies anything', () => {
    for (const expected of ['', FAKE_COINDCX_ID, 'A'.repeat(64), 'a'.repeat(63)]) {
      expect(verifyProviderAccountIdentity(expected, observed(FAKE_COINDCX_ID)).kind).toBe('ACCOUNT_IDENTITY_UNVERIFIED');
      expect(() => requireExpectedProviderAccountFingerprint(expected)).toThrow(/LIVE_EXECUTION_DISABLED/);
    }
  });

  it('a rotated API key on the SAME trading account still verifies (coindcx_id is permanent across rotation), because no key material is an input', () => {
    // The only inputs are the configured fingerprint and the observed one; an
    // API key, secret, or key generation cannot influence the result.
    expect(verifyProviderAccountIdentity).toHaveLength(2);
    const beforeRotation = observed(FAKE_COINDCX_ID);
    const afterRotation = observed(FAKE_COINDCX_ID);
    expect(verifyProviderAccountIdentity(EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT, beforeRotation).kind).toBe('ACCOUNT_IDENTITY_VERIFIED');
    expect(verifyProviderAccountIdentity(EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT, afterRotation).kind).toBe('ACCOUNT_IDENTITY_VERIFIED');
  });

  it('identity success cannot construct ACCOUNT_CONTINUITY_PROVEN', () => {
    const verification = verifyProviderAccountIdentity(EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT, observed(FAKE_COINDCX_ID));
    expect(JSON.stringify(verification)).not.toContain('ACCOUNT_CONTINUITY_PROVEN');
    expect(Object.values(verification).filter((value) => value === true)).toEqual([]);
    // The only continuity decision point is untouched by a verified identity.
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
  });
});

function enabledOrphanPolicy() {
  const resolution = resolveOrphanCleanupPolicy({ LIVE_ORPHAN_CANCELLATION_ENABLED: 'true', LIVE_ORPHAN_CANCELLATION_ACCOUNT_ALLOWLIST: ACCOUNT });
  if (resolution.status !== 'ENABLED') throw new Error('fixture');
  return resolution.policy;
}

function buildService(provider: FakeEvidenceProvider, options: { readonly orphanCancellation?: FakeOrphanCancellation } = {}) {
  const reconciliation = new InMemoryReconciliationRepository();
  const execution = new InMemoryLiveExecutionRepository();
  const service = new LiveReconciliationService({
    repository: reconciliation,
    executionRepository: execution,
    evidenceProvider: provider,
    runtimeIdentity: RUNTIME_IDENTITY,
    credentialAccountId: ACCOUNT,
    expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
    clock: new FixedClock(),
    ...(options.orphanCancellation === undefined ? {} : { orphanCancellation: options.orphanCancellation, orphanPolicy: enabledOrphanPolicy() }),
  });
  return { service, reconciliation, execution };
}

describe('account identity guard inside reconciliation (the only path to HEALTHY)', () => {
  it('matching identity: the run proceeds, and the barrier STILL refuses mutation (identity is not continuity)', async () => {
    const provider = new FakeEvidenceProvider(evidenceSet());
    const { service, reconciliation } = buildService(provider);
    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.status).toBe('HEALTHY');
    expect(provider.identityCalls).toBe(1);
    expect(provider.orderCalls).toBeGreaterThan(0);
    await expect(requireCurrentReconciliation(reconciliation, ACCOUNT, RUNTIME_IDENTITY, 'CREATE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
  });

  it('mismatch (different subaccount): MANUAL_REVIEW_REQUIRED before ANY evidence read, effect, or orphan cancel', async () => {
    const orphanVisible = evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'orphan-1' })] });
    const provider = new FakeEvidenceProvider(orphanVisible);
    provider.accountIdentity = observed(SUBACCOUNT_COINDCX_ID);
    const orphanCancellation = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    const { service, reconciliation } = buildService(provider, { orphanCancellation });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.status).toBe('MANUAL_REVIEW_REQUIRED');
    expect(outcome.result.findings.map((finding) => finding.code)).toEqual(['RECON_ACCOUNT_IDENTITY_MISMATCH']);
    expect(provider.calls).toBe(0);
    expect(provider.orderCalls).toBe(0);
    expect(provider.positionCalls).toBe(0);
    expect(orphanCancellation.attempts).toEqual([]);
    expect(JSON.stringify(outcome.result.findings)).not.toContain(SUBACCOUNT_COINDCX_ID);
    await expect(requireCurrentReconciliation(reconciliation, ACCOUNT, RUNTIME_IDENTITY, 'CREATE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_MANUAL_REVIEW_REQUIRED' });

    // Control: the SAME evidence and orphan policy with a matching identity
    // does reach the orphan cancel, so the zero above is the guard's doing.
    const control = new FakeEvidenceProvider(orphanVisible);
    const controlCancellation = new FakeOrphanCancellation({ kind: 'CANCELLED' });
    await buildService(control, { orphanCancellation: controlCancellation }).service.reconcileAccount(ACCOUNT);
    expect(control.orderCalls).toBeGreaterThan(0);
    expect(controlCancellation.attempts.map((attempt) => attempt.exchangeOrderId)).toEqual(['orphan-1']);
  });

  it.each([
    ['missing coindcx_id', { kind: 'UNAVAILABLE', reason: 'ACCOUNT_IDENTITY_MISSING' }],
    ['unreadable users/info', { kind: 'UNAVAILABLE', reason: 'ACCOUNT_IDENTITY_READ_FAILED' }],
  ] as const)('%s: the run completes blocked with nothing read or changed', async (_label, read) => {
    const provider = new FakeEvidenceProvider(evidenceSet());
    provider.accountIdentity = read;
    const { service, reconciliation } = buildService(provider);
    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.status).not.toBe('HEALTHY');
    expect(outcome.result.findings.map((finding) => finding.code)).toEqual(['RECON_ACCOUNT_IDENTITY_UNVERIFIED']);
    expect(provider.orderCalls).toBe(0);
    await expect(requireCurrentReconciliation(reconciliation, ACCOUNT, RUNTIME_IDENTITY, 'CREATE')).rejects.toThrow();
  });

  it('a provider that throws on the identity read is UNVERIFIED, never a pass', async () => {
    const provider = new FakeEvidenceProvider(evidenceSet());
    provider.readAccountIdentity = async () => { throw new Error('socket hang up'); };
    const { service } = buildService(provider);
    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.findings).toEqual([expect.objectContaining({
      code: 'RECON_ACCOUNT_IDENTITY_UNVERIFIED',
      evidence: expect.objectContaining({ failure: 'IDENTITY_READ_FAILED' }),
    })]);
    expect(provider.orderCalls).toBe(0);
  });

  it('recovers on a later run once the identity verifies (a blocked run is not sticky state)', async () => {
    const provider = new FakeEvidenceProvider(evidenceSet());
    provider.accountIdentity = { kind: 'UNAVAILABLE', reason: 'ACCOUNT_IDENTITY_READ_FAILED' };
    const { service } = buildService(provider);
    const first = await service.reconcileAccount(ACCOUNT);
    provider.accountIdentity = observed(FAKE_COINDCX_ID);
    const second = await service.reconcileAccount(ACCOUNT);
    if (first.kind !== 'COMPLETED' || second.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(first.result.status).not.toBe('HEALTHY');
    expect(second.result.status).toBe('HEALTHY');
  });

  it('the expectation is required configuration: a service cannot be built without a valid one', () => {
    for (const expected of [undefined, '', FAKE_COINDCX_ID, 'A'.repeat(64)]) {
      expect(() => new LiveReconciliationService({
        repository: new InMemoryReconciliationRepository(),
        executionRepository: new InMemoryLiveExecutionRepository(),
        evidenceProvider: new FakeEvidenceProvider(evidenceSet()),
        runtimeIdentity: RUNTIME_IDENTITY,
        credentialAccountId: ACCOUNT,
        expectedProviderAccountFingerprint: expected as unknown as string,
      })).toThrow(/LIVE_EXECUTION_DISABLED/);
    }
  });
});
