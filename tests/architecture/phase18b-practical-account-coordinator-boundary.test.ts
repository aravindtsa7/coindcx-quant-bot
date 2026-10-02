import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImportGraph, computeReachable } from './support/import-graph';

const ROOT = path.resolve(__dirname, '../..');
const OWNER = 'src/integration/coindcx/live/practical-account-coordinator.ts';
const { graph, files } = buildImportGraph(path.join(ROOT, 'src'), ROOT);
const source = readFileSync(path.join(ROOT, OWNER), 'utf8').replace(/\r\n/g, '\n');
describe('unwired single-account coordinator boundary', () => {
  it('has zero production incoming edges, including operational roots and barrels', () => {
    for (const file of files) {
      if (file === OWNER) continue;
      expect(graph.get(file) ?? [], file).not.toContain(OWNER);
      expect(computeReachable(graph, file), file).not.toContain(OWNER);
    }
  });
  it('constructs genuine owned repositories, sources and original issuer authorities only', () => {
    for (const binding of ['createOwnedPracticalSafetyRepository', 'createOwnedPracticalCancelMutationStore',
      'createOwnedLiveReconciliationRepository', 'createOwnedLiveExecutionRepository', 'createOwnedPracticalRecoveryService',
      'createOwnedLiveReconciliationService', 'createCoinDcxPracticalCredentialSources', 'checkCoinDcxCredentialScope']) {
      expect(source).toContain(binding);
    }
    expect(source).toContain('issuer !== ISSUER || new.target !== CoinDcxPracticalAccountCoordinator');
    expect(source).toContain('owners.set(association, coordinator)');
    for (const forbidden of ['issuePracticalRecoveryCertificate', 'issueCurrentReconciliation', 'releaseOrphan',
      'consumeCancelDispatchWithinCallerFencedTransaction', 'issuePracticalCancelOutcome', 'setProviderConfirmation',
      'fixtureReady', 'PROVEN_READY: true', 'process.env', 'listen(']) expect(source).not.toContain(forbidden);
  });
  it('retains one original budget and guards every shutdown effect before scheduling it', () => {
    expect(source).toContain('const STARTUP_BUDGET_MS = 300_000;');
    expect(source).toContain('const SHUTDOWN_BUDGET_MS = 30_000;');
    expect(source).toContain("if (!this.#shutdownSchedulingAllowed()) { record.state = 'UNSCHEDULED'; throw NO_SHUTDOWN_SCHEDULE; }");
    for (const phase of ['STARTUP_SETTLEMENT', 'CANCEL_SETTLEMENT', 'BOOKKEEPING_SETTLEMENT', 'CANCEL_DRAIN',
      'OBSERVER_SETTLEMENT', 'RECOVERY_SETTLEMENT', 'STOP_WATCH', 'FINAL_SETTLEMENT', 'UNSUBSCRIBE', 'STOP_STREAM']) {
      expect(source).toContain(`this.#shutdownStep('${phase}'`);
    }
    expect(source).toContain('observeDrainWithoutRetry()');
    expect(source).toContain('snapshotDrainWithoutRetry()');
    expect(source).not.toContain('this.#owned.cancel.drain(');
    expect(source).toContain("practicalPrivateStreamReadiness(this.#owned.sources.privateStream.getHealthSnapshot()).kind !== 'PROVEN_READY'");
    expect(source).toContain('PracticalRecoveryService.checkOriginalCertificateWatch');
  });
});
