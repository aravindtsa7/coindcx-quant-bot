/**
 * Phase18 reconciliation test fixtures.
 *
 * NOTHING HERE TOUCHES COINDCX. The evidence provider is a fake that returns
 * literal fixtures, and the orphan-cancellation port is a fake that RECORDS
 * calls instead of making them — so a Phase18 test cannot send a real create or
 * cancel even by accident (§25).
 */
import {
  buildResolvedOrderState,
  type LiveOrphanCancellationPort,
  type LiveOrphanCancelResult,
  providerAccountFingerprint,
  type LiveProviderAccountIdentityRead,
  type LiveVenueEvidenceProvider,
} from '../../../../../src/execution/live/reconciliation';
import type {
  LiveEvidenceProvenance,
  LiveVenueEvidenceSet,
  LiveVenueOrderEvidence,
  LiveVenuePositionEvidence,
} from '../../../../../src/execution/live/reconciliation/types';
import type { LiveDurableOrderView } from '../../../../../src/execution/live/reconciliation/ports';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch } from '../../../../../src/execution/live/reconciliation/barrier';

export const ACCOUNT = 'account-live-1';
export const PAIR = 'B-BTC_USDT';
/** A second pair, to keep every assertion pair-generic rather than BTC-shaped. */
export const OTHER_PAIR = 'B-SOL_USDT';
export const RUNTIME_IDENTITY = newLiveRuntimeIdentity();
export const EPOCH = readLiveRuntimeEpoch(RUNTIME_IDENTITY)!;

/**
 * The provider trading-account binding every fixture runtime is configured
 * with, derived exactly as production derives it: SHA-256 of a (fake)
 * users/info `coindcx_id`. The raw fake id never appears in any artifact.
 */
export const FAKE_COINDCX_ID = 'fake-coindcx-trading-account-1';
export const EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT = providerAccountFingerprint(FAKE_COINDCX_ID);
export const MATCHING_ACCOUNT_IDENTITY: LiveProviderAccountIdentityRead = Object.freeze({
  kind: 'OBSERVED' as const,
  fingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
});

export const T_READ_START = 1_000_000;
export const T_READ_END = 1_000_500;

export function provenance(overrides: Partial<LiveEvidenceProvenance> = {}): LiveEvidenceProvenance {
  return Object.freeze({
    source: 'COINDCX_FUTURES_ORDERS',
    localReadStartedAtMs: T_READ_START,
    localReadEndedAtMs: T_READ_END,
    complete: true,
    pagesRead: 1,
    incompleteReason: null,
    ...overrides,
  });
}

export function venueOrder(overrides: Partial<LiveVenueOrderEvidence> = {}): LiveVenueOrderEvidence {
  const base = {
    exchangeOrderId: 'venue-1',
    pair: PAIR,
    side: 'BUY' as const,
    venueStatus: 'open',
    orderedQuantity: '0.5',
    filledQuantity: '0',
    remainingQuantity: '0.5',
    cancelledQuantity: '0',
    averageFillPrice: null,
    price: '64000.5',
    wireOrderType: 'limit_order',
    leverage: '5',
    providerCreatedAtMs: T_READ_START - 10_000,
    providerEventTimeMs: T_READ_START - 5_000,
    clientOrderId: null as string | null,
  };
  return Object.freeze({ ...base, ...overrides });
}

/** A venue order that is exactly `filled` filled, with conservation satisfied. */
export function filledVenueOrder(filled: string, overrides: Partial<LiveVenueOrderEvidence> = {}): LiveVenueOrderEvidence {
  const ordered = overrides.orderedQuantity ?? '0.5';
  const remaining = (Number(ordered) - Number(filled)).toString();
  const full = Number(filled) === Number(ordered);
  return venueOrder({
    venueStatus: full ? 'filled' : 'partially_filled',
    orderedQuantity: ordered,
    filledQuantity: filled,
    remainingQuantity: full ? '0' : remaining,
    cancelledQuantity: '0',
    averageFillPrice: '64000',
    ...overrides,
  });
}

export function venuePosition(overrides: Partial<LiveVenuePositionEvidence> = {}): LiveVenuePositionEvidence {
  return Object.freeze({
    venuePositionId: 'venue-position-1',
    pair: PAIR,
    signedQuantity: '0.5',
    averageEntryPrice: '64000',
    leverage: '5',
    providerEventTimeMs: T_READ_START - 5_000,
    ...overrides,
  });
}

