/**
 * M4 (unwired review candidate): a CoinDCX read adapter for the asynchronous synchronization orchestration. It
 * implements that orchestration's `scan` source structurally (no import of the candidate modules) over the EXISTING
 * committed, M2-budgeted read client: `CoinDcxClient.listInrFuturesOrders` and `listInrFuturesPositions`, which go
 * through the existing transport, signer and shared read budget. It creates no request site, signing logic, budget
 * acquisition or unpaced fallback, constructs no client, reads no configuration or credentials, and is composed
 * nowhere.
 *
 * Supported components (only those with committed read methods):
 *   - ORDERS: list orders, read once per side (`buy`, `sell`) as two named segments, each paged and terminated
 *     independently, for an explicit set of statuses;
 *   - POSITIONS: list positions, one segment.
 * Unsupported by THIS CLIENT ADAPTER: TRANSACTIONS (`CLIENT_ADAPTER_UNSUPPORTED`). That is a statement about the
 * committed client path, not evidence that CoinDCX lacks transaction history or fill identifiers. No committed read
 * method's normalized model exposes a fill identity with an established order linkage (register B3, B13): position
 * transactions need a stage filter whose mapping is unverified, the committed trade model carries no fill id and needs
 * a pair and a date range, and wallet-activity semantics are unconfirmed (C5b–C5d). Two questions stay separate:
 * observing transaction records (not implemented here) and confirmed fill-level reconstruction or accounting (stable
 * fill semantics unresolved). A scope that requires TRANSACTIONS keeps it: the adapter returns an explicit unsupported
 * failure, which leaves the scope unresolved, instead of dropping the component or substituting another endpoint.
 *
 * Bindings and provenance. The response echoes the orchestration's binding: that is ADAPTER-LOCAL correlation, not
 * provider proof that the data belongs to the account (no read response carries an account identity). The account
 * provenance is carried separately: the injected credential binding of the authenticated client, or UNKNOWN. Unknown
 * or mismatched provenance stays unresolved downstream.
 *
 * Fields. Only fields of the committed schemas and normalizers are mapped; each mapping is listed with its basis, and
 * no provider semantics are claimed (observed field is not confirmed semantics). `client_order_id` is carried exactly
 * as returned; `client_id` is not exposed by the committed read path and is reported as such. No fill id, ownership,
 * timestamp meaning, liquidation stage or funding attribution is invented. A missing optional quantity is an explicit
 * gap, never defaulted.
 *
 * Pagination. Bounded and sequential within each segment, using the request's explicit page size and page bound. A
 * short page is never treated as terminal (no confirmed contract): reading continues to an empty page or the bound.
 * Neither endpoint takes a date filter, so a declared window is reported as unsupported and nothing is filtered.
 * History completeness is UNKNOWN.
 *
 * Cancellation. The committed read primitive accepts no abort signal. When the signal aborts, no further page is
 * requested, the in-flight page's result is abandoned, and that limitation is reported. The in-flight request keeps
 * its budget capacity until it completes or fails; the adapter never releases it.
 */
import type { CoinDcxClient } from '../client';
import type { InrFuturesOrder, InrFuturesPosition } from '../models';

/** The orchestration's request, structurally. */
export type SyncReadRequest = Readonly<{
  binding: Readonly<{ accountId: string; scopeId: string; cycle: number; pass: 0 | 1; component: string; epoch: number | null; requestId: string }>;
  limits: Readonly<{ pageSize: number; maxPages: number }>;
  history: Readonly<{ kind: 'AVAILABLE_HISTORY' }> | Readonly<{ kind: 'DECLARED_WINDOW'; fromMs: number; toMs: number }>;
  signal: AbortSignal;
}>;

export interface CoinDcxSyncReadAdapterOptions {
  /** An already-constructed, M2-budgeted authenticated read client. The adapter never constructs one. */
  readonly client: Pick<CoinDcxClient, 'listInrFuturesOrders' | 'listInrFuturesPositions'>;
  /** The existing authenticated-client provenance: the account its credentials are bound to, or UNKNOWN. */
  readonly accountProvenance: Readonly<{ kind: 'CREDENTIAL_BOUND'; accountId: string }> | Readonly<{ kind: 'UNKNOWN' }>;
  /** Explicit order statuses to read (values accepted by the committed request schema). */
  readonly orderStatuses: readonly string[];
  /** Injected local time for read timestamps. */
  readonly clock: Readonly<{ now(): number }>;
}

export type SyncReadFieldBasis = 'COMMITTED_SCHEMA_FIELD' | 'DERIVED_FROM_SCHEMA_FIELDS' | 'NOT_EXPOSED_BY_COMMITTED_READ_PATH';
export type SyncReadFieldProvenance = Readonly<{ field: string; providerField: string; basis: SyncReadFieldBasis; providerSemantics: 'NOT_CONFIRMED' }>;

