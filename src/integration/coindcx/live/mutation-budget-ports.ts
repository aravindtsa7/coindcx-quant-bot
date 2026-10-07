/**
 * M2 W4 (U-M2-1): integration-layer implementations of the two execution-layer budget ports
 * (`PracticalCancelBudgetPort`, `LiveMutationBudgetPort`) over a limiter mutation budget.
 *
 * Budget only. An admission is a limiter mutation permit: opaque to execution, never authority, never provider data,
 * never a certificate. A budget can only delay or refuse. The mutation kind is fixed here (the practical cancel is
 * always CANCEL; `placeOrder` is CREATE and `cancelOrder` is CANCEL, from a closed union), and the transport re-derives
 * it from its closed endpoint and refuses a mismatch.
 *
 * Typed structurally so this module imports no execution module; the composition roots pass these objects to the
 * execution services, where the port types are checked.
 */
import {
  boundProductionMutationBudget, consumeMutationPermit, releaseMutationPermit, type MutationBudget, type MutationOperation,
} from '../rate-limit/runtime/mutation-budget';

export interface PracticalCancelBudgetPortImplementation {
  admit(request: { readonly lifetimeMs: number }): Promise<object | null>;
  consume(admission: object): object | null;
  release(admission: object): void;
}
export interface LiveMutationBudgetPortImplementation {
  admit(request: { readonly gatewayCall: 'placeOrder' | 'cancelOrder'; readonly lifetimeMs: number }): Promise<object | null>;
  release(permit: object): void;
}

async function admit(budget: MutationBudget, operation: MutationOperation, lifetimeMs: unknown): Promise<object | null> {
  if (typeof lifetimeMs !== 'number' || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1) return null;
  try {
    const acquired = await budget.acquire({ operation, lifetimeMs });
    return acquired.kind === 'GRANTED' ? acquired.permit : null;
  } catch { return null; }
}

/** The practical cancel's port: CANCEL permits, consumed synchronously at the gateway boundary. */
export function createPracticalCancelBudgetPort(budget: MutationBudget): PracticalCancelBudgetPortImplementation {
  return Object.freeze({
    admit: (request: { readonly lifetimeMs: number }) => admit(budget, 'CANCEL', request.lifetimeMs),
    consume: (admission: object): object | null => {
      const consumption = consumeMutationPermit(admission, 'CANCEL');
      return consumption.kind === 'CONSUMED' ? consumption.consumed : null;
    },
    release: (admission: object): void => { releaseMutationPermit(admission); },
  });
}

/** The Phase 17 service's port: the permit is consumed by the transport, synchronously before signing. */
export function createLiveMutationBudgetPort(budget: MutationBudget): LiveMutationBudgetPortImplementation {
  return Object.freeze({
    admit: (request: { readonly gatewayCall: 'placeOrder' | 'cancelOrder'; readonly lifetimeMs: number }): Promise<object | null> => {
      const operation: MutationOperation | null = request.gatewayCall === 'placeOrder' ? 'CREATE' : request.gatewayCall === 'cancelOrder' ? 'CANCEL' : null;
      return operation === null ? Promise.resolve(null) : admit(budget, operation, request.lifetimeMs);
    },
    release: (permit: object): void => { releaseMutationPermit(permit); },
  });
}

/** Production ports: delegate to the set-once production mutation budget, which nothing in `src/` binds (refused). */
export function productionPracticalCancelBudgetPort(): PracticalCancelBudgetPortImplementation { return createPracticalCancelBudgetPort(boundProductionMutationBudget()); }
export function productionLiveMutationBudgetPort(): LiveMutationBudgetPortImplementation { return createLiveMutationBudgetPort(boundProductionMutationBudget()); }

for (const fn of [createPracticalCancelBudgetPort, createLiveMutationBudgetPort, productionPracticalCancelBudgetPort, productionLiveMutationBudgetPort]) Object.freeze(fn);
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  const pinned = { createPracticalCancelBudgetPort, createLiveMutationBudgetPort, productionPracticalCancelBudgetPort, productionLiveMutationBudgetPort };
  for (const [name, value] of Object.entries(pinned)) {
    const descriptor = Object.getOwnPropertyDescriptor(module.exports, name);
    if (descriptor?.configurable === false) { if (module.exports[name] !== value) throw new Error('MUTATION_BUDGET_PORT_EXPORT_INVALID'); }
    else Object.defineProperty(module.exports, name, { get: () => value, configurable: false, enumerable: true });
  }
}
