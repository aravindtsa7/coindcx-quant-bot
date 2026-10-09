/** Closed semantic operations over the committed read client; no transport, signing, retry or budget acquisition. */
import type { SyncCampaignReadClient } from '../../src/integration/coindcx/live/sync-read-campaign';
import { providerAccountFingerprint } from '../../src/execution/live/reconciliation/account-identity';
import type { LaunchProposal } from './proposal';

export const CAMPAIGN_READ_ENDPOINTS = Object.freeze(['USER_INFO', 'FUTURES_ORDERS', 'FUTURES_POSITIONS'] as const);
export function assertCampaignOperation(operation: string, endpoint: string): void {
  if (![['IDENTITY', 'USER_INFO'], ['INR_ORDERS', 'FUTURES_ORDERS'], ['INR_POSITIONS', 'FUTURES_POSITIONS']].some(([op, id]) => operation === op && endpoint === id)) throw new Error('CAMPAIGN_OPERATION_NOT_ALLOWED');
}
export function campaignReadBoundary(client: SyncCampaignReadClient, proposal: LaunchProposal, onError: () => void) {
  let started = 0, verified = false, firstError: string | null = null;
  const c = proposal.configuration;
  const fail = (kind: string) => { firstError ??= kind; onError(); };
  const invoke = async <T>(op: string, endpoint: string, read: () => Promise<T>): Promise<T> => {
    assertCampaignOperation(op, endpoint);
    if (firstError !== null || started >= 39 || (op !== 'IDENTITY' && !verified)) throw new Error('CAMPAIGN_READ_GATE_CLOSED');
    started += 1;
    try { return await read(); } catch (error) {
      const e = error as { code?: unknown; details?: { readBudget?: unknown } };
      fail(e?.code === 'COINDCX_RATE_LIMIT' ? 'HTTP_429' : e?.details?.readBudget === 'REFUSED' ? 'BUDGET_REFUSED' : 'READ_FAILED');
      throw error;
    }
  };
  const boundedPage = (page: string, size: string, component: 'ORDERS' | 'POSITIONS') => {
    if (!/^[1-9][0-9]*$/.test(page) || Number(page) > c.scanLimits[component].maxPages || size !== String(c.scanLimits[component].pageSize)) throw new Error('CAMPAIGN_PAGE_NOT_ALLOWED');
  };
  return Object.freeze({ inspect: () => ({ started, firstError }), client: Object.freeze({
    getUserInfoSafe: () => invoke('IDENTITY', 'USER_INFO', async () => {
      verified = false; const result = await client.getUserInfoSafe();
      verified = typeof result.coindcxId === 'string' && providerAccountFingerprint(result.coindcxId) === c.account.expectedProviderAccountFingerprint;
      return result;
    }),
    listInrFuturesOrders: (request: Parameters<SyncCampaignReadClient['listInrFuturesOrders']>[0]) => {
      if (!Object.keys(request).every(key => ['status', 'side', 'page', 'size'].includes(key))) throw new Error('CAMPAIGN_ORDER_FILTER_NOT_ALLOWED');
      boundedPage(request.page, request.size, 'ORDERS');
      if (!['buy', 'sell'].includes(request.side) || request.status !== c.scope.orderStatuses.join(',')) throw new Error('CAMPAIGN_ORDER_FILTER_NOT_ALLOWED');
      return invoke('INR_ORDERS', 'FUTURES_ORDERS', () => client.listInrFuturesOrders(request));
    },
    listInrFuturesPositions: (request: Parameters<SyncCampaignReadClient['listInrFuturesPositions']>[0]) => {
      if (request === undefined || !Object.keys(request).every(key => ['page', 'size'].includes(key))) throw new Error('CAMPAIGN_POSITION_FILTER_NOT_ALLOWED');
      boundedPage(request.page, request.size, 'POSITIONS'); return invoke('INR_POSITIONS', 'FUTURES_POSITIONS', () => client.listInrFuturesPositions(request));
    },
  }) });
}
