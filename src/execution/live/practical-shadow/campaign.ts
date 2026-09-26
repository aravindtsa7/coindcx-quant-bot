/**
 * Phase 18B Checkpoint C: the shadow campaign runner (orchestration).
 *
 * A campaign is a long run of evaluation windows for ONE account, bound to
 * its provider fingerprint, CLEAN source commit (`./provenance.ts`: a dirty
 * or unknown source tree never starts or resumes a campaign), and
 * configuration digest. The runner opens a campaign (start a new one, or
 * resume the ACTIVE one only if its binding is identical), then repeatedly:
 * claims an evaluation, collects
 * read-only evidence (`./collector.ts`), classifies it (`./classification.ts`),
 * and completes it with its hypothetical paper decisions. Every durable step
 * goes through the shadow store's compare-and-set (`./ports.ts`).
 *
 * SHADOW ONLY. Nothing here is authority: the runner holds no certificate
 * issuer, no enablement issuer, no Stage 1B1 write port, no lease, dispatch,
 * arm, or gateway path, and no revocation port. A crash at any point leaves
 * at most a CLAIMED evaluation, which a later resume ABORTS; it never changes
 * practical authority state.
 *
 * The cadence is observational configuration only (validated, recorded in
 * the campaign's configuration digest), never a provider guarantee.
 *
 * `abortPracticalShadowCampaign` is the separate, EXPLICIT operator abort of a
 * campaign whose binding drifted (exact account + campaign id). It is never
 * called by the runner: opening a campaign never force-aborts anything.
 */
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../../../monitoring/logger';
import { evaluatePracticalLiveSafetyConfig, type PracticalLiveSafetyConfigInput } from '../practical/policy';
import { collectPracticalShadowEvidence, type PracticalShadowSources, type PracticalShadowTierBStatus } from './collector';
import type { PracticalShadowConfig } from './config';
import { buildPracticalShadowCompletion } from './integrity';
import { practicalShadowSourceRefusal, type PracticalShadowSourceProvenance } from './provenance';
import type {
  PracticalShadowAbortCampaignResult,
  PracticalShadowCampaignBinding,
  PracticalShadowCampaignRecord,
  PracticalShadowStore,
} from './ports';
import { PRACTICAL_SHADOW_EVIDENCE_SCHEMA_VERSION, PracticalShadowError, type PracticalAuthorityBlocker } from './types';

const logger = createChildLogger('execution:live:practical-shadow');

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** A fresh runtime epoch for a shadow process that is not bound to the live runtime (Phase 18 state then reads as another runtime). */
export function newPracticalShadowRuntimeEpoch(): string {
  return `shadow-${randomUUID()}`;
}

/** Tier-B configuration status as DATA (Stage 1A config parse; never an enablement). */
export function practicalShadowTierBStatus(config: PracticalLiveSafetyConfigInput, accountId: string): PracticalShadowTierBStatus {
  const evaluation = evaluatePracticalLiveSafetyConfig(config);
  if (evaluation.status === 'DISABLED') return Object.freeze({ status: 'DISABLED' as const, disabledReason: evaluation.reason, accountAllowlisted: false });
  return Object.freeze({ status: 'ELIGIBLE' as const, disabledReason: null, accountAllowlisted: evaluation.accountAllowlist.includes(accountId) });
}

export interface PracticalShadowCampaignDependencies {
  readonly store: PracticalShadowStore;
  readonly sources: PracticalShadowSources;
  readonly config: PracticalShadowConfig;
  readonly accountId: string;
  readonly expectedProviderAccountFingerprint: string;
  readonly runtimeEpoch: string;
  /** The resolved source provenance; only CLEAN may open a campaign. */
  readonly sourceProvenance: PracticalShadowSourceProvenance;
  readonly tierB: PracticalShadowTierBStatus;
  readonly workerId?: string | undefined;
  readonly newId?: (() => string) | undefined;
}