const provenance = (field: string, providerField: string, basis: SyncReadFieldBasis = 'COMMITTED_SCHEMA_FIELD'): SyncReadFieldProvenance =>
  Object.freeze({ field, providerField, basis, providerSemantics: 'NOT_CONFIRMED' as const });

/** How each mapped field relates to the provider response. Observed fields only; no semantics are confirmed. */
export const SYNC_READ_FIELD_PROVENANCE = Object.freeze({
  ORDERS: Object.freeze([
    provenance('exchangeOrderId', 'id'), provenance('pair', 'pair'), provenance('side', 'side'), provenance('venueStatus', 'status'),
    provenance('orderedQuantity', 'total_quantity'), provenance('remainingQuantity', 'remaining_quantity'),
    provenance('cancelledQuantity', 'cancelled_quantity'),
    provenance('filledQuantity', 'total_quantity - remaining_quantity - cancelled_quantity', 'DERIVED_FROM_SCHEMA_FIELDS'),
    provenance('averageFillPrice', 'avg_price'), provenance('price', 'price'), provenance('wireOrderType', 'order_type'),
    provenance('leverage', 'leverage'), provenance('providerCreatedAtMs', 'created_at'), provenance('providerEventTimeMs', 'updated_at'),
    provenance('clientOrderId', 'client_order_id'),
    provenance('(none)', 'client_id', 'NOT_EXPOSED_BY_COMMITTED_READ_PATH'),
  ]),
  POSITIONS: Object.freeze([
    provenance('venuePositionId', 'id'), provenance('pair', 'pair'), provenance('signedQuantity', 'active_pos'),
    provenance('averageEntryPrice', 'avg_price'), provenance('leverage', 'leverage'), provenance('providerEventTimeMs', 'updated_at'),
  ]),
});

export type SyncReadPageProvenance = Readonly<{ segment: string; page: number; requestedSize: number; records: number; startedAtMs: number; endedAtMs: number }>;
export type SyncReadGap = Readonly<{ segment: string; page: number; key: string; field: string; gap: 'MISSING' }>;
export type SyncReadStop = 'EMPTY_PAGE' | 'SCAN_BOUND' | 'READ_FAILED' | 'CANCELLED';

export type SyncReadAdapterReport = Readonly<{
  component: string;
  support: 'SUPPORTED' | 'UNSUPPORTED';
  unsupportedReason?: 'CLIENT_ADAPTER_UNSUPPORTED' | 'UNKNOWN_COMPONENT';
  /** For TRANSACTIONS only: what the unsupported label does and does not mean. */
  unsupportedScope?: Readonly<{
    meaning: 'NOT_EVIDENCE_THAT_THE_PROVIDER_LACKS_TRANSACTION_HISTORY_OR_FILL_IDENTIFIERS';
    transactionRecordObservation: 'NOT_IMPLEMENTED_BY_THIS_ADAPTER';
    fillLevelReconstruction: 'UNRESOLVED_STABLE_FILL_SEMANTICS_UNCONFIRMED';
    substitution: 'NONE';
  }>;
  correlation: Readonly<{ kind: 'ADAPTER_LOCAL_ECHO'; providerReturnedIdentity: 'NONE' }>;
  accountProvenance: Readonly<{ source: 'AUTHENTICATED_CLIENT_CREDENTIAL_BINDING'; status: 'BOUND' | 'MISMATCH' | 'UNKNOWN'; providerAccountProof: 'NOT_IN_READ_RESPONSES' }>;
  endpoint: 'FUTURES_ORDERS' | 'FUTURES_POSITIONS' | null;
  orderStatuses: readonly string[] | null;
  pages: readonly SyncReadPageProvenance[];
  stops: readonly Readonly<{ segment: string; stop: SyncReadStop }>[];
  failure: Readonly<{ segment: string; page: number; errorName: string }> | null;
  gaps: readonly SyncReadGap[];
  fieldProvenance: readonly SyncReadFieldProvenance[];
  dateFilter: 'NOT_REQUESTED' | 'UNSUPPORTED_BY_ENDPOINT_NOT_APPLIED';
  historyCompleteness: 'UNKNOWN';
  terminalShortPage: 'NOT_ASSUMED_CONTINUED_TO_EMPTY_PAGE_OR_BOUND';
  cancellation: 'NOT_FORWARDABLE_TO_READ_PRIMITIVE_RESULT_ABANDONED';
  budget: 'SHARED_READ_BUDGET_OF_THE_INJECTED_CLIENT_NEVER_RELEASED_HERE';
}>;

