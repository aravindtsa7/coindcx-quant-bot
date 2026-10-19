/**
 * M4 offline ownership-lineage DIAGNOSTIC (restricted candidate D1-D4 of `docs/M4_OWNERSHIP_LINEAGE_EXPORT_PLAN.md`).
 *
 * A pure transformer over INJECTED snapshot rows. It reads no database, clock, environment or credential and is
 * composed nowhere. Its result is a distinct diagnostic type, never a `SyncLineage`, and there is deliberately no
 * conversion: the M4 engine treats ANY supplied lineage object as available (removing
 * `OWNERSHIP_LINEAGE_UNAVAILABLE`), so M4 runs keep `{ kind: 'UNAVAILABLE' }`.
 *
 * Classification (plan §3), with D1-D4 applied:
 *   - owned orders, closed intent tags and owned positions are EMPTY BY POLICY (D4, D2, D3). Nothing here infers
 *     create-response provenance, and no tag, quantity, id or intent existence establishes ownership;
 *   - a null-id `SUBMISSION_AMBIGUOUS`, or wire-armed `DISPATCH_RESERVED`, order is an ambiguous-create CANDIDATE,
 *     diagnostic evidence only; reconciliation-resolved orders never are (D1);
 *   - every other row is kept as `excluded`, `omitted` or `conflicts` with a fixed reason, never dropped;
 *   - only a finding that names the intent classifies it. An exchange-id-only finding is correlation, reported
 *     separately, and never a classification or provenance input.
 *
 * Any malformed row, scope violation or uniqueness/integrity contradiction REFUSES the whole diagnostic (no partial
 * success). Every supplied field is read exactly once and validated before use. Results carry fixed reasons,
 * allowlisted fields and taxonomy finding codes only (an unknown code is reported as `UNRECOGNIZED_FINDING_CODE`).
 */
import { sha256CanonicalJson } from '../../risk';
import { canonicalPositiveLiveDecimal } from './decimal';
import { LIVE_CLIENT_ORDER_ID_PATTERN, LIVE_CLIENT_ORDER_ID_PREFIX } from './identity';
import type { LiveOrderStateName } from './types';

/**
 * The order-view fields this diagnostic needs: a structural subset of the repository's verified listing row
 * (`LiveDurableOrderRow`), declared here because that module's importers are pinned by an architecture guard.
 */
export type LineageDiagnosticOrderRow = Readonly<{
  intentId: string; clientOrderId: string; accountId: string; pair: string; state: LiveOrderStateName; exchangeOrderId: string | null;
  dispatchWireArmed: boolean; side: 'BUY' | 'SELL'; wireOrderType: string; orderedQuantity: string; price: string | null; leverage: string | null;
}>;
/** One `live_reconciliation_finding` row naming an intent and/or an exchange order id. */
export type LineageDiagnosticFindingRow = Readonly<{ accountId: string; intentId: string | null; exchangeOrderId: string | null; code: string }>;
/** One distinct `live_practical_certificate` fingerprint for the account. */
export type LineageDiagnosticCertificateRow = Readonly<{ accountId: string; providerAccountFingerprint: string }>;

export interface OfflineLineageDiagnosticInput {
  /** The local account label every supplied row must carry. */
  readonly accountId: string;
  /** Supplied rows. Synthetic or real, they are checked only as supplied: no transaction consistency is implied. */
  readonly rows: Readonly<{
    orders: readonly LineageDiagnosticOrderRow[];
    findings: readonly LineageDiagnosticFindingRow[];
    certificates: readonly LineageDiagnosticCertificateRow[];
    /** `live_reconciliation_state` for the account, or null when no row was supplied. */
    reconciliationState: Readonly<{ accountId: string; currentGeneration: number; healthyGeneration: number | null }> | null;
    ownershipShareCount: number;
  }>;
  /** Caller/operator statements. None is a verified database fact. */
  readonly statements: Readonly<{
    expectedProviderAccountFingerprint: string;
    campaignExpectedProviderAccountFingerprint: string;
    campaignAccountId: string;
    sourceCommit: string;
    migrationIdentity: Readonly<{ directories: readonly string[]; lockSha256: string }>;
    sourceCoverage: 'ATTESTED' | 'NOT_ATTESTED';
  }>;
}

export type OfflineLineageDiagnosticRefusalReason =
  | 'INPUT_INVALID' | 'ORDER_ROW_INVALID' | 'FINDING_ROW_INVALID' | 'CERTIFICATE_ROW_INVALID' | 'ROW_ACCOUNT_SCOPE_VIOLATION'
  | 'DUPLICATE_INTENT_ID' | 'DUPLICATE_CLIENT_ORDER_ID' | 'WIRE_ARM_STATE_CONTRADICTION'
  | 'ACCOUNT_LABEL_STATEMENT_MISMATCH' | 'FINGERPRINT_STATEMENTS_DISAGREE' | 'CERTIFICATE_FINGERPRINT_MISMATCH';

