/**
 * M2 W3: read-budget interface for the REST read primitives, a coordinator-backed implementation, and the
 * set-once production binding used by the owned/privileged read paths.
 *
 * Budget only: a permit is never execution authority and can never supply or alter response data; a budget can
 * only delay or refuse a read. A missing, unbound, unavailable or refusing budget means an explicit refusal BEFORE
 * any HTTP request. There is no unpaced fallback.
 *
 * Permit discipline (enforced here for every primitive):
 *   - `start(create)` is the synchronous start check; on USE it calls `create` (which must create the HTTP request
 *     synchronously) and STARTED is reported at that moment, including when `create` throws;
 *   - a permit starts at most once;
 *   - `release()` voids a permit only while it is still unused (irrevocable known non-use);
 *   - `complete()` is accepted only after a start, once, and only as positive local completion/teardown evidence;
 *     a throwing or uncertain request factory never produces NOT_STARTED or completion evidence;
 *   - `throttled()` routes a 429 observation (raw Retry-After / Date headers) to the shared coordinator.
 *
 * Set-once binding (process composition): `bindProductionReadBudget` may succeed once per process; any further call
 * throws. Until bound, every owned/privileged read refuses. Limit: the binding is a process-global seam; whoever binds
 * first wins (trusted-process model, same as the IPC prototype).
 */
import type { BudgetScope, PriorityClass } from '../config';
import type { AckResult, RateLimitClient } from './client';

export type ReadStart<T> = Readonly<{ kind: 'STARTED'; value: T }> | Readonly<{ kind: 'NOT_STARTED'; reason: string }>;
export interface ReadPermit {
  start<T>(create: () => T): ReadStart<T>;
  complete(): void;
  release(): void;
  throttled(headers: Readonly<{ retryAfter?: string; serverDate?: string }>): void;
}
export type ReadBudgetAcquisition = Readonly<{ kind: 'GRANTED'; permit: ReadPermit }> | Readonly<{ kind: 'REFUSED'; reason: string }>;
export interface ReadBudgetRequest { readonly scope: BudgetScope; readonly lifetimeMs: number }
export interface ReadBudget { acquire(request: ReadBudgetRequest): Promise<ReadBudgetAcquisition> }
/** A non-owned transport's budget binding: the budget and the scope of that transport's host. */
export interface TransportReadBudget { readonly budget: ReadBudget; readonly scope: BudgetScope }

/** Wraps any permit-like backend with the single-use discipline above. */
export function disciplinedPermit(backend: Readonly<{
  start<T>(create: () => T): ReadStart<T>; complete(): void; release(): void; throttled(headers: Readonly<{ retryAfter?: string; serverDate?: string }>): void;
}>): ReadPermit {
  let state: 'UNUSED' | 'STARTED' | 'NOT_STARTED' | 'RELEASED' | 'COMPLETED' = 'UNUSED';
  return Object.freeze({
    start<T>(create: () => T): ReadStart<T> {
      if (state !== 'UNUSED') return Object.freeze({ kind: 'NOT_STARTED', reason: `PERMIT_${state}` });
      let reachedCreate = false;
      try {
        const result = backend.start(() => { reachedCreate = true; return create(); });
        state = result.kind === 'STARTED' ? 'STARTED' : 'NOT_STARTED';
        return result;
      } catch (error) {
        // `create` threw after the start check passed: the start cannot be excluded (STARTED was reported).
        if (reachedCreate) state = 'STARTED';
        throw error;
      }
    },
    complete(): void { if (state === 'STARTED') { state = 'COMPLETED'; backend.complete(); } },
    release(): void { if (state === 'UNUSED') { state = 'RELEASED'; backend.release(); } },
    throttled(headers: Readonly<{ retryAfter?: string; serverDate?: string }>): void { if (state === 'STARTED' || state === 'COMPLETED') backend.throttled(headers); },
  });
}

/**
 * The IPC schema bounds header values at 128 characters. A longer value is replaced by a marker that the coordinator
 * cannot parse, so it fails closed (present but unparseable) instead of being dropped or shortened.
 */
function clipHeaders(headers: Readonly<{ retryAfter?: string; serverDate?: string }>): { retryAfter?: string; serverDate?: string } {
  const clip = (value: string): string => (value.length <= 128 ? value : 'OVERSIZED_HEADER_VALUE');
  return { ...(headers.retryAfter === undefined ? {} : { retryAfter: clip(headers.retryAfter) }), ...(headers.serverDate === undefined ? {} : { serverDate: clip(headers.serverDate) }) };
}

