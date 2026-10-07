/**
 * M2 W4 test-only mutation-budget fixtures. Production has no granting or unpaced budget: every mutation is refused
 * until the process binds a real budget. These fixtures grant at once and mint genuine limiter permits (same
 * single-use discipline as the coordinator-backed budget) with a recording backend; pacing itself is exercised in
 * tests/integration/coindcx/rate-limit.
 */
import { createLiveMutationBudgetPort, createPracticalCancelBudgetPort } from '../../src/integration/coindcx/live/mutation-budget-ports';
import * as mutationBudgetModule from '../../src/integration/coindcx/rate-limit/runtime/mutation-budget';
import type { MutationBudget, MutationOperation, MutationPermit } from '../../src/integration/coindcx/rate-limit/runtime/mutation-budget';

export interface MutationBudgetRecord {
  acquired: number; consumed: number; started: number; completed: number; released: number; throttled: number;
  readonly operations: MutationOperation[];
}
export function emptyMutationBudgetRecord(): MutationBudgetRecord {
  return { acquired: 0, consumed: 0, started: 0, completed: 0, released: 0, throttled: 0, operations: [] };
}
export type FixtureMutationBudget = MutationBudget & { readonly record: MutationBudgetRecord };

/** A genuine permit whose start check passes (or is voided with `consumeRefusal()`), recording its lifecycle. */
export function fixtureMutationPermitSync(operation: MutationOperation, record: MutationBudgetRecord = emptyMutationBudgetRecord(),
  consumeRefusal: () => string | null = () => null, module: typeof mutationBudgetModule = mutationBudgetModule): MutationPermit {
  return module.disciplinedMutationPermit(operation, {
    consume: () => {
      const reason = consumeRefusal();
      if (reason !== null) return Object.freeze({ kind: 'NOT_STARTED' as const, reason });
      record.consumed += 1; return Object.freeze({ kind: 'USED' as const });
    },
    started: () => { record.started += 1; },
    complete: () => { record.completed += 1; },
    release: () => { record.released += 1; },
    throttled: () => { record.throttled += 1; },
  });
}
/** Grants every request at once with a genuine fixture permit. */
export function grantingMutationBudget(record: MutationBudgetRecord = emptyMutationBudgetRecord(), consumeRefusal: () => string | null = () => null,
  module: typeof mutationBudgetModule = mutationBudgetModule): FixtureMutationBudget {
  return Object.freeze({
    record,
    async acquire(request: { readonly operation: MutationOperation; readonly lifetimeMs: number }) {
      record.acquired += 1; record.operations.push(request.operation);
      return Object.freeze({ kind: 'GRANTED' as const, permit: fixtureMutationPermitSync(request.operation, record, consumeRefusal, module) });
    },
  });
}
export function fixturePracticalCancelBudgetPort(record?: MutationBudgetRecord) { return createPracticalCancelBudgetPort(grantingMutationBudget(record)); }
export function fixtureLiveMutationBudgetPort(record?: MutationBudgetRecord) { return createLiveMutationBudgetPort(grantingMutationBudget(record)); }

const boundFixtures = new WeakMap<object, FixtureMutationBudget>();
/**
 * Binds a granting fixture as the production mutation budget of `module` (the current module-registry instance), once.
 * Returns the same fixture on later calls for the same instance; refuses if anything else is already bound.
 */
export function ensureFixtureProductionMutationBudget(module: typeof mutationBudgetModule = mutationBudgetModule): FixtureMutationBudget {
  const existing = boundFixtures.get(module);
  if (existing !== undefined) return existing;
  const fixture = grantingMutationBudget(emptyMutationBudgetRecord(), () => null, module);
  module.bindProductionMutationBudget(fixture); // throws PRODUCTION_MUTATION_BUDGET_ALREADY_BOUND for a non-fixture binding
  boundFixtures.set(module, fixture);
  return fixture;
}
