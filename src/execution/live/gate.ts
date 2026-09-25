/**
 * Live-execution enablement gate (P17-I04).
 *
 * Live order mutation is DISABLED unless application configuration explicitly,
 * unambiguously enables it. Every other outcome — an absent variable, a
 * malformed value, an unknown environment, an empty allowlist, or missing
 * credentials — fails closed with a named reason. There is no boolean short
 * circuit, no default-on branch, and no way to enable live mutation by passing
 * a flag at a call site: the only input is the configuration record.
 *
 * The ENABLED outcome is a symbol-minted class instance, not a plain object, so
 * downstream code cannot be handed a fabricated `{ status: 'ENABLED' }`
 * literal in place of a genuine gate resolution.
 */
import { canonicalPositiveLiveDecimal } from './decimal';
import { LiveExecutionError } from './errors';
import { isProviderAccountFingerprint } from './reconciliation/account-identity';

export type LiveExecutionDisabledReason =
  | 'NOT_EXPLICITLY_ENABLED'
  | 'MALFORMED_ENABLE_FLAG'
  | 'UNSUPPORTED_ENVIRONMENT'
  | 'MISSING_CREDENTIALS'
  | 'MISSING_CREDENTIAL_ACCOUNT_ID'
  /** No configured provider trading-account binding (`COINDCX_EXPECTED_ACCOUNT_FINGERPRINT`). */
  | 'MISSING_ACCOUNT_IDENTITY_BINDING'
  /** The configured binding is not a lowercase 64-hex SHA-256 fingerprint. */
  | 'MALFORMED_ACCOUNT_IDENTITY_BINDING'
  | 'EMPTY_ACCOUNT_ALLOWLIST'
  | 'EMPTY_PAIR_ALLOWLIST'
  | 'MALFORMED_NOTIONAL_CEILING';

export interface LiveExecutionEnablementRecord {
  readonly accountAllowlist: readonly string[];
  readonly pairAllowlist: readonly string[];
  /** Exact Decimal string. Feeds the live execution policy's notional ceiling. */
  readonly maxOrderNotionalInr: string;
  /** Trusted configured boundary for the account owned by these credentials. */
  readonly credentialAccountId: string;
  /**
   * The provider trading account this deployment is bound to: SHA-256 hex of
   * the expected users/info `coindcx_id` (the raw identifier is never
   * configured). Verified against the live credentials at the start of every
   * reconciliation run. It identifies an ACCOUNT only — CoinDCX exposes no API
   * key id or generation, so it cannot distinguish rotated keys, and it
   * authorizes nothing by itself.
   */
  readonly expectedProviderAccountFingerprint: string;
  readonly environment: 'production';
}

const ENABLEMENT_ISSUER = Symbol('P17 live execution enablement issuer');

/** Non-forgeable proof that configuration genuinely enabled live mutation. */
export class LiveExecutionEnablement {
  readonly #record: LiveExecutionEnablementRecord;

  public constructor(issuer: symbol, record: LiveExecutionEnablementRecord) {
    if (issuer !== ENABLEMENT_ISSUER) {
      throw new LiveExecutionError('LIVE_EXECUTION_DISABLED', 'Only the genuine configuration gate may issue live execution enablement');
    }
    this.#record = Object.freeze({
      ...record,
      accountAllowlist: Object.freeze([...record.accountAllowlist]),
      pairAllowlist: Object.freeze([...record.pairAllowlist]),
    });
    Object.freeze(this);
  }

  public static read(value: unknown): LiveExecutionEnablementRecord | null {
    return value !== null && typeof value === 'object' && #record in value ? value.#record : null;
  }

  public permitsAccount(accountId: string): boolean {
    return this.#record.accountAllowlist.includes(accountId);
  }

  public permitsPair(pair: string): boolean {
    return this.#record.pairAllowlist.includes(pair);
  }

  public get maxOrderNotionalInr(): string {
    return this.#record.maxOrderNotionalInr;
  }

  public get credentialAccountId(): string {
    return this.#record.credentialAccountId;
  }

  public get expectedProviderAccountFingerprint(): string {
    return this.#record.expectedProviderAccountFingerprint;
  }
}
Object.freeze(LiveExecutionEnablement.prototype);
Object.freeze(LiveExecutionEnablement);

export type LiveExecutionGateResolution =
  | { readonly status: 'DISABLED'; readonly reason: LiveExecutionDisabledReason }
  | { readonly status: 'ENABLED'; readonly enablement: LiveExecutionEnablement };

