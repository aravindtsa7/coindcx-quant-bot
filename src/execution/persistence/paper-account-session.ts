import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../persistence/prisma';
import { RiskAdmissionCoordinator, type AdmissionRequest } from '../../dispatch';
// [P14-D BLK-01] Internal, non-barrel import — see admission.ts/restore.ts.
import { ACCOUNT_FAULT_RECOVERY_CAPABILITY } from '../../dispatch/admission';
import { PaperAccountRepository, type PaperAccountSnapshot, type Clock } from './account-repository';
import { PaperAccountOwnership } from './account-ownership';
// [P14-D MAJ-01] `SESSION_PROOF` is deliberately imported directly from this
// concrete module path, never re-exported from `./index.ts` — it is the
// non-forgeable token that proves a call to the bridge originates from a
// session that has already completed restore (see admission-bridge.ts).
import { PaperAdmissionBridge, SESSION_PROOF, type AdmitAndPersistResult } from './admission-bridge';
import {
  PaperExecutionEngine, type PaperCloseExecutionInputs, type PaperCloseExecutionOutcome,
  type PaperOpenExecutionInputs, type PaperOpenExecutionOutcome,
} from './execution-engine';
import { PaperPersistenceError } from './errors';
import { restoreAccountAdmissionState, type RestoreResult } from './restore';
import { disclosePaperFundingExcluded, type PaperFundingDisclosedResult } from '../funding-capability';
import type { PaperOpenExecutionAuthority } from '../open-authority';
import type { PaperCloseExecutionAuthority } from '../close-authority';

const SESSION_ISSUER = Symbol('P14-D PaperAccountSession issuer — only openPaperAccountSession may construct a session');

export type PaperOpenExecutionResult = PaperFundingDisclosedResult<PaperOpenExecutionOutcome>;
export type PaperCloseExecutionResult = PaperFundingDisclosedResult<PaperCloseExecutionOutcome>;

/**
 * [P14-D BLK-01/§15] A session's mutation lifecycle. `READY` may admit/
 * release; `FAULTED` (a durable-persistence outcome went ambiguous after
 * in-memory admission/release state had already mutated) and `RELEASED`
 * both reject every further mutation. A `FAULTED` session cannot toggle
 * itself back to `READY` — the only recovery is opening a brand-new session
 * via `openPaperAccountSession`, which performs a fresh authoritative
 * restore for the account (see `restore.ts`).
 */
export type PaperAccountSessionState = 'READY' | 'FAULTED' | 'RELEASED';

/**
 * The frozen ordering (V2 §21): acquire ownership → validate fence → coherent
 * snapshot → restore/synchronize C3 pending state → READY_FOR_ADMISSION →
 * accept new admissions. A `PaperAccountSession` cannot exist without every
 * one of those steps having already completed successfully — its mere
 * presence is the readiness proof (V2-D §32's "minimal readiness state"),
 * not a separately-checked boolean flag callers could race past. The
 * constructor itself is non-forgeable (symbol-gated, mirroring
 * `PaperAccountOwnership`): only `openPaperAccountSession` can produce a live
 * instance, so a caller cannot fabricate a "READY" session structurally by
 * passing a genuine `ownership` alongside hand-built snapshot/restore values
 * (P14-D MAJ-01). `admitAndPersist`/`releaseAndPersist` are only reachable
 * through such a session, and additionally require the session to still be
 * in `READY` state (P14-D BLK-01) — there is no path to durable admission
 * that skips restoration or continues past an outcome-ambiguous failure.
 */
export class PaperAccountSession {
  public readonly accountId: string;
  public readonly ownership: PaperAccountOwnership;
  public readonly snapshot: PaperAccountSnapshot;
  public readonly restoreResult: RestoreResult;

  #state: PaperAccountSessionState = 'READY';
  readonly #bridge: PaperAdmissionBridge;
  readonly #repository: PaperAccountRepository;
  readonly #executionEngine: PaperExecutionEngine;

  /** @internal — only `openPaperAccountSession` may construct one; throws for any other caller. */
  public constructor(
    issuer: symbol, accountId: string, ownership: PaperAccountOwnership, snapshot: PaperAccountSnapshot, restoreResult: RestoreResult,
    bridge: PaperAdmissionBridge, repository: PaperAccountRepository, executionEngine: PaperExecutionEngine,
  ) {
    if (issuer !== SESSION_ISSUER) throw new PaperPersistenceError('NOT_OWNER', 'Only openPaperAccountSession may construct a PaperAccountSession');
    this.accountId = accountId;
    this.ownership = ownership;
    this.snapshot = snapshot;
    this.restoreResult = restoreResult;
    this.#bridge = bridge;
    this.#repository = repository;
    this.#executionEngine = executionEngine;
    Object.freeze(this);
  }

  /** Current lifecycle state (§15) — private-field mutation is unaffected by `Object.freeze(this)` above. */
  public get state(): PaperAccountSessionState {
    return this.#state;
  }

  public async admitAndPersist(pair: string, request: AdmissionRequest, coordinator: RiskAdmissionCoordinator): Promise<AdmitAndPersistResult> {
    this.#assertReady();
    try {
      return await this.#bridge.admitAndPersist(SESSION_PROOF, this.ownership, pair, request, coordinator);
    } catch (cause) {
      await this.#faultIfAmbiguous(cause, coordinator);
      throw cause;
    }
  }

