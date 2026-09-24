/**
 * [P18] The authoritative venue-evidence adapter (§5, §14, §20).
 *
 * This implements the execution-owned `LiveVenueEvidenceProvider` port over the
 * ALREADY-EXISTING, production-verified authenticated CoinDCX read path
 * (`../client.ts` -> `../transport.ts`). It deliberately introduces no new
 * endpoint, no new signing site, and no new HTTP owner: Phase 2 already
 * established `FUTURES_ORDERS` and `FUTURES_POSITIONS` as read-only signed
 * reads, and Phase 18 reuses that contract rather than re-verifying one of its
 * own.
 *
 * It is also strictly read-only. It cannot cancel, create, or modify anything
 * — the read client has no mutation method at all, which the Phase 17
 * architecture test already pins. Orphan cancellation travels the separate,
 * approved Phase 17 mutation gateway.
 *
 * COMPLETENESS IS THE WHOLE POINT (§14). `provenance.complete` is set ONLY when
 * pagination genuinely reached an empty page. Every other exit — the page
 * guard, a provider failure, a validation refusal — returns `complete: false`
 * with a named reason, and the reconciler then refuses to treat absence as
 * proof of non-existence.
 */
import Decimal from 'decimal.js';
import type {
  LiveEvidenceProvenance,
  LiveVenueEvidenceSet,
  LiveVenueOrderEvidence,
  LiveVenuePositionEvidence,
} from '../../../execution/live/reconciliation/types';
import type { LiveVenueEvidenceProvider } from '../../../execution/live/reconciliation/ports';
import { createChildLogger } from '../../../monitoring/logger';
import { Clock, SystemClock } from '../clock';
import type { CoinDcxClient } from '../client';
import type { InrFuturesOrder, InrFuturesPosition } from '../models';
import { LiveExecutionError } from '../../../execution/live/errors';

const logger = createChildLogger('coindcx:live-reconciliation-evidence');

/**
 * Every documented futures order status. Reconciliation must see terminal
 * statuses too: an order absent from an "open only" read has NOT been proven
 * absent from the venue, merely absent from that filter.
 */
const OBSERVATION_STATUSES = 'open,filled,partially_filled,partially_cancelled,cancelled,rejected,untriggered';

/** Requested page size only. The futures provider's real cap is NOT verified. */
const REQUESTED_PAGE_SIZE = '100';

/**
 * Finite loop guard. Reaching it is never evidence that pagination is
 * exhausted — it produces `complete: false`, exactly as Phase17's adapter
 * returns an explicit pagination-limit ambiguity rather than NOT_FOUND.
 */
export const COINDCX_RECONCILIATION_MAX_PAGES = 100;

/**
 * [Wave B2 / F18-22] Implementation-owned hard ceiling. No configuration
 * input may exceed this, ever — it is not merely a default, it is the maximum
 * ANY caller-supplied `maxPages` may request. A caller-controlled unbounded
 * value here would let a misconfiguration turn "finite guard" into an
 * effectively unbounded read loop.
 */
export const COINDCX_RECONCILIATION_MAX_PAGES_CEILING = 2_000;

/**
 * [Wave B2 / F18-22] Confirmed exploit: `maxPages = 0` (or `NaN`, negative,
 * fractional, `Infinity`) makes the page loop's `page <= maxPages` condition
 * false on its very first check, so the loop body never executes. Zero pages
 * are read, `pagesRead` stays `0`, `incompleteReason` stays `null`, and the
 * adapter reports `complete: true` — an authoritative-looking empty result
 * that never actually asked the venue anything. Refuses eagerly, at
 * construction time, rather than letting a misconfigured adapter silently
 * fabricate completeness on every subsequent call.
 */
function validateMaxPages(value: number | undefined): number {
  if (value === undefined) return COINDCX_RECONCILIATION_MAX_PAGES;
  if (!Number.isSafeInteger(value) || value < 1 || value > COINDCX_RECONCILIATION_MAX_PAGES_CEILING) {
    throw new LiveExecutionError('LIVE_RECONCILIATION_EVIDENCE_INVALID', 'maxPages must be a safe positive integer within the implementation-owned ceiling', {
      details: { value, ceiling: COINDCX_RECONCILIATION_MAX_PAGES_CEILING },
    });
  }
  return value;
}

