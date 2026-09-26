import { describe, expect, it } from 'vitest';
import {
  classifyPracticalShadowEvaluation,
  classifyRestStability,
  decidePaperSafety,
  evaluateAuthorityEligibility,
  practicalPaperDecisionId,
  practicalPaperIntent,
} from '../../../../../src/execution/live/practical-shadow/classification';
import { collectPracticalShadowEvidence, type PracticalShadowTierBStatus } from '../../../../../src/execution/live/practical-shadow/collector';
import { PRACTICAL_AUTHORITY_BLOCKERS } from '../../../../../src/execution/live/practical-shadow/types';
import {
  ACCOUNT,
  EPOCH,
  EPOCH_B,
  FINGERPRINT,
  TIER_B_DISABLED,
  TIER_B_ELIGIBLE,
  advancePhase18,
  order,
  position,
  shadowWorld,
  type ShadowWorld,
} from './support';

async function collect(world: ShadowWorld, options: { readonly baseline?: number | null; readonly tierB?: PracticalShadowTierBStatus } = {}) {
  return collectPracticalShadowEvidence({
    sources: world.sources,
    config: world.config,
    accountId: ACCOUNT,
    expectedProviderAccountFingerprint: FINGERPRINT,
    runtimeEpoch: EPOCH,
    campaignId: 'campaign-1',
    evaluationId: 'evaluation-1',
    tierB: options.tierB ?? TIER_B_ELIGIBLE,
    generationBaselineFor: () => (options.baseline === undefined ? 0 : options.baseline),
  });
}

/** A world in which EVERY authority prerequisite holds (a deterministic PROVEN_READY test stream). */
async function eligibleWorld(): Promise<ShadowWorld> {
  const world = await shadowWorld({ provenReady: true });
  advancePhase18(world);
  return world;
}

describe('the REAL CoinDCX condition: REST stable, stream UNPROVEN, authority NOT eligible (expected, useful calibration data)', () => {
  it('REST PASS + UNPROVEN readiness -> authorityEligible false, primary blocker PRIVATE_STREAM_READINESS_UNPROVEN; the REST measurements are kept', async () => {
    const world = await shadowWorld();
    advancePhase18(world);
    const evidence = await collect(world);
    expect(evidence.readiness.atStart).toMatchObject({ readiness: 'UNPROVEN', unprovenReason: 'NO_PROVIDER_CONFIRMATION', incarnation: 1 });
    expect(evidence.reads).toHaveLength(21);
    const rest = classifyRestStability(evidence);
    expect(rest).toMatchObject({ concept: 'REST_STABILITY_CANDIDATE', result: 'PASS', failure: null, grantsAuthority: false });
    const authority = evaluateAuthorityEligibility(evidence, rest);
    expect(authority).toMatchObject({ concept: 'AUTHORITY_ELIGIBILITY', authorityEligible: false, primaryBlocker: 'PRIVATE_STREAM_READINESS_UNPROVEN', grantsAuthority: false });
    // UNPROVEN is recorded exactly and never upgraded, however stable the REST evidence is.
    expect(authority.blockers).toEqual(['PRIVATE_STREAM_READINESS_UNPROVEN']);
  });

  it('shadow collection never writes practical authority state (loadAccount only)', async () => {
    const world = await shadowWorld();
    await collect(world);
    expect(world.practical.operations.filter((op) => op !== 'loadAccount')).toEqual(['initializeAccount']);
    expect(world.practical.certificate).toBeNull();
  });
});