  public async releaseAndPersist(admissionId: string, coordinator: RiskAdmissionCoordinator): Promise<'RELEASED' | 'ALREADY_RELEASED' | 'UNKNOWN_ADMISSION'> {
    this.#assertReady();
    try {
      return await this.#bridge.releaseAndPersist(SESSION_PROOF, this.ownership, admissionId, coordinator);
    } catch (cause) {
      await this.#faultIfAmbiguous(cause, coordinator);
      throw cause;
    }
  }

  /**
   * [P14-E] Integrated PAPER OPEN economic execution. Same fault-on-ambiguous
   * wrapper as `admitAndPersist` — `PaperExecutionEngine.executeOpen` calls
   * `coordinator.release()` (reused P14-D coordinator, no fork) before its
   * final durable writes, so a failure after that point is outcome-ambiguous
   * for the identical reason and is handled identically.
   */
  public async executeOpen(authority: PaperOpenExecutionAuthority, inputs: PaperOpenExecutionInputs, coordinator: RiskAdmissionCoordinator): Promise<PaperOpenExecutionResult> {
    this.#assertReady();
    try {
      const outcome = await this.#executionEngine.executeOpen(SESSION_PROOF, this.ownership, authority, inputs, coordinator);
      return disclosePaperFundingExcluded(outcome);
    } catch (cause) {
      await this.#faultIfAmbiguous(cause, coordinator);
      throw cause;
    }
  }

  /**
   * [P14-E] Integrated PAPER CLOSE economic execution. CLOSE has no
   * reservation/coordinator interaction at all (V2.2 §41) — every write is a
   * plain DB mutation with no preceding in-memory mutation, so a failure here
   * is an ordinary rollback, never an outcome-ambiguous fault; this session is
   * never faulted by a CLOSE failure.
   */
  public executeClose(authority: PaperCloseExecutionAuthority, inputs: PaperCloseExecutionInputs): Promise<PaperCloseExecutionResult> {
    this.#assertReady();
    return this.#executionEngine.executeClose(SESSION_PROOF, this.ownership, authority, inputs)
      .then((outcome) => disclosePaperFundingExcluded(outcome));
  }

  /** Re-reads a fresh coherent snapshot under the same held ownership (does not require/change READY state — a plain read). */
  public refreshSnapshot(): Promise<PaperAccountSnapshot> {
    return this.#repository.loadCoherentSnapshot(this.ownership);
  }

  public release(): void {
    this.#repository.releaseOwnership(this.ownership);
    this.#state = 'RELEASED';
  }

  #assertReady(): void {
    if (this.#state !== 'READY') {
      throw new PaperPersistenceError(
        'ACCOUNT_NOT_READY',
        `PaperAccountSession for ${this.accountId} is ${this.#state} — a new session must be opened via openPaperAccountSession${this.#state === 'FAULTED' ? ' (authoritative restore required)' : ''}`,
      );
    }
  }

  /**
   * [P14-D BLK-01] Transitions this session to FAULTED and invalidates the
   * coordinator's in-memory projection for this account ONLY when the
   * bridge reported an outcome-AMBIGUOUS failure (durable commit unconfirmed
   * after in-memory admission/release already mutated). Any other error
   * (e.g. a clean `STALE_FENCE`/`PAIR_SLOT_UNAVAILABLE`-as-error) mutated
   * nothing and leaves this session READY.
   */
  async #faultIfAmbiguous(cause: unknown, coordinator: RiskAdmissionCoordinator): Promise<void> {
    if (cause instanceof PaperPersistenceError && cause.code === 'ADMISSION_OUTCOME_AMBIGUOUS') {
      this.#state = 'FAULTED';
      await coordinator.markAccountFaulted(ACCOUNT_FAULT_RECOVERY_CAPABILITY, this.accountId);
    }
  }
}

export interface OpenPaperAccountSessionParams {
  readonly accountId: string;
  readonly coordinator: RiskAdmissionCoordinator;
  readonly prisma?: PrismaClient;
  readonly clock?: Clock;
}

/**
 * The sole entry point that produces a `PaperAccountSession`. Requires the
 * `paper_account` row to already exist (`PaperAccountRepository.ensureAccountInitialized`
 * is a separate, explicit call — this function never invents a starting
 * capital value on the account's behalf).
 */
export async function openPaperAccountSession(params: OpenPaperAccountSessionParams): Promise<PaperAccountSession> {
  const prismaClient = params.prisma ?? defaultPrisma;
  const repository = new PaperAccountRepository(prismaClient, params.clock);
  const bridge = new PaperAdmissionBridge(prismaClient);
  const executionEngine = new PaperExecutionEngine(prismaClient);

  const ownership = await repository.acquireOwnership(params.accountId);
  const snapshot = await repository.loadCoherentSnapshot(ownership);
  const restoreResult = await restoreAccountAdmissionState(ownership, params.coordinator, prismaClient);

  return new PaperAccountSession(SESSION_ISSUER, params.accountId, ownership, snapshot, restoreResult, bridge, repository, executionEngine);
}
