/**
 * Test-only read-budget fixtures (M2 W3). Production has no granting or unpaced budget: every owned/privileged read
 * refuses until the process binds a real budget. These fixtures grant at once, record the permit lifecycle, and apply
 * the same single-use discipline as the coordinator-backed budget.
 */
import * as readBudgetModule from '../../src/integration/coindcx/rate-limit/runtime/read-budget';
import type { ReadBudget, TransportReadBudget } from '../../src/integration/coindcx/rate-limit/runtime/read-budget';

export interface FixtureBudgetLog {
  acquired: number; started: number; completed: number; released: number;
  readonly throttled: Array<Readonly<{ retryAfter?: string; serverDate?: string }>>;
}
export type FixtureReadBudget = ReadBudget & { readonly log: FixtureBudgetLog };

export function grantingReadBudget(module: typeof readBudgetModule = readBudgetModule): FixtureReadBudget {
  const log: FixtureBudgetLog = { acquired: 0, started: 0, completed: 0, released: 0, throttled: [] };
  return {
    log,
    async acquire() {
      log.acquired += 1;
      return { kind: 'GRANTED', permit: module.disciplinedPermit({
        start: (create) => { const value = create(); log.started += 1; return { kind: 'STARTED', value }; },
        complete: () => { log.completed += 1; },
        release: () => { log.released += 1; },
        throttled: (headers) => { log.throttled.push(headers); },
      }) };
    },
  };
}

export function fixtureTransportBudget(scope: 'API_AUTH' | 'PUBLIC' = 'API_AUTH'): TransportReadBudget & { readonly budget: FixtureReadBudget } {
  return { budget: grantingReadBudget(), scope };
}

const boundFixtures = new WeakMap<object, FixtureReadBudget>();
/**
 * Binds a granting fixture as the production read budget of `module` (the current module-registry instance), once.
 * Returns the same fixture on later calls for the same instance.
 */
export function ensureFixtureProductionReadBudget(module: typeof readBudgetModule = readBudgetModule): FixtureReadBudget {
  const existing = boundFixtures.get(module);
  if (existing !== undefined) return existing;
  if (module.productionReadBudget() !== null) throw new Error('a non-fixture production read budget is already bound');
  const fixture = grantingReadBudget(module);
  module.bindProductionReadBudget(fixture);
  boundFixtures.set(module, fixture);
  return fixture;
}

/** For tests that call `vi.resetModules()`: bind in the fresh module registry (the one the next dynamic import uses). */
export async function ensureFreshFixtureProductionReadBudget(): Promise<FixtureReadBudget> {
  const fresh = await import('../../src/integration/coindcx/rate-limit/runtime/read-budget');
  return ensureFixtureProductionReadBudget(fresh);
}
