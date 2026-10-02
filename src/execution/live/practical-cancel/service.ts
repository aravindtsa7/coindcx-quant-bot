import { readPracticalLiveSafetyError } from '../practical/types';
import { readPracticalPersistenceError } from '../practical-persistence/ports';
import { readLiveExecutionError } from '../errors';
import { readPracticalMutationError } from '../practical-mutation/ports';
/** Unwired owner of one cancel chain. Cleanup/retries never enter a gateway. */
import { PracticalRecoveryCertificate } from '../practical/certificate';
import { type PracticalNotDispatchedReport } from '../practical-mutation/ports';
import {
  PracticalAcquiredCancel, PracticalArmedCancel, PracticalCancelDispatchOwner,
  readPracticalUnknownAcquireReceipt,
} from '../practical-mutation/ticket';
import { checkPracticalCancelGuard, PracticalCancelGatewayBoundary } from './gateway-boundary';
import type { PracticalCancelCode, PracticalCancelDependencies, PracticalCancelDrainResult, PracticalCancelInput, PracticalCancelPhase, PracticalCancelResult, PracticalCancelTime } from './ports';
import { createPracticalCancelLifecycle, installPracticalCancelLifecycleBrand, PracticalCancelLifecycle } from './lifecycle';

type Job =
  | { readonly kind: 'ACQUIRE'; readonly owner: unknown }
  | { readonly kind: 'ABANDON'; readonly owner: unknown }
  | { readonly kind: 'ARMED'; readonly owner: unknown; readonly report: PracticalNotDispatchedReport }
  | { readonly kind: 'UNENTERED'; readonly owner: unknown; readonly report: PracticalNotDispatchedReport; readonly creationUnknown?: true }
  | { readonly kind: 'OUTCOME'; readonly owner: unknown };
const BOOKKEEPING_ISSUER = Object.freeze({ purpose: 'unwired-cancel-bookkeeping' });

/** No public fields contain ownership; no restart/clone/cross-service restoration. */
export class PracticalCancelBookkeeping {
  readonly #service: PracticalCancelService;
  #job: Job;
  #status: 'READY' | 'RUNNING' | 'SPENT' = 'READY';
  public constructor(issuer: unknown, service: PracticalCancelService, job: Job) {
    if (issuer !== BOOKKEEPING_ISSUER) throw new Error('INVALID_BOOKKEEPING_ISSUER');
    this.#service = service;
    this.#job = job;
    Object.freeze(this);
  }
  public static reserve(issuer: unknown, service: PracticalCancelService, value: unknown): Job | null {
    if (issuer !== BOOKKEEPING_ISSUER || typeof value !== 'object' || value === null || !(#service in value)
      || value.#service !== service || value.#status !== 'READY') return null;
    value.#status = 'RUNNING';
    return value.#job;
  }
  public static finish(issuer: unknown, value: PracticalCancelBookkeeping, job: Job | null): void {
    if (issuer !== BOOKKEEPING_ISSUER || value.#status !== 'RUNNING') throw new Error('INVALID_BOOKKEEPING_TRANSITION');
    if (job !== null) value.#job = job;
    value.#status = job === null ? 'SPENT' : 'READY';
  }
}
Object.freeze(PracticalCancelBookkeeping.prototype);
Object.freeze(PracticalCancelBookkeeping);

/** Reject hostile/unknown/inherited fields without reading accessors. */
function fields(value: unknown, expected: readonly string[]): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) return null;
    const result: Record<string, unknown> = {};
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return null; }
}
function codeOf(error: unknown): PracticalCancelCode {
  if ((readPracticalMutationError(error) !== null) || (readLiveExecutionError(error) !== null)
    || (readPracticalPersistenceError(error) !== null) || (readPracticalLiveSafetyError(error) !== null)) return (readPracticalMutationError(error) ?? readLiveExecutionError(error) ?? readPracticalPersistenceError(error) ?? readPracticalLiveSafetyError(error))!.code;
  return 'OPERATIONAL_FAILURE';
}
function blocked(phase: PracticalCancelPhase, code: PracticalCancelCode): PracticalCancelResult {
  return Object.freeze({ kind: 'BLOCKED', phase, code });
}
function reportFor(code: PracticalCancelCode): PracticalNotDispatchedReport {
  return Object.freeze({ kind: 'NOT_DISPATCHED', reason: code === 'DISPATCH_WINDOW_CLOSED' || code === 'CLOCK_ANOMALY'
    ? 'DISPATCH_WINDOW_CLOSED' : code === 'ORIGINAL_WATCH_REFUSED' ? 'FINAL_STREAM_GUARD_FAILED' : 'ABORTED_BEFORE_DISPATCH' });
}

