import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../../src/core/time/clock';
import { PracticalRecoveryCertificate } from '../../../../../src/execution/live/practical/certificate';
import { PRACTICAL_TIMING_CANDIDATES } from '../../../../../src/execution/live/practical/policy';
import { practicalDurableFailureFor, PracticalRecoveryService } from '../../../../../src/execution/live/practical-recovery/service';
import { PracticalRecoveryTelemetryBuffer } from '../../../../../src/execution/live/practical-recovery/telemetry';
import { PRACTICAL_RECOVERY_HARD_CEILINGS } from '../../../../../src/execution/live/practical-recovery/timing';
import {
  EPOCH,
  EPOCH_B,
  FINGERPRINT,
  FakePrivateStream,
  FakeReconciliation,
  FakeScheduler,
  FakeVenue,
  MemoryPracticalPersistence,
  OTHER_FINGERPRINT,
  T0,
  enablementFor,
  order,
  position,
} from './support';

const ACCOUNT = 'account-live-1';

interface Harness {
  readonly clock: FakeClock;
  readonly scheduler: FakeScheduler;
  readonly venue: FakeVenue;
  readonly stream: FakePrivateStream;
  readonly reconciliation: FakeReconciliation;
  readonly persistence: MemoryPracticalPersistence;
  readonly telemetry: PracticalRecoveryTelemetryBuffer;
  readonly service: PracticalRecoveryService;
}

function harness(options: { readonly epoch?: string; readonly shared?: Harness; readonly enabledFor?: string; readonly timing?: typeof PRACTICAL_TIMING_CANDIDATES } = {}): Harness {
  const clock = options.shared?.clock ?? new FakeClock(T0);
  const scheduler = new FakeScheduler(clock);
  const venue = options.shared?.venue ?? new FakeVenue(clock);
  const stream = options.shared?.stream ?? new FakePrivateStream();
  const reconciliation = options.shared?.reconciliation ?? new FakeReconciliation(ACCOUNT);
  const persistence = options.shared?.persistence ?? new MemoryPracticalPersistence(ACCOUNT);
  const telemetry = new PracticalRecoveryTelemetryBuffer();
  let runs = 0;
  const epoch = options.epoch ?? EPOCH;
  const service = new PracticalRecoveryService({
    accountId: ACCOUNT,
    runtimeEpoch: epoch,
    expectedProviderAccountFingerprint: FINGERPRINT,
    enablement: enablementFor(options.enabledFor ?? ACCOUNT),
    persistence,
    venue,
    reconciliation,
    privateStream: stream,
    clock,
    scheduler,
    telemetry,
    timing: options.timing,
    newRunId: () => `run-${epoch}-${++runs}`,
  });
  return { clock, scheduler, venue, stream, reconciliation, persistence, telemetry, service };
}

/** Startup, a watch, then a Phase 18 run of this runtime that completes HEALTHY after the watch. */
async function ready(h: Harness, epoch = EPOCH): Promise<number> {
  await h.service.recoverAtStartup();
  expect(await h.service.startWatch()).toMatchObject({ kind: 'WATCHING' });
  return h.reconciliation.completeHealthyRun(epoch);
}

describe('the certification path: O-P-O-P-O -> CERTIFIED_IDLE', () => {
  it('issues a one-shot PRACTICAL_RECOVERY certificate bound to account, fingerprint, epoch, generation, and incarnation', async () => {
    const h = harness();
    const generation = await ready(h);
    const outcome = await h.service.certifyAccount();
    if (outcome.kind !== 'CERTIFIED') throw new Error(`expected CERTIFIED, got ${JSON.stringify(outcome)}`);
    const record = PracticalRecoveryCertificate.read(outcome.certificate)!;
    expect(record).toMatchObject({
      accountId: ACCOUNT, providerAccountFingerprint: FINGERPRINT, runtimeEpoch: EPOCH, reconciliationGeneration: generation, streamIncarnation: 1,
      basis: 'PRACTICAL_RECOVERY', provesAccountContinuity: false,
    });
    expect(record.expiresAtMs - record.issuedAtMs).toBeLessThanOrEqual(120_000);
    expect(outcome.certificate.provesAccountContinuity).toBe(false);
    expect(outcome.summary.passCount).toBeGreaterThanOrEqual(3);
    expect(outcome.summary.certificationSpanMs).toBeGreaterThanOrEqual(30_000);
    expect(outcome.summary.minimumObservedPassSpacingMs).toBeGreaterThanOrEqual(10_000);
    expect(outcome.account).toMatchObject({ state: 'CERTIFIED_IDLE', fence: { mode: { kind: 'IDLE' }, reconciliationGeneration: generation } });
    expect(h.persistence.certificate?.record).toMatchObject({ certificateId: record.certificateId, status: 'ISSUED', evidenceDigest: outcome.summary.evidenceDigest });
    // The durable path: exactly start -> finish, no invalidation, no lease path.
    expect(h.persistence.operations.filter((op) => !op.startsWith('load'))).toEqual(['initializeAccount', 'startCertification', 'finishCertification']);
  });

  it('each pass is the bracketed sequence identity, O1 P1 O2 P2 O3, identity, back to back; passes are paced by the ceilings', async () => {
    const h = harness();
    await ready(h);
    await h.service.certifyAccount();
    const PASS = ['IDENTITY', 'ORDERS', 'POSITIONS', 'ORDERS', 'POSITIONS', 'ORDERS', 'IDENTITY'];
    expect(h.venue.calls.map((call) => call.kind)).toEqual([...PASS, ...PASS, ...PASS]);
    const starts = [0, 7, 14].map((index) => h.venue.calls[index]!.atMs);
    const ends = [6, 13, 20].map((index) => h.venue.calls[index]!.atMs + h.venue.latencyMs);
    expect(starts[1]! - ends[0]!).toBeGreaterThanOrEqual(10_000);
    expect(starts[2]! - ends[1]!).toBeGreaterThanOrEqual(10_000);
    expect(ends[2]! - starts[0]!).toBeGreaterThanOrEqual(30_000);
    // Inside a pass there is no deliberate pause: the bracket is as tight as the reads allow.
    for (let index = 1; index < 7; index += 1) {
      expect(h.venue.calls[index]!.atMs - (h.venue.calls[index - 1]!.atMs + h.venue.latencyMs)).toBe(0);
    }
    const reads = h.telemetry.events.filter((event) => event.type === 'P18B_READ');
    expect(reads.slice(0, 7).map((event) => (event.type === 'P18B_READ' ? event.slot : null))).toEqual(['IDENTITY_OPEN', 'O1', 'P1', 'O2', 'P2', 'O3', 'IDENTITY_CLOSE']);
  });

  it('the evidence digest (and so the certificate id) is deterministic for identical accepted evidence', async () => {
    const first = harness();
    await ready(first);
    const a = await first.service.certifyAccount();
    const second = harness();
    await ready(second);
    const b = await second.service.certifyAccount();
    if (a.kind !== 'CERTIFIED' || b.kind !== 'CERTIFIED') throw new Error('expected CERTIFIED twice');
    expect(b.summary.evidenceDigest).toBe(a.summary.evidenceDigest);
    expect(b.certificate.certificateId).toBe(a.certificate.certificateId);
  });

  it('records safe calibration telemetry: reads, passes, spacing, outcome (numbers and codes only)', async () => {
    const h = harness();
    await ready(h);
    await h.service.certifyAccount();
    const types = h.telemetry.events.map((event) => event.type);
    expect(types.filter((type) => type === 'P18B_READ')).toHaveLength(21);
    expect(types.filter((type) => type === 'P18B_PASS')).toHaveLength(3);
    expect(types.filter((type) => type === 'P18B_PASS_SPACING')).toHaveLength(2);
    expect(h.telemetry.events.at(-1)).toMatchObject({ type: 'P18B_CERTIFICATION', outcome: 'CERTIFIED', passCount: 3 });
    const serialized = JSON.stringify(h.telemetry.events);
    expect(serialized).not.toContain(FINGERPRINT);
    expect(serialized).not.toContain('ord-1');
    expect(serialized).not.toMatch(/apiKey|secret|signature/i);
  });
});

