import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CampaignInvocationSchema, validateCampaignInvocation, requireRecordedAuthorization, campaignDigest, campaignParameters, PROPOSED_PARAMETERS_SHA256 } from '../../../scripts/sync-read-launch/campaign-input';
import { loadCampaignSecrets, CAMPAIGN_ENVIRONMENT_NAMES, redactCampaignOutput } from '../../../scripts/sync-read-launch/campaign-secrets';
import { assertCampaignOperation, campaignReadBoundary } from '../../../scripts/sync-read-launch/campaign-read-boundary';
import { inspectLaunchProposal } from '../../../scripts/sync-read-launch/proposal';
import { providerAccountFingerprint } from '../../../src/execution/live/reconciliation/account-identity';
import { CoinDcxTransport, type CoinDcxReadEndpoint } from '../../../src/integration/coindcx/transport';
import type { SyncCampaignReadClient } from '../../../src/integration/coindcx/live/sync-read-campaign';

const original = () => inspectLaunchProposal(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/launch/m4-orders-positions-proposal.json'), 'utf8'))).proposal!;
const ID = 'OFFLINE-INDEPENDENT-ACCOUNT';
const now = Date.parse('2026-10-09T00:00:00Z');
function input() {
  const p = original();
  return { kind: 'COINDCX_READ_ONLY_CAMPAIGN_INPUT' as const, target: { kind: 'LOOPBACK_FIXTURE' as const, origin: 'http://127.0.0.1:1234' },
    valuesStatus: 'PROPOSED_NOT_APPROVED' as const, host: {}, proposal: { ...p, configuration: { ...p.configuration,
      account: { accountId: ID, expectedProviderAccountFingerprint: providerAccountFingerprint(ID) }, lineage: { kind: 'UNAVAILABLE', reason: 'OFFLINE-NO-LINEAGE' } } },
    accountMapping: { accountId: ID, expectedProviderAccountFingerprint: providerAccountFingerprint(ID), sourceReference: 'OFFLINE-INDEPENDENT-SOURCE', verifiedAt: '2026-10-08T00:00:00Z', independentlyEstablished: true as const },
    credentialProvenance: { accountId: ID, sourceReference: 'OFFLINE-CREDENTIAL-SOURCE', establishedAt: '2026-10-08T00:00:00Z' },
    lineageProvenance: { kind: 'UNAVAILABLE' as const, reason: 'OFFLINE-NO-LINEAGE' }, connectionBinding: 'AUTHENTICATED_CAMPAIGN_SESSION_AT_START' as const,
    managedTraffic: { knownConsumers: [{ consumerId: 'OFFLINE-CAMPAIGN', coordinatorInstallationId: 'OFFLINE-INSTALLATION', operations: 'READ_P1_API_AUTH' as const }], externalTraffic: 'UNKNOWN_NOT_CONTROLLED' as const } };
}
describe('campaign inputs, semantic allowlist and request ceiling without provider access', () => {
  it('pins every proposed parameter and the 39 request calculation, leaving the actual proposal unapproved and unpopulated', () => {
    const p = original(); expect(campaignDigest(campaignParameters(p))).toBe(PROPOSED_PARAMETERS_SHA256);
    expect(inspectLaunchProposal(p).requestBounds?.maximumRequests).toBe(39); expect(p.configuration.account.accountId).toBeNull();
    expect(p.valuesStatus).toBe('PROPOSED_NOT_APPROVED'); expect(validateCampaignInvocation(input(), now).lineageProvenance.kind).toBe('UNAVAILABLE');
    const changed = input(); changed.proposal.configuration.scanLimits.ORDERS.maxPages = 3;
    expect(() => validateCampaignInvocation(changed, now)).toThrow('EXACT_39_REQUEST');
    const lowered = input(); lowered.proposal.configuration.campaign.maxEvaluations = 1;
    expect(() => validateCampaignInvocation(lowered, now)).toThrow('EXACT_39_REQUEST');
  });
  it('requires independent matching account mapping, provenance date and a separate lineage availability declaration', () => {
    const { accountMapping: _mapping, ...missing } = input(); expect(() => validateCampaignInvocation(missing, now)).toThrow('CAMPAIGN_INPUT_INVALID');
    for (const mapping of [{ ...input().accountMapping, accountId: 'OTHER' }, { ...input().accountMapping, verifiedAt: '2099-01-01T00:00:00Z' }]) expect(() => validateCampaignInvocation({ ...input(), accountMapping: mapping }, now)).toThrow('INDEPENDENT_ACCOUNT');
    expect(() => validateCampaignInvocation({ ...input(), lineageProvenance: { kind: 'UNAVAILABLE', reason: 'different' } }, now)).toThrow('LINEAGE_INPUT');
    const noLineage = input(); Reflect.set(noLineage.proposal.configuration, 'lineage', null); expect(() => validateCampaignInvocation(noLineage, now)).toThrow('LINEAGE_INPUT');
  });
  it('separates real and loopback targets without arbitrary hosts, credentials in URLs or provider relabelling', () => {
    for (const target of [{ kind: 'LOOPBACK_FIXTURE', origin: 'https://api.coindcx.com' }, { kind: 'COINDCX_PROVIDER', origin: 'http://127.0.0.1:1234' },
      { kind: 'COINDCX_PROVIDER', origin: 'https://api.coindcx.com.evil.example' }, { kind: 'LOOPBACK_FIXTURE', origin: 'http://secret@127.0.0.1:1234' }]) expect(CampaignInvocationSchema.safeParse({ ...input(), target }).success).toBe(false);
    expect(validateCampaignInvocation({ ...input(), target: { kind: 'COINDCX_PROVIDER', origin: 'https://api.coindcx.com' } }, now).target.kind).toBe('COINDCX_PROVIDER');
  });
  it('never grants provider authority from missing, forged or loopback authorization records', () => {
    const provider = validateCampaignInvocation({ ...input(), target: { kind: 'COINDCX_PROVIDER', origin: 'https://api.coindcx.com' } }, now);
    for (const record of [undefined, {}, { kind: 'FIXTURE_ONLY_NOT_AUTHORIZATION' }, { kind: 'RECORDED_READ_ONLY_COLLECTION_AUTHORIZATION', target: 'LOOPBACK_FIXTURE' }]) expect(() => requireRecordedAuthorization(provider, record, now)).toThrow('RECORDED_PROVIDER_AUTHORIZATION_REQUIRED');
    expect(() => requireRecordedAuthorization(validateCampaignInvocation(input(), now), {}, now)).toThrow();
  });
  it('reads only four explicit campaign environment names and refuses live aliases, missing and shared IPC secrets', () => {
    const queried: string[] = []; const data = { COINDCX_CAMPAIGN_API_KEY: 'OFFLINE-KEY', COINDCX_CAMPAIGN_API_SECRET: 'OFFLINE-SECRET', COINDCX_CAMPAIGN_IPC_READ_KEY: 'a'.repeat(64), COINDCX_CAMPAIGN_IPC_STOP_KEY: 'b'.repeat(64) };
    const environment = new Proxy(data, { get(target, name: string) { queried.push(name); return Reflect.get(target, name) as string | undefined; } });
    expect(loadCampaignSecrets(environment).credentials.apiKey).toBe('OFFLINE-KEY'); expect(queried).toEqual(CAMPAIGN_ENVIRONMENT_NAMES);
    expect(() => loadCampaignSecrets({ COINDCX_API_KEY: 'OFFLINE-LIVE-ALIAS', COINDCX_API_SECRET: 'OFFLINE-LIVE-ALIAS' })).toThrow('CAMPAIGN_ENVIRONMENT_INPUTS_REQUIRED');
    for (const name of CAMPAIGN_ENVIRONMENT_NAMES) expect(() => loadCampaignSecrets({ ...data, [name]: undefined })).toThrow('CAMPAIGN_ENVIRONMENT_INPUTS_REQUIRED');
    expect(() => loadCampaignSecrets({ ...data, COINDCX_CAMPAIGN_IPC_STOP_KEY: data.COINDCX_CAMPAIGN_IPC_READ_KEY })).toThrow('CAMPAIGN_IPC_KEYS_INVALID');
    expect(JSON.stringify(redactCampaignOutput({ nested: ['prefix OFFLINE-SECRET tail'], apiKey: 'OFFLINE-KEY' }, ['OFFLINE-KEY', 'OFFLINE-SECRET']))).not.toMatch(/OFFLINE-(KEY|SECRET)/);
  });
  it('validates binding and expiry using an in-memory synthetic authorization fixture, never an operator approval', () => {
    const provider = validateCampaignInvocation({ ...input(), target: { kind: 'COINDCX_PROVIDER', origin: 'https://api.coindcx.com' } }, now);
    const fixture = { kind: 'RECORDED_READ_ONLY_COLLECTION_AUTHORIZATION', target: 'COINDCX_PROVIDER', authorizationId: 'SYNTHETIC-IN-MEMORY-TEST-ONLY',
      authorizedBy: 'SYNTHETIC-NOT-AN-OPERATOR', authorizedAt: '2026-10-08T00:00:00Z', expiresAt: '2026-10-10T00:00:00Z', invocationSha256: campaignDigest(provider),
      accountId: ID, expectedProviderAccountFingerprint: provider.accountMapping.expectedProviderAccountFingerprint, scope: 'ORDERS_POSITIONS_ONLY_INFORMATION_COLLECTION', maximumRequests: 39,
      approvedProposalParametersSha256: PROPOSED_PARAMETERS_SHA256, reviews: { hostSecurity: 'SYNTHETIC', credentialCustody: 'SYNTHETIC', supervisorAndStop: 'SYNTHETIC', reportAccess: 'SYNTHETIC', stateLifecycle: 'SYNTHETIC', aggregateManagedBudget: 'SYNTHETIC' },
      residualHostAssumptions: 'EXPLICITLY_REVIEWED_NO_ACL_REMOTE_OR_PROCESS_IDENTITY_PROOF' };
    expect(() => requireRecordedAuthorization(provider, fixture, now)).not.toThrow();
    for (const change of [{ invocationSha256: '0'.repeat(64) }, { accountId: 'OTHER' }, { expectedProviderAccountFingerprint: '0'.repeat(64) },
      { expiresAt: '2026-10-08T00:00:00Z' }, { approvedProposalParametersSha256: '0'.repeat(64) }]) expect(() => requireRecordedAuthorization(provider, { ...fixture, ...change }, now)).toThrow('MISMATCH_OR_EXPIRED');
    expect(() => requireRecordedAuthorization({ ...provider, target: { kind: 'LOOPBACK_FIXTURE', origin: 'http://127.0.0.1:1' } }, fixture, now)).toThrow('AUTHORIZATION_REQUIRED');
  });
  it('rejects mutation semantics, other read endpoints and prototype names before budget acquisition', async () => {
    for (const [operation, endpoint] of [['POST', 'FUTURES_ORDERS'], ['CREATE', 'CREATE_ORDER'], ['CANCEL', 'CANCEL_ORDER'], ['INR_ORDERS', 'FUTURES_TRADES'], ['IDENTITY', '__proto__']]) expect(() => assertCampaignOperation(operation!, endpoint!)).toThrow('CAMPAIGN_OPERATION_NOT_ALLOWED');
    const acquire = vi.fn(); const transport = new CoinDcxTransport({ baseUrl: 'http://127.0.0.1:1', allowedReadEndpoints: ['USER_INFO', 'FUTURES_ORDERS', 'FUTURES_POSITIONS'], readBudget: { scope: 'API_AUTH', budget: { acquire } } });
    for (const endpoint of ['FUTURES_WALLETS', 'POSITION_TRANSACTIONS', 'CREATE_ORDER', 'CANCEL_ORDER', '__proto__']) await expect(transport.executeRead({ endpoint: endpoint as CoinDcxReadEndpoint })).rejects.toThrow('READ_ENDPOINT_NOT_ALLOWED');
    expect(acquire).not.toHaveBeenCalled();
  });
  it('enforces identity first, both side/page bounds, a hard 39-call ceiling and no mutation capability', async () => {
    const calls: string[] = [];
    const client: SyncCampaignReadClient = { getUserInfoSafe: async () => { calls.push('ID'); return { coindcxId: ID } as Awaited<ReturnType<SyncCampaignReadClient['getUserInfoSafe']>>; },
      listInrFuturesOrders: async () => { calls.push('ORDERS'); return []; }, listInrFuturesPositions: async () => { calls.push('POSITIONS'); return []; } };
    const boundary = campaignReadBoundary(client, input().proposal, vi.fn());
    await expect(boundary.client.listInrFuturesPositions({ page: '1', size: '25' })).rejects.toThrow('GATE_CLOSED'); expect(calls).toEqual([]);
    expect(Object.keys(boundary.client).sort()).toEqual(['getUserInfoSafe', 'listInrFuturesOrders', 'listInrFuturesPositions']);
    await boundary.client.getUserInfoSafe();
    expect(() => boundary.client.listInrFuturesOrders({ side: 'buy', status: 'open', page: '1', size: '25' })).toThrow('FILTER_NOT_ALLOWED');
    expect(() => boundary.client.listInrFuturesPositions({ page: '3', size: '25' })).toThrow('PAGE_NOT_ALLOWED');
    expect(() => boundary.client.listInrFuturesPositions({ page: '1', size: '25', pairs: 'B-BTC_USDT' })).toThrow('FILTER_NOT_ALLOWED');
    for (let i = 0; i < 38; i++) await boundary.client.listInrFuturesPositions({ page: '1', size: '25' });
    await expect(boundary.client.getUserInfoSafe()).rejects.toThrow('GATE_CLOSED'); expect(calls).toHaveLength(39);
  });
  it('a first error prevents every subsequent primitive invocation and does not retry', async () => {
    const error = vi.fn(), read = vi.fn(async () => { throw Error('OFFLINE-SECRET'); });
    const boundary = campaignReadBoundary({ getUserInfoSafe: read, listInrFuturesOrders: read, listInrFuturesPositions: read }, input().proposal, error);
    await expect(boundary.client.getUserInfoSafe()).rejects.toThrow(); await expect(boundary.client.getUserInfoSafe()).rejects.toThrow('GATE_CLOSED');
    expect(read).toHaveBeenCalledTimes(1); expect(error).toHaveBeenCalledTimes(1); expect(boundary.inspect()).toEqual({ started: 1, firstError: 'READ_FAILED' });
  });
});
