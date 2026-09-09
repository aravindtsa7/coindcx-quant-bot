import type { ResearchApprovalOrigin } from '../research/research-validation';
import type {
  AccountRiskSnapshot, CoinDcxLeverageTierSnapshot, EntryStopProposal, LeverageProposal, PairRiskSnapshot,
  RiskOverride, RiskPolicy, SettlementConversionSnapshot,
} from '../risk';
import type { StrategyDecision, StrategyKernel } from '../strategies';
import { RiskAdmissionCoordinator } from './admission';
import { authorizeStrategyDispatch } from './strategy-dispatch';
import type { AdmissionOutcome, PortfolioExposureSnapshot } from './types';

export interface DispatchRequest {
  readonly kernel: StrategyKernel;
  readonly decision: StrategyDecision;
  readonly instrumentSpecSnapshotId: string;
  readonly researchApproval: ResearchApprovalOrigin | null;
  readonly accountId: string;
  readonly policy: RiskPolicy;
  readonly entryStopProposal: EntryStopProposal | null;
  readonly leverageProposal: LeverageProposal | null;
  readonly override: RiskOverride | null;
  readonly evaluationTimeMs: number;
  readonly accountSnapshot: AccountRiskSnapshot | null;
  readonly pairSnapshot: PairRiskSnapshot;
  readonly exposureSnapshot: PortfolioExposureSnapshot | null;
  readonly leverageTierSnapshot: CoinDcxLeverageTierSnapshot | null;
  readonly settlementRateSnapshot: SettlementConversionSnapshot | null;
}

export type DispatchOutcome =
  | { readonly stage: 'RESEARCH_UNAUTHORIZED' }
  | { readonly stage: 'DISPATCH_UNAUTHORIZED' }
  | ({ readonly stage: 'ADMISSION' } & AdmissionOutcome);

/**
 * The one production path from a Phase 10 decision to admitted risk capacity:
 *
 *   authoritative research eligibility -> authorized strategy dispatch ->
 *   createStrategyRiskHandoff -> RiskEngine.evaluateRisk -> admission boundary
 *
 * Nothing upstream of this function may treat a bare `RiskDecision` as
 * actionable/allocated authority — only an `{ stage: 'ADMISSION', status: 'ADMITTED', ... }`
 * outcome carries an `AdmissionRecord`, which is what a future Phase 14 consumer
 * must require.
 */
export async function dispatchStrategyDecision(coordinator: RiskAdmissionCoordinator, request: DispatchRequest): Promise<DispatchOutcome> {
  if (request.researchApproval === null) return { stage: 'RESEARCH_UNAUTHORIZED' };
  const authorized = authorizeStrategyDispatch(request.kernel, request.decision, request.instrumentSpecSnapshotId, request.researchApproval);
  if (authorized === null) return { stage: 'DISPATCH_UNAUTHORIZED' };
  const outcome = await coordinator.admit({
    accountId: request.accountId,
    policy: request.policy,
    context: {
      strategyOrigin: authorized.strategyOrigin,
      candidate: authorized.candidate,
      entryStopProposal: request.entryStopProposal,
      leverageProposal: request.leverageProposal,
      override: request.override,
      evaluationTimeMs: request.evaluationTimeMs,
      accountSnapshot: request.accountSnapshot,
      pairSnapshot: request.pairSnapshot,
      exposureSnapshot: request.exposureSnapshot,
      leverageTierSnapshot: request.leverageTierSnapshot,
      settlementRateSnapshot: request.settlementRateSnapshot,
    },
  });
  return { stage: 'ADMISSION', ...outcome };
}