export type PracticalShadowOpenOutcome =
  | { readonly kind: 'STARTED' | 'RESUMED'; readonly campaign: PracticalShadowCampaignRecord; readonly abortedEvaluations: number }
  | {
      readonly kind: 'REFUSED';
      readonly reason: 'ACTIVE_CAMPAIGN_EXISTS' | 'NO_ACTIVE_CAMPAIGN' | 'BINDING_MISMATCH' | 'SHADOW_SOURCE_DIRTY' | 'SHADOW_SOURCE_PROVENANCE_UNAVAILABLE';
      readonly detail: readonly string[];
    };

export type PracticalShadowEvaluationOutcome =
  | {
      readonly kind: 'COMPLETED';
      readonly evaluationId: string;
      readonly sequence: number;
      readonly restStability: 'PASS' | 'FAIL';
      readonly streamReadiness: string;
      readonly authorityEligible: boolean;
      readonly primaryBlocker: PracticalAuthorityBlocker | null;
    }
  | { readonly kind: 'NOT_COLLECTED'; readonly reason: string };

export class PracticalShadowCampaignRunner {
  readonly #deps: PracticalShadowCampaignDependencies;
  readonly #workerId: string;
  readonly #newId: () => string;
  readonly #baselines = new Map<number, number>();
  #campaign: PracticalShadowCampaignRecord | null = null;

