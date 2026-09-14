import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../persistence/prisma';
import { RiskAdmissionCoordinator, authorizeStrategyDispatch } from '../../dispatch';
import { SerialQueue } from '../../dispatch/serial-queue';
import type { AdmissionRequest } from '../../dispatch';
import {
  PaperAccountKernel, PaperAccountReconciler, PaperPersistenceError, SystemClock,
  type Clock, type PaperAccountReconciliationResult, type PaperAccountRuntime, type PaperCloseExecutionResult, type PaperOpenExecutionResult,
} from '../../execution/persistence';
import { disclosePaperFundingExcluded } from '../../execution/funding-capability';
import { mintPaperOpenExecutionAuthority, type PaperOpenRiskEvidence } from '../../execution/open-authority';
import { mintPaperCloseExecutionAuthority, type PaperClosePositionBinding, type PaperCloseRiskEvidence } from '../../execution/close-authority';
import type { ExecutionPolicySnapshot } from '../../execution/policy';
import { issueResearchApprovalOrigin, type ResearchValidationPlanResult } from '../../research/research-validation';
import type { RiskEvaluationContext, RiskPolicy } from '../../risk';
import type { StrategyDecision, StrategyKernel } from '../../strategies';
import { getTrustedPaperExecutionEvidence } from './execution-evidence-adapter';
import { CoinDcxPaperEvidence } from './paper-evidence';

/**
 * [P14-I] Production PAPER runtime composition.
 *
 * Wires the already-verified, frozen Phase14 components — trusted strategy
 * dispatch, Phase13 RiskEngine (via `RiskAdmissionCoordinator`), P14-D durable
 * admission, P14-B trusted market evidence, P14-E paper execution, P14-G
 * restart/rehydration, P14-H reconciliation — into ONE safe production
 * PAPER-only runtime surface. It invents no execution economics, risk rules,
 * identity rules, or funding economics: every economic mutation is performed
 * by the exact existing `PaperAccountSession.executeOpen`/`executeClose`;
 * every authority is minted by the exact existing
 * `mintPaperOpenExecutionAuthority`/`mintPaperCloseExecutionAuthority`.
 *
 * Lives under `src/integration/coindcx/` rather than `src/execution/**`
 * deliberately: `src/execution/**` is ESLint-forbidden from importing the
 * CoinDCX integration surface (`eslint.config.mjs`, V2 §25 paper/live
 * isolation) — this composition root necessarily depends on both the paper
 * execution tree and the P14-B evidence provider, so it sits on the
 * integration side of that boundary (mirroring `execution-evidence-adapter.ts`'s
 * own placement), never inside the isolated tree itself.
 *
 * [P14-I-A1, authoritative] A P14-H `UNHEALTHY` reconciliation result blocks
 * ALL economic mutation — OPEN and CLOSE alike. There is no reduce-only CLOSE
 * exception. This is PAPER mode only (no real exchange exposure requiring
 * emergency liquidation); do not infer future LIVE behavior from this rule.
 * Once external correction makes a fresh reconciliation HEALTHY again, normal
 * OPEN/CLOSE operation resumes — historical `PaperReconciliationFault` rows
 * never permanently disable an account, and no automatic repair is ever
 * introduced here or anywhere upstream.
 */

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

export type PaperProductionRuntimeFailureCode =
  | 'RECONCILIATION_UNHEALTHY'
  | 'HEALTH_STALE'
  | 'EVIDENCE_UNAVAILABLE'
  | 'AUTHORITY_REJECTED'
  | 'POSITION_NOT_OPEN';

