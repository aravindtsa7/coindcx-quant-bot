/**
 * Phase 18B practical live safety — public barrel (Stage 1A).
 *
 * Pure domain only. Nothing exported here can MINT authority. Deliberately NOT
 * exported (each is an internal issuance boundary whose production importer
 * set an architecture test pins to exactly empty in Stage 1A):
 *   - `issuePracticalLiveSafetyEnablement` (`./policy`): the barrel exports
 *     only `evaluatePracticalLiveSafetyConfig`, which returns data, never an
 *     enablement;
 *   - `mintPracticalManualReviewResolution` (`./state-machine`): the barrel
 *     exports the resolution only as a TYPE;
 *   - `issuePracticalRecoveryCertificate` (`./certificate`);
 *   - any gate, authorization function, or strict/practical selector — Stage
 *     1A has none, and gate selection will be fixed by trusted composition,
 *     never by a caller.
 * Nothing in this tree is wired into the runtime yet.
 */
export {
  PRACTICAL_ACCOUNT_STATES,
  PRACTICAL_AUTHORIZATION_BASIS,
  PRACTICAL_INVALIDATION_REASONS,
  PRACTICAL_MUTATION_ACTIONS,
  PRACTICAL_MUTATION_OUTCOMES,
  PracticalLiveSafetyError,
  isPracticalAccountStateName,
  isPracticalInvalidationReason,
  isPracticalMutationAction,
  type PracticalAccountStateName,
  type PracticalAuthorizationBasis,
  type PracticalInvalidationReason,
  type PracticalInvalidationSeverity,
  type PracticalLiveSafetyErrorCode,
  type PracticalMutationAction,
  type PracticalMutationOutcome,
  type PracticalQuarantineCause,
} from './types';

export {
  PRACTICAL_ROLLOUT_STAGES,
  PRACTICAL_SAFETY_CEILINGS,
  PRACTICAL_TIMING_CANDIDATES,
  VERIFIED_REDUCE_ONLY_CAPABILITY,
  PracticalLiveSafetyEnablement,
  evaluatePracticalLiveSafetyConfig,
  isAtLeastAsStrictAsCeilings,
  isPracticalRolloutStage,
  practicalActionPermission,
  requirePracticalLiveSafetyEnablement,
  type PracticalActionPermission,
  type PracticalActionRefusal,
  type PracticalLiveSafetyConfigEvaluation,
  type PracticalLiveSafetyConfigInput,
  type PracticalLiveSafetyDisabledReason,
  type PracticalLiveSafetyEnablementRecord,
  type PracticalLiveSafetyResolution,
  type PracticalRolloutStage,
  type PracticalSafetyCeilings,
  type PracticalTimingCandidate,
  type PracticalTimingCandidates,
} from './policy';

export {
  PRACTICAL_ALLOWED_TRANSITIONS,
  practicalAccountStateOnStartup,
  practicalStateAfterTransitionFailure,
  transitionPracticalAccountState,
  type PracticalManualReviewResolution,
  type PracticalManualReviewResolutionRecord,
  type PracticalTransitionEvent,
} from './state-machine';

export {
  PracticalRecoveryCertificate,
  consumePracticalRecoveryCertificate,
  revokePracticalRecoveryCertificate,
  verifyPracticalRecoveryCertificate,
  type PracticalCertificateBindings,
  type PracticalCertificateStatus,
  type PracticalCertificateTermination,
  type PracticalCertificationEvidenceSummary,
  type PracticalRecoveryCertificateRecord,
} from './certificate';

export {
  adoptPracticalFenceForNewRuntime,
  beginPracticalCertification,
  beginPracticalMutationLease,
  finishPracticalCertification,
  initialPracticalFence,
  releasePracticalMutationLease,
  type PracticalAccountFence,
  type PracticalFenceExpectation,
  type PracticalFenceMode,
} from './fence';

export {
  PRACTICAL_INVALIDATION_SEVERITY,
  classifyPracticalInvalidation,
  practicalStateForSeverity,
  strictestPracticalSeverity,
} from './invalidation';
