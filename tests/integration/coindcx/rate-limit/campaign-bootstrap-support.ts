import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { initializeCampaignHost, windowsDirectoryOwner, type CampaignHostInput } from '../../../../scripts/sync-read-launch/campaign-host';
import type { CampaignKeys } from '../../../../scripts/sync-read-launch/campaign-access';
import { inspectLaunchProposal, type LaunchProposal } from '../../../../scripts/sync-read-launch/proposal';
import { providerAccountFingerprint } from '../../../../src/execution/live/reconciliation/account-identity';
import { validateCoordinatorConfig, validateClientConfig } from '../../../../src/integration/coindcx/rate-limit/runtime/config';

export const ROOT = path.resolve(__dirname, '../../../..');
export const evidence = path.join(ROOT, '.local/m4-provider-invocation-evidence-20261009');
export const proposed = () => inspectLaunchProposal(JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/launch/m4-orders-positions-proposal.json'), 'utf8'))).proposal!;
let expectedOwner: string | undefined;
export function hostFixture(initialize = true, supervision: Partial<CampaignHostInput['supervision']> = {}) {
  const parent = fs.mkdtempSync(path.join(ROOT, '.local/m4-bootstrap-test-'));
  expectedOwner ??= windowsDirectoryOwner(parent, 10000);
  const campaignId = `readonly-campaign-${randomBytes(8).toString('hex')}`, installationId = `c${randomBytes(16).toString('hex')}`;
  const directory = path.join(parent, campaignId), pipePath = `\\\\.\\pipe\\coindcx-readonly-campaign-${installationId}`;
  const c = validateCoordinatorConfig({ limiter: proposed().configuration.budget.limiter, stateDirectory: directory, pipePath,
    maxFrameBytes: 65536, maxStateBytes: 1048576, tickMs: 10, handshakeTimeoutMs: 2000, maxSessions: 16, maxRegisteredClients: 32, maxPendingRequestsPerSession: 16 });
  const r = validateClientConfig({ pipePath, maxFrameBytes: 65536, connectTimeoutMs: 2000, probeScopes: [], maxOutbox: 256 });
  if (c.kind !== 'VALID' || r.kind !== 'VALID') throw Error('fixture runtime config invalid');
  const cfg = { valuesStatus: 'PROPOSED_NOT_APPROVED' as const, networkAccess: 'LOOPBACK_ONLY' as const,
    campaignId, installationId, coordinator: c.config, client: r.config,
    supervision: { heartbeatIntervalMs: 200, leaseMs: 15000, shutdownWaitMs: 300, pollMs: 20, ...supervision },
    expectedWindowsOwner: expectedOwner, ownershipCheckTimeoutMs: 10000, reportDirectory: path.join(directory, 'reports') };
  const keys: CampaignKeys = { read: randomBytes(32).toString('hex'), operatorStop: randomBytes(32).toString('hex') };
  if (initialize) initializeCampaignHost(cfg, keys, 'NEW_READ_ONLY_CAMPAIGN');
  return { cfg, keys, parent, directory, pipePath };
}
export const IDENTITY = 'OFFLINE-CAMPAIGN-ACCOUNT-IDENTIFIER';
export function fixtureProposal(connectionId: string, reportDirectory: string, maxEvaluations = 3): LaunchProposal {
  const p = proposed();
  return { ...p, configuration: { ...p.configuration,
    account: { accountId: 'OFFLINE-CAMPAIGN-ACCOUNT', expectedProviderAccountFingerprint: providerAccountFingerprint(IDENTITY) },
    budget: { ...p.configuration.budget, connectionId },
    lineage: { ownedOrders: [], ambiguousCreates: [], closedIntentTags: [], ownedPositions: [], botTagNamespace: 'OFFLINE-' },
    reportDestination: { kind: 'LOCAL_FILE', path: path.join(reportDirectory, 'campaign.json') },
    campaign: { ...p.configuration.campaign, maxEvaluations },
  } };
}
export function page(body: Record<string, unknown>, orders: boolean): unknown[] {
  if (body['page'] !== '1') return [];
  return Array.from({ length: 25 }, (_, i) => orders ? {
    id: `${String(body['side'])}-${i}`, pair: 'B-BTC_USDT', side: body['side'], status: 'open', order_type: 'limit_order', leverage: '5', price: '100', avg_price: null,
    total_quantity: '1', remaining_quantity: '1', cancelled_quantity: '0', margin_currency_short_name: 'INR', created_at: 1000, updated_at: 1000, client_order_id: null,
  } : { id: `position-${i}`, pair: 'B-BTC_USDT', active_pos: '1', avg_price: '100', locked_margin: '100', locked_user_margin: '100', locked_order_margin: '0',
    maintenance_margin: '1', mark_price: '100', margin_type: 'isolated', settlement_currency_avg_price: '89', margin_currency_short_name: 'INR', leverage: '5', updated_at: 1000 });
}
export async function venue(handler?: (url: string, body: Record<string, unknown>) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }> | { status: number; body: unknown; headers?: Record<string, string> }) {
  const hits: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    let text = ''; req.on('data', b => { text += String(b); });
    req.on('end', () => {
      const url = req.url ?? '', body = JSON.parse(text) as Record<string, unknown>; hits.push({ path: url, body });
      const standard: { status: number; body: unknown; headers?: Record<string, string> } = { status: 200, body: url.endsWith('/users/info') ? { coindcx_id: IDENTITY } : page(body, url.endsWith('/orders')) };
      void Promise.resolve(handler ? handler(url, body) : standard).then(answer => { res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers }); res.end(JSON.stringify(answer.body)); });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { hits, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
export const connection = (origin: string) => ({ origin, apiKey: 'OFFLINE-KEY', apiSecret: 'OFFLINE-SECRET' });
export function saveEvidence(name: string, data: unknown): void { fs.writeFileSync(path.join(evidence, name), JSON.stringify(data, null, 2) + '\n'); }