/** Mirrors `PaperPersistenceError`'s exact `code`+message+`cause` shape. Lower-layer errors (`STALE_FENCE`, `RECONCILIATION_REQUIRED`, `FUNDING_INVARIANT_VIOLATION`, ...) are never wrapped — they propagate as their own `PaperPersistenceError` untouched (§36/§46). */
export class PaperProductionRuntimeError extends Error {
  public readonly code: PaperProductionRuntimeFailureCode;
  public constructor(code: PaperProductionRuntimeFailureCode, message: string, options?: { readonly cause?: unknown }) {
    super(`[${code}] ${message}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PaperProductionRuntimeError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Public parameter/state shapes
// ---------------------------------------------------------------------------

/** Same shape as `PaperOpenRiskEvidence`/`PaperCloseRiskEvidence` (both `Omit<RiskEvaluationContext, 'strategyOrigin' | 'candidate'>`) — defined once here for P14-I's own public surface. */
export type PaperProductionRiskEvidence = Omit<RiskEvaluationContext, 'strategyOrigin' | 'candidate'>;

export interface ProductionOpenParams {
  readonly kernel: StrategyKernel;
  readonly decision: StrategyDecision;
  readonly instrumentSpecSnapshotId: string;
  readonly planResult: ResearchValidationPlanResult;
  readonly policy: RiskPolicy;
  readonly riskEvidence: PaperProductionRiskEvidence;
  readonly executionPolicy: ExecutionPolicySnapshot;
  readonly priceIncrement: string;
  readonly quantityIncrement: string;
}

export interface ProductionCloseParams {
  readonly kernel: StrategyKernel;
  readonly decision: StrategyDecision;
  readonly instrumentSpecSnapshotId: string;
  readonly policy: RiskPolicy;
  readonly riskEvidence: PaperProductionRiskEvidence;
  readonly executionPolicy: ExecutionPolicySnapshot;
  readonly priceIncrement: string;
}

/** P14-I's OWN readiness — distinct from `CoinRuntime` lifecycle and from `PaperAccountKernelState` (§32). */
export type PaperAccountProductionState = 'STARTING' | 'READY' | 'NOT_READY';

export interface StartPaperAccountProductionRuntimeParams {
  readonly accountId: string;
  readonly coordinator: RiskAdmissionCoordinator;
  readonly provider: CoinDcxPaperEvidence;
}

const PRODUCTION_ISSUER = Symbol('P14-I PaperAccountProductionRuntime issuer — only PaperAccountProductionComposer.start may construct one');

/**
 * [P14-I] Non-forgeable READY production facade for exactly one paper
 * account. Mirrors `PaperAccountRuntime` (P14-G)/`PaperAccountSession`'s own
 * symbol-gated-constructor pattern (§33) — a caller cannot fabricate
 * `{ state: 'READY', ... }` and gain mutation access, because the real
 * mutation methods below are the only path to `session.executeOpen`/
 * `executeClose`, which themselves remain gated by the session's own
 * internal `SESSION_PROOF`/ownership checks. Its mere existence is the
 * readiness proof, exactly like `PaperAccountRuntime`'s (§30 reused here).
 *
 * Owns no daemon/scheduler/HTTP endpoint (§57) — it is reusable orchestration
 * logic only, invoked directly by a caller for one OPEN/CLOSE at a time.
 */
export class PaperAccountProductionRuntime {
  public readonly accountId: string;
  readonly #kernelRuntime: PaperAccountRuntime;
  readonly #reconciler: PaperAccountReconciler;
  readonly #provider: CoinDcxPaperEvidence;
  readonly #coordinator: RiskAdmissionCoordinator;
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;
  readonly #mutationQueue = new SerialQueue();

  /** @internal — only `PaperAccountProductionComposer.start` may construct one; throws for any other caller. */
  public constructor(
    issuer: symbol, accountId: string, kernelRuntime: PaperAccountRuntime, reconciler: PaperAccountReconciler,
    provider: CoinDcxPaperEvidence, coordinator: RiskAdmissionCoordinator, prismaClient: PrismaClient, clock: Clock,
  ) {
    if (issuer !== PRODUCTION_ISSUER) {
      throw new PaperProductionRuntimeError('AUTHORITY_REJECTED', 'Only PaperAccountProductionComposer.start may construct a PaperAccountProductionRuntime');
    }
    this.accountId = accountId;
    this.#kernelRuntime = kernelRuntime;
    this.#reconciler = reconciler;
    this.#provider = provider;
    this.#coordinator = coordinator;
    this.#prisma = prismaClient;
    this.#clock = clock;
    Object.freeze(this);
  }

  /** Always `'READY'` — an instance cannot exist in any other state (§32/§33). */
  public get state(): 'READY' {
    return 'READY';
  }

  public get ownerFence(): bigint {
    return this.#kernelRuntime.ownerFence;
  }

  /** Immutable, safe read-only view — never the mutable underlying P14-G rehydration objects (§70). */
  public readSnapshot(): Readonly<{ accountId: string; ownerFence: bigint; positions: PaperAccountRuntime['positions'] }> {
    return Object.freeze({ accountId: this.accountId, ownerFence: this.#kernelRuntime.ownerFence, positions: this.#kernelRuntime.positions });
  }

  /** Read-only diagnostic re-run of P14-H reconciliation — no gating side effect beyond the reconciler's own idempotent fault persistence (§69). */
  public refreshHealth(): Promise<PaperAccountReconciliationResult> {
    return this.#reconciler.reconcile(this.accountId);
  }

  /**
   * Production OPEN. Serialized per-account (§13) via the internal
   * `SerialQueue` — never globally (§60). Every call independently obtains a
   * FRESH P14-H reconciliation immediately before mutating (§12/§29): a prior
   * HEALTHY observation, even from a call made moments earlier through this
   * SAME runtime, is never reused.
   */
  public executeOpen(params: ProductionOpenParams): Promise<PaperOpenExecutionResult> {
    return this.#mutationQueue.enqueue(() => this.#executeOpenLocked(params));
  }

  /** Production CLOSE — same per-account serialization and fresh-health requirement as `executeOpen` (§12/§13/§24-§28). */
  public executeClose(params: ProductionCloseParams): Promise<PaperCloseExecutionResult> {
    return this.#mutationQueue.enqueue(() => this.#executeCloseLocked(params));
  }

  /**
   * [P14-I-A1] Pre-mutation gate, run fresh before every OPEN and every
   * CLOSE with no exception. A fence mismatch (a newer owner has taken over
   * since this runtime started) reuses the existing `PaperPersistenceError`
   * `STALE_FENCE` code — the exact condition the DB-level checks would also
   * reject, just detected earlier (§11/§14/§36/§51); it is never swallowed or
   * relabeled. An `UNHEALTHY` reconciliation blocks unconditionally — OPEN
   * and CLOSE alike, per the authoritative P14-I-A1 decision — before any
   * risk admission, authority minting, evidence acquisition, or execution
   * transaction is attempted (§30).
   */
  async #assertFreshlyHealthy(): Promise<PaperAccountReconciliationResult> {
    const health = await this.#reconciler.reconcile(this.accountId);
    if (health.ownerFence !== this.#kernelRuntime.ownerFence) {
      throw new PaperPersistenceError(
        'STALE_FENCE',
        `Reconciliation observed ownerFence ${health.ownerFence} for ${this.accountId}, but this production runtime holds fence ${this.#kernelRuntime.ownerFence} — a newer owner has taken over`,
      );
    }
    if (health.status === 'UNHEALTHY') {
      throw new PaperProductionRuntimeError(
        'RECONCILIATION_UNHEALTHY',
        `Account ${this.accountId} is UNHEALTHY (${health.issues.length} reconciliation issue(s)) — no economic mutation may proceed until a fresh reconciliation reports HEALTHY`,
        { cause: health },
      );
    }
    return health;
  }

