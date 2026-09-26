/**
 * Deterministic fakes for the Phase 18B Checkpoint C shadow infrastructure.
 *
 * The read-only sources reuse the Checkpoint B fakes (read-only venue,
 * private stream, Phase 18 state, fake clock/scheduler, and the in-memory
 * Stage 1B1 persistence used ONLY through `loadAccount`). The in-memory
 * shadow store mirrors the MySQL store's compare-and-set semantics so the
 * runner can be unit tested; the real-MySQL suite uses the real store.
 */
import { FakeClock } from '../../../../../src/core/time/clock';
import type { PracticalShadowSources, PracticalShadowTierBStatus } from '../../../../../src/execution/live/practical-shadow/collector';
import {
  parsePracticalShadowConfigSnapshot,
  resolvePracticalShadowConfig,
  type PracticalShadowConfig,
  type PracticalShadowConfigInput,
  type PracticalShadowProviderDescriptor,
} from '../../../../../src/execution/live/practical-shadow/config';
import { verifyPracticalShadowCompletion } from '../../../../../src/execution/live/practical-shadow/integrity';
import type {
  PracticalShadowCampaignRecord,
  PracticalShadowCampaignSnapshot,
  PracticalShadowEvaluationRecord,
  PracticalShadowPaperDecisionRecord,
  PracticalShadowStore,
} from '../../../../../src/execution/live/practical-shadow/ports';
import {
  requireTrustedPracticalShadowProvenance,
  resolvePracticalShadowSourceProvenance,
  type PracticalShadowSourceProvenance,
} from '../../../../../src/execution/live/practical-shadow/provenance';
import { PRACTICAL_SHADOW_OPERATOR_ABORT_REASON } from '../../../../../src/execution/live/practical-shadow/types';
import {
  EPOCH,
  FakePrivateStream,
  FakeReconciliation,
  FakeScheduler,
  FakeVenue,
  MemoryPracticalPersistence,
  T0,
} from '../practical-recovery/support';

export { EPOCH, EPOCH_B, FINGERPRINT, OTHER_FINGERPRINT, T0, order, position } from '../practical-recovery/support';

export const ACCOUNT = 'account-live-1';

/** The (non-secret) provider descriptor every test campaign is bound to. */
export const TEST_PROVIDER: PracticalShadowProviderDescriptor = Object.freeze({ restOrigin: 'https://rest.shadow.invalid', streamEndpoint: 'wss://stream.shadow.invalid' });

export function shadowConfig(input: Omit<PracticalShadowConfigInput, 'provider'> = { cadenceMs: 60_000 }): PracticalShadowConfig {
  return resolvePracticalShadowConfig({ provider: TEST_PROVIDER, ...input });
}

/** Deterministic clean source commits (tests inject provenance; no git is run). */
export const COMMIT_A = '0123456789abcdef0123456789abcdef01234567';
export const COMMIT_B = 'fedcba9876543210fedcba9876543210fedcba98';

export function cleanSource(commit: string = COMMIT_A): PracticalShadowSourceProvenance {
  return resolvePracticalShadowSourceProvenance({ head: `${commit}\n`, status: '' });
}

export const DIRTY_SOURCE: PracticalShadowSourceProvenance = resolvePracticalShadowSourceProvenance({ head: COMMIT_A, status: ' M src/index.ts\n?? scratch.ts\n' });
export const UNAVAILABLE_SOURCE: PracticalShadowSourceProvenance = resolvePracticalShadowSourceProvenance({ head: null, status: null });

export const TIER_B_ELIGIBLE: PracticalShadowTierBStatus = Object.freeze({ status: 'ELIGIBLE', disabledReason: null, accountAllowlisted: true });
export const TIER_B_DISABLED: PracticalShadowTierBStatus = Object.freeze({ status: 'DISABLED', disabledReason: 'NOT_EXPLICITLY_ENABLED', accountAllowlisted: false });

