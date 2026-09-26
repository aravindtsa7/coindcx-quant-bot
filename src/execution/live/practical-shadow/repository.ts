/**
 * Phase 18B Checkpoint C: Prisma/MySQL implementation of the shadow
 * calibration store. The ONLY module of the shadow tree that imports Prisma.
 *
 * Every guarantee is enforced by MySQL inside ONE transaction (the Stage 1B1
 * pattern), never by an in-memory lock:
 *
 * | Guarantee                                  | Enforcement |
 * | :----------------------------------------- | :---------- |
 * | One ACTIVE campaign per account            | the account row is locked `FOR UPDATE`; its active-campaign pointer (UNIQUE) changes by compare-and-set on `revision` |
 * | One worker owns a campaign                 | the campaign row is locked `FOR UPDATE`; claim/complete/stop check the owner; a resume swaps the owner by compare-and-set |
 * | A crash never completes an observation     | a resume or stop ABORTS every evaluation left CLAIMED, in the same transaction; ABORTED rows carry no result (CHECK) |
 * | One evaluation counted at most once        | completion is `updateMany ... WHERE status = 'CLAIMED' AND worker_id = ?`, exactly one row, under the campaign and evaluation locks |
 * | Unique sequence / ids / paper decisions    | PRIMARY KEYs, UNIQUE(campaign_id, sequence), UNIQUE(evaluation_id, action, stage) |
 * | Consistent reports                         | `snapshotCampaign` reads in ONE REPEATABLE READ transaction with an explicit sequence cutoff |
 * | Clean source provenance                    | the binding must name GIT_CLEAN_COMMIT + a 40-hex commit (checked here, and by a MySQL CHECK) |
 * | Config bound to its digest                 | `startCampaign` recomputes the canonical digest of `configJson` and refuses unless it equals the binding's `configDigest` (MySQL CHECKs the digest SHAPE only) |
 * | One story per evaluation                   | `completeEvaluation` re-verifies, INSIDE the transaction and before any write, that the evidence is bound to exactly this campaign/evaluation and that the result and paper decisions are exactly the recomputed ones (`./integrity.ts`); any disagreement rolls the whole completion back |
 * | Exact ids despite a case-insensitive collation | every lookup by a caller-supplied id re-checks the returned id with exact (case-sensitive) equality and treats a case-only match as NOT FOUND, before any write |
 * | Explicit operator abort                    | `abortCampaign` locks the account then the campaign `FOR UPDATE`; exact account + campaign id; ACTIVE only (compare-and-set); CLAIMED evaluations aborted and the pointer cleared in the same transaction |
 *
 * It touches ONLY `live_practical_shadow_*` tables: never a Stage 1B1
 * practical authority row. Nothing it stores is authority.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { parsePracticalShadowConfigSnapshot } from './config';
import { verifyPracticalShadowCompletion } from './integrity';
import { PRACTICAL_SHADOW_SOURCE_PROVENANCE_KIND, requireTrustedPracticalShadowProvenance } from './provenance';
import {
  PRACTICAL_SHADOW_OPERATOR_ABORT_REASON,
  PRACTICAL_SHADOW_OPERATOR_REASON_PATTERN,
  PracticalShadowError,
  type PracticalPaperAction,
  type PracticalPaperOutcome,
  type PracticalPaperRolloutStage,
  type PracticalShadowStreamReadiness,
} from './types';
import type {
  PracticalShadowAbortCampaignResult,
  PracticalShadowCampaignBinding,
  PracticalShadowCampaignRecord,
  PracticalShadowCampaignSnapshot,
  PracticalShadowClaimResult,
  PracticalShadowCompleteResult,
  PracticalShadowEvaluationRecord,
  PracticalShadowEvaluationResult,
  PracticalShadowPaperDecisionRecord,
  PracticalShadowResumeResult,
  PracticalShadowStartResult,
  PracticalShadowStore,
} from './ports';

type Tx = Prisma.TransactionClient;

export const PRACTICAL_SHADOW_TRANSACTION_MAX_ATTEMPTS = 3;
const TRANSACTION_TIMEOUT_MS = 15_000;
const MYSQL_DEADLOCK = 1213;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function isRetryableDeadlock(error: unknown): boolean {
  if (isPrismaCode(error, 'P2034')) return true;
  if (!isPrismaCode(error, 'P2010')) return false;
  const meta = (error as Prisma.PrismaClientKnownRequestError).meta as Record<string, unknown> | undefined;
  return meta !== undefined && (meta['code'] === String(MYSQL_DEADLOCK) || meta['code'] === MYSQL_DEADLOCK);
}

function malformed(message: string): never {
  throw new PracticalShadowError('SHADOW_STORE_MALFORMED', message);
}

function conflict(message: string): never {
  throw new PracticalShadowError('SHADOW_STORE_CONFLICT', message);
}

function requireId(value: string, name: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new PracticalShadowError('SHADOW_CONFIG_INVALID', `${name} must be an exact identifier of at most 64 characters`);
  return value;
}

function toInt(value: unknown, name: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) malformed(`${name} is not a safe integer`);
  if (typeof value === 'bigint' && BigInt(number) !== value) malformed(`${name} is not a safe integer`);
  return number;
}

function toIntOrNull(value: unknown, name: string): number | null {
  return value === null || value === undefined ? null : toInt(value, name);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) malformed(`${name} is not a known value`);
  return value as T;
}

function toBool(value: unknown, name: string): boolean {
  if (value === true || value === 1 || value === 1n) return true;
  if (value === false || value === 0 || value === 0n) return false;
  return malformed(`${name} is not a boolean`);
}

function parseStringList(value: unknown, name: string): readonly string[] {
  if (typeof value !== 'string') malformed(`${name} is not a string`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return malformed(`${name} is not JSON`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) malformed(`${name} is not a string list`);
  return Object.freeze([...(parsed as string[])]);
}

const READINESS: readonly PracticalShadowStreamReadiness[] = ['PROVEN_READY', 'UNPROVEN', 'RECONCILIATION_REQUIRED', 'DISCONNECTED'];

function parseCampaign(row: Record<string, unknown>): PracticalShadowCampaignRecord {
  const status = oneOf(row['status'], ['ACTIVE', 'COMPLETED', 'ABORTED'] as const, 'campaign.status');
  const endedAtMs = toIntOrNull(row['endedAtMs'], 'campaign.endedAtMs');
  const endReason = row['endReason'] === null ? null : String(row['endReason']);
  if ((status === 'ACTIVE') !== (endedAtMs === null) || (status === 'ACTIVE') !== (endReason === null)) malformed('campaign end fields do not match its status');
  return Object.freeze({
    campaignId: String(row['campaignId']),
    accountId: String(row['accountId']),
    providerAccountFingerprint: String(row['providerAccountFingerprint']),
    softwareVersion: String(row['softwareVersion']),
    sourceProvenance: oneOf(row['sourceProvenance'], [PRACTICAL_SHADOW_SOURCE_PROVENANCE_KIND] as const, 'campaign.sourceProvenance'),
    configDigest: String(row['configDigest']),
    configJson: String(row['configJson']),
    evidenceSchemaVersion: String(row['evidenceSchemaVersion']),
    status,
    workerId: String(row['workerId']),
    nextSequence: toInt(row['nextSequence'], 'campaign.nextSequence'),
    startedAtMs: toInt(row['startedAtMs'], 'campaign.startedAtMs'),
    endedAtMs,
    endReason,
    revision: toInt(row['revision'], 'campaign.revision'),
  });
}

function parseEvaluation(row: Record<string, unknown>): PracticalShadowEvaluationRecord {
  const status = oneOf(row['status'], ['CLAIMED', 'COMPLETED', 'ABORTED'] as const, 'evaluation.status');
  let result: PracticalShadowEvaluationResult | null = null;
  if (status === 'COMPLETED') {
    const restStability = oneOf(row['restStability'], ['PASS', 'FAIL'] as const, 'evaluation.restStability');
    const streamReadiness = oneOf(row['streamReadiness'], READINESS, 'evaluation.streamReadiness');
    const authorityEligible = toBool(row['authorityEligible'], 'evaluation.authorityEligible');
    if (authorityEligible && (streamReadiness !== 'PROVEN_READY' || restStability !== 'PASS')) malformed('an eligible evaluation must be PROVEN_READY with REST PASS');
    result = Object.freeze({
      startedAtMs: toInt(row['startedAtMs'], 'evaluation.startedAtMs'),
      endedAtMs: toInt(row['endedAtMs'], 'evaluation.endedAtMs'),
      reconciliationGeneration: toIntOrNull(row['reconciliationGeneration'], 'evaluation.reconciliationGeneration'),
      streamIncarnation: toIntOrNull(row['streamIncarnation'], 'evaluation.streamIncarnation'),
      streamReadiness,
      restStability,
      restFailure: row['restFailure'] === null ? null : String(row['restFailure']),
      authorityEligible,
      primaryBlocker: row['primaryBlocker'] === null ? null : String(row['primaryBlocker']),
      blockers: parseStringList(row['blockersJson'], 'evaluation.blockersJson'),
      evidenceSchemaVersion: String(row['evidenceSchemaVersion']),
      evidenceDigest: String(row['evidenceDigest']),
      evidenceJson: String(row['evidenceJson']),
    });
  } else if (row['evidenceJson'] !== null && row['evidenceJson'] !== undefined) {
    malformed('a non-completed evaluation carries evidence');
  }
  return Object.freeze({
    evaluationId: String(row['evaluationId']),
    campaignId: String(row['campaignId']),
    sequence: toInt(row['sequence'], 'evaluation.sequence'),
    workerId: String(row['workerId']),
    runtimeEpoch: String(row['runtimeEpoch']),
    status,
    claimedAtMs: toInt(row['claimedAtMs'], 'evaluation.claimedAtMs'),
    finishedAtMs: toIntOrNull(row['finishedAtMs'], 'evaluation.finishedAtMs'),
    abortReason: row['abortReason'] === null ? null : String(row['abortReason']),
    result,
  });
}

function parsePaperDecision(row: Record<string, unknown>): PracticalShadowPaperDecisionRecord {
  return Object.freeze({
    paperDecisionId: String(row['paperDecisionId']),
    evaluationId: String(row['evaluationId']),
    campaignId: String(row['campaignId']),
    requestedAction: oneOf<PracticalPaperAction>(row['requestedAction'], ['CANCEL', 'OPEN', 'CLOSE'], 'paper.requestedAction'),
    rolloutStage: oneOf<PracticalPaperRolloutStage>(row['rolloutStage'], ['STAGE_5A_CANCEL_ONLY', 'STAGE_5B_OPEN_CLOSE_FUTURE'], 'paper.rolloutStage'),
    restStability: oneOf(row['restStability'], ['PASS', 'FAIL'] as const, 'paper.restStability'),
    streamReadiness: oneOf(row['streamReadiness'], READINESS, 'paper.streamReadiness'),
    authorityPrerequisitesMet: toBool(row['authorityPrerequisitesMet'], 'paper.authorityPrerequisitesMet'),
    outcome: oneOf<PracticalPaperOutcome>(row['outcome'], ['WOULD_BLOCK', 'WOULD_REACH_AUTHORITY_GATE'], 'paper.outcome'),
    blockers: parseStringList(row['blockersJson'], 'paper.blockersJson'),
    policyVersion: String(row['policyVersion']),
    createdAtMs: toInt(row['createdAtMs'], 'paper.createdAtMs'),
  });
}

const CAMPAIGN_COLUMNS = Prisma.raw(`campaign_id AS campaignId, account_id AS accountId, provider_account_fingerprint AS providerAccountFingerprint,
  software_version AS softwareVersion, source_provenance AS sourceProvenance, config_digest AS configDigest, config_json AS configJson, evidence_schema_version AS evidenceSchemaVersion,
  status, worker_id AS workerId, next_sequence AS nextSequence, started_at_ms AS startedAtMs, ended_at_ms AS endedAtMs, end_reason AS endReason, revision`);

const EVALUATION_COLUMNS = Prisma.raw(`evaluation_id AS evaluationId, campaign_id AS campaignId, sequence, worker_id AS workerId, runtime_epoch AS runtimeEpoch,
  status, claimed_at_ms AS claimedAtMs, finished_at_ms AS finishedAtMs, abort_reason AS abortReason, started_at_ms AS startedAtMs, ended_at_ms AS endedAtMs,
  reconciliation_generation AS reconciliationGeneration, stream_incarnation AS streamIncarnation, stream_readiness AS streamReadiness,
  rest_stability AS restStability, rest_failure AS restFailure, authority_eligible AS authorityEligible, primary_blocker AS primaryBlocker,
  blockers_json AS blockersJson, evidence_schema_version AS evidenceSchemaVersion, evidence_digest AS evidenceDigest, evidence_json AS evidenceJson`);

const PAPER_COLUMNS = Prisma.raw(`paper_decision_id AS paperDecisionId, evaluation_id AS evaluationId, campaign_id AS campaignId, requested_action AS requestedAction,
  rollout_stage AS rolloutStage, rest_stability AS restStability, stream_readiness AS streamReadiness,
  authority_prerequisites_met AS authorityPrerequisitesMet, outcome, blockers_json AS blockersJson, policy_version AS policyVersion, created_at_ms AS createdAtMs`);

function lock(forUpdate: boolean): Prisma.Sql {
  return Prisma.raw(forUpdate ? ' FOR UPDATE' : '');
}

/**
 * The tables use a case-insensitive collation, so a lookup by id can match a
 * row whose id differs only in case. A caller-supplied id is authoritative
 * and EXACT: a case-only match is treated as not found (never normalized).
 */