  async #executeOpenLocked(params: ProductionOpenParams): Promise<PaperOpenExecutionResult> {
    const health = await this.#assertFreshlyHealthy();

    const researchApproval = issueResearchApprovalOrigin(params.planResult, {
      pair: params.kernel.pair, strategyId: params.kernel.strategyId, strategyVersion: params.kernel.strategyVersion, parameterHash: params.kernel.parameterHash,
    });
    if (researchApproval === null) throw new PaperProductionRuntimeError('AUTHORITY_REJECTED', 'Research approval origin was rejected for the supplied plan result/kernel');
    const authorized = authorizeStrategyDispatch(params.kernel, params.decision, params.instrumentSpecSnapshotId, researchApproval);
    if (authorized === null) throw new PaperProductionRuntimeError('AUTHORITY_REJECTED', 'Strategy dispatch authorization was rejected');

    const admissionContext: RiskEvaluationContext = { ...params.riskEvidence, strategyOrigin: authorized.strategyOrigin, candidate: authorized.candidate };
    const admissionRequest: AdmissionRequest = { accountId: this.accountId, policy: params.policy, context: admissionContext };
    // [F14-06] Bind admission to the exact revision this call's own fresh
    // health observation just saw, atomically re-verified under the account
    // lock inside admitAndPersist itself — never a separate preflight check.
    const admitted = await this.#kernelRuntime.session.admitAndPersist(params.kernel.pair, admissionRequest, this.#coordinator, health.revision);
    if (admitted.outcome === 'SOURCE_DECISION_ALREADY_EXECUTED') {
      // §22 terminal retry idempotency — nothing left to admit/mint/execute; the durable terminal fact already exists.
      return disclosePaperFundingExcluded({ outcome: 'SOURCE_DECISION_ALREADY_EXECUTED' as const });
    }
    if (admitted.outcome !== 'ADMITTED') {
      throw new PaperProductionRuntimeError('AUTHORITY_REJECTED', `Durable admission was not granted for account ${this.accountId}: ${admitted.outcome}`, { cause: admitted });
    }

