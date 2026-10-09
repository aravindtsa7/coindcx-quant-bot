import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { selectCredentialLine, campaignCredentialEnvironment, createIpcKeyFile, loadIpcKeyFile } from '../../../scripts/sync-read-launch/operator-local-secrets';
import { campaignEntry } from '../../../scripts/sync-read-launch/campaign-entry';
import { operatorEntry } from '../../../scripts/coindcx-sync-read-operator';
import { inspectLaunchProposal } from '../../../scripts/sync-read-launch/proposal';
import { campaignDigest, campaignParameters, SHARED_USE_PARAMETERS_SHA256 } from '../../../scripts/sync-read-launch/campaign-input';

describe('explicit local preparation with synthetic credentials only', () => {
  it('selects only the two exact literal assignments, never expands operational settings', () => {
    const selected = new Map<string, string>();
    for (const line of ['OTHER_SECRET=$(do-not-evaluate)', '# COINDCX_API_KEY=ignored', 'COINDCX_API_KEY="OFFLINE-KEY"', "export COINDCX_API_SECRET='OFFLINE-SECRET' # comment", 'LIVE_ENABLED=true']) selectCredentialLine(line, selected);
    expect(campaignCredentialEnvironment(selected)).toEqual({ COINDCX_CAMPAIGN_API_KEY: 'OFFLINE-KEY', COINDCX_CAMPAIGN_API_SECRET: 'OFFLINE-SECRET' });
    expect([...selected.keys()]).toEqual(['COINDCX_API_KEY', 'COINDCX_API_SECRET']);
  });
  it('refuses duplicate, absent, expanded, multiline or malformed source values without echoing them', () => {
    expect(() => campaignCredentialEnvironment(new Map())).toThrow('TWO_VALUES_REQUIRED');
    for (const value of ['$(OFFLINE-command)', '${OFFLINE-secret}', '"OFFLINE-unclosed', 'OFFLINE\\escaped', '"OFFLINE\nsecret"']) {
      expect(() => selectCredentialLine(`COINDCX_API_KEY=${value}`, new Map())).toThrow('LITERAL_REQUIRED');
    }
    const selected = new Map<string, string>(); selectCredentialLine('COINDCX_API_KEY=OFFLINE-KEY', selected);
    expect(() => selectCredentialLine('COINDCX_API_KEY=OFFLINE-OTHER', selected)).toThrow('DUPLICATE');
  });
  it('DPAPI protects separate random keys, restores them only in memory and refuses overwrite', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'coindcx-ipc-preparation-test-')), file = path.join(parent, 'ipc.dpapi');
    createIpcKeyFile(file); const keys = loadIpcKeyFile(file);
    expect(keys.COINDCX_CAMPAIGN_IPC_READ_KEY).toMatch(/^[a-f0-9]{64}$/);
    expect(keys.COINDCX_CAMPAIGN_IPC_STOP_KEY).toMatch(/^[a-f0-9]{64}$/);
    expect(keys.COINDCX_CAMPAIGN_IPC_READ_KEY).not.toBe(keys.COINDCX_CAMPAIGN_IPC_STOP_KEY);
    const encrypted = fs.readFileSync(file).toString('hex');
    for (const secret of Object.values(keys)) expect(encrypted).not.toContain(secret);
    expect(loadIpcKeyFile(file)).toEqual(keys); expect(() => createIpcKeyFile(file)).toThrow();
  });
  it('refuses incomplete operator input before invoking any lazy credential callback', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'coindcx-input-preparation-test-')), file = path.join(parent, 'input.json');
    fs.writeFileSync(file, '{}'); const credentials = vi.fn();
    await expect(campaignEntry(['run-provider', '--input', file], credentials)).rejects.toThrow('CAMPAIGN_INPUT_INVALID');
    expect(credentials).not.toHaveBeenCalled();
    await expect(operatorEntry(['run-provider', '--ipc-key-file', path.join(parent, 'absent.dpapi'), '--input', file])).rejects.toThrow('CAMPAIGN_INPUT_INVALID');
  });
  it('pins manual/shared use without changing the numeric proposal or attesting exclusivity', () => {
    const p = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/launch/m4-orders-positions-proposal.json'), 'utf8'));
    p.configuration.accountScope = { assumption: 'SHARED_USE_POSSIBLE', attestation: 'NONE' };
    const inspection = inspectLaunchProposal(p); expect(inspection.parametersValid).toBe(true);
    expect(inspection.requestBounds?.maximumRequests).toBe(39);
    expect(campaignDigest(campaignParameters(p))).toBe(SHARED_USE_PARAMETERS_SHA256);
    p.configuration.accountScope.attestation = 'EXCLUSIVE_BOT_USE'; expect(inspectLaunchProposal(p).parametersValid).toBe(false);
  });
  it('validates authorization before calling the source loader, and prepare calls no loader', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'coindcx-authorization-preparation-test-')), file = path.join(parent, 'input.json');
    const p = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/launch/m4-orders-positions-proposal.json'), 'utf8'));
    const campaignId = 'readonly-campaign-OFFLINE-test', installationId = `c${'0'.repeat(32)}`, pipePath = `\\\\.\\pipe\\coindcx-readonly-campaign-${installationId}`, stateDirectory = path.join(parent, campaignId);
    p.configuration.account = { accountId: 'OFFLINE-ACCOUNT', expectedProviderAccountFingerprint: 'f'.repeat(64) };
    p.configuration.lineage = { kind: 'UNAVAILABLE', reason: 'OFFLINE-NO-LINEAGE' };
    p.configuration.accountScope.assumption = 'SHARED_USE_POSSIBLE';
    p.configuration.reportDestination.path = path.join(stateDirectory, 'reports', 'report.json');
    const input = { kind: 'COINDCX_READ_ONLY_CAMPAIGN_INPUT', target: { kind: 'COINDCX_PROVIDER', origin: 'https://api.coindcx.com' }, valuesStatus: 'PROPOSED_NOT_APPROVED', proposal: p,
      host: { valuesStatus: 'PROPOSED_NOT_APPROVED', networkAccess: 'COINDCX_PROVIDER_AUTHORIZATION_REQUIRED', campaignId, installationId,
        coordinator: { limiter: p.configuration.budget.limiter, stateDirectory, pipePath, maxFrameBytes: 65536, maxStateBytes: 1048576, tickMs: 10, handshakeTimeoutMs: 2000, maxSessions: 16, maxRegisteredClients: 32, maxPendingRequestsPerSession: 16 },
        client: { pipePath, maxFrameBytes: 65536, connectTimeoutMs: 2000, probeScopes: [], maxOutbox: 256 },
        supervision: { heartbeatIntervalMs: 1000, leaseMs: 15000, shutdownWaitMs: 15000, pollMs: 100 }, expectedWindowsOwner: 'OFFLINE-OWNER', ownershipCheckTimeoutMs: 10000, reportDirectory: path.join(stateDirectory, 'reports') },
      accountMapping: { ...p.configuration.account, sourceReference: 'OFFLINE-INDEPENDENT-REFERENCE', verifiedAt: '2026-09-24T13:11:41.439Z', independentlyEstablished: true },
      credentialProvenance: { accountId: 'OFFLINE-ACCOUNT', sourceReference: 'OFFLINE-OPERATOR', establishedAt: '2026-09-24T13:11:41.439Z' },
      lineageProvenance: p.configuration.lineage, connectionBinding: 'AUTHENTICATED_CAMPAIGN_SESSION_AT_START',
      managedTraffic: { knownConsumers: [{ consumerId: campaignId, coordinatorInstallationId: installationId, operations: 'READ_P1_API_AUTH' }], externalTraffic: 'UNKNOWN_NOT_CONTROLLED' } };
    fs.writeFileSync(file, JSON.stringify(input)); const credentials = vi.fn();
    const print = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(campaignEntry(['prepare', '--input', file], credentials)).resolves.toBe(0);
      await expect(campaignEntry(['initialize-campaign', '--input', file, '--confirm', 'NEW_READ_ONLY_CAMPAIGN'], credentials)).rejects.toThrow('ABSOLUTE_CAMPAIGN_JSON_INPUT_REQUIRED');
      await expect(operatorEntry(['initialize-campaign', '--ipc-key-file', path.join(parent, 'absent.dpapi'), '--input', file, '--confirm', 'NEW_READ_ONLY_CAMPAIGN'])).rejects.toThrow('ABSOLUTE_CAMPAIGN_JSON_INPUT_REQUIRED');
      expect(credentials).not.toHaveBeenCalled(); expect(fs.existsSync(stateDirectory)).toBe(false);
      fs.writeFileSync(file, JSON.stringify({ ...input, target: { kind: 'LOOPBACK_FIXTURE', origin: 'http://127.0.0.1:1234' }, host: { ...input.host, networkAccess: 'LOOPBACK_ONLY' } }));
      await expect(operatorEntry(['initialize-campaign', '--ipc-key-file', path.join(parent, 'absent.dpapi'), '--input', file, '--confirm', 'NEW_READ_ONLY_CAMPAIGN'])).rejects.toThrow('CAMPAIGN_TARGET_MODE_MISMATCH');
    } finally { print.mockRestore(); }
  });
});
