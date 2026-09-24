/**
 * READ-ONLY CoinDCX provider capability probe (observation, never authorization).
 *
 * Usage (explicit opt-in required):
 *   COINDCX_READONLY_PROVIDER_PROBE=true npm run probe:coindcx:readonly
 *
 * Reads only the allowlisted authenticated endpoints and observes the private
 * account socket; it never places, cancels, edits, exits, or closes anything,
 * and never prints or writes credentials. Sanitized artifacts go to the
 * git-ignored `.local/provider-probe/<timestamp>/`.
 */
import 'dotenv/config';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { HmacSha256Signer } from '../src/integration/coindcx/signer';
import { ProbeReadClient, RecordingSigner, createPhase2ReadExecutor } from './provider-probe/rest-probe';
import { DEFAULT_PROBE_TIMING, renderArtifacts, runProviderProbe, writeArtifacts } from './provider-probe/run';
import { SecretRegistry } from './provider-probe/sanitize';
import { productionProbeSocketFactory } from './provider-probe/ws-probe';

const REPO_ROOT = path.resolve(__dirname, '..');

async function main(): Promise<number> {
  if (process.env['COINDCX_READONLY_PROVIDER_PROBE'] !== 'true') {
    console.error('Refusing to run: set COINDCX_READONLY_PROVIDER_PROBE=true to opt in to the read-only provider probe.');
    return 2;
  }
  const apiKey = process.env['COINDCX_API_KEY']?.trim() ?? '';
  const apiSecret = process.env['COINDCX_API_SECRET']?.trim() ?? '';
  if (apiKey === '' || apiSecret === '') {
    console.error('Refusing to run: COINDCX_API_KEY and COINDCX_API_SECRET must both be set (values are never printed).');
    return 2;
  }

  const registry = new SecretRegistry();
  registry.addSecret('api-key', apiKey);
  registry.addSecret('api-secret', apiSecret);
  const log = (line: string) => console.log(registry.redact(line));

  log('================================================================');
  log('  READ-ONLY PROVIDER PROBE');
  log('  NO TRADING MUTATIONS ARE PERMITTED');
  log('  (allowlisted reads + private-socket observation only)');
  log('================================================================');

  try {
    return await probe(apiKey, apiSecret, registry, log);
  } catch (error) {
    console.error(`[probe] aborted: ${registry.redact(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
}

async function probe(apiKey: string, apiSecret: string, registry: SecretRegistry, log: (line: string) => void): Promise<number> {
  const signer = new RecordingSigner(new HmacSha256Signer(apiSecret), registry);
  const result = await runProviderProbe({
    client: new ProbeReadClient(createPhase2ReadExecutor(apiKey, apiSecret, registry)),
    socketFactory: productionProbeSocketFactory,
    signer,
    apiKey,
    registry,
    log,
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timing: DEFAULT_PROBE_TIMING,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(REPO_ROOT, '.local', 'provider-probe', stamp);
  const written = writeArtifacts(REPO_ROOT, directory, renderArtifacts(result), registry);
  log(`[probe] identity: ${result.summary.identity}; replay: ${result.summary.replay}`);
  log(`[probe] REST: ${result.summary.restRequests.ok}/${result.summary.restRequests.total} ok`);
  for (const primitive of result.summary.primitives) log(`[probe] ${primitive.classification.padEnd(12)} ${primitive.primitive}`);
  log(`[probe] artifacts: ${written.map((file) => path.relative(REPO_ROOT, file)).join(', ')}`);
  log(result.summary.providerGuarantee);
  log(result.summary.continuityDisclaimer);
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    console.error(`[probe] aborted: ${error instanceof Error ? error.name : 'UnknownError'}`);
    process.exitCode = 1;
  },
);