describe('every failure is explicit, durable, and issues nothing', () => {
  const cases: readonly {
    readonly name: string;
    readonly arrange: (h: Harness) => void;
    readonly outcome: Record<string, unknown>;
    readonly state: string;
    readonly durable: string;
  }[] = [
    {
      name: 'provider unavailable (read throws)',
      arrange: (h) => { h.venue.behavior = (kind, index) => (kind === 'ORDERS' && index === 1 ? { kind: 'THROW' } : undefined); },
      outcome: { kind: 'FAILED', failure: 'PROVIDER_UNAVAILABLE', durableFailure: { kind: 'PROVIDER_UNAVAILABLE' } },
      state: 'PROVIDER_UNAVAILABLE',
      durable: 'failCertification:PROVIDER_UNAVAILABLE',
    },
    {
      name: 'a read that hangs (bounded by the HARD read timeout)',
      arrange: (h) => { h.venue.behavior = (kind, index) => (kind === 'POSITIONS' && index === 0 ? { kind: 'HANG' } : undefined); },
      outcome: { kind: 'FAILED', failure: 'READ_HARD_TIMEOUT' },
      state: 'PROVIDER_UNAVAILABLE',
      durable: 'failCertification:PROVIDER_UNAVAILABLE',
    },
    {
      name: 'incomplete pagination',
      arrange: (h) => {
        h.venue.behavior = (kind, index) => (kind === 'ORDERS' && index === 2
          ? { kind: 'VALUE', value: { orders: [order('ord-1')], provenance: { source: 'COINDCX_FUTURES_ORDERS', localReadStartedAtMs: 1, localReadEndedAtMs: 2, complete: false, pagesRead: 100, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' } } }
          : undefined);
      },
      outcome: { kind: 'FAILED', failure: 'PAGINATION_INCOMPLETE' },
      state: 'QUARANTINED',
      durable: 'failCertification:INCOMPLETE_PAGINATION',
    },
    {
      name: 'a malformed response',
      arrange: (h) => { h.venue.behavior = (kind) => (kind === 'POSITIONS' ? { kind: 'VALUE', value: { positions: 'nope' } } : undefined); },
      outcome: { kind: 'FAILED', failure: 'MALFORMED_RESPONSE' },
      state: 'QUARANTINED',
      durable: 'failCertification:PROVIDER_SCHEMA_ERROR',
    },
    {
      name: 'an account fingerprint mismatch (manual review)',
      arrange: (h) => { h.venue.behavior = (kind, index) => (kind === 'IDENTITY' && index === 1 ? { kind: 'VALUE', value: { kind: 'OBSERVED', fingerprint: OTHER_FINGERPRINT } } : undefined); },
      outcome: { kind: 'FAILED', failure: 'ACCOUNT_FINGERPRINT_MISMATCH' },
      state: 'MANUAL_REVIEW_REQUIRED',
      durable: 'failCertification:ACCOUNT_IDENTITY_MISMATCH',
    },
    {
      name: 'a missing account identity',
      arrange: (h) => { h.venue.behavior = (kind) => (kind === 'IDENTITY' ? { kind: 'VALUE', value: { kind: 'UNAVAILABLE', reason: 'ACCOUNT_IDENTITY_MISSING' } } : undefined); },
      outcome: { kind: 'FAILED', failure: 'ACCOUNT_IDENTITY_UNAVAILABLE' },
      state: 'QUARANTINED',
      durable: 'failCertification:ACCOUNT_IDENTITY_MISSING',
    },
    {
      name: 'observation disagreement ACROSS passes (the order set changed between pass 1 and pass 2)',
      arrange: (h) => { h.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 3) h.venue.orders = [order('ord-1'), order('ord-2')]; }; },
      outcome: { kind: 'FAILED', failure: 'OBSERVATION_DISAGREEMENT' },
      state: 'QUARANTINED',
      durable: 'failCertification:EVIDENCE_STALE',
    },
    {
      name: 'a Phase 18 generation change during the run',
      arrange: (h) => { h.venue.onCall = (kind, index) => { if (kind === 'IDENTITY' && index === 1) h.reconciliation.completeHealthyRun(); }; },
      outcome: { kind: 'FAILED', failure: 'GENERATION_CHANGED' },
      state: 'QUARANTINED',
      durable: 'failCertification:GENERATION_CHANGED',
    },
    {
      name: 'a clock anomaly (local time ran backwards)',
      arrange: (h) => { h.venue.onCall = (kind, index) => { if (kind === 'POSITIONS' && index === 1) h.clock.setTime(h.clock.nowMs() - 60_000); }; },
      outcome: { kind: 'FAILED', failure: 'CLOCK_ANOMALY' },
      state: 'QUARANTINED',
      durable: 'failCertification:CLOCK_ANOMALY',
    },
  ];

  it.each(cases.map((testCase) => [testCase.name, testCase] as const))('%s', async (_name, testCase) => {
    const h = harness();
    const generation = await ready(h);
    testCase.arrange(h);
    const outcome = await h.service.certifyAccount();
    expect(outcome).toMatchObject({ ...testCase.outcome, released: true });
    expect(h.persistence.state).toBe(testCase.state);
    expect(h.persistence.operations).toContain(testCase.durable);
    expect(h.persistence.operations).not.toContain('finishCertification');
    expect(h.persistence.certificate).toBeNull();
    expect(h.persistence.fence).toMatchObject({ mode: { kind: 'IDLE' }, reconciliationGeneration: generation });
  });

  it('the durable failure mapping is total and explicit', () => {
    expect(practicalDurableFailureFor('PROVIDER_UNAVAILABLE', null)).toEqual({ kind: 'PROVIDER_UNAVAILABLE' });
    expect(practicalDurableFailureFor('READ_HARD_TIMEOUT', null)).toEqual({ kind: 'PROVIDER_UNAVAILABLE' });
    expect(practicalDurableFailureFor('STREAM_CHANGED', 'WS_RECONNECTED')).toEqual({ kind: 'INVALIDATED', reason: 'WS_RECONNECTED' });
    expect(practicalDurableFailureFor('STREAM_CHANGED', null)).toEqual({ kind: 'INVALIDATED', reason: 'UNKNOWN_PRIVATE_EVENT' });
    for (const code of [
      'BRACKET_DISAGREEMENT', 'OBSERVATION_DISAGREEMENT', 'PASS_HARD_CEILING_EXCEEDED', 'TIMING_WINDOW_UNMET', 'TOO_FEW_PASSES', 'ISSUANCE_REFUSED', 'PERSISTENCE_REFUSED', 'UNEXPECTED_ERROR',
    ] as const) {
      expect(practicalDurableFailureFor(code, null)).toEqual({ kind: 'INVALIDATED', reason: 'EVIDENCE_STALE' });
    }
  });
});

describe('the private-stream tripwire: WS can only revoke', () => {
  it('a private state event mid-run durably invalidates at once; the run is SUPERSEDED and issues nothing', async () => {
    const h = harness();
    await ready(h);
    h.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 1) h.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION'); };
    const outcome = await h.service.certifyAccount();
    expect(outcome).toMatchObject({ kind: 'SUPERSEDED', reason: 'PRIVATE_STATE_EVENT' });
    expect(h.persistence.operations).toContain('invalidate:PRIVATE_STATE_EVENT');
    expect(h.persistence.operations).toContain('failCertification:PRIVATE_STATE_EVENT');
    expect(h.persistence.operations).not.toContain('finishCertification');
    expect(h.persistence).toMatchObject({ state: 'QUARANTINED', certificate: null });
    expect(h.telemetry.events).toContainEqual(expect.objectContaining({ type: 'P18B_TRIPWIRE', reason: 'PRIVATE_STATE_EVENT', certificateAgeMs: null }));
  });

  it('a silent incarnation change mid-run is caught at the next checkpoint', async () => {
    const h = harness();
    await ready(h);
    h.venue.onCall = (kind, index) => { if (kind === 'POSITIONS' && index === 1) h.stream.health = { ...h.stream.health, generationId: 2 }; };
    expect(await h.service.certifyAccount()).toMatchObject({ kind: 'SUPERSEDED', reason: 'STREAM_INCARNATION_CHANGED' });
    expect(h.persistence.certificate).toBeNull();
  });

  it('INVALIDATION RACING FINAL ISSUANCE: a trip that commits first wins; the certificate is never persisted', async () => {
    const h = harness();
    await ready(h);
    h.persistence.beforeFinish = async () => {
      h.stream.emit('PRIVATE_POSITION_UPDATE_NOTIFICATION');
      await h.service.settled();
    };
    const outcome = await h.service.certifyAccount();
    expect(outcome).toMatchObject({ kind: 'SUPERSEDED', reason: 'PRIVATE_STATE_EVENT' });
    expect(h.persistence).toMatchObject({ state: 'QUARANTINED', certificate: null });
    expect(h.persistence.fence).toMatchObject({ mode: { kind: 'IDLE' } });
  });

  it('a trip AFTER issuance durably revokes the certificate and reports its age', async () => {
    const h = harness();
    await ready(h);
    const outcome = await h.service.certifyAccount();
    if (outcome.kind !== 'CERTIFIED') throw new Error('expected CERTIFIED');
    h.clock.advance(7_000);
    h.stream.reconnect();
    await h.service.settled();
    expect(h.persistence.state).toBe('QUARANTINED');
    expect(h.persistence.certificate?.record).toMatchObject({ status: 'REVOKED', terminalReason: 'WS_DISCONNECTED' });
    expect(PracticalRecoveryCertificate.status(outcome.certificate)).toBe('REVOKED');
    expect(h.telemetry.events).toContainEqual(expect.objectContaining({ type: 'P18B_TRIPWIRE', reason: 'WS_DISCONNECTED', certificateAgeMs: 7_000 }));
    // Reconnect never re-certifies: the trip is sticky, and even after a durable-safety reset the reconnected
    // stream is RECONCILIATION_REQUIRED, so no new watch can bind at all.
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'WATCH_TRIPPED' });
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'WATCH_TRIPPED_RESET_REQUIRED' });
    expect(await h.service.resetAfterRevocation()).toEqual({ kind: 'RESET' });
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'STREAM_RECONCILIATION_REQUIRED' });
    h.reconciliation.completeHealthyRun();
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'NO_ACTIVE_WATCH' });
    expect(h.persistence.operations.filter((op) => op === 'startCertification')).toHaveLength(1);
  });
});

