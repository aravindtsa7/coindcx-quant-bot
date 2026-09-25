/**
 * Provider account identity guard (Phase 18, provider-confirmed `coindcx_id`).
 *
 * CoinDCX support has confirmed that `/exchange/v1/users/info`'s `coindcx_id`
 * is a PERMANENT trading-account identifier: it is unchanged across API-key
 * rotation, and every subaccount has a different one. That makes it usable for
 * exactly one question: "do the configured credentials act on the trading
 * account this deployment is bound to, at the instant of the read?"
 *
 * It answers NOTHING else, and the types below say so explicitly:
 *
 *   - it is not account continuity: it says nothing about what happened on the
 *     account between two reads (`currentAccountContinuityCapability()` in
 *     `./barrier.ts` stays the only place continuity is decided, and it is not
 *     reachable from this module);
 *   - it is not a current reconciliation: only a completed, HEALTHY run of the
 *     current runtime epoch is that;
 *   - it is not reconnect continuity: a reconnect to the same account can
 *     still have missed events;
 *   - it is not an API-key generation or credential/session identity: CoinDCX
 *     exposes no authenticated key id, generation, version, or creation time,
 *     and this module does not pretend otherwise. A rotated key on the same
 *     account verifies identically, by design.
 *
 * The raw `coindcx_id` never enters this module's outputs, findings, or logs:
 * the integration adapter reduces it to `providerAccountFingerprint` (SHA-256
 * hex of its exact UTF-8 bytes) at the boundary, and only fingerprints are
 * compared. The expected fingerprint comes from application configuration
 * via the live enablement gate, never from a per-request caller input.
 */
import { createHash } from 'node:crypto';
import { sha256CanonicalJson } from '../../../risk';
import { LiveExecutionError } from '../errors';
import { buildFinding } from './findings';
import type { LiveReconciliationFinding } from './types';

/** Lowercase 64-hex SHA-256. The only accepted representation of a provider account identity. */
export const LIVE_PROVIDER_ACCOUNT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export function isProviderAccountFingerprint(value: unknown): value is string {
  return typeof value === 'string' && LIVE_PROVIDER_ACCOUNT_FINGERPRINT_PATTERN.test(value);
}

/**
 * Fingerprint of one provider trading-account identifier: SHA-256 hex over the
 * exact UTF-8 bytes, with NO normalization (no trim, no case folding), so two
 * identifiers that differ in any byte can never compare equal. This is the
 * same digest the read-only provider probe reports as the `coindcx_id`
 * SHA-256, so an operator can bind a deployment from that report without ever
 * handling the raw identifier.
 */
export function providerAccountFingerprint(providerAccountIdentifier: string): string {
  if (typeof providerAccountIdentifier !== 'string' || providerAccountIdentifier.length === 0) {
    throw new LiveExecutionError('LIVE_RECONCILIATION_EVIDENCE_INVALID', 'A provider account identifier must be a non-empty string');
  }
  return createHash('sha256').update(providerAccountIdentifier, 'utf8').digest('hex');
}

/** What the evidence provider observed. Fingerprint only; the raw identifier stays at the integration boundary. */
export type LiveProviderAccountIdentityRead =
  | { readonly kind: 'OBSERVED'; readonly fingerprint: string }
  /** The identity could not be read, was missing/empty, or had an unexpected cardinality. */
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

/**
 * A successful verification, with everything it does NOT prove spelled out as
 * `false` literals, so no consumer can read more into it than it carries.
 */
export interface LiveProviderAccountIdentityVerified {
  readonly kind: 'ACCOUNT_IDENTITY_VERIFIED';
  /** The credentials acted on the configured provider trading account when the identity was read. */
  readonly scope: 'PROVIDER_TRADING_ACCOUNT_AT_READ_TIME';
  readonly provesAccountContinuity: false;
  readonly provesCurrentReconciliation: false;
  readonly provesReconnectContinuity: false;
  readonly provesCredentialGeneration: false;
}

export type LiveProviderAccountIdentityVerification =
  | LiveProviderAccountIdentityVerified
  /** The credentials act on a DIFFERENT provider trading account (e.g. another subaccount). */
  | { readonly kind: 'ACCOUNT_IDENTITY_MISMATCH'; readonly expectedFingerprintPrefix: string; readonly observedFingerprintPrefix: string }
  /** Identity could not be established. Fails closed exactly like a mismatch, but is retryable. */
  | { readonly kind: 'ACCOUNT_IDENTITY_UNVERIFIED'; readonly reason: string };