export class PracticalCancelService {
  readonly #dependencies: PracticalCancelDependencies;
  readonly #boundary: PracticalCancelGatewayBoundary;
  #running = false;
  #pending: PracticalCancelBookkeeping | null = null;
  readonly #lifecycle: PracticalCancelLifecycle;
  #draining = false;
  #phase: PracticalCancelPhase = 'PREFLIGHT';
  #operationKind: 'CANCEL' | 'BOOKKEEPING' | null = null;
  #done: Promise<void> = Promise.resolve();
  #signalDone: (() => void) | null = null;
  #unresolved: { readonly phase: PracticalCancelPhase; readonly code: PracticalCancelCode } | null = null;

  static { installPracticalCancelLifecycleBrand(value => typeof value === 'object' && value !== null && #running in value); }

  public constructor(dependencies: PracticalCancelDependencies) {
    this.#dependencies = Object.freeze({ ...dependencies });
    this.#lifecycle = createPracticalCancelLifecycle(this, this.#dependencies);
    this.#boundary = new PracticalCancelGatewayBoundary(this.#dependencies, this.#lifecycle, this);
    Object.freeze(this);
  }

  public async cancel(input: PracticalCancelInput): Promise<PracticalCancelResult> {
    if (!this.#admissionOpen()) return Object.freeze({ kind: 'REFUSED', phase: 'PREFLIGHT', code: 'ADMISSION_CLOSED' });
    if (this.#running || this.#pending !== null) return Object.freeze({ kind: 'REFUSED', phase: 'PREFLIGHT', code: 'OPERATION_IN_PROGRESS' });
    if (this.#unresolved !== null) return blocked(this.#unresolved.phase, this.#unresolved.code);
    this.#beginOperation('CANCEL'); // reservation precedes every await and caller getter
    let phase: PracticalCancelPhase = 'PREFLIGHT';
    let job: Job | null = null;
    const time: PracticalCancelTime = { lastNowMs: 0 };
    try {
      const data = fields(input, ['intentId', 'expected', 'certificate']);
      if (data === null || typeof data['intentId'] !== 'string' || !/^[0-9a-f]{64}$/.test(data['intentId'])) return Object.freeze({ kind: 'REFUSED', phase, code: 'INVALID_INPUT' });
      const certificate = data['certificate'];
      const first = this.#guard(certificate, time);
      if (first.kind === 'REFUSED') return Object.freeze({ kind: 'REFUSED', phase, code: first.code });
      const record = PracticalRecoveryCertificate.read(certificate)!;
      let guard = this.#guard(certificate, time);
      if (guard.kind === 'REFUSED') return Object.freeze({ kind: 'REFUSED', phase, code: guard.code });
      this.#phase = phase = 'ACQUIRE';
      const acquisition = await this.#dependencies.store.acquireCancelLease({ accountId: record.accountId, expected: data['expected'] as PracticalCancelInput['expected'],
        certificate, enablement: this.#dependencies.enablement, runtimeIdentity: this.#dependencies.runtimeIdentity,
        intentId: data['intentId'], trustedNowMs: guard.nowMs });
      switch (acquisition.kind) {
        case 'CERTIFICATE_TERMINATED': return Object.freeze({ kind: 'ACQUISITION_STOPPED', reason: 'CERTIFICATE_TERMINATED' });
        case 'AUTHORITY_INVALIDATED': return Object.freeze({ kind: 'ACQUISITION_STOPPED', reason: 'AUTHORITY_INVALIDATED' });
        case 'MALFORMED_LATCHED': return this.#blocked(phase, 'MANUAL_REVIEW_REQUIRED');
        case 'ACQUIRED': job = { kind: 'ABANDON', owner: acquisition.acquired }; break;
        default: return this.#blocked(phase, 'OPERATIONAL_FAILURE');
      }
      guard = this.#guard(certificate, time);
      if (guard.kind === 'REFUSED') return await this.#cleanup(job);
      this.#phase = phase = 'ARM';
      const armed = await this.#dependencies.store.armCancelLease({ acquired: acquisition.acquired, enablement: this.#dependencies.enablement,
        runtimeIdentity: this.#dependencies.runtimeIdentity, trustedNowMs: guard.nowMs });
      job = { kind: 'ARMED', owner: armed.ticket, report: reportFor('OPERATIONAL_FAILURE') };
      guard = this.#guard(certificate, time);
      if (guard.kind === 'REFUSED') return await this.#cleanup({ ...job, report: reportFor(guard.code) });
      this.#phase = phase = 'PERMISSION';
      const permitted = await this.#dependencies.store.createCancelDispatchPermission({ armed: armed.ticket, enablement: this.#dependencies.enablement,
        runtimeIdentity: this.#dependencies.runtimeIdentity, trustedNowMs: guard.nowMs });
      job = { kind: 'UNENTERED', owner: permitted.permission, report: reportFor('OPERATIONAL_FAILURE') };
      guard = this.#guard(certificate, time);
      if (guard.kind === 'REFUSED') return await this.#cleanup({ ...job, report: reportFor(guard.code) });
      this.#phase = phase = 'CONSUMPTION';
      const consumed = await this.#dependencies.store.consumeCancelDispatchPermission({ permission: permitted.permission, enablement: this.#dependencies.enablement,
        runtimeIdentity: this.#dependencies.runtimeIdentity, trustedNowMs: guard.nowMs });
      job = { kind: 'UNENTERED', owner: consumed.attempt, report: reportFor('OPERATIONAL_FAILURE') };
      this.#phase = phase = 'FINAL_GUARD';
      const result = await this.#boundary.invoke(consumed.attempt, certificate, time);
      if (result.kind === 'NOT_ENTERED') return await this.#cleanup({ ...job, report: reportFor(result.code) });
      job = { kind: 'OUTCOME', owner: result.outcome };
      this.#phase = phase = 'COMPLETION';
      return await this.#cleanup(job);
    } catch (error) {
      // Read genuine unknown-acquire provenance BEFORE any wrapping/sanitization.
      const unknown = readPracticalUnknownAcquireReceipt(error);
      if (unknown !== null) return this.#pendingResult({ kind: 'ACQUIRE', owner: unknown }, codeOf(error));
      if (job !== null && this.#cleanupEligible(job)) {
        if (job.kind === 'ARMED' && PracticalArmedCancel.status(job.owner) === 'PERMIT_CREATION_UNKNOWN') job = { kind: 'UNENTERED', owner: job.owner, report: job.report, creationUnknown: true };
        return await this.#cleanup(job);
      }
      return this.#blocked(phase, codeOf(error));
    } finally { this.#endOperation(); }
  }

  public async retryBookkeeping(input: { readonly continuation: PracticalCancelBookkeeping }): Promise<PracticalCancelResult> {
    if (this.#draining) return Object.freeze({ kind: 'REFUSED', phase: 'CLEANUP', code: 'OPERATION_IN_PROGRESS' });
    return this.#retryBookkeeping(input);
  }

  async #retryBookkeeping(input: { readonly continuation: PracticalCancelBookkeeping }): Promise<PracticalCancelResult> {
    if (this.#running) return Object.freeze({ kind: 'REFUSED', phase: 'CLEANUP', code: 'OPERATION_IN_PROGRESS' });
    this.#beginOperation('BOOKKEEPING');
    let continuation: PracticalCancelBookkeeping | null = null;
    let job: Job | null = null;
    try {
      const data = fields(input, ['continuation']);
      if (data === null || data['continuation'] !== this.#pending) return Object.freeze({ kind: 'REFUSED', phase: 'CLEANUP', code: 'INVALID_INPUT' });
      job = PracticalCancelBookkeeping.reserve(BOOKKEEPING_ISSUER, this, data['continuation']);
      if (job === null) return Object.freeze({ kind: 'REFUSED', phase: 'CLEANUP', code: 'INVALID_INPUT' });
      continuation = data['continuation'] as PracticalCancelBookkeeping;
      if (job.kind === 'ACQUIRE') {
        this.#phase = 'ACQUIRE';
        const resolution = await this.#dependencies.store.resolveUnknownAcquire({ unknown: job.owner, runtimeIdentity: this.#dependencies.runtimeIdentity, trustedNowMs: this.#cleanupNow() });
        if (resolution.kind === 'NOT_COMMITTED') {
          PracticalCancelBookkeeping.finish(BOOKKEEPING_ISSUER, continuation, null);
          continuation = null;
          this.#pending = null;
          this.#unresolved = null;
          return Object.freeze({ kind: 'NOT_COMMITTED', certificateStatus: resolution.certificateStatus });
        }
        if (resolution.kind !== 'RESTORED') return this.#blocked('ACQUIRE', 'OPERATIONAL_FAILURE');
        job = { kind: 'ABANDON', owner: resolution.acquired };
      }
      const result = await this.#execute(job);
      PracticalCancelBookkeeping.finish(BOOKKEEPING_ISSUER, continuation, result.kind === 'COMPLETED' ? null : job);
      continuation = null;
      if (result.kind === 'COMPLETED') this.#pending = null;
      return result;
    } catch (error) {
      return this.#blocked(job?.kind === 'OUTCOME' ? 'COMPLETION' : job?.kind === 'ACQUIRE' ? 'ACQUIRE' : 'CLEANUP', codeOf(error));
    } finally {
      try { if (continuation !== null && job !== null) PracticalCancelBookkeeping.finish(BOOKKEEPING_ISSUER, continuation, job); }
      finally { this.#endOperation(); }
    }
  }

  public requestStop(): { readonly kind: 'ADMISSION_CLOSED' } {
    PracticalCancelLifecycle.close(this.#lifecycle, this, this.#dependencies);
    return Object.freeze({ kind: 'ADMISSION_CLOSED' });
  }

  public async drain(): Promise<PracticalCancelDrainResult> {
    if (this.#admissionOpen()) return Object.freeze({ kind: 'REFUSED', code: 'ADMISSION_NOT_CLOSED' });
    if (this.#draining) return Object.freeze({ kind: 'REFUSED', code: 'DRAIN_IN_PROGRESS' });
    this.#draining = true;
    let expired = false;
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<void>(resolve => { timer = setTimeout(() => { expired = true; resolve(); }, 30_000); });
    try {
      const observingBookkeeping = this.#operationKind === 'BOOKKEEPING';
      if (this.#running) await Promise.race([this.#done, deadline]);
      if (expired || this.#running || observingBookkeeping) return this.#drainState();
      const pending = this.#pending;
      if (pending !== null) {
        // One exact retry only. Its reservation survives this drain's scheduling timeout.
        const work = this.#retryBookkeeping({ continuation: pending });
        await Promise.race([work.then(() => undefined, () => { this.#blocked(this.#phase, 'OPERATIONAL_FAILURE'); }), deadline]);
      }
      return this.#drainState();
    } finally { clearTimeout(timer); this.#draining = false; }
  }

  /** Observe the existing chain without a second budget or automatic retry. */
  public async observeDrainWithoutRetry(): Promise<PracticalCancelDrainResult> {
    if (this.#admissionOpen()) return Object.freeze({ kind: 'REFUSED', code: 'ADMISSION_NOT_CLOSED' });
    if (this.#draining) return Object.freeze({ kind: 'REFUSED', code: 'DRAIN_IN_PROGRESS' });
    this.#draining = true;
    try {
      if (this.#running) await this.#done;
      return this.#drainState();
    } finally { this.#draining = false; }
  }

  /** No reservation, retry, timer, durable access or gateway entry. */
  public snapshotDrainWithoutRetry(): PracticalCancelDrainResult {
    if (this.#admissionOpen()) return Object.freeze({ kind: 'REFUSED', code: 'ADMISSION_NOT_CLOSED' });
    return this.#drainState();
  }

  #admissionOpen(): boolean { return PracticalCancelLifecycle.open(this.#lifecycle, this, this.#dependencies); }
  #guard(certificate: unknown, time: PracticalCancelTime) {
    if (!this.#admissionOpen()) return Object.freeze({ kind: 'REFUSED' as const, code: 'ADMISSION_CLOSED' as const });
    const result = checkPracticalCancelGuard(this.#dependencies, certificate, time);
    return this.#admissionOpen() ? result : Object.freeze({ kind: 'REFUSED' as const, code: 'ADMISSION_CLOSED' as const });
  }
  #beginOperation(kind: 'CANCEL' | 'BOOKKEEPING'): void {
    this.#running = true;
    this.#phase = kind === 'CANCEL' ? 'PREFLIGHT' : 'CLEANUP';
    this.#operationKind = kind;
    this.#done = new Promise(resolve => { this.#signalDone = resolve; });
  }
  #endOperation(): void {
    this.#running = false;
    this.#operationKind = null;
    const resolve = this.#signalDone;
    this.#signalDone = null;
    resolve?.();
  }
  #blocked(phase: PracticalCancelPhase, code: PracticalCancelCode): PracticalCancelResult {
    this.#unresolved = Object.freeze({ phase, code });
    return blocked(phase, code);
  }
  #drainState(): PracticalCancelDrainResult {
    if (this.#running) return Object.freeze({ kind: 'IN_FLIGHT', phase: this.#phase });
    if (this.#pending !== null) return Object.freeze({ kind: 'BOOKKEEPING_PENDING', phase: this.#phase === 'ACQUIRE' ? 'ACQUIRE' : this.#phase === 'COMPLETION' ? 'COMPLETION' : 'CLEANUP' });
    if (this.#unresolved !== null) return Object.freeze({ kind: 'BLOCKED', code: this.#unresolved.code });
    return Object.freeze({ kind: 'LOCAL_DRAINED' });
  }

  #cleanupNow(): number {
    const nowMs = this.#dependencies.clock.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('INVALID_CLEANUP_TIME');
    return nowMs; // cleanup needs valid time, never renewed healthy authority
  }
  #cleanupEligible(job: Job): boolean {
    if (job.kind === 'ABANDON') return ['AVAILABLE', 'ARM_OUTCOME_UNKNOWN', 'ABANDON_OUTCOME_UNKNOWN'].includes(PracticalAcquiredCancel.status(job.owner) ?? '');
    if (job.kind === 'ARMED') return ['ARMED', 'COMMIT_UNKNOWN', 'PERMIT_CREATION_UNKNOWN'].includes(PracticalArmedCancel.status(job.owner) ?? '');
    if (job.kind === 'UNENTERED') return job.creationUnknown === true
      ? ['PERMIT_CREATION_UNKNOWN', 'TRANSFERRED'].includes(PracticalArmedCancel.status(job.owner) ?? '')
      : ['READY', 'UNENTERED', 'CONSUMPTION_UNKNOWN', 'CLEANUP_UNKNOWN'].includes(PracticalCancelDispatchOwner.status(job.owner) ?? '');
    return job.kind === 'OUTCOME' && ['READY', 'COMMIT_UNKNOWN'].includes(PracticalCancelDispatchOwner.status(job.owner) ?? '');
  }
  async #execute(job: Job): Promise<PracticalCancelResult> {
    this.#phase = job.kind === 'OUTCOME' ? 'COMPLETION' : job.kind === 'ACQUIRE' ? 'ACQUIRE' : 'CLEANUP';
    const nowMs = this.#cleanupNow();
    const store = this.#dependencies.store;
    const result = job.kind === 'OUTCOME' ? await store.completeCancelLease({ outcome: job.owner, trustedNowMs: nowMs })
      : job.kind === 'ABANDON' ? await store.abandonAcquiredCancel({ acquired: job.owner, trustedNowMs: nowMs })
      : job.kind === 'ARMED' ? await store.completeUndispatchedCancel({ armed: job.owner, report: job.report, trustedNowMs: nowMs })
      : job.kind === 'UNENTERED' ? await store.completeUnenteredCancelDispatch({ owner: job.owner, report: job.report, trustedNowMs: nowMs })
      : null;
    if (result?.kind === 'COMPLETED' || result?.kind === 'ALREADY_COMPLETED') {
      this.#unresolved = null;
      return Object.freeze({ kind: 'COMPLETED', outcome: result.outcome, disposition: result.kind });
    }
    return this.#blocked(job.kind === 'OUTCOME' ? 'COMPLETION' : 'CLEANUP', result?.kind === 'MALFORMED_LATCHED' ? 'MANUAL_REVIEW_REQUIRED' : 'OPERATIONAL_FAILURE');
  }
  #pendingResult(job: Job, code: PracticalCancelCode): PracticalCancelResult {
    const continuation = new PracticalCancelBookkeeping(BOOKKEEPING_ISSUER, this, job);
    this.#pending = continuation;
    return Object.freeze({ kind: 'BOOKKEEPING_PENDING', phase: job.kind === 'ACQUIRE' ? 'ACQUIRE' : job.kind === 'OUTCOME' ? 'COMPLETION' : 'CLEANUP', code, continuation });
  }
  async #cleanup(job: Job): Promise<PracticalCancelResult> {
    try {
      const result = await this.#execute(job);
      return result;
    } catch (error) {
      if (this.#cleanupEligible(job)) return this.#pendingResult(job, codeOf(error));
      return this.#blocked(job.kind === 'OUTCOME' ? 'COMPLETION' : 'CLEANUP', codeOf(error));
    }
  }
}

// Close the new public orchestration lookups too; mutable private lifecycle
// fields remain usable on frozen genuine instances and opaque continuations.
Object.freeze(PracticalCancelService.prototype);
Object.freeze(PracticalCancelService);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const [name, value] of Object.entries({ PracticalCancelService, PracticalCancelBookkeeping })) {
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) {
      if (descriptor.get === undefined || descriptor.set !== undefined
        || module.exports[name] !== value) throw new Error('CANCEL_SERVICE_EXPORT_BINDING_INVALID');
    } else {
      Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
    }
  }
}

// Reviewed defining-owner binding protection.
Object.freeze(PracticalCancelService.prototype);
Object.freeze(PracticalCancelService);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const name of ["PracticalCancelService"]) {
    const value = module.exports[name] as unknown;
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) {
      if (descriptor.set !== undefined || (descriptor.get === undefined && descriptor.writable !== false) || module.exports[name] !== value) throw new Error('OWNED_TRUSTED_EXPORT_INVALID');
    } else Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
  }
}
