export { PaperConfigError, PaperEngineError, paperSourceInvalid, type PaperEngineFailureCode } from './errors';
export {
  assertQuantityAligned, canonicalPaperDecimalString, ceilToTick, floorToTick, paperDecimal, paperMax, paperMin,
  PaperCalcDecimal, PaperDecimal, PAPER_ONE, PAPER_ZERO, toPaperCalcDecimal,
  MAX_PAPER_INTEGER_DIGITS, MAX_PAPER_PRECISION, MAX_PAPER_SCALE,
  type PaperCalc, type PaperDecimalInput,
} from './decimal';
export {
  buildExecutionPolicySnapshot, EXECUTION_POLICY_VERSION,
  type ExecutionPolicySnapshot, type ExecutionPolicySnapshotContent, type MarketEvidenceEligibilityPolicy,
} from './policy';
export {
  computeCloseExecutionIntentId, computeOpenExecutionIntentId, computePositionInstanceId, computeSourceExecutionKey,
  CLOSE_EXECUTION_INTENT_IDENTITY_POLICY_ID, OPEN_EXECUTION_INTENT_IDENTITY_POLICY_ID,
  POSITION_INSTANCE_IDENTITY_POLICY_ID, SOURCE_EXECUTION_IDENTITY_POLICY_ID,
  type CloseExecutionIntentIdentityInput, type OpenExecutionIntentIdentityInput,
  type PositionInstanceIdentityInput, type SourceExecutionKeyInput,
} from './identity';
// `mintPaperOpenExecutionAuthority`/`mintPaperCloseExecutionAuthority` and their
// raw mint-input/evidence types (`MintPaperOpenExecutionAuthorityInput`,
// `PaperOpenRiskEvidence`, etc.) are deliberately NOT re-exported here — see the
// doc comments on those functions in `open-authority.ts`/`close-authority.ts`.
// Only the authority classes and their read-only record/binding shapes (no mint
// capability) belong on the public barrel.
export { PaperOpenExecutionAuthority, type PaperOpenExecutionAuthorityRecord } from './open-authority';
export {
  PaperCloseExecutionAuthority, type PaperClosePositionBinding, type PaperCloseExecutionAuthorityRecord,
} from './close-authority';
export type { PaperExecutionQuoteSnapshot } from './evidence';
export type { TrustedPaperExecutionEvidence } from './trusted-evidence';
export type { PaperMarkSnapshot } from './mark';
export {
  computeAvailableMargin, computeCashBalance, computeEquity, computeFeeInr, computeFundingPnlInr,
  computeRealizedPnlInr, computeUnrealizedPnlInr, quantizePaperPosting,
  type AvailableMarginInputs, type CashBalanceInputs, type FundingPnlInputs, type RealizedPnlInputs, type UnrealizedPnlInputs,
} from './accounting';
export { resolveExecutionAction, type NoExecutionOutcome, type PaperExecutionAction, type UnsupportedStrategyRiskAction } from './action';
