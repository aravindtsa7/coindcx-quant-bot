/** Reviewed, unwired account owner. No operational module imports this module. */
import { types } from 'node:util';
import type { PrismaClient } from '@prisma/client';
import { resolveLiveExecutionGate } from '../../../execution/live/gate';
import { PracticalRecoveryCertificate } from '../../../execution/live/practical/certificate';
import { issuePracticalLiveSafetyEnablement, type PracticalSafetyCeilings } from '../../../execution/live/practical/policy';
import { PracticalCancelService, type PracticalCancelBookkeeping } from '../../../execution/live/practical-cancel/service';
import type { PracticalCancelResult } from '../../../execution/live/practical-cancel/ports';
import { createOwnedPracticalCancelMutationStore } from '../../../execution/live/practical-mutation/repository';
import { createOwnedPracticalSafetyRepository } from '../../../execution/live/practical-persistence/repository';
import { createOwnedPracticalRecoveryService, PracticalRecoveryService } from '../../../execution/live/practical-recovery/service';
import { practicalPrivateStreamReadiness, practicalStreamHealthTrip } from '../../../execution/live/practical-recovery/private-events';
import { newLiveRuntimeIdentity, readLiveRuntimeEpoch } from '../../../execution/live/reconciliation/barrier';
import { createOwnedLiveReconciliationRepository } from '../../../execution/live/reconciliation/repository';
import { createOwnedLiveReconciliationService } from '../../../execution/live/reconciliation/service';
import { createOwnedLiveExecutionRepository } from '../../../execution/live/repository';
import {
  createCoinDcxPracticalCredentialSources, readCoinDcxPracticalCredentialSources, checkCoinDcxCredentialScope,
  type CoinDcxCredentialConstructionOptions, type CoinDcxCredentialOriginAssociation, type CoinDcxPracticalSourceSet,
} from './practical-credential-sources';

export interface PracticalAccountPolicy {
  readonly liveExecutionEnabled: 'true';
  readonly practicalSafetyEnabled: 'true';
  readonly pairAllowlist: string;
  readonly maxOrderNotionalInr: string;
  readonly requestTimeoutMs: number;
  readonly certificateLifetimeMs?: number;
  readonly minimumPasses?: number;
  readonly minimumCertificationSpanMs?: number;
  readonly minimumPassSpacingMs?: number;
  readonly firstMutationDwellMs?: number;
  readonly postIssuanceDwellMs?: number;
}
export interface PracticalAccountConstruction {
  readonly prisma: PrismaClient;
  readonly credentials: CoinDcxCredentialConstructionOptions;
  readonly policy: PracticalAccountPolicy;
  /** Optional existing genuine association; never a reconstructed tuple. */
  readonly association?: CoinDcxCredentialOriginAssociation;
}
export type PracticalAccountAdmission = 'CLOSED' | 'OPEN' | 'BUSY' | 'BOOKKEEPING_ONLY' | 'TERMINAL';
export type PracticalAccountPhase = 'CONSTRUCTED' | 'PREVIOUS_RUNTIME_RECOVERY' | 'STARTUP_RECOVERY' | 'STREAM_PROOF'
  | 'WATCH' | 'RECONCILIATION' | 'CERTIFICATION' | 'DWELL' | 'ADMITTED' | 'STARTUP_SETTLEMENT'
  | 'CANCEL_SETTLEMENT' | 'BOOKKEEPING_SETTLEMENT' | 'OBSERVER_SETTLEMENT' | 'CANCEL_DRAIN' | 'RECOVERY_SETTLEMENT' | 'STOP_WATCH' | 'FINAL_SETTLEMENT' | 'UNSUBSCRIBE' | 'STOP_STREAM' | 'STOPPED';
export type PracticalAccountStartup = Readonly<{ kind: 'ADMITTED' | 'BLOCKED' | 'STOPPED' | 'STARTUP_DEADLINE'; phase: PracticalAccountPhase }>;
export type PracticalShutdownStatus = 'PENDING_OBSERVATION' | 'TERMINAL_REFUSAL' | 'BUDGET_EXPIRED' | 'COMPLETE';
export type PracticalShutdownReason = 'IN_FLIGHT' | 'BOOKKEEPING_PENDING' | 'DRAIN_BLOCKED' | 'DRAIN_REFUSED'
  | 'AUTHORITY_OUTSTANDING' | 'STARTUP_EFFECT_UNKNOWN' | 'CANCEL_EFFECT_UNKNOWN' | 'OWNER_REFUSED'
  | 'OPERATIONAL_FAILURE' | 'CLOCK_ANOMALY' | 'SCHEDULING_BUDGET_EXPIRED' | 'COMPLETED';
export type PracticalAccountShutdown = Readonly<{
  kind: 'LOCAL_SHUTDOWN_COMPLETED' | 'BLOCKED' | 'SHUTDOWN_DEADLINE'; phase: PracticalAccountPhase;
  status: PracticalShutdownStatus; pendingOperations: number; lastSettledPhase: PracticalAccountPhase | null;
  reason: PracticalShutdownReason;
  localDrain: 'NOT_OBSERVED' | 'LOCAL_DRAINED' | 'IN_FLIGHT' | 'BOOKKEEPING_PENDING' | 'BLOCKED' | 'REFUSED';
}>;
export type PracticalAccountCancel = Exclude<PracticalCancelResult, { kind: 'BOOKKEEPING_PENDING' }>
  | Readonly<{ kind: 'BOOKKEEPING_PENDING'; phase: 'ACQUIRE' | 'CLEANUP' | 'COMPLETION'; code: string }>;

