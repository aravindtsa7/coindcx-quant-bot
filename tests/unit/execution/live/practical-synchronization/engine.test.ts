import { describe, expect, it } from 'vitest';
import { LiveExecutionAuthority } from '../../../../../src/execution/live/authority';
import { PracticalRecoveryCertificate } from '../../../../../src/execution/live/practical/certificate';
import { GRANTS_NOTHING, type ObservationComponent, type PrivateStreamObservation } from '../../../../../src/execution/live/practical-observation/assessment';
import { practicalPrivateStreamReadiness } from '../../../../../src/execution/live/practical-recovery/private-events';
import {
  canonicalDecimal,
  runSynchronizationCandidate,
  type SyncComponentScan,
  type SynchronizationConfig,
  type SynchronizationResult,
  type SynchronizationSource,
  type SyncProviderContracts,
  type SyncTransactionEvidence,
} from '../../../../../src/execution/live/practical-synchronization/engine';
import { currentAccountContinuityCapability } from '../../../../../src/execution/live/reconciliation/barrier';
import { LiveReconciliationAuthorization } from '../../../../../src/execution/live/reconciliation/repository';
import type { LiveVenueOrderEvidence, LiveVenuePositionEvidence } from '../../../../../src/execution/live/reconciliation/types';
import { consumeMutationPermit } from '../../../../../src/integration/coindcx/rate-limit/runtime/mutation-budget';

// M4 synchronization candidate. Synthetic fixtures only; every limit and threshold here is a test value, not a default.
const ACCOUNT = 'synthetic-account';

function order(overrides: Partial<LiveVenueOrderEvidence> = {}): LiveVenueOrderEvidence {
  return {
    exchangeOrderId: 'ex-1', pair: 'B-BTC_USDT', side: 'BUY', venueStatus: 'open', orderedQuantity: '0.5', filledQuantity: '0',
    remainingQuantity: '0.5', cancelledQuantity: '0', averageFillPrice: null, price: '64000.5', wireOrderType: 'limit_order', leverage: '5',
    providerCreatedAtMs: 1_000, providerEventTimeMs: 1_500, clientOrderId: 'bot-0001', ...overrides,
  };
}
function position(overrides: Partial<LiveVenuePositionEvidence> = {}): LiveVenuePositionEvidence {
  return { venuePositionId: 'pos-1', pair: 'B-BTC_USDT', signedQuantity: '0.5', averageEntryPrice: '64000.5', leverage: '5', providerEventTimeMs: 1_600, ...overrides };
}
function txn(overrides: Partial<SyncTransactionEvidence> = {}): SyncTransactionEvidence {
  return { category: 'FILL', fillId: { field: 'id', value: 'fill-1' }, parentExchangeOrderId: 'ex-1', stage: null, amount: '0.5', currency: 'USDT', providerEventTimeMs: 1_700, ...overrides };
}
function stream(overrides: Partial<PrivateStreamObservation> = {}): PrivateStreamObservation {
  return { connected: true, epoch: 7, epochAtWindowStart: 7, disconnectObservedSinceWindowStart: false, reconnectLatched: false,
    joinAcknowledgement: { kind: 'UNKNOWN' }, events: [], bufferedUnprocessedEvents: 0, ...overrides };
}
function config(overrides: Partial<SynchronizationConfig> = {}, scope: Partial<SynchronizationConfig['scope']> = {}): SynchronizationConfig {
  return {
    mode: 'FULL_EVIDENCE',
    scope: { accountId: ACCOUNT, components: ['ORDERS', 'POSITIONS'], requiredAccounting: [], history: { kind: 'AVAILABLE_HISTORY' }, ...scope },
    scanLimits: { ORDERS: { pageSize: 2, maxPages: 3 }, POSITIONS: { pageSize: 2, maxPages: 3 }, TRANSACTIONS: { pageSize: 2, maxPages: 3 } },
    thresholds: { maxEvidenceAgeMs: 5_000, maxTotalReadDurationMs: 2_000 },
    maxCycles: 2,
    lineage: { ownedOrders: [{ exchangeOrderId: 'ex-1', intentId: 'intent-1' }], ambiguousCreates: [], closedIntentTags: [], ownedPositions: ['pos-1'], botTagNamespace: 'bot-' },
    contracts: { tagContract: { confirmed: false }, venueGeneratedOrderTypes: null, venueGeneratedWalletStages: null, terminalShortPage: {} },
    ...overrides,
  };
}

type Pages = readonly (readonly unknown[])[];
interface FixtureOptions {
  pages?: (cycle: number, pass: 0 | 1, component: ObservationComponent) => Pages | SyncComponentScan | 'THROW';
  stream?: (cycle: number, point: 'CYCLE_START' | 'EVALUATION') => PrivateStreamObservation | 'THROW';
  accountScope?: (component: ObservationComponent) => Readonly<{ kind: 'CONFIRMED'; accountId: string }> | Readonly<{ kind: 'UNKNOWN' }>;
}
/** Each default scan is one short page followed by an empty page: the terminal-page contract is unknown by default. */
const DEFAULT_PAGES: Record<ObservationComponent, Pages> = { ORDERS: [[order()], []], POSITIONS: [[position()], []], TRANSACTIONS: [[txn()], []] };
/** Cycle c reads pass 0 at base+0..., pass 1 at base+300..., evaluation at base+800 (base = 10_000 + 1_000c). */
function fixtureSource(options: FixtureOptions = {}): SynchronizationSource & { requests: unknown[] } {
  const requests: unknown[] = [];
  const offsets: Record<ObservationComponent, number> = { ORDERS: 0, POSITIONS: 100, TRANSACTIONS: 200 };
  return {
    requests,
    scan(request) {
      requests.push(request);
      const value = options.pages?.(request.cycle, request.pass, request.component) ?? DEFAULT_PAGES[request.component];
      if (value === 'THROW') throw new Error('synthetic read failure');
      if (!Array.isArray(value)) return value as SyncComponentScan;
      const startedAtMs = 10_000 + request.cycle * 1_000 + request.pass * 300 + offsets[request.component];
      return { kind: 'SCANNED', accountScope: options.accountScope?.(request.component) ?? { kind: 'CONFIRMED', accountId: ACCOUNT }, startedAtMs, endedAtMs: startedAtMs + 50, pages: value };
    },
    stream(request) {
      requests.push(request);
      const value = options.stream?.(request.cycle, request.point) ?? stream();
      if (value === 'THROW') throw new Error('synthetic stream failure');
      return value;
    },
    clock(request) { requests.push({ clock: request.cycle }); return 10_000 + request.cycle * 1_000 + 800; },
  };
}
const run = (c: SynchronizationConfig = config(), options: FixtureOptions = {}): SynchronizationResult => runSynchronizationCandidate(c, fixtureSource(options));
const last = (result: SynchronizationResult) => result.cycles[result.cycles.length - 1]!;
const record = (result: SynchronizationResult, key: string, pass: 0 | 1 = 0) => last(result).records.filter((entry) => entry.pass === pass).flatMap((entry) => entry.records).find((entry) => entry.key === key);
/** Same pages in both passes, with `ORDERS` replaced exactly as given. */
const withOrderPages = (orders: readonly unknown[][]) => ({ pages: (_c: number, _p: 0 | 1, component: ObservationComponent) => (component === 'ORDERS' ? orders : DEFAULT_PAGES[component]) });
/** As `withOrderPages`, with a terminating empty page appended (for ownership-focused tests). */
const withOrders = (orders: readonly unknown[][]) => withOrderPages([...orders, []]);

