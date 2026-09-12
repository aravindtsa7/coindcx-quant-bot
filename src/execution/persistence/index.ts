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
export { PaperAccountSession, openPaperAccountSession, type OpenPaperAccountSessionParams, type PaperAccountSessionState } from './paper-account-session';
