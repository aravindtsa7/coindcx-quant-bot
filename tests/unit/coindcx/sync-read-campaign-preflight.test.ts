import { describe, expect, it } from 'vitest';
import { GRANTS_NOTHING } from '../../../src/execution/live/practical-synchronization/engine';
import {
  preflightSyncReadCampaign,
  SYNC_CAMPAIGN_DECISIONS,
  type SyncReadCampaignRuntimeStatus,
} from '../../../src/integration/coindcx/live/sync-read-campaign-preflight';

// M4 read-only campaign preflight (unwired review candidate). Synthetic configuration only; NOT approved values.
const FINGERPRINT = 'a'.repeat(64);
function limiter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    windows: [{ windowMs: 1000, maxStarts: 5 }, { windowMs: 10_000, maxStarts: 50 }], fairnessWindowMs: 10_000,
    classShares: { P0: { minPerWindow: 0, maxPerWindow: 50 }, P1: { minPerWindow: 0, maxPerWindow: 30 }, P2: { minPerWindow: 0, maxPerWindow: 50 }, P3: { minPerWindow: 0, maxPerWindow: 50 } },
    concurrency: 20, p0ReservedSlots: 0, grantTtlMs: 2000, maxRequestDeadlineMs: 60_000, overdueGuardMs: 50, uncertainChargeAlertMs: 60_000,
    retryAfter: { noHeaderDefaultMs: 60_000, providerStatedBlockMs: 1000, localBackoffBaseMs: 1000, localBackoffMaxMs: 4000, operationalCapMs: 600_000, clockUncertaintyMs: 2000 },
    ...overrides,
  };
}
function config() {
  return {
    account: { accountId: 'synthetic-account', expectedProviderAccountFingerprint: FINGERPRINT },
    scope: { mode: 'FULL_EVIDENCE', components: ['ORDERS', 'POSITIONS'], requiredAccounting: [] as string[],
      history: { kind: 'AVAILABLE_HISTORY' } as { kind: string; fromMs?: number; toMs?: number }, orderStatuses: ['open', 'filled'] },
    accountScope: { assumption: 'UNKNOWN', attestation: 'NONE' },
    decisions: { d4c: 'PENDING', as1: 'PENDING' },
    budget: { connectionId: 'synthetic-budget', kind: 'SHARED_COORDINATOR_READ_BUDGET', scope: 'API_AUTH', priorityClass: 'P1', admissionDeadlineMs: 500, transportRequestTimeoutMs: 1_000,
      limiter: limiter(), campaignShare: { maxStartsPerFairnessWindow: 25 } },
    scanLimits: { ORDERS: { pageSize: 2, maxPages: 3 }, POSITIONS: { pageSize: 2, maxPages: 3 } } as
      Record<string, { pageSize: number; maxPages: number }> & { ORDERS: { pageSize: number; maxPages: number }; POSITIONS: { pageSize: number; maxPages: number } },
    timeouts: { identityReadTimeoutMs: 2_000, readTimeoutMs: 10_000, streamTimeoutMs: 1_000 },
    maxCycles: 1,
    thresholds: { maxEvidenceAgeMs: 5_000, maxTotalReadDurationMs: 2_000 },
    campaign: { durationMs: 60_000, evaluationIntervalMs: 10_000, maxEvaluations: 3, maxConsecutiveFailedReadEvaluations: 2 },
    lineage: { ownedOrders: [] as Array<{ exchangeOrderId: string; intentId: string }>, ambiguousCreates: [] as unknown[], closedIntentTags: [], ownedPositions: [], botTagNamespace: 'bot-' },
    contracts: 'ALL_UNCONFIRMED',
    reportDestination: { kind: 'LOCAL_FILE', path: 'C:\\synthetic\\campaign-report.json' },
  };
}
const RUNTIME: SyncReadCampaignRuntimeStatus = {
  authenticatedClient: { kind: 'CREDENTIAL_BOUND', accountId: 'synthetic-account', budgetConnectionId: 'synthetic-budget' },
  coordinator: { connected: true, localStop: false, coordinatorStop: 'NONE' }, stream: 'INJECTED', reportSink: true,
};
const codes = (entries: readonly { code: string }[]): string[] => entries.map((entry) => entry.code);
type FixtureConfig = ReturnType<typeof config>;
/** Deliberately invalid input remains unknown; this helper does not relax the valid fixture type or assertions. */
function fixtureParent(c: unknown, keys: readonly string[]): Record<string, unknown> {
  let parent = c;
  for (const key of keys) {
    if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) throw new Error('Invalid fixture path');
    parent = (parent as Record<string, unknown>)[key];
  }
  if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) throw new Error('Invalid fixture parent');
  return parent as Record<string, unknown>;
}
function setInvalid(c: FixtureConfig, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  fixtureParent(c, keys.slice(0, -1))[keys.at(-1)!] = value;
}
const blockerOf = (mutate: (c: FixtureConfig) => void, runtime: SyncReadCampaignRuntimeStatus = RUNTIME) => {
  const c = config(); mutate(c);
  return preflightSyncReadCampaign(c, runtime);
};

