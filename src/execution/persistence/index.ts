export { PaperPersistenceError, type PaperPersistenceFailureCode } from './errors';
export { PaperAccountOwnership, type PaperAccountOwnershipRecord } from './account-ownership';
export {
  PaperAccountRepository, SystemClock, buildBaseExposureSnapshot,
  type Clock, type PaperAccountSnapshot, type PaperPairSlotSnapshot,
} from './account-repository';
// [F14-01] Authoritative durable risk input derivation — the production
// replacement for caller-supplied account/exposure risk evidence. Pure
// durable-state derivation plus a strict (never silently rewriting)
// pair-snapshot binding check; it mints no capability and mutates nothing.
export {
  DAILY_WINDOW_MS, advanceDurablePeakEquity, deriveCloseRiskInput, deriveMarkToMarketRiskInput,
  loadAuthoritativePaperRiskBase, pairSnapshotDurableMismatch, rebaseOnAdvancedPeak,
  type AdvancePeakEquityParams, type AdvancePeakEquityResult,
  type AuthoritativeOpenPositionValuation, type AuthoritativePairSlotFacts, type AuthoritativePaperRiskBase,
  type AuthoritativePaperRiskInput, type AuthoritativeRiskInputResult, type AuthoritativeValuationEvidence,
  type DeriveAuthoritativePaperRiskInputParams, type LoadAuthoritativePaperRiskBaseParams,
} from './authoritative-risk-input';
// [F14-01] The frozen §12.4/§12.5 durable risk-state rules. Pure functions over
// durable facts — they mint nothing and hold no state of their own.
export {
  advancesPeak, nextLossState, nextPeakEquityInr, replayLossState,
  type PaperLossState, type PaperLossStatePolicy,
} from './durable-risk-state';
// [P14-D MAJ-01] `PaperAdmissionBridge` itself and its `SESSION_PROOF` token
// are deliberately NOT exported here — the only public route to durable
// admission/release is a READY `PaperAccountSession` (below). The bridge
// remains importable by its concrete module path for internal/lower-level
// tests that explicitly exercise its own logic.
export { type AdmitAndPersistResult } from './admission-bridge';
export { restoreAccountAdmissionState, type RestoreResult } from './restore';
export {
  PaperAccountSession, openPaperAccountSession, type OpenPaperAccountSessionParams,
  type PaperAccountSessionState, type PaperCloseExecutionResult, type PaperOpenExecutionResult,
} from './paper-account-session';
// [P14-G] Restart/rehydration/kernel startup sequence. `PaperAccountKernel`
// is the only production entry point — it composes around the frozen
// `openPaperAccountSession` above rather than re-exposing any lower-level
// restore primitive.
export {
  PaperAccountKernel, PaperAccountRuntime, type PaperAccountKernelState, type StartPaperAccountRuntimeParams,
  type PaperPositionRehydration, type PaperPositionRehydrationEmpty, type PaperPositionRehydrationOpen, type PaperPositionRehydrationPending,
} from './paper-account-kernel';
// [P14-E §60] `PaperExecutionEngine` itself is NOT exported here — same
// reasoning as `PaperAdmissionBridge` above: the only public route to durable
// OPEN/CLOSE economic execution is a READY `PaperAccountSession`. Its input/
// result data shapes ARE exported, since they carry no mutation capability.
export {
  type PaperExecutionSide,
  type PaperOpenExecutionInputs,
  type PaperCloseExecutionInputs,
} from './execution-engine';
export type { TrustedPaperExecutionEvidence } from '../trusted-evidence';
// [P14-H] Read-only PAPER durable reconciliation/health. `PaperAccountReconciler`
// is the only production entry point — it never mutates economic state and
// never repairs a detected mismatch; it only appends immutable
// `PaperReconciliationFault` evidence.
export {
  PaperAccountReconciler, type PaperAccountReconciliationResult, type PaperAccountReconciliationIssue,
  type PaperAccountReconciliationStatus, type PaperReconciliationFaultType,
} from './paper-account-reconciler';