function exactly<T extends Record<string, unknown>>(rows: readonly T[], column: string, requested: string): T | null {
  const row = rows[0];
  return row !== undefined && row[column] === requested ? row : null;
}

async function readAccount(tx: Tx, accountId: string): Promise<{ activeCampaignId: string | null; revision: number } | null> {
  const rows = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT account_id AS accountId, active_campaign_id AS activeCampaignId, revision
    FROM live_practical_shadow_account WHERE account_id = ${accountId} FOR UPDATE`);
  if (rows.length === 0) return null;
  const row = rows[0]!;
  // A different-cased account row exists: fail closed (never adopt or normalize another account id).
  if (row['accountId'] !== accountId) conflict('the account id matches an existing account only by case');
  return { activeCampaignId: row['activeCampaignId'] === null ? null : String(row['activeCampaignId']), revision: toInt(row['revision'], 'account.revision') };
}

async function readCampaign(tx: Tx, campaignId: string, forUpdate: boolean): Promise<PracticalShadowCampaignRecord | null> {
  const rows = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT ${CAMPAIGN_COLUMNS} FROM live_practical_shadow_campaign WHERE campaign_id = ${campaignId}${lock(forUpdate)}`);
  const row = exactly(rows, 'campaignId', campaignId);
  return row === null ? null : parseCampaign(row);
}