describe('M4 read-only campaign preflight: startable configuration', () => {
  it('an explicit, consistent configuration is startable; limitations stay listed separately and decisions stay pending', () => {
    const result = preflightSyncReadCampaign(config(), RUNTIME);
    expect(result.startable).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.scopeLabel).toBe('ORDERS_AND_POSITIONS_ONLY_NOT_FULL_ACCOUNT_SYNCHRONIZATION');
    expect(result.fullAccountSynchronization).toBe('NOT_CLAIMED');
    expect(result.decisions).toBe(SYNC_CAMPAIGN_DECISIONS);
    expect(result.decisions).toEqual({ D4c: 'PENDING_NOT_DECIDED_BY_COLLECTION', AS1: 'PENDING_NOT_DECIDED_BY_COLLECTION' });
    expect(result.grants).toBe(GRANTS_NOTHING);
    expect(result.limitations.filter((l) => l.effect === 'PREVENTS_CONVERGENCE')).toEqual([]);
    expect(codes(result.limitations)).toEqual(expect.arrayContaining(['D4C_PENDING', 'AS1_PENDING', 'EXCLUSIVE_ACCOUNT_USE_NOT_ATTESTED_NOT_ESTABLISHABLE_BY_PASSIVE_READS',
      'SCOPE_EXCLUDES_TRANSACTIONS_NOT_FULL_ACCOUNT_SYNCHRONIZATION', 'ACCEPTANCE_CRITERIA_AND_VALUES_NOT_APPROVED', 'PROVIDER_CONTRACTS_UNCONFIRMED',
      'CAMPAIGN_SHARE_DECLARED_NOT_ENFORCED_BY_COORDINATOR', 'PRODUCTION_READ_BUDGET_BINDING_ABSENT', 'DURABLE_LINEAGE_FROM_EXPLICIT_INPUT_NOT_READ_FROM_REPOSITORY',
      'HISTORY_COMPLETENESS_UNPROVABLE_BY_PASSIVE_READS', 'PROVIDER_PAGE_SIZE_CAP_UNVERIFIED']));
    expect(result.limitations.every((l) => l.effect === 'PREVENTS_MILESTONE_ACCEPTANCE')).toBe(true);
    // One identity read, then two passes over orders (2 segments x 3 pages) and positions (3 pages).
    expect(result.plan?.worstCaseRequestsPerEvaluation).toBe(1 + 2 * (2 * 3 + 3));
    expect(result.plan?.synchronization.contracts).toEqual({ tagContract: { confirmed: false }, venueGeneratedOrderTypes: null, venueGeneratedWalletStages: null, terminalShortPage: {} });
  });

  it('labels a partial scope exactly; a required unsupported component stays in scope and visible, and prevents convergence', () => {
    expect(blockerOf((c) => { c.scope.components = ['ORDERS']; }).scopeLabel).toBe('ORDERS_ONLY_NOT_FULL_ACCOUNT_SYNCHRONIZATION');
    expect(blockerOf((c) => { c.scope.components = ['POSITIONS']; }).scopeLabel).toBe('POSITIONS_ONLY_NOT_FULL_ACCOUNT_SYNCHRONIZATION');
    const withTransactions = blockerOf((c) => { c.scope.components = ['ORDERS', 'POSITIONS', 'TRANSACTIONS']; c.scanLimits.TRANSACTIONS = { pageSize: 2, maxPages: 3 }; });
    expect(withTransactions.startable).toBe(true);
    expect(withTransactions.scopeLabel).toBe('DECLARED_SCOPE_INCLUDES_CLIENT_ADAPTER_UNSUPPORTED_COMPONENT');
    expect(withTransactions.unsupportedRequiredComponents).toEqual([{ component: 'TRANSACTIONS', support: 'CLIENT_ADAPTER_UNSUPPORTED' }]);
    expect(withTransactions.limitations).toContainEqual({ code: 'REQUIRED_COMPONENT_CLIENT_ADAPTER_UNSUPPORTED', effect: 'PREVENTS_CONVERGENCE', detail: 'TRANSACTIONS' });
    expect(withTransactions.plan?.synchronization.scope.components).toEqual(['ORDERS', 'POSITIONS', 'TRANSACTIONS']); // never dropped
    expect(codes(withTransactions.limitations)).not.toContain('SCOPE_EXCLUDES_TRANSACTIONS_NOT_FULL_ACCOUNT_SYNCHRONIZATION');
  });

  it('limitations that allow collection but prevent convergence are separate from blockers', () => {
    const result = blockerOf((c) => {
      c.scope.requiredAccounting = ['FEE_ACCOUNTING'];
      c.scope.history = { kind: 'DECLARED_WINDOW', fromMs: 0, toMs: 1_000 };
      c.budget.campaignShare = { maxStartsPerFairnessWindow: 5 };
      c.timeouts.readTimeoutMs = 1_000;
      c.timeouts.identityReadTimeoutMs = 1_000;
    }, { ...RUNTIME, stream: 'NOT_CONFIGURED' });
    expect(result.startable).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.limitations.filter((l) => l.effect === 'PREVENTS_CONVERGENCE')).toEqual([
      { code: 'REQUIRED_ACCOUNTING_DECLARED', effect: 'PREVENTS_CONVERGENCE', detail: 'FEE_ACCOUNTING' },
      { code: 'PRIVATE_STREAM_OBSERVATION_NOT_CONFIGURED_EVERY_CYCLE_REVOKES', effect: 'PREVENTS_CONVERGENCE' },
      { code: 'IDENTITY_READ_TIMEOUT_BELOW_WORST_CASE_REQUEST', effect: 'PREVENTS_CONVERGENCE' },
      { code: 'WORST_CASE_EVALUATION_REQUESTS_EXCEED_CAMPAIGN_SHARE', effect: 'PREVENTS_CONVERGENCE', detail: '19>5' },
      { code: 'READ_TIMEOUT_BELOW_WORST_CASE_SCAN', effect: 'PREVENTS_CONVERGENCE', detail: 'ORDERS' },
      { code: 'READ_TIMEOUT_BELOW_WORST_CASE_SCAN', effect: 'PREVENTS_CONVERGENCE', detail: 'POSITIONS' },
    ]);
    expect(codes(result.limitations)).toContain('DATE_FILTER_UNSUPPORTED_BY_ENDPOINTS_WINDOW_FLAGGED_NOT_APPLIED');
  });
});

