/**
 * Phase 18B practical recovery certificate (Stage 1A).
 *
 * A `PracticalRecoveryCertificate` records that a practical certification
 * completed for one account under one runtime epoch, one reconciliation
 * generation, and one private-stream incarnation, over one evidence digest.
 * It is PRACTICAL recovery evidence, never account continuity:
 * `basis` is literally `'PRACTICAL_RECOVERY'`, `provesAccountContinuity` is
 * literally `false`, and nothing here converts to, bridges to, or names the
 * Phase 18 strict continuity capability.
 *
 * Lifecycle: ISSUED -> CONSUMED | EXPIRED | REVOKED. All three are terminal.
 *   - ONE-SHOT: the first mutation lease consumes it. The mutation's later
 *     outcome (success, rejection, ambiguity, duplicate, or pre-dispatch
 *     failure) never restores it.
 *   - NON-RENEWABLE: the absolute expiry is fixed at issuance; there is no
 *     renew, extend, or refresh operation anywhere in this module.
 *   - NON-FORGEABLE: private-slot state, module-private issuer object, frozen
 *     prototype; clones, structural look-alikes, and prototype-only objects are
 *     rejected.
 *
 * STAGE-1B INVARIANT (documented here, NOT implemented in Stage 1A):
 * the in-memory `#termination` below is NOT the final one-shot authority once
 * persistence exists. Two in-memory objects can carry the same
 * `certificateId` (the id is a deterministic digest of the issuance inputs),
 * and each has its own `#termination`. Stage 1B MUST therefore:
 *   - persist every issued certificate under a UNIQUE durable certificateId
 *     with a durable status;
 *   - move that durable status ISSUED -> CONSUMED atomically, as a
 *     compare-and-set conditioned on ISSUED, INSIDE THE SAME TRANSACTION that
 *     takes the account fence's mutation lease / dispatch claim;
 *   - treat that durable row, not this object, as the arbiter: however many
 *     in-memory objects share a certificateId, at most one mutation lease can
 *     win it.
 * This must NOT be solved with a process-global in-memory registry, which a
 * second process or a restart would not share.
 *
 * Issuance (`issuePracticalRecoveryCertificate`) is deliberately NOT exported
 * from the practical barrel. In Stage 1A nothing in `src/` imports it; an
 * architecture test pins its importers so that only the future recovery
 * service can be added, by review.
 */
import { sha256CanonicalJson } from '../../../risk';
import { isProviderAccountFingerprint } from '../reconciliation/account-identity';
import { requirePracticalLiveSafetyEnablement } from './policy';
import {
  PRACTICAL_AUTHORIZATION_BASIS,
  PRACTICAL_DIGEST_PATTERN,
  PracticalLiveSafetyError,
  isExactId,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isPracticalInvalidationReason,
  type PracticalAuthorizationBasis,
  type PracticalInvalidationReason,
} from './types';

export type PracticalCertificateStatus = 'ISSUED' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';

/** The bindings every use of a certificate must match exactly. */
export interface PracticalCertificateBindings {
  readonly accountId: string;
  readonly providerAccountFingerprint: string;
  readonly runtimeEpoch: string;
  readonly reconciliationGeneration: number;
  readonly streamIncarnation: number;
}

/** Summary of the certification evidence, checked against the policy ceilings at issuance. */
export interface PracticalCertificationEvidenceSummary {
  /** Digest over the certifying passes' evidence (lowercase 64-hex). */
  readonly evidenceDigest: string;
  readonly passCount: number;
  /** First certifying pass start to last certifying pass end, local monotonic ms. */
  readonly certificationSpanMs: number;
  /** Smallest spacing observed between consecutive passes, local ms. */
  readonly minimumObservedPassSpacingMs: number;
}

export interface PracticalRecoveryCertificateRecord extends PracticalCertificateBindings {
  readonly certificateId: string;
  readonly evidenceDigest: string;
  readonly issuedAtMs: number;
  /** Absolute. Fixed at issuance; never extended. */
  readonly expiresAtMs: number;
  readonly basis: PracticalAuthorizationBasis;
  readonly provesAccountContinuity: false;
}

