import { describe, expect, it } from 'vitest';
import { PracticalShadowCampaignRunner, abortPracticalShadowCampaign } from '../../../../../src/execution/live/practical-shadow/campaign';
import {
  practicalShadowSourceRefusal,
  resolvePracticalShadowSourceProvenance,
  type PracticalShadowSourceProvenance,
} from '../../../../../src/execution/live/practical-shadow/provenance';
import { replayPracticalShadowSnapshot } from '../../../../../src/execution/live/practical-shadow/replay';
import { FakeScheduler } from '../practical-recovery/support';
import {
  ACCOUNT,
  COMMIT_A,
  COMMIT_B,
  DIRTY_SOURCE,
  EPOCH,
  FINGERPRINT,
  MemoryPracticalShadowStore,
  TIER_B_ELIGIBLE,
  UNAVAILABLE_SOURCE,
  advancePhase18,
  cleanSource,
  shadowConfig,
  shadowWorld,
  type ShadowWorld,
} from './support';

function runner(world: ShadowWorld, store: MemoryPracticalShadowStore, options: { readonly workerId?: string; readonly source?: PracticalShadowSourceProvenance; readonly cadenceMs?: number; readonly ownScheduler?: boolean } = {}) {
  let ids = 0;
  const workerId = options.workerId ?? 'worker-a';
  return new PracticalShadowCampaignRunner({
    store,
    sources: options.ownScheduler === true ? { ...world.sources, scheduler: new FakeScheduler(world.clock) } : world.sources,
    config: options.cadenceMs === undefined ? world.config : shadowConfig({ cadenceMs: options.cadenceMs }),
    accountId: ACCOUNT,
    expectedProviderAccountFingerprint: FINGERPRINT,
    runtimeEpoch: EPOCH,
    sourceProvenance: options.source ?? cleanSource(),
    tierB: TIER_B_ELIGIBLE,
    workerId,
    newId: () => `${workerId}-${++ids}`,
  });
}