export interface CoordinatorReadBudgetPolicy { readonly cls: PriorityClass; readonly deadlineInMs: number }
/** A read budget backed by the shared coordinator through a connected W2 client. */
export function createCoordinatorReadBudget(client: RateLimitClient, policy: CoordinatorReadBudgetPolicy): ReadBudget {
  if (!Number.isSafeInteger(policy.deadlineInMs) || policy.deadlineInMs <= 0) throw new TypeError('createCoordinatorReadBudget: invalid deadline');
  const ignore = (ack: Promise<AckResult>): void => { void ack.catch(() => undefined); };
  return Object.freeze({
    async acquire(request: ReadBudgetRequest): Promise<ReadBudgetAcquisition> {
      let result;
      try {
        result = await client.acquire({ cls: policy.cls, operation: 'READ', scope: request.scope, deadlineInMs: policy.deadlineInMs, lifetimeMs: request.lifetimeMs });
      } catch {
        return Object.freeze({ kind: 'REFUSED', reason: 'BUDGET_ERROR' });
      }
      if (result.kind === 'REFUSED') return Object.freeze({ kind: 'REFUSED', reason: result.code });
      if (result.kind === 'UNAVAILABLE') return Object.freeze({ kind: 'REFUSED', reason: `UNAVAILABLE_${result.reason}` });
      const permit = result.permit;
      return Object.freeze({ kind: 'GRANTED', permit: disciplinedPermit({
        start: (create) => permit.start(create),
        complete: () => ignore(permit.complete()),
        release: () => { permit.release(); },
        throttled: (headers) => ignore(permit.reportThrottled(clipHeaders(headers))),
      }) });
    },
  });
}

/** Refusal raised by every read primitive when no budget is available or the budget refuses (before any HTTP). */
export function readBudgetRefusal(reason: string): Readonly<{ message: string; details: Readonly<{ readBudget: 'REFUSED'; reason: string }> }> {
  return Object.freeze({ message: `CoinDCX read budget refused before any request: ${reason}`, details: Object.freeze({ readBudget: 'REFUSED', reason }) });
}

/** Host-derived scope for owned/privileged production reads. */
export function productionReadScope(url: URL): BudgetScope {
  return url.hostname === 'public.coindcx.com' ? 'PUBLIC' : 'API_AUTH';
}

let productionBudget: ReadBudget | null = null;
/** Binds the process's production read budget. Succeeds once; every later call throws. */
export function bindProductionReadBudget(budget: ReadBudget): void {
  if (productionBudget !== null) throw new Error('PRODUCTION_READ_BUDGET_ALREADY_BOUND');
  if (typeof budget !== 'object' || budget === null || typeof budget.acquire !== 'function') throw new TypeError('PRODUCTION_READ_BUDGET_INVALID');
  const acquire = budget.acquire.bind(budget);
  productionBudget = Object.freeze({ acquire: (request: ReadBudgetRequest) => acquire(request) });
}
/** The bound production read budget, or null (every owned/privileged read then refuses). */
export function productionReadBudget(): ReadBudget | null { return productionBudget; }

/**
 * A transport budget that delegates to the set-once production binding at each request (REFUSED while unbound).
 * For transports a module constructs for itself as defaults; it is pacing only and confers no provenance.
 */
export function boundProductionTransportBudget(scope: BudgetScope): TransportReadBudget {
  return Object.freeze({ scope, budget: Object.freeze({
    acquire: async (request: ReadBudgetRequest): Promise<ReadBudgetAcquisition> => {
      const budget = productionBudget;
      if (budget === null) return Object.freeze({ kind: 'REFUSED', reason: 'PRODUCTION_READ_BUDGET_UNBOUND' });
      return budget.acquire(request);
    },
  }) });
}

/** One fresh permit from the bound production budget for a privileged read of `url`; REFUSED when unbound, refusing or failing. */
export async function acquireProductionPermit(url: URL, lifetimeMs: number): Promise<ReadBudgetAcquisition> {
  const budget = productionBudget;
  if (budget === null) return Object.freeze({ kind: 'REFUSED', reason: 'PRODUCTION_READ_BUDGET_UNBOUND' });
  try {
    const acquired = await budget.acquire({ scope: productionReadScope(url), lifetimeMs });
    return acquired.kind === 'GRANTED' ? acquired : Object.freeze({ kind: 'REFUSED', reason: acquired.reason });
  } catch {
    return Object.freeze({ kind: 'REFUSED', reason: 'READ_BUDGET_ERROR' });
  }
}

for (const fn of [disciplinedPermit, createCoordinatorReadBudget, readBudgetRefusal, productionReadScope, bindProductionReadBudget, productionReadBudget, acquireProductionPermit, boundProductionTransportBudget]) Object.freeze(fn);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  const pinned = { disciplinedPermit, createCoordinatorReadBudget, readBudgetRefusal, productionReadScope, bindProductionReadBudget, productionReadBudget, acquireProductionPermit, boundProductionTransportBudget };
  for (const [name, value] of Object.entries(pinned)) {
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) { if (module.exports[name] !== value) throw new Error('READ_BUDGET_EXPORT_INVALID'); }
    else Object.defineProperty(module.exports, name, { get: () => value, configurable: false, enumerable: true });
  }
}