export interface ShadowWorld {
  readonly clock: FakeClock;
  readonly scheduler: FakeScheduler;
  readonly venue: FakeVenue;
  readonly stream: FakePrivateStream;
  readonly reconciliation: FakeReconciliation;
  readonly practical: MemoryPracticalPersistence;
  readonly sources: PracticalShadowSources;
  readonly config: PracticalShadowConfig;
}

/**
 * A shadow world. By default the stream is REAL-LIKE (UNPROVEN: join sent,
 * no provider confirmation) and the practical account is initialized
 * QUARANTINED/IDLE for this runtime epoch.
 */
export async function shadowWorld(options: { readonly provenReady?: boolean; readonly initialize?: boolean; readonly config?: Omit<PracticalShadowConfigInput, 'provider'> } = {}): Promise<ShadowWorld> {
  const clock = new FakeClock(T0);
  const scheduler = new FakeScheduler(clock);
  const venue = new FakeVenue(clock);
  const stream = new FakePrivateStream();
  if (options.provenReady !== true) stream.unprove();
  const reconciliation = new FakeReconciliation(ACCOUNT);
  const practical = new MemoryPracticalPersistence(ACCOUNT);
  if (options.initialize !== false) await practical.initializeAccount({ runtimeEpoch: EPOCH, reconciliationGeneration: 0 });
  const sources: PracticalShadowSources = Object.freeze({
    venue,
    privateStream: stream,
    reconciliation,
    // READ-ONLY: only loadAccount is reachable.
    practicalAccount: Object.freeze({ loadAccount: (_accountId: string) => practical.loadAccount() }),
    clock,
    scheduler,
  });
  return { clock, scheduler, venue, stream, reconciliation, practical, sources, config: shadowConfig(options.config) };
}

/** In-memory shadow store with the MySQL store's compare-and-set semantics (no real locking; unit tests only). */
export class MemoryPracticalShadowStore implements PracticalShadowStore {
  public readonly activeByAccount = new Map<string, string>();
  public readonly campaigns = new Map<string, PracticalShadowCampaignRecord>();
  public readonly evaluations = new Map<string, PracticalShadowEvaluationRecord>();
  public readonly paperDecisions = new Map<string, PracticalShadowPaperDecisionRecord>();

  public async startCampaign(input: Parameters<PracticalShadowStore['startCampaign']>[0]) {
    requireTrustedPracticalShadowProvenance(input.binding.sourceProvenance, input.binding.softwareVersion);
    parsePracticalShadowConfigSnapshot(input.configJson, input.binding.configDigest);
    const active = this.activeByAccount.get(input.binding.accountId);
    if (active !== undefined) return { kind: 'ACTIVE_CAMPAIGN_EXISTS' as const, campaign: this.campaigns.get(active)! };
    const campaign: PracticalShadowCampaignRecord = {
      campaignId: input.campaignId, ...input.binding, configJson: input.configJson, status: 'ACTIVE', workerId: input.workerId, nextSequence: 1,
      startedAtMs: input.nowMs, endedAtMs: null, endReason: null, revision: 0,
    };
    this.campaigns.set(campaign.campaignId, campaign);
    this.activeByAccount.set(input.binding.accountId, campaign.campaignId);
    return { kind: 'STARTED' as const, campaign };
  }

  public async resumeCampaign(input: Parameters<PracticalShadowStore['resumeCampaign']>[0]) {
    requireTrustedPracticalShadowProvenance(input.binding.sourceProvenance, input.binding.softwareVersion);
    const active = this.activeByAccount.get(input.binding.accountId);
    if (active === undefined) return { kind: 'NO_ACTIVE_CAMPAIGN' as const };
    const campaign = this.campaigns.get(active)!;
    // The MySQL store's C-08 order: the stored configuration is validated before the binding is compared or anything changes.
    parsePracticalShadowConfigSnapshot(campaign.configJson, campaign.configDigest);
    const mismatches = (['accountId', 'providerAccountFingerprint', 'softwareVersion', 'sourceProvenance', 'configDigest', 'evidenceSchemaVersion'] as const).filter((key) => campaign[key] !== input.binding[key]);
    if (mismatches.length > 0) return { kind: 'BINDING_MISMATCH' as const, campaign, mismatches };
    const resumed = { ...campaign, workerId: input.workerId, revision: campaign.revision + 1 };
    this.campaigns.set(campaign.campaignId, resumed);
    let abortedEvaluations = 0;
    for (const evaluation of this.evaluations.values()) {
      if (evaluation.campaignId === campaign.campaignId && evaluation.status === 'CLAIMED') {
        this.evaluations.set(evaluation.evaluationId, { ...evaluation, status: 'ABORTED', abortReason: 'WORKER_REPLACED', finishedAtMs: input.nowMs });
        abortedEvaluations += 1;
      }
    }
    return { kind: 'RESUMED' as const, campaign: resumed, abortedEvaluations };
  }