/** Exactly the configuration keys the gate reads. Nothing else can influence it. */
export interface LiveExecutionConfigInput {
  readonly NODE_ENV?: string | undefined;
  readonly LIVE_EXECUTION_ENABLED?: string | undefined;
  readonly LIVE_EXECUTION_ACCOUNT_ALLOWLIST?: string | undefined;
  readonly LIVE_EXECUTION_PAIR_ALLOWLIST?: string | undefined;
  readonly LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR?: string | undefined;
  readonly COINDCX_API_KEY?: string | undefined;
  readonly COINDCX_API_SECRET?: string | undefined;
  readonly COINDCX_LIVE_ACCOUNT_ID?: string | undefined;
  readonly COINDCX_EXPECTED_ACCOUNT_FINGERPRINT?: string | undefined;
}

function disabled(reason: LiveExecutionDisabledReason): LiveExecutionGateResolution {
  return Object.freeze({ status: 'DISABLED' as const, reason });
}

function parseList(raw: string | undefined): readonly string[] {
  if (typeof raw !== 'string') return Object.freeze([]);
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return Object.freeze([...new Set(entries)].sort());
}

/**
 * The sole live-enablement decision. Pure: no process state, no wall clock, no
 * filesystem. `process.env` reaches it only because a caller passes it in.
 */
export function resolveLiveExecutionGate(config: LiveExecutionConfigInput): LiveExecutionGateResolution {
  const rawFlag = config.LIVE_EXECUTION_ENABLED;
  if (rawFlag === undefined || rawFlag === '' || rawFlag === 'false') return disabled('NOT_EXPLICITLY_ENABLED');
  // Only the exact lowercase literal enables. 'TRUE', '1', 'yes', ' true ' and
  // any other near-miss are malformed, never a silent enable.
  if (rawFlag !== 'true') return disabled('MALFORMED_ENABLE_FLAG');

  if (config.NODE_ENV !== 'production') return disabled('UNSUPPORTED_ENVIRONMENT');

  const apiKey = config.COINDCX_API_KEY;
  const apiSecret = config.COINDCX_API_SECRET;
  if (typeof apiKey !== 'string' || apiKey.trim() === '' || typeof apiSecret !== 'string' || apiSecret.trim() === '') {
    return disabled('MISSING_CREDENTIALS');
  }

  const credentialAccountId = config.COINDCX_LIVE_ACCOUNT_ID;
  if (typeof credentialAccountId !== 'string' || credentialAccountId.trim() === '' || credentialAccountId.trim() !== credentialAccountId) {
    return disabled('MISSING_CREDENTIAL_ACCOUNT_ID');
  }

  // The provider account binding is mandatory: without it no run could ever
  // verify WHICH trading account the credentials act on. Exact lowercase hex
  // only — no trimming or case folding that could make two bindings compare
  // equal.
  const expectedProviderAccountFingerprint = config.COINDCX_EXPECTED_ACCOUNT_FINGERPRINT;
  if (typeof expectedProviderAccountFingerprint !== 'string' || expectedProviderAccountFingerprint === '') {
    return disabled('MISSING_ACCOUNT_IDENTITY_BINDING');
  }
  if (!isProviderAccountFingerprint(expectedProviderAccountFingerprint)) return disabled('MALFORMED_ACCOUNT_IDENTITY_BINDING');

  const accountAllowlist = parseList(config.LIVE_EXECUTION_ACCOUNT_ALLOWLIST);
  if (accountAllowlist.length === 0) return disabled('EMPTY_ACCOUNT_ALLOWLIST');
  if (!accountAllowlist.includes(credentialAccountId)) return disabled('MISSING_CREDENTIAL_ACCOUNT_ID');

  const pairAllowlist = parseList(config.LIVE_EXECUTION_PAIR_ALLOWLIST);
  if (pairAllowlist.length === 0) return disabled('EMPTY_PAIR_ALLOWLIST');

  let maxOrderNotionalInr: string;
  try {
    maxOrderNotionalInr = canonicalPositiveLiveDecimal(config.LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR, 'LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR');
  } catch {
    return disabled('MALFORMED_NOTIONAL_CEILING');
  }

  return Object.freeze({
    status: 'ENABLED' as const,
    enablement: new LiveExecutionEnablement(ENABLEMENT_ISSUER, {
      accountAllowlist,
      pairAllowlist,
      maxOrderNotionalInr,
      credentialAccountId,
      expectedProviderAccountFingerprint,
      environment: 'production',
    }),
  });
}

/**
 * Convenience assertion for a call site that must not proceed while live
 * mutation is disabled. Throws the named Phase17 code rather than returning.
 */
export function requireLiveExecutionEnabled(config: LiveExecutionConfigInput): LiveExecutionEnablement {
  const resolution = resolveLiveExecutionGate(config);
  if (resolution.status === 'DISABLED') {
    throw new LiveExecutionError('LIVE_EXECUTION_DISABLED', 'Live order mutation is disabled by application configuration', {
      details: { reason: resolution.reason },
    });
  }
  return resolution.enablement;
}