describe('P18B-C-01 source provenance: only an exact CLEAN commit is accepted (no dirty/development mode)', () => {
  it.each([
    ['a clean tree at an exact commit', { head: `${COMMIT_A}\n`, status: '' }, { state: 'CLEAN', kind: 'GIT_CLEAN_COMMIT', commit: COMMIT_A }],
    ['a clean tree (whitespace-only status)', { head: COMMIT_A, status: '\n' }, { state: 'CLEAN', kind: 'GIT_CLEAN_COMMIT', commit: COMMIT_A }],
    ['a modified tracked file', { head: COMMIT_A, status: ' M src/index.ts\n' }, { state: 'DIRTY', changedEntries: 1 }],
    ['an untracked file only', { head: COMMIT_A, status: '?? scratch.ts\n' }, { state: 'DIRTY', changedEntries: 1 }],
    ['staged and untracked changes', { head: COMMIT_A, status: 'A  new.ts\n?? other.ts\n' }, { state: 'DIRTY', changedEntries: 2 }],
    ['git unavailable', { head: null, status: null }, { state: 'UNAVAILABLE' }],
    ['a failed status probe', { head: COMMIT_A, status: null }, { state: 'UNAVAILABLE' }],
    ['a failed HEAD probe on a dirty tree', { head: null, status: ' M src/index.ts\n' }, { state: 'UNAVAILABLE' }],
    ['a symbolic HEAD', { head: 'HEAD', status: '' }, { state: 'UNAVAILABLE' }],
    ['an abbreviated commit', { head: COMMIT_A.slice(0, 12), status: '' }, { state: 'UNAVAILABLE' }],
    ['an upper-case commit', { head: COMMIT_A.toUpperCase(), status: '' }, { state: 'UNAVAILABLE' }],
    ['a placeholder version', { head: 'unknown-software-version', status: '' }, { state: 'UNAVAILABLE' }],
  ])('%s', (_label, probe, expected) => {
    const provenance = resolvePracticalShadowSourceProvenance(probe);
    expect(provenance).toEqual(expected);
    // Only the COUNT of changed entries is kept: never a path or content.
    expect(JSON.stringify(provenance)).not.toMatch(/src\/index|scratch|new\.ts|other\.ts/);
  });

  it('no probe at all is UNAVAILABLE; only CLEAN has no refusal', () => {
    expect(resolvePracticalShadowSourceProvenance(null)).toEqual({ state: 'UNAVAILABLE' });
    expect(resolvePracticalShadowSourceProvenance(undefined)).toEqual({ state: 'UNAVAILABLE' });
    expect(practicalShadowSourceRefusal(cleanSource())).toBeNull();
    expect(practicalShadowSourceRefusal(DIRTY_SOURCE)).toBe('SHADOW_SOURCE_DIRTY');
    expect(practicalShadowSourceRefusal(UNAVAILABLE_SOURCE)).toBe('SHADOW_SOURCE_PROVENANCE_UNAVAILABLE');
    // A forged "CLEAN" object without an exact commit is still refused.
    expect(practicalShadowSourceRefusal({ state: 'CLEAN', kind: 'GIT_CLEAN_COMMIT', commit: 'software-1' })).toBe('SHADOW_SOURCE_PROVENANCE_UNAVAILABLE');
  });

  it('1. a clean exact commit starts a campaign bound to that commit', async () => {
    const world = await shadowWorld();
    const store = new MemoryPracticalShadowStore();
    expect(await runner(world, store).open('START_NEW')).toMatchObject({
      kind: 'STARTED', campaign: { softwareVersion: COMMIT_A, sourceProvenance: 'GIT_CLEAN_COMMIT', status: 'ACTIVE' },
    });
  });

  it.each([
    ['2. a dirty source tree', DIRTY_SOURCE, 'SHADOW_SOURCE_DIRTY'],
    ['3. unavailable provenance', UNAVAILABLE_SOURCE, 'SHADOW_SOURCE_PROVENANCE_UNAVAILABLE'],
  ])('%s creates NO campaign (every open mode), before touching the store', async (_label, source, reason) => {
    const world = await shadowWorld();
    const store = new MemoryPracticalShadowStore();
    for (const mode of ['START_NEW', 'RESUME', 'RESUME_OR_START'] as const) {
      expect(await runner(world, store, { source }).open(mode)).toEqual({ kind: 'REFUSED', reason, detail: [] });
    }
    expect(store.campaigns.size).toBe(0);
    expect(store.activeByAccount.size).toBe(0);
  });

  it('a forged "CLEAN" provenance without an exact commit is refused by the runner itself (no campaign, no store error)', async () => {
    const world = await shadowWorld();
    const store = new MemoryPracticalShadowStore();
    for (const commit of ['software-1', COMMIT_A.toUpperCase(), '']) {
      const forged = { state: 'CLEAN', kind: 'GIT_CLEAN_COMMIT', commit } as const;
      expect(await runner(world, store, { source: forged }).open('RESUME_OR_START')).toEqual({ kind: 'REFUSED', reason: 'SHADOW_SOURCE_PROVENANCE_UNAVAILABLE', detail: [] });
    }
    expect(store.campaigns.size).toBe(0);
  });

  it('4/5. resume requires the SAME clean commit; another commit, a dirty tree, or unknown provenance cannot resume (and changes nothing)', async () => {
    const world = await shadowWorld();
    const store = new MemoryPracticalShadowStore();
    const a = runner(world, store);
    await a.open('START_NEW');
    const before = JSON.stringify([...store.campaigns.values()]);
    expect(await runner(world, store, { workerId: 'worker-b', source: cleanSource(COMMIT_B) }).open('RESUME')).toMatchObject({ kind: 'REFUSED', reason: 'BINDING_MISMATCH', detail: ['softwareVersion'] });
    expect(await runner(world, store, { workerId: 'worker-c', source: DIRTY_SOURCE }).open('RESUME')).toMatchObject({ kind: 'REFUSED', reason: 'SHADOW_SOURCE_DIRTY' });
    expect(await runner(world, store, { workerId: 'worker-d', source: UNAVAILABLE_SOURCE }).open('RESUME_OR_START')).toMatchObject({ kind: 'REFUSED', reason: 'SHADOW_SOURCE_PROVENANCE_UNAVAILABLE' });
    expect(JSON.stringify([...store.campaigns.values()])).toBe(before);
    expect(await runner(world, store, { workerId: 'worker-e', source: cleanSource(COMMIT_A) }).open('RESUME')).toMatchObject({ kind: 'RESUMED', campaign: { workerId: 'worker-e', softwareVersion: COMMIT_A } });
  });

  it('the store itself refuses a binding without a trusted clean commit (defence in depth)', async () => {
    const store = new MemoryPracticalShadowStore();
    const binding = { accountId: ACCOUNT, providerAccountFingerprint: FINGERPRINT, softwareVersion: 'software-1', sourceProvenance: 'GIT_CLEAN_COMMIT' as const, configDigest: 'd'.repeat(64), evidenceSchemaVersion: 'P18B_SHADOW_EVIDENCE_V1' };
    await expect(store.startCampaign({ campaignId: 'campaign-x', binding, configJson: '{}', workerId: 'worker-a', nowMs: 1 })).rejects.toThrow(/SHADOW_SOURCE_PROVENANCE_UNAVAILABLE/);
    await expect(store.startCampaign({ campaignId: 'campaign-x', binding: { ...binding, softwareVersion: COMMIT_A, sourceProvenance: 'GIT_DIRTY_TREE' as never }, configJson: '{}', workerId: 'worker-a', nowMs: 1 })).rejects.toThrow(/SHADOW_SOURCE_PROVENANCE_UNAVAILABLE/);
    expect(store.campaigns.size).toBe(0);
  });

  it('6. replay and the report expose the persisted provenance', async () => {
    const world = await shadowWorld();
    const store = new MemoryPracticalShadowStore();
    const a = runner(world, store);
    await a.open('START_NEW');
    advancePhase18(world);
    await a.runEvaluation();
    const replay = replayPracticalShadowSnapshot((await store.snapshotCampaign(a.campaign!.campaignId))!);
    const expected = { sourceProvenance: 'GIT_CLEAN_COMMIT', softwareVersion: COMMIT_A, trustedCleanCommit: true };
    expect(replay.provenance).toEqual(expected);
    expect(replay.report.provenance).toEqual(expected);
  });
});