describe('P18B-B-01: the bracketed O-P-O-P-O pass', () => {
  const other = [order('ord-1'), order('ord-2')];
  const otherPositions = [position('pos-1', { signedQuantity: '1' })];

  it.each([
    ['O1 != O2 (the orders changed before O2)', (h: Harness) => { h.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 1) h.venue.orders = other; }; }, 'ORDERS_O1_O2', 4],
    ['O2 != O3 (the orders changed before O3)', (h: Harness) => { h.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 2) h.venue.orders = other; }; }, 'ORDERS_O2_O3', 6],
    ['P1 != P2 (the positions changed before P2)', (h: Harness) => { h.venue.onCall = (kind, index) => { if (kind === 'POSITIONS' && index === 1) h.venue.positions = otherPositions; }; }, 'POSITIONS_P1_P2', 5],
    ['a TRANSIENT order change restored before O3 (only O2 saw it)', (h: Harness) => {
      const original = h.venue.orders;
      h.venue.onCall = (kind, index) => {
        if (kind === 'ORDERS' && index === 1) h.venue.orders = other;
        if (kind === 'ORDERS' && index === 2) h.venue.orders = original;
      };
    }, 'ORDERS_O1_O2', 4],
    ['a TRANSIENT position change restored before P2 (only P1 saw it)', (h: Harness) => {
      const original = h.venue.positions;
      h.venue.onCall = (kind, index) => {
        if (kind === 'POSITIONS' && index === 0) h.venue.positions = otherPositions;
        if (kind === 'POSITIONS' && index === 1) h.venue.positions = original;
      };
    }, 'POSITIONS_P1_P2', 5],
  ] as const)('%s fails the pass at once: BRACKET_DISAGREEMENT %s, durable EVIDENCE_STALE, nothing issued', async (_label, arrange, disagreement, readsBeforeStop) => {
    const h = harness();
    const generation = await ready(h);
    arrange(h);
    expect(await h.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'BRACKET_DISAGREEMENT', durableFailure: { kind: 'INVALIDATED', reason: 'EVIDENCE_STALE' }, released: true });
    // The pass stopped at the read that disagreed: a partial pass never continues.
    expect(h.venue.calls).toHaveLength(readsBeforeStop);
    expect(h.telemetry.events).toContainEqual({ type: 'P18B_DISAGREEMENT', runId: `run-${EPOCH}-1`, passIndex: 1, reason: disagreement });
    expect(h.telemetry.events).toContainEqual(expect.objectContaining({ type: 'P18B_PASS', passIndex: 1, failure: 'BRACKET_DISAGREEMENT', bracketDisagreement: disagreement, stateDigestPrefix: null }));
    expect(h.persistence).toMatchObject({ state: 'QUARANTINED', certificate: null });
    expect(h.persistence.fence).toMatchObject({ mode: { kind: 'IDLE' }, reconciliationGeneration: generation });
  });

  it.each([
    ['O1', 'ORDERS', 3],
    ['P1', 'POSITIONS', 2],
    ['O2', 'ORDERS', 4],
    ['P2', 'POSITIONS', 3],
    ['O3', 'ORDERS', 5],
  ] as const)('PARTIAL PAGINATION in %s of pass 2 fails the certification (PAGINATION_INCOMPLETE)', async (_slot, kind, index) => {
    const h = harness();
    await ready(h);
    const incomplete = kind === 'ORDERS'
      ? { orders: [order('ord-1')], provenance: { source: 'COINDCX_FUTURES_ORDERS', localReadStartedAtMs: 1, localReadEndedAtMs: 2, complete: false, pagesRead: 100, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' } }
      : { positions: [position('pos-1')], provenance: { source: 'COINDCX_FUTURES_POSITIONS', localReadStartedAtMs: 1, localReadEndedAtMs: 2, complete: false, pagesRead: 1, incompleteReason: 'POSITION_PAGE_LIMIT' } };
    h.venue.behavior = (readKind, readIndex) => (readKind === kind && readIndex === index ? { kind: 'VALUE', value: incomplete } : undefined);
    expect(await h.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'PAGINATION_INCOMPLETE', released: true });
    expect(h.venue.calls.at(-1)).toMatchObject({ kind });
    expect(h.persistence.operations).toContain('failCertification:INCOMPLETE_PAGINATION');
    expect(h.persistence.certificate).toBeNull();
  });

  it('identical bracketed reads in every pass certify', async () => {
    const h = harness();
    await ready(h);
    expect((await h.service.certifyAccount()).kind).toBe('CERTIFIED');
    const passes = h.telemetry.events.filter((event) => event.type === 'P18B_PASS');
    expect(passes).toHaveLength(3);
    for (const event of passes) expect(event).toMatchObject({ complete: true, failure: null, bracketDisagreement: null });
  });
});

describe('P18B-B-02: stream readiness (WS remains revoke-only)', () => {
  it('the initial healthy, eligible stream state may arm', async () => {
    const h = harness();
    await h.service.recoverAtStartup();
    expect(h.stream.getHealthSnapshot()).toMatchObject({ state: 'AUTH_JOIN_SENT', reconciliationRequired: false });
    expect(await h.service.startWatch()).toMatchObject({ kind: 'WATCHING', watch: { binding: { incarnation: 1, state: 'AUTH_JOIN_SENT' } } });
  });

  it.each([
    ['RECONCILIATION_REQUIRED (state and sticky flag)', { state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true }, 'STREAM_RECONCILIATION_REQUIRED'],
    ['a NEW incarnation alone (still unresolved)', { generationId: 2, reconciliationRequired: true }, 'STREAM_RECONCILIATION_REQUIRED'],
    ['join delivery uncertain (join not sent)', { state: 'CONNECTED', authJoinSent: false }, 'STREAM_JOIN_NOT_SENT'],
    ['disconnected', { connected: false }, 'STREAM_DISCONNECTED'],
  ])('%s cannot arm, so certification is refused and nothing durable changes', async (_label, change, reason) => {
    const h = harness();
    await h.service.recoverAtStartup();
    h.stream.health = { ...h.stream.health, ...change };
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason });
    h.reconciliation.completeHealthyRun();
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'NO_ACTIVE_WATCH' });
    expect(h.persistence.operations).not.toContain('startCertification');
    expect(h.venue.calls).toEqual([]);
  });

  it('a reconnect moves the stream to an unusable state: the watch trips and no new watch can bind', async () => {
    const h = harness();
    await ready(h);
    h.stream.reconnect();
    await h.service.settled();
    expect(h.stream.getHealthSnapshot()).toMatchObject({ generationId: 2, state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true });
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'WATCH_TRIPPED' });
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'WATCH_TRIPPED_RESET_REQUIRED' });
    expect(await h.service.resetAfterRevocation()).toEqual({ kind: 'RESET' });
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'STREAM_RECONCILIATION_REQUIRED' });
    h.reconciliation.completeHealthyRun();
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'NO_ACTIVE_WATCH' });
    expect(h.persistence.operations).not.toContain('startCertification');
  });

  it.each([
    ['a silent move to RECONCILIATION_REQUIRED (same incarnation)', (h: Harness) => { h.stream.health = { ...h.stream.health, state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true }; }, 'WS_RECONNECTED'],
    ['a reconciliation-required event', (h: Harness) => { h.stream.emit('PRIVATE_RECONCILIATION_REQUIRED'); }, 'WS_RECONNECTED'],
    ['a lost join (subscription delivery uncertain)', (h: Harness) => { h.stream.health = { ...h.stream.health, authJoinSent: false }; }, 'WS_JOIN_FAILED'],
  ])('%s during certification aborts it: SUPERSEDED, durably invalidated, nothing issued', async (_label, change, reason) => {
    const h = harness();
    await ready(h);
    h.venue.onCall = (kind, index) => { if (kind === 'POSITIONS' && index === 3) change(h); };
    expect(await h.service.certifyAccount()).toMatchObject({ kind: 'SUPERSEDED', reason });
    expect(h.persistence.operations).toContain(`invalidate:${reason}`);
    expect(h.persistence.operations).not.toContain('finishCertification');
    expect(h.persistence).toMatchObject({ state: 'QUARANTINED', certificate: null });
  });

  it('an issued certificate is invalidated if the stream later enters RECONCILIATION_REQUIRED (even silently)', async () => {
    const h = harness();
    await ready(h);
    const outcome = await h.service.certifyAccount();
    if (outcome.kind !== 'CERTIFIED') throw new Error('expected CERTIFIED');
    h.clock.advance(3_000);
    h.stream.health = { ...h.stream.health, state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true };
    // The monitor's stream check trips the watch; the tripwire's durable revocation has already ended the certificate.
    expect(await h.service.monitorAuthority()).toEqual({ kind: 'NO_OUTSTANDING_CERTIFICATE', tripped: true });
    expect(h.persistence.operations).toContain('invalidate:WS_RECONNECTED');
    expect(h.persistence.certificate?.record).toMatchObject({ status: 'REVOKED', terminalReason: 'WS_RECONNECTED' });
    expect(h.telemetry.events).toContainEqual(expect.objectContaining({ type: 'P18B_TRIPWIRE', reason: 'WS_RECONNECTED', certificateAgeMs: 3_000 }));
    expect(h.persistence.state).toBe('QUARANTINED');
    expect(PracticalRecoveryCertificate.status(outcome.certificate)).toBe('REVOKED');
  });
});

describe('P18B-B-04: positive readiness (PROVEN_READY) is required; AUTH_JOIN_SENT is not readiness', () => {
  it('AUTH_JOIN_SENT alone (connected, join sent, no reconnect, UNPROVEN) cannot arm or certify: no certificate, no REST reads, no durable change', async () => {
    const h = harness();
    await h.service.recoverAtStartup();
    h.stream.unprove();
    expect(h.stream.getHealthSnapshot()).toMatchObject({ state: 'AUTH_JOIN_SENT', connected: true, authJoinSent: true, reconciliationRequired: false, subscriptionConfirmation: null });
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'STREAM_NO_PROVIDER_CONFIRMATION' });
    h.reconciliation.completeHealthyRun();
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'NO_ACTIVE_WATCH' });
    expect(h.venue.calls).toEqual([]);
    expect(h.persistence.operations.filter((op) => !op.startsWith('load'))).toEqual(['initializeAccount']);
    expect(h.persistence.certificate).toBeNull();
  });

  it('PROLONGED SILENCE on an UNPROVEN stream never becomes authority, however long, however many Phase 18 runs and REST observations agree', async () => {
    const h = harness();
    await h.service.recoverAtStartup();
    h.stream.unprove();
    for (let round = 0; round < 50; round += 1) {
      h.clock.advance(10 * 60_000);
      h.reconciliation.completeHealthyRun();
      // The account state never changes and no private event ever arrives: pure silence.
      expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'STREAM_NO_PROVIDER_CONFIRMATION' });
      expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'NO_ACTIVE_WATCH' });
    }
    // Even when REST evidence is plentiful and unanimous, silence on an unproven stream grants nothing.
    for (let read = 0; read < 30; read += 1) {
      await h.venue.readOrders();
      await h.venue.readPositions();
    }
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'NO_ACTIVE_WATCH' });
    expect(h.persistence.operations).not.toContain('startCertification');
    expect(h.persistence).toMatchObject({ state: 'QUARANTINED', certificate: null });
  });

  it('a deterministic PROVEN_READY stream runs the complete certification path, bound to the proven incarnation', async () => {
    const h = harness();
    await h.service.recoverAtStartup();
    h.stream.reconnect();
    // A hypothetical future adapter that resolved the reconnect AND observed a genuine provider confirmation for incarnation 2.
    h.stream.health = { ...h.stream.health, state: 'AUTH_JOIN_SENT', reconciliationRequired: false };
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'STREAM_NO_PROVIDER_CONFIRMATION' });
    h.stream.confirmSubscription(T0 + 1);
    expect(await h.service.startWatch()).toMatchObject({ kind: 'WATCHING', watch: { binding: { incarnation: 2, confirmedAtMs: T0 + 1 } } });
    h.reconciliation.completeHealthyRun();
    const outcome = await h.service.certifyAccount();
    if (outcome.kind !== 'CERTIFIED') throw new Error(`expected CERTIFIED, got ${JSON.stringify(outcome)}`);
    expect(PracticalRecoveryCertificate.read(outcome.certificate)).toMatchObject({ streamIncarnation: 2, provesAccountContinuity: false });
  });

  it('a confirmation of another incarnation never proves this one', async () => {
    const h = harness();
    await h.service.recoverAtStartup();
    h.stream.health = { ...h.stream.health, subscriptionConfirmation: { source: 'PROVIDER', incarnation: 7, confirmedAtMs: T0 } };
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'STREAM_CONFIRMATION_FOR_OTHER_INCARNATION' });
  });

  it.each([
    ['the provider confirmation disappears (back to AUTH_JOIN_SENT alone)', (h: Harness) => { h.stream.unprove(); }],
    ['the confirmation is replaced (a new subscription attempt)', (h: Harness) => { h.stream.confirmSubscription(T0 + 99); }],
  ])('READINESS LOSS DURING O-P-O-P-O (%s) aborts the certification: SUPERSEDED, nothing issued', async (_label, loseReadiness) => {
    const h = harness();
    await ready(h);
    h.venue.onCall = (kind, index) => { if (kind === 'ORDERS' && index === 4) loseReadiness(h); };
    expect(await h.service.certifyAccount()).toMatchObject({ kind: 'SUPERSEDED', reason: 'WS_JOIN_FAILED' });
    expect(h.persistence.operations).toContain('invalidate:WS_JOIN_FAILED');
    expect(h.persistence.operations).not.toContain('finishCertification');
    expect(h.persistence).toMatchObject({ state: 'QUARANTINED', certificate: null });
  });

  it('READINESS LOSS AFTER ISSUANCE revokes the certificate; readiness never renews it', async () => {
    const h = harness();
    await ready(h);
    const outcome = await h.service.certifyAccount();
    if (outcome.kind !== 'CERTIFIED') throw new Error('expected CERTIFIED');
    h.stream.unprove();
    expect(await h.service.monitorAuthority()).toEqual({ kind: 'NO_OUTSTANDING_CERTIFICATE', tripped: true });
    expect(h.persistence.certificate?.record).toMatchObject({ status: 'REVOKED', terminalReason: 'WS_JOIN_FAILED' });
    expect(PracticalRecoveryCertificate.status(outcome.certificate)).toBe('REVOKED');
    // Readiness coming back grants nothing by itself: the old watch stays tripped, and a new certificate needs a new full run.
    h.stream.confirmSubscription();
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'WATCH_TRIPPED' });
    expect(h.persistence.operations.filter((op) => op === 'finishCertification')).toHaveLength(1);
  });
});

