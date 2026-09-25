/**
 * Public Phase18 reconciliation surface.
 *
 * Deliberately inert, on exactly the Phase17 barrel's terms: pure functions,
 * plain types, a policy gate that can only refuse by default, and classes whose
 * constructors demand ports a caller cannot fabricate. Importing this barrel
 * reaches no integration module, so it can never pull in CoinDCX mutation — the
 * architecture test proves that over the true transitive import graph.
 */
export {
  currentAccountContinuityCapability,
  evaluateReconciliationBarrier,
  initialReconciliationState,
  requireCurrentReconciliation,
  type LiveAccountContinuityCapability,
  type LiveMutationKind,
  type LiveReconciliationBarrierResolution,
  type LiveReconciliationBlockReason,
} from './barrier';

export {
  assertCausalOrdering,
  assertEvidenceSetUsable,
  assertNoConflictingDuplicates,
  assertNoConflictingPositionDuplicates,
  assertOrderEvidenceConservation,
  assertProvenanceWellFormed,
  dedupeOrderEvidence,
  dedupePositionEvidence,
  evidenceSnapshotSha256,
  evidenceWindowIsSeparable,
  mergeEvidenceProvenance,
  rawEvidenceSnapshotSha256,
  rawOrderSetSha256,
  rawPositionSetSha256,
  venueOrderContentSha256,
  venuePositionContentSha256,
  LIVE_EVIDENCE_SNAPSHOT_SCHEMA,
} from './evidence';

export {
  buildFinding,
  countBlocking,
  findingSha256,
  isFindingBlocking,
  resolveAccountStatus,
  sortFindings,
  LIVE_FINDING_IDENTITY_SCHEMA,
} from './findings';

export {
  ambiguousCreateIdentityUnobservableReason,
  ambiguousCreateProofSha256,
  clientOrderIdResolutionProofSha256,
  detectOrphanVenueOrders,
  isLocallyActive,
  matchesImmutableEconomics,
  matchesProvenEconomicsForAmbiguousCreate,
  matchVenueOrdersByClientOrderId,
  observationFromEvidence,
  planClaimRecovery,
  reconcileIdentifiedOrder,
  requiresAmbiguousCreateResolution,
  resolveAmbiguousCreate,
  resolveAmbiguousCreateAgainstObservableCandidates,
  resolveAmbiguousCreateByClientOrderId,
  withinSubmissionWindow,
  LIVE_RECONCILIATION_TRANSITIONS,
  LOCALLY_ACTIVE_STATES,
  LOCALLY_TERMINAL_STATES,
  VENUE_OPEN_STATUSES,
  type AmbiguousCreateResolutionInput,
  type LiveClaimRecoveryEffect,
  type LiveClaimRecoveryPlan,
  type LiveClientOrderIdMatch,
  type LiveOrderReconciliationEffect,
  type LiveOrderReconciliationOutcome,
} from './order-reconciliation';

export {
  deriveOwnershipShares,
  ownershipLineageSha256,
  reconcilePosition,
  signedFillContribution,
  type LivePositionReconciliationEffect,
  type LivePositionReconciliationOutcome,
  type PositionReconciliationInput,
  type ProvenOwnershipShare,
} from './position-attribution';

export {
  resolveOrphanCleanupPolicy,
  OrphanCleanupPolicy,
  DEFAULT_MAX_ORPHAN_CANCELLATIONS_PER_RUN,
  MAX_ORPHAN_CANCELLATIONS_PER_RUN_CEILING,
  isValidMaxOrphanCancellationsPerRun,
  type OrphanCleanupConfigInput,
  type OrphanCleanupDisabledReason,
  type OrphanCleanupResolution,
} from './orphan-policy';

export { GatewayOrphanCancellation } from './gateway-orphan-cancellation';

export {
  accountIdentityFinding,
  accountIdentityGateSnapshotSha256,
  isProviderAccountFingerprint,
  providerAccountFingerprint,
  requireExpectedProviderAccountFingerprint,
  verifyProviderAccountIdentity,
  LIVE_PROVIDER_ACCOUNT_FINGERPRINT_PATTERN,
  type LiveProviderAccountIdentityRead,
  type LiveProviderAccountIdentityVerification,
  type LiveProviderAccountIdentityVerified,
} from './account-identity';

export {
  mintOrphanAmbiguityResolutionRequest,
  readOrphanAmbiguityResolutionRequest,
  OrphanAmbiguityResolutionRequest,
  type OrphanAmbiguityResolutionRequestRecord,
} from './orphan-resolution';

export { PrismaLiveReconciliationRepository } from './repository';

export {
  buildResolvedOrderState,
  isUnresolvedForOwnership,
  LiveReconciliationService,
  SystemReconciliationClock,
  type LiveReconciliationOutcome,
  type LiveReconciliationRunResult,
  type LiveReconciliationServiceDependencies,
  type ReconciliationClock,
} from './service';

export type {
  LiveDurableOrderReader,
  LiveDurableOrderView,
  LiveOrphanCancelClaimOutcome,
  LiveOrphanCancellationPort,
  LiveOrphanCancelResolutionRecord,
  LiveOrphanCancelResult,
  LiveOrphanVenueOrderRecord,
  LivePositionOwnershipShareInput,
  LivePositionOwnershipShareRecord,
  LiveReconciliationClaimOutcome,
  LiveReconciliationFindingRecord,
  LiveReconciliationLease,
  LiveReconciliationRepository,
  LiveReconciliationStateRecord,
  LiveVenueEvidenceProvider,
  LiveVenueOrderReadResult,
  LiveVenuePositionReadResult,
} from './ports';

export {
  isBlockingCategory,
  NON_BLOCKING_FINDING_CATEGORIES,
  type LiveEvidenceProvenance,
  type LiveOrphanCancelResolutionOutcomeName,
  type LiveOrphanCancelStateName,
  type LiveReconciliationFinding,
  type LiveReconciliationFindingCategoryName,
  type LiveReconciliationFindingCode,
  type LiveReconciliationFindingSubject,
  type LiveReconciliationRunStatusName,
  type LiveReconciliationStatusName,
  type LiveVenueEvidenceSet,
  type LiveVenueOrderEvidence,
  type LiveVenuePositionEvidence,
} from './types';