export type ExcludedReason = 'OWNED_ORDERS_DISABLED' | 'RECONCILIATION_RESOLVED';
export type OmittedReason = 'CLAIM_RELEASED_UNSENT' | 'RESERVATION_UNARMED' | 'VENUE_REFUSED_WITHOUT_SNAPSHOT';
export type ConflictReason =
  | 'UNEXPECTED_STATE_WITHOUT_EXCHANGE_ID' | 'DUPLICATE_EXCHANGE_ORDER_ID' | 'FINDING_INTENT_NOT_IN_SNAPSHOT'
  | 'FINDING_EXCHANGE_ID_HELD_BY_OTHER_INTENT' | 'FINDING_EXCHANGE_ID_DIFFERS_FROM_ORDER' | 'RESOLUTION_FINDING_WITHOUT_EXCHANGE_ID';

/** The persisted Phase 18 finding taxonomy (`LiveReconciliationFindingCode`); a unit test pins it to the union. */
const KNOWN_FINDING_CODES = [
  'RECON_ACCOUNT_IDENTITY_MISMATCH', 'RECON_ACCOUNT_IDENTITY_UNVERIFIED', 'RECON_AMBIGUOUS_CREATE_CLIENT_ORDER_ID_CONFLICT',
  'RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE', 'RECON_AMBIGUOUS_CREATE_MULTIPLE_CANDIDATES', 'RECON_AMBIGUOUS_CREATE_PROVEN_ABSENT',
  'RECON_AMBIGUOUS_CREATE_RESOLVED', 'RECON_AMBIGUOUS_CREATE_RESOLVED_BY_CLIENT_ORDER_ID', 'RECON_AMBIGUOUS_CREATE_UNRESOLVED',
  'RECON_CANCEL_CLAIM_PRACTICALLY_BOUND', 'RECON_CANCEL_RESERVATION_RECLAIMED', 'RECON_CANCEL_RESOLVED_FROM_VENUE', 'RECON_CANCEL_UNRESOLVED',
  'RECON_CLIENT_ORDER_ID_DUPLICATE_AT_VENUE', 'RECON_DISPATCH_RESERVATION_RECLAIMED', 'RECON_EVIDENCE_CAUSALITY_VIOLATION',
  'RECON_EVIDENCE_CONSERVATION_VIOLATION', 'RECON_EVIDENCE_DUPLICATE_CONFLICT', 'RECON_EVIDENCE_IDENTITY_MISMATCH', 'RECON_EVIDENCE_INCOMPLETE',
  'RECON_EVIDENCE_SNAPSHOT_UNSTABLE', 'RECON_ORDER_ABSENCE_UNPROVEN', 'RECON_ORDER_ABSENT_FROM_VENUE', 'RECON_ORDER_ADVANCED_FROM_VENUE',
  'RECON_ORDER_ADVANCE_WITHHELD_INCOMPLETE_EVIDENCE', 'RECON_ORDER_CLIENT_ORDER_ID_CONFLICT', 'RECON_ORDER_ECONOMICS_CONFLICT',
  'RECON_ORDER_FILL_REGRESSION', 'RECON_ORDER_STATE_CONFLICT', 'RECON_ORDER_VERIFIED_MATCH', 'RECON_ORPHAN_CANCEL_AMBIGUOUS',
  'RECON_ORPHAN_CLEANUP_DISABLED', 'RECON_ORPHAN_REAPPEARED_AFTER_RESOLUTION', 'RECON_ORPHAN_VENUE_ORDER', 'RECON_POSITION_DIRECTION_MISMATCH',
  'RECON_POSITION_IDENTITY_MISMATCH', 'RECON_POSITION_LOCAL_OPEN_VENUE_FLAT', 'RECON_POSITION_OWNERSHIP_ESTABLISHED',
  'RECON_POSITION_OWNERSHIP_SHARED', 'RECON_POSITION_OWNERSHIP_SUM_MISMATCH', 'RECON_POSITION_QUANTITY_MISMATCH',
  'RECON_POSITION_UNATTRIBUTED_EXPOSURE', 'RECON_POSITION_VERIFIED_MATCH', 'RECON_PRACTICAL_CANCEL_AMBIGUITY_UNRESOLVED',
  'RECON_PRACTICAL_CANCEL_BINDING_SPLIT',
] as const;
export type LineageDiagnosticFindingCode = (typeof KNOWN_FINDING_CODES)[number];
/** A reported finding code: a taxonomy code, or a fixed marker for a well-formed code outside it (never echoed). */
export type ReportedFindingCode = LineageDiagnosticFindingCode | 'UNRECOGNIZED_FINDING_CODE';