describe('P18B-C-02 explicit operator abort (shadow only; exact account + campaign id)', () => {
  async function activeWithClaim() {
    const world = await shadowWorld();
    const store = new MemoryPracticalShadowStore();
    const a = runner(world, store);
    await a.open('START_NEW');
    advancePhase18(world);
    await a.runEvaluation();
    // An evaluation is in flight (claimed; its collection is held).
    world.scheduler.hold();
    const pending = a.runEvaluation();
    await new Promise((resolve) => setImmediate(resolve));
    return { world, store, a, pending, campaignId: a.campaign!.campaignId };
  }

  it('binding drift: a normal stop is refused, the explicit abort succeeds, CLAIMED -> ABORTED, the pointer is cleared, and the stale completion loses', async () => {
    const { world, store, a, pending, campaignId } = await activeWithClaim();
    const drifted = runner(world, store, { workerId: 'worker-b', cadenceMs: 120_000, ownScheduler: true });
    expect(await drifted.open('RESUME')).toMatchObject({ kind: 'REFUSED', reason: 'BINDING_MISMATCH', detail: ['configDigest'] });
    expect(await drifted.stop('COMPLETED', 'OPERATOR_STOP')).toBe(false);

    const result = await abortPracticalShadowCampaign({ store, accountId: ACCOUNT, campaignId, reason: 'CONFIG_CHANGED', nowMs: world.clock.nowMs() });
    expect(result).toMatchObject({ kind: 'ABORTED', abortedEvaluations: 1, campaign: { status: 'ABORTED', endReason: 'OPERATOR_CAMPAIGN_ABORT:CONFIG_CHANGED' } });
    expect(await store.loadActiveCampaign(ACCOUNT)).toBeNull();
    expect([...store.evaluations.values()].map((row) => [row.status, row.abortReason])).toEqual([['COMPLETED', null], ['ABORTED', 'OPERATOR_CAMPAIGN_ABORT']]);

    world.scheduler.release();
    expect(await pending).toEqual({ kind: 'NOT_COLLECTED', reason: 'CAMPAIGN_NOT_ACTIVE' });
    expect(a.campaign).toBeNull();
    // Nothing touched practical authority state; no paper decision was added by the abort.
    expect(world.practical.operations.filter((op) => op !== 'loadAccount')).toEqual(['initializeAccount']);
    expect(store.paperDecisions.size).toBe(6);
  });

  it('wrong account / unknown campaign are refused; a repeated abort is ALREADY_TERMINAL and changes nothing; a new campaign may then start', async () => {
    const { world, store, campaignId } = await activeWithClaim();
    expect(await abortPracticalShadowCampaign({ store, accountId: 'account-other', campaignId, reason: 'X', nowMs: 1 })).toEqual({ kind: 'REFUSED', reason: 'ACCOUNT_MISMATCH' });
    expect(await abortPracticalShadowCampaign({ store, accountId: ACCOUNT, campaignId: 'campaign-unknown', reason: 'X', nowMs: 1 })).toEqual({ kind: 'REFUSED', reason: 'UNKNOWN_CAMPAIGN' });
    expect((await store.loadActiveCampaign(ACCOUNT))?.status).toBe('ACTIVE');

    await abortPracticalShadowCampaign({ store, accountId: ACCOUNT, campaignId, reason: 'FIRST', nowMs: 5 });
    const terminal = JSON.stringify([[...store.campaigns.values()], [...store.evaluations.values()]]);
    expect(await abortPracticalShadowCampaign({ store, accountId: ACCOUNT, campaignId, reason: 'SECOND', nowMs: 9 })).toMatchObject({ kind: 'ALREADY_TERMINAL', campaign: { status: 'ABORTED', endReason: 'OPERATOR_CAMPAIGN_ABORT:FIRST' } });
    expect(JSON.stringify([[...store.campaigns.values()], [...store.evaluations.values()]])).toBe(terminal);
    // It can never be resumed again.
    expect(await runner(world, store, { workerId: 'worker-c', ownScheduler: true }).open('RESUME')).toMatchObject({ kind: 'REFUSED', reason: 'NO_ACTIVE_CAMPAIGN' });
    const next = runner(world, store, { workerId: 'worker-d', ownScheduler: true });
    expect(await next.open('START_NEW')).toMatchObject({ kind: 'STARTED' });
    expect(next.campaign!.campaignId).not.toBe(campaignId);
    expect(store.campaigns.get(campaignId)!.status).toBe('ABORTED');
  });
});