/** Fingerprint prefix length recorded in findings: enough for an operator to tell bindings apart. */
const FINGERPRINT_PREFIX_CHARS = 12;

const VERIFIED: LiveProviderAccountIdentityVerified = Object.freeze({
  kind: 'ACCOUNT_IDENTITY_VERIFIED' as const,
  scope: 'PROVIDER_TRADING_ACCOUNT_AT_READ_TIME' as const,
  provesAccountContinuity: false as const,
  provesCurrentReconciliation: false as const,
  provesReconnectContinuity: false as const,
  provesCredentialGeneration: false as const,
});

/** Throws unless `value` is a well-formed configured fingerprint. Used at construction time. */
export function requireExpectedProviderAccountFingerprint(value: unknown): string {
  if (!isProviderAccountFingerprint(value)) {
    throw new LiveExecutionError('LIVE_EXECUTION_DISABLED', 'The expected provider account fingerprint must be a lowercase 64-hex SHA-256 from application configuration');
  }
  return value;
}

/**
 * Pure comparison. Exact string equality of two validated fingerprints; there
 * is no partial, prefix, or case-insensitive match. Every non-verified outcome
 * blocks the reconciliation run that asked.
 */
export function verifyProviderAccountIdentity(
  expectedFingerprint: string,
  read: LiveProviderAccountIdentityRead,
): LiveProviderAccountIdentityVerification {
  if (!isProviderAccountFingerprint(expectedFingerprint)) {
    return Object.freeze({ kind: 'ACCOUNT_IDENTITY_UNVERIFIED' as const, reason: 'EXPECTED_FINGERPRINT_INVALID' });
  }
  if (read.kind !== 'OBSERVED') {
    return Object.freeze({ kind: 'ACCOUNT_IDENTITY_UNVERIFIED' as const, reason: read.kind === 'UNAVAILABLE' ? read.reason : 'IDENTITY_READ_INVALID' });
  }
  if (!isProviderAccountFingerprint(read.fingerprint)) {
    return Object.freeze({ kind: 'ACCOUNT_IDENTITY_UNVERIFIED' as const, reason: 'OBSERVED_FINGERPRINT_INVALID' });
  }
  if (read.fingerprint !== expectedFingerprint) {
    return Object.freeze({
      kind: 'ACCOUNT_IDENTITY_MISMATCH' as const,
      expectedFingerprintPrefix: expectedFingerprint.slice(0, FINGERPRINT_PREFIX_CHARS),
      observedFingerprintPrefix: read.fingerprint.slice(0, FINGERPRINT_PREFIX_CHARS),
    });
  }
  return VERIFIED;
}

/** The blocking finding for a failed verification, or `null` when verified. */
export function accountIdentityFinding(verification: LiveProviderAccountIdentityVerification): LiveReconciliationFinding | null {
  switch (verification.kind) {
    case 'ACCOUNT_IDENTITY_VERIFIED':
      return null;
    case 'ACCOUNT_IDENTITY_MISMATCH':
      return buildFinding({
        category: 'MANUAL_REVIEW_REQUIRED',
        code: 'RECON_ACCOUNT_IDENTITY_MISMATCH',
        evidence: {
          reason: 'The configured credentials act on a different provider trading account than this deployment is bound to; nothing was read or changed',
          expectedFingerprintPrefix: verification.expectedFingerprintPrefix,
          observedFingerprintPrefix: verification.observedFingerprintPrefix,
        },
      });
    case 'ACCOUNT_IDENTITY_UNVERIFIED':
      return buildFinding({
        category: 'AMBIGUOUS',
        code: 'RECON_ACCOUNT_IDENTITY_UNVERIFIED',
        evidence: {
          reason: 'The provider trading-account identity could not be verified; nothing was read or changed',
          failure: verification.reason,
        },
      });
    default:
      return buildFinding({
        category: 'AMBIGUOUS',
        code: 'RECON_ACCOUNT_IDENTITY_UNVERIFIED',
        evidence: { reason: 'Unknown identity verification outcome', failure: 'UNKNOWN' },
      });
  }
}

/** Deterministic snapshot identity recorded for a run that stopped at the identity gate. */
export function accountIdentityGateSnapshotSha256(verification: LiveProviderAccountIdentityVerification): string {
  return sha256CanonicalJson({
    schema: 'P18_ACCOUNT_IDENTITY_GATE_V1',
    outcome: verification.kind,
    failure: verification.kind === 'ACCOUNT_IDENTITY_UNVERIFIED' ? verification.reason : null,
  });
}