export type AmbiguousCreateCandidate = Readonly<{
  intentId: string; accountId: string; tag: string; pair: string; side: 'BUY' | 'SELL';
  orderedQuantity: string; price: string | null; wireOrderType: string; leverage: string | null; findingCodes: readonly ReportedFindingCode[];
}>;

const NOT_ESTABLISHED = Object.freeze([
  'TRANSACTION_CONSISTENCY', 'SNAPSHOT_ISOLATION_AND_TIME', 'INTENT_CONTENT_HASH_INTEGRITY', 'DATABASE_IDENTITY',
  'DATABASE_APPLIED_MIGRATIONS', 'SOURCE_COVERAGE', 'ORDER_TIME_ACCOUNT_IDENTITY', 'CREATE_RESPONSE_PROVENANCE', 'ACCOUNT_WIDE_ABSENCE',
] as const);
const CHECKS_PERFORMED = Object.freeze([
  'ROW_SHAPES_AND_FORMATS', 'ROW_ACCOUNT_SCOPE', 'UNIQUE_INTENT_IDS', 'UNIQUE_CLIENT_ORDER_IDS', 'WIRE_ARM_STATE_CONSISTENCY',
  'FINDING_ASSOCIATIONS', 'ACCOUNT_LABEL_AGAINST_CAMPAIGN_STATEMENT', 'CERTIFICATE_FINGERPRINTS_AGAINST_STATEMENT',
] as const);

export type OfflineLineageDiagnostic = Readonly<{
  kind: 'OFFLINE_LINEAGE_DIAGNOSTIC';
  use: 'OFFLINE_DIAGNOSTIC_ONLY';
  engineInput: 'NOT_PERMITTED';
  ownershipProof: 'NONE';
  accountId: string;
  policyEmpty: Readonly<{
    ownedOrderLineage: Readonly<{ status: 'EMPTY_BY_POLICY'; decision: 'D4' }>;
    closedIntentTagLineage: Readonly<{ status: 'EMPTY_BY_POLICY'; decision: 'D2' }>;
    ownedPositionLineage: Readonly<{ status: 'EMPTY_BY_POLICY'; decision: 'D3' }>;
  }>;
  ambiguousCreateCandidates: Readonly<{
    status: 'ENTRIES_FOUND' | 'NONE_FOUND_IN_SNAPSHOT';
    scope: 'SUPPLIED_SNAPSHOT_ONLY';
    accountWideAbsence: 'NOT_ESTABLISHED';
    evidenceUse: 'DIAGNOSTIC_ONLY';
    entries: readonly AmbiguousCreateCandidate[];
  }>;
  correlationTagNamespace: typeof LIVE_CLIENT_ORDER_ID_PREFIX;
  diagnostics: Readonly<{
    excluded: readonly Readonly<{ intentId: string; reasons: readonly ExcludedReason[]; findingCodes: readonly ReportedFindingCode[];
      exchangeIdCorrelatedFindingCodes: readonly ReportedFindingCode[] }>[];
    omitted: readonly Readonly<{ intentId: string; reason: OmittedReason; findingCodes: readonly ReportedFindingCode[] }>[];
    conflicts: readonly Readonly<{ reason: ConflictReason; intentIds: readonly string[]; findingCodes: readonly ReportedFindingCode[] }>[];
    unlinkedFindingCodes: readonly Readonly<{ code: ReportedFindingCode; count: number }>[];
    ownershipShareCount: number;
  }>;
  provenance: Readonly<{
    checkedOnSuppliedRows: Readonly<{
      checks: typeof CHECKS_PERFORMED;
      rowCounts: Readonly<{ orders: number; findings: number; certificates: number; ownershipShares: number }>;
      reconciliationGenerations: Readonly<{ current: number; healthy: number | null }> | 'NO_STATE_ROW_SUPPLIED';
      certificateBinding: 'SUPPLIED_CERTIFICATE_ROWS_MATCH_STATEMENT' | 'NO_CERTIFICATE_ROWS_STATEMENT_ONLY';
      accountLabel: 'SUPPLIED_ROWS_MATCH_CAMPAIGN_STATEMENT';
    }>;
    callerStatements: Readonly<{
      sourceCommit: string;
      migrationIdentity: Readonly<{ directories: readonly string[]; lockSha256: string }>;
      expectedFingerprintPrefix: string;
      fingerprintStatements: 'STATEMENTS_AGREE_BINDS_NOTHING';
      sourceCoverage: 'ATTESTED_BY_OPERATOR_UNVERIFIED' | 'NOT_ATTESTED';
    }>;
    notEstablished: typeof NOT_ESTABLISHED;
  }>;
  recordSha256: string;
}>;

