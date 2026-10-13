/** Deliberate local preparation; future provider actions retain the existing independent authorization gate. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { campaignEntry } from './sync-read-launch/campaign-entry';
import { loadCampaignSecrets } from './sync-read-launch/campaign-secrets';
import { createIpcKeyFile, loadIpcKeyFile, AUTHORIZED_CREDENTIAL_SOURCE } from './sync-read-launch/operator-local-secrets';
import { assertCredentialCustody, credentialStorePath, loadSelectedCredentialSource, parseCredentialSource } from './sync-read-launch/credential-store';
import { validateCampaignInvocation } from './sync-read-launch/campaign-input';

export async function operatorEntry(args: readonly string[]): Promise<number> {
  const [action, keyFlag, keyFile, sourceFlag, sourceValue, ...rest] = args;
  if (!['prepare-local', 'initialize-campaign', 'run-provider'].includes(action ?? '') || keyFlag !== '--ipc-key-file'
    || !keyFile || !path.isAbsolute(keyFile)) throw new Error('EXPLICIT_OPERATOR_INPUTS_REQUIRED');
  if (sourceFlag !== '--credential-source') throw new Error('EXPLICIT_CREDENTIAL_SOURCE_REQUIRED');
  const sourceSelection = parseCredentialSource(sourceValue);
  if (action === 'prepare-local') {
    if (rest.length || fs.existsSync(keyFile)) throw new Error('NEW_LOCAL_IPC_KEY_FILE_REQUIRED');
    // This command reads only the authorized credential source, generates IPC keys, and never initializes a campaign.
    const sourceFile = sourceSelection === 'protected-dpapi' ? credentialStorePath() : AUTHORIZED_CREDENTIAL_SOURCE;
    const source = await loadSelectedCredentialSource(sourceSelection);
    createIpcKeyFile(keyFile);
    const environment = { ...source.environment, ...loadIpcKeyFile(keyFile) };
    if ([environment.COINDCX_CAMPAIGN_IPC_READ_KEY, environment.COINDCX_CAMPAIGN_IPC_STOP_KEY]
      .some(key => key === environment.COINDCX_CAMPAIGN_API_KEY || key === environment.COINDCX_CAMPAIGN_API_SECRET)) throw new Error('PROVIDER_AND_IPC_KEYS_MUST_DIFFER');
    loadCampaignSecrets(environment);
    // Re-stream solely for an unchanged-source digest; no operational settings are interpreted or retained.
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(sourceFile)) digest.update(chunk);
    if (digest.digest('hex') !== source.sourceFileSha256) throw new Error('CAMPAIGN_SOURCE_CHANGED_DURING_PREPARATION');
    console.log(JSON.stringify({ outcome: 'LOCAL_CREDENTIAL_MAPPING_AND_IPC_KEYS_PREPARED', sourceUnchanged: true,
      providerCredentialValuesPersisted: false, ipcProtection: 'WINDOWS_DPAPI_CURRENT_USER', separateReadStopKeys: true,
      campaignInitialized: false, providerRequests: 0, readyToContactProvider: false, valuesStatus: 'PROPOSED_NOT_APPROVED' }));
    return 0;
  }
  // The existing entry validates independent authorization BEFORE invoking this lazy credential callback.
  return campaignEntry([action!, ...rest], async () => {
    const inputFile = rest[rest.indexOf('--input') + 1]!;
    const invocation = validateCampaignInvocation(JSON.parse(fs.readFileSync(inputFile, 'utf8')), Date.now());
    const binding = invocation.credentialProvenance.sourceBinding;
    if (sourceSelection === 'protected-dpapi' ? !binding || path.resolve(binding.path) !== credentialStorePath() : binding !== undefined) {
      throw new Error('CREDENTIAL_SOURCE_INVOCATION_BINDING_REQUIRED');
    }
    if (action === 'initialize-campaign' && sourceSelection === 'protected-dpapi') {
      // Preserve full selected-source custody/hash validation without opening or decrypting API ciphertext here.
      assertCredentialCustody(credentialStorePath());
      const root = path.resolve(__dirname, '..');
      const inventory = JSON.parse(fs.readFileSync(path.join(root, 'runtime-inventory.json'), 'utf8')) as { files: { path: string; sha256: string }[] };
      if (!inventory.files.some(entry => path.resolve(root, entry.path) === credentialStorePath() && entry.sha256 === binding!.ciphertextSha256)) {
        throw new Error('CREDENTIAL_SOURCE_INVOCATION_BINDING_REQUIRED');
      }
      return loadIpcKeyFile(keyFile);
    }
    return { ...(await loadSelectedCredentialSource(sourceSelection, binding?.ciphertextSha256)).environment, ...loadIpcKeyFile(keyFile) };
  }, 'COINDCX_PROVIDER');
}
if (require.main === module) void operatorEntry(process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(() => { console.error('OPERATOR_PREPARATION_OR_AUTHORIZED_INVOCATION_REFUSED'); process.exitCode = 1; });