async function readEvaluation(tx: Tx, evaluationId: string, forUpdate: boolean): Promise<PracticalShadowEvaluationRecord | null> {
  const rows = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT ${EVALUATION_COLUMNS} FROM live_practical_shadow_evaluation WHERE evaluation_id = ${evaluationId}${lock(forUpdate)}`);
  const row = exactly(rows, 'evaluationId', evaluationId);
  return row === null ? null : parseEvaluation(row);
}

function bindingMismatches(campaign: PracticalShadowCampaignRecord, binding: PracticalShadowCampaignBinding): readonly string[] {
  const mismatches: string[] = [];
  for (const key of ['accountId', 'providerAccountFingerprint', 'softwareVersion', 'sourceProvenance', 'configDigest', 'evidenceSchemaVersion'] as const) {
    if (campaign[key] !== binding[key]) mismatches.push(key);
  }
  return Object.freeze(mismatches);
}

export class PrismaPracticalShadowStore implements PracticalShadowStore {
  readonly #prisma: PrismaClient;

  public constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async #transaction<T>(work: (tx: Tx) => Promise<T>, options: { readonly retryDuplicateKey?: boolean } = {}): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#prisma.$transaction(work, { timeout: TRANSACTION_TIMEOUT_MS });
      } catch (error) {
        const retryable = isRetryableDeadlock(error) || (options.retryDuplicateKey === true && isPrismaCode(error, 'P2002'));
        if (!retryable || attempt >= PRACTICAL_SHADOW_TRANSACTION_MAX_ATTEMPTS) throw error;
      }
    }
  }

  public async startCampaign(input: Parameters<PracticalShadowStore['startCampaign']>[0]): Promise<PracticalShadowStartResult> {
    requireId(input.campaignId, 'campaignId');
    requireId(input.workerId, 'workerId');
    requireTrustedPracticalShadowProvenance(input.binding.sourceProvenance, input.binding.softwareVersion);
    if (!/^[0-9a-f]{64}$/.test(input.binding.providerAccountFingerprint)) {
      throw new PracticalShadowError('SHADOW_CONFIG_INVALID', 'providerAccountFingerprint must be a lowercase 64-hex fingerprint');
    }
    // The persisted configuration must be exactly what the bound digest covers (and supported): checked before any write.
    const config = parsePracticalShadowConfigSnapshot(input.configJson, input.binding.configDigest);
    if (config.evidenceSchemaVersion !== input.binding.evidenceSchemaVersion) {
      throw new PracticalShadowError('SHADOW_EVIDENCE_TAMPERED', 'The configuration names another evidence schema than the binding');
    }
    return this.#transaction(async (tx) => {
      let account = await readAccount(tx, input.binding.accountId);
      if (account === null) {
        await tx.livePracticalShadowAccount.create({ data: { accountId: input.binding.accountId } });
        account = await readAccount(tx, input.binding.accountId);
        if (account === null) malformed('the shadow account row vanished');
      }
      if (account.activeCampaignId !== null) {
        const active = await readCampaign(tx, account.activeCampaignId, true);
        if (active === null || active.status !== 'ACTIVE') malformed('the active campaign pointer names no ACTIVE campaign');
        return Object.freeze({ kind: 'ACTIVE_CAMPAIGN_EXISTS' as const, campaign: active });
      }
      await tx.livePracticalShadowCampaign.create({
        data: {
          campaignId: input.campaignId,
          accountId: input.binding.accountId,
          providerAccountFingerprint: input.binding.providerAccountFingerprint,
          softwareVersion: input.binding.softwareVersion,
          sourceProvenance: input.binding.sourceProvenance,
          configDigest: input.binding.configDigest,
          configJson: input.configJson,
          evidenceSchemaVersion: input.binding.evidenceSchemaVersion,
          workerId: input.workerId,
          startedAtMs: BigInt(input.nowMs),
        },
      });
      const moved = await tx.livePracticalShadowAccount.updateMany({
        where: { accountId: input.binding.accountId, revision: BigInt(account.revision), activeCampaignId: null },
        data: { activeCampaignId: input.campaignId, revision: { increment: 1 } },
      });
      if (moved.count !== 1) conflict('the shadow account changed concurrently');
      const campaign = await readCampaign(tx, input.campaignId, false);
      if (campaign === null) malformed('the new campaign vanished');
      return Object.freeze({ kind: 'STARTED' as const, campaign });
    }, { retryDuplicateKey: true });
  }

  public async resumeCampaign(input: Parameters<PracticalShadowStore['resumeCampaign']>[0]): Promise<PracticalShadowResumeResult> {
    requireId(input.workerId, 'workerId');
    requireTrustedPracticalShadowProvenance(input.binding.sourceProvenance, input.binding.softwareVersion);
    return this.#transaction(async (tx) => {
      const account = await readAccount(tx, input.binding.accountId);
      if (account === null || account.activeCampaignId === null) return Object.freeze({ kind: 'NO_ACTIVE_CAMPAIGN' as const });
      const campaign = await readCampaign(tx, account.activeCampaignId, true);
      if (campaign === null || campaign.status !== 'ACTIVE') malformed('the active campaign pointer names no ACTIVE campaign');
      // The stored configuration must still be intact (digest + supported versions) BEFORE the binding is compared or
      // anything is written: a corrupted campaign is never resumed (no owner change, no revision, no abort of CLAIMED rows).
      // It can still be ended with the explicit operator abort, which does not depend on the configuration.
      const stored = parsePracticalShadowConfigSnapshot(campaign.configJson, campaign.configDigest);
      if (stored.evidenceSchemaVersion !== campaign.evidenceSchemaVersion) {
        throw new PracticalShadowError('SHADOW_EVIDENCE_TAMPERED', 'The stored campaign configuration names another evidence schema than its binding');
      }
      const mismatches = bindingMismatches(campaign, input.binding);
      if (mismatches.length > 0) return Object.freeze({ kind: 'BINDING_MISMATCH' as const, campaign, mismatches });
      const owned = await tx.livePracticalShadowCampaign.updateMany({
        where: { campaignId: campaign.campaignId, revision: BigInt(campaign.revision), status: 'ACTIVE' },
        data: { workerId: input.workerId, revision: { increment: 1 } },
      });
      if (owned.count !== 1) conflict('the campaign changed concurrently');
      // A crash never becomes a completed observation: whatever the previous worker left CLAIMED is ABORTED.
      const aborted = await tx.livePracticalShadowEvaluation.updateMany({
        where: { campaignId: campaign.campaignId, status: 'CLAIMED' },
        data: { status: 'ABORTED', abortReason: 'WORKER_REPLACED', finishedAtMs: BigInt(input.nowMs) },
      });
      const resumed = await readCampaign(tx, campaign.campaignId, false);
      if (resumed === null) malformed('the resumed campaign vanished');
      return Object.freeze({ kind: 'RESUMED' as const, campaign: resumed, abortedEvaluations: aborted.count });
    });
  }

  public async stopCampaign(input: Parameters<PracticalShadowStore['stopCampaign']>[0]): ReturnType<PracticalShadowStore['stopCampaign']> {
    return this.#transaction(async (tx) => {
      const unlocked = await readCampaign(tx, input.campaignId, false);
      if (unlocked === null) return Object.freeze({ kind: 'CAMPAIGN_NOT_ACTIVE' as const });
      const account = await readAccount(tx, unlocked.accountId);
      const campaign = await readCampaign(tx, input.campaignId, true);
      if (campaign === null || campaign.status !== 'ACTIVE') return Object.freeze({ kind: 'CAMPAIGN_NOT_ACTIVE' as const });
      if (campaign.workerId !== input.workerId) return Object.freeze({ kind: 'STALE_WORKER' as const });
      await tx.livePracticalShadowEvaluation.updateMany({
        where: { campaignId: campaign.campaignId, status: 'CLAIMED' },
        data: { status: 'ABORTED', abortReason: 'CAMPAIGN_STOPPED', finishedAtMs: BigInt(input.nowMs) },
      });
      const ended = await tx.livePracticalShadowCampaign.updateMany({
        where: { campaignId: campaign.campaignId, revision: BigInt(campaign.revision), status: 'ACTIVE', workerId: input.workerId },
        data: { status: input.status, endedAtMs: BigInt(Math.max(input.nowMs, campaign.startedAtMs)), endReason: input.reason.slice(0, 64), revision: { increment: 1 } },
      });
      if (ended.count !== 1) conflict('the campaign changed concurrently');
      if (account !== null && account.activeCampaignId === campaign.campaignId) {
        const cleared = await tx.livePracticalShadowAccount.updateMany({
          where: { accountId: campaign.accountId, revision: BigInt(account.revision), activeCampaignId: campaign.campaignId },
          data: { activeCampaignId: null, revision: { increment: 1 } },
        });
        if (cleared.count !== 1) conflict('the shadow account changed concurrently');
      }
      const stopped = await readCampaign(tx, campaign.campaignId, false);
      if (stopped === null) malformed('the stopped campaign vanished');
      return Object.freeze({ kind: 'STOPPED' as const, campaign: stopped });
    });
  }

  public async abortCampaign(input: Parameters<PracticalShadowStore['abortCampaign']>[0]): Promise<PracticalShadowAbortCampaignResult> {
    if (typeof input.accountId !== 'string' || input.accountId.length === 0 || input.accountId.length > 128 || input.accountId.trim() !== input.accountId) {
      throw new PracticalShadowError('SHADOW_CONFIG_INVALID', 'accountId must be an exact account id');
    }
    requireId(input.campaignId, 'campaignId');
    if (typeof input.reason !== 'string' || !PRACTICAL_SHADOW_OPERATOR_REASON_PATTERN.test(input.reason)) {
      throw new PracticalShadowError('SHADOW_CONFIG_INVALID', 'reason must be an upper-case CODE of at most 40 characters');
    }
    const endReason = `${PRACTICAL_SHADOW_OPERATOR_ABORT_REASON}:${input.reason}`;
    const refused = (reason: 'UNKNOWN_CAMPAIGN' | 'ACCOUNT_MISMATCH'): PracticalShadowAbortCampaignResult => Object.freeze({ kind: 'REFUSED' as const, reason });
    return this.#transaction(async (tx) => {
      // Lock order: account, then campaign (the start/resume/stop order), then its evaluations.
      const account = await readAccount(tx, input.accountId);
      const campaign = await readCampaign(tx, input.campaignId, true);
      if (campaign === null) return refused('UNKNOWN_CAMPAIGN');
      if (campaign.accountId !== input.accountId) return refused('ACCOUNT_MISMATCH');
      // A COMPLETED/ABORTED campaign is never resurrected or changed: no write at all.
      if (campaign.status !== 'ACTIVE') return Object.freeze({ kind: 'ALREADY_TERMINAL' as const, campaign });
      if (account === null || account.activeCampaignId !== campaign.campaignId) malformed('an ACTIVE campaign is not the active campaign of its account');
      const aborted = await tx.livePracticalShadowEvaluation.updateMany({
        where: { campaignId: campaign.campaignId, status: 'CLAIMED' },
        data: { status: 'ABORTED', abortReason: PRACTICAL_SHADOW_OPERATOR_ABORT_REASON, finishedAtMs: BigInt(input.nowMs) },
      });
      const ended = await tx.livePracticalShadowCampaign.updateMany({
        where: { campaignId: campaign.campaignId, revision: BigInt(campaign.revision), status: 'ACTIVE' },
        data: { status: 'ABORTED', endedAtMs: BigInt(Math.max(input.nowMs, campaign.startedAtMs)), endReason, revision: { increment: 1 } },
      });
      if (ended.count !== 1) conflict('the campaign changed concurrently');
      const cleared = await tx.livePracticalShadowAccount.updateMany({
        where: { accountId: campaign.accountId, revision: BigInt(account.revision), activeCampaignId: campaign.campaignId },
        data: { activeCampaignId: null, revision: { increment: 1 } },
      });
      if (cleared.count !== 1) conflict('the shadow account changed concurrently');
      const terminal = await readCampaign(tx, campaign.campaignId, false);
      if (terminal === null) malformed('the aborted campaign vanished');
      return Object.freeze({ kind: 'ABORTED' as const, campaign: terminal, abortedEvaluations: aborted.count });
    });
  }

  public async claimEvaluation(input: Parameters<PracticalShadowStore['claimEvaluation']>[0]): Promise<PracticalShadowClaimResult> {
    requireId(input.evaluationId, 'evaluationId');
    return this.#transaction(async (tx) => {
      const campaign = await readCampaign(tx, input.campaignId, true);
      if (campaign === null || campaign.status !== 'ACTIVE') return Object.freeze({ kind: 'CAMPAIGN_NOT_ACTIVE' as const });
      if (campaign.workerId !== input.workerId) return Object.freeze({ kind: 'STALE_WORKER' as const });
      await tx.livePracticalShadowEvaluation.create({
        data: {
          evaluationId: input.evaluationId,
          campaignId: campaign.campaignId,
          sequence: campaign.nextSequence,
          workerId: input.workerId,
          runtimeEpoch: input.runtimeEpoch,
          claimedAtMs: BigInt(input.nowMs),
        },
      });
      const advanced = await tx.livePracticalShadowCampaign.updateMany({
        where: { campaignId: campaign.campaignId, revision: BigInt(campaign.revision), workerId: input.workerId, status: 'ACTIVE' },
        data: { nextSequence: { increment: 1 }, revision: { increment: 1 } },
      });
      if (advanced.count !== 1) conflict('the campaign changed concurrently');
      const evaluation = await readEvaluation(tx, input.evaluationId, false);
      if (evaluation === null) malformed('the claimed evaluation vanished');
      return Object.freeze({ kind: 'CLAIMED' as const, evaluation });
    });
  }

  public async completeEvaluation(input: Parameters<PracticalShadowStore['completeEvaluation']>[0]): Promise<PracticalShadowCompleteResult> {
    const refused = (reason: Extract<PracticalShadowCompleteResult, { kind: 'REFUSED' }>['reason']): PracticalShadowCompleteResult => Object.freeze({ kind: 'REFUSED' as const, reason });
    const result = input.result;
    if (result.authorityEligible && (result.streamReadiness !== 'PROVEN_READY' || result.restStability !== 'PASS')) {
      throw new PracticalShadowError('SHADOW_STORE_CONFLICT', 'An UNPROVEN or unstable evaluation can never be recorded as authority-eligible');
    }
    try {
      return await this.#transaction(async (tx) => {
        const unlocked = await readEvaluation(tx, input.evaluationId, false);
        if (unlocked === null) return refused('NOT_CLAIMED');
        // Fixed lock order: campaign, then evaluation (the claim path's order).
        const campaign = await readCampaign(tx, unlocked.campaignId, true);
        const evaluation = await readEvaluation(tx, input.evaluationId, true);
        if (campaign === null || evaluation === null || campaign.status !== 'ACTIVE') return refused('CAMPAIGN_NOT_ACTIVE');
        if (campaign.workerId !== input.workerId || evaluation.workerId !== input.workerId) return refused('STALE_WORKER');
        if (evaluation.status !== 'CLAIMED') return refused('NOT_CLAIMED');
        // One story: evidence bound to exactly this campaign/evaluation, result and paper decisions exactly recomputed.
        // Throws SHADOW_EVIDENCE_TAMPERED/INSUFFICIENT before any write; the transaction rolls back.
        const verified = verifyPracticalShadowCompletion({ campaign, evaluation, result, paperDecisions: input.paperDecisions });
        const record = verified.result;
        const completed = await tx.livePracticalShadowEvaluation.updateMany({
          where: { evaluationId: evaluation.evaluationId, status: 'CLAIMED', workerId: input.workerId },
          data: {
            status: 'COMPLETED',
            finishedAtMs: BigInt(input.nowMs),
            startedAtMs: BigInt(record.startedAtMs),
            endedAtMs: BigInt(record.endedAtMs),
            reconciliationGeneration: record.reconciliationGeneration,
            streamIncarnation: record.streamIncarnation,
            streamReadiness: record.streamReadiness,
            restStability: record.restStability,
            restFailure: record.restFailure,
            authorityEligible: record.authorityEligible,
            primaryBlocker: record.primaryBlocker,
            blockersJson: JSON.stringify(record.blockers),
            evidenceSchemaVersion: record.evidenceSchemaVersion,
            evidenceDigest: record.evidenceDigest,
            evidenceJson: record.evidenceJson,
          },
        });
        if (completed.count !== 1) conflict('the evaluation changed concurrently');
        for (const decision of verified.paperDecisions) {
          if (decision.evaluationId !== evaluation.evaluationId || decision.campaignId !== campaign.campaignId) conflict('a paper decision names another evaluation');
          await tx.livePracticalShadowPaperDecision.create({
            data: {
              paperDecisionId: requireId(decision.paperDecisionId, 'paperDecisionId'),
              evaluationId: decision.evaluationId,
              campaignId: decision.campaignId,
              requestedAction: decision.requestedAction,
              rolloutStage: decision.rolloutStage,
              restStability: decision.restStability,
              streamReadiness: decision.streamReadiness,
              authorityPrerequisitesMet: decision.authorityPrerequisitesMet,
              outcome: decision.outcome,
              blockersJson: JSON.stringify(decision.blockers),
              policyVersion: decision.policyVersion,
              createdAtMs: BigInt(decision.createdAtMs),
            },
          });
        }
        const stored = await readEvaluation(tx, input.evaluationId, false);
        if (stored === null) malformed('the completed evaluation vanished');
        return Object.freeze({ kind: 'COMPLETED' as const, evaluation: stored });
      });
    } catch (error) {
      // The whole completion rolled back: the evaluation stays CLAIMED and nothing was counted.
      if (isPrismaCode(error, 'P2002')) return refused('DUPLICATE_PAPER_DECISION');
      throw error;
    }
  }

  public async abortEvaluation(input: Parameters<PracticalShadowStore['abortEvaluation']>[0]): Promise<{ readonly kind: 'ABORTED' | 'REFUSED' }> {
    return this.#transaction(async (tx) => {
      const evaluation = await readEvaluation(tx, input.evaluationId, true);
      if (evaluation === null) return Object.freeze({ kind: 'REFUSED' as const });
      const aborted = await tx.livePracticalShadowEvaluation.updateMany({
        where: { evaluationId: evaluation.evaluationId, status: 'CLAIMED', workerId: input.workerId },
        data: { status: 'ABORTED', abortReason: input.reason.slice(0, 64), finishedAtMs: BigInt(input.nowMs) },
      });
      return Object.freeze({ kind: aborted.count === 1 ? 'ABORTED' as const : 'REFUSED' as const });
    });
  }

  public async loadActiveCampaign(accountId: string): Promise<PracticalShadowCampaignRecord | null> {
    const account = await this.#prisma.livePracticalShadowAccount.findUnique({ where: { accountId } });
    if (account === null || account.accountId !== accountId || account.activeCampaignId === null) return null;
    return this.loadCampaign(account.activeCampaignId);
  }

  public async loadCampaign(campaignId: string): Promise<PracticalShadowCampaignRecord | null> {
    const rows = await this.#prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT ${CAMPAIGN_COLUMNS} FROM live_practical_shadow_campaign WHERE campaign_id = ${campaignId}`);
    const row = exactly(rows, 'campaignId', campaignId);
    return row === null ? null : parseCampaign(row);
  }

  /**
   * One REPEATABLE READ transaction (InnoDB consistent snapshot from its
   * first read): the campaign, the sequence cutoff, every evaluation up to
   * the cutoff, and their paper decisions are all from the same instant, so a
   * report or replay taken while collection runs is internally consistent.
   */
  public async snapshotCampaign(campaignId: string): Promise<PracticalShadowCampaignSnapshot | null> {
    return this.#prisma.$transaction(async (tx) => {
      const campaign = await readCampaign(tx, campaignId, false);
      if (campaign === null) return null;
      const cutoffRows = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT COALESCE(MAX(sequence), 0) AS cutoff FROM live_practical_shadow_evaluation WHERE campaign_id = ${campaignId}`);
      const cutoffSequence = toInt(cutoffRows[0]?.['cutoff'] ?? 0, 'snapshot.cutoff');
      const evaluationRows = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT ${EVALUATION_COLUMNS} FROM live_practical_shadow_evaluation
        WHERE campaign_id = ${campaignId} AND sequence <= ${cutoffSequence} ORDER BY sequence`);
      const paperRows = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT ${PAPER_COLUMNS} FROM live_practical_shadow_paper_decision p
        WHERE p.campaign_id = ${campaignId} AND p.evaluation_id IN (SELECT e.evaluation_id FROM live_practical_shadow_evaluation e WHERE e.campaign_id = ${campaignId} AND e.sequence <= ${cutoffSequence})
        ORDER BY p.paper_decision_id`);
      return Object.freeze({
        campaign,
        evaluations: Object.freeze(evaluationRows.map(parseEvaluation)),
        paperDecisions: Object.freeze(paperRows.map(parsePaperDecision)),
        cutoffSequence,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: TRANSACTION_TIMEOUT_MS });
  }
}