const NO_SHUTDOWN_SCHEDULE = Symbol('NO_SHUTDOWN_SCHEDULE');
interface ShutdownPhaseRecord {
  work: Promise<unknown> | null;
  state: 'PENDING' | 'FULFILLED' | 'REJECTED' | 'UNSCHEDULED';
  started: boolean; result: unknown;
}
interface RetainedCancelWork { readonly work: Promise<PracticalCancelResult>; settled: boolean; result: PracticalCancelResult | null }
const ISSUER = Object.freeze({});
const STARTUP_BUDGET_MS = 300_000;
const SHUTDOWN_BUDGET_MS = 30_000;
const OBSERVATION_MS = 50;
const owners = new WeakMap<CoinDcxCredentialOriginAssociation, CoinDcxPracticalAccountCoordinator>();
const CREDENTIAL_KEYS = ['apiKey', 'apiSecret', 'configuredAccountId', 'expectedProviderAccountFingerprint', 'restOrigin', 'streamEndpoint'] as const;
const CEILING_KEYS = ['certificateLifetimeMs', 'minimumPasses', 'minimumCertificationSpanMs', 'minimumPassSpacingMs', 'firstMutationDwellMs', 'postIssuanceDwellMs'] as const;
const POLICY_KEYS = ['liveExecutionEnabled', 'practicalSafetyEnabled', 'pairAllowlist', 'maxOrderNotionalInr', 'requestTimeoutMs', ...CEILING_KEYS] as const;

/** Reject a Proxy before reflection and all accessors before any field read. */
function data(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || types.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(descriptors[key]!, 'value')) return null;
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) snapshot[key] = descriptors[key]?.value;
  return Object.freeze(snapshot);
}
interface Composition {
  readonly association: CoinDcxCredentialOriginAssociation;
  readonly sources: Readonly<CoinDcxPracticalSourceSet>;
  readonly accountId: string;
  readonly runtimeEpoch: string;
  readonly ceilings: PracticalSafetyCeilings;
  readonly recovery: ReturnType<typeof createOwnedPracticalRecoveryService>;
  readonly mutation: ReturnType<typeof createOwnedPracticalCancelMutationStore>;
  readonly persistence: ReturnType<typeof createOwnedPracticalSafetyRepository>;
  readonly reconciliation: ReturnType<typeof createOwnedLiveReconciliationService>;
  readonly cancel: PracticalCancelService;
  readonly runtimeIdentity: ReturnType<typeof newLiveRuntimeIdentity>;
}

/** No owner, credential, evidence, fence or bookkeeping continuation is public. */
export class CoinDcxPracticalAccountCoordinator {
  readonly #owned: Composition;
  #admission: PracticalAccountAdmission = 'CLOSED';
  #phase: PracticalAccountPhase = 'CONSTRUCTED';
  #stopped = false;
  #startupExpired = false;
  #startupDeadline = 0;
  #lastNow = 0;
  #startupWork: Promise<PracticalAccountStartup> | null = null;
  #startupSettled = true;
  #startupReported: Promise<PracticalAccountStartup> | null = null;
  #startupEffectUnknown = false;
  #certificate: PracticalRecoveryCertificate | null = null;
  #expected: Parameters<PracticalCancelService['cancel']>[0]['expected'] | null = null;
  #watch: Awaited<ReturnType<Composition['recovery']['startWatch']>> | null = null;
  #initial: Awaited<ReturnType<Composition['persistence']['loadAccount']>> | null = null;
  #previous: Awaited<ReturnType<Composition['mutation']['recoverPreviousRuntimeCancelLease']>> | null = null;
  #recovered: Awaited<ReturnType<Composition['recovery']['recoverAtStartup']>> | null = null;
  #reconciled: Awaited<ReturnType<Composition['reconciliation']['reconcileAccount']>> | null = null;
  #certified: Awaited<ReturnType<Composition['recovery']['certifyAccount']>> | null = null;
  #authority: Awaited<ReturnType<Composition['recovery']['monitorAuthority']>> | null = null;
  #unsubscribe: (() => void) | null = null;
  #observerTimer: ReturnType<typeof setTimeout> | null = null;
  #observerWork: Promise<void> | null = null;
  #cancelWork: Promise<PracticalCancelResult> | null = null;
  #bookkeeping: PracticalCancelBookkeeping | null = null;
  #bookkeepingWork: Promise<PracticalCancelResult> | null = null;
  #shutdownWork: Promise<PracticalAccountShutdown> | null = null;
  #shutdownDeadline = 0;
  #shutdownExpired = false;
  #shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  #shutdownDeadlineReport: Promise<PracticalAccountShutdown> | null = null;
  #shutdownPhase: PracticalAccountPhase = 'STARTUP_SETTLEMENT';
  #shutdownRecords = new Map<PracticalAccountPhase, ShutdownPhaseRecord>();
  #lastSettledPhase: PracticalAccountPhase | null = null;
  #shutdownTerminalReason: PracticalShutdownReason | null = null;
  #shutdownPendingReason: PracticalShutdownReason = 'IN_FLIGHT';
  #shutdownComplete = false;
  #shutdownRetrySpent = false;
  #cancelEffectUnknown = false;
  #observerEffectUnknown = false;
  #retainedCancelWork: RetainedCancelWork[] = [];
  #dwellTimer: ReturnType<typeof setTimeout> | null = null;
  #dwellResolve: (() => void) | null = null;
  #drained: Awaited<ReturnType<PracticalCancelService['drain']>> | null = null;
  #watchStopped: Awaited<ReturnType<Composition['recovery']['stopWatch']>> | null = null;

