/** Sole unwired production-source entry/result and verified transport-token owner. */
import { LiveExecutionEnablement } from '../gate';
import type { LiveCancelOrderRequest } from '../gateway';
import { PracticalRecoveryCertificate } from '../practical/certificate';
import { PracticalLiveSafetyEnablement } from '../practical/policy';
import { practicalCancelDwellMs } from '../practical-mutation/preflight';
import {
  PracticalCancelDispatchOwner, enterPracticalCancelGateway, issuePracticalCancelOutcome, issuePracticalCancelTransportNoWire,
  type PracticalCancelOutcomeReceipt,
} from '../practical-mutation/ticket';
import { PracticalRecoveryService } from '../practical-recovery/service';
import { readLiveRuntimeEpoch } from '../reconciliation/barrier';
import type { PracticalCancelDependencies, PracticalCancelLocalRefusal, PracticalCancelTime } from './ports';
import { PracticalCancelLifecycle } from './lifecycle';
import { hasCancelTransportSource, reserveCancelTransportInvocation, invokeCancelTransport, settleCancelTransportInvocation, closeCancelTransportInvocation,
  type CancelTransportInvocation } from '../practical-cancel-transport-evidence';

export type PracticalCancelGuard = { readonly kind: 'UNCHANGED'; readonly nowMs: number }
  | { readonly kind: 'REFUSED'; readonly code: PracticalCancelLocalRefusal };

/** Fresh observation, never cached authority. All source associations are genuine. */
export function checkPracticalCancelGuard(dependencies: PracticalCancelDependencies, certificate: unknown, time: PracticalCancelTime): PracticalCancelGuard {
  const refuse = (code: PracticalCancelLocalRefusal): PracticalCancelGuard => Object.freeze({ kind: 'REFUSED', code });
  try {
    const nowMs = dependencies.clock.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs < time.lastNowMs) return refuse('CLOCK_ANOMALY');
    time.lastNowMs = nowMs;
    const record = PracticalRecoveryCertificate.read(certificate);
    if (record === null) return refuse('ORIGINAL_WATCH_REFUSED');
    const runtimeEpoch = readLiveRuntimeEpoch(dependencies.runtimeIdentity);
    if (runtimeEpoch === null || runtimeEpoch !== record.runtimeEpoch) return refuse('RUNTIME_BINDING_REFUSED');
    const practical = PracticalLiveSafetyEnablement.read(dependencies.enablement);
    const live = LiveExecutionEnablement.read(dependencies.liveEnablement);
    if (practical === null || live === null || practical.stage !== 'STAGE_5A_CANCEL_ONLY'
      || !practical.accountAllowlist.includes(record.accountId) || !live.accountAllowlist.includes(record.accountId)) return refuse('ENABLEMENT_REFUSED');
    if (live.credentialAccountId !== record.accountId || live.expectedProviderAccountFingerprint !== record.providerAccountFingerprint) return refuse('ACCOUNT_BINDING_REFUSED');
    if (nowMs < record.issuedAtMs + practicalCancelDwellMs(practical.ceilings)
      || nowMs >= Math.min(record.expiresAtMs, record.issuedAtMs + practical.ceilings.certificateLifetimeMs)) return refuse('DISPATCH_WINDOW_CLOSED');
    const watch = PracticalRecoveryService.checkOriginalCertificateWatch(dependencies.recovery, { certificate, trustedNowMs: nowMs });
    if (watch.kind !== 'UNCHANGED') return refuse(watch.reason === 'CLOCK_ANOMALY' ? 'CLOCK_ANOMALY' : 'ORIGINAL_WATCH_REFUSED');
    return Object.freeze({ kind: 'UNCHANGED', nowMs });
  } catch {
    return refuse('ORIGINAL_WATCH_REFUSED');
  }
}

type Report = { readonly kind: 'CANCEL_ACCEPTED' | 'REJECTED' | 'AMBIGUOUS' };
const AMBIGUOUS: Report = Object.freeze({ kind: 'AMBIGUOUS' });

