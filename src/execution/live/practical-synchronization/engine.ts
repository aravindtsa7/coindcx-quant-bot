/**
 * M4 (unwired review candidate, docs/M4_SYNCHRONIZATION_CANDIDATE.md): a read-only synchronization engine driven
 * entirely by an injected read source. It performs no I/O of its own, reads no clock, and is imported by nothing in
 * `src/`. It does not approve D4c, satisfy AS1, or complete the formal M3/M4 milestones.
 *
 * One observation cycle:
 *   1. Snapshot the private stream (cycle start).
 *   2. Two REST passes over the declared account, components and history scope, with explicit scan limits.
 *   3. Normalize each record, key it, fingerprint it and classify its ownership (register §5).
 *   4. Assess the passes with the M3 evaluator. A private event, reconnect or epoch change revokes the cycle, and a new
 *      cycle starts while cycles remain.
 *
 * What a result is not. OBSERVED_CONVERGENCE is observed convergence within the declared scan scope. It is not
 * proof of complete account history, atomic consistency, strict continuity, private-stream readiness, the provider's
 * synchronization procedure, or consent to submit orders. Every result grants nothing.
 */
import {
  assessPracticalObservation,
  GRANTS_NOTHING,
  type AccountingCapability,
  type ComponentRead,
  type ObservationComponent,
  type ObservationMode,
  type ObservationOwnership,
  type ObservedRecord,
  type PracticalObservationAssessment,
  type PracticalObservationThresholds,
  type PrivateStreamObservation,
} from '../practical-observation/assessment';
import type { LiveVenueOrderEvidence, LiveVenuePositionEvidence } from '../reconciliation/types';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Explicit per-component scan limits. No default exists; none is approved for production. */
export interface SyncScanLimits {
  readonly pageSize: number;
  readonly maxPages: number;
}

/** Declared history scope. Neither form proves the history is complete (register B8, B9). */
export type SyncHistoryScope =
  | Readonly<{ kind: 'AVAILABLE_HISTORY' }>
  | Readonly<{ kind: 'DECLARED_WINDOW'; fromMs: number; toMs: number }>;

/**
 * One transaction-like record (fills and wallet activity). `fillId` is a provider identifier exactly as returned,
 * with the field it came from, or null. It is never invented. `stage` is the raw lexeme, never interpreted.
 */
export interface SyncTransactionEvidence {
  readonly category: 'FILL' | 'WALLET';
  readonly fillId: Readonly<{ field: string; value: string }> | null;
  readonly parentExchangeOrderId: string | null;
  readonly stage: string | null;
  readonly amount: string;
  readonly currency: string | null;
  readonly providerEventTimeMs: number | null;
}

/**
 * What the injected source returns for one component scan. Records are validated, never trusted. A scan is either one
 * unnamed page sequence (`pages`) or several named sub-scans (`segments`, for example an endpoint that must be read
 * once per side); each segment is bounded by the same limits and must terminate on its own.
 */
export type SyncComponentScan =
  | Readonly<{ kind: 'FAILED' }>
  | Readonly<{
    kind: 'SCANNED';
    accountScope: Readonly<{ kind: 'CONFIRMED'; accountId: string }> | Readonly<{ kind: 'UNKNOWN' }>;
    startedAtMs: number;
    endedAtMs: number;
    pages: readonly (readonly unknown[])[];
  }>
  | Readonly<{
    kind: 'SCANNED';
    accountScope: Readonly<{ kind: 'CONFIRMED'; accountId: string }> | Readonly<{ kind: 'UNKNOWN' }>;
    startedAtMs: number;
    endedAtMs: number;
    segments: readonly Readonly<{ segment: string; pages: readonly (readonly unknown[])[] }>[];
  }>;

/** Durable local lineage, injected. Only these establish OWNED; a tag alone never does. */
export interface SyncLineage {
  /** Exchange order ids returned to this bot's own create responses, bound to durable intents. */
  readonly ownedOrders: readonly Readonly<{ exchangeOrderId: string; intentId: string }>[];
  /** Durable pre-dispatch intents whose create outcome is ambiguous (no exchange id known). */
  readonly ambiguousCreates: readonly Readonly<{
    intentId: string; accountId: string; tag: string; pair: string; side: 'BUY' | 'SELL';
    orderedQuantity: string; price: string | null; wireOrderType: string; leverage: string | null;
  }>[];
  /** Tags of intents that are closed (a venue order carrying one is a reuse conflict). */
  readonly closedIntentTags: readonly string[];
  /** Venue position ids with a durable ownership record. */
  readonly ownedPositions: readonly string[];
  /** The bot's tag namespace prefix (correlation only). */
  readonly botTagNamespace: string;
}

/**
 * Provider contracts as explicit inputs. Unconfirmed is the fail-closed state. The order evidence carries the venue's
 * `client_order_id`; a contract confirmed for another field name (for example `client_id`) is not applied to it.
 */
export interface SyncProviderContracts {
  readonly tagContract:
    | Readonly<{ confirmed: false }>
    | Readonly<{ confirmed: true; field: 'client_order_id' | 'client_id'; botCreatesAlwaysTagged: boolean }>;
  /** Confirmed `wireOrderType` lexemes identifying liquidation or TP/SL (C5a), or null when unconfirmed. */
  readonly venueGeneratedOrderTypes: readonly string[] | null;
  /** Confirmed wallet `stage` lexemes for venue-generated changes (C5b–C5d), or null when unconfirmed. */
  readonly venueGeneratedWalletStages: readonly string[] | null;
  /**
   * Per endpoint: whether a short (non-empty) page is CONFIRMED to be the terminal page (register B9). Absent means
   * unknown: a scan that stops at a short page is then unresolved, and the source must continue to an empty page or
   * the configured bound. An empty page ends a scan either way, but never proves complete history.
   */
  readonly terminalShortPage: Readonly<Partial<Record<ObservationComponent, 'CONFIRMED'>>>;
}

export interface SynchronizationConfig {
  readonly mode: ObservationMode;
  readonly scope: Readonly<{
    accountId: string;
    components: readonly ObservationComponent[];
    requiredAccounting: readonly AccountingCapability[];
    history: SyncHistoryScope;
  }>;
  readonly scanLimits: Readonly<Partial<Record<ObservationComponent, SyncScanLimits>>>;
  readonly thresholds: PracticalObservationThresholds;
  readonly maxCycles: number;
  readonly lineage: SyncLineage;
  readonly contracts: SyncProviderContracts;
}