describe('M4 two-pass observation over a declared scope', () => {
  it('two agreeing passes of owned records are observed convergence within the declared scan scope only', () => {
    const source = fixtureSource();
    const result = runSynchronizationCandidate(config(), source);
    expect(result.status).toBe('OBSERVED_CONVERGENCE');
    expect(result.semantics).toBe('OBSERVED_CONVERGENCE_WITHIN_DECLARED_SCAN_SCOPE');
    expect(result.historyCompleteness).toEqual({ status: 'UNPROVEN', reasons: ['OBSERVED_TERMINATION_IS_NOT_PROOF_OF_COMPLETE_HISTORY', 'PAGINATION_SEMANTICS_UNKNOWN', 'RETENTION_UNKNOWN'] });
    expect(result.cycles).toHaveLength(1);
    expect(last(result).terminations.map((t) => t.termination)).toEqual(Array(4).fill('OBSERVED_EMPTY_PAGE'));
    expect(record(result, 'order:ex-1')).toMatchObject({ identity: 'EXCHANGE_ORDER_ID', ownership: 'OWNED', reason: 'BOT_CREATE_RESPONSE' });
    expect(record(result, 'position:pos-1')).toMatchObject({ identity: 'VENUE_POSITION_ID', ownership: 'OWNED', reason: 'DURABLE_OWNERSHIP_RECORD' });
    expect(result.grants).toBe(GRANTS_NOTHING);
    // Reads go through the injected source only, with the declared account, scan limits and history scope.
    expect(source.requests[0]).toEqual({ cycle: 0, point: 'CYCLE_START' });
    expect(source.requests[1]).toEqual({ cycle: 0, pass: 0, component: 'ORDERS', accountId: ACCOUNT, limits: { pageSize: 2, maxPages: 3 }, history: { kind: 'AVAILABLE_HISTORY' } });
    expect(source.requests.slice(-2)).toEqual([{ cycle: 0, point: 'EVALUATION' }, { clock: 0 }]);
  });

  it('a fill that changes state between the passes is a disagreement, never convergence', () => {
    const result = run(config(), { pages: (_c, pass, component) => (component === 'ORDERS'
      ? [[order(pass === 0 ? {} : { filledQuantity: '0.2', remainingQuantity: '0.3', venueStatus: 'partially_filled' })], []] : DEFAULT_PAGES[component]) });
    expect(result.status).toBe('UNRESOLVED');
    expect(last(result).reasons).toEqual(['RECORDS_DISAGREE']);
  });

  it('a declared history window is passed to the source, and still proves nothing about completeness', () => {
    const source = fixtureSource();
    const result = runSynchronizationCandidate(config({}, { history: { kind: 'DECLARED_WINDOW', fromMs: 0, toMs: 9_000 } }), source);
    expect((source.requests[1] as { history: unknown }).history).toEqual({ kind: 'DECLARED_WINDOW', fromMs: 0, toMs: 9_000 });
    expect(result.history).toEqual({ kind: 'DECLARED_WINDOW', fromMs: 0, toMs: 9_000 });
    expect(result.historyCompleteness.status).toBe('UNPROVEN');
  });
});

