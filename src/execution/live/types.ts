/**
 * Phase17 live-execution domain vocabulary.
 *
 * Everything here is plain data. No type in this module confers any capability:
 * possession of a `LiveExecutionIntentContent` authorizes nothing, and the
 * runtime authority that does authorize (`LiveExecutionAuthority`) is a class
 * that cannot be expressed as a literal of any type declared here (P17-I03).
 */

/** Exchange-side order direction. Distinct from position direction. */
export type LiveOrderSide = 'BUY' | 'SELL';

/** Economic intent of the order against the account's position. */
export type LiveExecutionAction = 'OPEN' | 'CLOSE';

/**
 * Order types Phase17 will dispatch. The wire value actually sent to CoinDCX is
 * never one of these names: it is resolved from the authoritative instrument's
 * own `supportedOrderTypes` metadata (P17-I11 / §10 "do not infer undocumented
 * semantics"), so this union only expresses the two *economic* shapes Phase17
 * supports.
 */
export type LiveOrderType = 'MARKET' | 'LIMIT';

/**
 * Time-in-force semantics Phase17 is willing to claim. `UNSPECIFIED` omits the
 * field (CoinDCX documents GTC as the default). Explicit GTC/FOK/IOC survive to
 * the wire for LIMIT. POST_ONLY remains modelled only so it can be rejected
 * explicitly; the venue marks that capability unsupported.
 */
export type LiveTimeInForce =
  | 'UNSPECIFIED'
  | 'GOOD_TILL_CANCEL'
  | 'FILL_OR_KILL'
  | 'IMMEDIATE_OR_CANCEL'
  | 'POST_ONLY';

/**
 * Immutable economic content of one live order mutation. Every field here
 * participates in the intent's canonical identity (`computeLiveExecutionIntentId`),
 * so two structurally different economic requests can never share an identity,
 * and a replay of the same request always resolves to the same one (P17-I05).
 */
export interface LiveExecutionIntentContent {
  readonly accountId: string;
  readonly pair: string;
  readonly side: LiveOrderSide;
  readonly action: LiveExecutionAction;
  /** Exact fixed-point Decimal string, already aligned to the instrument increment. */
  readonly quantity: string;
  readonly orderType: LiveOrderType;
  /** Required for `LIMIT`, forbidden for `MARKET`. Exact fixed-point Decimal string. */
  readonly price: string | null;
  readonly timeInForce: LiveTimeInForce;
  /** Authoritative execution leverage, or `null` when the action does not bind one. */
  readonly leverage: string | null;
  /** Phase13 risk decision this mutation descends from (P17-I02). */
  readonly riskDecisionId: string;
  /** Phase13/Phase14 admission grant. OPEN-only; `null` for CLOSE, which is never capacity-tracked. */
  readonly admissionId: string | null;
  readonly strategyInstanceId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  /** Content-addressed Phase17 execution policy this intent is interpreted under. */
  readonly liveExecutionPolicyId: string;
  /** Authoritative CoinDCX instrument identity the economics were validated against. */
  readonly instrumentSpecSnapshotId: string;
  /** Risk-approved exposure envelope, always denominated in INR. */
  readonly authorizedNotionalInr: string;
  /** Exact authoritative INR conversion for one quote-currency unit (OPEN). */
  readonly settlementRateInrPerQuote: string | null;
  /** Durable CLOSE ownership identity. Null together for OPEN. */
  readonly positionInstanceId: string | null;
  readonly positionRevision: number | null;
  readonly reduceOnlyQuantity: string | null;
}

/**
 * Audit-only lineage. Deliberately NOT part of the identity hash (matching the
 * frozen Phase14 rule in `src/execution/identity.ts`): a genuine reissue of the
 * same research approval must never fork an existing economic identity.
 */
export interface LiveExecutionLineage {
  /**
   * OPEN-only Phase12 research approval evidence, read straight off the genuine
   * `ResearchApprovalOriginRecord` the mint itself obtained (P17-I01). `null`
   * for CLOSE, which is research-exempt by the frozen Phase14 rule.
   */
  readonly researchApproval: {
    readonly validationSubjectId: string;
    readonly validationPlanId: string;
    readonly validationSubjectResultSha256: string;
  } | null;
  /** The genuine kernel-issued `StrategyDecision` this mutation descends from. */
  readonly sourceStrategyDecisionId: string;
}

/** Durable Phase17 order states, including an explicit provider-conflict sink. */
export type LiveOrderStateName =
  | 'CREATED'
  | 'DISPATCH_RESERVED'
  | 'SUBMISSION_AMBIGUOUS'
  | 'ACKNOWLEDGED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'REJECTED'
  /** Provider truth contradicts a terminal local projection; Phase18 must reconcile it. */
  | 'RECONCILIATION_REQUIRED';