  public constructor(issuer: unknown, owned: Composition) {
    if (issuer !== ISSUER || new.target !== CoinDcxPracticalAccountCoordinator) throw new Error('COORDINATOR_CONSTRUCTION_REFUSED');
    this.#owned = owned;
    Object.freeze(this);
  }
  public snapshot(): Readonly<{ admission: PracticalAccountAdmission; phase: PracticalAccountPhase; stopRequested: boolean }> {
    return Object.freeze({ admission: this.#admission, phase: this.#shutdownDeadline === 0 ? this.#phase : this.#shutdownPhase, stopRequested: this.#stopped });
  }
  public requestStop(): Readonly<{ kind: 'ADMISSION_CLOSED' }> {
    if (!this.#stopped) {
      this.#stopped = true;
      this.#admission = 'TERMINAL';
      if (this.#observerTimer !== null) { clearTimeout(this.#observerTimer); this.#observerTimer = null; }
      this.#cancelDwellPause();
      if (this.#bookkeepingWork !== null) this.#shutdownRetrySpent = true;
      this.#owned.cancel.requestStop();
    }
    return Object.freeze({ kind: 'ADMISSION_CLOSED' });
  }
  #cancelDwellPause(): void {
    if (this.#dwellTimer !== null) clearTimeout(this.#dwellTimer);
    this.#dwellTimer = null;
    const resolve = this.#dwellResolve;
    this.#dwellResolve = null;
    resolve?.();
  }
  #pauseDwell(delayMs: number): Promise<void> {
    return new Promise(resolve => {
      this.#dwellResolve = resolve;
      this.#dwellTimer = setTimeout(() => {
        this.#dwellTimer = null;
        this.#dwellResolve = null;
        resolve();
      }, delayMs);
    });
  }
  #now(): number {
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || now < this.#lastNow) throw new Error('COORDINATOR_CLOCK_ANOMALY');
    this.#lastNow = now;
    return now;
  }
  #owns(): boolean { return owners.get(this.#owned.association) === this; }
  #startupAllowed(): boolean {
    if (this.#stopped || this.#startupExpired || this.#admission === 'TERMINAL' || !this.#owns()
      || this.#now() >= this.#startupDeadline) return false;
    if (this.#watch?.kind === 'WATCHING'
      && practicalStreamHealthTrip(this.#owned.sources.privateStream.getHealthSnapshot(), this.#watch.watch.binding) !== null) {
      this.#admission = 'TERMINAL';
      return false;
    }
    return !this.#stopped && !this.#startupExpired && (this.#admission as PracticalAccountAdmission) !== 'TERMINAL' && this.#owns()
      && this.#now() < this.#startupDeadline;
  }
  #startupRefusal(): PracticalAccountStartup {
    this.#admission = 'TERMINAL';
    return Object.freeze({ kind: this.#stopped ? 'STOPPED' : this.#startupExpired || this.#now() >= this.#startupDeadline ? 'STARTUP_DEADLINE' : 'BLOCKED', phase: this.#phase });
  }
  #watchUnchanged(): boolean {
    return this.#certificate !== null && PracticalRecoveryService.checkOriginalCertificateWatch(this.#owned.recovery,
      { certificate: this.#certificate, trustedNowMs: this.#now() }).kind === 'UNCHANGED';
  }
  public start(): Promise<PracticalAccountStartup> {
    if (this.#startupReported !== null) return this.#startupReported;
    if (this.#stopped) return this.#startupReported = Promise.resolve(Object.freeze({ kind: 'STOPPED', phase: this.#phase }));
    try {
      this.#startupDeadline = this.#now() + STARTUP_BUDGET_MS;
      if (!Number.isSafeInteger(this.#startupDeadline)) throw new Error('COORDINATOR_CLOCK_ANOMALY');
    } catch {
      this.#admission = 'TERMINAL';
      return this.#startupReported = Promise.resolve(Object.freeze({ kind: 'BLOCKED', phase: this.#phase }));
    }
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<PracticalAccountStartup>(resolve => {
      timer = setTimeout(() => {
        this.#startupExpired = true;
        this.#admission = 'TERMINAL';
        this.#cancelDwellPause();
        resolve(Object.freeze({ kind: 'STARTUP_DEADLINE', phase: this.#phase }));
      }, STARTUP_BUDGET_MS);
    });
    this.#startupSettled = false;
    this.#startupWork = this.#startup().finally(() => { this.#startupSettled = true; });
    this.#startupReported = Promise.race([this.#startupWork, deadline]).finally(() => clearTimeout(timer));
    return this.#startupReported;
  }
  async #startup(): Promise<PracticalAccountStartup> {
    try {
      this.#phase = 'PREVIOUS_RUNTIME_RECOVERY';
      this.#initial = await this.#owned.persistence.loadAccount(this.#owned.accountId);
      if (!this.#startupAllowed()) return this.#startupRefusal();
      if (this.#initial.kind === 'MALFORMED' || this.#initial.kind === 'FOUND' && this.#initial.account.fence.mode.kind === 'MUTATION_LEASED') {
        this.#previous = await this.#owned.mutation.recoverPreviousRuntimeCancelLease({ accountId: this.#owned.accountId,
          runtimeIdentity: this.#owned.runtimeIdentity, trustedNowMs: this.#now() });
        if (!this.#startupAllowed()) return this.#startupRefusal();
        if (this.#previous.kind === 'MALFORMED_LATCHED') return this.#startupRefusal();
      }
      this.#phase = 'STARTUP_RECOVERY';
      this.#recovered = await this.#owned.recovery.recoverAtStartup();
      if (!this.#startupAllowed()) return this.#startupRefusal();
      if (this.#recovered.kind !== 'READY') return this.#startupRefusal();
      this.#phase = 'STREAM_PROOF';
      await this.#owned.sources.privateStream.start();
      if (!this.#startupAllowed()) return this.#startupRefusal();
      // The genuine adapter has no provider confirmation and remains blocked here.
      if (practicalPrivateStreamReadiness(this.#owned.sources.privateStream.getHealthSnapshot()).kind !== 'PROVEN_READY') return this.#startupRefusal();
      this.#phase = 'WATCH';
      this.#watch = await this.#owned.recovery.startWatch();
      if (!this.#startupAllowed()) return this.#startupRefusal();
      if (this.#watch.kind !== 'WATCHING') return this.#startupRefusal();
      this.#unsubscribe = this.#owned.sources.privateStream.subscribe(() => { this.#admission = 'TERMINAL'; });
      this.#phase = 'RECONCILIATION';
      this.#reconciled = await this.#owned.reconciliation.reconcileAccount(this.#owned.accountId);
      if (!this.#startupAllowed()) return this.#startupRefusal();
      if (this.#reconciled.kind !== 'COMPLETED' || this.#reconciled.result.status !== 'HEALTHY'
        || this.#reconciled.result.generation <= this.#watch.reconciliationGenerationAtArm
        || this.#reconciled.result.generation <= this.#recovered.account.fence.reconciliationGeneration) return this.#startupRefusal();
      this.#phase = 'CERTIFICATION';
      this.#certified = await this.#owned.recovery.certifyAccount();
      // The native result is retained even when late; it never establishes admission after stop/expiry.
      if (!this.#startupAllowed() || this.#certified.kind !== 'CERTIFIED') return this.#startupRefusal();
      this.#certificate = this.#certified.certificate;
      const fence = this.#certified.account.fence;
      this.#expected = Object.freeze({ accountId: fence.accountId, runtimeEpoch: fence.runtimeEpoch,
        reconciliationGeneration: fence.reconciliationGeneration, revision: fence.revision });
      if (!this.#watchUnchanged()) { this.#certificate = null; this.#expected = null; return this.#startupRefusal(); }
      this.#phase = 'DWELL';
      const record = PracticalRecoveryCertificate.read(this.#certificate)!;
      const dwellEnd = record.issuedAtMs + Math.max(this.#owned.ceilings.firstMutationDwellMs, this.#owned.ceilings.postIssuanceDwellMs);
      do {
        this.#authority = await this.#owned.recovery.monitorAuthority();
        if (!this.#startupAllowed()) return this.#startupRefusal();
        if (this.#authority.kind !== 'CERTIFICATE_STILL_VALID' || !this.#watchUnchanged()) return this.#startupRefusal();
        if (this.#now() >= dwellEnd) break;
        await this.#pauseDwell(Math.min(OBSERVATION_MS, dwellEnd - this.#now()));
        if (!this.#startupAllowed()) return this.#startupRefusal();
      } while (!this.#stopped && !this.#startupExpired);
      if (!this.#startupAllowed() || !this.#watchUnchanged() || this.#admission === 'TERMINAL') return this.#startupRefusal();
      this.#admission = 'OPEN';
      this.#phase = 'ADMITTED';
      this.#scheduleObservation();
      return Object.freeze({ kind: 'ADMITTED', phase: this.#phase });
    } catch {
      // A rejected operation may have a late durable effect. Never discard it or assert drainage.
      this.#startupEffectUnknown = true;
      this.#admission = 'TERMINAL';
      return Object.freeze({ kind: 'BLOCKED', phase: this.#phase });
    }
  }
  #scheduleObservation(): void {
    if (this.#stopped || this.#admission !== 'OPEN' || this.#observerTimer !== null || this.#observerWork !== null || !this.#owns()) return;
    this.#observerTimer = setTimeout(() => {
      this.#observerTimer = null;
      if (this.#stopped || this.#admission !== 'OPEN' || this.#observerWork !== null || !this.#owns()) return;
      this.#observerWork = Promise.resolve().then(() => this.#observe()).finally(() => {
        this.#observerWork = null;
        this.#scheduleObservation();
      });
    }, OBSERVATION_MS);
  }
  async #observe(): Promise<void> {
    try {
      if (this.#stopped || this.#admission !== 'OPEN' || !this.#owns() || !this.#watchUnchanged()) return;
      if (this.#stopped || this.#admission !== 'OPEN' || !this.#owns()) return;
      this.#authority = await this.#owned.recovery.monitorAuthority();
      if (this.#authority.kind !== 'CERTIFICATE_STILL_VALID' || !this.#watchUnchanged() || !this.#owns()) this.#admission = 'TERMINAL';
    } catch { this.#observerEffectUnknown = true; this.#admission = 'TERMINAL'; }
  }
  #freshAdmissionCheck(): boolean {
    return !this.#stopped && this.#owns() && this.#certificate !== null
      && PracticalRecoveryCertificate.status(this.#certificate) === 'ISSUED' && this.#watchUnchanged()
      && !this.#stopped && this.#owns();
  }
  #project(result: PracticalCancelResult): PracticalAccountCancel {
    if (result.kind === 'BOOKKEEPING_PENDING') return Object.freeze({ kind: result.kind, phase: result.phase, code: result.code });
    return result;
  }
  #retainCancel(result: PracticalCancelResult): void {
    if (result.kind === 'BOOKKEEPING_PENDING') this.#bookkeeping = result.continuation;
    else if (result.kind === 'COMPLETED' || result.kind === 'NOT_COMMITTED') this.#bookkeeping = null;
    // Only two results permit re-use, and only after a fresh original-watch check.
    const reusable = result.kind === 'NOT_COMMITTED' && result.certificateStatus === 'ISSUED'
      || result.kind === 'REFUSED' && result.phase === 'PREFLIGHT' && result.code === 'INVALID_INPUT';
    this.#admission = reusable && this.#freshAdmissionCheck() ? 'OPEN'
      : result.kind === 'BOOKKEEPING_PENDING' ? 'BOOKKEEPING_ONLY' : 'TERMINAL';
    if (this.#stopped) this.#admission = 'TERMINAL';
    if (this.#admission === 'OPEN') this.#scheduleObservation();
  }
  #retainWork(work: Promise<PracticalCancelResult>): RetainedCancelWork {
    const record: RetainedCancelWork = { work, settled: false, result: null };
    this.#retainedCancelWork.push(record);
    return record;
  }
  #unknownCancel(): PracticalCancelResult {
    this.#cancelEffectUnknown = true;
    this.#admission = 'TERMINAL';
    return Object.freeze({ kind: 'BLOCKED', phase: 'PREFLIGHT', code: 'OPERATIONAL_FAILURE' });
  }
  public async cancel(input: Readonly<{ intentId: string }>): Promise<PracticalAccountCancel> {
    const refuse = () => Object.freeze({ kind: 'REFUSED' as const, phase: 'PREFLIGHT' as const, code: 'ADMISSION_CLOSED' as const });
    if (this.#stopped || this.#admission !== 'OPEN' || this.#cancelWork !== null || this.#bookkeepingWork !== null || !this.#owns()) return refuse();
    this.#admission = 'BUSY';
    try {
      const values = data(input, ['intentId']);
      if (values === null || typeof values['intentId'] !== 'string' || !/^[0-9a-f]{64}$/.test(values['intentId'])) {
        this.#admission = this.#freshAdmissionCheck() ? 'OPEN' : 'TERMINAL';
        return Object.freeze({ kind: 'REFUSED', phase: 'PREFLIGHT', code: 'INVALID_INPUT' });
      }
      if (!this.#freshAdmissionCheck() || this.#expected === null || this.#certificate === null) {
        this.#admission = 'TERMINAL'; return refuse();
      }
      const request = Object.freeze({ intentId: values['intentId'], expected: this.#expected, certificate: this.#certificate });
      // Reservation and retained promise precede invocation, including synchronous throw.
      const work = Promise.resolve().then(() => {
        if (!this.#freshAdmissionCheck()) return refuse();
        return this.#owned.cancel.cancel(request);
      }).catch(() => this.#unknownCancel());
      this.#cancelWork = work;
      const record = this.#retainWork(work);
      try {
        const result = await work;
        record.settled = true; record.result = result;
        this.#retainCancel(result);
        return this.#project(result);
      } finally { this.#cancelWork = null; }
    } catch { return this.#project(this.#unknownCancel()); }
  }
  #reserveBookkeeping(forShutdown: boolean): Promise<PracticalCancelResult> | null {
    if (this.#bookkeeping === null || this.#bookkeepingWork !== null || this.#cancelWork !== null
      || (this.#stopped && this.#shutdownRetrySpent) || (forShutdown && !this.#shutdownSchedulingAllowed())) return null;
    const continuation = this.#bookkeeping;
    if (this.#stopped) this.#shutdownRetrySpent = true;
    const work = Promise.resolve().then(() => {
      if (forShutdown && !this.#shutdownSchedulingAllowed()) throw NO_SHUTDOWN_SCHEDULE;
      return this.#owned.cancel.retryBookkeeping({ continuation });
    }).catch(error => {
      if (error === NO_SHUTDOWN_SCHEDULE) return Object.freeze({ kind: 'REFUSED' as const, phase: 'CLEANUP' as const, code: 'ADMISSION_CLOSED' as const });
      return this.#unknownCancel();
    });
    this.#bookkeepingWork = work;
    const record = this.#retainWork(work);
    void work.then(result => {
      record.settled = true; record.result = result;
      try { this.#retainCancel(result); }
      catch { this.#unknownCancel(); }
    }).finally(() => { this.#bookkeepingWork = null; });
    return work;
  }
  public async retryBookkeeping(): Promise<PracticalAccountCancel> {
    if (this.#shutdownDeadline !== 0) return Object.freeze({ kind: 'REFUSED', phase: 'CLEANUP', code: 'OPERATION_IN_PROGRESS' });
    const work = this.#reserveBookkeeping(false);
    if (work === null) return Object.freeze({ kind: 'REFUSED', phase: 'CLEANUP', code: 'OPERATION_IN_PROGRESS' });
    return this.#project(await work);
  }
  #shutdownSchedulingAllowed(): boolean {
    if (this.#shutdownComplete || this.#shutdownTerminalReason !== null || this.#shutdownExpired) return false;
    if (!this.#owns()) { this.#shutdownTerminalReason = 'OWNER_REFUSED'; return false; }
    try {
      if (this.#now() >= this.#shutdownDeadline) { this.#shutdownExpired = true; return false; }
      return true;
    } catch { this.#shutdownTerminalReason = 'CLOCK_ANOMALY'; return false; }
  }
  #shutdownReport(): PracticalAccountShutdown {
    if (!this.#shutdownComplete && this.#shutdownDeadline !== 0 && !this.#shutdownExpired) this.#shutdownSchedulingAllowed();
    const observations: readonly PracticalAccountPhase[] = ['STARTUP_SETTLEMENT', 'CANCEL_SETTLEMENT', 'BOOKKEEPING_SETTLEMENT', 'OBSERVER_SETTLEMENT'];
    const pendingOperations = [...this.#shutdownRecords.entries()].filter(([phase, record]) => !observations.includes(phase) && record.state === 'PENDING').length
      + this.#retainedCancelWork.filter(record => !record.settled).length
      + (this.#startupSettled ? 0 : 1) + (this.#observerWork === null ? 0 : 1);
    let observed: ReturnType<PracticalCancelService['snapshotDrainWithoutRetry']> | null = null;
    try { if (this.#drained !== null) observed = this.#owned.cancel.snapshotDrainWithoutRetry(); }
    catch { this.#shutdownTerminalReason = 'OPERATIONAL_FAILURE'; }
    const status: PracticalShutdownStatus = this.#shutdownComplete ? 'COMPLETE' : this.#shutdownExpired
      ? 'BUDGET_EXPIRED' : this.#shutdownTerminalReason !== null ? 'TERMINAL_REFUSAL' : 'PENDING_OBSERVATION';
    return Object.freeze({ kind: status === 'COMPLETE' ? 'LOCAL_SHUTDOWN_COMPLETED' : status === 'BUDGET_EXPIRED' ? 'SHUTDOWN_DEADLINE' : 'BLOCKED',
      phase: this.#shutdownPhase, status, pendingOperations, lastSettledPhase: this.#lastSettledPhase,
      reason: status === 'COMPLETE' ? 'COMPLETED' : status === 'BUDGET_EXPIRED' ? 'SCHEDULING_BUDGET_EXPIRED'
        : this.#shutdownTerminalReason ?? this.#shutdownPendingReason,
      localDrain: observed?.kind ?? 'NOT_OBSERVED' });
  }
  #shutdownStep<T>(phase: PracticalAccountPhase, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#shutdownRecords.get(phase);
    if (previous !== undefined) return previous.work as Promise<T>;
    if (!this.#shutdownSchedulingAllowed()) return Promise.reject(NO_SHUTDOWN_SCHEDULE);
    this.#shutdownPhase = phase;
    const record: ShutdownPhaseRecord = { work: null, state: 'PENDING', started: false, result: null };
    this.#shutdownRecords.set(phase, record);
    const work = Promise.resolve().then(() => {
      if (!this.#shutdownSchedulingAllowed()) { record.state = 'UNSCHEDULED'; throw NO_SHUTDOWN_SCHEDULE; }
      record.started = true;
      return operation();
    }).then(result => {
      record.state = 'FULFILLED'; record.result = result; this.#lastSettledPhase = phase;
      return result;
    }, error => {
      if (record.state !== 'UNSCHEDULED') record.state = 'REJECTED';
      record.result = error === NO_SHUTDOWN_SCHEDULE ? 'SCHEDULING_BUDGET_EXPIRED' : 'OPERATIONAL_FAILURE';
      throw error;
    });
    record.work = work;
    return work;
  }
  public shutdown(): Promise<PracticalAccountShutdown> {
    try { this.requestStop(); }
    catch { this.#shutdownTerminalReason = 'OPERATIONAL_FAILURE'; return Promise.resolve(this.#shutdownReport()); }
    if (this.#shutdownDeadline === 0) {
      try {
        this.#shutdownDeadline = this.#now() + SHUTDOWN_BUDGET_MS;
        if (!Number.isSafeInteger(this.#shutdownDeadline)) throw new Error('CLOCK_ANOMALY');
        this.#shutdownDeadlineReport = new Promise(resolve => {
          this.#shutdownTimer = setTimeout(() => { this.#shutdownTimer = null; this.#shutdownExpired = true; resolve(this.#shutdownReport()); }, SHUTDOWN_BUDGET_MS);
        });
      } catch { this.#shutdownTerminalReason = 'CLOCK_ANOMALY'; return Promise.resolve(this.#shutdownReport()); }
    }
    if (this.#shutdownComplete || this.#shutdownTerminalReason !== null || !this.#shutdownSchedulingAllowed()) return Promise.resolve(this.#shutdownReport());
    if (this.#shutdownWork !== null) return Promise.race([this.#shutdownWork.then(() => this.#shutdownReport()), this.#shutdownDeadlineReport!]);
    this.#shutdownWork = this.#shutdownPump().finally(() => {
      this.#shutdownWork = null;
      if ((this.#shutdownComplete || this.#shutdownTerminalReason !== null) && this.#shutdownTimer !== null) {
        clearTimeout(this.#shutdownTimer); this.#shutdownTimer = null;
      }
    });
    return Promise.race([this.#shutdownWork.then(() => this.#shutdownReport()), this.#shutdownDeadlineReport!]);
  }
  async #shutdownPump(): Promise<PracticalAccountShutdown> {
    try {
      await this.#shutdownStep('STARTUP_SETTLEMENT', () => this.#startupWork === null ? undefined : this.#startupWork.then(() => undefined));
      if (!this.#shutdownSchedulingAllowed()) return this.#shutdownReport();
      if (this.#startupEffectUnknown) { this.#shutdownTerminalReason = 'STARTUP_EFFECT_UNKNOWN'; return this.#shutdownReport(); }
      await this.#shutdownStep('CANCEL_SETTLEMENT', () => this.#cancelWork === null ? undefined : this.#cancelWork.then(() => undefined));
      if (!this.#shutdownSchedulingAllowed()) return this.#shutdownReport();
      if (this.#cancelEffectUnknown) { this.#shutdownTerminalReason = 'CANCEL_EFFECT_UNKNOWN'; return this.#shutdownReport(); }
      await this.#shutdownStep('BOOKKEEPING_SETTLEMENT', async () => {
        if (this.#bookkeepingWork !== null) { this.#shutdownRetrySpent = true; await this.#bookkeepingWork; }
        else if (this.#bookkeeping !== null) { const work = this.#reserveBookkeeping(true); if (work !== null) await work; }
      });
      if (!this.#shutdownSchedulingAllowed()) return this.#shutdownReport();
      if (this.#cancelEffectUnknown) { this.#shutdownTerminalReason = 'CANCEL_EFFECT_UNKNOWN'; return this.#shutdownReport(); }
      this.#drained = await this.#shutdownStep('CANCEL_DRAIN', () => this.#owned.cancel.observeDrainWithoutRetry());
      if (!this.#shutdownSchedulingAllowed()) return this.#shutdownReport();
      const drain = this.#owned.cancel.snapshotDrainWithoutRetry();
      if (drain.kind !== 'LOCAL_DRAINED' || this.#bookkeeping !== null) {
        if (drain.kind === 'BLOCKED') this.#shutdownTerminalReason = 'DRAIN_BLOCKED';
        else if (drain.kind === 'REFUSED' && drain.code === 'ADMISSION_NOT_CLOSED') this.#shutdownTerminalReason = 'DRAIN_REFUSED';
        else if ((drain.kind === 'BOOKKEEPING_PENDING' || this.#bookkeeping !== null) && this.#shutdownRetrySpent && this.#bookkeepingWork === null)
          this.#shutdownTerminalReason = 'BOOKKEEPING_PENDING';
        else this.#shutdownPendingReason = drain.kind === 'BOOKKEEPING_PENDING' || this.#bookkeeping !== null ? 'BOOKKEEPING_PENDING' : 'IN_FLIGHT';
        return this.#shutdownReport();
      }
      await this.#shutdownStep('OBSERVER_SETTLEMENT', () => this.#observerWork === null ? undefined : this.#observerWork);
      if (!this.#shutdownSchedulingAllowed()) return this.#shutdownReport();
      if (this.#observerEffectUnknown) { this.#shutdownTerminalReason = 'OPERATIONAL_FAILURE'; return this.#shutdownReport(); }
      await this.#shutdownStep('RECOVERY_SETTLEMENT', () => this.#owned.recovery.settled());
      if (!this.#shutdownSchedulingAllowed()) return this.#shutdownReport();
      this.#watchStopped = await this.#shutdownStep('STOP_WATCH', () => this.#owned.recovery.stopWatch());
      if (!this.#shutdownSchedulingAllowed()) return this.#shutdownReport();
      if (this.#watchStopped.kind !== 'STOPPED') { this.#shutdownTerminalReason = 'AUTHORITY_OUTSTANDING'; return this.#shutdownReport(); }
      await this.#shutdownStep('FINAL_SETTLEMENT', () => this.#owned.recovery.settled());
      if (!this.#shutdownSchedulingAllowed()) return this.#shutdownReport();
      await this.#shutdownStep('UNSUBSCRIBE', () => { this.#unsubscribe?.(); this.#unsubscribe = null; });
      if (!this.#shutdownSchedulingAllowed()) return this.#shutdownReport();
      await this.#shutdownStep('STOP_STREAM', () => {
        this.#owned.sources.privateStream.stop();
        if (!this.#shutdownSchedulingAllowed()) return;
        this.#shutdownComplete = true;
        this.#shutdownPhase = 'STOPPED';
      });
      return this.#shutdownReport();
    } catch (error) {
      if (error !== NO_SHUTDOWN_SCHEDULE) this.#shutdownTerminalReason = 'OPERATIONAL_FAILURE';
      return this.#shutdownReport();
    }
  }

}

export type PracticalAccountConstructionResult = Readonly<{ kind: 'CONSTRUCTED'; coordinator: CoinDcxPracticalAccountCoordinator }>
  | Readonly<{ kind: 'REFUSED'; code: 'INVALID_INPUT' | 'ENABLEMENT_REFUSED' | 'INVALID_ASSOCIATION' | 'ASSOCIATION_OWNED' | 'CONSTRUCTION_FAILED' }>;

export function createCoinDcxPracticalAccountCoordinator(input: PracticalAccountConstruction): PracticalAccountConstructionResult {
  const refuse = (code: Extract<PracticalAccountConstructionResult, { kind: 'REFUSED' }>['code']): PracticalAccountConstructionResult => Object.freeze({ kind: 'REFUSED', code });
  try {
    const options = data(input, ['prisma', 'credentials', 'policy', 'association']);
    if (options === null || typeof options['prisma'] !== 'object' || options['prisma'] === null) return refuse('INVALID_INPUT');
    const credentials = data(options['credentials'], CREDENTIAL_KEYS), policy = data(options['policy'], POLICY_KEYS);
    if (credentials === null || policy === null) return refuse('INVALID_INPUT');
    for (const key of CREDENTIAL_KEYS) if (credentials[key] !== undefined && typeof credentials[key] !== 'string') return refuse('INVALID_INPUT');
    for (const key of CEILING_KEYS) if (policy[key] !== undefined && (typeof policy[key] !== 'number' || !Number.isSafeInteger(policy[key]) || policy[key] <= 0)) return refuse('INVALID_INPUT');
    if (policy['liveExecutionEnabled'] !== 'true' || policy['practicalSafetyEnabled'] !== 'true'
      || typeof policy['pairAllowlist'] !== 'string' || typeof policy['maxOrderNotionalInr'] !== 'string'
      || typeof policy['requestTimeoutMs'] !== 'number' || !Number.isSafeInteger(policy['requestTimeoutMs'])
      || policy['requestTimeoutMs'] < 1 || policy['requestTimeoutMs'] > 120_000) return refuse('INVALID_INPUT');
    const accountId = credentials['configuredAccountId'], fingerprint = credentials['expectedProviderAccountFingerprint'];
    if (typeof accountId !== 'string' || typeof fingerprint !== 'string') return refuse('INVALID_INPUT');
    const live = resolveLiveExecutionGate({ NODE_ENV: 'production', LIVE_EXECUTION_ENABLED: 'true',
      LIVE_EXECUTION_ACCOUNT_ALLOWLIST: accountId, LIVE_EXECUTION_PAIR_ALLOWLIST: policy['pairAllowlist'],
      LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR: policy['maxOrderNotionalInr'], COINDCX_API_KEY: credentials['apiKey'] as string,
      COINDCX_API_SECRET: credentials['apiSecret'] as string, COINDCX_LIVE_ACCOUNT_ID: accountId, COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: fingerprint });
    const practical = issuePracticalLiveSafetyEnablement({ LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: accountId,
      LIVE_PRACTICAL_CERTIFICATE_LIFETIME_MS: policy['certificateLifetimeMs']?.toString(), LIVE_PRACTICAL_MIN_PASSES: policy['minimumPasses']?.toString(),
      LIVE_PRACTICAL_MIN_CERTIFICATION_SPAN_MS: policy['minimumCertificationSpanMs']?.toString(), LIVE_PRACTICAL_MIN_PASS_SPACING_MS: policy['minimumPassSpacingMs']?.toString(),
      LIVE_PRACTICAL_FIRST_MUTATION_DWELL_MS: policy['firstMutationDwellMs']?.toString(), LIVE_PRACTICAL_POST_ISSUANCE_DWELL_MS: policy['postIssuanceDwellMs']?.toString() });
    if (live.status !== 'ENABLED' || practical.status !== 'ENABLED') return refuse('ENABLEMENT_REFUSED');
    let association: CoinDcxCredentialOriginAssociation;
    if (options['association'] === undefined) {
      const origin = createCoinDcxPracticalCredentialSources(credentials as unknown as CoinDcxCredentialConstructionOptions);
      if (origin.kind !== 'CONSTRUCTED') return refuse('INVALID_INPUT');
      association = origin.association;
    } else association = options['association'] as CoinDcxCredentialOriginAssociation;
    const sources = readCoinDcxPracticalCredentialSources(association);
    if (sources === null || checkCoinDcxCredentialScope(association, { configuredAccountId: accountId, expectedProviderAccountFingerprint: fingerprint }).kind !== 'CONFIGURED_SCOPE_MATCH') return refuse('INVALID_ASSOCIATION');
    if (owners.has(association)) return refuse('ASSOCIATION_OWNED');
    const runtimeIdentity = newLiveRuntimeIdentity(), runtimeEpoch = readLiveRuntimeEpoch(runtimeIdentity)!;
    const prisma = options['prisma'] as PrismaClient;
    const clock = Object.freeze({ nowMs: () => Date.now() });
    const scheduler = Object.freeze({ setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) });
    const persistence = createOwnedPracticalSafetyRepository(prisma);
    const mutation = createOwnedPracticalCancelMutationStore(prisma);
    const reconciliationRepository = createOwnedLiveReconciliationRepository(prisma);
    const executionRepository = createOwnedLiveExecutionRepository(prisma);
    const recovery = createOwnedPracticalRecoveryService({ accountId, runtimeEpoch, expectedProviderAccountFingerprint: fingerprint,
      enablement: practical.enablement, persistence, venue: sources.reader, reconciliation: reconciliationRepository,
      privateStream: sources.privateStream, clock, scheduler });
    const reconciliation = createOwnedLiveReconciliationService({ repository: reconciliationRepository, executionRepository,
      evidenceProvider: sources.reader, runtimeIdentity, credentialAccountId: accountId, expectedProviderAccountFingerprint: fingerprint,
      clock, requestTimeoutMs: policy['requestTimeoutMs'] });
    const cancel = new PracticalCancelService({ store: mutation, clock, runtimeIdentity, enablement: practical.enablement,
      liveEnablement: live.enablement, recovery, gateway: sources.gateway, requestTimeoutMs: policy['requestTimeoutMs'] });
    const owned = Object.freeze({ association, sources, accountId, runtimeEpoch, ceilings: practical.enablement.ceilings,
      recovery, mutation, persistence, reconciliation, cancel, runtimeIdentity });
    const coordinator = new CoinDcxPracticalAccountCoordinator(ISSUER, owned);
    owners.set(association, coordinator); // publish only after every constructor succeeded
    return Object.freeze({ kind: 'CONSTRUCTED', coordinator });
  } catch { return refuse('CONSTRUCTION_FAILED'); }
}
Object.freeze(CoinDcxPracticalAccountCoordinator.prototype);
Object.freeze(CoinDcxPracticalAccountCoordinator);
Object.freeze(createCoinDcxPracticalAccountCoordinator);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const [name, value] of Object.entries({ CoinDcxPracticalAccountCoordinator, createCoinDcxPracticalAccountCoordinator })) {
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) {
      if (descriptor.get === undefined || descriptor.set !== undefined || module.exports[name] !== value) throw new Error('COORDINATOR_EXPORT_INVALID');
    } else Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
  }
}
