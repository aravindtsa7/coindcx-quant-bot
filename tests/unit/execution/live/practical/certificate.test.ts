import { describe, expect, it } from 'vitest';
import * as practical from '../../../../../src/execution/live/practical';
import {
  PracticalRecoveryCertificate,
  consumePracticalRecoveryCertificate,
  evaluatePracticalLiveSafetyConfig,
  revokePracticalRecoveryCertificate,
  verifyPracticalRecoveryCertificate,
  type PracticalCertificateBindings,
  type PracticalCertificationEvidenceSummary,
} from '../../../../../src/execution/live/practical';
import * as certificateModule from '../../../../../src/execution/live/practical/certificate';
import { issuePracticalRecoveryCertificate } from '../../../../../src/execution/live/practical/certificate';
// Internal issuance boundary, imported directly by tests only (no production importer).
import { issuePracticalLiveSafetyEnablement } from '../../../../../src/execution/live/practical/policy';
import { providerAccountFingerprint } from '../../../../../src/execution/live/reconciliation/account-identity';

// Pure domain: timestamps are passed in; nothing reads a clock or a provider.

const ACCOUNT = 'account-live-1';
const ISSUED_AT = 1_000_000;

const BINDINGS: PracticalCertificateBindings = Object.freeze({
  accountId: ACCOUNT,
  providerAccountFingerprint: providerAccountFingerprint('fake-coindcx-trading-account-1'),
  runtimeEpoch: 'epoch-a',
  reconciliationGeneration: 7,
  streamIncarnation: 3,
});

const EVIDENCE: PracticalCertificationEvidenceSummary = Object.freeze({
  evidenceDigest: 'e'.repeat(64),
  passCount: 3,
  certificationSpanMs: 30_000,
  minimumObservedPassSpacingMs: 10_000,
});

function enablement(extra: Record<string, string> = {}) {
  const resolution = issuePracticalLiveSafetyEnablement({ LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: ACCOUNT, ...extra });
  if (resolution.status !== 'ENABLED') throw new Error('fixture');
  return resolution.enablement;
}

function issue(overrides: { evidence?: Partial<PracticalCertificationEvidenceSummary>; bindings?: Partial<PracticalCertificateBindings>; issuedAtMs?: number; enablement?: unknown } = {}) {
  return issuePracticalRecoveryCertificate({
    enablement: overrides.enablement ?? enablement(),
    bindings: { ...BINDINGS, ...overrides.bindings },
    evidence: { ...EVIDENCE, ...overrides.evidence },
    issuedAtMs: overrides.issuedAtMs ?? ISSUED_AT,
  });
}

describe('issuance', () => {
  it('a valid issuer-created certificate carries every binding, practical basis, and no continuity claim', () => {
    const certificate = issue();
    const record = PracticalRecoveryCertificate.read(certificate)!;
    expect(record).toMatchObject({ ...BINDINGS, evidenceDigest: EVIDENCE.evidenceDigest, issuedAtMs: ISSUED_AT, expiresAtMs: ISSUED_AT + 120_000 });
    expect(record.basis).toBe('PRACTICAL_RECOVERY');
    expect(record.provesAccountContinuity).toBe(false);
    expect(certificate.basis).toBe('PRACTICAL_RECOVERY');
    expect(certificate.provesAccountContinuity).toBe(false);
    expect(PracticalRecoveryCertificate.status(certificate)).toBe('ISSUED');
    expect(record.certificateId).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(record)).toBe(true);
    expect(JSON.stringify(record)).not.toContain('ACCOUNT_CONTINUITY');
  });

  it('a tightened lifetime from configuration shortens the absolute expiry', () => {
    const certificate = issue({ enablement: enablement({ LIVE_PRACTICAL_CERTIFICATE_LIFETIME_MS: '60000' }) });
    expect(certificate.expiresAtMs).toBe(ISSUED_AT + 60_000);
  });

  it.each([
    ['too few passes', { passCount: 2 }],
    ['too short a span', { certificationSpanMs: 29_999 }],
    ['passes too close together', { minimumObservedPassSpacingMs: 9_999 }],
    ['a malformed evidence digest', { evidenceDigest: 'E'.repeat(64) }],
  ])('refuses %s', (_label, evidence) => {
    expect(() => issue({ evidence })).toThrow(/PRACTICAL_CERTIFICATE_INVALID/);
  });

  it.each([
    ['an empty account', { accountId: '' }],
    ['a raw (unhashed) provider identity', { providerAccountFingerprint: 'fake-coindcx-trading-account-1' }],
    ['a zero generation', { reconciliationGeneration: 0 }],
    ['a zero stream incarnation', { streamIncarnation: 0 }],
    ['a padded runtime epoch', { runtimeEpoch: ' epoch-a' }],
  ])('refuses %s', (_label, bindings) => {
    expect(() => issue({ bindings })).toThrow(/PRACTICAL_CERTIFICATE_INVALID/);
  });

  it('refuses without a genuine enablement, or for an account the enablement does not permit', () => {
    expect(() => issue({ enablement: { accountAllowlist: [ACCOUNT] } })).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
    // Parsed configuration data (even ELIGIBLE, for this account) is not authority.
    const evaluation = evaluatePracticalLiveSafetyConfig({ LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: ACCOUNT });
    expect(evaluation.status).toBe('ELIGIBLE');
    expect(() => issue({ enablement: evaluation })).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
    expect(() => issue({ bindings: { accountId: 'account-live-2' } })).toThrow(/not enabled for this account/);
  });

  it('there is no public constructor a caller can use to self-authorize', () => {
    const record = PracticalRecoveryCertificate.read(issue())!;
    expect(() => new PracticalRecoveryCertificate({}, record)).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
    expect(() => new PracticalRecoveryCertificate(Symbol('issuer'), record)).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
    expect(() => PracticalRecoveryCertificate.applyTermination({}, issue(), { status: 'REVOKED', atMs: 1, leaseId: null, reason: 'WS_DISCONNECTED' }))
      .toThrow(/PRACTICAL_AUTHORITY_INVALID/);
  });

  it('issuance is not exported from the practical barrel', () => {
    expect('issuePracticalRecoveryCertificate' in practical).toBe(false);
  });
});