  public async stopCampaign(input: Parameters<PracticalShadowStore['stopCampaign']>[0]) {
    const campaign = this.campaigns.get(input.campaignId);
    if (campaign === undefined || campaign.status !== 'ACTIVE') return { kind: 'CAMPAIGN_NOT_ACTIVE' as const };
    if (campaign.workerId !== input.workerId) return { kind: 'STALE_WORKER' as const };
    for (const evaluation of this.evaluations.values()) {
      if (evaluation.campaignId === campaign.campaignId && evaluation.status === 'CLAIMED') {
        this.evaluations.set(evaluation.evaluationId, { ...evaluation, status: 'ABORTED', abortReason: 'CAMPAIGN_STOPPED', finishedAtMs: input.nowMs });
      }
    }
    const stopped = { ...campaign, status: input.status, endedAtMs: input.nowMs, endReason: input.reason, revision: campaign.revision + 1 };
    this.campaigns.set(campaign.campaignId, stopped);
    this.activeByAccount.delete(campaign.accountId);
    return { kind: 'STOPPED' as const, campaign: stopped };
  }

  public async abortCampaign(input: Parameters<PracticalShadowStore['abortCampaign']>[0]) {
    const campaign = this.campaigns.get(input.campaignId);
    if (campaign === undefined) return { kind: 'REFUSED' as const, reason: 'UNKNOWN_CAMPAIGN' as const };
    if (campaign.accountId !== input.accountId) return { kind: 'REFUSED' as const, reason: 'ACCOUNT_MISMATCH' as const };
    if (campaign.status !== 'ACTIVE') return { kind: 'ALREADY_TERMINAL' as const, campaign };
    let abortedEvaluations = 0;
    for (const evaluation of this.evaluations.values()) {
      if (evaluation.campaignId === campaign.campaignId && evaluation.status === 'CLAIMED') {
        this.evaluations.set(evaluation.evaluationId, { ...evaluation, status: 'ABORTED', abortReason: PRACTICAL_SHADOW_OPERATOR_ABORT_REASON, finishedAtMs: input.nowMs });
        abortedEvaluations += 1;
      }
    }
    const aborted = { ...campaign, status: 'ABORTED' as const, endedAtMs: input.nowMs, endReason: `${PRACTICAL_SHADOW_OPERATOR_ABORT_REASON}:${input.reason}`, revision: campaign.revision + 1 };
    this.campaigns.set(campaign.campaignId, aborted);
    this.activeByAccount.delete(campaign.accountId);
    return { kind: 'ABORTED' as const, campaign: aborted, abortedEvaluations };
  }

  public async claimEvaluation(input: Parameters<PracticalShadowStore['claimEvaluation']>[0]) {
    const campaign = this.campaigns.get(input.campaignId);
    if (campaign === undefined || campaign.status !== 'ACTIVE') return { kind: 'CAMPAIGN_NOT_ACTIVE' as const };
    if (campaign.workerId !== input.workerId) return { kind: 'STALE_WORKER' as const };
    if (this.evaluations.has(input.evaluationId)) throw new Error('duplicate evaluation id');
    const evaluation: PracticalShadowEvaluationRecord = {
      evaluationId: input.evaluationId, campaignId: campaign.campaignId, sequence: campaign.nextSequence, workerId: input.workerId, runtimeEpoch: input.runtimeEpoch,
      status: 'CLAIMED', claimedAtMs: input.nowMs, finishedAtMs: null, abortReason: null, result: null,
    };
    this.evaluations.set(evaluation.evaluationId, evaluation);
    this.campaigns.set(campaign.campaignId, { ...campaign, nextSequence: campaign.nextSequence + 1, revision: campaign.revision + 1 });
    return { kind: 'CLAIMED' as const, evaluation };
  }