export type OfflineLineageDiagnosticResult =
  | OfflineLineageDiagnostic
  | Readonly<{ kind: 'OFFLINE_LINEAGE_DIAGNOSTIC_REFUSED'; reason: OfflineLineageDiagnosticRefusalReason }>;

const ORDER_STATES: ReadonlySet<LiveOrderStateName> = new Set<LiveOrderStateName>([
  'CREATED', 'DISPATCH_RESERVED', 'SUBMISSION_AMBIGUOUS', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED',
  'CANCELLED', 'REJECTED', 'RECONCILIATION_REQUIRED',
]);
const KNOWN_CODES: ReadonlySet<string> = new Set(KNOWN_FINDING_CODES);
const RESOLUTION_CODES: ReadonlySet<string> = new Set<LineageDiagnosticFindingCode>(['RECON_AMBIGUOUS_CREATE_RESOLVED_BY_CLIENT_ORDER_ID', 'RECON_AMBIGUOUS_CREATE_RESOLVED']);
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MIGRATION_DIRECTORY = /^\d{14}_[a-z0-9_]{1,100}$/;
const ACCOUNT = /^[A-Za-z0-9_.:-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const EXCHANGE_ID = /^\S{1,64}$/;

class Refusal extends Error {
  constructor(readonly reason: OfflineLineageDiagnosticRefusalReason) { super(reason); }
}
const refuseIf = (condition: boolean, reason: OfflineLineageDiagnosticRefusalReason): void => { if (condition) throw new Refusal(reason); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** Code-unit order: deterministic and locale-independent. */
const byText = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};
const sortedUnique = <T extends string>(values: Iterable<T>): readonly T[] => Object.freeze([...new Set(values)].sort(byText));
const reported = (code: string): ReportedFindingCode => (KNOWN_CODES.has(code) ? code as LineageDiagnosticFindingCode : 'UNRECOGNIZED_FINDING_CODE');

/** Reads each named field exactly once into a plain object, so a value cannot change between validation and use. */
function fields<K extends string>(value: unknown, keys: readonly K[], reason: OfflineLineageDiagnosticRefusalReason): Readonly<Record<K, unknown>> {
  refuseIf(!isRecord(value), reason);
  const source = value as Record<string, unknown>;
  const out = {} as Record<K, unknown>;
  for (const key of keys) out[key] = source[key];
  return out;
}
/** Copies a supplied list once. */
function list(value: unknown, reason: OfflineLineageDiagnosticRefusalReason): readonly unknown[] {
  refuseIf(!Array.isArray(value), reason);
  return [...(value as readonly unknown[])];
}
/** A positive `DECIMAL(36,18)` value, as the repository persists ordered quantity, price and leverage. */
function decimal(value: unknown, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  try {
    return canonicalPositiveLiveDecimal(value, 'decimal');
  } catch {
    throw new Refusal('ORDER_ROW_INVALID'); // the library message is never surfaced
  }
}

type Order = Readonly<{ intentId: string; tag: string; pair: string; state: LiveOrderStateName; exchangeOrderId: string | null; armed: boolean;
  side: 'BUY' | 'SELL'; wireOrderType: string; orderedQuantity: string; price: string | null; leverage: string | null }>;
const ORDER_FIELDS = ['intentId', 'clientOrderId', 'accountId', 'pair', 'state', 'exchangeOrderId', 'dispatchWireArmed', 'side',
  'wireOrderType', 'orderedQuantity', 'price', 'leverage'] as const;

/** Reads only the allowlisted fields of one order row. */
function readOrder(value: unknown, accountId: string): Order {
  const row = fields(value, ORDER_FIELDS, 'ORDER_ROW_INVALID');
  const { intentId, clientOrderId, pair, state, exchangeOrderId, dispatchWireArmed, side, wireOrderType } = row;
  refuseIf(!matches(intentId, HEX64) || !matches(clientOrderId, LIVE_CLIENT_ORDER_ID_PATTERN) || !matches(pair, TOKEN)
    || !matches(wireOrderType, TOKEN) || typeof state !== 'string' || !ORDER_STATES.has(state as LiveOrderStateName)
    || !(exchangeOrderId === null || matches(exchangeOrderId, EXCHANGE_ID)) || typeof dispatchWireArmed !== 'boolean'
    || (side !== 'BUY' && side !== 'SELL') || !matches(row.accountId, ACCOUNT), 'ORDER_ROW_INVALID');
  refuseIf(row.accountId !== accountId, 'ROW_ACCOUNT_SCOPE_VIOLATION');
  // Repository integrity rule: a dispatch wire arm exists only inside an active DISPATCH_RESERVED claim.
  refuseIf(dispatchWireArmed === true && state !== 'DISPATCH_RESERVED', 'WIRE_ARM_STATE_CONTRADICTION');
  return Object.freeze({
    intentId: intentId as string, tag: clientOrderId as string, pair: pair as string, state: state as LiveOrderStateName,
    exchangeOrderId: exchangeOrderId as string | null, armed: dispatchWireArmed as boolean, side: side as 'BUY' | 'SELL',
    wireOrderType: wireOrderType as string, orderedQuantity: decimal(row.orderedQuantity, false) as string,
    price: decimal(row.price, true), leverage: decimal(row.leverage, true),
  });
}

type Finding = Readonly<{ intentId: string | null; exchangeOrderId: string | null; code: string }>;
function readFinding(value: unknown, accountId: string): Finding {
  const { intentId, exchangeOrderId, code, accountId: rowAccount } = fields(value, ['accountId', 'intentId', 'exchangeOrderId', 'code'] as const, 'FINDING_ROW_INVALID');
  refuseIf(!matches(code, CODE) || !(intentId === null || matches(intentId, HEX64))
    || !(exchangeOrderId === null || matches(exchangeOrderId, EXCHANGE_ID)) || (intentId === null && exchangeOrderId === null)
    || !matches(rowAccount, ACCOUNT), 'FINDING_ROW_INVALID');
  refuseIf(rowAccount !== accountId, 'ROW_ACCOUNT_SCOPE_VIOLATION');
  return Object.freeze({ intentId: intentId as string | null, exchangeOrderId: exchangeOrderId as string | null, code: code as string });
}

type Statements = Readonly<{
  accountId: string; fingerprint: string; sourceCommit: string; migration: Readonly<{ directories: readonly string[]; lockSha256: string }>;
  coverage: 'ATTESTED' | 'NOT_ATTESTED';
}>;
type Rows = Readonly<{ orders: unknown; findings: unknown; certificates: readonly string[];
  state: Readonly<{ currentGeneration: number; healthyGeneration: number | null }> | null; shareCount: number }>;

/** Reads the input once, validates the statements and checks the account and fingerprint bindings. */
function readInput(input: unknown): Readonly<{ statements: Statements; rows: Rows }> {
  const top = fields(input, ['accountId', 'rows', 'statements'] as const, 'INPUT_INVALID');
  const rows = fields(top.rows, ['orders', 'findings', 'certificates', 'reconciliationState', 'ownershipShareCount'] as const, 'INPUT_INVALID');
  const s = fields(top.statements, ['expectedProviderAccountFingerprint', 'campaignExpectedProviderAccountFingerprint', 'campaignAccountId',
    'sourceCommit', 'migrationIdentity', 'sourceCoverage'] as const, 'INPUT_INVALID');
  const migration = fields(s.migrationIdentity, ['directories', 'lockSha256'] as const, 'INPUT_INVALID');
  const directories = list(migration.directories, 'INPUT_INVALID');
  const accountId = top.accountId;
  refuseIf(!matches(accountId, ACCOUNT) || !matches(s.campaignAccountId, ACCOUNT) || !matches(s.sourceCommit, COMMIT)
    || !matches(s.expectedProviderAccountFingerprint, HEX64) || !matches(s.campaignExpectedProviderAccountFingerprint, HEX64)
    || (s.sourceCoverage !== 'ATTESTED' && s.sourceCoverage !== 'NOT_ATTESTED') || !matches(migration.lockSha256, HEX64)
    || directories.length === 0 || !directories.every((entry) => matches(entry, MIGRATION_DIRECTORY)) || !isCount(rows.ownershipShareCount), 'INPUT_INVALID');
  // Statement-to-statement agreement binds nothing; it only must not disagree. Full values are compared.
  refuseIf(s.campaignAccountId !== accountId, 'ACCOUNT_LABEL_STATEMENT_MISMATCH');
  refuseIf(s.expectedProviderAccountFingerprint !== s.campaignExpectedProviderAccountFingerprint, 'FINGERPRINT_STATEMENTS_DISAGREE');
  const certificates = list(rows.certificates, 'INPUT_INVALID').map((value) => {
    const row = fields(value, ['accountId', 'providerAccountFingerprint'] as const, 'CERTIFICATE_ROW_INVALID');
    refuseIf(!matches(row.accountId, ACCOUNT) || !matches(row.providerAccountFingerprint, HEX64), 'CERTIFICATE_ROW_INVALID');
    refuseIf(row.accountId !== accountId, 'ROW_ACCOUNT_SCOPE_VIOLATION');
    return row.providerAccountFingerprint as string;
  });
  refuseIf(certificates.some((fingerprint) => fingerprint !== s.expectedProviderAccountFingerprint), 'CERTIFICATE_FINGERPRINT_MISMATCH');
  let state: Rows['state'] = null;
  if (rows.reconciliationState !== null) {
    const row = fields(rows.reconciliationState, ['accountId', 'currentGeneration', 'healthyGeneration'] as const, 'INPUT_INVALID');
    refuseIf(!isCount(row.currentGeneration) || !(row.healthyGeneration === null || isCount(row.healthyGeneration)), 'INPUT_INVALID');
    refuseIf(row.accountId !== accountId, 'ROW_ACCOUNT_SCOPE_VIOLATION');
    state = Object.freeze({ currentGeneration: row.currentGeneration as number, healthyGeneration: row.healthyGeneration as number | null });
  }
  return {
    statements: Object.freeze({ accountId: accountId as string, fingerprint: s.expectedProviderAccountFingerprint as string,
      sourceCommit: s.sourceCommit as string, coverage: s.sourceCoverage as 'ATTESTED' | 'NOT_ATTESTED',
      migration: Object.freeze({ directories: Object.freeze(directories as string[]), lockSha256: migration.lockSha256 as string }) }),
    rows: Object.freeze({ orders: rows.orders, findings: rows.findings, certificates, state, shareCount: rows.ownershipShareCount as number }),
  };
}

/** Indexes orders by intent and by exchange id; repeated intent or client order ids are integrity failures. */
function indexOrders(orders: readonly Order[]): Readonly<{ byIntent: ReadonlyMap<string, Order>; holders: ReadonlyMap<string, readonly string[]> }> {
  const byIntent = new Map<string, Order>();
  const tags = new Set<string>();
  const holders = new Map<string, string[]>();
  for (const order of orders) {
    refuseIf(byIntent.has(order.intentId), 'DUPLICATE_INTENT_ID');
    refuseIf(tags.has(order.tag), 'DUPLICATE_CLIENT_ORDER_ID');
    byIntent.set(order.intentId, order);
    tags.add(order.tag);
    if (order.exchangeOrderId !== null) holders.set(order.exchangeOrderId, [...(holders.get(order.exchangeOrderId) ?? []), order.intentId]);
  }
  return { byIntent, holders };
}

type Conflict = OfflineLineageDiagnostic['diagnostics']['conflicts'][number];
const conflict = (reason: ConflictReason, intentIds: readonly string[], findingCodes: readonly string[]): Conflict =>
  Object.freeze({ reason, intentIds: sortedUnique(intentIds), findingCodes: sortedUnique(findingCodes.map(reported)) });
type CodeMap = Map<string, string[]>;
const attach = (map: CodeMap, intentId: string, code: string): void => { map.set(intentId, [...(map.get(intentId) ?? []), code]); };

/**
 * Findings are evaluated as per-intent and per-exchange-id sets, never as a row join. A finding that names an intent
 * is attached to it; one that names only an exchange id is attached to its holders as correlation only.
 */
function associateFindings(findings: readonly Finding[], index: ReturnType<typeof indexOrders>): Readonly<{
  named: ReadonlyMap<string, readonly string[]>; correlated: ReadonlyMap<string, readonly string[]>;
  conflicts: readonly Conflict[]; unlinked: ReadonlyMap<ReportedFindingCode, number>;
}> {
  const named: CodeMap = new Map();
  const correlated: CodeMap = new Map();
  const conflicts: Conflict[] = [];
  const unlinked = new Map<ReportedFindingCode, number>();
  for (const finding of findings) {
    const holderIds = finding.exchangeOrderId === null ? [] : index.holders.get(finding.exchangeOrderId) ?? [];
    const order = finding.intentId === null ? undefined : index.byIntent.get(finding.intentId);
    if (finding.intentId === null) {
      const code = reported(finding.code);
      if (holderIds.length === 0) unlinked.set(code, (unlinked.get(code) ?? 0) + 1);
      holderIds.forEach((holder) => attach(correlated, holder, finding.code));
    } else if (order === undefined) {
      conflicts.push(conflict('FINDING_INTENT_NOT_IN_SNAPSHOT', [finding.intentId], [finding.code]));
    } else {
      attach(named, order.intentId, finding.code);
      const others = holderIds.filter((holder) => holder !== order.intentId);
      if (others.length > 0) {
        conflicts.push(conflict('FINDING_EXCHANGE_ID_HELD_BY_OTHER_INTENT', [order.intentId, ...others], [finding.code]));
      } else if (finding.exchangeOrderId !== null && order.exchangeOrderId !== null && finding.exchangeOrderId !== order.exchangeOrderId) {
        conflicts.push(conflict('FINDING_EXCHANGE_ID_DIFFERS_FROM_ORDER', [order.intentId], [finding.code]));
      }
    }
  }
  for (const intentIds of index.holders.values()) {
    if (intentIds.length > 1) conflicts.push(conflict('DUPLICATE_EXCHANGE_ORDER_ID', intentIds, []));
  }
  return { named, correlated, conflicts, unlinked };
}

type Classified =
  | Readonly<{ kind: 'EXCLUDED'; entry: OfflineLineageDiagnostic['diagnostics']['excluded'][number] }>
  | Readonly<{ kind: 'OMITTED'; entry: OfflineLineageDiagnostic['diagnostics']['omitted'][number] }>
  | Readonly<{ kind: 'CANDIDATE'; entry: AmbiguousCreateCandidate }>
  | Readonly<{ kind: 'CONFLICT'; entry: Conflict }>;
const OMISSIONS: Partial<Record<LiveOrderStateName, OmittedReason>> = {
  CREATED: 'CLAIM_RELEASED_UNSENT', DISPATCH_RESERVED: 'RESERVATION_UNARMED', REJECTED: 'VENUE_REFUSED_WITHOUT_SNAPSHOT',
};

/**
 * The plan §3 table for one order, with D1 (resolved never a candidate) and D4 (no owned orders) applied. Only codes of
 * findings that name this intent classify it; exchange-id correlation is reported, never used here.
 */
function classify(order: Order, accountId: string, namedCodes: readonly string[], correlatedCodes: readonly string[]): Classified {
  const { intentId } = order;
  const findingCodes = sortedUnique(namedCodes.map(reported));
  const resolved = namedCodes.some((code) => RESOLUTION_CODES.has(code));
  if (order.exchangeOrderId !== null) {
    const reasons: readonly ExcludedReason[] = resolved ? ['OWNED_ORDERS_DISABLED', 'RECONCILIATION_RESOLVED'] : ['OWNED_ORDERS_DISABLED'];
    return { kind: 'EXCLUDED', entry: Object.freeze({ intentId, reasons: Object.freeze([...reasons]), findingCodes,
      exchangeIdCorrelatedFindingCodes: sortedUnique(correlatedCodes.map(reported)) }) };
  }
  if (resolved) return { kind: 'CONFLICT', entry: conflict('RESOLUTION_FINDING_WITHOUT_EXCHANGE_ID', [intentId], namedCodes) };
  if (order.state === 'SUBMISSION_AMBIGUOUS' || (order.state === 'DISPATCH_RESERVED' && order.armed)) {
    return { kind: 'CANDIDATE', entry: Object.freeze({ intentId, accountId, tag: order.tag, pair: order.pair, side: order.side,
      orderedQuantity: order.orderedQuantity, price: order.price, wireOrderType: order.wireOrderType, leverage: order.leverage, findingCodes }) };
  }
  const omission = OMISSIONS[order.state];
  return omission === undefined
    ? { kind: 'CONFLICT', entry: conflict('UNEXPECTED_STATE_WITHOUT_EXCHANGE_ID', [intentId], namedCodes) }
    : { kind: 'OMITTED', entry: Object.freeze({ intentId, reason: omission, findingCodes }) };
}

function diagnose(input: unknown): OfflineLineageDiagnostic {
  const { statements, rows } = readInput(input);
  const { accountId } = statements;
  const orders = list(rows.orders, 'INPUT_INVALID').map((row) => readOrder(row, accountId));
  const findings = list(rows.findings, 'INPUT_INVALID').map((row) => readFinding(row, accountId));
  const associations = associateFindings(findings, indexOrders(orders));

  const excluded: OfflineLineageDiagnostic['diagnostics']['excluded'][number][] = [];
  const omitted: OfflineLineageDiagnostic['diagnostics']['omitted'][number][] = [];
  const candidates: AmbiguousCreateCandidate[] = [];
  const conflicts: Conflict[] = [...associations.conflicts];
  for (const order of [...orders].sort((a, b) => byText(a.intentId, b.intentId))) {
    const classified = classify(order, accountId, associations.named.get(order.intentId) ?? [], associations.correlated.get(order.intentId) ?? []);
    if (classified.kind === 'EXCLUDED') excluded.push(classified.entry);
    else if (classified.kind === 'OMITTED') omitted.push(classified.entry);
    else if (classified.kind === 'CANDIDATE') candidates.push(classified.entry);
    else conflicts.push(classified.entry);
  }
  const conflictKey = (entry: Conflict): string => JSON.stringify([entry.reason, entry.intentIds, entry.findingCodes]);
  const sortedConflicts = [...conflicts].sort((a, b) => byText(conflictKey(a), conflictKey(b)));
  const { state, certificates, shareCount } = rows;

  const body = {
    kind: 'OFFLINE_LINEAGE_DIAGNOSTIC' as const,
    use: 'OFFLINE_DIAGNOSTIC_ONLY' as const,
    engineInput: 'NOT_PERMITTED' as const,
    ownershipProof: 'NONE' as const,
    accountId,
    policyEmpty: Object.freeze({
      ownedOrderLineage: Object.freeze({ status: 'EMPTY_BY_POLICY' as const, decision: 'D4' as const }),
      closedIntentTagLineage: Object.freeze({ status: 'EMPTY_BY_POLICY' as const, decision: 'D2' as const }),
      ownedPositionLineage: Object.freeze({ status: 'EMPTY_BY_POLICY' as const, decision: 'D3' as const }),
    }),
    ambiguousCreateCandidates: Object.freeze({
      status: candidates.length > 0 ? 'ENTRIES_FOUND' as const : 'NONE_FOUND_IN_SNAPSHOT' as const,
      scope: 'SUPPLIED_SNAPSHOT_ONLY' as const,
      accountWideAbsence: 'NOT_ESTABLISHED' as const,
      evidenceUse: 'DIAGNOSTIC_ONLY' as const,
      entries: Object.freeze(candidates),
    }),
    correlationTagNamespace: LIVE_CLIENT_ORDER_ID_PREFIX,
    diagnostics: Object.freeze({
      excluded: Object.freeze(excluded),
      omitted: Object.freeze(omitted),
      conflicts: Object.freeze(sortedConflicts),
      unlinkedFindingCodes: Object.freeze([...associations.unlinked].sort(([a], [b]) => byText(a, b)).map(([code, count]) => Object.freeze({ code, count }))),
      ownershipShareCount: shareCount,
    }),
    provenance: Object.freeze({
      checkedOnSuppliedRows: Object.freeze({
        checks: CHECKS_PERFORMED,
        rowCounts: Object.freeze({ orders: orders.length, findings: findings.length, certificates: certificates.length, ownershipShares: shareCount }),
        reconciliationGenerations: state === null ? 'NO_STATE_ROW_SUPPLIED' as const
          : Object.freeze({ current: state.currentGeneration, healthy: state.healthyGeneration }),
        certificateBinding: certificates.length > 0 ? 'SUPPLIED_CERTIFICATE_ROWS_MATCH_STATEMENT' as const : 'NO_CERTIFICATE_ROWS_STATEMENT_ONLY' as const,
        accountLabel: 'SUPPLIED_ROWS_MATCH_CAMPAIGN_STATEMENT' as const,
      }),
      callerStatements: Object.freeze({
        sourceCommit: statements.sourceCommit,
        migrationIdentity: statements.migration,
        expectedFingerprintPrefix: statements.fingerprint.slice(0, 12),
        fingerprintStatements: 'STATEMENTS_AGREE_BINDS_NOTHING' as const,
        sourceCoverage: statements.coverage === 'ATTESTED' ? 'ATTESTED_BY_OPERATOR_UNVERIFIED' as const : 'NOT_ATTESTED' as const,
      }),
      notEstablished: NOT_ESTABLISHED,
    }),
  };
  return Object.freeze({ ...body, recordSha256: sha256CanonicalJson(body) });
}

/** Builds the offline diagnostic, or a refusal with a fixed reason. Never returns a partial diagnostic. */
export function buildOfflineLineageDiagnostic(input: OfflineLineageDiagnosticInput): OfflineLineageDiagnosticResult {
  try {
    return diagnose(input);
  } catch (error) {
    if (error instanceof Refusal) return Object.freeze({ kind: 'OFFLINE_LINEAGE_DIAGNOSTIC_REFUSED' as const, reason: error.reason });
    return Object.freeze({ kind: 'OFFLINE_LINEAGE_DIAGNOSTIC_REFUSED' as const, reason: 'INPUT_INVALID' as const }); // e.g. a throwing getter
  }
}
