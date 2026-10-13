import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { operatorEntry } from '../../../scripts/coindcx-sync-read-operator';
import { campaignDigest, campaignParameters } from '../../../scripts/sync-read-launch/campaign-input';
import { initializeCampaignHost } from '../../../scripts/sync-read-launch/campaign-host';
import { assertCredentialCustody, credentialStorePath, loadSelectedCredentialSource } from '../../../scripts/sync-read-launch/credential-store';
import { loadIpcKeyFile } from '../../../scripts/sync-read-launch/operator-local-secrets';
vi.mock('../../../scripts/sync-read-launch/credential-store', async original => ({ ...await original<object>(),
  assertCredentialCustody: vi.fn(), loadSelectedCredentialSource: vi.fn(() => { throw Error('SYNTHETIC_API_LOADER_MUST_NOT_RUN'); }) }));
vi.mock('../../../scripts/sync-read-launch/operator-local-secrets', async original => ({ ...await original<object>(), loadIpcKeyFile: vi.fn() }));
vi.mock('../../../scripts/sync-read-launch/campaign-host', async original => ({ ...await original<object>(), initializeCampaignHost: vi.fn() }));
const directories: string[] = [];
beforeEach(() => { vi.clearAllMocks(); vi.mocked(loadIpcKeyFile).mockReturnValue({ COINDCX_CAMPAIGN_IPC_READ_KEY: '1'.repeat(64), COINDCX_CAMPAIGN_IPC_STOP_KEY: '2'.repeat(64) }); });
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture(options: { expired?: boolean; wrongDigest?: boolean } = {}) {
  const input = JSON.parse(fs.readFileSync(path.resolve('docs/launch/m4-collection-input.pending.json'), 'utf8'));
  input.proposal.configuration.account = { accountId: 'OFFLINE-IPC-ONLY-ACCOUNT', expectedProviderAccountFingerprint: 'a'.repeat(64) };
  input.accountMapping = { ...input.proposal.configuration.account, sourceReference: 'SYNTHETIC_ONLY_NOT_ACCOUNT_EVIDENCE', verifiedAt: '2000-01-01T00:00:00.000Z', independentlyEstablished: true };
  input.credentialProvenance = { accountId: input.accountMapping.accountId, sourceReference: 'SYNTHETIC_ONLY_NO_CREDENTIALS', establishedAt: '2000-01-01T00:00:00.000Z',
    sourceBinding: { kind: 'protected-dpapi', path: credentialStorePath(), ciphertextSha256: 'b'.repeat(64) } };
  const authorization = { kind: 'RECORDED_READ_ONLY_COLLECTION_AUTHORIZATION', target: 'COINDCX_PROVIDER', authorizationId: 'SYNTHETIC-ONLY', authorizedBy: 'SYNTHETIC-ONLY',
    authorizedAt: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() + (options.expired ? -1000 : 60000)).toISOString(),
    invocationSha256: campaignDigest(input), accountId: input.accountMapping.accountId, expectedProviderAccountFingerprint: input.accountMapping.expectedProviderAccountFingerprint,
    scope: 'ORDERS_POSITIONS_ONLY_INFORMATION_COLLECTION', maximumRequests: 39, approvedProposalParametersSha256: campaignDigest(campaignParameters(input.proposal)),
    reviews: Object.fromEntries(['hostSecurity','credentialCustody','supervisorAndStop','reportAccess','stateLifecycle','aggregateManagedBudget'].map(name => [name, 'SYNTHETIC-ONLY'])),
    residualHostAssumptions: 'EXPLICITLY_REVIEWED_NO_ACL_REMOTE_OR_PROCESS_IDENTITY_PROOF' };
  const directory = fs.mkdtempSync(path.resolve('.local/OFFLINE-initialize-keys-unit-')); directories.push(directory);
  const file = path.join(directory, 'input.json'), auth = path.join(directory, 'synthetic-authorization.json');
  fs.writeFileSync(file, JSON.stringify(input)); fs.writeFileSync(auth, JSON.stringify(authorization));
  const originalRead = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(target) === credentialStorePath()) throw Error('SYNTHETIC_API_CIPHERTEXT_READ_FORBIDDEN');
    if (String(target) === path.resolve('runtime-inventory.json')) return JSON.stringify({ files: [{ path: 'operator-credentials/coindcx-api.dpapi', sha256: (options.wrongDigest ? 'c' : 'b').repeat(64) }] });
    return Reflect.apply(originalRead, fs, [target, ...args]);
  }) as typeof fs.readFileSync);
  const args = ['initialize-campaign', '--ipc-key-file', path.join(directory, 'SYNTHETIC-ipc.dpapi'), '--credential-source', 'protected-dpapi', '--input', file, '--authorization', auth, '--confirm', 'NEW_READ_ONLY_CAMPAIGN'];
  return { args, input };
}
describe('protected-DPAPI initialization consumes IPC keys only, after independent authorization and custody', () => {
  it('initializes without reading/decrypting API ciphertext or invoking its loader', async () => {
    const { args, input } = fixture(); const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(operatorEntry(args)).resolves.toBe(0);
    expect(loadSelectedCredentialSource).not.toHaveBeenCalled(); expect(assertCredentialCustody).toHaveBeenCalledWith(credentialStorePath());
    expect(loadIpcKeyFile).toHaveBeenCalledTimes(1);
    expect(initializeCampaignHost).toHaveBeenCalledWith(expect.objectContaining({ campaignId: input.host.campaignId }), { read: '1'.repeat(64), operatorStop: '2'.repeat(64) }, 'NEW_READ_ONLY_CAMPAIGN');
    expect(output.mock.calls).toHaveLength(1); expect(JSON.stringify(output.mock.calls)).not.toContain('1'.repeat(64));
  });
  it('rejects expired authorization before custody, IPC decryption or initialization', async () => {
    const { args } = fixture({ expired: true });
    await expect(operatorEntry(args)).rejects.toThrow('RECORDED_PROVIDER_AUTHORIZATION_MISMATCH_OR_EXPIRED');
    expect(assertCredentialCustody).not.toHaveBeenCalled(); expect(loadIpcKeyFile).not.toHaveBeenCalled(); expect(initializeCampaignHost).not.toHaveBeenCalled();
  });
  it('retains selected ciphertext digest enforcement before IPC decryption', async () => {
    const { args } = fixture({ wrongDigest: true });
    await expect(operatorEntry(args)).rejects.toThrow('CREDENTIAL_SOURCE_INVOCATION_BINDING_REQUIRED');
    expect(loadIpcKeyFile).not.toHaveBeenCalled(); expect(initializeCampaignHost).not.toHaveBeenCalled();
  });
  it('retains distinct valid IPC key validation', async () => {
    const { args } = fixture(); vi.mocked(loadIpcKeyFile).mockReturnValue({ COINDCX_CAMPAIGN_IPC_READ_KEY: '1'.repeat(64), COINDCX_CAMPAIGN_IPC_STOP_KEY: '1'.repeat(64) });
    await expect(operatorEntry(args)).rejects.toThrow('DISTINCT_CAMPAIGN_CAPABILITY_KEYS_REQUIRED'); expect(initializeCampaignHost).not.toHaveBeenCalled();
  });
  it('leaves run-provider API loading behind the existing authorization gate', async () => {
    const { args } = fixture(); const run = args.slice(0, -2);run[0] = 'run-provider';
    await expect(operatorEntry(run)).rejects.toThrow('SYNTHETIC_API_LOADER_MUST_NOT_RUN');
    expect(loadSelectedCredentialSource).toHaveBeenCalledTimes(1); expect(initializeCampaignHost).not.toHaveBeenCalled();
  });
});
