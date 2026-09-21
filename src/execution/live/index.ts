/**
 * Public Phase17 live-execution surface.
 *
 * Deliberately ABSENT from this barrel:
 *   - `mintLiveOpenExecutionAuthority` / `mintLiveCloseExecutionAuthority`
 *     (`./authority`) — the same rule Phase14 applies to its paper mints. Only
 *     a module that imports the authority file directly can mint, and only the
 *     production composition is supposed to.
 *   - `createLiveExecutionIntent` (`./intent`) — intents are produced by a mint
 *     from authoritative risk output, never hand-built by a caller.
 *   - `./composer` — importing it pulls in the mutable CoinDCX adapter. Keeping
 *     it off the barrel is what lets the architecture test prove that this
 *     barrel reaches no integration code at all, transitively.
 *
 * What remains is inert: read-only classes, pure identity/policy/state
 * functions, plain types, and the service/repository whose constructors demand
 * dependencies a caller cannot fabricate.
 */
export {
  LiveExecutionError,
  LIVE_AMBIGUOUS_CODES,
  assertCredentialFree,
  type LiveExecutionFailureCode,
} from './errors';

export {
  canonicalLiveDecimalString,
  canonicalNonNegativeLiveDecimal,
  canonicalPersistedLiveDecimal,
  canonicalPositiveLiveDecimal,
  ceilToIncrement,
  floorToIncrement,
  isAlignedToIncrement,
  liveDecimal,
  LiveCalcDecimal,
  MAX_LIVE_INTEGER_DIGITS,
  MAX_LIVE_PRECISION,
  MAX_LIVE_SCALE,
  type LiveCalc,
  type LiveDecimalInput,
} from './decimal';

export type {
  LiveCancelAttemptState,
  LiveDispatchOutcome,
  LiveDispatchOutcomeKind,
  LiveExecutionAction,
  LiveExecutionIntentContent,
  LiveExecutionLineage,
  LiveOrderObservation,
  LiveOrderObservationKind,
  LiveOrderSide,
  LiveOrderStateName,
  LiveOrderStateRecord,
  LiveOrderType,
  LiveTimeInForce,
} from './types';

export {
  computeLiveExecutionIntentId,
  deriveLiveClientOrderId,
  isLiveClientOrderId,
  liveExecutionIntentIdentityPreimage,
  LIVE_CLIENT_ORDER_ID_LENGTH,
  LIVE_CLIENT_ORDER_ID_PATTERN,
  LIVE_CLIENT_ORDER_ID_POLICY_ID,
  LIVE_CLIENT_ORDER_ID_PREFIX,
  LIVE_EXECUTION_INTENT_IDENTITY_POLICY_ID,
} from './identity';

export {
  buildLiveExecutionPolicySnapshot,
  defaultLiveExecutionPolicyContent,
  normalizeLiveExecutionPolicyContent,
  validateLiveExecutionPolicySnapshot,
  LIVE_EXECUTION_POLICY_VERSION,
  type LiveExecutionPolicyContent,
  type LiveExecutionPolicySnapshot,
} from './execution-policy';

export {
  resolveLiveExecutionGate,
  requireLiveExecutionEnabled,
  LiveExecutionEnablement,
  type LiveExecutionConfigInput,
  type LiveExecutionDisabledReason,
  type LiveExecutionEnablementRecord,
  type LiveExecutionGateResolution,
} from './gate';

export {
  assertOrderWithinInstrumentConstraints,
  quantizeOrderEconomics,
  resolveWireOrderType,
  type AuthoritativeInstrumentConstraints,
  type QuantizedOrderEconomics,
} from './instrument-constraints';

export {
  LiveExecutionIntent,
  assertLiveExecutionIntentIdentity,
  type LiveExecutionIntentRecord,
  type LiveExecutionShapeRequest,
} from './intent';

export {
  LiveExecutionAuthority,
  readLiveAuthorityForIntent,
  type LiveClosePositionBinding,
  type LiveExecutionAuthorityRecord,
} from './authority';

export {
  applyLiveOrderObservation,
  initialLiveOrderState,
  isLiveTerminalState,
  markCancelAmbiguous,
  markSubmissionAmbiguous,
  releaseDispatchClaim,
  requestCancel,
  reserveDispatch,
  LIVE_ORDER_TRANSITIONS,
  LIVE_TERMINAL_STATES,
  type ObservationApplication,
} from './state-machine';

export type {
  CoinDcxFuturesOrderGateway,
  LiveCancelOrderRequest,
  LiveCancelOrderResult,
  LiveFetchOrderRequest,
  LiveFetchOrderResult,
  LivePlaceOrderRequest,
  LivePlaceOrderResult,
} from './gateway';

export {
  PrismaLiveExecutionRepository,
  liveExecutionIntentContentSha256,
  observationSha256,
  type ClaimCancelOutcome,
  type ClaimDispatchOutcome,
  type CompleteCancelAttemptOutcome,
  type LiveExecutionRepository,
} from './repository';

export {
  LiveExecutionService,
  type LiveCancelOutcome,
  type LiveCancelOutcomeKind,
  type LiveExecutionServiceDependencies,
} from './service';