  public async completeEvaluation(input: Parameters<PracticalShadowStore['completeEvaluation']>[0]) {
    const evaluation = this.evaluations.get(input.evaluationId);
    if (evaluation === undefined) return { kind: 'REFUSED' as const, reason: 'NOT_CLAIMED' as const };
    const campaign = this.campaigns.get(evaluation.campaignId)!;
    if (campaign.status !== 'ACTIVE') return { kind: 'REFUSED' as const, reason: 'CAMPAIGN_NOT_ACTIVE' as const };
    if (campaign.workerId !== input.workerId || evaluation.workerId !== input.workerId) return { kind: 'REFUSED' as const, reason: 'STALE_WORKER' as const };
    if (evaluation.status !== 'CLAIMED') return { kind: 'REFUSED' as const, reason: 'NOT_CLAIMED' as const };
    if (input.result.authorityEligible && (input.result.streamReadiness !== 'PROVEN_READY' || input.result.restStability !== 'PASS')) throw new Error('CHECK violated');
    // The MySQL store's integrity gate (same function): a disagreement throws before anything is recorded.
    const verified = verifyPracticalShadowCompletion({ campaign, evaluation, result: input.result, paperDecisions: input.paperDecisions });
    if (input.paperDecisions.some((decision) => this.paperDecisions.has(decision.paperDecisionId))) return { kind: 'REFUSED' as const, reason: 'DUPLICATE_PAPER_DECISION' as const };
    const completed: PracticalShadowEvaluationRecord = { ...evaluation, status: 'COMPLETED', finishedAtMs: input.nowMs, result: verified.result };
    this.evaluations.set(evaluation.evaluationId, completed);
    for (const decision of verified.paperDecisions) this.paperDecisions.set(decision.paperDecisionId, decision);
    return { kind: 'COMPLETED' as const, evaluation: completed };
  }

  public async abortEvaluation(input: Parameters<PracticalShadowStore['abortEvaluation']>[0]) {
    const evaluation = this.evaluations.get(input.evaluationId);
    if (evaluation === undefined || evaluation.status !== 'CLAIMED' || evaluation.workerId !== input.workerId) return { kind: 'REFUSED' as const };
    this.evaluations.set(evaluation.evaluationId, { ...evaluation, status: 'ABORTED', abortReason: input.reason, finishedAtMs: input.nowMs });
    return { kind: 'ABORTED' as const };
  }

  public async loadActiveCampaign(accountId: string) {
    const active = this.activeByAccount.get(accountId);
    return active === undefined ? null : this.campaigns.get(active)!;
  }

  public async loadCampaign(campaignId: string) {
    return this.campaigns.get(campaignId) ?? null;
  }

  public async snapshotCampaign(campaignId: string): Promise<PracticalShadowCampaignSnapshot | null> {
    const campaign = this.campaigns.get(campaignId);
    if (campaign === undefined) return null;
    const evaluations = [...this.evaluations.values()].filter((row) => row.campaignId === campaignId).sort((a, b) => a.sequence - b.sequence);
    const cutoffSequence = evaluations.at(-1)?.sequence ?? 0;
    const ids = new Set(evaluations.map((row) => row.evaluationId));
    return {
      campaign,
      evaluations,
      paperDecisions: [...this.paperDecisions.values()].filter((row) => ids.has(row.evaluationId)).sort((a, b) => a.paperDecisionId.localeCompare(b.paperDecisionId)),
      cutoffSequence,
    };
  }
}

/** Advances Phase 18 so the next evaluation's generation is after the stream baseline and newer than the fence. */
export function advancePhase18(world: ShadowWorld): number {
  return world.reconciliation.completeHealthyRun(EPOCH);
}