describe('P18B-B-03: calibration candidates are telemetry markers; hard ceilings fail closed', () => {
  const readEvents = (h: Harness) => h.telemetry.events.filter((event): event is Extract<typeof event, { type: 'P18B_READ' }> => event.type === 'P18B_READ');
  const passEvents = (h: Harness) => h.telemetry.events.filter((event): event is Extract<typeof event, { type: 'P18B_PASS' }> => event.type === 'P18B_PASS');

  it('the two kinds are distinct values: hard ceilings are named, not provider guarantees, and far above the candidates', () => {
    expect(PRACTICAL_RECOVERY_HARD_CEILINGS).toMatchObject({ kind: 'HARD_OPERATIONAL_CEILING', providerGuarantee: false });
    expect(PRACTICAL_RECOVERY_HARD_CEILINGS.readTimeoutMs).toBeGreaterThan(PRACTICAL_TIMING_CANDIDATES.readDuration.valueMs);
    expect(PRACTICAL_RECOVERY_HARD_CEILINGS.passDurationMs).toBeGreaterThan(PRACTICAL_TIMING_CANDIDATES.passWindow.valueMs);
    expect(PRACTICAL_TIMING_CANDIDATES.readDuration).toMatchObject({ status: 'SHADOW_CALIBRATION_CANDIDATE', providerGuarantee: false });
  });

  it('CANDIDATE EXCEEDED, HARD CEILING NOT: slow reads (5 s) and a slow pass (35 s) still certify, reported as candidate exceedances only', async () => {
    const h = harness();
    await ready(h);
    h.venue.latencyMs = 5_000;
    expect((await h.service.certifyAccount()).kind).toBe('CERTIFIED');
    expect(readEvents(h)).toHaveLength(21);
    for (const event of readEvents(h)) expect(event).toMatchObject({ outcome: 'OK', latencyMs: 5_000, readCandidateExceeded: true, hardTimeout: false });
    for (const event of passEvents(h)) expect(event).toMatchObject({ complete: true, durationMs: 35_000, passCandidateExceeded: true, hardCeilingExceeded: false });
  });

  it('tightening every candidate to 1 ms changes only the markers, never the outcome', async () => {
    const tiny = { valueMs: 1, status: 'SHADOW_CALIBRATION_CANDIDATE' as const, providerGuarantee: false as const };
    const h = harness({ timing: { readDuration: tiny, passWindow: tiny, interReadGap: tiny } });
    await ready(h);
    expect((await h.service.certifyAccount()).kind).toBe('CERTIFIED');
    for (const event of readEvents(h)) expect(event.readCandidateExceeded).toBe(true);
    for (const event of passEvents(h)) expect(event).toMatchObject({ passCandidateExceeded: true, interReadGapCandidateExceeded: false, maxInterReadGapMs: 0 });
  });

  it('HARD READ TIMEOUT: a read that never returns is abandoned at the hard ceiling (not the candidate) and fails closed', async () => {
    const h = harness();
    await ready(h);
    h.venue.behavior = (kind, index) => (kind === 'ORDERS' && index === 1 ? { kind: 'HANG' } : undefined);
    expect(await h.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'READ_HARD_TIMEOUT', durableFailure: { kind: 'PROVIDER_UNAVAILABLE' } });
    const hung = readEvents(h).find((event) => event.slot === 'O2')!;
    expect(hung).toMatchObject({ outcome: 'READ_HARD_TIMEOUT', hardTimeout: true, readCandidateExceeded: true });
    expect(hung.latencyMs).toBeGreaterThanOrEqual(PRACTICAL_RECOVERY_HARD_CEILINGS.readTimeoutMs);
    // Every earlier read also exceeded nothing hard.
    expect(readEvents(h).filter((event) => event.hardTimeout)).toHaveLength(1);
    expect(h.persistence.state).toBe('PROVIDER_UNAVAILABLE');
  });

  it('HARD PASS CEILING: reads under the hard read timeout (10 s) that add up past the hard pass ceiling (70 s) fail closed', async () => {
    const h = harness();
    await ready(h);
    h.venue.latencyMs = 10_000;
    expect(await h.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'PASS_HARD_CEILING_EXCEEDED', durableFailure: { kind: 'INVALIDATED', reason: 'EVIDENCE_STALE' } });
    for (const event of readEvents(h)) expect(event).toMatchObject({ outcome: 'OK', hardTimeout: false, readCandidateExceeded: true });
    expect(passEvents(h)).toEqual([expect.objectContaining({ complete: true, durationMs: 70_000, hardCeilingExceeded: true, passCandidateExceeded: true })]);
    expect(h.persistence.certificate).toBeNull();
  });
});

describe('eligibility: nothing durable changes unless every precondition holds', () => {
  it.each([
    ['no watch armed', async (h: Harness) => { await h.service.recoverAtStartup(); }, 'NO_ACTIVE_WATCH'],
    ['the Phase 18 generation was claimed before the watch', async (h: Harness) => {
      await h.service.recoverAtStartup();
      h.reconciliation.completeHealthyRun();
      await h.service.startWatch();
    }, 'RECONCILIATION_GENERATION_NOT_AFTER_WATCH'],
    ['Phase 18 is not HEALTHY', async (h: Harness) => {
      await ready(h);
      h.reconciliation.state = { ...h.reconciliation.state, status: 'UNHEALTHY' };
    }, 'RECONCILIATION_NOT_HEALTHY'],
    ['Phase 18 was reconciled by another runtime', async (h: Harness) => { await ready(h, EPOCH_B); }, 'RECONCILIATION_OTHER_RUNTIME'],
    ['the Phase 18 state cannot be read', async (h: Harness) => { await ready(h); h.reconciliation.fail = true; }, 'RECONCILIATION_STATE_UNAVAILABLE'],
    ['the watch tripped', async (h: Harness) => { await ready(h); h.stream.emit('PRIVATE_BALANCE_CHANGE_NOTIFICATION'); }, 'WATCH_TRIPPED'],
    ['the account was never initialized', async (h: Harness) => { await h.service.startWatch(); h.reconciliation.completeHealthyRun(); }, 'ACCOUNT_NOT_INITIALIZED'],
  ])('%s -> NOT_ELIGIBLE %s', async (_label, arrange, reason) => {
    const h = harness();
    await arrange(h);
    const before = h.persistence.operations.filter((op) => !op.startsWith('load') && !op.startsWith('invalidate')).length;
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason });
    expect(h.persistence.operations.filter((op) => !op.startsWith('load') && !op.startsWith('invalidate')).length).toBe(before);
    expect(h.persistence.certificate).toBeNull();
  });

  it('Tier B not enabled for the account -> NOT_ELIGIBLE, and the issuer is never reached', async () => {
    const h = harness({ enabledFor: 'some-other-account' });
    await ready(h);
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'TIER_B_NOT_ENABLED_FOR_ACCOUNT' });
    expect(h.persistence.operations).not.toContain('startCertification');
  });

  it('a failed run cannot be retried on the SAME Phase 18 generation (Stage 1A: the generation must advance)', async () => {
    const h = harness();
    await ready(h);
    h.venue.behavior = (kind, index) => (kind === 'IDENTITY' && index === 0 ? { kind: 'VALUE', value: { kind: 'UNAVAILABLE', reason: 'ACCOUNT_IDENTITY_MISSING' } } : undefined);
    expect(await h.service.certifyAccount()).toMatchObject({ kind: 'FAILED' });
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'RECONCILIATION_GENERATION_NOT_NEWER_THAN_FENCE' });
    h.reconciliation.completeHealthyRun();
    expect((await h.service.certifyAccount()).kind).toBe('CERTIFIED');
  });

  it('already certified, or in manual review -> NOT_ELIGIBLE', async () => {
    const h = harness();
    await ready(h);
    await h.service.certifyAccount();
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'ALREADY_CERTIFIED' });
    await h.persistence.invalidate({ reason: 'ORPHAN_ORDER' });
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'MANUAL_REVIEW_REQUIRED' });
  });

  it('PROVIDER_UNAVAILABLE is left only after a successful identity probe; a probe that sees another account goes to review', async () => {
    const h = harness();
    await ready(h);
    h.venue.behavior = (kind, index) => (kind === 'ORDERS' && index === 0 ? { kind: 'THROW' } : undefined);
    await h.service.certifyAccount();
    expect(h.persistence.state).toBe('PROVIDER_UNAVAILABLE');
    h.reconciliation.completeHealthyRun();
    h.venue.behavior = (kind) => (kind === 'IDENTITY' ? { kind: 'THROW' } : undefined);
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'PROVIDER_STILL_UNAVAILABLE' });
    expect(h.persistence.state).toBe('PROVIDER_UNAVAILABLE');
    // No probe (and no durable change) at all while Phase 18 eligibility is missing.
    const identityReads = h.venue.calls.filter((call) => call.kind === 'IDENTITY');
    h.reconciliation.state = { ...h.reconciliation.state, status: 'UNHEALTHY' };
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'RECONCILIATION_NOT_HEALTHY' });
    expect(h.venue.calls.filter((call) => call.kind === 'IDENTITY')).toHaveLength(identityReads.length);
    expect(h.persistence.state).toBe('PROVIDER_UNAVAILABLE');
    h.reconciliation.state = { ...h.reconciliation.state, status: 'HEALTHY' };
    h.venue.behavior = () => undefined;
    expect((await h.service.certifyAccount()).kind).toBe('CERTIFIED');
    expect(h.persistence.operations).toContain('recordProviderRecovered');

    const mismatch = harness();
    await ready(mismatch);
    mismatch.venue.behavior = (kind, index) => (kind === 'ORDERS' && index === 0 ? { kind: 'THROW' } : undefined);
    await mismatch.service.certifyAccount();
    mismatch.reconciliation.completeHealthyRun();
    mismatch.venue.behavior = () => undefined;
    mismatch.venue.identity = { kind: 'OBSERVED', fingerprint: OTHER_FINGERPRINT };
    expect(await mismatch.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'ACCOUNT_IDENTITY_MISMATCH' });
    expect(mismatch.persistence.state).toBe('MANUAL_REVIEW_REQUIRED');
  });
});

