import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { campaignEntry } from '../../../scripts/sync-read-launch/campaign-entry';
import { validateCampaignInvocation } from '../../../scripts/sync-read-launch/campaign-input';
import { validateCampaignHostInput } from '../../../scripts/sync-read-launch/campaign-host';
const { makeOfflinePrepareFixture } = createRequire(__filename)('../../../scripts/sync-read-launch/offline-prepare-fixture.cjs');
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function failedFixture() {
  // Same reviewed models and exactly the malformed synthetic substitutions in retained operator input.
  const value = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/launch/m4-collection-input.pending.json'), 'utf8'));
  value.host.campaignId = value.host.installationId = 'OFFLINE-prepare-diagnostic-20261013';
  value.host.coordinator.stateDirectory = path.resolve('OFFLINE-NEVER-INITIALIZE');
  value.host.coordinator.pipePath = value.host.client.pipePath = '\\\\.\\pipe\\OFFLINE-prepare-diagnostic-20261013';
  value.host.reportDirectory = path.join(value.host.coordinator.stateDirectory, 'reports');
  value.proposal.configuration.reportDestination.path = path.join(value.host.reportDirectory, 'campaign-report.json');
  value.proposal.configuration.account = { accountId: 'OFFLINE-SYNTHETIC-NO-ACCOUNT', expectedProviderAccountFingerprint: 'a'.repeat(64) };
  value.accountMapping = { ...value.proposal.configuration.account, sourceReference: 'SYNTHETIC_ONLY_NOT_ACCOUNT_EVIDENCE', verifiedAt: '2000-01-01T00:00:00.000Z', independentlyEstablished: true };
  value.credentialProvenance = { accountId: value.accountMapping.accountId, sourceReference: 'SYNTHETIC_ONLY_NO_CREDENTIALS', establishedAt: '2000-01-01T00:00:00.000Z' };
  value.managedTraffic.knownConsumers = [{ consumerId: value.host.campaignId, coordinatorInstallationId: value.host.installationId, operations: 'READ_P1_API_AUTH' }];
  return value;
}
function writeInput(value: unknown) {
  const directory = fs.mkdtempSync(path.resolve('.local/OFFLINE-prepare-unit-')); directories.push(directory);
  const file = path.join(directory, 'synthetic-input.json'); fs.writeFileSync(file, JSON.stringify(value)); return file;
}
describe('synthetic prepare host contract and offline-only refusal reporting', () => {
  it('reproduces invocation success followed by exact host schema rejection of the prior synthetic IDs', async () => {
    const input = failedFixture();
    expect(() => validateCampaignInvocation(input, Date.now())).not.toThrow();
    try { validateCampaignHostInput(input.host); expect.fail('Expected retained host substitutions to be rejected'); }
    catch (error) { expect(error).toBeInstanceOf(ZodError); expect((error as ZodError).issues.map(issue => issue.path.join('.'))).toEqual(['campaignId', 'installationId']); }
    const environment = vi.fn(() => { throw Error('NO_ENVIRONMENT_READ_ALLOWED'); });
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(campaignEntry(['prepare', '--input', writeInput(input)], environment)).rejects.toBeInstanceOf(ZodError);
    expect(environment).not.toHaveBeenCalled();
    expect(output.mock.calls).toEqual([[JSON.stringify({ kind: 'SYNTHETIC_OFFLINE_PREPARE_REFUSAL', stage: 'HOST_VALIDATION', code: 'CAMPAIGN_HOST_SCHEMA_INVALID' })]]);
  });
  it('prepares the corrected synthetic fixture through the actual campaign entry without environment or namespace access', async () => {
    const fixture = makeOfflinePrepareFixture(failedFixture(), path.resolve('.local/OFFLINE-unused-prepare-namespace'));
    const environment = vi.fn(() => { throw Error('NO_ENVIRONMENT_READ_ALLOWED'); });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(campaignEntry(['prepare', '--input', writeInput(fixture)], environment)).resolves.toBe(0);
    expect(environment).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ outcome: 'CAMPAIGN_CONFIGURATION_VALID', maximumRequests: 39, readyToContactProvider: false });
    expect(fs.existsSync(fixture.host.coordinator.stateDirectory)).toBe(false);
  });
  it('keeps state/pipe bindings enforced after fixing identifier formats', async () => {
    const fixture = makeOfflinePrepareFixture(failedFixture(), path.resolve('.local/OFFLINE-unused-prepare-namespace'));
    fixture.host.coordinator.stateDirectory = path.join(path.dirname(fixture.host.coordinator.stateDirectory), 'WRONG-BASENAME');
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(campaignEntry(['prepare', '--input', writeInput(fixture)])).rejects.toThrow('CAMPAIGN_NAMESPACE_OR_SUPERVISION_INVALID');
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({ kind: 'SYNTHETIC_OFFLINE_PREPARE_REFUSAL', stage: 'HOST_VALIDATION', code: 'CAMPAIGN_NAMESPACE_OR_SUPERVISION_INVALID' });
    const badPipe = makeOfflinePrepareFixture(failedFixture(), path.resolve('.local/OFFLINE-unused-prepare-namespace'));
    badPipe.host.client.pipePath = '\\\\.\\pipe\\OFFLINE-WRONG-PIPE';
    expect(() => validateCampaignHostInput(badPipe.host)).toThrow('CAMPAIGN_NAMESPACE_OR_SUPERVISION_INVALID');
  });
  it('does not add real-provider error dumps or expose supplied values', async () => {
    const input = failedFixture(); input.accountMapping.sourceReference = 'REAL_PROVIDER_OR_PRIVATE_SECRET_MARKER';
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(campaignEntry(['prepare', '--input', writeInput(input)])).rejects.toBeInstanceOf(ZodError);
    expect(output).not.toHaveBeenCalled();
    input.accountMapping.sourceReference = 'SYNTHETIC_ONLY_NOT_ACCOUNT_EVIDENCE';
    input.host.campaignId = 'PRIVATE_VALUE_MUST_NOT_BE_PRINTED';
    await expect(campaignEntry(['prepare', '--input', writeInput(input)])).rejects.toBeInstanceOf(ZodError);
    expect(JSON.stringify(output.mock.calls)).not.toMatch(/PRIVATE_VALUE|OFFLINE-prepare|issues|stack|regex/);
  });
  it('does not change policy, observations, synthetic provenance or original fixture bytes', () => {
    const before = failedFixture(), copy = structuredClone(before);
    const fixture = makeOfflinePrepareFixture(before, path.resolve('.local/OFFLINE-unused-prepare-namespace'));
    expect(before).toEqual(copy); expect(fixture.accountMapping).toEqual(before.accountMapping);
    expect(fixture.credentialProvenance).toEqual(before.credentialProvenance);
    for (const field of ['scope','budget','scanLimits','timeouts','campaign','lineage','contracts','decisions']) {
      expect(fixture.proposal.configuration[field]).toEqual(before.proposal.configuration[field]);
    }
    expect(fixture.host.supervision).toEqual(before.host.supervision);
    expect(fixture.host.coordinator.limiter).toEqual(before.host.coordinator.limiter);
    const bound = validateCampaignHostInput(fixture.host);
    expect(fixture.managedTraffic.knownConsumers).toEqual([{ consumerId: bound.campaignId, coordinatorInstallationId: bound.installationId, operations: 'READ_P1_API_AUTH' }]);
  });
  it('refuses credential-bound or non-synthetic fixture construction', () => {
    const input = failedFixture();input.credentialProvenance.sourceBinding = { kind: 'protected-dpapi', path: 'NEVER-READ', ciphertextSha256: 'a'.repeat(64) };
    expect(() => makeOfflinePrepareFixture(input, path.resolve('.local/OFFLINE-unused-prepare-namespace'))).toThrow('SYNTHETIC_PREPARE_FIXTURE_REQUIRED');
    expect(() => makeOfflinePrepareFixture(failedFixture(), 'relative-path')).toThrow('SYNTHETIC_PREPARE_FIXTURE_REQUIRED');
  });
});