describe('non-forgeability', () => {
  it('forged structural objects, clones, and prototype-only objects are rejected everywhere', () => {
    const genuine = issue();
    const forgeries = [
      { ...PracticalRecoveryCertificate.read(genuine) },
      { ...genuine },
      Object.create(PracticalRecoveryCertificate.prototype),
      structuredClone(PracticalRecoveryCertificate.read(genuine)),
    ];
    for (const forged of forgeries) {
      expect(PracticalRecoveryCertificate.read(forged)).toBeNull();
      expect(() => verifyPracticalRecoveryCertificate(forged, BINDINGS, ISSUED_AT)).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
      expect(() => consumePracticalRecoveryCertificate(forged, BINDINGS, ISSUED_AT, 'lease-1')).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
      expect(() => revokePracticalRecoveryCertificate(forged, 'WS_DISCONNECTED', ISSUED_AT)).toThrow(/PRACTICAL_AUTHORITY_INVALID/);
    }
    expect(Object.isFrozen(PracticalRecoveryCertificate)).toBe(true);
    expect(Object.isFrozen(PracticalRecoveryCertificate.prototype)).toBe(true);
    expect(Object.isFrozen(genuine)).toBe(true);
  });
});

describe('binding checks at use', () => {
  it.each([
    ['cross-account', { accountId: 'account-live-2' }, 'accountId'],
    ['cross-fingerprint', { providerAccountFingerprint: providerAccountFingerprint('another-subaccount') }, 'providerAccountFingerprint'],
    ['cross-epoch', { runtimeEpoch: 'epoch-b' }, 'runtimeEpoch'],
    ['cross-generation', { reconciliationGeneration: 8 }, 'reconciliationGeneration'],
    ['cross-stream-incarnation', { streamIncarnation: 4 }, 'streamIncarnation'],
  ])('%s is refused and does not consume the certificate', (_label, override, field) => {
    const certificate = issue();
    expect(() => consumePracticalRecoveryCertificate(certificate, { ...BINDINGS, ...override }, ISSUED_AT + 1, 'lease-1'))
      .toThrow(expect.objectContaining({ code: 'PRACTICAL_CERTIFICATE_BINDING_MISMATCH', details: expect.objectContaining({ mismatched: [field] }) }));
    expect(PracticalRecoveryCertificate.status(certificate)).toBe('ISSUED');
  });

  it('matching bindings verify without consuming', () => {
    const certificate = issue();
    expect(verifyPracticalRecoveryCertificate(certificate, BINDINGS, ISSUED_AT + 1).certificateId).toBe(certificate.certificateId);
    expect(PracticalRecoveryCertificate.status(certificate)).toBe('ISSUED');
  });
});