describe('concurrency and stale runs (the durable fence decides)', () => {
  it('two engines racing on one account: exactly one certifies; the other loses with no durable change', async () => {
    const a = harness();
    const b = harness({ shared: a });
    await a.service.recoverAtStartup();
    await a.service.startWatch();
    await b.service.startWatch();
    a.reconciliation.completeHealthyRun();
    const results = await Promise.all([a.service.certifyAccount(), b.service.certifyAccount()]);
    const kinds = results.map((result) => result.kind).sort();
    expect(kinds).toEqual(['CERTIFIED', 'LOST_RACE']);
    expect(a.persistence.operations.filter((op) => op === 'finishCertification')).toHaveLength(1);
  });

  it('a run of a dead runtime epoch can never finish after a restart adopted the fence', async () => {
    const a = harness();
    await ready(a);
    a.scheduler.hold(); // "process A stops": its next pause never fires
    const pending = a.service.certifyAccount();
    await new Promise((resolve) => setImmediate(resolve));
    expect(a.persistence.state).toBe('CERTIFYING');
    const b = harness({ shared: a, epoch: EPOCH_B });
    expect(await b.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'ADOPTED', account: { state: 'QUARANTINED', fence: { runtimeEpoch: EPOCH_B, mode: { kind: 'IDLE' } } } });
    a.scheduler.release(); // the stale process wakes up
    const stale = await pending;
    expect(stale).toMatchObject({ kind: 'FAILED', released: false });
    expect(a.persistence).toMatchObject({ state: 'QUARANTINED', certificate: null });
    expect(a.persistence.fence).toMatchObject({ runtimeEpoch: EPOCH_B, mode: { kind: 'IDLE' } });
  });

  it('a rollback during certificate persistence leaves no certificate and a released fence', async () => {
    const h = harness();
    await ready(h);
    h.persistence.failFinish = true;
    expect(await h.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'PERSISTENCE_REFUSED', released: true });
    expect(h.persistence).toMatchObject({ state: 'QUARANTINED', certificate: null });
  });
});

describe('startup and the revoke-only authority monitor', () => {
  it('startup: absent -> QUARANTINED; malformed -> durable manual-review latch', async () => {
    const h = harness();
    expect(await h.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'CREATED', account: { state: 'QUARANTINED' } });
    const malformed = harness();
    malformed.persistence.malformed = true;
    expect(await malformed.service.recoverAtStartup()).toEqual({ kind: 'MANUAL_REVIEW_REQUIRED', reviewEpisodeId: 'latched-1' });
  });

  it('an issued certificate expires at its absolute lifetime; there is no renewal', async () => {
    const h = harness();
    await ready(h);
    const outcome = await h.service.certifyAccount();
    if (outcome.kind !== 'CERTIFIED') throw new Error('expected CERTIFIED');
    expect(await h.service.monitorAuthority()).toEqual({ kind: 'CERTIFICATE_STILL_VALID' });
    h.clock.advance(120_000);
    expect(await h.service.monitorAuthority()).toEqual({ kind: 'CERTIFICATE_EXPIRED' });
    expect(h.persistence.state).toBe('QUARANTINED');
    expect(PracticalRecoveryCertificate.status(outcome.certificate)).toBe('REVOKED');
    expect(h.telemetry.events).toContainEqual({ type: 'P18B_AUTHORITY_ENDED', accountId: ACCOUNT, reason: 'CERTIFICATE_EXPIRED', certificateAgeMs: 120_000 });
  });

  it('a new Phase 18 generation, or losing the watch, revokes an outstanding certificate', async () => {
    const h = harness();
    await ready(h);
    await h.service.certifyAccount();
    h.reconciliation.completeHealthyRun();
    expect(await h.service.monitorAuthority()).toEqual({ kind: 'CERTIFICATE_REVOKED', reason: 'GENERATION_CHANGED' });

    const w = harness();
    await ready(w);
    await w.service.certifyAccount();
    // A graceful stop revokes first: it never leaves an ISSUED certificate unobserved.
    expect(await w.service.stopWatch()).toEqual({ kind: 'STOPPED', revokedCertificate: true });
    expect(w.persistence.certificate?.record).toMatchObject({ status: 'REVOKED', terminalReason: 'STREAM_INCARNATION_CHANGED' });
    expect(await w.service.monitorAuthority()).toEqual({ kind: 'NO_OUTSTANDING_CERTIFICATE', tripped: false });
  });
});