describe('B. authority eligibility: all prerequisites, or a blocker', () => {
  it('a deterministic PROVEN_READY stream with every prerequisite -> eligible (hypothetically), no blockers; still not authority', async () => {
    const world = await eligibleWorld();
    const evidence = await collect(world);
    const classification = classifyPracticalShadowEvaluation(evidence, world.config.paperIntents);
    expect(classification.rest.result).toBe('PASS');
    expect(classification.authority).toMatchObject({ authorityEligible: true, blockers: [], primaryBlocker: null, grantsAuthority: false });
  });

  it.each([
    ['RECONCILIATION_REQUIRED at start', async (w: ShadowWorld) => { w.stream.health = { ...w.stream.health, state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true }; }, 'PRIVATE_STREAM_RECONCILIATION_REQUIRED'],
    ['DISCONNECTED at start', async (w: ShadowWorld) => { w.stream.health = { ...w.stream.health, connected: false }; }, 'PRIVATE_STREAM_DISCONNECTED'],
    ['a reconnect mid-window', async (w: ShadowWorld) => { w.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 4) w.stream.reconnect(); }; }, 'PRIVATE_STREAM_INCARNATION_CHANGED'],
    ['readiness lost mid-window', async (w: ShadowWorld) => { w.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 4) w.stream.unprove(); }; }, 'PRIVATE_STREAM_READINESS_LOST'],
    ['a private state event mid-window', async (w: ShadowWorld) => { w.venue.onCall = (kind, index) => { if (kind === 'POSITIONS' && index === 2) w.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION'); }; }, 'PRIVATE_STREAM_EVENT_DURING_WINDOW'],
    ['an unstable REST bracket', async (w: ShadowWorld) => { w.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 1) w.venue.orders = [order('ord-1'), order('ord-2')]; }; }, 'REST_STABILITY_NOT_PASSED'],
    ['Phase 18 unreadable', async (w: ShadowWorld) => { w.reconciliation.fail = true; }, 'PHASE18_STATE_UNAVAILABLE'],
    ['a Phase 18 row of another account', async (w: ShadowWorld) => { w.reconciliation.transform = (state) => ({ ...state, accountId: 'account-live-2' }); }, 'PHASE18_STATE_UNAVAILABLE'],
    ['Phase 18 not HEALTHY', async (w: ShadowWorld) => { w.reconciliation.state = { ...w.reconciliation.state, status: 'UNHEALTHY' }; }, 'PHASE18_NOT_HEALTHY'],
    ['Phase 18 of another runtime', async (w: ShadowWorld) => { w.reconciliation.completeHealthyRun(EPOCH_B); }, 'PHASE18_OTHER_RUNTIME'],
    ['the Phase 18 generation changing mid-window', async (w: ShadowWorld) => { w.venue.onCall = (kind, index) => { if (kind === 'IDENTITY' && index === 2) w.reconciliation.completeHealthyRun(EPOCH); }; }, 'PHASE18_GENERATION_CHANGED'],
    ['the practical account unreadable (MALFORMED)', async (w: ShadowWorld) => { w.practical.malformed = true; }, 'PRACTICAL_ACCOUNT_UNREADABLE'],
    ['the practical account not QUARANTINED/IDLE', async (w: ShadowWorld) => { w.practical.state = 'CERTIFYING'; }, 'PRACTICAL_ACCOUNT_NOT_QUARANTINED_IDLE'],
    ['a fence of another runtime', async (w: ShadowWorld) => { w.practical.fence = { ...w.practical.fence!, runtimeEpoch: EPOCH_B }; }, 'PRACTICAL_FENCE_OTHER_RUNTIME'],
    ['a generation not newer than the fence', async (w: ShadowWorld) => { w.practical.fence = { ...w.practical.fence!, reconciliationGeneration: 7 }; }, 'PHASE18_GENERATION_NOT_NEWER_THAN_FENCE'],
  ])('%s -> not eligible (%s)', async (_label, arrange, blocker) => {
    const world = await eligibleWorld();
    await arrange(world);
    const evidence = await collect(world);
    const authority = evaluateAuthorityEligibility(evidence, classifyRestStability(evidence));
    expect(authority.authorityEligible).toBe(false);
    expect(authority.blockers).toContain(blocker);
    expect(authority.primaryBlocker).toBe(authority.blockers[0]);
  });

  it('no stream baseline yet, or no generation after it -> PHASE18_GENERATION_NOT_AFTER_STREAM_OBSERVATION', async () => {
    for (const baseline of [null, 1, 2]) {
      const world = await eligibleWorld();
      const evidence = await collect(world, { baseline });
      expect(evaluateAuthorityEligibility(evidence, classifyRestStability(evidence)).blockers).toContain('PHASE18_GENERATION_NOT_AFTER_STREAM_OBSERVATION');
    }
  });

  it('Tier B not enabled for the account -> TIER_B_NOT_ENABLED_FOR_ACCOUNT', async () => {
    const world = await eligibleWorld();
    const evidence = await collect(world, { tierB: TIER_B_DISABLED });
    expect(evaluateAuthorityEligibility(evidence, classifyRestStability(evidence)).blockers).toEqual(['TIER_B_NOT_ENABLED_FOR_ACCOUNT']);
  });

  it('blockers are always reported in the canonical order', async () => {
    const world = await shadowWorld({ initialize: false });
    world.reconciliation.fail = true;
    const evidence = await collect(world, { baseline: null, tierB: TIER_B_DISABLED });
    const blockers = evaluateAuthorityEligibility(evidence, classifyRestStability(evidence)).blockers;
    expect(blockers).toEqual(PRACTICAL_AUTHORITY_BLOCKERS.filter((blocker) => blockers.includes(blocker)));
    expect(blockers[0]).toBe('PRIVATE_STREAM_READINESS_UNPROVEN');
  });
});