describe('expiry', () => {
  it('is absolute: usable just before, EXPIRED at the expiry instant, and permanently unusable afterwards', () => {
    const certificate = issue();
    expect(() => verifyPracticalRecoveryCertificate(certificate, BINDINGS, ISSUED_AT + 119_999)).not.toThrow();
    expect(() => verifyPracticalRecoveryCertificate(certificate, BINDINGS, ISSUED_AT + 120_000)).toThrow(/PRACTICAL_CERTIFICATE_EXPIRED/);
    expect(PracticalRecoveryCertificate.status(certificate)).toBe('EXPIRED');
    expect(PracticalRecoveryCertificate.termination(certificate)).toMatchObject({ status: 'EXPIRED', reason: 'CERTIFICATE_EXPIRED' });
    // Even presented with an earlier clock, an expired certificate stays dead.
    expect(() => consumePracticalRecoveryCertificate(certificate, BINDINGS, ISSUED_AT, 'lease-1')).toThrow(/PRACTICAL_CERTIFICATE_NOT_ISSUED/);
  });
});

describe('validity window is exactly issuedAt <= now < expiresAt (no clamping)', () => {
  const EXPIRES_AT = ISSUED_AT + 120_000;

  it('issuedAt - 1 is refused, fail-closed: the certificate is revoked for CLOCK_ANOMALY', () => {
    const certificate = issue();
    expect(() => verifyPracticalRecoveryCertificate(certificate, BINDINGS, ISSUED_AT - 1))
      .toThrow(expect.objectContaining({ code: 'PRACTICAL_CERTIFICATE_BEFORE_ISSUANCE' }));
    expect(PracticalRecoveryCertificate.termination(certificate)).toEqual({ status: 'REVOKED', atMs: ISSUED_AT - 1, leaseId: null, reason: 'CLOCK_ANOMALY' });
    // A later, valid-looking time cannot bring it back.
    expect(() => verifyPracticalRecoveryCertificate(certificate, BINDINGS, ISSUED_AT + 1)).toThrow(/PRACTICAL_CERTIFICATE_NOT_ISSUED/);
  });

  it('consumption at issuedAt - 1 (or any earlier time) is refused and consumes nothing', () => {
    for (const nowMs of [ISSUED_AT - 1, 0]) {
      const certificate = issue();
      expect(() => consumePracticalRecoveryCertificate(certificate, BINDINGS, nowMs, 'lease-1')).toThrow(/PRACTICAL_CERTIFICATE_BEFORE_ISSUANCE/);
      expect(PracticalRecoveryCertificate.status(certificate)).toBe('REVOKED');
      expect(PracticalRecoveryCertificate.termination(certificate)!.leaseId).toBeNull();
    }
  });

  it('issuedAt is allowed (verify and consume)', () => {
    expect(verifyPracticalRecoveryCertificate(issue(), BINDINGS, ISSUED_AT).issuedAtMs).toBe(ISSUED_AT);
    expect(consumePracticalRecoveryCertificate(issue(), BINDINGS, ISSUED_AT, 'lease-1').status).toBe('CONSUMED');
  });

  it('expiresAt - 1 is allowed (verify and consume)', () => {
    expect(() => verifyPracticalRecoveryCertificate(issue(), BINDINGS, EXPIRES_AT - 1)).not.toThrow();
    expect(consumePracticalRecoveryCertificate(issue(), BINDINGS, EXPIRES_AT - 1, 'lease-1').status).toBe('CONSUMED');
  });

  it('expiresAt is expired and refused (verify and consume)', () => {
    const verified = issue();
    expect(() => verifyPracticalRecoveryCertificate(verified, BINDINGS, EXPIRES_AT)).toThrow(/PRACTICAL_CERTIFICATE_EXPIRED/);
    expect(PracticalRecoveryCertificate.status(verified)).toBe('EXPIRED');
    const consumed = issue();
    expect(() => consumePracticalRecoveryCertificate(consumed, BINDINGS, EXPIRES_AT, 'lease-1')).toThrow(/PRACTICAL_CERTIFICATE_EXPIRED/);
    expect(PracticalRecoveryCertificate.status(consumed)).toBe('EXPIRED');
  });
});

