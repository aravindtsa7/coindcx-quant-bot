import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../../src/core/time/clock';
import { providerAccountFingerprint } from '../../../../../src/execution/live/reconciliation/account-identity';
import { classifyPracticalShadowEvaluation } from '../../../../../src/execution/live/practical-shadow/classification';
import { collectPracticalShadowEvidence, type PracticalShadowSources } from '../../../../../src/execution/live/practical-shadow/collector';
import { resolvePracticalShadowConfig } from '../../../../../src/execution/live/practical-shadow/config';
import { CoinDcxReconciliationEvidenceAdapter } from '../../../../../src/integration/coindcx/live/reconciliation-evidence-adapter';
import { CoinDcxPrivateAccountStream } from '../../../../../src/integration/coindcx/websocket/private-stream';
import { createTestStreamContext } from '../../../coindcx/ws/test-helpers';
import { FakeReconciliation, FakeScheduler, MemoryPracticalPersistence } from '../practical-recovery/support';
import { TEST_PROVIDER } from './support';
import { ACCOUNT, EPOCH, T0, TIER_B_ELIGIBLE } from './support';

// Checkpoint C reuses the EXISTING read-only CoinDCX adapters unchanged: the
// REST evidence adapter (over a fake read client: no network, no credentials)
// and the real private account stream (over the existing fake socket).

const RAW_PROVIDER_ID = 'raw-coindcx-account-identifier-never-stored';

function realAdapter(clock: FakeClock) {
  const calls: string[] = [];
  const client = {
    getUserInfoSafe: async () => {
      calls.push('getUserInfoSafe');
      return { coindcxId: RAW_PROVIDER_ID };
    },
    listInrFuturesOrders: async () => {
      calls.push('listInrFuturesOrders');
      return [];
    },
    listInrFuturesPositions: async () => {
      calls.push('listInrFuturesPositions');
      return [];
    },
  };
  // Any other method (a create/cancel/close, if one existed) would be undefined here and throw if touched.
  const adapter = new CoinDcxReconciliationEvidenceAdapter({ client: client as never, credentialAccountId: ACCOUNT, clock });
  return { adapter, calls };
}

describe('P18B Checkpoint C: shadow over the REAL read-only CoinDCX adapters', () => {
  it('the real REST adapter supplies every shadow read; the real stream is UNPROVEN and stays UNPROVEN; REST data is still recorded; authority is not eligible', async () => {
    const clock = new FakeClock(T0);
    const { adapter, calls } = realAdapter(clock);
    const ctx = createTestStreamContext();
    const stream = new CoinDcxPrivateAccountStream({ apiKey: 'dummy-key', apiSecret: 'dummy-secret', socketFactory: ctx.socketFactory, clock: ctx.clock, scheduler: ctx.scheduler });
    await stream.start();
    const reconciliation = new FakeReconciliation(ACCOUNT);
    reconciliation.completeHealthyRun(EPOCH);
    const practical = new MemoryPracticalPersistence(ACCOUNT);
    await practical.initializeAccount({ runtimeEpoch: EPOCH, reconciliationGeneration: 0 });
    const sources: PracticalShadowSources = {
      venue: adapter,
      privateStream: stream,
      reconciliation,
      practicalAccount: { loadAccount: () => practical.loadAccount() },
      clock,
      scheduler: new FakeScheduler(clock),
    };
    const config = resolvePracticalShadowConfig({ provider: TEST_PROVIDER, cadenceMs: 60_000 });
    const evidence = await collectPracticalShadowEvidence({
      sources, config, accountId: ACCOUNT, expectedProviderAccountFingerprint: providerAccountFingerprint(RAW_PROVIDER_ID), runtimeEpoch: EPOCH,
      campaignId: 'campaign-1', evaluationId: 'evaluation-1', tierB: TIER_B_ELIGIBLE, generationBaselineFor: () => 0,
    });

    // Real readiness, exactly as the adapter can show it: join sent, no provider confirmation.
    expect(stream.getHealthSnapshot()).toMatchObject({ state: 'AUTH_JOIN_SENT', authJoinSent: true, reconciliationRequired: false });
    expect(evidence.readiness.atStart).toMatchObject({ readiness: 'UNPROVEN', unprovenReason: 'NO_PROVIDER_CONFIRMATION', incarnation: 1 });
    expect(evidence.readiness.samples.every((sample) => sample.readiness === 'UNPROVEN')).toBe(true);
    // Useful REST observations were recorded through the real adapter.
    expect(evidence.reads).toHaveLength(21);
    expect(evidence.reads.every((read) => read.failure === null && read.complete)).toBe(true);
    expect(calls.filter((call) => call === 'getUserInfoSafe')).toHaveLength(6);
    const classification = classifyPracticalShadowEvaluation(evidence, config.paperIntents);
    expect(classification.rest.result).toBe('PASS');
    expect(classification.authority).toMatchObject({ authorityEligible: false, primaryBlocker: 'PRIVATE_STREAM_READINESS_UNPROVEN' });
    expect(classification.paperDecisions.every((decision) => decision.outcome === 'WOULD_BLOCK')).toBe(true);
    // Read-only: only list/get calls; no practical authority write; no raw provider identity in the evidence.
    expect(new Set(calls)).toEqual(new Set(['getUserInfoSafe', 'listInrFuturesOrders', 'listInrFuturesPositions']));
    expect(practical.operations.filter((op) => op !== 'loadAccount')).toEqual(['initializeAccount']);
    expect(practical.certificate).toBeNull();
    expect(JSON.stringify(evidence)).not.toContain(RAW_PROVIDER_ID);
    expect(ctx.socketFactory.latestSocket!.emitted.map((entry) => entry.event).filter((event) => event !== 'join' && event !== 'ping')).toEqual([]);
    stream.stop();
  });
});