function exact(value: Decimal | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed();
}

function requiredExact(value: Decimal): string {
  return value.toFixed();
}

/**
 * Translates one validated read-client order into evidence.
 *
 * `cancelled_quantity` is optional in the Phase 2 contract; a missing value is
 * treated as zero ONLY because the same contract guarantees
 * `total = remaining + cancelled + filled`, and the conservation check in
 * `evidence.ts` re-proves that identity afterwards. If the identity fails, the
 * record fails closed there rather than being silently accepted here.
 */
/**
 * [Wave B4 / F18-24] Deliberately does not map a time-in-force field:
 * `LiveOrderEconomicsSchema` (`wire-schemas.ts`) carries none, because no
 * authoritative TIF field is documented in the verified CoinDCX futures
 * observation contract available to this project (`docs/PHASE18_RECONCILIATION.md`
 * §8). That is a statement about what has been verified and documented, not a
 * claim that the provider is structurally incapable of ever returning one —
 * this project cannot prove a universal negative about an external API.
 * `LiveVenueOrderEvidence` therefore has no `timeInForce` field to populate,
 * and `ambiguousCreateIdentityUnobservableReason` (F18-21) is the durable
 * enforcement point that keeps automatic ambiguous-create resolution blocked
 * on the absence of verified evidence — not on an absolute claim about the
 * provider. See the wire-schema doc comment for the exact sequence required
 * before this could ever change.
 */
function toOrderEvidence(order: InrFuturesOrder): LiveVenueOrderEvidence | null {
  if (order.marginCurrency !== 'INR') return null;
  const total = requiredExact(order.totalQuantity);
  const remaining = requiredExact(order.remainingQuantity);
  const cancelled = order.cancelledQuantity === null ? '0' : requiredExact(order.cancelledQuantity);
  const filled = new Decimal(total).minus(new Decimal(remaining)).minus(new Decimal(cancelled));
  const average = exact(order.avgPriceUsdt);
  return Object.freeze({
    exchangeOrderId: order.id,
    pair: order.pair,
    side: order.side === 'buy' ? 'BUY' as const : 'SELL' as const,
    venueStatus: order.status,
    orderedQuantity: total,
    filledQuantity: filled.toFixed(),
    remainingQuantity: remaining,
    cancelledQuantity: cancelled,
    // A zero fill must carry NO average price, and a positive fill must carry
    // one. Normalizing here keeps the conservation rule in `evidence.ts` the
    // single place that decides whether the pair is coherent.
    averageFillPrice: filled.isZero() ? null : average,
    price: exact(order.priceUsdt),
    wireOrderType: order.orderType,
    leverage: exact(order.leverage),
    providerCreatedAtMs: order.createdAtMs,
    providerEventTimeMs: order.updatedAtMs,
  });
}

/**
 * Translates one validated position. `activePositionQuantity` is already
 * SIGNED by the Phase 2 normalizer (negative short, positive long, zero flat),
 * which is exactly the representation the attribution arithmetic needs.
 */
function toPositionEvidence(position: InrFuturesPosition): LiveVenuePositionEvidence | null {
  if (position.marginCurrency !== 'INR') return null;
  return Object.freeze({
    venuePositionId: position.id,
    pair: position.pair,
    signedQuantity: requiredExact(position.activePositionQuantity),
    averageEntryPrice: exact(position.avgPriceUsdt),
    leverage: exact(position.leverage),
    providerEventTimeMs: position.updatedAtMs,
  });
}

export interface CoinDcxReconciliationEvidenceAdapterOptions {
  /** An already-constructed authenticated read client. Credentials never reach this class. */
  readonly client: CoinDcxClient;
  /** Immutable identity of the account owned by the supplied credentials. */
  readonly credentialAccountId: string;
  readonly clock?: Clock | undefined;
  readonly maxPages?: number | undefined;
}