    const evidenceRead = getTrustedPaperExecutionEvidence(this.#provider, params.kernel.pair);
    if (evidenceRead.state !== 'AVAILABLE') throw new PaperProductionRuntimeError('EVIDENCE_UNAVAILABLE', `Fresh P14-B trusted evidence unavailable for ${params.kernel.pair}: ${evidenceRead.reason}`);

    const authority = await mintPaperOpenExecutionAuthority({
      coordinator: this.#coordinator, accountId: this.accountId, kernel: params.kernel, decision: params.decision,
      instrumentSpecSnapshotId: params.instrumentSpecSnapshotId, planResult: params.planResult, policy: params.policy,
      evidence: params.riskEvidence as PaperOpenRiskEvidence,
    });
    if (authority === null) throw new PaperProductionRuntimeError('AUTHORITY_REJECTED', 'OPEN execution authority was not granted');

    // [F14-06] Admission itself just atomically advanced the account revision
    // to `admitted.accountRevision` — the OPEN fill transaction must bind to
    // THAT new value, never the pre-admission `health.revision`.
    return this.#kernelRuntime.session.executeOpen(authority, {
      evidence: evidenceRead.evidence, priceIncrement: params.priceIncrement, quantityIncrement: params.quantityIncrement,
      executionPolicy: params.executionPolicy, nowMs: this.#clock.nowMs(),
    }, this.#coordinator, admitted.accountRevision);
  }

  async #executeCloseLocked(params: ProductionCloseParams): Promise<PaperCloseExecutionResult> {
    const health = await this.#assertFreshlyHealthy();
    const pair = params.kernel.pair;

    // Fresh durable read (never the P14-G rehydration snapshot taken at
    // startup, and never a previous CLOSE authority) — §24/§25. P14-E's own
    // transaction independently re-verifies revision/ownership at fill time
    // regardless; this is defense-in-depth, not the final authority (§14).
    const slot = await this.#prisma.paperPosition.findUnique({ where: { accountId_pair: { accountId: this.accountId, pair } } });
    if (
      slot === null || slot.status !== 'OPEN' || slot.positionInstanceId === null || slot.quantity === null
      || slot.ownerStrategyInstanceId === null || slot.ownerStrategyId === null || slot.ownerStrategyVersion === null || slot.ownerParameterHash === null
    ) {
      throw new PaperProductionRuntimeError('POSITION_NOT_OPEN', `No current genuine OPEN position for (${this.accountId}, ${pair})`);
    }
    const position: PaperClosePositionBinding = {
      positionInstanceId: slot.positionInstanceId, positionRevision: slot.revision, ownerStrategyInstanceId: slot.ownerStrategyInstanceId,
      ownerStrategyId: slot.ownerStrategyId, ownerStrategyVersion: slot.ownerStrategyVersion, ownerParameterHash: slot.ownerParameterHash,
      ownedQuantity: slot.quantity.toFixed(),
    };

    const evidenceRead = getTrustedPaperExecutionEvidence(this.#provider, pair);
    if (evidenceRead.state !== 'AVAILABLE') throw new PaperProductionRuntimeError('EVIDENCE_UNAVAILABLE', `Fresh P14-B trusted evidence unavailable for ${pair}: ${evidenceRead.reason}`);

    const authority = await mintPaperCloseExecutionAuthority({
      coordinator: this.#coordinator, accountId: this.accountId, kernel: params.kernel, decision: params.decision,
      instrumentSpecSnapshotId: params.instrumentSpecSnapshotId, policy: params.policy, evidence: params.riskEvidence as PaperCloseRiskEvidence, position,
    });
    if (authority === null) throw new PaperProductionRuntimeError('AUTHORITY_REJECTED', 'CLOSE execution authority was not granted');

    // [F14-06] CLOSE has no admission step of its own — bind directly to this
    // call's own fresh health observation, atomically re-verified under the
    // account lock inside executeClose itself.
    return this.#kernelRuntime.session.executeClose(authority, {
      evidence: evidenceRead.evidence, priceIncrement: params.priceIncrement, executionPolicy: params.executionPolicy, nowMs: this.#clock.nowMs(),
    }, health.revision);
  }
}
Object.freeze(PaperAccountProductionRuntime.prototype);
Object.freeze(PaperAccountProductionRuntime);