/** Do not evaluate accessors, traverse economic observations or retain raw reasons. */
function projectResult(value: unknown): Report {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return AMBIGUOUS;
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return AMBIGUOUS;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('kind')) return AMBIGUOUS;
    const fields: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string') return AMBIGUOUS;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) return AMBIGUOUS;
      fields[key] = descriptor.value;
    }
    if (fields['kind'] === 'CANCEL_ACCEPTED' && keys.includes('observation')
      && (fields['observation'] === null || (typeof fields['observation'] === 'object' && !Array.isArray(fields['observation'])))) {
      return Object.freeze({ kind: 'CANCEL_ACCEPTED' });
    }
    if (fields['kind'] === 'REJECTED' && keys.includes('reasonCode')
      && typeof fields['reasonCode'] === 'string' && fields['reasonCode'].trim() !== '') return Object.freeze({ kind: 'REJECTED' });
    // Including PRE_DISPATCH_FAILURE: the port carries no genuine transport proof.
    return AMBIGUOUS;
  } catch {
    return AMBIGUOUS;
  }
}

/** A timeout settles only our report. It neither cancels nor retries the invocation. */
function boundedReport(invocation: Promise<unknown>, timeoutMs: number, context: CancelTransportInvocation | null, attempt: unknown): Promise<PracticalCancelOutcomeReceipt> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: unknown, fulfilled: boolean): void => {
      if (settled) return;
      settled = true; // reserve terminal settlement BEFORE reflection or consuming proof
      clearTimeout(timer);
      try {
        const observation = fulfilled && context !== null ? settleCancelTransportInvocation(context, value) : null;
        if (context !== null && observation === null) closeCancelTransportInvocation(context);
        if (observation?.noWrite === true) {
          const noWire = issuePracticalCancelTransportNoWire(attempt);
          resolve(issuePracticalCancelOutcome(attempt, { kind: 'PRE_DISPATCH_FAILURE', noWire }));
        } else resolve(issuePracticalCancelOutcome(attempt, fulfilled
          ? projectResult(context === null ? value : observation?.result) : AMBIGUOUS));
      } catch { reject(new Error('CANCEL_REPORT_UNAVAILABLE')); }
    };
    const timer = setTimeout(() => finish(undefined, false), timeoutMs);
    // Late fulfilment is ignored before even reflective inspection; rejection is handled.
    invocation.then(value => finish(value, true), () => finish(undefined, false));
  });
}

export type PracticalCancelGatewayResult =
  | { readonly kind: 'NOT_ENTERED'; readonly code: PracticalCancelLocalRefusal }
  | { readonly kind: 'REPORTED'; readonly outcome: PracticalCancelOutcomeReceipt };

export class PracticalCancelGatewayBoundary {
  readonly #dependencies: PracticalCancelDependencies;
  readonly #invoke: ((request: LiveCancelOrderRequest) => Promise<unknown>) | null;
  readonly #lifecycle: PracticalCancelLifecycle;
  readonly #owner: object;
  readonly #associationDependencies: PracticalCancelDependencies;

  public constructor(dependencies: PracticalCancelDependencies, lifecycle: unknown, owner: object) {
    if (!PracticalCancelLifecycle.matches(lifecycle, owner, dependencies)) throw new Error('CANCEL_LIFECYCLE_ASSOCIATION_REFUSED');
    this.#lifecycle = lifecycle;
    this.#owner = owner;
    this.#associationDependencies = dependencies;
    if (!Number.isSafeInteger(dependencies.requestTimeoutMs) || dependencies.requestTimeoutMs < 1 || dependencies.requestTimeoutMs > 120_000) throw new Error('INVALID_CANCEL_TIMEOUT');
    this.#dependencies = Object.freeze({ ...dependencies });
    this.#invoke = hasCancelTransportSource(dependencies.gateway) ? null : dependencies.gateway.cancelOrder.bind(dependencies.gateway);
    Object.freeze(this);
  }