describe('M4 ownership: the seven register §5 scenarios', () => {
  const lineage = config().lineage;
  it('1. a bot-looking tag with no local intent is UNRESOLVED', () => {
    const result = run(config(), withOrders([[order({ exchangeOrderId: 'ex-9', clientOrderId: 'bot-9999' })]]));
    expect(record(result, 'order:ex-9')).toMatchObject({ ownership: 'UNRESOLVED', reason: 'TAG_WITHOUT_DURABLE_INTENT' });
    expect(last(result).reasons).toEqual(['OWNERSHIP_UNRESOLVED']);
  });

  it('2. an ambiguous create with exactly one matching durable intent is OWNED only under a confirmed contract and an exact field match', () => {
    const venueOrder = order({ exchangeOrderId: 'ex-7', clientOrderId: 'bot-0007' });
    const candidate = { intentId: 'intent-7', accountId: ACCOUNT, tag: 'bot-0007', pair: 'B-BTC_USDT', side: 'BUY' as const, orderedQuantity: '0.50', price: '64000.50', wireOrderType: 'limit_order', leverage: '5' };
    const confirmed = { tagContract: { confirmed: true as const, field: 'client_order_id' as const, botCreatesAlwaysTagged: false }, venueGeneratedOrderTypes: null, venueGeneratedWalletStages: null, terminalShortPage: {} };
    const withCandidates = (candidates: (typeof candidate)[], contracts: SyncProviderContracts = confirmed) => config({ lineage: { ...lineage, ambiguousCreates: candidates }, contracts });
    const resolved = run(withCandidates([candidate]), withOrders([[venueOrder]]));
    expect(record(resolved, 'order:ex-7')).toMatchObject({ ownership: 'OWNED', reason: 'RESOLVED_UNDER_CONFIRMED_CONTRACT' });
    expect(resolved.status).toBe('OBSERVED_CONVERGENCE');
    expect(record(run(withCandidates([candidate], config().contracts), withOrders([[venueOrder]])), 'order:ex-7')).toMatchObject({ ownership: 'UNRESOLVED', reason: 'TAG_CONTRACT_UNCONFIRMED' });
    expect(record(run(withCandidates([{ ...candidate, orderedQuantity: '0.6' }]), withOrders([[venueOrder]])), 'order:ex-7')).toMatchObject({ reason: 'CANDIDATE_FIELD_MISMATCH' });
    expect(record(run(withCandidates([candidate, { ...candidate, intentId: 'intent-8' }]), withOrders([[venueOrder]])), 'order:ex-7')).toMatchObject({ reason: 'AMBIGUOUS_MULTIPLE_CANDIDATES' });
    // A contract confirmed for `client_id` is not applied to the evidence's `client_order_id`: no renaming.
    const clientId = { ...confirmed, tagContract: { confirmed: true as const, field: 'client_id' as const, botCreatesAlwaysTagged: false } };
    expect(record(run(withCandidates([candidate], clientId), withOrders([[venueOrder]])), 'order:ex-7')).toMatchObject({ ownership: 'UNRESOLVED', reason: 'TAG_CONTRACT_UNCONFIRMED' });
  });

  it('3. conflicting or reused tags (two venue orders with one tag, or a closed intent tag) are UNRESOLVED', () => {
    const twins = run(config(), withOrders([[order({ exchangeOrderId: 'ex-5', clientOrderId: 'bot-0005' }), order({ exchangeOrderId: 'ex-6', clientOrderId: 'bot-0005' })], []]));
    expect([record(twins, 'order:ex-5')?.reason, record(twins, 'order:ex-6')?.reason]).toEqual(['TAG_CONFLICT', 'TAG_CONFLICT']);
    const closed = run(config({ lineage: { ...lineage, closedIntentTags: ['bot-0005'] } }), withOrders([[order({ exchangeOrderId: 'ex-5', clientOrderId: 'bot-0005' })]]));
    expect(record(closed, 'order:ex-5')).toMatchObject({ ownership: 'UNRESOLVED', reason: 'TAG_CONFLICT' });
  });

  it.each([['over-length', `bot-${'x'.repeat(33)}`], ['whitespace', 'bot 0001'], ['empty', '']])('4. a malformed (%s) tag is UNRESOLVED', (_label, tag) => {
    expect(record(run(config(), withOrders([[order({ exchangeOrderId: 'ex-4', clientOrderId: tag })]])), 'order:ex-4')).toMatchObject({ ownership: 'UNRESOLVED', reason: 'TAG_MALFORMED' });
  });

  it('5. venue-generated liquidation or TP/SL is VENUE_GENERATED only with confirmed fields; otherwise UNRESOLVED', () => {
    const liquidation = withOrders([[order({ exchangeOrderId: 'ex-l', clientOrderId: null, wireOrderType: 'liquidation' })]]);
    const confirmed = run(config({ contracts: { ...config().contracts, venueGeneratedOrderTypes: ['liquidation'] } }), liquidation);
    expect(record(confirmed, 'order:ex-l')).toMatchObject({ ownership: 'VENUE_GENERATED', reason: 'VENUE_GENERATED_CONFIRMED_TYPE' });
    expect(last(confirmed).reasons).toEqual(['VENUE_GENERATED_CHANGE']); // quarantine and re-sync, never adoption
    expect(record(run(config(), liquidation), 'order:ex-l')).toMatchObject({ ownership: 'UNRESOLVED', reason: 'TAG_MISSING' });
  });

  it('6. an unexplained wallet change (possibly funding) is UNRESOLVED, never zero, and its stage is not interpreted', () => {
    const scope = { components: ['ORDERS', 'TRANSACTIONS'] as ObservationComponent[] };
    const wallet = { pages: (_c: number, _p: 0 | 1, component: ObservationComponent) => (component === 'TRANSACTIONS'
      ? [[txn({ category: 'WALLET', fillId: null, parentExchangeOrderId: null, stage: 'funding', amount: '-1.25' })], []] : DEFAULT_PAGES[component]) };
    for (const mode of ['FULL_EVIDENCE', 'CUMULATIVE_STATE'] as const) {
      const result = run(config({ mode }, scope), wallet);
      const entry = last(result).records.flatMap((r) => r.records).find((r) => r.reason === 'WALLET_CHANGE_UNEXPLAINED');
      expect(entry, mode).toMatchObject({ ownership: 'UNRESOLVED', identity: 'CONTENT_ONLY', stageInterpretation: 'UNCONFIRMED' });
      expect(entry?.fingerprint, mode).toContain('amount="-1.25"');
      expect(result.status, mode).toBe('UNRESOLVED');
    }
    const confirmed = run(config({ contracts: { ...config().contracts, venueGeneratedWalletStages: ['funding'] } }, scope), wallet);
    expect(last(confirmed).records.flatMap((r) => r.records).find((r) => r.identity === 'CONTENT_ONLY')).toMatchObject({ ownership: 'VENUE_GENERATED', stageInterpretation: 'CONFIRMED_VENUE_GENERATED' });
    expect(confirmed.status).toBe('UNRESOLVED');
  });

  it('7. a missing tag outside lineage is UNRESOLVED; FOREIGN_OBSERVED only under a confirmed contract that makes it so', () => {
    const untagged = withOrders([[order({ exchangeOrderId: 'ex-u', clientOrderId: null })]]);
    expect(record(run(config(), untagged), 'order:ex-u')).toMatchObject({ ownership: 'UNRESOLVED', reason: 'TAG_MISSING' });
    const alwaysTagged = { ...config().contracts, tagContract: { confirmed: true as const, field: 'client_order_id' as const, botCreatesAlwaysTagged: true } };
    expect(record(run(config({ contracts: alwaysTagged }), untagged), 'order:ex-u')).toMatchObject({ ownership: 'FOREIGN_OBSERVED', reason: 'UNTAGGED_UNDER_CONFIRMED_CONTRACT' });
    expect(record(run(config(), withOrders([[order({ exchangeOrderId: 'ex-f', clientOrderId: 'web-1' })]])), 'order:ex-f')).toMatchObject({ reason: 'TAG_OUTSIDE_NAMESPACE_UNCONFIRMED' });
  });

  it('a matching tag alone never establishes ownership, and a fill inherits only an OWNED parent', () => {
    // The owned order's own tag on a different exchange order id is still not lineage.
    expect(record(run(config(), withOrders([[order({ exchangeOrderId: 'ex-2', clientOrderId: 'bot-0001' })]])), 'order:ex-2')).toMatchObject({ ownership: 'UNRESOLVED' });
    const fills = { pages: (_c: number, _p: 0 | 1, component: ObservationComponent) => (component === 'TRANSACTIONS'
      ? [[txn(), txn({ fillId: { field: 'id', value: 'fill-2' }, parentExchangeOrderId: 'ex-unknown' })], []] : DEFAULT_PAGES[component]) };
    const result = run(config({}, { components: ['ORDERS', 'TRANSACTIONS'] }), fills);
    expect(record(result, 'txn:fill:id:fill-1')).toMatchObject({ ownership: 'OWNED', reason: 'OWNED_PARENT_ORDER', identity: 'PROVIDER_FILL_ID' });
    expect(record(result, 'txn:fill:id:fill-2')).toMatchObject({ ownership: 'UNRESOLVED', reason: 'FILL_PARENT_NOT_OWNED' });
    const unowned = run(config({ lineage: { ...lineage, ownedPositions: [] } }));
    expect(record(unowned, 'position:pos-1')).toMatchObject({ ownership: 'UNRESOLVED', reason: 'NO_DURABLE_POSITION_OWNERSHIP' });
  });
});

