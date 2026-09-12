export { PaperPersistenceError, type PaperPersistenceFailureCode } from './errors';
export { PaperAccountOwnership, type PaperAccountOwnershipRecord } from './account-ownership';
export {
  PaperAccountRepository, SystemClock, buildBaseExposureSnapshot,
  type Clock, type PaperAccountSnapshot, type PaperPairSlotSnapshot,
} from './account-repository';
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
