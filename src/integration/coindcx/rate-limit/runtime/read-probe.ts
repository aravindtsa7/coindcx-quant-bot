/**
 * M2 W3: probe responder. When the coordinator announces a probe for a scope (PROBE_DUE), the responder acquires that
 * generation's PROBE permit and runs an injected, read-only probe executor inside the permit's synchronous start.
 *
 * The executor is injected; production probe endpoints are U-M2-4 and are NOT defined here (W3 tests use loopback
 * fixtures). Contract for `probe(scope)`: create the HTTP request synchronously during the call, and resolve only
 * after the request is locally closed (positive teardown evidence).
 *   - SUCCESS   -> PROBE_RESULT SUCCESS (clears that scope only; the operator STOP is never touched)
 *   - THROTTLED -> a shared throttle observation (the coordinator re-blocks with full waits; a new generation follows)
 *   - FAILED    -> PROBE_RESULT FAILED (local backoff)
 * A throwing executor reports STARTED (a start cannot be excluded) and no completion. A rejected promise reports FAILED
 * and no completion. A stale generation is refused by the coordinator, so its probe never starts.
 */
import type { BudgetScope } from '../config';
import type { RateLimitClient } from './client';

export type ReadProbeOutcome = Readonly<{ kind: 'SUCCESS' }> | Readonly<{ kind: 'FAILED' }> | Readonly<{ kind: 'THROTTLED'; retryAfter?: string; serverDate?: string }>;
export interface ReadProbeExecutor { probe(scope: BudgetScope): Promise<ReadProbeOutcome> }
export interface ReadProbePolicy { readonly deadlineInMs: number; readonly lifetimeMs: number }
export type ProbeRecord = Readonly<{ scope: BudgetScope; probeGen: number; result: 'SUCCESS' | 'FAILED' | 'THROTTLED' | 'REFUSED' | 'NOT_STARTED' | 'THREW' }>;

/** Subscribes `client` (connected with the probe scopes it serves) to probe announcements. Returns the probe log. */
export function attachReadProbeResponder(client: RateLimitClient, executor: ReadProbeExecutor, policy: ReadProbePolicy): readonly ProbeRecord[] {
  const log: ProbeRecord[] = [];
  client.onProbeDue((scope, probeGen) => {
    void (async () => {
      const acquired = await client.acquire({ cls: 'P0', operation: 'PROBE', scope, probeGen, deadlineInMs: policy.deadlineInMs, lifetimeMs: policy.lifetimeMs });
      if (acquired.kind !== 'GRANTED') { log.push(Object.freeze({ scope, probeGen, result: 'REFUSED' })); return; }
      const permit = acquired.permit;
      let outcome: Promise<ReadProbeOutcome>;
      try {
        const started = permit.start(() => executor.probe(scope));
        if (started.kind !== 'STARTED') { log.push(Object.freeze({ scope, probeGen, result: 'NOT_STARTED' })); return; }
        outcome = started.value;
      } catch {
        log.push(Object.freeze({ scope, probeGen, result: 'THREW' })); // STARTED reported; no completion evidence
        return;
      }
      let result: ReadProbeOutcome;
      try { result = await outcome; } catch {
        await permit.reportProbe('FAILED');
        log.push(Object.freeze({ scope, probeGen, result: 'FAILED' }));
        return;
      }
      if (result.kind === 'THROTTLED') {
        await permit.reportThrottled({ ...(result.retryAfter === undefined ? {} : { retryAfter: result.retryAfter }), ...(result.serverDate === undefined ? {} : { serverDate: result.serverDate }) });
      } else {
        await permit.reportProbe(result.kind);
      }
      await permit.complete();
      log.push(Object.freeze({ scope, probeGen, result: result.kind }));
    })();
  });
  return log;
}