describe('M4 read-only campaign preflight: blockers (no defaults, no approvals from configuration)', () => {
  it('rejects malformed lineage and unsafe aggregate bounds, and snapshots mutable collection inputs', () => {
    expect(blockerOf(c => { setInvalid(c, 'lineage.ownedOrders', [null]); }).blockers).toEqual([{ code: 'LINEAGE_INVALID' }]);
    expect(blockerOf(c => { c.lineage.ambiguousCreates = [{}]; }).blockers).toEqual([{ code: 'LINEAGE_INVALID' }]);
    expect(codes(blockerOf(c => { c.maxCycles = Number.MAX_SAFE_INTEGER; }).blockers)).toContain('REQUEST_BOUND_NOT_SAFE_INTEGER');
    const c = config();
    const result = preflightSyncReadCampaign(c, RUNTIME);
    c.scope.history.kind = 'DECLARED_WINDOW';
    c.scanLimits.ORDERS.maxPages = 999;
    c.lineage.ownedOrders.push({ exchangeOrderId: 'invented-after-preflight', intentId: 'invented' });
    expect(result.plan!.synchronization.scope.history).toEqual({ kind: 'AVAILABLE_HISTORY' });
    expect(result.plan!.synchronization.scanLimits.ORDERS!.maxPages).toBe(3);
    const copiedLineage = result.plan!.synchronization.lineage;
    expect('kind' in copiedLineage).toBe(false);
    if ('kind' in copiedLineage) throw new Error('Expected supplied durable lineage');
    expect(copiedLineage.ownedOrders).toEqual([]);
  });
  it('a missing configuration blocks every section; nothing is defaulted', () => {
    const result = preflightSyncReadCampaign(undefined, { authenticatedClient: null, coordinator: null, stream: 'NOT_CONFIGURED', reportSink: false });
    expect(result.startable).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.blockers.filter((b) => b.code === 'CONFIG_MISSING').map((b) => b.detail)).toEqual(expect.arrayContaining([
      'account', 'scope', 'accountScope', 'decisions', 'budget', 'scanLimits', 'timeouts', 'maxCycles', 'thresholds', 'campaign', 'lineage', 'reportDestination']));
    expect(codes(result.blockers)).toEqual(expect.arrayContaining(['BUDGET_COORDINATOR_NOT_CONFIGURED', 'REPORT_SINK_NOT_CONFIGURED', 'EXPECTED_ACCOUNT_FINGERPRINT_INVALID']));
    expect(result.grants).toBe(GRANTS_NOTHING);
  });

  it('removing any single required value is a blocker', () => {
    const paths = ['account.accountId', 'account.expectedProviderAccountFingerprint', 'scope.mode', 'scope.components', 'scope.requiredAccounting', 'scope.history',
      'scope.orderStatuses', 'accountScope.assumption', 'accountScope.attestation', 'decisions.d4c', 'decisions.as1', 'budget.kind', 'budget.scope', 'budget.priorityClass',
      'budget.connectionId', 'budget.admissionDeadlineMs', 'budget.transportRequestTimeoutMs', 'budget.limiter', 'budget.campaignShare', 'scanLimits.ORDERS', 'scanLimits.POSITIONS',
      'timeouts.identityReadTimeoutMs', 'timeouts.readTimeoutMs', 'timeouts.streamTimeoutMs', 'maxCycles', 'thresholds.maxEvidenceAgeMs', 'thresholds.maxTotalReadDurationMs',
      'campaign.durationMs', 'campaign.evaluationIntervalMs', 'campaign.maxEvaluations', 'campaign.maxConsecutiveFailedReadEvaluations', 'lineage', 'contracts',
      'reportDestination.kind', 'reportDestination.path'];
    for (const dotted of paths) {
      const result = blockerOf((c) => {
        const keys = dotted.split('.');
        const parent = fixtureParent(c, keys.slice(0, -1));
        delete parent[keys.at(-1)!];
      });
      expect(result.startable, dotted).toBe(false);
      expect(result.blockers.length, dotted).toBeGreaterThan(0);
    }
  });

  it('D4c, AS1, exclusive-use attestation and provider-contract confirmations are never accepted from configuration', () => {
    for (const mutate of [
      (c: FixtureConfig) => { c.decisions.d4c = 'APPROVED'; },
      (c: FixtureConfig) => { c.decisions.as1 = 'APPROVED'; },
      (c: FixtureConfig) => { c.accountScope.attestation = 'OPERATOR_ATTESTED_EXCLUSIVE'; },
      (c: FixtureConfig) => { setInvalid(c, 'contracts', { tagContract: { confirmed: true, field: 'client_order_id', botCreatesAlwaysTagged: true } }); },
    ]) {
      const result = blockerOf(mutate);
      expect(result.startable).toBe(false);
      expect(result.decisions).toEqual({ D4c: 'PENDING_NOT_DECIDED_BY_COLLECTION', AS1: 'PENDING_NOT_DECIDED_BY_COLLECTION' });
      expect(result.plan).toBeNull();
      expect(JSON.stringify(result)).not.toMatch(/"APPROVED"|OPERATOR_ATTESTED|"confirmed":true/); // the claim is never echoed as a state
    }
    expect(codes(blockerOf((c) => { c.decisions.as1 = 'APPROVED'; }).blockers)).toEqual(['DECISION_STATE_NOT_ACCEPTED_FROM_CONFIGURATION']);
    expect(codes(blockerOf((c) => { c.accountScope.attestation = 'X'; }).blockers)).toEqual(['ACCOUNT_SCOPE_ATTESTATION_NOT_ACCEPTED_FROM_CONFIGURATION']);
    expect(codes(blockerOf((c) => { c.contracts = 'CONFIRMED'; }).blockers)).toEqual(['PROVIDER_CONTRACT_CONFIRMATION_NOT_ACCEPTED_FROM_CONFIGURATION']);
  });

  it('the budget is checked against the existing limiter constraints', () => {
    expect(codes(blockerOf((c) => { setInvalid(c, 'budget.campaignShare', 'UNASSIGNED'); }).blockers)).toEqual(['CAMPAIGN_BUDGET_SHARE_UNASSIGNED']);
    expect(codes(blockerOf((c) => { c.budget.campaignShare = { maxStartsPerFairnessWindow: 31 }; }).blockers)).toEqual(['CAMPAIGN_SHARE_EXCEEDS_CLASS_CEILING']);
    expect(codes(blockerOf((c) => { c.budget.admissionDeadlineMs = 60_001; }).blockers)).toEqual(['ADMISSION_DEADLINE_EXCEEDS_LIMITER_REQUEST_DEADLINE_CAP']);
    expect(blockerOf((c) => { c.budget.limiter = limiter({ concurrency: 0 }); }).blockers).toEqual([{ code: 'LIMITER_CONFIG_INVALID', detail: 'CONCURRENCY' }]);
    expect(codes(blockerOf((c) => { c.budget.priorityClass = 'P9'; }).blockers)).toEqual(['BUDGET_PRIORITY_CLASS_INVALID']);
    expect(codes(blockerOf((c) => { c.budget.scope = 'PUBLIC'; }).blockers)).toEqual(['BUDGET_SCOPE_NOT_AUTHENTICATED_READ_SCOPE']);
  });

  it('an unavailable coordinator or report sink blocks collection', () => {
    const run = (runtime: Partial<SyncReadCampaignRuntimeStatus>) => codes(preflightSyncReadCampaign(config(), { ...RUNTIME, ...runtime }).blockers);
    expect(run({ coordinator: null })).toEqual(['BUDGET_COORDINATOR_NOT_CONFIGURED']);
    expect(run({ coordinator: { connected: false, localStop: false, coordinatorStop: 'NONE' } })).toEqual(['BUDGET_COORDINATOR_NOT_CONNECTED']);
    expect(run({ coordinator: { connected: true, localStop: true, coordinatorStop: 'NONE' } })).toEqual(['BUDGET_COORDINATOR_STOP_ACTIVE']);
    expect(run({ coordinator: { connected: true, localStop: false, coordinatorStop: 'DURABLE' } })).toEqual(['BUDGET_COORDINATOR_STOP_ACTIVE']);
    expect(run({ reportSink: false })).toEqual(['REPORT_SINK_NOT_CONFIGURED']);
    expect(run({ authenticatedClient: null })).toEqual(['AUTHENTICATED_CLIENT_PROVENANCE_UNKNOWN']);
    expect(run({ authenticatedClient: { kind: 'CREDENTIAL_BOUND', accountId: 'another-account', budgetConnectionId: 'synthetic-budget' } })).toEqual(['AUTHENTICATED_CLIENT_ACCOUNT_MISMATCH']);
    expect(run({ authenticatedClient: { kind: 'CREDENTIAL_BOUND', accountId: 'synthetic-account', budgetConnectionId: 'another-budget' } })).toEqual(['AUTHENTICATED_CLIENT_BUDGET_CONNECTION_MISMATCH']);
  });

  it('scope, fingerprint, bounds and destination are validated', () => {
    expect(codes(blockerOf((c) => { c.account.expectedProviderAccountFingerprint = 'A'.repeat(64); }).blockers)).toEqual(['EXPECTED_ACCOUNT_FINGERPRINT_INVALID']);
    expect(codes(blockerOf((c) => { c.scope.components = ['ORDERS', 'ORDERS']; }).blockers)).toContain('SCOPE_COMPONENTS_DUPLICATED');
    expect(blockerOf((c) => { c.scope.components = ['ORDERS', 'WALLET']; }).blockers).toContainEqual({ code: 'SCOPE_COMPONENT_UNKNOWN', detail: 'WALLET' });
    expect(blockerOf((c) => { c.scope.components = ['ORDERS', 'TRANSACTIONS']; }).blockers).toEqual([{ code: 'CONFIG_MISSING', detail: 'scanLimits.TRANSACTIONS' }]);
    expect(blockerOf((c) => { c.scope.requiredAccounting = ['EVERYTHING']; }).blockers).toEqual([{ code: 'CONFIG_MISSING', detail: 'scope.requiredAccounting' }]);
    expect(blockerOf((c) => { c.scope.orderStatuses = ['open; DROP']; }).blockers).toEqual([{ code: 'CONFIG_MISSING', detail: 'scope.orderStatuses' }]);
    for (const bad of [0, -1, 1.5, Number.POSITIVE_INFINITY, '3']) {
      expect(blockerOf((c) => { setInvalid(c, 'scanLimits.ORDERS.maxPages', bad); }).blockers).toEqual([{ code: 'CONFIG_MISSING', detail: 'scanLimits.ORDERS' }]);
      expect(blockerOf((c) => { setInvalid(c, 'campaign.durationMs', bad); }).blockers).toEqual([{ code: 'CONFIG_MISSING', detail: 'campaign.durationMs' }]);
    }
    for (const target of ['relative/report.json', 'C:\\synthetic\\report.txt', 'C:\\synthetic\\..\\report.json', '']) {
      expect(codes(blockerOf((c) => { c.reportDestination.path = target; }).blockers), target).toEqual(['REPORT_DESTINATION_INVALID']);
    }
    expect(codes(blockerOf((c) => { c.scope.history = { kind: 'DECLARED_WINDOW', fromMs: 5, toMs: 1 }; }).blockers)).toEqual(['SYNCHRONIZATION_CONFIG_INVALID']);
  });
});
