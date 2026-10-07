/**
 * M2 W6 / M10A: the admission-stop interlock (kill switch) and the `KillSwitchCancellationHook` INTERFACE.
 *
 * Engaging the interlock, synchronously and before anything is awaited:
 *   1. calls every injected local admission stop (for example the existing practical account coordinator's or practical
 *      cancel service's `requestStop()`, which permanently close their own mutation admission);
 *   2. latches the limiter client's local mutation refusal (`RateLimitClient.requestStop`), which also queues STOP for
 *      the coordinator.
 * The report then waits for the coordinator. `DURABLE` means the coordinator acknowledged STOP after its durable
 * commit. No connection, a disconnect, a failed persistence, UNKNOWN or a timeout is `NOT_ACKNOWLEDGED`, never success.
 *
 * Budget and admission only.
 * - It performs no cancel, OPEN or CLOSE and mints no hook token. STOP stays separate from throttling: a probe never
 *   reopens mutation admission, and reads keep their eligibility.
 * - It never rewrites or resends a request already started, and it cannot revoke one past its synchronous start check
 *   (the client's suspension limit).
 * - Cancellation under STOP needs a registered `KillSwitchCancellationHook`. Registration is M6 and does not exist here,
 *   so the cancellation outcome is always `CANCELLATION_HOOK_ABSENT`. No caller field changes that.
 *
 * It imports no execution module; local stops are injected structurally.
 */
import type { CoordinatorStopStatus, StopAcknowledgement } from './client';

export const CANCELLATION_HOOK_ABSENT = 'CANCELLATION_HOOK_ABSENT' as const;

/**
 * M10A interface for the cancellation hook that M6 will implement and register. It would cancel outstanding orders
 * through the practical cancel path under every existing gate; its budget eligibility would come from an opaque token
 * minted only by the registered hook. Nothing in M2 implements, registers or calls it.
 */
export interface KillSwitchCancellationHook {
  cancelOutstanding(request: Readonly<{ reason: 'KILL_SWITCH' }>): Promise<unknown>;
}

/** An existing local admission stop, called synchronously. */
export interface LocalAdmissionStop { requestStop(): unknown }
/** The limiter client's M10A surface (the W2/W6 `RateLimitClient`). */
export interface StoppableLimiter {
  requestStop(ackTimeoutMs: number): Readonly<{ latched: true; acknowledgement: Promise<StopAcknowledgement> }>;
  readonly stopStatus: Readonly<{ localLatch: boolean; coordinator: CoordinatorStopStatus }>;
}

export type LocalStopOutcome = 'ADMISSION_CLOSED' | 'STOP_FAILED';
export interface KillSwitchEngagement {
  /** Settled before any await: each local stop's outcome and whether the limiter's local latch is set. */
  readonly local: Readonly<{ admissionStops: readonly LocalStopOutcome[]; limiterLatch: 'LATCHED' | 'NO_LIMITER' }>;
  readonly cancellation: typeof CANCELLATION_HOOK_ABSENT;
  readonly report: Promise<KillSwitchReport>;
}
export type KillSwitchReport = Readonly<{
  local: KillSwitchEngagement['local'];
  coordinatorStop: StopAcknowledgement | Readonly<{ kind: 'NOT_ACKNOWLEDGED'; reason: 'NO_LIMITER' }>;
  cancellation: typeof CANCELLATION_HOOK_ABSENT;
}>;

export interface KillSwitchInput {
  readonly localStops: readonly LocalAdmissionStop[];
  readonly limiter: StoppableLimiter | null;
  readonly ackTimeoutMs: number;
}

/** Engages the admission-stop interlock. Only `localStops`, `limiter` and `ackTimeoutMs` are read. */
export function engageAdmissionStop(input: KillSwitchInput): KillSwitchEngagement {
  const ackTimeoutMs = input.ackTimeoutMs;
  if (!Number.isSafeInteger(ackTimeoutMs) || ackTimeoutMs <= 0) throw new TypeError('engageAdmissionStop: invalid acknowledgement timeout');
  const admissionStops = Object.freeze(input.localStops.map((stop): LocalStopOutcome => {
    try { stop.requestStop(); return 'ADMISSION_CLOSED'; } catch { return 'STOP_FAILED'; }
  }));
  const limiter = input.limiter;
  const stop = limiter === null ? null : limiter.requestStop(ackTimeoutMs);
  const local = Object.freeze({ admissionStops, limiterLatch: stop === null ? 'NO_LIMITER' as const : 'LATCHED' as const });
  const report = (async (): Promise<KillSwitchReport> => {
    const coordinatorStop = stop === null ? Object.freeze({ kind: 'NOT_ACKNOWLEDGED' as const, reason: 'NO_LIMITER' as const }) : await stop.acknowledgement;
    return Object.freeze({ local, coordinatorStop, cancellation: CANCELLATION_HOOK_ABSENT });
  })();
  return Object.freeze({ local, cancellation: CANCELLATION_HOOK_ABSENT, report });
}

/** The kill switch's cancellation capability in M2: always absent (M6 registers the hook). */
export function killSwitchCancellationStatus(): typeof CANCELLATION_HOOK_ABSENT { return CANCELLATION_HOOK_ABSENT; }

for (const fn of [engageAdmissionStop, killSwitchCancellationStatus]) Object.freeze(fn);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  const pinned = { CANCELLATION_HOOK_ABSENT, engageAdmissionStop, killSwitchCancellationStatus };
  for (const [name, value] of Object.entries(pinned)) {
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) { if (module.exports[name] !== value) throw new Error('ADMISSION_STOP_EXPORT_INVALID'); }
    else Object.defineProperty(module.exports, name, { get: () => value, configurable: false, enumerable: true });
  }
}