  public async invoke(attempt: unknown, certificate: unknown, time: PracticalCancelTime): Promise<PracticalCancelGatewayResult> {
    const owner = PracticalCancelDispatchOwner.read(attempt);
    const original = PracticalRecoveryCertificate.read(certificate);
    const live = LiveExecutionEnablement.read(this.#dependencies.liveEnablement);
    if (owner === null || owner.role !== 'ATTEMPT' || PracticalCancelDispatchOwner.status(attempt) !== 'UNENTERED'
      || original === null || owner.original.certificate.certificateId !== original.certificateId
      || owner.original.certificate.evidenceDigest !== original.evidenceDigest
      || owner.original.certificate.providerAccountFingerprint !== original.providerAccountFingerprint
      || owner.original.certificate.accountId !== original.accountId || owner.original.certificate.runtimeEpoch !== original.runtimeEpoch
      || owner.original.certificate.issuedAtMs !== original.issuedAtMs || owner.original.certificate.expiresAtMs !== original.expiresAtMs
      || owner.original.certificate.streamIncarnation !== original.streamIncarnation
      || owner.original.certificate.reconciliationGeneration !== original.reconciliationGeneration
      || owner.armed.certificateId !== original.certificateId
      || owner.armed.accountId !== original.accountId || owner.armed.runtimeEpoch !== original.runtimeEpoch
      || owner.armed.certificateStreamIncarnation !== original.streamIncarnation
      || owner.armed.reconciliationGeneration !== original.reconciliationGeneration) return Object.freeze({ kind: 'NOT_ENTERED', code: 'ENTRY_REFUSED' });
    if (live === null || !live.pairAllowlist.includes(owner.armed.pair)) return Object.freeze({ kind: 'NOT_ENTERED', code: 'ENABLEMENT_REFUSED' });
    const request = Object.freeze({ clientOrderId: owner.armed.clientOrderId, exchangeOrderId: owner.armed.exchangeOrderId,
      pair: owner.armed.pair, timeoutMs: this.#dependencies.requestTimeoutMs });
    const context = reserveCancelTransportInvocation(this.#dependencies.gateway, attempt, request);
    const guard = checkPracticalCancelGuard(this.#dependencies, certificate, time);
    if (guard.kind === 'REFUSED') { if (context !== null) closeCancelTransportInvocation(context); return Object.freeze({ kind: 'NOT_ENTERED', code: guard.code }); }
    if (guard.nowMs < owner.armed.armedAtMs) { if (context !== null) closeCancelTransportInvocation(context); return Object.freeze({ kind: 'NOT_ENTERED', code: 'CLOCK_ANOMALY' }); }
    let invocation: Promise<unknown>;
    // Last synchronous observation AFTER watch inspection; no callback or await before entry.
    if (!PracticalCancelLifecycle.open(this.#lifecycle, this.#owner, this.#associationDependencies)) {
      if (context !== null) closeCancelTransportInvocation(context);
      return Object.freeze({ kind: 'NOT_ENTERED', code: 'ADMISSION_CLOSED' });
    }
    try {
      enterPracticalCancelGateway(attempt);
    } catch {
      if (context !== null) closeCancelTransportInvocation(context);
      return Object.freeze({ kind: 'NOT_ENTERED', code: 'ENTRY_REFUSED' });
    }
    // No await, queue, telemetry or unrelated callback between entry and invocation.
    try {
      invocation = Promise.resolve(context === null ? this.#invoke!(request) : invokeCancelTransport(context));
    } catch {
      invocation = Promise.reject(new Error('CANCEL_INVOCATION_UNCERTAIN'));
    }
    const outcome = await boundedReport(invocation, this.#dependencies.requestTimeoutMs, context, attempt);
    return Object.freeze({ kind: 'REPORTED', outcome });
  }
}

// Protect the dispatch implementation before any importer can obtain it.
// Freezing an instance alone would leave its inherited invoke replaceable.
Object.freeze(PracticalCancelGatewayBoundary.prototype);
Object.freeze(PracticalCancelGatewayBoundary);

// Pin every new trusted lookup used by the orchestration service. tsc exports
// mutable properties; tsx already supplies immutable lexical getters. Never
// accept an existing immutable binding to a different value or with a setter.
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const [name, value] of Object.entries({ PracticalCancelGatewayBoundary, checkPracticalCancelGuard })) {
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) {
      if (descriptor.get === undefined || descriptor.set !== undefined
        || module.exports[name] !== value) throw new Error('CANCEL_BOUNDARY_EXPORT_BINDING_INVALID');
    } else {
      Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
    }
  }
}
