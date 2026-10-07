/**
 * M2 W4: mutation budget for the order-mutation transport (Phase 17 create/cancel and the practical cancel), a
 * coordinator-backed implementation, and the set-once production binding.
 *
 * Budget only: a permit is never execution authority, carries no provider data, and can only delay or refuse a
 * mutation. It imports no execution module; callers treat a permit as opaque.
 *
 * Two-step discipline (design V3 §4.3):
 *   - `consumeMutationPermit(permit, operation)` is the synchronous start check at the last dispatch boundary. It
 *     accepts only a permit minted by this module (structural fakes and read permits are refused), for exactly
 *     `operation`, at most once. The limiter's own check (session, epoch, local TTL, STOP, scope block) marks the grant
 *     USED. It reports nothing: consumption is not a start.
 *   - the consumed permit's `start(create)` runs `create`, the actual request creation, and reports STARTED at that
 *     moment, including when `create` throws.
 *   - a consumed permit whose request is never created (preparation failure, entry refusal) reports nothing: its
 *     capacity stays uncertain at the coordinator until the reconnect inventory lists it as used. A consumed permit is
 *     never released.
 *   - `releaseMutationPermit` voids only a permit that was never consumed (irrevocable known non-use).
 *   - `complete()` is accepted only after a start, once; `throttled()` routes a 429's raw headers to the coordinator.
 *
 * Set-once binding: `bindProductionMutationBudget` may succeed once per process; until then every production
 * admission refuses. Nothing in `src/` binds it (production wiring stays disabled).
 */
import type { PriorityClass } from '../config';
import type { AckResult, RateLimitClient } from './client';

export type MutationOperation = 'CREATE' | 'CANCEL';
export type MutationThrottleHeaders = Readonly<{ retryAfter?: string; serverDate?: string }>;
export interface MutationPermitBackend {
  /** The synchronous start check; USE marks the grant used without reporting a start. */
  consume(): Readonly<{ kind: 'USED' }> | Readonly<{ kind: 'NOT_STARTED'; reason: string }>;
  started(): void;
  complete(): void;
  release(): void;
  throttled(headers: MutationThrottleHeaders): void;
}
/** A consumed permit: the only way to create the request it pays for. */
export interface ConsumedMutationPermit {
  readonly operation: MutationOperation;
  start<T>(create: () => T): Readonly<{ kind: 'STARTED'; value: T }>;
  complete(): void;
  throttled(headers: MutationThrottleHeaders): void;
}
export type MutationConsumption = Readonly<{ kind: 'CONSUMED'; consumed: ConsumedMutationPermit }> | Readonly<{ kind: 'REFUSED'; reason: string }>;
export interface MutationBudgetRequest { readonly operation: MutationOperation; readonly lifetimeMs: number }
export type MutationBudgetAcquisition = Readonly<{ kind: 'GRANTED'; permit: MutationPermit }> | Readonly<{ kind: 'REFUSED'; reason: string }>;
export interface MutationBudget { acquire(request: MutationBudgetRequest): Promise<MutationBudgetAcquisition> }

const ISSUER = Object.freeze({ purpose: 'm2-mutation-permit' });
const consumedPermits = new WeakSet<object>();