describe('one-shot consumption', () => {
  it('consumes exactly once; a second consumption is refused', () => {
    const certificate = issue();
    const termination = consumePracticalRecoveryCertificate(certificate, BINDINGS, ISSUED_AT + 1, 'lease-1');
    expect(termination).toEqual({ status: 'CONSUMED', atMs: ISSUED_AT + 1, leaseId: 'lease-1', reason: null });
    expect(PracticalRecoveryCertificate.status(certificate)).toBe('CONSUMED');
    expect(() => consumePracticalRecoveryCertificate(certificate, BINDINGS, ISSUED_AT + 2, 'lease-2')).toThrow(/PRACTICAL_CERTIFICATE_NOT_ISSUED/);
    expect(() => verifyPracticalRecoveryCertificate(certificate, BINDINGS, ISSUED_AT + 2)).toThrow(/PRACTICAL_CERTIFICATE_NOT_ISSUED/);
  });

  it('nothing restores a consumed certificate: revoke is a no-op and no API returns it to ISSUED', () => {
    const certificate = issue();
    consumePracticalRecoveryCertificate(certificate, BINDINGS, ISSUED_AT + 1, 'lease-1');
    expect(revokePracticalRecoveryCertificate(certificate, 'WS_DISCONNECTED', ISSUED_AT + 2)).toMatchObject({ status: 'CONSUMED', leaseId: 'lease-1' });
    expect(PracticalRecoveryCertificate.status(certificate)).toBe('CONSUMED');
  });

  it('a revoked certificate cannot be consumed', () => {
    const certificate = issue();
    expect(revokePracticalRecoveryCertificate(certificate, 'PRIVATE_STATE_EVENT', ISSUED_AT + 1)).toMatchObject({ status: 'REVOKED', reason: 'PRIVATE_STATE_EVENT' });
    expect(() => consumePracticalRecoveryCertificate(certificate, BINDINGS, ISSUED_AT + 2, 'lease-1')).toThrow(/PRACTICAL_CERTIFICATE_NOT_ISSUED/);
  });

  it('revocation requires a typed reason', () => {
    expect(() => revokePracticalRecoveryCertificate(issue(), 'because' as never, ISSUED_AT)).toThrow(/typed invalidation reason/);
  });
});

// STAGE-1B TEST PLAN (the invariant is documented in certificate.ts; Stage 1A has no persistence):
//   - persist each issued certificate under a UNIQUE durable certificateId with a durable status;
//   - two concurrent lease attempts for one certificateId (even from two in-memory objects, or two
//     processes) -> exactly one ISSUED -> CONSUMED compare-and-set wins, inside the same transaction
//     that takes the fence's mutation lease / dispatch claim; the other is refused and dispatches nothing;
//   - a restart that re-materializes an in-memory certificate from a CONSUMED row cannot consume it again.
// No process-global in-memory registry may stand in for that row.
describe('Stage-1B invariant: the in-memory one-shot is NOT the final authority', () => {
  it('two in-memory objects can carry the same certificateId, each with its own in-memory termination', () => {
    const first = issue();
    const second = issue();
    expect(second).not.toBe(first);
    expect(second.certificateId).toBe(first.certificateId);
    consumePracticalRecoveryCertificate(first, BINDINGS, ISSUED_AT + 1, 'lease-1');
    // In memory, the second object is still ISSUED. Only the Stage-1B durable
    // UNIQUE certificate row can make "at most one lease wins" true.
    expect(PracticalRecoveryCertificate.status(second)).toBe('ISSUED');
  });

  it('the module keeps no process-global certificate registry', () => {
    expect(Object.keys(certificateModule).filter((name) => /registry|store|cache|seen/i.test(name))).toEqual([]);
  });
});

describe('no renewal exists', () => {
  it('neither the module, the barrel, nor the certificate exposes a renew/extend/refresh operation', () => {
    const names = [
      ...Object.keys(certificateModule),
      ...Object.keys(practical),
      ...Object.getOwnPropertyNames(PracticalRecoveryCertificate),
      ...Object.getOwnPropertyNames(PracticalRecoveryCertificate.prototype),
    ];
    expect(names.filter((name) => /renew|extend|refresh|reissue|prolong/i.test(name))).toEqual([]);
  });

  it('the expiry is fixed at issuance', () => {
    const certificate = issue();
    const before = certificate.expiresAtMs;
    verifyPracticalRecoveryCertificate(certificate, BINDINGS, ISSUED_AT + 100_000);
    expect(certificate.expiresAtMs).toBe(before);
    expect(PracticalRecoveryCertificate.read(certificate)!.expiresAtMs).toBe(before);
  });
});