export class CoinDcxReconciliationEvidenceAdapter implements LiveVenueEvidenceProvider {
  readonly #client: CoinDcxClient;
  readonly #credentialAccountId: string;
  readonly #clock: Clock;
  readonly #maxPages: number;

  public constructor(options: CoinDcxReconciliationEvidenceAdapterOptions) {
    this.#client = options.client;
    if (options.credentialAccountId.length === 0) throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Credential account id is required');
    this.#credentialAccountId = options.credentialAccountId;
    this.#clock = options.clock ?? new SystemClock();
    this.#maxPages = validateMaxPages(options.maxPages);
  }

  /**
   * [Wave A/B] Retained as a convenience for callers that only need ONE
   * evidence set (e.g. diagnostics, the credential-binding test). Production
   * reconciliation (`../../../execution/live/reconciliation/service.ts`) does
   * NOT use this: it calls `readOrders`/`readPositions` directly, more than
   * once each, to run the bracketed snapshot-stability protocol (§F18-04). A
   * single call here is exactly as non-atomic as it always was — the two
   * reads are sequential and their windows are recorded separately.
   */
  public async readAccountEvidence(request: {
    readonly accountId: string;
    readonly pairs: readonly string[];
    readonly timeoutMs: number;
  }): Promise<LiveVenueEvidenceSet> {
    if (request.accountId !== this.#credentialAccountId) {
      throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Evidence credentials are bound to a different account');
    }
    const orders = await this.#readOrders();
    const positions = await this.#readPositions();

    return Object.freeze({
      accountId: this.#credentialAccountId,
      orders: orders.records,
      positions: positions.records,
      ordersProvenance: orders.provenance,
      positionsProvenance: positions.provenance,
      evaluatedAtMs: this.#clock.nowMs(),
    });
  }

  /** [Wave B / F18-04] Port method: one authoritative orders read. */
  public async readOrders(request: {
    readonly accountId: string;
    readonly pairs: readonly string[];
    readonly timeoutMs: number;
  }): Promise<{ readonly orders: readonly LiveVenueOrderEvidence[]; readonly provenance: LiveEvidenceProvenance }> {
    if (request.accountId !== this.#credentialAccountId) {
      throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Evidence credentials are bound to a different account');
    }
    const orders = await this.#readOrders();
    return { orders: orders.records, provenance: orders.provenance };
  }

