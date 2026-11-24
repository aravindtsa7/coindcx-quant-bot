import type { ReadBudget, ReadBudgetAcquisition } from '../src/integration/coindcx/rate-limit/runtime/read-budget';

/** Observes the existing permit lifecycle; never grants, retries or changes admission. */
export function observeReadBudget(delegate: ReadBudget, nowMs: () => number) {
  const counter = () => ({ acquisitions: 0, granted: 0, refused: 0, started: 0, completed: 0, throttled: 0, pending: 0, inFlight: 0 });
  const total = counter(), scopes = { PUBLIC: counter(), API_AUTH: counter() };
  const traffic: { timestampMs: number; starts: number; completed: number; pending: number; inFlight: number }[] = [];
  const latencies: { timestampMs: number; scope: string; durationMs: number }[] = [];
  const sample = () => { traffic.push({ timestampMs: nowMs(), starts: total.started, completed: total.completed, pending: total.pending, inFlight: total.inFlight }); if (traffic.length > 120) traffic.shift(); };
  const budget: ReadBudget = { async acquire(request): Promise<ReadBudgetAcquisition> {
    const scope = scopes[request.scope];
    total.acquisitions++; scope.acquisitions++; total.pending++; scope.pending++;
    try {
      const result = await delegate.acquire(request);
      if (result.kind === 'REFUSED') { total.refused++; scope.refused++; return result; }
      total.granted++; scope.granted++;
      let startedAt: number | null = null, completed = false;
      return { kind: 'GRANTED', permit: {
        start: create => result.permit.start(() => { startedAt = nowMs(); total.started++; scope.started++; total.inFlight++; scope.inFlight++; sample(); return create(); }),
        release: () => result.permit.release(),
        complete: () => {
          result.permit.complete();
          if (startedAt !== null && !completed) {
            completed = true; total.completed++; scope.completed++; total.inFlight--; scope.inFlight--;
            latencies.push({ timestampMs: nowMs(), scope: request.scope, durationMs: Math.max(0, nowMs() - startedAt) }); if (latencies.length > 120) latencies.shift(); sample();
          }
        },
        throttled: headers => { total.throttled++; scope.throttled++; result.permit.throttled(headers); },
      } };
    } finally { total.pending--; scope.pending--; }
  } };
  return { budget, stats: () => ({ ...total, scopes: structuredClone(scopes), traffic: structuredClone(traffic), latencies: structuredClone(latencies),
    telemetryScope: 'THIS_DASHBOARD_PROCESS', externalIpConsumers: 'UNKNOWN' }) };
}