describe('P18B-B-05: authority is revalidated after every async persistence/read boundary', () => {
  it('Phase 18 generation G -> G+1 DURING finishCertification: never CERTIFIED; the persisted G certificate is durably revoked', async () => {
    const h = harness();
    const generation = await ready(h);
    h.persistence.beforeFinish = async () => { h.reconciliation.completeHealthyRun(); };
    const outcome = await h.service.certifyAccount();
    expect(outcome).toMatchObject({ kind: 'SUPERSEDED', reason: 'GENERATION_CHANGED' });
    expect(h.persistence.operations).toContain('finishCertification');
    expect(h.persistence.certificate?.record).toMatchObject({ reconciliationGeneration: generation, status: 'REVOKED', terminalReason: 'GENERATION_CHANGED' });
    expect(h.persistence.state).toBe('QUARANTINED');
    expect(await h.service.monitorAuthority()).toEqual({ kind: 'NO_OUTSTANDING_CERTIFICATE', tripped: false });
    expect(h.telemetry.events.at(-1)).toMatchObject({ type: 'P18B_CERTIFICATION', outcome: 'SUPERSEDED', failure: 'GENERATION_CHANGED' });
  });

  it('G -> G+1 right AFTER the commit (before finishCertification returns): never CERTIFIED; revoked', async () => {
    const h = harness();
    await ready(h);
    h.persistence.afterFinish = async () => { h.reconciliation.completeHealthyRun(); };
    expect(await h.service.certifyAccount()).toMatchObject({ kind: 'SUPERSEDED', reason: 'GENERATION_CHANGED' });
    expect(h.persistence.certificate?.record.status).toBe('REVOKED');
  });

  it.each([
    ['a private state event', (h: Harness) => { h.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION'); }, 'PRIVATE_STATE_EVENT'],
    ['a silent readiness loss', (h: Harness) => { h.stream.unprove(); }, 'WS_JOIN_FAILED'],
  ])('%s during the POST-PERSISTENCE generation await is caught by the stream re-check AFTER it: never CERTIFIED', async (_label, change, reason) => {
    const h = harness();
    await ready(h);
    // Only the post-commit generation read triggers the change.
    h.persistence.afterFinish = async () => { h.reconciliation.onLoad = () => { h.reconciliation.onLoad = () => undefined; change(h); }; };
    const outcome = await h.service.certifyAccount();
    expect(outcome).toMatchObject({ kind: 'SUPERSEDED', reason });
    await h.service.settled();
    expect(h.persistence.certificate?.record).toMatchObject({ status: 'REVOKED', terminalReason: reason });
    expect(h.persistence.state).toBe('QUARANTINED');
  });

  it.each([
    ['a private state event', (h: Harness) => { h.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION'); }, 'PRIVATE_STATE_EVENT'],
    ['a silent readiness loss', (h: Harness) => { h.stream.unprove(); }, 'WS_JOIN_FAILED'],
    ['a silent RECONCILIATION_REQUIRED', (h: Harness) => { h.stream.health = { ...h.stream.health, state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true }; }, 'WS_RECONNECTED'],
  ])('%s while monitorAuthority awaits reconciliation.loadState(): never CERTIFICATE_STILL_VALID; durably revoked', async (_label, change, reason) => {
    const h = harness();
    await ready(h);
    const outcome = await h.service.certifyAccount();
    if (outcome.kind !== 'CERTIFIED') throw new Error('expected CERTIFIED');
    h.reconciliation.onLoad = () => { h.reconciliation.onLoad = () => undefined; change(h); };
    expect(await h.service.monitorAuthority()).toEqual({ kind: 'CERTIFICATE_REVOKED', reason });
    expect(h.persistence.certificate?.record.status).toBe('REVOKED');
    expect(h.persistence.state).toBe('QUARANTINED');
    expect(PracticalRecoveryCertificate.status(outcome.certificate)).toBe('REVOKED');
  });

  it('unchanged stream and unchanged G: CERTIFIED, then CERTIFICATE_STILL_VALID (repeatedly)', async () => {
    const h = harness();
    await ready(h);
    expect((await h.service.certifyAccount()).kind).toBe('CERTIFIED');
    for (let check = 0; check < 3; check += 1) expect(await h.service.monitorAuthority()).toEqual({ kind: 'CERTIFICATE_STILL_VALID' });
    expect(h.persistence.certificate?.record.status).toBe('ISSUED');
  });

  it('a certificate this service instance did not issue under its current watch is never STILL_VALID', async () => {
    const a = harness();
    await ready(a);
    expect((await a.service.certifyAccount()).kind).toBe('CERTIFIED');
    // Another service instance of the SAME runtime, with its own fresh watch, sees the durable ISSUED certificate.
    const b = harness({ shared: a });
    expect(await b.service.startWatch()).toMatchObject({ kind: 'WATCHING' });
    expect(await b.service.monitorAuthority()).toEqual({ kind: 'CERTIFICATE_REVOKED', reason: 'EVIDENCE_STALE' });
    expect(a.persistence.certificate?.record.status).toBe('REVOKED');
  });
});

describe('P18B-B-06: a trip is sticky until durable safety is PROVEN; stopWatch is fail-closed', () => {
  /** Certified, then a private order event whose durable revocation fails every retry. */
  async function trippedWithFailedRevocation() {
    const h = harness();
    await ready(h);
    const outcome = await h.service.certifyAccount();
    if (outcome.kind !== 'CERTIFIED') throw new Error('expected CERTIFIED');
    h.persistence.failInvalidate = true;
    h.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    await h.service.settled();
    return { h, outcome };
  }

  it('FAILED durable revocation: the trip stays sticky, the durable ISSUED certificate is treated as unusable, nothing re-arms, never STILL_VALID', async () => {
    const { h, outcome } = await trippedWithFailedRevocation();
    expect(h.persistence.operations.filter((op) => op === 'invalidate:PRIVATE_STATE_EVENT')).toHaveLength(3);
    // The DB write failed: the durable certificate physically remains ISSUED ...
    expect(h.persistence).toMatchObject({ state: 'CERTIFIED_IDLE', certificate: { record: { status: 'ISSUED' } } });
    // ... but the service treats it as unusable.
    expect(PracticalRecoveryCertificate.status(outcome.certificate)).toBe('REVOKED');
    expect(h.telemetry.events).toContainEqual(expect.objectContaining({ type: 'P18B_REVOCATION_FAILED', reason: 'PRIVATE_STATE_EVENT' }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Stream silence and repeated startWatch calls cannot clear the trip or re-arm, even on the same PROVEN_READY incarnation.
      expect(await h.service.startWatch()).toMatchObject({ kind: 'NOT_READY' });
      expect(await h.service.monitorAuthority()).toEqual({ kind: 'REVOCATION_UNCONFIRMED', reason: 'PRIVATE_STATE_EVENT' });
      h.reconciliation.completeHealthyRun();
      expect((await h.service.certifyAccount()).kind).toBe('NOT_ELIGIBLE');
    }
    // A reset while persistence is still failing proves nothing and keeps everything blocked.
    expect(await h.service.resetAfterRevocation()).toEqual({ kind: 'KEPT', problem: 'CERTIFICATE_OUTSTANDING' });
    h.persistence.failLoad = true;
    expect(await h.service.resetAfterRevocation()).toEqual({ kind: 'KEPT', problem: 'PERSISTENCE_UNREADABLE' });
    expect(await h.service.startWatch()).toMatchObject({ kind: 'NOT_READY' });
  });

  it('after persistence is restored, the EXPLICIT safe reset durably revokes the old certificate; only then can a NEW watch bind; the old certificate never returns', async () => {
    const { h, outcome } = await trippedWithFailedRevocation();
    expect(await h.service.monitorAuthority()).toEqual({ kind: 'REVOCATION_UNCONFIRMED', reason: 'PRIVATE_STATE_EVENT' });
    h.persistence.failInvalidate = false;
    expect(await h.service.resetAfterRevocation()).toEqual({ kind: 'RESET' });
    expect(h.persistence).toMatchObject({ state: 'QUARANTINED', certificate: { record: { status: 'REVOKED', terminalReason: 'PRIVATE_STATE_EVENT' } } });
    expect(await h.service.resetAfterRevocation()).toEqual({ kind: 'NOTHING_TO_RESET' });
    // A NEW PROVEN_READY watch is allowed, but a new certificate needs a fresh Phase 18 generation and a full certification.
    expect(await h.service.startWatch()).toMatchObject({ kind: 'WATCHING' });
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'RECONCILIATION_GENERATION_NOT_AFTER_WATCH' });
    expect(await h.service.monitorAuthority()).toEqual({ kind: 'NO_OUTSTANDING_CERTIFICATE', tripped: false });
    h.reconciliation.completeHealthyRun();
    const again = await h.service.certifyAccount();
    if (again.kind !== 'CERTIFIED') throw new Error(`expected CERTIFIED, got ${again.kind}`);
    expect(again.certificate.certificateId).not.toBe(outcome.certificate.certificateId);
    expect(PracticalRecoveryCertificate.status(outcome.certificate)).toBe('REVOKED');
    expect(await h.service.monitorAuthority()).toEqual({ kind: 'CERTIFICATE_STILL_VALID' });
  });

  it('a SUCCESSFUL trip revocation is sticky too: startWatch never clears it; the reset proves durable safety first', async () => {
    const h = harness();
    await ready(h);
    h.stream.emit('PRIVATE_BALANCE_CHANGE_NOTIFICATION');
    await h.service.settled();
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'WATCH_TRIPPED_RESET_REQUIRED' });
    expect(await h.service.resetAfterRevocation()).toEqual({ kind: 'RESET' });
    expect(await h.service.startWatch()).toMatchObject({ kind: 'WATCHING' });
  });

  it('stopWatch with an outstanding certificate revokes it FIRST; if that cannot be confirmed the stop is refused and the watch keeps observing', async () => {
    const h = harness();
    await ready(h);
    const outcome = await h.service.certifyAccount();
    if (outcome.kind !== 'CERTIFIED') throw new Error('expected CERTIFIED');
    h.persistence.failInvalidate = true;
    expect(await h.service.stopWatch()).toEqual({ kind: 'REFUSED_AUTHORITY_OUTSTANDING', problem: 'REVOCATION_UNCONFIRMED' });
    expect(h.persistence.certificate?.record.status).toBe('ISSUED');
    // The watch still observes: a private event still trips it.
    h.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    expect(h.telemetry.events).toContainEqual(expect.objectContaining({ type: 'P18B_TRIPWIRE', reason: 'PRIVATE_STATE_EVENT' }));
    await h.service.settled();
    // Blocked, and never STILL_VALID.
    expect(await h.service.monitorAuthority()).toMatchObject({ kind: 'REVOCATION_UNCONFIRMED' });
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'DURABLE_SAFETY_UNCONFIRMED' });
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'DURABLE_SAFETY_UNCONFIRMED' });
    h.persistence.failInvalidate = false;
    expect(await h.service.stopWatch()).toEqual({ kind: 'STOPPED', revokedCertificate: true });
    expect(h.persistence.certificate?.record.status).toBe('REVOKED');
    expect(await h.service.resetAfterRevocation()).toEqual({ kind: 'RESET' });
  });

  it('stopWatch refuses when durable state cannot be read (it cannot know whether authority is outstanding)', async () => {
    const h = harness();
    await ready(h);
    await h.service.certifyAccount();
    h.persistence.failLoad = true;
    expect(await h.service.stopWatch()).toEqual({ kind: 'REFUSED_AUTHORITY_OUTSTANDING', problem: 'PERSISTENCE_UNAVAILABLE' });
    h.persistence.failLoad = false;
    expect(await h.service.monitorAuthority()).toEqual({ kind: 'CERTIFICATE_STILL_VALID' });
  });

  it('a normal stop with no authority outstanding still works, and a new watch can follow', async () => {
    const h = harness();
    await ready(h);
    expect(await h.service.stopWatch()).toEqual({ kind: 'STOPPED', revokedCertificate: false });
    expect(h.stream.listenerCount).toBe(0);
    expect(h.persistence.operations.filter((op) => op.startsWith('invalidate'))).toEqual([]);
    expect(await h.service.startWatch()).toMatchObject({ kind: 'WATCHING' });
  });

  it('a restart (new runtime epoch) after a failed revocation still adopts fail-closed: the old ISSUED certificate is revoked', async () => {
    const { h } = await trippedWithFailedRevocation();
    h.persistence.failInvalidate = false;
    const restarted = harness({ shared: h, epoch: EPOCH_B });
    expect(await restarted.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'ADOPTED', account: { state: 'QUARANTINED' } });
    expect(h.persistence.certificate?.record).toMatchObject({ status: 'REVOKED', terminalReason: 'RUNTIME_EPOCH_CHANGED' });
  });
});


describe('configuration', () => {
  it('timing values must be SHADOW-CALIBRATION CANDIDATES, never provider guarantees; enablement must be genuine', () => {
    const base = harness();
    const deps = {
      accountId: ACCOUNT, runtimeEpoch: EPOCH, expectedProviderAccountFingerprint: FINGERPRINT, enablement: enablementFor(ACCOUNT), persistence: base.persistence,
      venue: base.venue, reconciliation: base.reconciliation, privateStream: base.stream, clock: base.clock, scheduler: base.scheduler,
    };
    expect(() => new PracticalRecoveryService({ ...deps, timing: { ...PRACTICAL_TIMING_CANDIDATES, readDuration: { valueMs: 3_000, status: 'SHADOW_CALIBRATION_CANDIDATE', providerGuarantee: true as never } } }))
      .toThrow(/SHADOW_CALIBRATION_CANDIDATE/);
    expect(() => new PracticalRecoveryService({ ...deps, enablement: { accountAllowlist: [ACCOUNT] } })).toThrow(/genuine issued enablement/);
    expect(() => new PracticalRecoveryService({ ...deps, expectedProviderAccountFingerprint: 'raw-coindcx-id' })).toThrow(/fingerprint/);
  });
});