describe('M4 scans: pagination, duplicates, page shifts, truncation and failures', () => {
  const owning = (ids: string[]) => config({ lineage: { ...config().lineage, ownedOrders: ids.map((id) => ({ exchangeOrderId: id, intentId: `intent-${id}` })) } });
  const a = order({ exchangeOrderId: 'a', clientOrderId: 'bot-a' });
  const b = order({ exchangeOrderId: 'b', clientOrderId: 'bot-b' });
  const c = order({ exchangeOrderId: 'c', clientOrderId: 'bot-c' });
  const findings = (result: SynchronizationResult) => last(result).scanFindings.map((f) => `${f.pass}:${f.finding}:${String(f.blocking)}`);

  it('an observed page shift (the same record on two pages) is unresolved', () => {
    const result = run(owning(['a', 'b', 'c']), withOrderPages([[a, b], [b, c], []]));
    expect(findings(result)).toEqual(['0:PAGE_SHIFT_OBSERVED:true', '1:PAGE_SHIFT_OBSERVED:true']);
    expect(result.status).toBe('UNRESOLVED');
    expect(last(result).reasons).toEqual(expect.arrayContaining(['PAGE_SHIFT_OBSERVED', 'PAGINATION_UNKNOWN']));
  });

  it('a conflicting duplicate is unresolved; an identical duplicate on one page is deduplicated and recorded', () => {
    const conflicting = run(owning(['a']), withOrderPages([[a, { ...a, filledQuantity: '0.1' }], []]));
    expect(findings(conflicting)).toEqual(['0:CONFLICTING_DUPLICATE:true', '1:CONFLICTING_DUPLICATE:true']);
    expect(conflicting.status).toBe('UNRESOLVED');
    const identical = run(owning(['a']), withOrderPages([[a, a], []]));
    expect(findings(identical)).toEqual(['0:IDENTICAL_DUPLICATE_DEDUPED:false', '1:IDENTICAL_DUPLICATE_DEDUPED:false']);
    expect(identical.status).toBe('OBSERVED_CONVERGENCE');
  });

  it('reaching the configured scan boundary is truncation, not completeness', () => {
    const result = run(owning(['a', 'b', 'c']), withOrderPages([[a, b], [c, a], [b, c]].map((page, index) => (index === 0 ? page : page.map((o, i) => ({ ...o, exchangeOrderId: `${o.exchangeOrderId}${index}${i}` }))))));
    expect(last(result).terminations.filter((t) => t.component === 'ORDERS').map((t) => t.termination)).toEqual(['SCAN_BOUNDARY_REACHED', 'SCAN_BOUNDARY_REACHED']);
    expect(last(result).reasons).toEqual(expect.arrayContaining(['PAGINATION_TRUNCATED', 'SCAN_BOUNDARY_REACHED']));
  });

  it('an empty page ends the scan but proves nothing about history; an unobserved termination is unresolved', () => {
    const empty = run(config({}, { components: ['POSITIONS'] }), { pages: () => [[]] });
    expect(empty.status).toBe('OBSERVED_CONVERGENCE');
    expect(last(empty).terminations.map((t) => t.termination)).toEqual(['OBSERVED_EMPTY_PAGE', 'OBSERVED_EMPTY_PAGE']);
    expect(empty.historyCompleteness.status).toBe('UNPROVEN');
    // Full pages that stop before the limit, or no pages at all: termination was never observed.
    expect(last(run(owning(['a', 'b']), withOrderPages([[a, b]]))).reasons).toEqual(expect.arrayContaining(['TERMINATION_UNOBSERVED', 'PAGINATION_UNKNOWN']));
    expect(last(run(config(), withOrderPages([]))).reasons).toEqual(expect.arrayContaining(['TERMINATION_UNOBSERVED']));
    // Records after a short page contradict termination.
    expect(last(run(owning(['a', 'b']), withOrderPages([[a], [b]]))).reasons).toEqual(expect.arrayContaining(['RECORDS_AFTER_SHORT_PAGE']));
  });

  it('failed reads, thrown reads, scans over the page limit and malformed records are explicit, never silently skipped', () => {
    expect(last(run(config(), { pages: (_c, pass, component) => (pass === 1 && component === 'ORDERS' ? { kind: 'FAILED' } : DEFAULT_PAGES[component]) })).reasons)
      .toEqual(expect.arrayContaining(['READ_FAILED']));
    expect(last(run(config(), { pages: (_c, _p, component) => (component === 'POSITIONS' ? 'THROW' : DEFAULT_PAGES[component]) })).reasons).toEqual(expect.arrayContaining(['READ_FAILED']));
    expect(last(run(config(), withOrderPages([[a], [], [], []]))).reasons).toEqual(expect.arrayContaining(['SCAN_LIMIT_VIOLATED']));
    expect(last(run(config(), withOrderPages([[{ ...order(), orderedQuantity: 'half' }]]))).reasons).toEqual(expect.arrayContaining(['RECORD_MALFORMED']));
  });

  it('a scan bound to another account, or to an unknown account, is never convergence', () => {
    expect(last(run(config(), { accountScope: () => ({ kind: 'CONFIRMED', accountId: 'other' }) })).reasons).toEqual(['ACCOUNT_SCOPE_MISMATCH']);
    expect(last(run(config(), { accountScope: () => ({ kind: 'UNKNOWN' }) })).reasons).toEqual(['ACCOUNT_SCOPE_UNKNOWN']);
  });
});