export function evidenceSet(overrides: Partial<LiveVenueEvidenceSet> = {}): LiveVenueEvidenceSet {
  return Object.freeze({
    accountId: ACCOUNT,
    orders: Object.freeze([]),
    positions: Object.freeze([]),
    ordersProvenance: provenance({ source: 'COINDCX_FUTURES_ORDERS' }),
    // Positions are read AFTER orders, so the windows are strictly ordered and
    // therefore separable — the shape a HEALTHY verdict requires.
    positionsProvenance: provenance({
      source: 'COINDCX_FUTURES_POSITIONS',
      localReadStartedAtMs: T_READ_END,
      localReadEndedAtMs: T_READ_END + 400,
    }),
    evaluatedAtMs: T_READ_END + 500,
    ...overrides,
  });
}

export function durableOrder(overrides: Partial<LiveDurableOrderView> = {}): LiveDurableOrderView {
  return Object.freeze({
    intentId: `${'0'.repeat(62)}01`,
    clientOrderId: `p17-${'0'.repeat(30)}01`,
    accountId: ACCOUNT,
    pair: PAIR,
    state: 'ACKNOWLEDGED',
    exchangeOrderId: 'venue-1',
    side: 'BUY',
    action: 'OPEN',
    wireOrderType: 'limit_order',
    orderedQuantity: '0.5',
    cumulativeFilledQuantity: '0',
    averageFillPrice: null,
    price: '64000.5',
    leverage: '5',
    timeInForce: 'UNSPECIFIED',
    cancelState: 'NONE',
    strategyInstanceId: 'instance-1',
    strategyId: 'EMA_TREND',
    strategyVersion: '1.0.0',
    parameterHash: 'p'.repeat(64),
    instrumentSpecSnapshotId: 'spec-1',
    positionInstanceId: null,
    reduceOnlyQuantity: null,
    createdAtMs: T_READ_START - 20_000,
    updatedAtMs: T_READ_START - 1_000,
    dispatchWireArmed: false,
    cancelWireArmed: false,
    revision: 1,
    ...overrides,
  });
}

/**
 * Returns the fixed evidence it was constructed with. Makes no network call.
 *
 * [Wave B / F18-04] Implements the split `readOrders`/`readPositions` port.
 * Because it serves the SAME stored evidence on every call, two bracketed
 * reads of a static fixture are always byte-identical, so the reconciliation
 * service's snapshot-stability protocol trivially succeeds on its first
 * attempt for every existing fixed-evidence test — nothing about those tests'
 * assumptions changes. Tests that need to exercise instability construct a
 * `SequencedEvidenceProvider` instead (below) or call `setEvidence` between
 * reads via a custom port.
 */
export class FakeEvidenceProvider implements LiveVenueEvidenceProvider {
  /** Total reads of either kind. Kept for the one existing "never called" assertion. */
  public calls = 0;
  public orderCalls = 0;
  public positionCalls = 0;
  #evidence: LiveVenueEvidenceSet;

  public constructor(evidence: LiveVenueEvidenceSet) {
    this.#evidence = evidence;
  }

  public setEvidence(evidence: LiveVenueEvidenceSet): void {
    this.#evidence = evidence;
  }

  /** Separate counter: identity reads are not evidence reads. */
  public identityCalls = 0;
  public accountIdentity: LiveProviderAccountIdentityRead = MATCHING_ACCOUNT_IDENTITY;

  public async readAccountIdentity(): Promise<LiveProviderAccountIdentityRead> {
    this.identityCalls += 1;
    return this.accountIdentity;
  }

  /** Legacy single-call convenience, unused by the service but kept for direct adapter-style tests. */
  public async readAccountEvidence(): Promise<LiveVenueEvidenceSet> {
    this.calls += 1;
    return this.#evidence;
  }

