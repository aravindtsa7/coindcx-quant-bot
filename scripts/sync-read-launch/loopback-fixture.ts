/** Explicit OFFLINE fixture composition. It cannot establish real provenance, supervision, state or pacing. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CoinDcxClient } from '../../src/integration/coindcx/client';
import { providerAccountFingerprint, verifyProviderAccountIdentity } from '../../src/execution/live/reconciliation/account-identity';
import type { AsyncClock } from '../../src/execution/live/practical-synchronization/async-orchestrator';
import { fixtureTransportBudget } from '../../tests/helpers/read-budget-fixture';
import { runPreparedCollection, type LaunchProposal } from './proposal';
import { localReportSink } from './report-sink';

class FixtureClock implements AsyncClock {
  private nowMs = 1000;
  constructor(private readonly interval: number) {}
  now(): number { return this.nowMs; }
  delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('fixture cancellation')); return; }
      if (ms === this.interval) { this.nowMs += ms; queueMicrotask(resolve); return; }
      signal.addEventListener('abort', () => reject(new Error('fixture timer cancelled')), { once: true });
    });
  }
}

export async function runLoopbackFixture(proposal: LaunchProposal, reportPath: string, signal: AbortSignal, mismatch = false) {
  const identity = 'OFFLINE-FIXTURE-IDENTIFIER-NOT-A-PROVIDER-ACCOUNT';
  const accountId = 'OFFLINE-FIXTURE-ACCOUNT';
  const connectionId = 'OFFLINE-FIXTURE-BUDGET-NOT-A-COORDINATOR';
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const clock = new FixtureClock(proposal.configuration.campaign.evaluationIntervalMs);
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      const url = request.url ?? '';
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push({ path: url, body: parsed });
      let answer: unknown;
      if (url === '/exchange/v1/users/info') answer = { coindcx_id: mismatch ? 'OFFLINE-DIFFERENT-ACCOUNT' : identity };
      else if (url === '/exchange/v1/derivatives/futures/orders') {
        answer = parsed['page'] === '1' ? Array.from({ length: proposal.configuration.scanLimits.ORDERS.pageSize }, (_, i) => ({
          id: `${String(parsed['side'])}-${i}`, pair: 'B-BTC_USDT', side: parsed['side'], status: 'open', order_type: 'limit_order',
          leverage: '5', price: '100', avg_price: null, total_quantity: '1', remaining_quantity: '1', cancelled_quantity: '0',
          margin_currency_short_name: 'INR', created_at: clock.now(), updated_at: clock.now(), client_order_id: null,
        })) : [];
      } else if (url === '/exchange/v1/derivatives/futures/positions') {
        answer = parsed['page'] === '1' ? Array.from({ length: proposal.configuration.scanLimits.POSITIONS.pageSize }, (_, i) => ({
          id: `position-${i}`, pair: 'B-BTC_USDT', active_pos: '1', avg_price: '100', locked_margin: '100', locked_user_margin: '100', locked_order_margin: '0',
          maintenance_margin: '1', mark_price: '100', margin_type: 'isolated', settlement_currency_avg_price: '89', margin_currency_short_name: 'INR', leverage: '5', updated_at: clock.now(),
        })) : [];
      } else { response.writeHead(404); response.end('{}'); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A literal loopback origin and synthetic credentials only. No production budget binding or state initialization.
  const budget = fixtureTransportBudget();
  const client = new CoinDcxClient({ baseUrl: origin, apiKey: 'OFFLINE-FIXTURE-KEY', apiSecret: 'OFFLINE-FIXTURE-SECRET',
    timeoutMs: proposal.configuration.budget.transportRequestTimeoutMs, readBudget: budget });
  const fixtureProposal: LaunchProposal = { ...proposal, configuration: { ...proposal.configuration,
    account: { accountId, expectedProviderAccountFingerprint: providerAccountFingerprint(identity) },
    budget: { ...proposal.configuration.budget, connectionId },
    lineage: { ownedOrders: [], ambiguousCreates: [], closedIntentTags: [], ownedPositions: [], botTagNamespace: 'OFFLINE-FIXTURE-' },
    reportDestination: { kind: 'LOCAL_FILE', path: reportPath },
  } };
  try {
    const outcome = await runPreparedCollection(fixtureProposal, {
      client: { getUserInfoSafe: () => client.getUserInfoSafe(), listInrFuturesOrders: request => client.listInrFuturesOrders(request),
        listInrFuturesPositions: request => client.listInrFuturesPositions(request) },
      identity: { fingerprint: providerAccountFingerprint, verify: verifyProviderAccountIdentity },
      authenticatedClient: { kind: 'CREDENTIAL_BOUND', accountId, budgetConnectionId: connectionId },
      coordinator: { status: () => ({ connected: true, localStop: false, coordinatorStop: 'NONE' }) },
      stream: null, clock, signal, reportSink: localReportSink,
    });
    return { mode: 'OFFLINE_LOOPBACK_FIXTURE_ONLY', readyToContactProvider: false, realProvenanceSatisfied: false,
      productionStateInitialized: false, productionBudgetBound: false, limiterPacingExercised: false,
      clock: 'VIRTUAL_FIXTURE_CLOCK', budget: 'IMMEDIATE_TEST_FIXTURE_ONLY_NOT_A_SHARED_COORDINATOR',
      fixtureSubstitutions: ['account', 'budget.connectionId', 'lineage', 'reportDestination', 'client/coordinator provenance', 'clock'],
      parametersChanged: false, requestCount: requests.length, requests, permits: budget.budget.log,
      delivery: outcome.delivery, reportPath, report: {
        status: outcome.report.status, stopReason: outcome.report.stopReason, scopeLabel: outcome.report.scopeLabel,
        observations: outcome.report.observations, counts: outcome.report.counts, grants: outcome.report.grants,
        identityOutcomes: outcome.report.evaluations.map(evaluation => evaluation.identity.outcome),
        streamObservations: outcome.report.evaluations.map(evaluation => evaluation.stream.observation),
        inFlight: outcome.report.inFlight,
      } };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