  public constructor(dependencies: PracticalShadowCampaignDependencies) {
    for (const [name, value] of [['accountId', dependencies.accountId], ['runtimeEpoch', dependencies.runtimeEpoch]] as const) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 64 || value.trim() !== value) {
        throw new PracticalShadowError('SHADOW_CONFIG_INVALID', `${name} must be an exact non-empty string of at most 64 characters`);
      }
    }
    if (!/^[0-9a-f]{64}$/.test(dependencies.expectedProviderAccountFingerprint)) {
      throw new PracticalShadowError('SHADOW_CONFIG_INVALID', 'expectedProviderAccountFingerprint must be a lowercase 64-hex fingerprint');
    }
    this.#deps = dependencies;
    this.#newId = dependencies.newId ?? randomUUID;
    this.#workerId = dependencies.workerId ?? `worker-${randomUUID()}`;
    if (!ID_PATTERN.test(this.#workerId)) throw new PracticalShadowError('SHADOW_CONFIG_INVALID', 'workerId must be an exact identifier');
  }

  public get workerId(): string {
    return this.#workerId;
  }

  public get campaign(): PracticalShadowCampaignRecord | null {
    return this.#campaign;
  }

  /** The binding, or null unless the source provenance is an exact CLEAN commit. */
  #binding(): PracticalShadowCampaignBinding | null {
    const provenance = this.#deps.sourceProvenance;
    if (practicalShadowSourceRefusal(provenance) !== null || provenance.state !== 'CLEAN') return null;
    return Object.freeze({
      accountId: this.#deps.accountId,
      providerAccountFingerprint: this.#deps.expectedProviderAccountFingerprint,
      softwareVersion: provenance.commit,
      sourceProvenance: provenance.kind,
      configDigest: this.#deps.config.digest,
      evidenceSchemaVersion: PRACTICAL_SHADOW_EVIDENCE_SCHEMA_VERSION,
    });
  }

  #nextId(prefix: string): string {
    const id = `${prefix}-${this.#newId()}`;
    if (!ID_PATTERN.test(id)) throw new PracticalShadowError('SHADOW_CONFIG_INVALID', 'Generated id is not an exact identifier');
    return id;
  }

  /**
   * Opens a campaign. A DIRTY or UNKNOWN source tree is refused before the
   * store is touched (no campaign row, no resume). RESUME never silently
   * continues a campaign whose binding (account, fingerprint, source commit,
   * configuration, schema) differs, and never aborts it. A resume takes
   * ownership and aborts whatever a previous worker left CLAIMED.
   */
  public async open(mode: 'START_NEW' | 'RESUME' | 'RESUME_OR_START'): Promise<PracticalShadowOpenOutcome> {
    const sourceRefusal = practicalShadowSourceRefusal(this.#deps.sourceProvenance);
    const binding = this.#binding();
    if (sourceRefusal !== null || binding === null) {
      const reason = sourceRefusal ?? 'SHADOW_SOURCE_PROVENANCE_UNAVAILABLE';
      logger.warn({ event: 'P18B_SHADOW_CAMPAIGN_SOURCE_REFUSED', reason }, 'P18B shadow campaign NOT opened: the source tree is not an exact clean commit');
      return Object.freeze({ kind: 'REFUSED' as const, reason, detail: Object.freeze([]) });
    }
    const nowMs = this.#deps.sources.clock.nowMs();
    if (mode !== 'START_NEW') {
      const resumed = await this.#deps.store.resumeCampaign({ binding, workerId: this.#workerId, nowMs });
      if (resumed.kind === 'RESUMED') {
        this.#campaign = resumed.campaign;
        this.#baselines.clear();
        logger.info({ event: 'P18B_SHADOW_CAMPAIGN_RESUMED', campaignId: resumed.campaign.campaignId, abortedEvaluations: resumed.abortedEvaluations }, 'P18B shadow campaign resumed (shadow only; no authority)');
        return Object.freeze({ kind: 'RESUMED' as const, campaign: resumed.campaign, abortedEvaluations: resumed.abortedEvaluations });
      }
      if (resumed.kind === 'BINDING_MISMATCH') {
        logger.warn({ event: 'P18B_SHADOW_CAMPAIGN_BINDING_MISMATCH', campaignId: resumed.campaign.campaignId, mismatches: resumed.mismatches }, 'P18B shadow campaign NOT resumed: binding differs');
        return Object.freeze({ kind: 'REFUSED' as const, reason: 'BINDING_MISMATCH' as const, detail: resumed.mismatches });
      }
      if (mode === 'RESUME') return Object.freeze({ kind: 'REFUSED' as const, reason: 'NO_ACTIVE_CAMPAIGN' as const, detail: Object.freeze([]) });
    }
    const started = await this.#deps.store.startCampaign({
      campaignId: this.#nextId('campaign'),
      binding,
      configJson: JSON.stringify(this.#deps.config.snapshot),
      workerId: this.#workerId,
      nowMs,
    });
    if (started.kind === 'ACTIVE_CAMPAIGN_EXISTS') {
      return Object.freeze({ kind: 'REFUSED' as const, reason: 'ACTIVE_CAMPAIGN_EXISTS' as const, detail: Object.freeze([started.campaign.campaignId]) });
    }
    this.#campaign = started.campaign;
    this.#baselines.clear();
    logger.info({ event: 'P18B_SHADOW_CAMPAIGN_STARTED', campaignId: started.campaign.campaignId, configDigest: started.campaign.configDigest }, 'P18B shadow campaign started (shadow only; no authority)');
    return Object.freeze({ kind: 'STARTED' as const, campaign: started.campaign, abortedEvaluations: 0 });
  }

  /** One evaluation window: claim, collect (read-only), classify, complete. */
  public async runEvaluation(): Promise<PracticalShadowEvaluationOutcome> {
    const campaign = this.#campaign;
    if (campaign === null) return Object.freeze({ kind: 'NOT_COLLECTED' as const, reason: 'NO_OPEN_CAMPAIGN' });
    const evaluationId = this.#nextId('evaluation');
    const claim = await this.#deps.store.claimEvaluation({
      campaignId: campaign.campaignId,
      workerId: this.#workerId,
      evaluationId,
      runtimeEpoch: this.#deps.runtimeEpoch,
      nowMs: this.#deps.sources.clock.nowMs(),
    });
    if (claim.kind !== 'CLAIMED') {
      if (claim.kind === 'STALE_WORKER' || claim.kind === 'CAMPAIGN_NOT_ACTIVE') this.#campaign = null;
      return Object.freeze({ kind: 'NOT_COLLECTED' as const, reason: claim.kind });
    }
    let evidence;
    try {
      evidence = await collectPracticalShadowEvidence({
        sources: this.#deps.sources,
        config: this.#deps.config,
        accountId: this.#deps.accountId,
        expectedProviderAccountFingerprint: this.#deps.expectedProviderAccountFingerprint,
        runtimeEpoch: this.#deps.runtimeEpoch,
        campaignId: campaign.campaignId,
        evaluationId,
        tierB: this.#deps.tierB,
        generationBaselineFor: (incarnation) => (incarnation === null ? null : this.#baselines.get(incarnation) ?? null),
      });
    } catch {
      await this.#deps.store.abortEvaluation({ evaluationId, workerId: this.#workerId, reason: 'COLLECTION_FAULT', nowMs: this.#deps.sources.clock.nowMs() });
      logger.error({ event: 'P18B_SHADOW_EVALUATION_ABORTED', campaignId: campaign.campaignId, evaluationId, reason: 'COLLECTION_FAULT' }, 'P18B shadow evaluation aborted');
      return Object.freeze({ kind: 'NOT_COLLECTED' as const, reason: 'COLLECTION_FAULT' });
    }
    const incarnation = evidence.readiness.atStart.incarnation;
    const generationAtStart = evidence.reconciliation[0]?.currentGeneration ?? null;
    if (incarnation !== null && generationAtStart !== null && !this.#baselines.has(incarnation)) this.#baselines.set(incarnation, generationAtStart);

    // The durable record (result + one paper decision per configured intent) from the CLOSED-schema rebuilt evidence;
    // the store re-verifies it. Evidence outside the closed V1 schema is never recorded: the evaluation is aborted.
    let completion: ReturnType<typeof buildPracticalShadowCompletion>;
    try {
      completion = buildPracticalShadowCompletion(evidence, this.#deps.config.paperIntents);
    } catch {
      await this.#deps.store.abortEvaluation({ evaluationId, workerId: this.#workerId, reason: 'EVIDENCE_INVALID', nowMs: this.#deps.sources.clock.nowMs() });
      logger.error({ event: 'P18B_SHADOW_EVALUATION_ABORTED', campaignId: campaign.campaignId, evaluationId, reason: 'EVIDENCE_INVALID' }, 'P18B shadow evaluation aborted');
      return Object.freeze({ kind: 'NOT_COLLECTED' as const, reason: 'EVIDENCE_INVALID' });
    }
    const { classification, result, paperDecisions } = completion;
    const completed = await this.#deps.store.completeEvaluation({ evaluationId, workerId: this.#workerId, result, paperDecisions, nowMs: this.#deps.sources.clock.nowMs() });
    if (completed.kind !== 'COMPLETED') {
      if (completed.reason === 'STALE_WORKER' || completed.reason === 'CAMPAIGN_NOT_ACTIVE') this.#campaign = null;
      logger.warn({ event: 'P18B_SHADOW_EVALUATION_NOT_RECORDED', campaignId: campaign.campaignId, evaluationId, reason: completed.reason }, 'P18B shadow evaluation not recorded');
      return Object.freeze({ kind: 'NOT_COLLECTED' as const, reason: completed.reason });
    }
    logger.info({
      event: 'P18B_SHADOW_EVALUATION_COMPLETED',
      campaignId: campaign.campaignId,
      evaluationId,
      sequence: completed.evaluation.sequence,
      restStability: result.restStability,
      restFailure: result.restFailure,
      streamReadiness: result.streamReadiness,
      authorityEligible: result.authorityEligible,
      primaryBlocker: result.primaryBlocker,
      providerFailures: evidence.reads.filter((read) => read.failure === 'PROVIDER_UNAVAILABLE' || read.failure === 'READ_HARD_TIMEOUT').length,
    }, 'P18B shadow evaluation completed (shadow evidence; NOT authority)');
    return Object.freeze({
      kind: 'COMPLETED' as const,
      evaluationId,
      sequence: completed.evaluation.sequence,
      restStability: result.restStability,
      streamReadiness: result.streamReadiness,
      authorityEligible: result.authorityEligible,
      primaryBlocker: classification.authority.primaryBlocker,
    });
  }

  /**
   * Runs evaluations until `shouldContinue` says stop (checked before each)
   * or `maxEvaluations` is reached. Each evaluation starts no earlier than
   * the previous start plus the cadence. Stops at once when the campaign is
   * lost (a stale worker or a stopped campaign).
   */
  public async runLoop(options: { readonly maxEvaluations?: number | undefined; readonly shouldContinue?: (() => boolean) | undefined } = {}): Promise<number> {
    let completed = 0;
    let previousStartMs: number | null = null;
    for (let count = 0; options.maxEvaluations === undefined || count < options.maxEvaluations; count += 1) {
      if (options.shouldContinue !== undefined && !options.shouldContinue()) break;
      if (previousStartMs !== null) {
        const delayMs = previousStartMs + this.#deps.config.cadenceMs - this.#deps.sources.clock.nowMs();
        if (delayMs > 0) await new Promise<void>((resolve) => { this.#deps.sources.scheduler.setTimeout(resolve, delayMs); });
        if (options.shouldContinue !== undefined && !options.shouldContinue()) break;
      }
      previousStartMs = this.#deps.sources.clock.nowMs();
      const outcome = await this.runEvaluation();
      if (outcome.kind === 'COMPLETED') completed += 1;
      if (this.#campaign === null) break;
    }
    return completed;
  }

  public async stop(status: 'COMPLETED' | 'ABORTED', reason: string): Promise<boolean> {
    const campaign = this.#campaign;
    if (campaign === null) return false;
    const stopped = await this.#deps.store.stopCampaign({ campaignId: campaign.campaignId, workerId: this.#workerId, status, reason, nowMs: this.#deps.sources.clock.nowMs() });
    this.#campaign = null;
    logger.info({ event: 'P18B_SHADOW_CAMPAIGN_STOPPED', campaignId: campaign.campaignId, status, result: stopped.kind }, 'P18B shadow campaign stopped');
    return stopped.kind === 'STOPPED';
  }
}

/**
 * EXPLICIT operator abort of one campaign, by exact account AND campaign id
 * (used when the binding drifted and a normal `stop` is refused). It is a
 * single store transaction: it does not resume the campaign, read or collect
 * provider data, compute authority, issue anything, create paper decisions,
 * touch Stage 1B1 practical state, or change any threshold. A terminal
 * campaign is reported ALREADY_TERMINAL and left unchanged.
 */
export async function abortPracticalShadowCampaign(input: {
  readonly store: Pick<PracticalShadowStore, 'abortCampaign'>;
  readonly accountId: string;
  readonly campaignId: string;
  readonly reason: string;
  readonly nowMs: number;
}): Promise<PracticalShadowAbortCampaignResult> {
  const result = await input.store.abortCampaign({ accountId: input.accountId, campaignId: input.campaignId, reason: input.reason, nowMs: input.nowMs });
  logger.warn({
    event: 'P18B_SHADOW_CAMPAIGN_OPERATOR_ABORT',
    campaignId: input.campaignId,
    reason: input.reason,
    result: result.kind === 'REFUSED' ? `REFUSED:${result.reason}` : result.kind,
    abortedEvaluations: result.kind === 'ABORTED' ? result.abortedEvaluations : 0,
  }, 'P18B shadow campaign operator abort (shadow only; no authority)');
  return result;
}