describe('A. the REST stability candidate uses the EXACT Checkpoint B bracket semantics (calibration only)', () => {
  it.each([
    ['O1 != O2 in pass 1', async (w: ShadowWorld) => { w.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 1) w.venue.orders = [order('ord-1'), order('ord-2')]; }; }, 'BRACKET_DISAGREEMENT'],
    ['P1 != P2 in pass 1', async (w: ShadowWorld) => { w.venue.onCall = (kind, index) => { if (kind === 'POSITIONS' && index === 1) w.venue.positions = [position('pos-1', { signedQuantity: '1' })]; }; }, 'BRACKET_DISAGREEMENT'],
    ['a change between passes', async (w: ShadowWorld) => { w.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 3) w.venue.orders = [order('ord-1'), order('ord-2')]; }; }, 'OBSERVATION_DISAGREEMENT'],
    ['incomplete pagination', async (w: ShadowWorld) => {
      w.venue.behavior = (kind, index) => (kind === 'ORDERS' && index === 3
        ? { kind: 'VALUE', value: { orders: [order('ord-1')], provenance: { source: 'COINDCX_FUTURES_ORDERS', localReadStartedAtMs: 1, localReadEndedAtMs: 2, complete: false, pagesRead: 100, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' } } }
        : undefined);
    }, 'PAGINATION_INCOMPLETE'],
    ['a hung read (hard timeout)', async (w: ShadowWorld) => { w.venue.behavior = (kind, index) => (kind === 'POSITIONS' && index === 0 ? { kind: 'HANG' } : undefined); }, 'READ_HARD_TIMEOUT'],
    ['provider unavailable', async (w: ShadowWorld) => { w.venue.behavior = (kind, index) => (kind === 'ORDERS' && index === 2 ? { kind: 'THROW' } : undefined); }, 'PROVIDER_UNAVAILABLE'],
    ['reads over the HARD pass ceiling', async (w: ShadowWorld) => { w.venue.latencyMs = 10_000; }, 'PASS_HARD_CEILING_EXCEEDED'],
  ])('%s -> FAIL (%s), and later passes are still observed for calibration', async (_label, arrange, failure) => {
    const world = await shadowWorld();
    await arrange(world);
    const evidence = await collect(world);
    expect(classifyRestStability(evidence)).toMatchObject({ result: 'FAIL', failure });
    expect(new Set(evidence.reads.map((read) => read.passIndex))).toEqual(new Set([1, 2, 3]));
  });

  it('reads slower than the CANDIDATE but under the hard ceiling still PASS (candidates are telemetry only)', async () => {
    const world = await shadowWorld();
    world.venue.latencyMs = 5_000;
    const evidence = await collect(world);
    expect(evidence.reads.every((read) => read.latencyMs > world.config.timing.readCandidateMs)).toBe(true);
    expect(classifyRestStability(evidence).result).toBe('PASS');
  });
});