describe('M4 private events, reconnects and epochs revoke; quiet streams prove nothing', () => {
  it('an event that conflicts with two agreeing REST reads revokes the cycle, and a fresh cycle is observed', () => {
    const source = fixtureSource({ stream: (cycle, point) => (cycle === 0 && point === 'EVALUATION' ? stream({ events: [{ observedAtMs: 10_400 }] }) : stream()) });
    const result = runSynchronizationCandidate(config(), source);
    expect(result.cycles.map((cycle) => cycle.status)).toEqual(['REVOKED', 'OBSERVED_CONVERGENCE']);
    expect(result.cycles[0]!.reasons).toEqual(['EVENT_DURING_OR_AFTER_WINDOW']);
    expect(result.status).toBe('OBSERVED_CONVERGENCE');
    // The second cycle re-read everything; nothing from the revoked cycle was reused.
    expect(source.requests.filter((request) => (request as { cycle?: number; pass?: number }).cycle === 1 && 'pass' in (request as object))).toHaveLength(4);
  });

  it('revocation in every cycle ends at the cycle limit, unresolved', () => {
    const result = run(config({ maxCycles: 2 }), { stream: (_c, point) => (point === 'EVALUATION' ? stream({ bufferedUnprocessedEvents: 1 }) : stream()) });
    expect(result.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
    expect(result.cycles.map((cycle) => cycle.reasons)).toEqual([['BUFFERED_EVENTS_PENDING'], ['BUFFERED_EVENTS_PENDING']]);
  });

  it.each([
    ['an epoch change during the cycle (reconnect)', (_c: number, point: string) => (point === 'EVALUATION' ? stream({ epoch: 8, epochAtWindowStart: 8 }) : stream()), 'EPOCH_CHANGED'],
    ['a disconnected stream at cycle start', (_c: number, point: string) => (point === 'CYCLE_START' ? stream({ connected: false }) : stream()), 'DISCONNECT_DURING_WINDOW'],
    ['the reconnect latch', () => stream({ reconnectLatched: true }), 'RECONNECT_LATCHED'],
    ['an unavailable stream', (_c: number, point: string) => (point === 'EVALUATION' ? 'THROW' as const : stream()), 'STREAM_DISCONNECTED'],
  ])('%s invalidates the evidence', (_label, streamFixture, reason) => {
    const result = run(config({ maxCycles: 1 }), { stream: streamFixture as NonNullable<FixtureOptions['stream']> });
    expect(result.status).toBe('REVOKED_CYCLE_LIMIT_REACHED');
    expect(result.cycles[0]!.reasons).toContain(reason);
  });

  it('a quiet stream is recorded, never credited, and never described as readiness or synchronization', () => {
    const result = run();
    const assessment = last(result).assessment;
    expect(assessment.stream).toMatchObject({ quietStream: true, quietStreamProvesNoActivity: false, privateStreamReadiness: 'NOT_ASSESSED', joinAcknowledgement: 'UNKNOWN' });
    expect(assessment.providerSynchronization.status).toBe('NOT_ESTABLISHED');
    expect(JSON.stringify(result)).not.toMatch(/READY|SYNCHRONIZED|\bPROVEN|SATISFIED/);
  });
});

describe('M4 cumulative mode: cumulative state compared, fill-level accounting UNKNOWN', () => {
  const noIds = { pages: (_c: number, _p: 0 | 1, component: ObservationComponent) => (component === 'TRANSACTIONS' ? [[txn({ fillId: null })], []] : DEFAULT_PAGES[component]) };
  const scope = { components: ['ORDERS', 'TRANSACTIONS'] as ObservationComponent[] };

  it('missing fill identifiers: cumulative comparison proceeds; identity is content only; no fill id is invented', () => {
    const result = run(config({ mode: 'CUMULATIVE_STATE' }, scope), noIds);
    expect(result.status).toBe('OBSERVED_CONVERGENCE');
    const fill = last(result).records.flatMap((r) => r.records).find((r) => r.identity === 'CONTENT_ONLY');
    expect(fill?.key.startsWith('txn:content:')).toBe(true);
    expect(fill?.fingerprint).toContain('fill_id_field=null|fill_id_value=null');
    expect(last(result).assessment.fillLevelAccounting).toEqual({ completeFillReconstruction: 'UNKNOWN', exactlyOnceExecutionAccounting: 'UNKNOWN', feeAccounting: 'UNKNOWN',
      reasons: ['STABLE_FILL_ID_CONTRACT_UNRESOLVED', 'FILL_IDS_MISSING', 'CUMULATIVE_STATE_MODE'] });
    // FULL_EVIDENCE still blocks on the same evidence; a scope needing accounting blocks in either mode.
    expect(last(run(config({}, scope), noIds)).reasons).toEqual(['FILL_IDS_MISSING']);
    expect(last(run(config({ mode: 'CUMULATIVE_STATE' }, { ...scope, requiredAccounting: ['FEE_ACCOUNTING'] }), noIds)).reasons).toEqual(['ACCOUNTING_UNSUPPORTED_FOR_SCOPE']);
  });

  it('identical content-only records cannot be told apart from duplicates, so they are explicit and blocking', () => {
    const twins = { pages: (_c: number, _p: 0 | 1, component: ObservationComponent) => (component === 'TRANSACTIONS' ? [[txn({ fillId: null }), txn({ fillId: null })], []] : DEFAULT_PAGES[component]) };
    expect(last(run(config({ mode: 'CUMULATIVE_STATE' }, scope), twins)).reasons).toEqual(['CONTENT_IDENTITY_AMBIGUOUS', 'PAGINATION_UNKNOWN']);
  });
});

describe('M4 deterministic normalization and fingerprints; explicit configuration', () => {
  it('canonical decimals are deterministic and exact', () => {
    expect(['1.50', '01.5', '1.5'].map(canonicalDecimal)).toEqual(['1.5', '1.5', '1.5']);
    expect(['0.0', '-0', '-0.000', '000'].map(canonicalDecimal)).toEqual(['0', '0', '0', '0']);
    expect(['-2.10', '64000.50'].map(canonicalDecimal)).toEqual(['-2.1', '64000.5']);
    expect(['1e3', '1.', '.5', ' 1', 'NaN', ''].map(canonicalDecimal)).toEqual([null, null, null, null, null, null]);
  });

  it('fingerprints ignore key order and decimal spelling, keep exact strings, and follow the documented field order', () => {
    const reordered = Object.fromEntries(Object.entries(order()).reverse());
    expect(run(config(), { pages: (_c, pass, component) => (component === 'ORDERS' ? [[pass === 0 ? order() : reordered], []] : DEFAULT_PAGES[component]) }).status).toBe('OBSERVED_CONVERGENCE');
    expect(run(config(), { pages: (_c, pass, component) => (component === 'ORDERS' ? [[order(pass === 0 ? {} : { orderedQuantity: '0.50', price: '64000.50' })], []] : DEFAULT_PAGES[component]) }).status).toBe('OBSERVED_CONVERGENCE');
    // No trimming or case folding of the client order id.
    expect(last(run(config(), { pages: (_c, pass, component) => (component === 'ORDERS' ? [[order(pass === 0 ? {} : { clientOrderId: 'BOT-0001' })], []] : DEFAULT_PAGES[component]) })).reasons).toEqual(['RECORDS_DISAGREE']);
    expect(record(run(), 'order:ex-1')?.fingerprint).toBe('ORDERS|exchangeOrderId="ex-1"|pair="B-BTC_USDT"|side="BUY"|venueStatus="open"|orderedQuantity="0.5"|filledQuantity="0"'
      + '|remainingQuantity="0.5"|cancelledQuantity="0"|averageFillPrice=null|price="64000.5"|wireOrderType="limit_order"|leverage="5"'
      + '|providerCreatedAtMs=1000|providerEventTimeMs=1500|client_order_id="bot-0001"');
  });

  it.each([
    ['no scan limits for a declared component', { scanLimits: { ORDERS: { pageSize: 2, maxPages: 3 } } }],
    ['a zero page size', { scanLimits: { ORDERS: { pageSize: 0, maxPages: 3 }, POSITIONS: { pageSize: 2, maxPages: 3 } } }],
    ['zero cycles', { maxCycles: 0 }],
    ['no mode', { mode: undefined }],
    ['no contracts', { contracts: undefined }],
  ])('%s is INVALID_CONFIGURATION (no defaults)', (_label, overrides) => {
    const result = runSynchronizationCandidate({ ...config(), ...overrides }, fixtureSource());
    expect(result).toMatchObject({ status: 'INVALID_CONFIGURATION', cycles: [], grants: GRANTS_NOTHING });
  });

  it('an inverted history window is INVALID_CONFIGURATION', () => {
    expect(runSynchronizationCandidate(config({}, { history: { kind: 'DECLARED_WINDOW', fromMs: 9_000, toMs: 1_000 } }), fixtureSource()).status).toBe('INVALID_CONFIGURATION');
  });
});

describe('M4 grants nothing', () => {
  const results: Array<[string, SynchronizationResult]> = [
    ['OBSERVED_CONVERGENCE', run()],
    ['UNRESOLVED', run(config(), withOrders([[order({ exchangeOrderId: 'ex-9', clientOrderId: 'bot-9999' })]]))],
    ['REVOKED_CYCLE_LIMIT_REACHED', run(config({ maxCycles: 1 }), { stream: () => stream({ reconnectLatched: true }) })],
    ['INVALID_CONFIGURATION', runSynchronizationCandidate(null, fixtureSource())],
  ];
  it.each(results)('%s carries GRANTS_NOTHING and is accepted by no authority, certificate, permit or readiness reader', (_label, result) => {
    expect(result.grants).toBe(GRANTS_NOTHING);
    for (const cycle of result.cycles) expect(cycle.assessment.grants).toBe(GRANTS_NOTHING);
    for (const candidate of [result, ...result.cycles, ...result.cycles.map((cycle) => cycle.assessment)]) {
      expect(LiveExecutionAuthority.read(candidate)).toBeNull();
      expect(PracticalRecoveryCertificate.read(candidate)).toBeNull();
      expect(LiveReconciliationAuthorization.read(candidate)).toBeNull();
      expect(practicalPrivateStreamReadiness(candidate).kind).not.toBe('PROVEN_READY');
      expect(consumeMutationPermit(candidate, 'CANCEL').kind).toBe('REFUSED');
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
  });
});

describe('M4 closeout counterexamples: pagination terminality', () => {
  const owning = (ids: string[]) => config({ lineage: { ...config().lineage, ownedOrders: ids.map((id) => ({ exchangeOrderId: id, intentId: `intent-${id}` })) } });
  const a = order({ exchangeOrderId: 'a', clientOrderId: 'bot-a' });
  const b = order({ exchangeOrderId: 'b', clientOrderId: 'bot-b' });
  const confirmedTerminal = (base: SynchronizationConfig) => config({ ...base, contracts: { ...base.contracts, terminalShortPage: { ORDERS: 'CONFIRMED' } } });
  const orderTerminations = (result: SynchronizationResult) => last(result).terminations.filter((t) => t.component === 'ORDERS').map((t) => t.termination);
  const orderKeys = (result: SynchronizationResult) => last(result).records.filter((r) => r.pass === 0 && r.component === 'ORDERS').flatMap((r) => r.records.map((v) => v.key));

  it('a short page alone does not establish exhaustion unless the terminal-page contract is confirmed', () => {
    const unknown = run(owning(['a']), withOrderPages([[a]]));
    expect(orderTerminations(unknown)).toEqual(['SHORT_PAGE_TERMINALITY_UNCONFIRMED', 'SHORT_PAGE_TERMINALITY_UNCONFIRMED']);
    expect(unknown.status).toBe('UNRESOLVED');
    expect(last(unknown).reasons).toEqual(['PAGINATION_UNKNOWN', 'SHORT_PAGE_TERMINALITY_UNCONFIRMED']);
    const confirmed = run(confirmedTerminal(owning(['a'])), withOrderPages([[a]]));
    expect(orderTerminations(confirmed)).toEqual(['CONFIRMED_TERMINAL_SHORT_PAGE', 'CONFIRMED_TERMINAL_SHORT_PAGE']);
    expect(confirmed.status).toBe('OBSERVED_CONVERGENCE');
    expect(confirmed.historyCompleteness.status).toBe('UNPROVEN');
  });

  it('a short page followed by a non-empty page never yields an apparently complete scan, and the later records are kept', () => {
    for (const layout of [[[a], [b], []], [[a], [], [b]]]) {
      for (const base of [owning(['a', 'b']), confirmedTerminal(owning(['a', 'b']))]) {
        const result = run(base, withOrderPages(layout));
        expect(orderTerminations(result)).toEqual(['UNOBSERVED', 'UNOBSERVED']);
        expect(last(result).reasons).toEqual(expect.arrayContaining(['RECORDS_AFTER_SHORT_PAGE', 'PAGINATION_UNKNOWN']));
        expect(result.status).toBe('UNRESOLVED');
        expect(orderKeys(result)).toEqual(['order:a', 'order:b']); // the record after the short page is not ignored
      }
    }
  });

  it('continuing past a short page to an empty page ends the scan; the history is still unproven', () => {
    const result = run(owning(['a']), withOrderPages([[a], []]));
    expect(orderTerminations(result)).toEqual(['OBSERVED_EMPTY_PAGE', 'OBSERVED_EMPTY_PAGE']);
    expect(result.status).toBe('OBSERVED_CONVERGENCE');
    expect(result.historyCompleteness).toMatchObject({ status: 'UNPROVEN' });
  });

  it('the terminal-page contract is explicit configuration: only CONFIRMED per known endpoint is accepted', () => {
    expect(runSynchronizationCandidate({ ...config(), contracts: { ...config().contracts, terminalShortPage: { ORDERS: 'ASSUMED' } } }, fixtureSource()).status).toBe('INVALID_CONFIGURATION');
    expect(runSynchronizationCandidate({ ...config(), contracts: { ...config().contracts, terminalShortPage: { TRADES: 'CONFIRMED' } } }, fixtureSource()).status).toBe('INVALID_CONFIGURATION');
    const { terminalShortPage: _omitted, ...withoutTerminal } = config().contracts;
    expect(runSynchronizationCandidate({ ...config(), contracts: withoutTerminal }, fixtureSource()).status).toBe('INVALID_CONFIGURATION');
  });
});

describe('M4 closeout counterexamples: declared history window', () => {
  const window = { history: { kind: 'DECLARED_WINDOW' as const, fromMs: 500, toMs: 9_000 } };
  const findingsOf = (result: SynchronizationResult) => last(result).scanFindings.filter((f) => f.pass === 0).map((f) => `${f.finding}:${f.key ?? ''}`);

  it('records outside the window are flagged and kept, never filtered', () => {
    const result = run(config({}, window), withOrders([[order({ providerEventTimeMs: 9_500 })]]));
    expect(findingsOf(result)).toEqual(['RECORD_OUTSIDE_DECLARED_WINDOW:order:ex-1']);
    expect(record(result, 'order:ex-1')).toBeDefined();
    expect(result.status).toBe('UNRESOLVED');
    expect(result.historyWindow).toEqual({ membership: 'FLAGGED_NEVER_FILTERED', boundarySemantics: 'UNCONFIRMED' });
  });

  it('a record on a window boundary is unresolved (boundary semantics unknown); a record without a timestamp has unknown membership', () => {
    expect(findingsOf(run(config({}, window), withOrders([[order({ providerCreatedAtMs: 500 })]])))).toEqual(['WINDOW_BOUNDARY_SEMANTICS_UNKNOWN:order:ex-1']);
    const noTime = { pages: (_c: number, _p: 0 | 1, component: ObservationComponent) => (component === 'TRANSACTIONS' ? [[txn({ providerEventTimeMs: null })], []] : DEFAULT_PAGES[component]) };
    const result = run(config({}, { ...window, components: ['ORDERS', 'TRANSACTIONS'] }), noTime);
    expect(findingsOf(result)).toEqual([`WINDOW_MEMBERSHIP_UNKNOWN:txn:fill:id:fill-1`]);
    expect(result.status).toBe('UNRESOLVED');
  });

  it('records inside the window converge; the same records under available history are not window-checked', () => {
    expect(run(config({}, window)).status).toBe('OBSERVED_CONVERGENCE');
    const outside = run(config(), withOrders([[order({ providerEventTimeMs: 9_500 })]]));
    expect(outside.status).toBe('OBSERVED_CONVERGENCE');
    expect(outside.historyWindow).toBeNull();
  });
});

describe('M4 closeout counterexamples: duplicates and content-only twins', () => {
  const contentTwins = (pass0: unknown[][], pass1: unknown[][]) => ({ pages: (_c: number, pass: 0 | 1, component: ObservationComponent) => (component === 'TRANSACTIONS' ? (pass === 0 ? pass0 : pass1) : DEFAULT_PAGES[component]) });
  const scope = { components: ['ORDERS', 'TRANSACTIONS'] as ObservationComponent[] };
  const twin = txn({ fillId: null });

  it('an identical same-page duplicate with a stable record id is deduplicated, keeping its occurrences and anomaly flag', () => {
    const a = order({ exchangeOrderId: 'ex-1' });
    const result = run(config(), withOrderPages([[a, a], []]));
    expect(result.status).toBe('OBSERVED_CONVERGENCE');
    expect(record(result, 'order:ex-1')).toMatchObject({ occurrences: [{ page: 0, position: 0 }, { page: 0, position: 1 }], anomalies: ['IDENTICAL_DUPLICATE_DEDUPED'] });
    expect(last(result).scanFindings.find((f) => f.pass === 0)).toMatchObject({ finding: 'IDENTICAL_DUPLICATE_DEDUPED', blocking: false, occurrences: [{ page: 0, position: 0 }, { page: 0, position: 1 }] });
    // A stable provider fill id may be deduplicated the same way.
    const fill = run(config({}, scope), contentTwins([[txn(), txn()], []], [[txn(), txn()], []]));
    expect(record(fill, 'txn:fill:id:fill-1')).toMatchObject({ identity: 'PROVIDER_FILL_ID', anomalies: ['IDENTICAL_DUPLICATE_DEDUPED'] });
  });

  it('content-only fill twins stay unresolved and are never collapsed into one execution', () => {
    const result = run(config({ mode: 'CUMULATIVE_STATE' }, scope), contentTwins([[twin, twin], []], [[twin, twin], []]));
    const view = last(result).records.flatMap((r) => r.records).find((r) => r.identity === 'CONTENT_ONLY');
    expect(view).toMatchObject({ occurrences: [{ page: 0, position: 0 }, { page: 0, position: 1 }], anomalies: ['CONTENT_ONLY_TWIN_UNRESOLVED'] });
    expect(view?.key.startsWith('txn:content:')).toBe(true); // comparison evidence, not an invented fill identity
    expect(last(result).reasons).toEqual(['CONTENT_IDENTITY_AMBIGUOUS', 'PAGINATION_UNKNOWN']);
    // Two occurrences in one pass and one in the other are a disagreement, not the same single execution.
    expect(last(run(config({ mode: 'CUMULATIVE_STATE' }, scope), contentTwins([[twin, twin], []], [[twin], []]))).reasons).toContain('RECORDS_DISAGREE');
  });
});

describe('M4 closeout counterexamples: flat positions', () => {
  const flat = (signedQuantity: string) => ({ pages: (_c: number, _p: 0 | 1, component: ObservationComponent) => (component === 'POSITIONS' ? [[position({ signedQuantity })], []] : DEFAULT_PAGES[component]) });

  it.each(['0', '0.000', '-0'])('a flat position (%s) without durable lineage stays UNRESOLVED and is not excluded', (quantity) => {
    const result = run(config({ lineage: { ...config().lineage, ownedPositions: [] } }), flat(quantity));
    expect(record(result, 'position:pos-1')).toMatchObject({ ownership: 'UNRESOLVED', reason: 'FLAT_POSITION_WITHOUT_DURABLE_OWNERSHIP' });
    expect(result.status).toBe('UNRESOLVED');
    expect(last(result).reasons).toEqual(['OWNERSHIP_UNRESOLVED']);
  });

  it('zero quantity never implies ownership; a durable record does', () => {
    expect(record(run(config(), flat('0')), 'position:pos-1')).toMatchObject({ ownership: 'OWNED', reason: 'DURABLE_OWNERSHIP_RECORD' });
  });
});

describe('M4 named scan segments (for endpoints read once per side)', () => {
  const buy = order({ exchangeOrderId: 'b-1', side: 'BUY', clientOrderId: 'bot-b1' });
  const sell = order({ exchangeOrderId: 's-1', side: 'SELL', clientOrderId: 'bot-s1' });
  const owning = config({ lineage: { ...config().lineage, ownedOrders: [{ exchangeOrderId: 'b-1', intentId: 'i-b' }, { exchangeOrderId: 's-1', intentId: 'i-s' }] } });
  const segmented = (segments: readonly { segment: string; pages: unknown[][] }[]) => ({ pages: (_c: number, pass: 0 | 1, component: ObservationComponent) => (component === 'ORDERS'
    ? { kind: 'SCANNED', accountScope: { kind: 'CONFIRMED', accountId: ACCOUNT }, startedAtMs: 10_000 + pass * 300, endedAtMs: 10_050 + pass * 300, segments } as SyncComponentScan
    : DEFAULT_PAGES[component]) });

  it('each segment terminates on its own; records of every segment are compared', () => {
    const result = run(owning, segmented([{ segment: 'side=buy', pages: [[buy], []] }, { segment: 'side=sell', pages: [[sell], []] }]));
    expect(result.status).toBe('OBSERVED_CONVERGENCE');
    expect(last(result).terminations.find((t) => t.component === 'ORDERS')).toMatchObject({ termination: 'OBSERVED_EMPTY_PAGE',
      segments: [{ segment: 'side=buy', termination: 'OBSERVED_EMPTY_PAGE' }, { segment: 'side=sell', termination: 'OBSERVED_EMPTY_PAGE' }] });
    expect(record(result, 'order:s-1')).toMatchObject({ occurrences: [{ segment: 'side=sell', page: 0, position: 0 }] });
  });

  it('one segment that does not terminate cleanly makes the scan unresolved, with the segment named', () => {
    const result = run(owning, segmented([{ segment: 'side=buy', pages: [[buy], []] }, { segment: 'side=sell', pages: [[sell]] }]));
    expect(result.status).toBe('UNRESOLVED');
    expect(last(result).scanFindings.filter((f) => f.pass === 0).map((f) => `${f.finding}:${f.segment ?? ''}`)).toEqual(['SHORT_PAGE_TERMINALITY_UNCONFIRMED:side=sell']);
  });

  it('page bounds apply per segment; a record in two segments is a page shift; malformed segment shapes fail the read', () => {
    expect(last(run(owning, segmented([{ segment: 'side=buy', pages: [[buy], [], [], []] }, { segment: 'side=sell', pages: [[]] }]))).reasons).toContain('SCAN_LIMIT_VIOLATED');
    expect(last(run(owning, segmented([{ segment: 'side=buy', pages: [[buy], []] }, { segment: 'side=sell', pages: [[buy], []] }]))).reasons).toContain('PAGE_SHIFT_OBSERVED');
    expect(last(run(owning, segmented([{ segment: 'x', pages: [[]] }, { segment: 'x', pages: [[]] }]))).reasons).toContain('READ_FAILED');
    expect(last(run(owning, segmented([]))).reasons).toContain('READ_FAILED');
    const both = { pages: (_c: number, _p: 0 | 1, component: ObservationComponent) => (component === 'ORDERS'
      ? { kind: 'SCANNED', accountScope: { kind: 'CONFIRMED', accountId: ACCOUNT }, startedAtMs: 10_000, endedAtMs: 10_050, pages: [[]], segments: [{ segment: 'a', pages: [[]] }] } as unknown as SyncComponentScan
      : DEFAULT_PAGES[component]) };
    expect(last(run(owning, both)).reasons).toContain('READ_FAILED');
  });
});
