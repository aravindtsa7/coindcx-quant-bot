/** Unwired owner of one cancel chain. Cleanup/retries never enter a gateway. */
import { LiveExecutionError } from '../errors';
import { PracticalRecoveryCertificate } from '../practical/certificate';
import { PracticalLiveSafetyError } from '../practical/types';
import { PracticalPersistenceError } from '../practical-persistence/ports';
import { PracticalMutationError, type PracticalNotDispatchedReport } from '../practical-mutation/ports';
import {
  PracticalAcquiredCancel, PracticalArmedCancel, PracticalCancelDispatchOwner,
  readPracticalUnknownAcquireReceipt,
} from '../practical-mutation/ticket';
import { checkPracticalCancelGuard, PracticalCancelGatewayBoundary } from './gateway-boundary';
import type { PracticalCancelCode, PracticalCancelDependencies, PracticalCancelInput, PracticalCancelPhase, PracticalCancelResult, PracticalCancelTime } from './ports';

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
  if (error instanceof PracticalMutationError || error instanceof LiveExecutionError
    || error instanceof PracticalPersistenceError || error instanceof PracticalLiveSafetyError) return error.code;
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

  public constructor(dependencies: PracticalCancelDependencies) {
    this.#dependencies = Object.freeze({ ...dependencies });
    this.#boundary = new PracticalCancelGatewayBoundary(this.#dependencies);
    Object.freeze(this);
  }

  public async cancel(input: PracticalCancelInput): Promise<PracticalCancelResult> {
    if (this.#running || this.#pending !== null) return Object.freeze({ kind: 'REFUSED', phase: 'PREFLIGHT', code: 'OPERATION_IN_PROGRESS' });
    this.#running = true; // reservation precedes every await and caller getter
    let phase: PracticalCancelPhase = 'PREFLIGHT';
    let job: Job | null = null;
    const time: PracticalCancelTime = { lastNowMs: 0 };
    try {
      const data = fields(input, ['intentId', 'expected', 'certificate']);
      if (data === null || typeof data['intentId'] !== 'string' || !/^[0-9a-f]{64}$/.test(data['intentId'])) return Object.freeze({ kind: 'REFUSED', phase, code: 'INVALID_INPUT' });
      const certificate = data['certificate'];
      const first = checkPracticalCancelGuard(this.#dependencies, certificate, time);
      if (first.kind === 'REFUSED') return Object.freeze({ kind: 'REFUSED', phase, code: first.code });
      const record = PracticalRecoveryCertificate.read(certificate)!;
      let guard = checkPracticalCancelGuard(this.#dependencies, certificate, time);
      if (guard.kind === 'REFUSED') return Object.freeze({ kind: 'REFUSED', phase, code: guard.code });
      phase = 'ACQUIRE';
      const acquisition = await this.#dependencies.store.acquireCancelLease({ accountId: record.accountId, expected: data['expected'] as PracticalCancelInput['expected'],
        certificate, enablement: this.#dependencies.enablement, runtimeIdentity: this.#dependencies.runtimeIdentity,
        intentId: data['intentId'], trustedNowMs: guard.nowMs });
      switch (acquisition.kind) {
        case 'CERTIFICATE_TERMINATED': return Object.freeze({ kind: 'ACQUISITION_STOPPED', reason: 'CERTIFICATE_TERMINATED' });
        case 'AUTHORITY_INVALIDATED': return Object.freeze({ kind: 'ACQUISITION_STOPPED', reason: 'AUTHORITY_INVALIDATED' });
        case 'MALFORMED_LATCHED': return blocked(phase, 'MANUAL_REVIEW_REQUIRED');
        case 'ACQUIRED': job = { kind: 'ABANDON', owner: acquisition.acquired }; break;
        default: return blocked(phase, 'OPERATIONAL_FAILURE');
      }
      guard = checkPracticalCancelGuard(this.#dependencies, certificate, time);
      if (guard.kind === 'REFUSED') return await this.#cleanup(job);
      phase = 'ARM';
      const armed = await this.#dependencies.store.armCancelLease({ acquired: acquisition.acquired, enablement: this.#dependencies.enablement,
        runtimeIdentity: this.#dependencies.runtimeIdentity, trustedNowMs: guard.nowMs });
      job = { kind: 'ARMED', owner: armed.ticket, report: reportFor('OPERATIONAL_FAILURE') };
      guard = checkPracticalCancelGuard(this.#dependencies, certificate, time);
      if (guard.kind === 'REFUSED') return await this.#cleanup({ ...job, report: reportFor(guard.code) });
      phase = 'PERMISSION';
      const permitted = await this.#dependencies.store.createCancelDispatchPermission({ armed: armed.ticket, enablement: this.#dependencies.enablement,
        runtimeIdentity: this.#dependencies.runtimeIdentity, trustedNowMs: guard.nowMs });
      job = { kind: 'UNENTERED', owner: permitted.permission, report: reportFor('OPERATIONAL_FAILURE') };
      guard = checkPracticalCancelGuard(this.#dependencies, certificate, time);
      if (guard.kind === 'REFUSED') return await this.#cleanup({ ...job, report: reportFor(guard.code) });
      phase = 'CONSUMPTION';
      const consumed = await this.#dependencies.store.consumeCancelDispatchPermission({ permission: permitted.permission, enablement: this.#dependencies.enablement,
        runtimeIdentity: this.#dependencies.runtimeIdentity, trustedNowMs: guard.nowMs });
      job = { kind: 'UNENTERED', owner: consumed.attempt, report: reportFor('OPERATIONAL_FAILURE') };
      phase = 'FINAL_GUARD';
      const result = await this.#boundary.invoke(consumed.attempt, certificate, time);
      if (result.kind === 'NOT_ENTERED') return await this.#cleanup({ ...job, report: reportFor(result.code) });
      job = { kind: 'OUTCOME', owner: result.outcome };
      phase = 'COMPLETION';
      return await this.#cleanup(job);
    } catch (error) {
      // Read genuine unknown-acquire provenance BEFORE any wrapping/sanitization.
      const unknown = readPracticalUnknownAcquireReceipt(error);
      if (unknown !== null) return this.#pendingResult({ kind: 'ACQUIRE', owner: unknown }, codeOf(error));
      if (job !== null && this.#cleanupEligible(job)) {
        if (job.kind === 'ARMED' && PracticalArmedCancel.status(job.owner) === 'PERMIT_CREATION_UNKNOWN') job = { kind: 'UNENTERED', owner: job.owner, report: job.report, creationUnknown: true };
        return await this.#cleanup(job);
      }
      return blocked(phase, codeOf(error));
    } finally { this.#running = false; }
  }

  public async retryBookkeeping(input: { readonly continuation: PracticalCancelBookkeeping }): Promise<PracticalCancelResult> {
    if (this.#running) return Object.freeze({ kind: 'REFUSED', phase: 'CLEANUP', code: 'OPERATION_IN_PROGRESS' });
    this.#running = true;
    let continuation: PracticalCancelBookkeeping | null = null;
    let job: Job | null = null;
    try {
      const data = fields(input, ['continuation']);
      if (data === null || data['continuation'] !== this.#pending) return Object.freeze({ kind: 'REFUSED', phase: 'CLEANUP', code: 'INVALID_INPUT' });
      job = PracticalCancelBookkeeping.reserve(BOOKKEEPING_ISSUER, this, data['continuation']);
      if (job === null) return Object.freeze({ kind: 'REFUSED', phase: 'CLEANUP', code: 'INVALID_INPUT' });
      continuation = data['continuation'] as PracticalCancelBookkeeping;
      if (job.kind === 'ACQUIRE') {
        const resolution = await this.#dependencies.store.resolveUnknownAcquire({ unknown: job.owner, runtimeIdentity: this.#dependencies.runtimeIdentity, trustedNowMs: this.#cleanupNow() });
        if (resolution.kind === 'NOT_COMMITTED') {
          PracticalCancelBookkeeping.finish(BOOKKEEPING_ISSUER, continuation, null);
          continuation = null;
          this.#pending = null;
          return Object.freeze({ kind: 'NOT_COMMITTED', certificateStatus: resolution.certificateStatus });
        }
        if (resolution.kind !== 'RESTORED') return blocked('ACQUIRE', 'OPERATIONAL_FAILURE');
        job = { kind: 'ABANDON', owner: resolution.acquired };
      }
      const result = await this.#execute(job);
      PracticalCancelBookkeeping.finish(BOOKKEEPING_ISSUER, continuation, result.kind === 'COMPLETED' ? null : job);
      continuation = null;
      if (result.kind === 'COMPLETED') this.#pending = null;
      return result;
    } catch (error) {
      return blocked(job?.kind === 'OUTCOME' ? 'COMPLETION' : job?.kind === 'ACQUIRE' ? 'ACQUIRE' : 'CLEANUP', codeOf(error));
    } finally {
      if (continuation !== null && job !== null) PracticalCancelBookkeeping.finish(BOOKKEEPING_ISSUER, continuation, job);
      this.#running = false;
    }
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
    const nowMs = this.#cleanupNow();
    const store = this.#dependencies.store;
    const result = job.kind === 'OUTCOME' ? await store.completeCancelLease({ outcome: job.owner, trustedNowMs: nowMs })
      : job.kind === 'ABANDON' ? await store.abandonAcquiredCancel({ acquired: job.owner, trustedNowMs: nowMs })
      : job.kind === 'ARMED' ? await store.completeUndispatchedCancel({ armed: job.owner, report: job.report, trustedNowMs: nowMs })
      : job.kind === 'UNENTERED' ? await store.completeUnenteredCancelDispatch({ owner: job.owner, report: job.report, trustedNowMs: nowMs })
      : null;
    if (result?.kind === 'COMPLETED' || result?.kind === 'ALREADY_COMPLETED') return Object.freeze({ kind: 'COMPLETED', outcome: result.outcome, disposition: result.kind });
    return blocked(job.kind === 'OUTCOME' ? 'COMPLETION' : 'CLEANUP', result?.kind === 'MALFORMED_LATCHED' ? 'MANUAL_REVIEW_REQUIRED' : 'OPERATIONAL_FAILURE');
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
      return blocked(job.kind === 'OUTCOME' ? 'COMPLETION' : 'CLEANUP', codeOf(error));
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