describe('C. paper safety decisions are hypothetical; nothing is executed or authorized', () => {
  it('on the real UNPROVEN stream EVERY paper intent WOULD_BLOCK', async () => {
    const world = await shadowWorld();
    advancePhase18(world);
    const classification = classifyPracticalShadowEvaluation(await collect(world), world.config.paperIntents);
    expect(classification.paperDecisions).toHaveLength(6);
    for (const decision of classification.paperDecisions) {
      expect(decision).toMatchObject({ concept: 'PAPER_DECISION', outcome: 'WOULD_BLOCK', authorityPrerequisitesMet: false, streamReadiness: 'UNPROVEN', grantsAuthority: false });
      expect(decision.blockers).toContain('PRIVATE_STREAM_READINESS_UNPROVEN');
    }
  });

  it('with every prerequisite: only CANCEL at Stage 5a WOULD_REACH_AUTHORITY_GATE; OPEN/CLOSE and Stage 5b are blocked by policy', async () => {
    const world = await eligibleWorld();
    const classification = classifyPracticalShadowEvaluation(await collect(world), world.config.paperIntents);
    const byIntent = Object.fromEntries(classification.paperDecisions.map((decision) => [`${decision.requestedAction}@${decision.rolloutStage}`, decision]));
    expect(byIntent['CANCEL@STAGE_5A_CANCEL_ONLY']).toMatchObject({ outcome: 'WOULD_REACH_AUTHORITY_GATE', blockers: [], authorityPrerequisitesMet: true });
    expect(byIntent['OPEN@STAGE_5A_CANCEL_ONLY']).toMatchObject({ outcome: 'WOULD_BLOCK', blockers: ['OPEN_DISABLED_UNTIL_STAGE_5B'] });
    expect(byIntent['CLOSE@STAGE_5A_CANCEL_ONLY']).toMatchObject({ outcome: 'WOULD_BLOCK', blockers: ['CLOSE_REQUIRES_VERIFIED_REDUCE_ONLY'] });
    expect(byIntent['CANCEL@STAGE_5B_OPEN_CLOSE_FUTURE']).toMatchObject({ outcome: 'WOULD_BLOCK', blockers: ['STAGE_5B_NOT_ENABLED'] });
    expect(byIntent['OPEN@STAGE_5B_OPEN_CLOSE_FUTURE']).toMatchObject({ outcome: 'WOULD_BLOCK', blockers: ['STAGE_5B_NOT_ENABLED', 'OPEN_REQUIRES_RESUME_APPROVAL'] });
    expect(byIntent['CLOSE@STAGE_5B_OPEN_CLOSE_FUTURE']).toMatchObject({
      outcome: 'WOULD_BLOCK',
      blockers: ['STAGE_5B_NOT_ENABLED', 'CLOSE_REQUIRES_VERIFIED_REDUCE_ONLY', 'CLOSE_REDUCE_ONLY_NOT_PROVIDER_CONFIRMED'],
    });
    expect(JSON.stringify(classification.paperDecisions)).not.toMatch(/LIVE_ALLOWED|ALLOWED|AUTHORIZED/);
  });

  it('paper decision ids are deterministic per (evaluation, action, stage) and differ otherwise', async () => {
    const cancel = practicalPaperIntent('CANCEL', 'STAGE_5A_CANCEL_ONLY');
    expect(practicalPaperDecisionId('evaluation-1', cancel)).toBe(practicalPaperDecisionId('evaluation-1', cancel));
    expect(practicalPaperDecisionId('evaluation-1', cancel)).not.toBe(practicalPaperDecisionId('evaluation-2', cancel));
    expect(practicalPaperDecisionId('evaluation-1', cancel)).not.toBe(practicalPaperDecisionId('evaluation-1', practicalPaperIntent('OPEN', 'STAGE_5A_CANCEL_ONLY')));
    expect(practicalPaperDecisionId('evaluation-1', cancel)).toMatch(/^pd-[0-9a-f]{48}$/);
  });

  it('a paper decision on a FAILED REST candidate is always blocked', async () => {
    const world = await eligibleWorld();
    world.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 1) world.venue.orders = [order('ord-1'), order('ord-2')]; };
    const evidence = await collect(world);
    const rest = classifyRestStability(evidence);
    const decision = decidePaperSafety(evidence, rest, evaluateAuthorityEligibility(evidence, rest), practicalPaperIntent('CANCEL', 'STAGE_5A_CANCEL_ONLY'));
    expect(decision).toMatchObject({ outcome: 'WOULD_BLOCK', restStability: 'FAIL', authorityPrerequisitesMet: false });
    expect(decision.blockers).toContain('REST_STABILITY_NOT_PASSED');
  });
});

describe('sensitive data never enters the evidence', () => {
  it('only digests, counts, codes, and timings: no order ids, no raw account identity, no credentials', async () => {
    const world = await shadowWorld();
    world.venue.orders = [order('ORDER-SECRET-ID-123'), order('ORDER-SECRET-ID-456')];
    world.venue.positions = [position('POSITION-SECRET-ID-9')];
    const evidence = await collect(world);
    const json = JSON.stringify(evidence);
    expect(json).not.toContain('ORDER-SECRET-ID');
    expect(json).not.toContain('POSITION-SECRET-ID');
    expect(json).not.toContain('fake-coindcx-trading-account');
    expect(json).not.toMatch(/apiKey|apiSecret|signature|authorization/i);
    for (const read of evidence.reads) if (read.contentDigest !== null) expect(read.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
