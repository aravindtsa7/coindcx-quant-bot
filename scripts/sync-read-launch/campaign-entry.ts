/** Explicit command implementation. No I/O or environment reads until called. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { validateCampaignInvocation, requireRecordedAuthorization, campaignDigest } from './campaign-input';
import { loadCampaignSecrets, redactCampaignOutput } from './campaign-secrets';
import { initializeCampaignHost, startCampaignHost, validateCampaignHostInput } from './campaign-host';

export async function campaignEntry(args: readonly string[], environment: () => Readonly<Record<string, string | undefined>> | Promise<Readonly<Record<string, string | undefined>>> = () => process.env, requiredTarget?: 'COINDCX_PROVIDER'): Promise<number> {
  const [action, ...options] = args;
  if (!['prepare', 'initialize-campaign', 'run-provider', 'run-loopback'].includes(action ?? '')) throw new Error('EXPLICIT_CAMPAIGN_COMMAND_REQUIRED');
  const fields = new Map<string, string>();
  for (let i = 0; i < options.length; i += 2) {
    const name = options[i]!, value = options[i + 1];
    if (!['--input', '--authorization', '--confirm'].includes(name) || fields.has(name) || !value || value.startsWith('--')) throw new Error('CAMPAIGN_ARGUMENTS_INVALID');
    fields.set(name, value);
  }
  const read = (file: string | undefined) => {
    if (!file || !path.isAbsolute(file) || !file.endsWith('.json')) throw new Error('ABSOLUTE_CAMPAIGN_JSON_INPUT_REQUIRED');
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  };
  const input = validateCampaignInvocation(read(fields.get('--input')), Date.now());
  const cfg = validateCampaignHostInput(input.host);
  const provider = input.target.kind === 'COINDCX_PROVIDER';
  if (requiredTarget && input.target.kind !== requiredTarget) throw new Error('CAMPAIGN_TARGET_MODE_MISMATCH');
  if (cfg.networkAccess !== (provider ? 'COINDCX_PROVIDER_AUTHORIZATION_REQUIRED' : 'LOOPBACK_ONLY')) throw new Error('CAMPAIGN_TARGET_MODE_MISMATCH');
  if (action === 'prepare') {
    if (fields.size !== 1) throw new Error('PREPARE_READS_NO_AUTHORIZATION_OR_ENVIRONMENT');
    console.log(JSON.stringify({ outcome: 'CAMPAIGN_CONFIGURATION_VALID', target: input.target.kind, invocationSha256: campaignDigest(input), maximumRequests: 39,
      valuesStatus: 'PROPOSED_NOT_APPROVED', readyToContactProvider: false,
      requirements: ['SEPARATE_RECORDED_AUTHORIZATION', 'ACTUAL_ACCOUNT_AND_CREDENTIAL_PROVENANCE', 'HOST_SECURITY_SUPERVISION_STATE_REPORT_REVIEW', 'MANAGED_BUDGET_ALLOCATION_EXTERNAL_TRAFFIC_UNKNOWN'] })); return 0;
  }
  if ((action === 'run-provider' && !provider) || (action === 'run-loopback' && provider)) throw new Error('CAMPAIGN_TARGET_MODE_MISMATCH');
  // Authorization is checked BEFORE environment lookup, state initialization, coordinator startup or client construction.
  const authorization = provider ? read(fields.get('--authorization')) : undefined;
  if (provider) requireRecordedAuthorization(input, authorization, Date.now());
  else if (fields.has('--authorization')) throw new Error('LOOPBACK_CANNOT_USE_PROVIDER_AUTHORIZATION');
  if (action === 'initialize-campaign' ? fields.get('--confirm') !== 'NEW_READ_ONLY_CAMPAIGN' : fields.has('--confirm')) throw new Error('CAMPAIGN_INITIALIZATION_CONFIRMATION_INVALID');
  if (action !== 'initialize-campaign' && (!process.stdin.readable || process.stdin.isTTY)) throw new Error('EXPLICIT_SUPERVISOR_STDIN_REQUIRED');
  const secrets = loadCampaignSecrets(await environment());
  if (!provider && (!secrets.credentials.apiKey.startsWith('OFFLINE-') || !secrets.credentials.apiSecret.startsWith('OFFLINE-'))) throw new Error('SYNTHETIC_LOOPBACK_CREDENTIALS_REQUIRED');
  if (action === 'initialize-campaign') {
    initializeCampaignHost(cfg, secrets.keys, 'NEW_READ_ONLY_CAMPAIGN');
    console.log(JSON.stringify({ outcome: 'CAMPAIGN_NAMESPACE_INITIALIZED', target: input.target.kind, readyToContactProvider: false })); return 0;
  }
  const host = await startCampaignHost(cfg, secrets.keys);
  const supervisor = readline.createInterface({ input: process.stdin, terminal: false });
  const stop = () => { void host.stop(); };
  supervisor.on('line', line => { try { if (line === 'HEARTBEAT') host.heartbeat(); else stop(); } catch { stop(); } });
  supervisor.on('close', stop); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const print = (value: unknown) => console.log(JSON.stringify(redactCampaignOutput(value, Object.values(secrets.credentials).concat(Object.values(secrets.keys)))));
  let exit = 1;
  try {
    print({ outcome: 'SUPERVISED_CAMPAIGN_READY', target: input.target.kind, provenance: host.provenance, authorizationRecordValidated: provider });
    const result = await host.runCampaign(input, authorization, secrets.credentials);
    print({ outcome: 'READ_ONLY_COLLECTION_ENDED', target: input.target.kind, status: result.report.status, stopReason: result.report.stopReason,
      delivery: result.delivery, grants: result.report.grants });
    exit = result.delivery === 'WRITTEN' ? 0 : 1;
  } finally {
    const shutdown = await host.close(); print(shutdown);
    if (shutdown.delivery !== 'WRITTEN' || shutdown.unresolved.length) exit = 1;
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); supervisor.removeListener('close', stop); supervisor.close(); process.stdin.destroy();
  }
  return exit;
}