/** An opaque, single-use mutation permit. Only this module can mint, consume or release one. */
export class MutationPermit {
  readonly #operation: MutationOperation;
  readonly #backend: MutationPermitBackend;
  #state: 'UNUSED' | 'CONSUMED' | 'STARTED' | 'COMPLETED' | 'VOIDED' | 'UNCERTAIN' = 'UNUSED';
  public constructor(issuer: unknown, operation: MutationOperation, backend: MutationPermitBackend) {
    if (issuer !== ISSUER) throw new Error('MUTATION_PERMIT_ISSUER_REFUSED');
    this.#operation = operation; this.#backend = backend; Object.freeze(this);
  }
  public static consume(value: unknown, operation: MutationOperation): MutationConsumption {
    const refuse = (reason: string): MutationConsumption => Object.freeze({ kind: 'REFUSED', reason });
    if (typeof value !== 'object' || value === null || !(#state in value)) return refuse('PERMIT_FORGED');
    if (value.#operation !== operation) return refuse('PERMIT_WRONG_OPERATION');
    if (value.#state !== 'UNUSED') return refuse(`PERMIT_${value.#state}`);
    let check: ReturnType<MutationPermitBackend['consume']>;
    try { check = value.#backend.consume(); } catch { value.#state = 'UNCERTAIN'; return refuse('PERMIT_CHECK_FAILED'); } // never released
    if (check.kind !== 'USED') { value.#state = 'VOIDED'; return refuse(`PERMIT_${check.reason}`); } // NOT_STARTED already reported
    value.#state = 'CONSUMED';
    const permit = value, backend = value.#backend;
    const consumed: ConsumedMutationPermit = Object.freeze({
      operation: value.#operation,
      start<T>(create: () => T): Readonly<{ kind: 'STARTED'; value: T }> {
        if (permit.#state !== 'CONSUMED') throw new Error('MUTATION_PERMIT_NOT_CONSUMED');
        permit.#state = 'STARTED';
        try {
          return Object.freeze({ kind: 'STARTED', value: create() });
        } finally {
          try { backend.started(); } catch { /* budget accounting only */ } // also when `create` throws: a start cannot be excluded
        }
      },
      complete(): void { if (permit.#state === 'STARTED') { permit.#state = 'COMPLETED'; backend.complete(); } },
      throttled(headers: MutationThrottleHeaders): void { if (permit.#state === 'STARTED' || permit.#state === 'COMPLETED') backend.throttled(headers); },
    });
    consumedPermits.add(consumed);
    return Object.freeze({ kind: 'CONSUMED', consumed });
  }
  public static release(value: unknown): void {
    if (typeof value !== 'object' || value === null || !(#state in value) || value.#state !== 'UNUSED') return;
    value.#state = 'VOIDED';
    try { value.#backend.release(); } catch { /* budget accounting only */ }
  }
  public static operation(value: unknown): MutationOperation | null {
    return typeof value === 'object' && value !== null && #state in value ? value.#operation : null;
  }
  public toJSON(): never { throw new Error('MUTATION_PERMIT_NOT_SERIALIZABLE'); }
}
Object.freeze(MutationPermit.prototype);
Object.freeze(MutationPermit);

/** Wraps a permit backend (a coordinator grant, or a test fixture) with the single-use discipline above. */
export function disciplinedMutationPermit(operation: MutationOperation, backend: MutationPermitBackend): MutationPermit {
  if (operation !== 'CREATE' && operation !== 'CANCEL') throw new TypeError('MUTATION_PERMIT_OPERATION_INVALID');
  return new MutationPermit(ISSUER, operation, backend);
}
/** The synchronous start check for exactly `operation`. Never reports STARTED. */
export function consumeMutationPermit(permit: unknown, operation: MutationOperation): MutationConsumption {
  return MutationPermit.consume(permit, operation);
}
/** A consumed permit minted here for exactly `operation`, or null (forged, read, wrong operation). */
export function readConsumedMutationPermit(value: unknown, operation: MutationOperation): ConsumedMutationPermit | null {
  if (typeof value !== 'object' || value === null || !consumedPermits.has(value)) return null;
  return (value as ConsumedMutationPermit).operation === operation ? value as ConsumedMutationPermit : null;
}
/** Voids a permit that was never consumed; a no-op for anything else. */
export function releaseMutationPermit(permit: unknown): void { MutationPermit.release(permit); }

/** The IPC schema bounds header values at 128 characters; a longer value becomes unparseable (fails closed), as for reads. */
function clipHeaders(headers: MutationThrottleHeaders): { retryAfter?: string; serverDate?: string } {
  const clip = (value: string): string => (value.length <= 128 ? value : 'OVERSIZED_HEADER_VALUE');
  return { ...(headers.retryAfter === undefined ? {} : { retryAfter: clip(headers.retryAfter) }), ...(headers.serverDate === undefined ? {} : { serverDate: clip(headers.serverDate) }) };
}

export interface CoordinatorMutationBudgetPolicy { readonly cls: PriorityClass; readonly deadlineInMs: number }
/** A mutation budget backed by the shared coordinator through a connected W2 client (scope API_AUTH). */
export function createCoordinatorMutationBudget(client: RateLimitClient, policy: CoordinatorMutationBudgetPolicy): MutationBudget {
  if (!Number.isSafeInteger(policy.deadlineInMs) || policy.deadlineInMs <= 0) throw new TypeError('createCoordinatorMutationBudget: invalid deadline');
  const ignore = (ack: Promise<AckResult>): void => { void ack.catch(() => undefined); };
  return Object.freeze({
    async acquire(request: MutationBudgetRequest): Promise<MutationBudgetAcquisition> {
      const operation = request.operation;
      if ((operation !== 'CREATE' && operation !== 'CANCEL') || !Number.isSafeInteger(request.lifetimeMs) || request.lifetimeMs <= 0) {
        return Object.freeze({ kind: 'REFUSED', reason: 'INVALID_REQUEST' });
      }
      let result;
      try {
        result = await client.acquire({ cls: policy.cls, operation, scope: 'API_AUTH', deadlineInMs: policy.deadlineInMs, lifetimeMs: request.lifetimeMs });
      } catch {
        return Object.freeze({ kind: 'REFUSED', reason: 'BUDGET_ERROR' });
      }
      if (result.kind === 'REFUSED') return Object.freeze({ kind: 'REFUSED', reason: result.code });
      if (result.kind === 'UNAVAILABLE') return Object.freeze({ kind: 'REFUSED', reason: `UNAVAILABLE_${result.reason}` });
      const permit = result.permit;
      // Binding: the grant must be for exactly this operation on the authenticated scope.
      if (permit.grant.operation !== operation || permit.grant.scope !== 'API_AUTH') { permit.release(); return Object.freeze({ kind: 'REFUSED', reason: 'GRANT_BINDING_MISMATCH' }); }
      return Object.freeze({ kind: 'GRANTED', permit: disciplinedMutationPermit(operation, {
        consume: () => permit.consume(),
        started: () => ignore(permit.reportStarted()),
        complete: () => ignore(permit.complete()),
        release: () => { permit.release(); },
        throttled: (headers) => ignore(permit.reportThrottled(clipHeaders(headers))),
      }) });
    },
  });
}

let productionBudget: MutationBudget | null = null;
/** Binds the process's production mutation budget. Succeeds once; every later call throws. */
export function bindProductionMutationBudget(budget: MutationBudget): void {
  if (productionBudget !== null) throw new Error('PRODUCTION_MUTATION_BUDGET_ALREADY_BOUND');
  if (typeof budget !== 'object' || budget === null || typeof budget.acquire !== 'function') throw new TypeError('PRODUCTION_MUTATION_BUDGET_INVALID');
  const acquire = budget.acquire.bind(budget);
  productionBudget = Object.freeze({ acquire: (request: MutationBudgetRequest) => acquire(request) });
}
/** A budget that delegates to the set-once production binding at each admission (REFUSED while unbound or failing). */
export function boundProductionMutationBudget(): MutationBudget {
  return Object.freeze({
    acquire: async (request: MutationBudgetRequest): Promise<MutationBudgetAcquisition> => {
      const budget = productionBudget;
      if (budget === null) return Object.freeze({ kind: 'REFUSED', reason: 'PRODUCTION_MUTATION_BUDGET_UNBOUND' });
      try {
        const acquired = await budget.acquire(request);
        return acquired.kind === 'GRANTED' ? acquired : Object.freeze({ kind: 'REFUSED', reason: acquired.reason });
      } catch {
        return Object.freeze({ kind: 'REFUSED', reason: 'MUTATION_BUDGET_ERROR' });
      }
    },
  });
}

for (const fn of [disciplinedMutationPermit, consumeMutationPermit, readConsumedMutationPermit, releaseMutationPermit, createCoordinatorMutationBudget, bindProductionMutationBudget, boundProductionMutationBudget]) Object.freeze(fn);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  const pinned = { MutationPermit, disciplinedMutationPermit, consumeMutationPermit, readConsumedMutationPermit, releaseMutationPermit, createCoordinatorMutationBudget, bindProductionMutationBudget, boundProductionMutationBudget };
  for (const [name, value] of Object.entries(pinned)) {
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) { if (module.exports[name] !== value) throw new Error('MUTATION_BUDGET_EXPORT_INVALID'); }
    else Object.defineProperty(module.exports, name, { get: () => value, configurable: false, enumerable: true });
  }
}