/**
 * [P14-I] The single production composition root (§4). Composes around the
 * already-verified `PaperAccountKernel` (P14-G) and `PaperAccountReconciler`
 * (P14-H) rather than reimplementing restart/rehydration/reconciliation
 * logic. Reuses `PaperAccountKernel.startPaperAccountRuntime`'s own
 * single-flight/READY-cache semantics (§35/§71) — this composer never
 * constructs a second `PaperAccountSession` manually and never bypasses the
 * kernel's cache.
 *
 * Startup order (§7): kernel READY -> fresh P14-H reconciliation -> verify
 * the reconciliation's `ownerFence`/`revision` correspond to the runtime
 * `PaperAccountKernel` just produced -> HEALTHY required -> only then a
 * `PaperAccountProductionRuntime` is constructed and returned. Any failure
 * along this chain never releases/stealss the underlying P14-G ownership
 * (§73) — the kernel runtime simply remains cached inside `PaperAccountKernel`
 * itself, retryable via a later `start()` call once external correction makes
 * reconciliation HEALTHY, with no new fence acquisition required.
 */
/** [F14-07] A cached READY facade paired with the exact P14-G kernel runtime it was built from — the only reliable way to detect that the kernel has since had to recover a FAULTED session underneath it (a brand-new `PaperAccountRuntime` instance), since the kernel's own diagnostic `getState()` never reflects a post-startup session fault. */
interface CachedProductionEntry {
  readonly runtime: PaperAccountProductionRuntime;
  readonly kernelRuntime: PaperAccountRuntime;
}

export class PaperAccountProductionComposer {
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;
  readonly #kernel: PaperAccountKernel;
  readonly #reconciler: PaperAccountReconciler;
  readonly #states = new Map<string, PaperAccountProductionState>();
  readonly #readyRuntimes = new Map<string, CachedProductionEntry>();
  readonly #inFlight = new Map<string, Promise<PaperAccountProductionRuntime>>();

  public constructor(params?: { readonly prisma?: PrismaClient; readonly clock?: Clock; readonly kernel?: PaperAccountKernel; readonly reconciler?: PaperAccountReconciler }) {
    this.#prisma = params?.prisma ?? defaultPrisma;
    this.#clock = params?.clock ?? new SystemClock();
    this.#kernel = params?.kernel ?? new PaperAccountKernel(this.#prisma);
    this.#reconciler = params?.reconciler ?? new PaperAccountReconciler(this.#prisma, this.#clock);
  }

  /** Diagnostic-only (`'STARTING'` default if never attempted in this process) — never a usable mutation surface (§32). */
  public getState(accountId: string): PaperAccountProductionState {
    return this.#states.get(accountId) ?? 'STARTING';
  }