const TRANSACTIONS_UNSUPPORTED_SCOPE = Object.freeze({
  meaning: 'NOT_EVIDENCE_THAT_THE_PROVIDER_LACKS_TRANSACTION_HISTORY_OR_FILL_IDENTIFIERS' as const,
  transactionRecordObservation: 'NOT_IMPLEMENTED_BY_THIS_ADAPTER' as const,
  fillLevelReconstruction: 'UNRESOLVED_STABLE_FILL_SEMANTICS_UNCONFIRMED' as const,
  substitution: 'NONE' as const,
});

const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const fixed = (value: { toFixed(): string } | null): string | null => (value === null ? null : value.toFixed());

function orderRecord(order: InrFuturesOrder, gap: (key: string, field: string) => void): Record<string, unknown> {
  const key = `order:${order.id}`;
  // A missing cancelled quantity stays missing: the record then fails the engine's validation explicitly.
  if (order.cancelledQuantity === null) gap(key, 'cancelled_quantity');
  const filled = order.cancelledQuantity === null ? null : order.totalQuantity.minus(order.remainingQuantity).minus(order.cancelledQuantity).toFixed();
  return {
    exchangeOrderId: order.id, pair: order.pair, side: order.side === 'buy' ? 'BUY' : 'SELL', venueStatus: order.status,
    orderedQuantity: order.totalQuantity.toFixed(), filledQuantity: filled, remainingQuantity: order.remainingQuantity.toFixed(),
    cancelledQuantity: fixed(order.cancelledQuantity), averageFillPrice: fixed(order.avgPriceUsdt), price: fixed(order.priceUsdt),
    wireOrderType: order.orderType, leverage: fixed(order.leverage),
    providerCreatedAtMs: order.createdAtMs, providerEventTimeMs: order.updatedAtMs,
    clientOrderId: order.clientOrderId, // exactly as the committed normalizer kept `client_order_id`
  };
}

function positionRecord(position: InrFuturesPosition): Record<string, unknown> {
  return {
    venuePositionId: position.id, pair: position.pair, signedQuantity: position.activePositionQuantity.toFixed(),
    averageEntryPrice: position.avgPriceUsdt.toFixed(), leverage: position.leverage.toFixed(), providerEventTimeMs: position.updatedAtMs,
  };
}