describe('P18B-B-07: ambiguous durable reads (MALFORMED / NOT_FOUND) are never benign absence', () => {
  async function certifiedHarness() {
    const h = harness();
    await ready(h);
    const outcome = await h.service.certifyAccount();
    if (outcome.kind !== 'CERTIFIED') throw new Error('expected CERTIFIED');
    return { h, outcome };
  }

  it('issued certificate + MALFORMED read: stopWatch is REFUSED, the watch keeps observing, the service is held', async () => {
    const { h } = await certifiedHarness();
    h.persistence.malformed = true;
    expect(await h.service.stopWatch()).toEqual({ kind: 'REFUSED_AUTHORITY_OUTSTANDING', problem: 'DURABLE_STATE_MALFORMED' });
    expect(h.stream.listenerCount).toBe(1);
    h.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION');
    expect(h.telemetry.events).toContainEqual(expect.objectContaining({ type: 'P18B_TRIPWIRE', reason: 'PRIVATE_STATE_EVENT' }));
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'DURABLE_SAFETY_UNCONFIRMED' });
  });

  it('issued certificate + unexpected NOT_FOUND read: stopWatch is REFUSED, the watch keeps observing', async () => {
    const { h } = await certifiedHarness();
    h.persistence.forceNotFound = true;
    expect(await h.service.stopWatch()).toEqual({ kind: 'REFUSED_AUTHORITY_OUTSTANDING', problem: 'DURABLE_STATE_NOT_FOUND' });
    expect(h.stream.listenerCount).toBe(1);
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'DURABLE_SAFETY_UNCONFIRMED' });
  });

  it('a mutation lease is authority this read-only core does not own: stopWatch refuses', async () => {
    const h = harness();
    await ready(h);
    h.persistence.fence = { ...h.persistence.fence!, mode: { kind: 'MUTATION_LEASED' } as never };
    expect(await h.service.stopWatch()).toEqual({ kind: 'REFUSED_AUTHORITY_OUTSTANDING', problem: 'MUTATION_LEASE_HELD' });
    expect(h.stream.listenerCount).toBe(1);
  });

  it('monitorAuthority + MALFORMED: REVOCATION_UNCONFIRMED (never NO_OUTSTANDING, never STILL_VALID); the in-memory certificate is revoked', async () => {
    const { h, outcome } = await certifiedHarness();
    h.persistence.malformed = true;
    expect(await h.service.monitorAuthority()).toEqual({ kind: 'REVOCATION_UNCONFIRMED', reason: 'EVIDENCE_STALE' });
    expect(PracticalRecoveryCertificate.status(outcome.certificate)).toBe('REVOKED');
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'DURABLE_SAFETY_UNCONFIRMED' });
  });

  it('monitorAuthority + unexpected NOT_FOUND after holding authority: fail closed; a never-watching service gets ACCOUNT_NOT_INITIALIZED (no proof claimed)', async () => {
    const { h } = await certifiedHarness();
    h.persistence.forceNotFound = true;
    expect(await h.service.monitorAuthority()).toEqual({ kind: 'REVOCATION_UNCONFIRMED', reason: 'EVIDENCE_STALE' });
    expect(await h.service.monitorAuthority()).not.toMatchObject({ kind: 'NO_OUTSTANDING_CERTIFICATE' });

    const fresh = harness();
    expect(await fresh.service.monitorAuthority()).toEqual({ kind: 'ACCOUNT_NOT_INITIALIZED' });
    expect(await fresh.service.startWatch()).toMatchObject({ kind: 'WATCHING' });
    expect(await fresh.service.monitorAuthority()).toEqual({ kind: 'REVOCATION_UNCONFIRMED', reason: 'EVIDENCE_STALE' });
  });

  it('after durable state is restored, the explicit reset revokes the old certificate and recovery proceeds only by a full new certification', async () => {
    const { h, outcome } = await certifiedHarness();
    h.persistence.malformed = true;
    expect(await h.service.stopWatch()).toMatchObject({ kind: 'REFUSED_AUTHORITY_OUTSTANDING' });
    expect(await h.service.resetAfterRevocation()).toEqual({ kind: 'KEPT', problem: 'ACCOUNT_MALFORMED' });
    h.persistence.malformed = false;
    expect(await h.service.resetAfterRevocation()).toEqual({ kind: 'RESET' });
    expect(h.persistence).toMatchObject({ state: 'QUARANTINED', certificate: { record: { status: 'REVOKED' } } });
    expect(await h.service.startWatch()).toMatchObject({ kind: 'WATCHING' });
    h.reconciliation.completeHealthyRun();
    const again = await h.service.certifyAccount();
    expect(again.kind).toBe('CERTIFIED');
    if (again.kind === 'CERTIFIED') expect(again.certificate.certificateId).not.toBe(outcome.certificate.certificateId);
    expect(await h.service.stopWatch()).toEqual({ kind: 'STOPPED', revokedCertificate: true });
  });
});

describe('P18B-B-08: startup NEVER preserves practical authority, whether or not the runtime epoch changed', () => {
  it('SAME runtime epoch + unexpired CERTIFIED_IDLE certificate: startup durably revokes it and ends non-authoritative', async () => {
    const a = harness();
    await ready(a);
    const issued = await a.service.certifyAccount();
    if (issued.kind !== 'CERTIFIED') throw new Error('expected CERTIFIED');
    // A service/component restart inside the same runtime epoch: a new instance, no trusted watch or provenance.
    const b = harness({ shared: a });
    expect(await b.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'REVOKED_CERTIFICATE', account: { state: 'QUARANTINED', currentCertificate: null } });
    expect(a.persistence.certificate?.record).toMatchObject({ certificateId: issued.certificate.certificateId, status: 'REVOKED', terminalReason: 'EVIDENCE_STALE' });
    expect(await b.service.monitorAuthority()).toEqual({ kind: 'NO_OUTSTANDING_CERTIFICATE', tripped: false });
  });

  it('the SAME service instance restarting also revokes its own in-memory certificate', async () => {
    const h = harness();
    await ready(h);
    const issued = await h.service.certifyAccount();
    if (issued.kind !== 'CERTIFIED') throw new Error('expected CERTIFIED');
    expect(await h.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'REVOKED_CERTIFICATE' });
    expect(PracticalRecoveryCertificate.status(issued.certificate)).toBe('REVOKED');
    expect(h.persistence.certificate?.record.status).toBe('REVOKED');
  });

  it('a NEW runtime epoch still adopts (RUNTIME_EPOCH_CHANGED)', async () => {
    const a = harness();
    await ready(a);
    await a.service.certifyAccount();
    const b = harness({ shared: a, epoch: EPOCH_B });
    expect(await b.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'ADOPTED', account: { state: 'QUARANTINED', currentCertificate: null } });
    expect(a.persistence.certificate?.record).toMatchObject({ status: 'REVOKED', terminalReason: 'RUNTIME_EPOCH_CHANGED' });
  });

  it('SAME epoch + EXPIRED certificate: terminalized as EXPIRED', async () => {
    const a = harness();
    await ready(a);
    await a.service.certifyAccount();
    a.clock.advance(120_000);
    const b = harness({ shared: a });
    expect(await b.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'EXPIRED_CERTIFICATE', account: { state: 'QUARANTINED' } });
    expect(a.persistence.certificate?.record).toMatchObject({ status: 'EXPIRED', terminalReason: 'CERTIFICATE_EXPIRED' });
  });

  it('a revocation that cannot be written: startup does NOT return READY; blocked until durable safety is proven', async () => {
    const a = harness();
    await ready(a);
    await a.service.certifyAccount();
    const b = harness({ shared: a });
    a.persistence.failInvalidate = true;
    expect(await b.service.recoverAtStartup()).toEqual({ kind: 'BLOCKED_DURABLE_SAFETY_UNCONFIRMED', problem: 'REVOCATION_UNCONFIRMED' });
    expect(a.persistence.certificate?.record.status).toBe('ISSUED');
    expect(await b.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'DURABLE_SAFETY_UNCONFIRMED' });
    expect(await b.service.monitorAuthority()).toMatchObject({ kind: 'REVOCATION_UNCONFIRMED' });
    a.persistence.failInvalidate = false;
    expect(await b.service.resetAfterRevocation()).toEqual({ kind: 'RESET' });
    expect(a.persistence.certificate?.record.status).toBe('REVOKED');
  });

  it('unreadable durable state: startup does NOT return READY; MALFORMED latches manual review', async () => {
    const h = harness();
    h.persistence.failLoad = true;
    expect(await h.service.recoverAtStartup()).toEqual({ kind: 'BLOCKED_DURABLE_SAFETY_UNCONFIRMED', problem: 'PERSISTENCE_UNREADABLE' });
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'DURABLE_SAFETY_UNCONFIRMED' });
    const m = harness();
    m.persistence.malformed = true;
    expect(await m.service.recoverAtStartup()).toEqual({ kind: 'MANUAL_REVIEW_REQUIRED', reviewEpisodeId: 'latched-1' });
  });

  it('after startup recovery: a new watch, a FRESH Phase 18 generation, and a full certification are required', async () => {
    const a = harness();
    await ready(a);
    const issued = await a.service.certifyAccount();
    if (issued.kind !== 'CERTIFIED') throw new Error('expected CERTIFIED');
    const b = harness({ shared: a });
    expect(await b.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'REVOKED_CERTIFICATE' });
    expect(await b.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'NO_ACTIVE_WATCH' });
    expect(await b.service.startWatch()).toMatchObject({ kind: 'WATCHING' });
    expect(await b.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'RECONCILIATION_GENERATION_NOT_AFTER_WATCH' });
    b.reconciliation.completeHealthyRun();
    const fresh = await b.service.certifyAccount();
    if (fresh.kind !== 'CERTIFIED') throw new Error(`expected CERTIFIED, got ${fresh.kind}`);
    expect(fresh.certificate.certificateId).not.toBe(issued.certificate.certificateId);
  });
});

/** Starts a certification and freezes it inside its run (the fence is CERTIFYING, no certificate). */
async function frozenMidRun(h: Harness): Promise<{ readonly pending: Promise<unknown> }> {
  await ready(h);
  h.scheduler.hold();
  const pending = h.service.certifyAccount();
  await new Promise((resolve) => setImmediate(resolve));
  expect(h.persistence).toMatchObject({ state: 'CERTIFYING', certificate: null });
  // Wrapped: returning the promise itself from an async function would wait for the frozen run.
  return { pending };
}