  public async readOrders(): Promise<{ readonly orders: readonly LiveVenueOrderEvidence[]; readonly provenance: LiveEvidenceProvenance }> {
    this.calls += 1;
    this.orderCalls += 1;
    return { orders: this.#evidence.orders, provenance: this.#evidence.ordersProvenance };
  }

  public async readPositions(): Promise<{ readonly positions: readonly LiveVenuePositionEvidence[]; readonly provenance: LiveEvidenceProvenance }> {
    this.calls += 1;
    this.positionCalls += 1;
    return { positions: this.#evidence.positions, provenance: this.#evidence.positionsProvenance };
  }
}

/**
 * [Wave B / F18-04] Serves a DIFFERENT evidence set on each successive read of
 * the same kind, so a test can construct an exact unstable-snapshot scenario:
 * e.g. a brand-new venue order that appears only starting from the second
 * `readOrders` call. Reads beyond the configured sequence repeat the last
 * entry, so a test only has to specify as many steps as it cares about.
 */
export class SequencedEvidenceProvider implements LiveVenueEvidenceProvider {
  public orderCalls = 0;
  public positionCalls = 0;
  readonly #orderSequence: readonly (readonly LiveVenueOrderEvidence[])[];
  readonly #orderProvenanceSequence: readonly LiveEvidenceProvenance[];
  readonly #positionSequence: readonly (readonly LiveVenuePositionEvidence[])[];
  readonly #positionProvenanceSequence: readonly LiveEvidenceProvenance[];

  public constructor(input: {
    readonly orders: readonly (readonly LiveVenueOrderEvidence[])[];
    readonly ordersProvenance: readonly LiveEvidenceProvenance[];
    readonly positions: readonly (readonly LiveVenuePositionEvidence[])[];
    readonly positionsProvenance: readonly LiveEvidenceProvenance[];
  }) {
    this.#orderSequence = input.orders;
    this.#orderProvenanceSequence = input.ordersProvenance;
    this.#positionSequence = input.positions;
    this.#positionProvenanceSequence = input.positionsProvenance;
  }

  /** Separate counter: identity reads are not evidence reads. */
  public identityCalls = 0;
  public accountIdentity: LiveProviderAccountIdentityRead = MATCHING_ACCOUNT_IDENTITY;

  public async readAccountIdentity(): Promise<LiveProviderAccountIdentityRead> {
    this.identityCalls += 1;
    return this.accountIdentity;
  }

  public async readOrders(): Promise<{ readonly orders: readonly LiveVenueOrderEvidence[]; readonly provenance: LiveEvidenceProvenance }> {
    const index = Math.min(this.orderCalls, this.#orderSequence.length - 1);
    this.orderCalls += 1;
    return { orders: this.#orderSequence[index]!, provenance: this.#orderProvenanceSequence[Math.min(index, this.#orderProvenanceSequence.length - 1)]! };
  }

  public async readPositions(): Promise<{ readonly positions: readonly LiveVenuePositionEvidence[]; readonly provenance: LiveEvidenceProvenance }> {
    const index = Math.min(this.positionCalls, this.#positionSequence.length - 1);
    this.positionCalls += 1;
    return { positions: this.#positionSequence[index]!, provenance: this.#positionProvenanceSequence[Math.min(index, this.#positionProvenanceSequence.length - 1)]! };
  }
}

/**
 * Records cancellation attempts instead of performing them.
 *
 * `attempts` is what the "at most one wire cancel attempt" proofs assert on: it
 * counts calls that reached this object, which in production would be the only
 * calls that reached the gateway.
 */
export class FakeOrphanCancellation implements LiveOrphanCancellationPort {
  public readonly attempts: { readonly exchangeOrderId: string; readonly pair: string }[] = [];
  #result: LiveOrphanCancelResult;

  public constructor(result: LiveOrphanCancelResult = { kind: 'CANCELLED' }) {
    this.#result = result;
  }

  public setResult(result: LiveOrphanCancelResult): void {
    this.#result = result;
  }

  public async cancelVenueOrder(request: { readonly exchangeOrderId: string; readonly pair: string }): Promise<LiveOrphanCancelResult> {
    this.attempts.push({ exchangeOrderId: request.exchangeOrderId, pair: request.pair });
    return this.#result;
  }
}

/**
 * [Wave B / F18-04] Guarantees genuine, unbounded instability on whichever
 * side is configured: orders instability appends a uniquely-id'd synthetic
 * order to EVERY read, and positions instability alternates the reported
 * quantity by call parity, so within any single bracket (`A` then `B`, called
 * back to back) the two reads of the unstable side can never agree — no matter
 * how many attempts the service budgets. Used for the "never stabilizes;
 * retry budget exhausts" required test.
 */
export class AlwaysUnstableEvidenceProvider implements LiveVenueEvidenceProvider {
  public orderCalls = 0;
  public positionCalls = 0;
  readonly #baseOrders: readonly LiveVenueOrderEvidence[];
  readonly #ordersProvenance: LiveEvidenceProvenance;
  readonly #basePositions: readonly LiveVenuePositionEvidence[];
  readonly #positionsProvenance: LiveEvidenceProvenance;
  readonly #unstableOrders: boolean;
  readonly #unstablePositions: boolean;

  public constructor(input: {
    readonly orders: readonly LiveVenueOrderEvidence[];
    readonly ordersProvenance: LiveEvidenceProvenance;
    readonly positions: readonly LiveVenuePositionEvidence[];
    readonly positionsProvenance: LiveEvidenceProvenance;
    readonly unstableOrders?: boolean;
    readonly unstablePositions?: boolean;
  }) {
    this.#baseOrders = input.orders;
    this.#ordersProvenance = input.ordersProvenance;
    this.#basePositions = input.positions;
    this.#positionsProvenance = input.positionsProvenance;
    this.#unstableOrders = input.unstableOrders ?? false;
    this.#unstablePositions = input.unstablePositions ?? false;
  }

  /** Separate counter: identity reads are not evidence reads. */
  public identityCalls = 0;
  public accountIdentity: LiveProviderAccountIdentityRead = MATCHING_ACCOUNT_IDENTITY;

  public async readAccountIdentity(): Promise<LiveProviderAccountIdentityRead> {
    this.identityCalls += 1;
    return this.accountIdentity;
  }

  public async readOrders(): Promise<{ readonly orders: readonly LiveVenueOrderEvidence[]; readonly provenance: LiveEvidenceProvenance }> {
    this.orderCalls += 1;
    if (!this.#unstableOrders) return { orders: this.#baseOrders, provenance: this.#ordersProvenance };
    const extra = venueOrder({ exchangeOrderId: `unstable-${this.orderCalls}`, providerCreatedAtMs: T_READ_START - 1_000, providerEventTimeMs: T_READ_START - 500 });
    return { orders: Object.freeze([...this.#baseOrders, extra]), provenance: this.#ordersProvenance };
  }

  public async readPositions(): Promise<{ readonly positions: readonly LiveVenuePositionEvidence[]; readonly provenance: LiveEvidenceProvenance }> {
    this.positionCalls += 1;
    if (!this.#unstablePositions) return { positions: this.#basePositions, provenance: this.#positionsProvenance };
    const shifted = this.#basePositions.map((position) => venuePosition({
      ...position,
      signedQuantity: this.positionCalls % 2 === 0 ? '0.5' : '0.6',
    }));
    return { positions: Object.freeze(shifted), provenance: this.#positionsProvenance };
  }
}

/** A deterministic clock so no reconciliation test depends on wall time. */
export class FixedClock {
  #now: number;
  public constructor(now = T_READ_END + 1_000) { this.#now = now; }
  public nowMs(): number { return this.#now; }
  public advance(ms: number): void { this.#now += ms; }
}

/**
 * [Wave B3 / F18-23] Simulates REAL network latency between provider calls,
 * exactly like the production adapter: each `readOrders`/`readPositions`
 * call stamps `localReadStartedAtMs` from the shared clock, advances it by
 * `latencyMs`, then stamps `localReadEndedAtMs`. Content is fixed (so
 * stability holds trivially, isolating this fixture to proving F18-23's
 * separability fix rather than re-testing F18-04's stability mechanism), but
 * PROVENANCE genuinely advances across the whole `ordersA -> positionsA ->
 * ordersB -> positionsB` bracket — exactly the condition that made the
 * pre-fix merged-envelope separability check false-block a clean, stable
 * account under any real latency.
 */
export class LatencyAwareEvidenceProvider implements LiveVenueEvidenceProvider {
  public orderCalls = 0;
  public positionCalls = 0;
  readonly #clock: FixedClock;
  readonly #latencyMs: number;
  readonly #orders: readonly LiveVenueOrderEvidence[];
  readonly #positions: readonly LiveVenuePositionEvidence[];

  public constructor(input: {
    readonly clock: FixedClock;
    readonly latencyMs: number;
    readonly orders: readonly LiveVenueOrderEvidence[];
    readonly positions: readonly LiveVenuePositionEvidence[];
  }) {
    this.#clock = input.clock;
    this.#latencyMs = input.latencyMs;
    this.#orders = input.orders;
    this.#positions = input.positions;
  }

  /** Separate counter: identity reads are not evidence reads. */
  public identityCalls = 0;
  public accountIdentity: LiveProviderAccountIdentityRead = MATCHING_ACCOUNT_IDENTITY;

  public async readAccountIdentity(): Promise<LiveProviderAccountIdentityRead> {
    this.identityCalls += 1;
    return this.accountIdentity;
  }

  public async readOrders(): Promise<{ readonly orders: readonly LiveVenueOrderEvidence[]; readonly provenance: LiveEvidenceProvenance }> {
    this.orderCalls += 1;
    const localReadStartedAtMs = this.#clock.nowMs();
    this.#clock.advance(this.#latencyMs);
    const localReadEndedAtMs = this.#clock.nowMs();
    return {
      orders: this.#orders,
      provenance: Object.freeze({
        source: 'COINDCX_FUTURES_ORDERS' as const,
        localReadStartedAtMs,
        localReadEndedAtMs,
        complete: true,
        pagesRead: 1,
        incompleteReason: null,
      }),
    };
  }

  public async readPositions(): Promise<{ readonly positions: readonly LiveVenuePositionEvidence[]; readonly provenance: LiveEvidenceProvenance }> {
    this.positionCalls += 1;
    const localReadStartedAtMs = this.#clock.nowMs();
    this.#clock.advance(this.#latencyMs);
    const localReadEndedAtMs = this.#clock.nowMs();
    return {
      positions: this.#positions,
      provenance: Object.freeze({
        source: 'COINDCX_FUTURES_POSITIONS' as const,
        localReadStartedAtMs,
        localReadEndedAtMs,
        complete: true,
        pagesRead: 1,
        incompleteReason: null,
      }),
    };
  }
}

export { buildResolvedOrderState };