  /**
   * Resolves only once the account is fully production-READY (§7). Rejects,
   * leaving the account `NOT_READY`, if P14-G fails to start, if the health
   * binding check fails (`HEALTH_STALE`), or if P14-H reports `UNHEALTHY`
   * (`RECONCILIATION_UNHEALTHY`) — no partially-started production facade is
   * ever returned (§8/§33).
   *
   * [P14-I §71/§72] An already-READY account (still holding a live,
   * still-READY underlying kernel session) returns the SAME cached runtime
   * with no re-acquisition, no re-reconciliation, no fence mutation —
   * idempotent composition mirroring `PaperAccountKernel`'s own cache exactly.
   */
  public start(params: StartPaperAccountProductionRuntimeParams): Promise<PaperAccountProductionRuntime> {
    const { accountId } = params;

    const existingFlight = this.#inFlight.get(accountId);
    if (existingFlight !== undefined) return existingFlight;

    const promise = this.#startOrReuse(params);
    this.#inFlight.set(accountId, promise);
    const clearInFlight = (): void => {
      if (this.#inFlight.get(accountId) === promise) this.#inFlight.delete(accountId);
    };
    promise.then(clearInFlight, clearInFlight);
    return promise;
  }

  /**
   * [F14-07] Never trusts a cached READY facade on the strength of the
   * kernel's own diagnostic `getState()` alone — that map is set once at the
   * end of a successful `PaperAccountKernel#start()` and is never updated
   * when the underlying `PaperAccountSession` later faults (e.g. an
   * outcome-ambiguous admission/execution failure), so it can read `'READY'`
   * long after the session genuinely is not. The kernel itself remains the
   * sole recovery authority (§19): every `start()` call re-verifies through
   * `PaperAccountKernel.startPaperAccountRuntime` itself, which (a) is a
   * cheap, no-DB-I/O no-op when the cached session is genuinely still READY
   * (P14-G-MAJ-02's own idempotent cache), and (b) transparently performs
   * genuine kernel-level fault recovery — a fresh ownership/restore sequence
   * producing a brand-new `PaperAccountRuntime` instance — when it is not.
   * Only when the kernel hands back the EXACT SAME runtime instance this
   * facade was built from is the cached facade still valid and returned with
   * no re-reconciliation; any other outcome (a new instance, or a thrown
   * failure) discards the stale facade and falls through to a full
   * `#startFresh` — fresh P14-H reconciliation included — before any new
   * READY facade can ever be produced.
   */
  async #startOrReuse(params: StartPaperAccountProductionRuntimeParams): Promise<PaperAccountProductionRuntime> {
    const { accountId, coordinator } = params;
    const cachedEntry = this.#readyRuntimes.get(accountId);
    if (cachedEntry !== undefined) {
      let kernelRuntime: PaperAccountRuntime;
      try {
        kernelRuntime = await this.#kernel.startPaperAccountRuntime({ accountId, coordinator, prisma: this.#prisma, clock: this.#clock });
      } catch {
        // Kernel-level recovery itself failed — the stale facade is
        // definitely no longer valid; fall through to #startFresh, whose own
        // try/catch reports the real failure and leaves the account NOT_READY.
        this.#readyRuntimes.delete(accountId);
        this.#states.set(accountId, 'NOT_READY');
        return this.#startFresh(params);
      }
      if (kernelRuntime === cachedEntry.kernelRuntime) return cachedEntry.runtime;
      // The kernel had to recover (a genuinely new PaperAccountRuntime) —
      // the cached production facade wraps the OLD, now-discarded session
      // and must never be returned as READY again.
      this.#readyRuntimes.delete(accountId);
      this.#states.set(accountId, 'NOT_READY');
    }
    return this.#startFresh(params);
  }

  async #startFresh(params: StartPaperAccountProductionRuntimeParams): Promise<PaperAccountProductionRuntime> {
    const { accountId, coordinator, provider } = params;
    this.#states.set(accountId, 'STARTING');

    try {
      const kernelRuntime = await this.#kernel.startPaperAccountRuntime({ accountId, coordinator, prisma: this.#prisma, clock: this.#clock });

      const health = await this.#reconciler.reconcile(accountId);
      if (health.ownerFence !== kernelRuntime.ownerFence || health.revision !== kernelRuntime.session.snapshot.revision) {
        throw new PaperProductionRuntimeError(
          'HEALTH_STALE',
          `Reconciliation observation (fence ${health.ownerFence}, revision ${health.revision}) for ${accountId} does not correspond to the just-started runtime (fence ${kernelRuntime.ownerFence}, revision ${kernelRuntime.session.snapshot.revision})`,
        );
      }
      if (health.status === 'UNHEALTHY') {
        // §8/§73: the P14-G kernel runtime is left exactly as-is — not
        // released, not faulted — so it remains cached inside
        // PaperAccountKernel itself and a later start() (after external
        // correction) can retry without a fresh ownership acquisition.
        throw new PaperProductionRuntimeError(
          'RECONCILIATION_UNHEALTHY',
          `Account ${accountId} failed P14-H reconciliation at startup (${health.issues.length} issue(s)) — production runtime not exposed`,
          { cause: health },
        );
      }

      const runtime = new PaperAccountProductionRuntime(PRODUCTION_ISSUER, accountId, kernelRuntime, this.#reconciler, provider, coordinator, this.#prisma, this.#clock);
      this.#readyRuntimes.set(accountId, { runtime, kernelRuntime });
      this.#states.set(accountId, 'READY');
      return runtime;
    } catch (cause) {
      // Any failure along the startup chain — P14-G itself failing (e.g.
      // FUNDING_INVARIANT_VIOLATION/RECONCILIATION_REQUIRED/STALE_FENCE) or
      // P14-I's own HEALTH_STALE/RECONCILIATION_UNHEALTHY gates — leaves this
      // account NOT_READY; the original, meaningful error always propagates
      // unchanged (§8/§46).
      this.#states.set(accountId, 'NOT_READY');
      throw cause;
    }
  }
}