describe('P18B-B-09: stopWatch refuses while a certification owns the durable fence', () => {
  it('CERTIFYING with no certificate: stop REFUSED (CERTIFICATION_IN_PROGRESS); the watch keeps observing; nothing durable changes', async () => {
    const h = harness();
    const { pending } = await frozenMidRun(h);
    const operations = h.persistence.operations.filter((op) => !op.startsWith('load')).length;
    expect(await h.service.stopWatch()).toEqual({ kind: 'REFUSED_AUTHORITY_OUTSTANDING', problem: 'CERTIFICATION_IN_PROGRESS' });
    expect(h.stream.listenerCount).toBe(1);
    expect(h.persistence.operations.filter((op) => !op.startsWith('load'))).toHaveLength(operations);
    // The run still completes under the SAME watch (it was never told observation stopped) ...
    h.scheduler.release();
    expect(await pending).toMatchObject({ kind: 'CERTIFIED' });
    // ... and only a revoke-first stop can end it.
    expect(await h.service.stopWatch()).toEqual({ kind: 'STOPPED', revokedCertificate: true });
    expect(h.persistence.certificate?.record.status).toBe('REVOKED');
  });

  it('while a gated finishCertification owns CERTIFYING, stop can never return STOPPED', async () => {
    const h = harness();
    await ready(h);
    let open!: () => void;
    let reach!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    h.persistence.beforeFinish = async () => { reach(); await gate; };
    const pending = h.service.certifyAccount();
    await reached;
    expect(await h.service.stopWatch()).toEqual({ kind: 'REFUSED_AUTHORITY_OUTSTANDING', problem: 'CERTIFICATION_IN_PROGRESS' });
    expect(h.stream.listenerCount).toBe(1);
    open();
    expect(await pending).toMatchObject({ kind: 'CERTIFIED' });
    expect(await h.service.stopWatch()).toEqual({ kind: 'STOPPED', revokedCertificate: true });
  });

  it('after the run safely fails and releases the fence, a normal no-authority stop works', async () => {
    const h = harness();
    await ready(h);
    h.venue.behavior = (kind, index) => (kind === 'POSITIONS' && index === 1 ? { kind: 'THROW' } : undefined);
    expect(await h.service.certifyAccount()).toMatchObject({ kind: 'FAILED', released: true });
    expect(await h.service.stopWatch()).toEqual({ kind: 'STOPPED', revokedCertificate: false });
    expect(h.stream.listenerCount).toBe(0);
  });
});

describe('P18B-B-10: startup is never READY with active fence authority, in ANY runtime epoch', () => {
  it.each([
    ['a MUTATION_LEASED fence', (h: Harness) => { h.persistence.fence = { ...h.persistence.fence!, mode: { kind: 'MUTATION_LEASED' } as never }; }],
    ['a MUTATING state', (h: Harness) => { h.persistence.state = 'MUTATING'; }],
  ])('SAME epoch + %s -> BLOCKED_MUTATION_LEASE_HELD', async (_label, lease) => {
    const a = harness();
    await ready(a);
    lease(a);
    const b = harness({ shared: a });
    expect(await b.service.recoverAtStartup()).toMatchObject({ kind: 'BLOCKED_MUTATION_LEASE_HELD' });
    expect(a.persistence.operations).not.toContain('adoptForNewRuntime');
  });

  it('DIFFERENT epoch + MUTATION_LEASED -> the existing block remains (no adoption)', async () => {
    const a = harness();
    await ready(a);
    a.persistence.fence = { ...a.persistence.fence!, mode: { kind: 'MUTATION_LEASED' } as never };
    const b = harness({ shared: a, epoch: EPOCH_B });
    expect(await b.service.recoverAtStartup()).toMatchObject({ kind: 'BLOCKED_MUTATION_LEASE_HELD' });
    expect(a.persistence.operations).not.toContain('adoptForNewRuntime');
  });

  it('SAME epoch + CERTIFYING (an earlier lifetime\'s run) -> never READY; blocked; no ownership invented', async () => {
    const a = harness();
    await frozenMidRun(a);
    const b = harness({ shared: a });
    expect(await b.service.recoverAtStartup()).toEqual({ kind: 'BLOCKED_DURABLE_SAFETY_UNCONFIRMED', problem: 'CERTIFICATION_IN_PROGRESS' });
    expect(a.persistence).toMatchObject({ state: 'CERTIFYING' });
    expect(a.persistence.operations.filter((op) => op.startsWith('failCertification') || op === 'adoptForNewRuntime')).toEqual([]);
    expect(await b.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'DURABLE_SAFETY_UNCONFIRMED' });
    // A later runtime epoch uses the reviewed adoption path.
    const c = harness({ shared: a, epoch: EPOCH_B });
    expect(await c.service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'ADOPTED', account: { state: 'QUARANTINED', fence: { mode: { kind: 'IDLE' } } } });
  });

  it('SAME epoch QUARANTINED/IDLE -> READY UNCHANGED; SAME epoch PROVIDER_UNAVAILABLE -> READY (non-authoritative)', async () => {
    const a = harness();
    await ready(a);
    expect(await harness({ shared: a }).service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'UNCHANGED', account: { state: 'QUARANTINED' } });
    a.venue.behavior = (kind, index) => (kind === 'ORDERS' && index === 0 ? { kind: 'THROW' } : undefined);
    expect(await a.service.certifyAccount()).toMatchObject({ kind: 'FAILED', failure: 'PROVIDER_UNAVAILABLE' });
    expect(await harness({ shared: a }).service.recoverAtStartup()).toMatchObject({ kind: 'READY', action: 'UNCHANGED', account: { state: 'PROVIDER_UNAVAILABLE' } });
  });
});

describe('P18B-B-11: the final pre-issuance stream guard runs AFTER the generation await', () => {
  /** Triggers `change` inside the FINAL pre-issuance Phase 18 read (the second read after the last venue read). */
  function duringFinalPreIssuanceRead(h: Harness, change: () => void): void {
    let readsAfterLastPass = 0;
    h.reconciliation.onLoad = () => {
      if (h.venue.calls.length !== 21) return;
      readsAfterLastPass += 1;
      if (readsAfterLastPass === 2) change();
    };
  }

  it.each([
    ['a private state event', (h: Harness) => { h.stream.emit('PRIVATE_POSITION_UPDATE_NOTIFICATION'); }, 'PRIVATE_STATE_EVENT'],
    ['a silent readiness loss', (h: Harness) => { h.stream.unprove(); }, 'WS_JOIN_FAILED'],
  ])('%s during that await: nothing is issued or persisted; SUPERSEDED', async (_label, change, reason) => {
    const h = harness();
    await ready(h);
    duringFinalPreIssuanceRead(h, () => change(h));
    expect(await h.service.certifyAccount()).toMatchObject({ kind: 'SUPERSEDED', reason });
    expect(h.persistence.operations).not.toContain('finishCertification');
    expect(h.persistence.certificate).toBeNull();
    expect(h.persistence.state).toBe('QUARANTINED');
    expect(h.persistence.fence).toMatchObject({ mode: { kind: 'IDLE' } });
    expect(h.telemetry.events.some((event) => event.type === 'P18B_CERTIFICATION' && event.outcome === 'CERTIFIED')).toBe(false);
  });

  it('an unchanged stream through that await still certifies', async () => {
    const h = harness();
    await ready(h);
    duringFinalPreIssuanceRead(h, () => undefined);
    expect((await h.service.certifyAccount()).kind).toBe('CERTIFIED');
  });
});

describe('P18B-B-12: the startWatch Phase 18 baseline is bound to EXACTLY this account', () => {
  it('a row of ANOTHER account: the watch is not established and the wrong baseline is never stored', async () => {
    const h = harness();
    await h.service.recoverAtStartup();
    h.reconciliation.transform = (state) => ({ ...state, accountId: 'account-live-2' });
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'RECONCILIATION_ACCOUNT_MISMATCH' });
    expect(h.stream.listenerCount).toBe(0);
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'NO_ACTIVE_WATCH' });
  });

  it.each([
    ['a padded id', ` ${'account-live-1'}`],
    ['a case variant', 'ACCOUNT-LIVE-1'],
  ])('ids are never normalized (%s)', async (_label, accountId) => {
    const h = harness();
    await h.service.recoverAtStartup();
    h.reconciliation.transform = (state) => ({ ...state, accountId });
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'RECONCILIATION_ACCOUNT_MISMATCH' });
  });

  it('B at generation 0 while A is already at generation 10: A\'s OLD generation 10 never becomes eligible through the wrong baseline', async () => {
    const h = harness();
    await h.service.recoverAtStartup();
    for (let run = 0; run < 10; run += 1) h.reconciliation.completeHealthyRun();
    expect(h.reconciliation.state.currentGeneration).toBe(10);
    h.reconciliation.transform = (state) => ({ ...state, accountId: 'account-live-2', currentGeneration: 0, healthyGeneration: 0 });
    expect(await h.service.startWatch()).toMatchObject({ kind: 'NOT_READY' });
    h.reconciliation.transform = (state) => state;
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'NO_ACTIVE_WATCH' });
    // The correct baseline is 10: generation 10 is NOT after the watch; only a fresh generation is.
    expect(await h.service.startWatch()).toMatchObject({ kind: 'WATCHING', reconciliationGenerationAtArm: 10 });
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'RECONCILIATION_GENERATION_NOT_AFTER_WATCH' });
    h.reconciliation.completeHealthyRun();
    const outcome = await h.service.certifyAccount();
    if (outcome.kind !== 'CERTIFIED') throw new Error(`expected CERTIFIED, got ${outcome.kind}`);
    expect(PracticalRecoveryCertificate.read(outcome.certificate)!.reconciliationGeneration).toBe(11);
  });

  it('a malformed generation is still refused; a trip during the baseline await is still refused', async () => {
    const h = harness();
    await h.service.recoverAtStartup();
    h.reconciliation.transform = (state) => ({ ...state, currentGeneration: -1 });
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'RECONCILIATION_STATE_UNAVAILABLE' });
    h.reconciliation.transform = (state) => ({ ...state, currentGeneration: 1.5 });
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'RECONCILIATION_STATE_UNAVAILABLE' });
    h.reconciliation.transform = (state) => state;
    h.reconciliation.onLoad = () => { h.reconciliation.onLoad = () => undefined; h.stream.emit('PRIVATE_ORDER_UPDATE_NOTIFICATION'); };
    expect(await h.service.startWatch()).toEqual({ kind: 'NOT_READY', reason: 'WATCH_TRIPPED_WHILE_ARMING' });
    expect(await h.service.certifyAccount()).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'WATCH_TRIPPED' });
  });
});