/** Creates the unwired adapter. Returns null for an invalid configuration (no defaults). */
export function createCoinDcxSyncReadAdapter(options: CoinDcxSyncReadAdapterOptions): Readonly<{ scan(request: SyncReadRequest): Promise<unknown> }> | null {
  const provenanceInput = options.accountProvenance;
  if (typeof options.client?.listInrFuturesOrders !== 'function' || typeof options.client.listInrFuturesPositions !== 'function'
    || typeof options.clock?.now !== 'function' || !Array.isArray(options.orderStatuses) || options.orderStatuses.length === 0
    || !options.orderStatuses.every((status) => typeof status === 'string' && /^[a-z_]+$/.test(status))
    || !(provenanceInput?.kind === 'UNKNOWN' || (provenanceInput?.kind === 'CREDENTIAL_BOUND' && typeof provenanceInput.accountId === 'string' && provenanceInput.accountId.length > 0))) {
    return null;
  }
  const { client, clock } = options;
  const statuses = Object.freeze([...options.orderStatuses]);

  async function scan(request: SyncReadRequest): Promise<unknown> {
    const binding = request.binding;
    const status: SyncReadAdapterReport['accountProvenance']['status'] = provenanceInput.kind === 'UNKNOWN' ? 'UNKNOWN'
      : provenanceInput.accountId === binding.accountId ? 'BOUND' : 'MISMATCH';
    const accountScope = provenanceInput.kind === 'UNKNOWN' ? { kind: 'UNKNOWN' as const } : { kind: 'CONFIRMED' as const, accountId: provenanceInput.accountId };
    const pages: SyncReadPageProvenance[] = [];
    const stops: Array<Readonly<{ segment: string; stop: SyncReadStop }>> = [];
    const gaps: SyncReadGap[] = [];
    let failure: SyncReadAdapterReport['failure'] = null;
    const component = binding.component;
    const endpoint = component === 'ORDERS' ? 'FUTURES_ORDERS' as const : component === 'POSITIONS' ? 'FUTURES_POSITIONS' as const : null;
    const report = (support: SyncReadAdapterReport['support'], extra: Partial<SyncReadAdapterReport> = {}): SyncReadAdapterReport => Object.freeze({
      component, support,
      correlation: Object.freeze({ kind: 'ADAPTER_LOCAL_ECHO' as const, providerReturnedIdentity: 'NONE' as const }),
      accountProvenance: Object.freeze({ source: 'AUTHENTICATED_CLIENT_CREDENTIAL_BINDING' as const, status, providerAccountProof: 'NOT_IN_READ_RESPONSES' as const }),
      endpoint, orderStatuses: component === 'ORDERS' ? statuses : null,
      pages: Object.freeze([...pages]), stops: Object.freeze([...stops]), failure, gaps: Object.freeze([...gaps]),
      fieldProvenance: component === 'ORDERS' ? SYNC_READ_FIELD_PROVENANCE.ORDERS : component === 'POSITIONS' ? SYNC_READ_FIELD_PROVENANCE.POSITIONS : Object.freeze([]),
      dateFilter: request.history.kind === 'DECLARED_WINDOW' ? 'UNSUPPORTED_BY_ENDPOINT_NOT_APPLIED' as const : 'NOT_REQUESTED' as const,
      historyCompleteness: 'UNKNOWN' as const,
      terminalShortPage: 'NOT_ASSUMED_CONTINUED_TO_EMPTY_PAGE_OR_BOUND' as const,
      cancellation: 'NOT_FORWARDABLE_TO_READ_PRIMITIVE_RESULT_ABANDONED' as const,
      budget: 'SHARED_READ_BUDGET_OF_THE_INJECTED_CLIENT_NEVER_RELEASED_HERE' as const,
      ...extra,
    });
    if (endpoint === null) {
      return Object.freeze({ binding, scan: Object.freeze({ kind: 'FAILED' as const }),
        adapter: report('UNSUPPORTED', component === 'TRANSACTIONS'
          ? { unsupportedReason: 'CLIENT_ADAPTER_UNSUPPORTED', unsupportedScope: TRANSACTIONS_UNSUPPORTED_SCOPE }
          : { unsupportedReason: 'UNKNOWN_COMPONENT' }) });
    }
    if (!isPositive(request.limits.pageSize) || !isPositive(request.limits.maxPages)) {
      return Object.freeze({ binding, scan: Object.freeze({ kind: 'FAILED' as const }), adapter: report('SUPPORTED') });
    }

    const startedAtMs = clock.now();
    const segments: Array<{ segment: string; pages: Record<string, unknown>[][] }> = [];
    const plan: readonly string[] = endpoint === 'FUTURES_ORDERS' ? ['side=buy', 'side=sell'] : ['all'];
    let cancelled = false;
    for (const segment of plan) {
      if (failure !== null || cancelled) break;
      const segmentPages: Record<string, unknown>[][] = [];
      let stop: SyncReadStop = 'SCAN_BOUND';
      for (let page = 1; page <= request.limits.maxPages; page += 1) {
        if (request.signal.aborted) { cancelled = true; stop = 'CANCELLED'; break; }
        const pageStartedAtMs = clock.now();
        let rows: Record<string, unknown>[];
        try {
          const size = String(request.limits.pageSize);
          if (endpoint === 'FUTURES_ORDERS') {
            const side = segment === 'side=buy' ? 'buy' as const : 'sell' as const;
            const batch = await client.listInrFuturesOrders({ status: statuses.join(','), side, page: String(page), size });
            rows = batch.map((order) => orderRecord(order, (key, field) => gaps.push(Object.freeze({ segment, page, key, field, gap: 'MISSING' as const }))));
          } else {
            const batch = await client.listInrFuturesPositions({ page: String(page), size });
            rows = batch.map(positionRecord);
          }
        } catch (error) {
          failure = Object.freeze({ segment, page, errorName: error instanceof Error ? error.name : typeof error });
          stop = 'READ_FAILED';
          break;
        }
        // The read primitive cannot be aborted: a result that arrives after cancellation is abandoned.
        if (request.signal.aborted) { cancelled = true; stop = 'CANCELLED'; break; }
        pages.push(Object.freeze({ segment, page, requestedSize: request.limits.pageSize, records: rows.length, startedAtMs: pageStartedAtMs, endedAtMs: clock.now() }));
        segmentPages.push(rows);
        if (rows.length === 0) { stop = 'EMPTY_PAGE'; break; } // a short non-empty page is not assumed terminal
      }
      stops.push(Object.freeze({ segment, stop }));
      segments.push({ segment, pages: segmentPages });
    }
    if (failure !== null || cancelled) {
      return Object.freeze({ binding, scan: Object.freeze({ kind: 'FAILED' as const }), adapter: report('SUPPORTED') });
    }
    const scanBody = endpoint === 'FUTURES_ORDERS'
      ? { segments: segments.map((entry) => ({ segment: entry.segment, pages: entry.pages })) }
      : { pages: segments[0]!.pages };
    return Object.freeze({
      binding,
      scan: Object.freeze({ kind: 'SCANNED' as const, accountScope, startedAtMs, endedAtMs: clock.now(), ...scanBody }),
      adapter: report('SUPPORTED'),
    });
  }

  return Object.freeze({ scan });
}