/** Independent durable ownership of a cancel mutation. */
export type LiveCancelAttemptState =
  | 'NONE'
  | 'CANCEL_RESERVED'
  | 'CANCEL_ACKNOWLEDGED'
  | 'CANCEL_AMBIGUOUS'
  | 'CANCEL_REJECTED';

/**
 * Durable projection of one live order. `cumulativeFilledQuantity` is the exact
 * authoritative fill total; `remainingQuantity` is always derivable as
 * `orderedQuantity - cumulativeFilledQuantity` and is stored only so the
 * database can be queried on it (P17-I09).
 */
export interface LiveOrderStateRecord {
  readonly intentId: string;
  readonly clientOrderId: string;
  readonly accountId: string;
  readonly pair: string;
  readonly state: LiveOrderStateName;
  /** Present only once CoinDCX has genuinely supplied one. Never fabricated (P17-I14). */
  readonly exchangeOrderId: string | null;
  readonly orderedQuantity: string;
  readonly cumulativeFilledQuantity: string;
  readonly remainingQuantity: string;
  readonly averageFillPrice: string | null;
  /** Raw, schema-validated exchange status lexeme, kept for audit. */
  readonly lastExchangeStatus: string | null;
  /**
   * Provider-supplied event time of the newest observation applied, clearly
   * labelled as exchange time rather than local time. Used only to distinguish
   * late delivery (ignored) from a fresh contradiction (fail closed).
   */
  readonly lastProviderEventTimeMs: number | null;
  /** Phase17 fault code recorded when the order reached a fail-closed state. */
  readonly faultCode: string | null;
  /** Cancellation uses a separate durable claim; it is never inferred from order state alone. */
  readonly cancelState: LiveCancelAttemptState;
  readonly cancelGeneration: number;
  readonly cancelExchangeOrderId: string | null;
  readonly cancelFaultCode: string | null;
  /**
   * [P18 Wave A2 / F18-14] `true` only once the SAME fenced transaction that is
   * the last durable checkpoint before the create-order HTTP call has committed.
   * `false` means this is a LOCAL-ONLY dispatch reservation: no wire request can
   * possibly have been sent, so a crash-recovering reconciliation generation may
   * safely reclaim it to `CREATED` with zero exchange mutation.
   */
  readonly dispatchWireArmed: boolean;
  /** [P18 Wave A2 / F18-14] The cancel-mutation equivalent of `dispatchWireArmed`. */
  readonly cancelWireArmed: boolean;
  /** Optimistic-concurrency token. Every durable state mutation bumps it. */
  readonly revision: number;
}

/** A single validated observation of exchange truth about one order. */
export type LiveOrderObservationKind =
  | 'ACKNOWLEDGED'
  | 'PARTIAL_FILL'
  | 'FILL'
  | 'CANCELLED'
  | 'REJECTED';

export interface LiveOrderObservation {
  readonly kind: LiveOrderObservationKind;
  readonly clientOrderId: string;
  /**
   * The VENUE's own `client_order_id` for this order, only when CoinDCX
   * returned one byte-identical to `clientOrderId`; otherwise null (for
   * example an order created before the id was sent, or a response that
   * carried none). The local deterministic id must never be copied in here as
   * if it were a venue echo, and a non-identical venue value is an identity
   * mismatch, never stored.
   */
  readonly exchangeClientOrderId: string | null;
  readonly exchangeOrderId: string;
  readonly pair: string;
  readonly side: LiveOrderSide;
  /** Exact cumulative filled quantity as reported, never a per-event delta. */
  readonly cumulativeFilledQuantity: string;
  readonly orderedQuantity: string;
  readonly averageFillPrice: string | null;
  readonly exchangeStatus: string;
  /** Exchange-supplied event time in epoch ms, clearly labelled as provider time. */
  readonly providerEventTimeMs: number;
}

/** Deterministic outcome of one dispatch attempt, as seen by the service layer. */
export type LiveDispatchOutcomeKind =
  | 'SUBMITTED'
  | 'ALREADY_DISPATCHED'
  | 'REJECTED'
  | 'AMBIGUOUS';

export interface LiveDispatchOutcome {
  readonly kind: LiveDispatchOutcomeKind;
  readonly order: LiveOrderStateRecord;
  /** Populated for `REJECTED`/`AMBIGUOUS` — always a Phase17 taxonomy code. */
  readonly faultCode: string | null;
}