export interface PracticalCertificateTermination {
  readonly status: Exclude<PracticalCertificateStatus, 'ISSUED'>;
  readonly atMs: number;
  /** The lease that consumed it, when CONSUMED. */
  readonly leaseId: string | null;
  /** The invalidation reason, when REVOKED; CERTIFICATE_EXPIRED when EXPIRED. */
  readonly reason: PracticalInvalidationReason | null;
}

const CERTIFICATE_ISSUER = Object.freeze({ purpose: 'p18b-practical-recovery-certificate' });

export class PracticalRecoveryCertificate {
  readonly #record: PracticalRecoveryCertificateRecord;
  #termination: PracticalCertificateTermination | null = null;

  public constructor(issuer: unknown, record: PracticalRecoveryCertificateRecord) {
    if (issuer !== CERTIFICATE_ISSUER) {
      throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'A practical recovery certificate may only be issued by the practical certification path');
    }
    this.#record = Object.freeze({ ...record, basis: PRACTICAL_AUTHORIZATION_BASIS, provesAccountContinuity: false as const });
    Object.freeze(this);
  }

  /** The immutable record of a GENUINE certificate, or null for clones and structural fakes. */
  public static read(value: unknown): PracticalRecoveryCertificateRecord | null {
    if (!(value instanceof PracticalRecoveryCertificate)) return null;
    try {
      return value.#record;
    } catch {
      return null;
    }
  }

  /** Current lifecycle status of a genuine certificate. */
  public static status(value: PracticalRecoveryCertificate): PracticalCertificateStatus {
    return value.#termination === null ? 'ISSUED' : value.#termination.status;
  }

  public static termination(value: PracticalRecoveryCertificate): PracticalCertificateTermination | null {
    return value.#termination;
  }

  /** Internal terminal transition. Only ISSUED can move; every terminal state is final. */
  static #terminate(value: PracticalRecoveryCertificate, termination: PracticalCertificateTermination): void {
    if (value.#termination !== null) {
      throw new PracticalLiveSafetyError('PRACTICAL_CERTIFICATE_NOT_ISSUED', 'The certificate is no longer ISSUED', {
        certificateId: value.#record.certificateId,
        status: value.#termination.status,
      });
    }
    value.#termination = Object.freeze({ ...termination });
  }

  /** Module-internal entry used by the exported lifecycle functions below. */
  public static applyTermination(issuer: unknown, value: PracticalRecoveryCertificate, termination: PracticalCertificateTermination): void {
    if (issuer !== CERTIFICATE_ISSUER) {
      throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'Certificate lifecycle changes are internal to the practical certificate module');
    }
    PracticalRecoveryCertificate.#terminate(value, termination);
  }

  public get certificateId(): string { return this.#record.certificateId; }
  public get basis(): PracticalAuthorizationBasis { return this.#record.basis; }
  public get provesAccountContinuity(): false { return false; }
  public get expiresAtMs(): number { return this.#record.expiresAtMs; }
}
Object.freeze(PracticalRecoveryCertificate.prototype);
Object.freeze(PracticalRecoveryCertificate);

function invalid(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new PracticalLiveSafetyError('PRACTICAL_CERTIFICATE_INVALID', message, details);
}

function assertBindings(bindings: PracticalCertificateBindings): void {
  if (!isExactId(bindings.accountId)) invalid('accountId must be a non-empty exact string');
  if (!isProviderAccountFingerprint(bindings.providerAccountFingerprint)) invalid('providerAccountFingerprint must be a lowercase 64-hex fingerprint');
  if (!isExactId(bindings.runtimeEpoch)) invalid('runtimeEpoch must be a non-empty exact string');
  if (!isPositiveSafeInteger(bindings.reconciliationGeneration)) invalid('reconciliationGeneration must be a positive safe integer');
  if (!isPositiveSafeInteger(bindings.streamIncarnation)) invalid('streamIncarnation must be a positive safe integer');
}

/**
 * Issues a certificate. Requires a genuine configuration-issued Tier-B
 * enablement that permits the account, and evidence that meets every policy
 * ceiling (pass count, span, spacing). The expiry is `issuedAtMs +` the
 * enablement's (possibly tightened) absolute lifetime and is never extended.
 */
export function issuePracticalRecoveryCertificate(input: {
  readonly enablement: unknown;
  readonly bindings: PracticalCertificateBindings;
  readonly evidence: PracticalCertificationEvidenceSummary;
  readonly issuedAtMs: number;
}): PracticalRecoveryCertificate {
  const enablement = requirePracticalLiveSafetyEnablement(input.enablement);
  assertBindings(input.bindings);
  if (!enablement.accountAllowlist.includes(input.bindings.accountId)) {
    throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'Tier B is not enabled for this account');
  }
  const { evidence } = input;
  if (typeof evidence.evidenceDigest !== 'string' || !PRACTICAL_DIGEST_PATTERN.test(evidence.evidenceDigest)) {
    invalid('evidenceDigest must be a lowercase 64-hex digest');
  }
  const ceilings = enablement.ceilings;
  if (!isPositiveSafeInteger(evidence.passCount) || evidence.passCount < ceilings.minimumPasses) {
    invalid('Too few certifying passes for the policy', { passCount: evidence.passCount, minimumPasses: ceilings.minimumPasses });
  }
  if (!isNonNegativeSafeInteger(evidence.certificationSpanMs) || evidence.certificationSpanMs < ceilings.minimumCertificationSpanMs) {
    invalid('Certification span is shorter than the policy minimum', { minimumCertificationSpanMs: ceilings.minimumCertificationSpanMs });
  }
  if (!isNonNegativeSafeInteger(evidence.minimumObservedPassSpacingMs) || evidence.minimumObservedPassSpacingMs < ceilings.minimumPassSpacingMs) {
    invalid('Certifying passes were closer together than the policy minimum', { minimumPassSpacingMs: ceilings.minimumPassSpacingMs });
  }
  if (!isNonNegativeSafeInteger(input.issuedAtMs)) invalid('issuedAtMs must be a non-negative safe integer');
  const expiresAtMs = input.issuedAtMs + ceilings.certificateLifetimeMs;
  if (!Number.isSafeInteger(expiresAtMs)) invalid('expiresAtMs overflowed');

  const certificateId = sha256CanonicalJson({
    schema: 'P18B_PRACTICAL_RECOVERY_CERTIFICATE_V1',
    accountId: input.bindings.accountId,
    providerAccountFingerprint: input.bindings.providerAccountFingerprint,
    runtimeEpoch: input.bindings.runtimeEpoch,
    reconciliationGeneration: input.bindings.reconciliationGeneration,
    streamIncarnation: input.bindings.streamIncarnation,
    evidenceDigest: evidence.evidenceDigest,
    issuedAtMs: input.issuedAtMs,
  });
  return new PracticalRecoveryCertificate(CERTIFICATE_ISSUER, {
    certificateId,
    accountId: input.bindings.accountId,
    providerAccountFingerprint: input.bindings.providerAccountFingerprint,
    runtimeEpoch: input.bindings.runtimeEpoch,
    reconciliationGeneration: input.bindings.reconciliationGeneration,
    streamIncarnation: input.bindings.streamIncarnation,
    evidenceDigest: evidence.evidenceDigest,
    issuedAtMs: input.issuedAtMs,
    expiresAtMs,
    basis: PRACTICAL_AUTHORIZATION_BASIS,
    provesAccountContinuity: false,
  });
}

function requireGenuine(value: unknown): { readonly certificate: PracticalRecoveryCertificate; readonly record: PracticalRecoveryCertificateRecord } {
  const record = PracticalRecoveryCertificate.read(value);
  if (record === null) {
    throw new PracticalLiveSafetyError('PRACTICAL_AUTHORITY_INVALID', 'Not a genuine practical recovery certificate');
  }
  return { certificate: value as PracticalRecoveryCertificate, record };
}

/**
 * Verifies a certificate for use RIGHT NOW. Checks, in order: genuine, still
 * ISSUED, a well-formed time, a time NOT BEFORE issuance, not expired, and
 * every binding exactly equal. Returns the immutable record; grants nothing.
 *
 * The valid window is exactly `issuedAtMs <= nowMs < expiresAtMs`. The
 * supplied time is never clamped:
 *   - a time before issuance means a backward or inconsistent clock. The
 *     certificate is revoked with CLOCK_ANOMALY and the use refused;
 *   - a time at or after expiry terminates the certificate as EXPIRED and
 *     the use is refused.
 * Both outcomes are terminal, so a refused certificate can never be used
 * later.
 */
export function verifyPracticalRecoveryCertificate(
  value: unknown,
  expected: PracticalCertificateBindings,
  nowMs: number,
): PracticalRecoveryCertificateRecord {
  const { certificate, record } = requireGenuine(value);
  const status = PracticalRecoveryCertificate.status(certificate);
  if (status !== 'ISSUED') {
    throw new PracticalLiveSafetyError('PRACTICAL_CERTIFICATE_NOT_ISSUED', 'The certificate is no longer ISSUED', { certificateId: record.certificateId, status });
  }
  if (!isNonNegativeSafeInteger(nowMs)) {
    throw new PracticalLiveSafetyError('PRACTICAL_CERTIFICATE_INVALID', 'nowMs must be a non-negative safe integer');
  }
  if (nowMs < record.issuedAtMs) {
    PracticalRecoveryCertificate.applyTermination(CERTIFICATE_ISSUER, certificate, { status: 'REVOKED', atMs: nowMs, leaseId: null, reason: 'CLOCK_ANOMALY' });
    throw new PracticalLiveSafetyError('PRACTICAL_CERTIFICATE_BEFORE_ISSUANCE', 'The supplied time is earlier than the certificate issuance', {
      certificateId: record.certificateId,
    });
  }
  if (nowMs >= record.expiresAtMs) {
    PracticalRecoveryCertificate.applyTermination(CERTIFICATE_ISSUER, certificate, { status: 'EXPIRED', atMs: nowMs, leaseId: null, reason: 'CERTIFICATE_EXPIRED' });
    throw new PracticalLiveSafetyError('PRACTICAL_CERTIFICATE_EXPIRED', 'The certificate has expired', { certificateId: record.certificateId });
  }
  const mismatched = (['accountId', 'providerAccountFingerprint', 'runtimeEpoch', 'reconciliationGeneration', 'streamIncarnation'] as const)
    .filter((key) => record[key] !== expected[key]);
  if (mismatched.length > 0) {
    throw new PracticalLiveSafetyError('PRACTICAL_CERTIFICATE_BINDING_MISMATCH', 'The certificate is bound to a different context', {
      certificateId: record.certificateId,
      mismatched,
    });
  }
  return record;
}

/**
 * Consumes a certificate for exactly one mutation lease. After this, the
 * certificate is CONSUMED forever, whatever the mutation's outcome.
 */
export function consumePracticalRecoveryCertificate(
  value: unknown,
  expected: PracticalCertificateBindings,
  nowMs: number,
  leaseId: string,
): PracticalCertificateTermination {
  if (!isExactId(leaseId)) {
    throw new PracticalLiveSafetyError('PRACTICAL_CERTIFICATE_INVALID', 'leaseId must be a non-empty exact string');
  }
  verifyPracticalRecoveryCertificate(value, expected, nowMs);
  const certificate = value as PracticalRecoveryCertificate;
  PracticalRecoveryCertificate.applyTermination(CERTIFICATE_ISSUER, certificate, { status: 'CONSUMED', atMs: nowMs, leaseId, reason: null });
  return PracticalRecoveryCertificate.termination(certificate)!;
}

/**
 * Revokes an ISSUED certificate for a typed reason. Revoking a certificate that
 * is already terminal is a no-op (it can never become usable again) and
 * returns its existing termination.
 */
export function revokePracticalRecoveryCertificate(
  value: unknown,
  reason: PracticalInvalidationReason,
  nowMs: number,
): PracticalCertificateTermination {
  const { certificate } = requireGenuine(value);
  if (!isPracticalInvalidationReason(reason)) {
    throw new PracticalLiveSafetyError('PRACTICAL_CERTIFICATE_INVALID', 'Revocation requires a typed invalidation reason');
  }
  if (!isNonNegativeSafeInteger(nowMs)) {
    throw new PracticalLiveSafetyError('PRACTICAL_CERTIFICATE_INVALID', 'nowMs must be a non-negative safe integer');
  }
  const existing = PracticalRecoveryCertificate.termination(certificate);
  if (existing !== null) return existing;
  PracticalRecoveryCertificate.applyTermination(CERTIFICATE_ISSUER, certificate, { status: 'REVOKED', atMs: nowMs, leaseId: null, reason });
  return PracticalRecoveryCertificate.termination(certificate)!;
}
