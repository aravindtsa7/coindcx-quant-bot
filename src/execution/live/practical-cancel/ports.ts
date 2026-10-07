/** Unwired orchestration contracts. No caller selector can redirect a gateway request. */
import type { Clock } from '../../../core/time/clock';
import type { CoinDcxFuturesOrderGateway } from '../gateway';
import type { LiveExecutionFailureCode } from '../errors';
import type { LiveExecutionEnablement } from '../gate';
import type { PracticalRecoveryCertificate } from '../practical/certificate';
import type { PracticalFenceExpectation } from '../practical/fence';
import type { PracticalLiveSafetyEnablement } from '../practical/policy';
import type { PracticalRecoveryService } from '../practical-recovery/service';
import type { PracticalPersistenceErrorCode } from '../practical-persistence/ports';
import type { PracticalLiveSafetyErrorCode } from '../practical/types';
import type { LiveRuntimeIdentity } from '../reconciliation/barrier';
import type {
  PracticalCancelMutationStore, PracticalCancelDispatchStore, PracticalCancelNoWireStore,
  PracticalUnknownAcquireRecoveryStore, PracticalMutationErrorCode,
} from '../practical-mutation/ports';
import type { PracticalCancelBookkeeping } from './service';

export type PracticalCancelStore = PracticalCancelMutationStore & PracticalCancelDispatchStore
  & PracticalCancelNoWireStore & PracticalUnknownAcquireRecoveryStore;

export interface PracticalCancelDependencies {
  readonly store: PracticalCancelStore;
  readonly clock: Clock;
  readonly runtimeIdentity: LiveRuntimeIdentity;
  readonly enablement: PracticalLiveSafetyEnablement;
  readonly liveEnablement: LiveExecutionEnablement;
  readonly recovery: PracticalRecoveryService;
  readonly gateway: Pick<CoinDcxFuturesOrderGateway, 'cancelOrder'>;
  /** Trusted validated policy value; never a per-call field. */
  readonly requestTimeoutMs: number;
  /** M2 W4 (U-M2-1): the shared REST budget. Required; an unavailable or refusing budget is `BUDGET_REFUSED`. */
  readonly budget: PracticalCancelBudgetPort;
}

/**
 * M2 W4 (U-M2-1): the budget-only admission port for one practical cancel, implemented by the integration layer.
 * It can only delay or refuse. An admission is opaque: never authority, never provider data, never a certificate.
 *   - `admit` is awaited before the final guard sequence, which then re-observes everything after the wait;
 *   - `consume` is the synchronous start check after the last lifecycle observation and before gateway entry
 *     (null: `BUDGET_REFUSED`); it never awaits and never reports a start;
 *   - `release` voids an admission that was never consumed (irrevocable known non-use); a consumed one is kept.
 */
export interface PracticalCancelBudgetPort {
  admit(request: { readonly lifetimeMs: number }): Promise<object | null>;
  consume(admission: object): object | null;
  release(admission: object): void;
}

export interface PracticalCancelInput {
  readonly intentId: string;
  readonly expected: PracticalFenceExpectation;
  readonly certificate: PracticalRecoveryCertificate;
}
export type PracticalCancelPhase = 'PREFLIGHT' | 'ACQUIRE' | 'ARM' | 'PERMISSION'
  | 'CONSUMPTION' | 'FINAL_GUARD' | 'ENTRY' | 'CLEANUP' | 'COMPLETION';
export type PracticalCancelLocalRefusal = 'INVALID_INPUT' | 'OPERATION_IN_PROGRESS'
  | 'ENABLEMENT_REFUSED' | 'ACCOUNT_BINDING_REFUSED' | 'RUNTIME_BINDING_REFUSED'
  | 'ORIGINAL_WATCH_REFUSED' | 'DISPATCH_WINDOW_CLOSED' | 'CLOCK_ANOMALY'
  | 'ENTRY_REFUSED' | 'OPERATIONAL_FAILURE' | 'MANUAL_REVIEW_REQUIRED' | 'ADMISSION_CLOSED' | 'BUDGET_REFUSED';
export type PracticalCancelCode = PracticalCancelLocalRefusal | PracticalMutationErrorCode | LiveExecutionFailureCode
  | PracticalPersistenceErrorCode | PracticalLiveSafetyErrorCode;
export type PracticalCancelReportedOutcome = 'ACCEPTED' | 'REJECTED' | 'AMBIGUOUS' | 'PRE_DISPATCH_FAILURE';
export type PracticalCancelResult =
  | { readonly kind: 'REFUSED' | 'BLOCKED'; readonly phase: PracticalCancelPhase; readonly code: PracticalCancelCode }
  | { readonly kind: 'ACQUISITION_STOPPED'; readonly reason: 'CERTIFICATE_TERMINATED' | 'AUTHORITY_INVALIDATED' }
  | { readonly kind: 'NOT_COMMITTED'; readonly certificateStatus: 'ISSUED' | 'EXPIRED' | 'REVOKED' | 'CONSUMED_BY_ANOTHER_LEASE' }
  | { readonly kind: 'COMPLETED'; readonly outcome: PracticalCancelReportedOutcome; readonly disposition: 'COMPLETED' | 'ALREADY_COMPLETED' }
  | { readonly kind: 'BOOKKEEPING_PENDING'; readonly phase: 'ACQUIRE' | 'CLEANUP' | 'COMPLETION'; readonly code: PracticalCancelCode; readonly continuation: PracticalCancelBookkeeping };

/** Internal mutable time high-water mark, owned by one operation, never caller input. */
export interface PracticalCancelTime { lastNowMs: number }

/** Local bookkeeping only; LOCAL_DRAINED never authorizes durable/provider shutdown. */
export type PracticalCancelDrainResult =
  | { readonly kind: 'LOCAL_DRAINED' }
  | { readonly kind: 'IN_FLIGHT'; readonly phase: PracticalCancelPhase }
  | { readonly kind: 'BOOKKEEPING_PENDING'; readonly phase: 'ACQUIRE' | 'CLEANUP' | 'COMPLETION' }
  | { readonly kind: 'BLOCKED'; readonly code: PracticalCancelCode }
  | { readonly kind: 'REFUSED'; readonly code: 'ADMISSION_NOT_CLOSED' | 'DRAIN_IN_PROGRESS' };