/** The injected read source: synthetic fixtures in tests. The engine never constructs one. */
export interface SynchronizationSource {
  scan(request: Readonly<{ cycle: number; pass: 0 | 1; component: ObservationComponent; accountId: string; limits: SyncScanLimits; history: SyncHistoryScope }>): SyncComponentScan;
  stream(request: Readonly<{ cycle: number; point: 'CYCLE_START' | 'EVALUATION' }>): PrivateStreamObservation;
  clock(request: Readonly<{ cycle: number }>): number;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type SyncOwnershipClass = 'OWNED' | 'UNRESOLVED' | 'FOREIGN_OBSERVED' | 'VENUE_GENERATED';
export type SyncOwnershipReason =
  | 'BOT_CREATE_RESPONSE' | 'RESOLVED_UNDER_CONFIRMED_CONTRACT' | 'DURABLE_OWNERSHIP_RECORD' | 'OWNED_PARENT_ORDER'
  | 'TAG_WITHOUT_DURABLE_INTENT' | 'TAG_CONTRACT_UNCONFIRMED' | 'TAG_CONFLICT' | 'TAG_MALFORMED' | 'TAG_MISSING'
  | 'AMBIGUOUS_MULTIPLE_CANDIDATES' | 'CANDIDATE_FIELD_MISMATCH' | 'TAG_OUTSIDE_NAMESPACE_UNCONFIRMED'
  | 'FOREIGN_TAG_UNDER_CONFIRMED_CONTRACT' | 'UNTAGGED_UNDER_CONFIRMED_CONTRACT'
  | 'VENUE_GENERATED_CONFIRMED_TYPE' | 'VENUE_GENERATED_CONFIRMED_STAGE'
  | 'NO_DURABLE_POSITION_OWNERSHIP' | 'FLAT_POSITION_WITHOUT_DURABLE_OWNERSHIP' | 'FILL_PARENT_NOT_OWNED' | 'WALLET_CHANGE_UNEXPLAINED';

/** Where a record occurred in one scan: zero-based page and position within the page. */
export type SyncOccurrence = Readonly<{ segment?: string; page: number; position: number }>;

export type SyncRecordView = Readonly<{
  key: string;
  identity: 'EXCHANGE_ORDER_ID' | 'VENUE_POSITION_ID' | 'PROVIDER_FILL_ID' | 'CONTENT_ONLY';
  /** The record's content fingerprint: comparison evidence only, never a fill identity. */
  fingerprint: string;
  ownership: SyncOwnershipClass;
  reason: SyncOwnershipReason;
  /** Every occurrence in the scan (more than one only for deduplicated or unresolved duplicates). */
  occurrences: readonly SyncOccurrence[];
  anomalies: readonly ('IDENTICAL_DUPLICATE_DEDUPED' | 'CONTENT_ONLY_TWIN_UNRESOLVED')[];
  /** Raw stage of a wallet record; never interpreted unless a contract confirms it. */
  stageInterpretation?: 'UNCONFIRMED' | 'CONFIRMED_VENUE_GENERATED';
}>;

export type SyncScanFinding = Readonly<{
  pass: 0 | 1;
  component: ObservationComponent;
  finding:
    | 'READ_FAILED' | 'SCAN_LIMIT_VIOLATED' | 'SCAN_BOUNDARY_REACHED' | 'TERMINATION_UNOBSERVED' | 'IRREGULAR_PAGE'
    | 'SHORT_PAGE_TERMINALITY_UNCONFIRMED' | 'RECORDS_AFTER_SHORT_PAGE'
    | 'RECORD_MALFORMED' | 'PAGE_SHIFT_OBSERVED' | 'CONFLICTING_DUPLICATE' | 'IDENTICAL_DUPLICATE_DEDUPED'
    | 'CONTENT_IDENTITY_AMBIGUOUS'
    | 'RECORD_OUTSIDE_DECLARED_WINDOW' | 'WINDOW_MEMBERSHIP_UNKNOWN' | 'WINDOW_BOUNDARY_SEMANTICS_UNKNOWN';
  blocking: boolean;
  key?: string;
  occurrences?: readonly SyncOccurrence[];
  /** The named segment a termination finding belongs to. */
  segment?: string;
}>;

/**
 * How a scan ended. Only OBSERVED_EMPTY_PAGE and CONFIRMED_TERMINAL_SHORT_PAGE end it cleanly, and neither proves the
 * account history complete.
 */
export type SyncScanTermination =
  | 'OBSERVED_EMPTY_PAGE' | 'CONFIRMED_TERMINAL_SHORT_PAGE' | 'SHORT_PAGE_TERMINALITY_UNCONFIRMED'
  | 'SCAN_BOUNDARY_REACHED' | 'UNOBSERVED' | 'FAILED';

export type SyncCycleResult = Readonly<{
  cycle: number;
  status: 'OBSERVED_CONVERGENCE' | 'UNRESOLVED' | 'REVOKED';
  reasons: readonly string[];
  terminations: readonly Readonly<{ pass: 0 | 1; component: ObservationComponent; termination: SyncScanTermination;
    segments?: readonly Readonly<{ segment: string; termination: SyncScanTermination }>[] }>[];
  scanFindings: readonly SyncScanFinding[];
  records: readonly Readonly<{ pass: 0 | 1; component: ObservationComponent; records: readonly SyncRecordView[] }>[];
  assessment: PracticalObservationAssessment;
}>;

export type SynchronizationResult = Readonly<{
  status: 'OBSERVED_CONVERGENCE' | 'UNRESOLVED' | 'REVOKED_CYCLE_LIMIT_REACHED' | 'INVALID_CONFIGURATION';
  semantics: 'OBSERVED_CONVERGENCE_WITHIN_DECLARED_SCAN_SCOPE';
  history: SyncHistoryScope | null;
  /** Never PROVEN: an observed short or empty page ends a scan, it does not prove the account history complete. */
  historyCompleteness: Readonly<{ status: 'UNPROVEN'; reasons: readonly string[] }>;
  /** For a declared window: records outside it are flagged, never filtered; the boundary semantics are unconfirmed. */
  historyWindow: Readonly<{ membership: 'FLAGGED_NEVER_FILTERED'; boundarySemantics: 'UNCONFIRMED' }> | null;
  cycles: readonly SyncCycleResult[];
  grants: typeof GRANTS_NOTHING;
}>;

// ---------------------------------------------------------------------------
// Normalization and fingerprints (deterministic; documented in the design note)
// ---------------------------------------------------------------------------

const DECIMAL = /^-?\d+(\.\d+)?$/;
/** Exact decimal string to canonical form: no leading zeros, no trailing fractional zeros, no negative zero. */
export function canonicalDecimal(value: string): string | null {
  if (!DECIMAL.test(value)) return null;
  const negative = value.startsWith('-');
  const [integerPart = '', fractionPart = ''] = (negative ? value.slice(1) : value).split('.');
  const integer = integerPart.replace(/^0+(?=\d)/, '');
  const fraction = fractionPart.replace(/0+$/, '');
  const body = fraction.length > 0 ? `${integer}.${fraction}` : integer;
  return negative && body !== '0' ? `-${body}` : body;
}

/** A canonical fingerprint: the component, then each named field in a fixed order, JSON-encoded. */
function fingerprintOf(component: ObservationComponent, fields: readonly (readonly [string, string | number | null])[]): string {
  return `${component}|${fields.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('|')}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const decimalOrNull = (value: unknown): string | null | undefined => (value === null ? null : isString(value) ? (canonicalDecimal(value) ?? undefined) : undefined);
const decimal = (value: unknown): string | undefined => (isString(value) ? (canonicalDecimal(value) ?? undefined) : undefined);
/** A tag the bot could have sent: 1-36 visible ASCII characters (the frozen identity limit). Anything else is malformed. */
const isWellFormedTag = (tag: string): boolean => tag.length >= 1 && tag.length <= 36 && /^[\x21-\x7e]+$/.test(tag);

/** One normalized record. `times` are its provider timestamps (null when absent or invalid), used only to flag window membership. */
type Normalized = Readonly<{ key: string; identity: SyncRecordView['identity']; fingerprint: string; timestamps: boolean; times: readonly (number | null)[]; raw: Record<string, unknown> }>;

function normalizeOrder(value: unknown): Normalized | null {
  if (!isRecord(value) || !isNonEmpty(value['exchangeOrderId']) || !isNonEmpty(value['pair']) || (value['side'] !== 'BUY' && value['side'] !== 'SELL')) return null;
  if (!isString(value['venueStatus']) || !isString(value['wireOrderType']) || !isNullableString(value['clientOrderId'])) return null;
  const quantities = ['orderedQuantity', 'filledQuantity', 'remainingQuantity', 'cancelledQuantity'].map((name) => decimal(value[name]));
  const [averageFillPrice, price, leverage] = ['averageFillPrice', 'price', 'leverage'].map((name) => decimalOrNull(value[name]));
  if (quantities.some((q) => q === undefined) || averageFillPrice === undefined || price === undefined || leverage === undefined) return null;
  const timestamps = isTime(value['providerCreatedAtMs']) && isTime(value['providerEventTimeMs']);
  const fields: (readonly [string, string | number | null])[] = [
    ['exchangeOrderId', value['exchangeOrderId']], ['pair', value['pair']], ['side', value['side']], ['venueStatus', value['venueStatus']],
    ['orderedQuantity', quantities[0]!], ['filledQuantity', quantities[1]!], ['remainingQuantity', quantities[2]!], ['cancelledQuantity', quantities[3]!],
    ['averageFillPrice', averageFillPrice], ['price', price], ['wireOrderType', value['wireOrderType']], ['leverage', leverage],
    ['providerCreatedAtMs', timestamps ? value['providerCreatedAtMs'] as number : null], ['providerEventTimeMs', timestamps ? value['providerEventTimeMs'] as number : null],
    // The venue's `client_order_id`, exactly as returned; never renamed to or merged with `client_id`.
    ['client_order_id', value['clientOrderId']],
  ];
  return Object.freeze({ key: `order:${value['exchangeOrderId']}`, identity: 'EXCHANGE_ORDER_ID' as const, fingerprint: fingerprintOf('ORDERS', fields), timestamps, times: [isTime(value['providerCreatedAtMs']) ? value['providerCreatedAtMs'] as number : null, isTime(value['providerEventTimeMs']) ? value['providerEventTimeMs'] as number : null], raw: value });
}

function normalizePosition(value: unknown): Normalized | null {
  if (!isRecord(value) || !isNonEmpty(value['venuePositionId']) || !isNonEmpty(value['pair'])) return null;
  const signedQuantity = decimal(value['signedQuantity']);
  const averageEntryPrice = decimalOrNull(value['averageEntryPrice']);
  const leverage = decimalOrNull(value['leverage']);
  if (signedQuantity === undefined || averageEntryPrice === undefined || leverage === undefined) return null;
  const timestamps = isTime(value['providerEventTimeMs']);
  const fields: (readonly [string, string | number | null])[] = [
    ['venuePositionId', value['venuePositionId']], ['pair', value['pair']], ['signedQuantity', signedQuantity],
    ['averageEntryPrice', averageEntryPrice], ['leverage', leverage], ['providerEventTimeMs', timestamps ? value['providerEventTimeMs'] as number : null],
  ];
  return Object.freeze({ key: `position:${value['venuePositionId']}`, identity: 'VENUE_POSITION_ID' as const, fingerprint: fingerprintOf('POSITIONS', fields), timestamps, times: [isTime(value['providerEventTimeMs']) ? value['providerEventTimeMs'] as number : null], raw: value });
}

function normalizeTransaction(value: unknown): Normalized | null {
  if (!isRecord(value) || (value['category'] !== 'FILL' && value['category'] !== 'WALLET')) return null;
  const fillId = value['fillId'];
  if (fillId !== null && !(isRecord(fillId) && isNonEmpty(fillId['field']) && isNonEmpty(fillId['value']))) return null;
  if (!isNullableString(value['parentExchangeOrderId']) || !isNullableString(value['stage']) || !isNullableString(value['currency'])) return null;
  const amount = decimal(value['amount']);
  if (amount === undefined || !(value['providerEventTimeMs'] === null || isTime(value['providerEventTimeMs']))) return null;
  const id = fillId as Readonly<{ field: string; value: string }> | null;
  const timestamps = isTime(value['providerEventTimeMs']);
  const eventTime = timestamps ? value['providerEventTimeMs'] as number : null;
  const fields: (readonly [string, string | number | null])[] = [
    ['category', value['category']], ['fill_id_field', id?.field ?? null], ['fill_id_value', id?.value ?? null],
    ['parentExchangeOrderId', value['parentExchangeOrderId']], ['stage', value['stage']], ['amount', amount],
    ['currency', value['currency']], ['providerEventTimeMs', timestamps ? value['providerEventTimeMs'] as number : null],
  ];
  const fingerprint = fingerprintOf('TRANSACTIONS', fields);
  return Object.freeze(id === null
    ? { key: `txn:content:${fingerprint}`, identity: 'CONTENT_ONLY' as const, fingerprint, timestamps, times: [eventTime], raw: value }
    : { key: `txn:fill:${id.field}:${id.value}`, identity: 'PROVIDER_FILL_ID' as const, fingerprint, timestamps, times: [eventTime], raw: value });
}

const NORMALIZERS: Readonly<Record<ObservationComponent, (value: unknown) => Normalized | null>> = Object.freeze({
  ORDERS: normalizeOrder, POSITIONS: normalizePosition, TRANSACTIONS: normalizeTransaction,
});

// ---------------------------------------------------------------------------
// Ownership (register §5 classes and its seven M4 scenarios)
// ---------------------------------------------------------------------------

type Classified = Readonly<{ ownership: SyncOwnershipClass; reason: SyncOwnershipReason; m3: ObservationOwnership; stageInterpretation?: SyncRecordView['stageInterpretation'] }>;
const owned = (reason: 'BOT_CREATE_RESPONSE' | 'RESOLVED_UNDER_CONFIRMED_CONTRACT' | 'DURABLE_OWNERSHIP_RECORD', lineage = reason): Classified =>
  Object.freeze({ ownership: 'OWNED' as const, reason, m3: Object.freeze({ kind: 'OWNED' as const, lineage }) });
const unresolved = (reason: SyncOwnershipReason, tagOnly = false): Classified =>
  Object.freeze({ ownership: 'UNRESOLVED' as const, reason, m3: Object.freeze(tagOnly ? { kind: 'TAG_CORRELATED_ONLY' as const } : { kind: 'UNRESOLVED' as const }) });
const foreign = (reason: SyncOwnershipReason): Classified => Object.freeze({ ownership: 'FOREIGN_OBSERVED' as const, reason, m3: Object.freeze({ kind: 'FOREIGN_OBSERVED' as const }) });
const venue = (reason: SyncOwnershipReason): Classified => Object.freeze({ ownership: 'VENUE_GENERATED' as const, reason, m3: Object.freeze({ kind: 'VENUE_GENERATED' as const }) });

/** The confirmed tag contract applies only when it names the field the evidence actually carries. */
function confirmedForClientOrderId(contracts: SyncProviderContracts): Readonly<{ botCreatesAlwaysTagged: boolean }> | null {
  const contract = contracts.tagContract;
  return contract.confirmed && contract.field === 'client_order_id' ? contract : null;
}

function classifyOrders(orders: readonly Normalized[], accountId: string, lineage: SyncLineage, contracts: SyncProviderContracts): Map<string, Classified> {
  const result = new Map<string, Classified>();
  const ownedIds = new Map(lineage.ownedOrders.map((entry) => [entry.exchangeOrderId, entry.intentId]));
  const tagCounts = new Map<string, number>();
  for (const order of orders) {
    const tag = order.raw['clientOrderId'];
    if (typeof tag === 'string') tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const confirmed = confirmedForClientOrderId(contracts);
  for (const order of orders) {
    const raw = order.raw as unknown as LiveVenueOrderEvidence;
    if (ownedIds.has(raw.exchangeOrderId)) { result.set(order.key, owned('BOT_CREATE_RESPONSE')); continue; }
    if (contracts.venueGeneratedOrderTypes !== null && contracts.venueGeneratedOrderTypes.includes(raw.wireOrderType)) {
      result.set(order.key, venue('VENUE_GENERATED_CONFIRMED_TYPE')); continue; // scenario 5 (confirmed fields only)
    }
    const tag = raw.clientOrderId;
    if (tag === null) {
      // Scenario 7: a missing tag is not foreign unless a confirmed contract makes it so.
      result.set(order.key, confirmed?.botCreatesAlwaysTagged === true ? foreign('UNTAGGED_UNDER_CONFIRMED_CONTRACT') : unresolved('TAG_MISSING'));
      continue;
    }
    if (!isWellFormedTag(tag)) { result.set(order.key, unresolved('TAG_MALFORMED')); continue; } // scenario 4
    if ((tagCounts.get(tag) ?? 0) > 1 || lineage.closedIntentTags.includes(tag)) { result.set(order.key, unresolved('TAG_CONFLICT')); continue; } // scenario 3
    const candidates = lineage.ambiguousCreates.filter((candidate) => candidate.tag === tag);
    if (candidates.length > 0) {
      if (confirmed === null) { result.set(order.key, unresolved('TAG_CONTRACT_UNCONFIRMED', true)); continue; } // tag before C2 confirmed
      if (candidates.length > 1) { result.set(order.key, unresolved('AMBIGUOUS_MULTIPLE_CANDIDATES')); continue; }
      const c = candidates[0]!;
      const exact = c.accountId === accountId && c.pair === raw.pair && c.side === raw.side && c.wireOrderType === raw.wireOrderType
        && canonicalDecimal(c.orderedQuantity) === canonicalDecimal(raw.orderedQuantity)
        && (c.price === null ? raw.price === null : raw.price !== null && canonicalDecimal(c.price) === canonicalDecimal(raw.price))
        && (c.leverage === null ? raw.leverage === null : raw.leverage !== null && canonicalDecimal(c.leverage) === canonicalDecimal(raw.leverage));
      result.set(order.key, exact ? owned('RESOLVED_UNDER_CONFIRMED_CONTRACT') : unresolved('CANDIDATE_FIELD_MISMATCH')); // scenario 2
      continue;
    }
    if (tag.startsWith(lineage.botTagNamespace)) { result.set(order.key, unresolved('TAG_WITHOUT_DURABLE_INTENT', true)); continue; } // scenario 1
    result.set(order.key, confirmed?.botCreatesAlwaysTagged === true ? foreign('FOREIGN_TAG_UNDER_CONFIRMED_CONTRACT') : unresolved('TAG_OUTSIDE_NAMESPACE_UNCONFIRMED'));
  }
  return result;
}

function classifyPositions(positions: readonly Normalized[], lineage: SyncLineage): Map<string, Classified> {
  const ownedIds = new Set(lineage.ownedPositions);
  return new Map(positions.map((position) => [position.key,
    ownedIds.has((position.raw as unknown as LiveVenuePositionEvidence).venuePositionId) ? owned('DURABLE_OWNERSHIP_RECORD')
      // A flat position is never inferred to be owned, and is never excluded to reach convergence (a later scope decision).
      : canonicalDecimal((position.raw as unknown as LiveVenuePositionEvidence).signedQuantity) === '0' ? unresolved('FLAT_POSITION_WITHOUT_DURABLE_OWNERSHIP')
        : unresolved('NO_DURABLE_POSITION_OWNERSHIP')]));
}

function classifyTransactions(transactions: readonly Normalized[], orders: ReadonlyMap<string, Classified>, contracts: SyncProviderContracts): Map<string, Classified> {
  const result = new Map<string, Classified>();
  for (const transaction of transactions) {
    const raw = transaction.raw as unknown as SyncTransactionEvidence;
    if (raw.category === 'FILL') {
      const parent = raw.parentExchangeOrderId === null ? undefined : orders.get(`order:${raw.parentExchangeOrderId}`);
      result.set(transaction.key, parent?.ownership === 'OWNED' && parent.m3.kind === 'OWNED'
        ? Object.freeze({ ownership: 'OWNED' as const, reason: 'OWNED_PARENT_ORDER' as const, m3: parent.m3 })
        : unresolved('FILL_PARENT_NOT_OWNED'));
      continue;
    }
    // Scenario 6: a wallet change is never treated as zero, and its stage is not interpreted without a confirmed contract.
    const confirmedStage = raw.stage !== null && contracts.venueGeneratedWalletStages !== null && contracts.venueGeneratedWalletStages.includes(raw.stage);
    result.set(transaction.key, confirmedStage
      ? Object.freeze({ ...venue('VENUE_GENERATED_CONFIRMED_STAGE'), stageInterpretation: 'CONFIRMED_VENUE_GENERATED' as const })
      : Object.freeze({ ...unresolved('WALLET_CHANGE_UNEXPLAINED'), stageInterpretation: 'UNCONFIRMED' as const }));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

/** A record kept from one scan, with every occurrence and any duplicate anomaly. */
type ScannedRecord = Normalized & Readonly<{
  occurrences: readonly SyncOccurrence[];
  anomalies: readonly ('IDENTICAL_DUPLICATE_DEDUPED' | 'CONTENT_ONLY_TWIN_UNRESOLVED')[];
  /** What the M3 comparison sees: the content fingerprint, plus the occurrence count for content-only twins. */
  comparisonFingerprint: string;
}>;

type ScanOutcome = Readonly<{
  read: ComponentRead;
  termination: SyncScanTermination;
  segments: readonly Readonly<{ segment: string; termination: SyncScanTermination }>[] | null;
  findings: SyncScanFinding[];
  records: ScannedRecord[];
}>;

function evaluateScan(pass: 0 | 1, component: ObservationComponent, limits: SyncScanLimits, history: SyncHistoryScope,
  contracts: SyncProviderContracts, scan: unknown): ScanOutcome {
  const findings: SyncScanFinding[] = [];
  const finding = (kind: SyncScanFinding['finding'], blocking: boolean, key?: string, occurrences?: readonly SyncOccurrence[], segment?: string | null): void => {
    findings.push(Object.freeze({ pass, component, finding: kind, blocking, ...(key === undefined ? {} : { key }),
      ...(occurrences === undefined ? {} : { occurrences: Object.freeze([...occurrences]) }),
      ...(segment === undefined || segment === null ? {} : { segment }) }));
  };
  const failed = (kind: 'READ_FAILED' | 'SCAN_LIMIT_VIOLATED'): ScanOutcome => {
    finding(kind, true);
    return Object.freeze({ read: Object.freeze({ component, kind: 'FAILED' as const }), termination: 'FAILED' as const, segments: null, findings, records: [] });
  };
  if (!isRecord(scan) || scan['kind'] !== 'SCANNED') return failed('READ_FAILED');
  const accountScope = scan['accountScope'];
  // One unnamed segment (`pages`), or several named, independently terminated sub-scans (`segments`); never both.
  const segmented = 'segments' in scan;
  const rawSegments: unknown = segmented ? scan['segments'] : [{ segment: null, pages: scan['pages'] }];
  const validPages = (value: unknown): value is unknown[][] => Array.isArray(value) && value.every((page: unknown) => Array.isArray(page));
  if (!isRecord(accountScope) || !(accountScope['kind'] === 'UNKNOWN' || (accountScope['kind'] === 'CONFIRMED' && isNonEmpty(accountScope['accountId'])))
    || !isTime(scan['startedAtMs']) || !isTime(scan['endedAtMs']) || (segmented && 'pages' in scan)
    || !Array.isArray(rawSegments) || rawSegments.length === 0
    || !rawSegments.every((entry: unknown) => isRecord(entry) && (segmented ? isNonEmpty(entry['segment']) : entry['segment'] === null) && validPages(entry['pages']))) {
    return failed('READ_FAILED');
  }
  const segments = rawSegments as { segment: string | null; pages: unknown[][] }[];
  if (new Set(segments.map((entry) => entry.segment)).size !== segments.length) return failed('READ_FAILED');
  if (segments.some((entry) => entry.pages.length > limits.maxPages)) return failed('SCAN_LIMIT_VIOLATED');

  // Termination (register B9), per segment. An empty page ends a segment. A short non-empty page ends it only under a
  // confirmed terminal-page contract for this endpoint; otherwise the source must continue (to an empty page or the
  // bound), and a segment stopping there is unresolved. Records after any short page contradict termination and are
  // never ignored. The scan is clean only when every segment is.
  const segmentTerminations = segments.map((entry): SyncScanTermination => {
    const note = (kind: SyncScanFinding['finding']): void => finding(kind, true, undefined, undefined, entry.segment);
    const sizes = entry.pages.map((page) => page.length);
    const firstShort = sizes.findIndex((size) => size < limits.pageSize);
    if (sizes.some((size) => size > limits.pageSize)) { note('IRREGULAR_PAGE'); return 'UNOBSERVED'; }
    if (sizes.length === 0) { note('TERMINATION_UNOBSERVED'); return 'UNOBSERVED'; }
    if (firstShort === -1) {
      if (sizes.length === limits.maxPages) { note('SCAN_BOUNDARY_REACHED'); return 'SCAN_BOUNDARY_REACHED'; }
      note('TERMINATION_UNOBSERVED'); return 'UNOBSERVED';
    }
    if (sizes.slice(firstShort + 1).some((size) => size > 0)) { note('RECORDS_AFTER_SHORT_PAGE'); return 'UNOBSERVED'; }
    if (sizes[firstShort] === 0 || firstShort < sizes.length - 1) return 'OBSERVED_EMPTY_PAGE';
    if (contracts.terminalShortPage[component] === 'CONFIRMED') return 'CONFIRMED_TERMINAL_SHORT_PAGE';
    note('SHORT_PAGE_TERMINALITY_UNCONFIRMED'); return 'SHORT_PAGE_TERMINALITY_UNCONFIRMED';
  });
  const clean = (value: SyncScanTermination): boolean => value === 'OBSERVED_EMPTY_PAGE' || value === 'CONFIRMED_TERMINAL_SHORT_PAGE';
  const termination: SyncScanTermination = segmentTerminations.find((value) => !clean(value))
    ?? (segmentTerminations.every((value) => value === 'OBSERVED_EMPTY_PAGE') ? 'OBSERVED_EMPTY_PAGE' : 'CONFIRMED_TERMINAL_SHORT_PAGE');

  // Identity and duplicates within one scan (across all its segments), with every occurrence retained.
  const entries = new Map<string, { record: Normalized; occurrences: SyncOccurrence[]; anomalies: Set<ScannedRecord['anomalies'][number]> }>();
  const order: string[] = [];
  let malformed = false;
  let timestamps = true;
  for (const segment of segments) {
    segment.pages.forEach((page, pageIndex) => {
      page.forEach((value, position) => {
        const record = NORMALIZERS[component](value);
        if (record === null) { malformed = true; return; }
        if (!record.timestamps) timestamps = false;
        const occurrence: SyncOccurrence = Object.freeze({ ...(segment.segment === null ? {} : { segment: segment.segment }), page: pageIndex, position });
        const previous = entries.get(record.key);
        if (previous === undefined) { entries.set(record.key, { record, occurrences: [occurrence], anomalies: new Set() }); order.push(record.key); return; }
        previous.occurrences.push(occurrence);
        if (record.identity === 'CONTENT_ONLY') {
          // Identical content without a provider fill id: a duplicate or a genuine twin. Undecidable, never collapsed.
          previous.anomalies.add('CONTENT_ONLY_TWIN_UNRESOLVED');
          finding('CONTENT_IDENTITY_AMBIGUOUS', true, record.key, previous.occurrences);
          return;
        }
        if (previous.record.fingerprint !== record.fingerprint) finding('CONFLICTING_DUPLICATE', true, record.key, previous.occurrences);
        else if (previous.occurrences.some((entry) => entry.page !== pageIndex || entry.segment !== occurrence.segment)) finding('PAGE_SHIFT_OBSERVED', true, record.key, previous.occurrences);
        else { previous.anomalies.add('IDENTICAL_DUPLICATE_DEDUPED'); finding('IDENTICAL_DUPLICATE_DEDUPED', false, record.key, previous.occurrences); }
      });
    });
  }
  if (malformed) finding('RECORD_MALFORMED', true);
  const records: ScannedRecord[] = order.map((key) => {
    const entry = entries.get(key)!;
    const twins = entry.record.identity === 'CONTENT_ONLY' && entry.occurrences.length > 1;
    return Object.freeze({ ...entry.record, occurrences: Object.freeze([...entry.occurrences]), anomalies: Object.freeze([...entry.anomalies]),
      comparisonFingerprint: twins ? `${entry.record.fingerprint}|occurrences=${entry.occurrences.length}` : entry.record.fingerprint });
  });

  // A declared window: records are flagged, never filtered (timestamp and date-filter semantics are unconfirmed).
  if (history.kind === 'DECLARED_WINDOW') {
    for (const record of records) {
      if (record.times.some((time) => time === null)) finding('WINDOW_MEMBERSHIP_UNKNOWN', true, record.key);
      else if (record.times.some((time) => time! < history.fromMs || time! > history.toMs)) finding('RECORD_OUTSIDE_DECLARED_WINDOW', true, record.key);
      else if (record.times.some((time) => time === history.fromMs || time === history.toMs)) finding('WINDOW_BOUNDARY_SEMANTICS_UNKNOWN', true, record.key);
    }
  }

  const unreliable = findings.some((entry) => entry.blocking && entry.finding !== 'SCAN_BOUNDARY_REACHED');
  const pagination = termination === 'SCAN_BOUNDARY_REACHED' ? 'TRUNCATED' as const
    : (termination === 'OBSERVED_EMPTY_PAGE' || termination === 'CONFIRMED_TERMINAL_SHORT_PAGE') && !unreliable ? 'COMPLETE' as const : 'UNKNOWN' as const;
  const fillRecords = component === 'TRANSACTIONS' ? records.filter((record) => record.raw['category'] === 'FILL') : [];
  const fillIds = component !== 'TRANSACTIONS' || fillRecords.length === 0 ? 'NOT_APPLICABLE' as const
    : fillRecords.every((record) => record.identity === 'PROVIDER_FILL_ID') ? 'PRESENT' as const : 'MISSING' as const;
  const read: ComponentRead = Object.freeze({
    component, kind: 'READ' as const,
    accountScope: accountScope['kind'] === 'CONFIRMED'
      ? Object.freeze({ kind: 'CONFIRMED' as const, accountId: accountScope['accountId'] as string }) : Object.freeze({ kind: 'UNKNOWN' as const }),
    pagination, recordTimestamps: timestamps ? 'PRESENT' as const : 'MISSING' as const, fillIds,
    startedAtMs: scan['startedAtMs'], endedAtMs: scan['endedAtMs'],
    records: Object.freeze([]), // filled after ownership classification
  });
  return Object.freeze({ read, termination, findings, records,
    segments: segmented ? Object.freeze(segments.map((entry, index) => Object.freeze({ segment: entry.segment as string, termination: segmentTerminations[index]! }))) : null });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const COMPONENTS: readonly ObservationComponent[] = ['ORDERS', 'POSITIONS', 'TRANSACTIONS'];
function validConfig(value: unknown): value is SynchronizationConfig {
  if (!isRecord(value) || (value['mode'] !== 'FULL_EVIDENCE' && value['mode'] !== 'CUMULATIVE_STATE') || !isPositive(value['maxCycles'])) return false;
  const scope = value['scope'];
  if (!isRecord(scope) || !isNonEmpty(scope['accountId']) || !Array.isArray(scope['components']) || scope['components'].length === 0
    || !scope['components'].every((c: unknown) => COMPONENTS.includes(c as ObservationComponent)) || new Set(scope['components']).size !== scope['components'].length
    || !Array.isArray(scope['requiredAccounting'])) return false;
  const history = scope['history'];
  if (!isRecord(history) || !(history['kind'] === 'AVAILABLE_HISTORY'
    || (history['kind'] === 'DECLARED_WINDOW' && isTime(history['fromMs']) && isTime(history['toMs']) && (history['fromMs'] as number) < (history['toMs'] as number)))) return false;
  const limits = value['scanLimits'];
  if (!isRecord(limits) || !(scope['components'] as unknown[]).every((c) => {
    const entry = limits[c as string];
    return isRecord(entry) && isPositive(entry['pageSize']) && isPositive(entry['maxPages']);
  })) return false;
  const lineage = value['lineage'];
  if (!isRecord(lineage) || !Array.isArray(lineage['ownedOrders']) || !Array.isArray(lineage['ambiguousCreates']) || !Array.isArray(lineage['closedIntentTags'])
    || !Array.isArray(lineage['ownedPositions']) || !isNonEmpty(lineage['botTagNamespace'])) return false;
  const contracts = value['contracts'];
  if (!isRecord(contracts) || !isRecord(contracts['tagContract']) || typeof contracts['tagContract']['confirmed'] !== 'boolean') return false;
  const listOrNull = (entry: unknown): boolean => entry === null || (Array.isArray(entry) && entry.every(isNonEmpty));
  const terminal = contracts['terminalShortPage'];
  if (!isRecord(terminal) || !Object.entries(terminal).every(([component, status]) => COMPONENTS.includes(component as ObservationComponent) && status === 'CONFIRMED')) return false;
  return listOrNull(contracts['venueGeneratedOrderTypes']) && listOrNull(contracts['venueGeneratedWalletStages']) && isRecord(value['thresholds']);
}

const HISTORY_UNPROVEN = Object.freeze({
  status: 'UNPROVEN' as const,
  reasons: Object.freeze(['OBSERVED_TERMINATION_IS_NOT_PROOF_OF_COMPLETE_HISTORY', 'PAGINATION_SEMANTICS_UNKNOWN', 'RETENTION_UNKNOWN']),
});
const HISTORY_WINDOW = Object.freeze({ membership: 'FLAGGED_NEVER_FILTERED' as const, boundarySemantics: 'UNCONFIRMED' as const });
const REVOCATIONS = new Set(['STREAM_DISCONNECTED', 'DISCONNECT_DURING_WINDOW', 'RECONNECT_LATCHED', 'EPOCH_UNKNOWN', 'EPOCH_CHANGED', 'EVENT_DURING_OR_AFTER_WINDOW', 'BUFFERED_EVENTS_PENDING']);
const STREAM_UNAVAILABLE: PrivateStreamObservation = Object.freeze({
  connected: false, epoch: null, epochAtWindowStart: null, disconnectObservedSinceWindowStart: true, reconnectLatched: false,
  joinAcknowledgement: Object.freeze({ kind: 'UNKNOWN' as const }), events: Object.freeze([]), bufferedUnprocessedEvents: 0,
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Everything one cycle collected: the stream at cycle start and at evaluation, the scans by [pass][declared component
 * index], and the evaluation time. Every value is validated here, never trusted.
 */
export interface CollectedCycle {
  readonly start: unknown;
  readonly scans: readonly (readonly unknown[])[];
  readonly evaluation: unknown;
  readonly evaluatedAtMs: unknown;
}

/** A stream observation of the expected shape, or the unavailable observation (which revokes). */
function asStream(value: unknown): PrivateStreamObservation {
  return isRecord(value) && typeof value['connected'] === 'boolean' && typeof value['disconnectObservedSinceWindowStart'] === 'boolean'
    && typeof value['reconnectLatched'] === 'boolean' && Array.isArray(value['events'])
    ? value as unknown as PrivateStreamObservation : STREAM_UNAVAILABLE;
}

/**
 * Pure: evaluates one collected cycle with the engine's normalization, scan, ownership and M3 rules. Both the
 * synchronous runner and the asynchronous orchestration candidate use it, so no rule is duplicated.
 */
export function evaluateCollectedCycle(config: SynchronizationConfig, cycle: number, collected: CollectedCycle): SyncCycleResult {
  const start = asStream(collected.start);
  const evaluation = asStream(collected.evaluation);
  const evaluatedAtMs = typeof collected.evaluatedAtMs === 'number' ? collected.evaluatedAtMs : -1;
  const outcomes: ScanOutcome[][] = ([0, 1] as const).map((pass) => config.scope.components.map((component, index) =>
    evaluateScan(pass, component, config.scanLimits[component]!, config.scope.history, config.contracts, collected.scans[pass]?.[index])));

  // Ownership per pass (fills inherit the classification of their parent order in the same pass).
  const recordViews: Array<Readonly<{ pass: 0 | 1; component: ObservationComponent; records: readonly SyncRecordView[] }>> = [];
  const passes = outcomes.map((passOutcomes, index) => {
    const pass = index as 0 | 1;
    const byComponent = new Map(passOutcomes.map((outcome) => [outcome.read.component, outcome]));
    const orders = byComponent.get('ORDERS')?.records ?? [];
    const orderClasses = classifyOrders(orders, config.scope.accountId, config.lineage, config.contracts);
    const classes = new Map<string, Classified>([...orderClasses,
      ...classifyPositions(byComponent.get('POSITIONS')?.records ?? [], config.lineage),
      ...classifyTransactions(byComponent.get('TRANSACTIONS')?.records ?? [], orderClasses, config.contracts)]);
    return Object.freeze({
      reads: Object.freeze(passOutcomes.map((outcome): ComponentRead => {
        if (outcome.read.kind === 'FAILED') return outcome.read;
        const views = outcome.records.map((record): SyncRecordView => {
          const classified = classes.get(record.key)!;
          return Object.freeze({ key: record.key, identity: record.identity, fingerprint: record.fingerprint, ownership: classified.ownership, reason: classified.reason,
            occurrences: record.occurrences, anomalies: record.anomalies,
            ...(classified.stageInterpretation === undefined ? {} : { stageInterpretation: classified.stageInterpretation }) });
        });
        recordViews.push(Object.freeze({ pass, component: outcome.read.component, records: Object.freeze(views) }));
        const records: ObservedRecord[] = outcome.records.map((record) => Object.freeze({ key: record.key, fingerprint: record.comparisonFingerprint, ownership: classes.get(record.key)!.m3 }));
        return Object.freeze({ ...outcome.read, records: Object.freeze(records) });
      })),
    });
  });

  const stream: PrivateStreamObservation = Object.freeze({
    ...evaluation,
    // The engine's own cycle-start observation is the window-start epoch; a disconnect at either point counts.
    epochAtWindowStart: start.connected ? start.epoch : null,
    disconnectObservedSinceWindowStart: evaluation.disconnectObservedSinceWindowStart || !start.connected,
    reconnectLatched: evaluation.reconnectLatched || start.reconnectLatched,
  });
  const assessment = assessPracticalObservation({
    mode: config.mode,
    scope: { accountId: config.scope.accountId, components: config.scope.components, requiredAccounting: config.scope.requiredAccounting },
    thresholds: config.thresholds, passes, stream, evaluatedAtMs,
  });
  const findings = outcomes.flat().flatMap((outcome) => outcome.findings);
  const reasons = [...new Set([...assessment.reasons, ...findings.filter((entry) => entry.blocking).map((entry) => entry.finding)])].sort();
  const revoked = assessment.reasons.some((reason) => REVOCATIONS.has(reason));
  const status = revoked ? 'REVOKED' as const : reasons.length === 0 && assessment.kind === 'OBSERVED_CONVERGENCE' ? 'OBSERVED_CONVERGENCE' as const : 'UNRESOLVED' as const;
  return Object.freeze({
    cycle, status, reasons: Object.freeze(reasons),
    terminations: Object.freeze(outcomes.flat().map((outcome, index) => Object.freeze({ pass: (index < config.scope.components.length ? 0 : 1) as 0 | 1, component: outcome.read.component, termination: outcome.termination,
      ...(outcome.segments === null ? {} : { segments: outcome.segments }) }))),
    scanFindings: Object.freeze(findings), records: Object.freeze(recordViews), assessment,
  });
}

function runCycle(config: SynchronizationConfig, source: SynchronizationSource, cycle: number): SyncCycleResult {
  const call = <T>(work: () => T, fallback: T): T => { try { return work(); } catch { return fallback; } };
  const start = call((): unknown => source.stream({ cycle, point: 'CYCLE_START' }), STREAM_UNAVAILABLE);
  const scans = ([0, 1] as const).map((pass) => config.scope.components.map((component) =>
    call((): unknown => source.scan({ cycle, pass, component, accountId: config.scope.accountId, limits: config.scanLimits[component]!, history: config.scope.history }), null)));
  const evaluation = call((): unknown => source.stream({ cycle, point: 'EVALUATION' }), STREAM_UNAVAILABLE);
  const evaluatedAtMs = call((): unknown => source.clock({ cycle }), -1);
  return evaluateCollectedCycle(config, cycle, { start, scans, evaluation, evaluatedAtMs });
}

/** The explicit configuration check shared with the asynchronous orchestration candidate. */
export function isValidSynchronizationConfig(value: unknown): value is SynchronizationConfig { return validConfig(value); }
export const SYNC_HISTORY_UNPROVEN = HISTORY_UNPROVEN;
export { GRANTS_NOTHING };
export type { ObservationComponent, PrivateStreamObservation };

/**
 * Runs observation cycles until one is not revoked, or `maxCycles` is reached. A revoked cycle (private event,
 * reconnect, epoch change, disconnect, buffered events) triggers a fresh cycle; nothing from it is reused.
 */
export function runSynchronizationCandidate(config: unknown, source: SynchronizationSource): SynchronizationResult {
  if (!validConfig(config)) {
    return Object.freeze({ status: 'INVALID_CONFIGURATION' as const, semantics: 'OBSERVED_CONVERGENCE_WITHIN_DECLARED_SCAN_SCOPE' as const, history: null,
      historyCompleteness: HISTORY_UNPROVEN, historyWindow: null, cycles: Object.freeze([]), grants: GRANTS_NOTHING });
  }
  const cycles: SyncCycleResult[] = [];
  for (let cycle = 0; cycle < config.maxCycles; cycle += 1) {
    const result = runCycle(config, source, cycle);
    cycles.push(result);
    if (result.status !== 'REVOKED') break;
  }
  const last = cycles[cycles.length - 1]!;
  return Object.freeze({
    status: last.status === 'REVOKED' ? 'REVOKED_CYCLE_LIMIT_REACHED' as const : last.status,
    semantics: 'OBSERVED_CONVERGENCE_WITHIN_DECLARED_SCAN_SCOPE' as const,
    history: config.scope.history,
    historyCompleteness: HISTORY_UNPROVEN,
    historyWindow: config.scope.history.kind === 'DECLARED_WINDOW' ? HISTORY_WINDOW : null,
    cycles: Object.freeze(cycles),
    grants: GRANTS_NOTHING,
  });
}
