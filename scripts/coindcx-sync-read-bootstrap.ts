/** Explicit OFFLINE host invocation. Stdin is a supervisor channel; read-client IPC cannot use it. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { initializeCampaignHost, startCampaignHost } from './sync-read-launch/campaign-host';
import { inspectLaunchProposal } from './sync-read-launch/proposal';
import type { CampaignKeys } from './sync-read-launch/campaign-access';
import { campaignEntry } from './sync-read-launch/campaign-entry';

async function main(): Promise<number> {
  if (['prepare', 'initialize-campaign', 'run-provider', 'run-loopback'].includes(process.argv[2] ?? '')) return campaignEntry(process.argv.slice(2));
  const [action, option, file, ...rest] = process.argv.slice(2);
  if (!['initialize', 'run'].includes(action ?? '') || option !== '--offline-input' || !file) throw new Error('EXPLICIT_OFFLINE_BOOTSTRAP_INVOCATION_REQUIRED');
  const workspace = path.resolve(__dirname, '..'), inputPath = path.resolve(file), relative = path.relative(path.join(workspace, '.local'), inputPath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !inputPath.endsWith('.json')) throw new Error('TASK_OWNED_OFFLINE_INPUT_REQUIRED');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as {
    kind?: string; host: unknown; capabilityKeys: CampaignKeys; proposal: unknown; connection: { origin: string; apiKey: string; apiSecret: string };
  };
  if ((input.host as { networkAccess?: unknown }).networkAccess !== 'LOOPBACK_ONLY') throw new Error('OFFLINE_HOST_TARGET_REQUIRED');
  if (input.kind !== 'SYNTHETIC_LOOPBACK_BOOTSTRAP_INPUT' || !input.connection.apiKey.startsWith('OFFLINE-') || !input.connection.apiSecret.startsWith('OFFLINE-')) throw new Error('SYNTHETIC_INPUT_REQUIRED');
  const stateDirectory = (input.host as { coordinator?: { stateDirectory?: unknown } }).coordinator?.stateDirectory;
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)) throw new Error('TASK_OWNED_CAMPAIGN_NAMESPACE_REQUIRED');
  const stateRelative = path.relative(path.join(workspace, '.local'), path.resolve(stateDirectory));
  if (!stateRelative || stateRelative.startsWith('..') || path.isAbsolute(stateRelative)) throw new Error('TASK_OWNED_CAMPAIGN_NAMESPACE_REQUIRED');
  const inspected = inspectLaunchProposal(input.proposal);
  if (!inspected.parametersValid || !inspected.proposal || !inspected.proposal.configuration.account.accountId?.startsWith('OFFLINE-')) throw new Error('SYNTHETIC_PROPOSAL_REQUIRED');
  if (action === 'initialize') {
    if (rest.length !== 2 || rest[0] !== '--confirm' || rest[1] !== 'NEW_READ_ONLY_CAMPAIGN') throw new Error('DELIBERATE_INITIALIZATION_REQUIRED');
    initializeCampaignHost(input.host, input.capabilityKeys, 'NEW_READ_ONLY_CAMPAIGN');
    console.log(JSON.stringify({ outcome: 'OFFLINE_CAMPAIGN_INITIALIZED', valuesStatus: 'PROPOSED_NOT_APPROVED', readyToContactProvider: false })); return 0;
  }
  if (rest.length || !process.stdin.readable || process.stdin.isTTY) throw new Error('EXPLICIT_SUPERVISOR_STDIN_REQUIRED');
  const host = await startCampaignHost(input.host, input.capabilityKeys);
  const supervisor = readline.createInterface({ input: process.stdin, terminal: false });
  const stop = () => { void host.stop(); };
  supervisor.on('line', line => {
    try {
      if (line === 'HEARTBEAT') host.heartbeat(); else if (line === 'STOP') stop(); else stop();
    } catch { stop(); }
  });
  supervisor.on('close', stop); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  console.log(JSON.stringify({ outcome: 'OFFLINE_SUPERVISED_HOST_READY', provenance: host.provenance, readyToContactProvider: false }));
  let exit = 1;
  try {
    const proposal = { ...inspected.proposal, configuration: { ...inspected.proposal.configuration,
      budget: { ...inspected.proposal.configuration.budget, connectionId: host.provenance.connectionId } } };
    const result = await host.run(proposal, input.connection);
    console.log(JSON.stringify({ outcome: 'OFFLINE_COLLECTION_ENDED', status: result.report.status, stopReason: result.report.stopReason,
      delivery: result.delivery, grants: result.report.grants, readyToContactProvider: false }));
    exit = result.delivery === 'WRITTEN' ? 0 : 1;
  } finally {
    const shutdown = await host.close(); console.log(JSON.stringify(shutdown));
    if (shutdown.delivery !== 'WRITTEN' || shutdown.unresolved.length > 0) exit = 1;
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); supervisor.removeListener('close', stop); supervisor.close();
    process.stdin.destroy(); // This invocation owns the supervisor pipe; do not keep it alive after shutdown.
  }
  return exit;
}
if (require.main === module) main().then(code => { process.exitCode = code; }, () => { console.error('OFFLINE_BOOTSTRAP_REFUSED_OR_FAILED'); process.exitCode = 1; });