  /** [Wave B / F18-04] Port method: one authoritative positions read. */
  public async readPositions(request: {
    readonly accountId: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly positions: readonly LiveVenuePositionEvidence[]; readonly provenance: LiveEvidenceProvenance }> {
    if (request.accountId !== this.#credentialAccountId) {
      throw new LiveExecutionError('LIVE_AUTHORITY_INVALID', 'Evidence credentials are bound to a different account');
    }
    const positions = await this.#readPositions();
    return { positions: positions.records, provenance: positions.provenance };
  }

  /**
   * Reads every futures order across both sides and all pages.
   *
   * The List Orders contract requires an explicit `side`, so completeness means
   * exhausting BOTH sides: a read that finished `buy` but failed on `sell` is
   * incomplete, and says so.
   */
  async #readOrders(): Promise<{
    readonly records: readonly LiveVenueOrderEvidence[];
    readonly provenance: LiveEvidenceProvenance;
  }> {
    const startedAtMs = this.#clock.nowMs();
    const records: LiveVenueOrderEvidence[] = [];
    let pagesRead = 0;
    let incompleteReason: string | null = null;

    for (const side of ['buy', 'sell'] as const) {
      if (incompleteReason !== null) break;
      for (let page = 1; page <= this.#maxPages; page += 1) {
        let batch: readonly InrFuturesOrder[];
        try {
          batch = await this.#client.listInrFuturesOrders({
            status: OBSERVATION_STATUSES,
            side,
            page: String(page),
            size: REQUESTED_PAGE_SIZE,
          });
        } catch (error) {
          // A provider or validation failure is NOT an empty result. Never
          // report the scan as complete after one.
          logger.error({ side, page, failure: (error as Error).name }, 'CoinDCX order evidence read failed');
          incompleteReason = `ORDER_READ_FAILED_${side.toUpperCase()}_PAGE_${page}`;
          break;
        }
        pagesRead += 1;

        // Only an empty page proves exhaustion. The current futures contract
        // does not establish that a short non-empty page is terminal, so every
        // non-empty page is followed regardless of its length.
        if (batch.length === 0) break;

        for (const order of batch) {
          const evidence = toOrderEvidence(order);
          if (evidence === null) {
            incompleteReason = 'ORDER_OUTSIDE_INR_SCOPE';
            break;
          }
          records.push(evidence);
        }
        if (incompleteReason !== null) break;

        if (page === this.#maxPages) {
          incompleteReason = `ORDER_PAGINATION_LIMIT_${side.toUpperCase()}`;
          break;
        }
      }
    }

    return {
      records: Object.freeze(records),
      provenance: Object.freeze({
        source: 'COINDCX_FUTURES_ORDERS' as const,
        localReadStartedAtMs: startedAtMs,
        localReadEndedAtMs: this.#clock.nowMs(),
        // [Wave B2 / F18-22 defense-in-depth] Completeness requires a
        // genuine traversal-termination condition to have been REACHED, which
        // is only possible after at least one real page request. Constructor
        // validation already makes `pagesRead === 0` unreachable through a
        // misconfigured `maxPages`, but this keeps the invariant true even if
        // that guard were ever bypassed or this method were reached some
        // other way — zero attempted reads can never license `complete: true`.
        complete: incompleteReason === null && pagesRead > 0,
        pagesRead,
        incompleteReason: incompleteReason ?? (pagesRead === 0 ? 'NO_PAGES_READ' : null),
      }),
    };
  }

  async #readPositions(): Promise<{
    readonly records: readonly LiveVenuePositionEvidence[];
    readonly provenance: LiveEvidenceProvenance;
  }> {
    const startedAtMs = this.#clock.nowMs();
    const records: LiveVenuePositionEvidence[] = [];
    let pagesRead = 0;
    let incompleteReason: string | null = null;

    for (let page = 1; page <= this.#maxPages; page += 1) {
      let batch: readonly InrFuturesPosition[];
      try {
        // Deliberately UNSCOPED by pair: reconciliation must be able to see a
        // venue position on a pair this system holds no local order for, which
        // is exactly the unattributed-exposure case (§10).
        batch = await this.#client.listInrFuturesPositions({ page: String(page), size: REQUESTED_PAGE_SIZE });
      } catch (error) {
        logger.error({ page, failure: (error as Error).name }, 'CoinDCX position evidence read failed');
        incompleteReason = `POSITION_READ_FAILED_PAGE_${page}`;
        break;
      }
      pagesRead += 1;
      if (batch.length === 0) break;

      for (const position of batch) {
        const evidence = toPositionEvidence(position);
        if (evidence === null) {
          incompleteReason = 'POSITION_OUTSIDE_INR_SCOPE';
          break;
        }
        records.push(evidence);
      }
      if (incompleteReason !== null) break;

      if (page === this.#maxPages) {
        incompleteReason = 'POSITION_PAGINATION_LIMIT';
        break;
      }
    }

    return {
      records: Object.freeze(records),
      provenance: Object.freeze({
        source: 'COINDCX_FUTURES_POSITIONS' as const,
        localReadStartedAtMs: startedAtMs,
        localReadEndedAtMs: this.#clock.nowMs(),
        // [Wave B2 / F18-22 defense-in-depth] See `#readOrders`'s identical comment.
        complete: incompleteReason === null && pagesRead > 0,
        pagesRead,
        incompleteReason: incompleteReason ?? (pagesRead === 0 ? 'NO_PAGES_READ' : null),
      }),
    };
  }
}
