import { describe, expect, it } from 'vitest';
import type { LiveExecutionIntentRecord } from '../../../../../src/execution/live/intent';
import {
  LiveReconciliationService,
  matchVenueOrdersByClientOrderId,
  reconcileIdentifiedOrder,
  requireCurrentReconciliation,
  resolveAmbiguousCreate,
  type AmbiguousCreateResolutionInput,
} from '../../../../../src/execution/live/reconciliation';
import { currentAccountContinuityCapability } from '../../../../../src/execution/live/reconciliation/barrier';
import { InMemoryLiveExecutionRepository } from '../helpers';
import { InMemoryReconciliationRepository } from './in-memory-repository';
import {
  ACCOUNT,
  EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
  FakeEvidenceProvider,
  FixedClock,
  PAIR,
  RUNTIME_IDENTITY,
  T_READ_START,
  durableOrder,
  evidenceSet,
  provenance,
  venueOrder,
} from './helpers';

// Offline: pure functions plus in-memory fakes. No test reaches CoinDCX.

const CLIENT_ORDER_ID = `p17-${'0'.repeat(30)}01`;
const ambiguous = durableOrder({ state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null, clientOrderId: CLIENT_ORDER_ID });

function input(overrides: Partial<AmbiguousCreateResolutionInput> = {}): AmbiguousCreateResolutionInput {
  return {
    order: ambiguous,
    evidence: evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'venue-7', clientOrderId: CLIENT_ORDER_ID })] }),
    alreadyClaimed: new Set<string>(),
    contestedCandidates: new Set<string>(),
    submissionWindowToleranceMs: 120_000,
    ...overrides,
  };
}

function codes(result: ReturnType<typeof resolveAmbiguousCreate>): readonly string[] {
  return result.findings.map((finding) => finding.code);
}

describe('exact client_order_id matching', () => {
  it('matches by exact string equality only', () => {
    const orders = [venueOrder({ exchangeOrderId: 'venue-7', clientOrderId: CLIENT_ORDER_ID })];
    expect(matchVenueOrdersByClientOrderId(CLIENT_ORDER_ID, orders)).toMatchObject({ kind: 'UNIQUE_MATCH', establishes: 'ORDER_IDENTITY_ONLY' });
    for (const variant of [CLIENT_ORDER_ID.toUpperCase(), ` ${CLIENT_ORDER_ID}`, `${CLIENT_ORDER_ID} `, CLIENT_ORDER_ID.slice(0, 35), `${CLIENT_ORDER_ID}x`]) {
      expect(matchVenueOrdersByClientOrderId(CLIENT_ORDER_ID, [venueOrder({ clientOrderId: variant })]).kind, variant).toBe('NO_MATCH');
    }
  });

  it('a null client_order_id never matches (orders created before the id was sent)', () => {
    expect(matchVenueOrdersByClientOrderId(CLIENT_ORDER_ID, [venueOrder({ clientOrderId: null })]).kind).toBe('NO_MATCH');
    expect(matchVenueOrdersByClientOrderId('', [venueOrder({ clientOrderId: '' })]).kind).toBe('NO_MATCH');
  });

  it('two distinct venue orders with the same id are MULTIPLE_MATCHES, never a choice', () => {
    const result = matchVenueOrdersByClientOrderId(CLIENT_ORDER_ID, [
      venueOrder({ exchangeOrderId: 'venue-a', clientOrderId: CLIENT_ORDER_ID }),
      venueOrder({ exchangeOrderId: 'venue-b', clientOrderId: CLIENT_ORDER_ID }),
    ]);
    expect(result).toEqual({ kind: 'MULTIPLE_MATCHES', exchangeOrderIds: ['venue-a', 'venue-b'] });
  });
});

describe('ambiguous create resolution by client_order_id', () => {
  it('exactly one match in a complete read resolves ORDER identity only', () => {
    const result = resolveAmbiguousCreate(input());
    expect(codes(result)).toEqual(['RECON_AMBIGUOUS_CREATE_RESOLVED_BY_CLIENT_ORDER_ID']);
    expect(result.findings[0]!.category).toBe('LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE');
    expect(result.findings[0]!.evidence).toMatchObject({ identityBasis: 'EXACT_CLIENT_ORDER_ID', establishes: 'ORDER_IDENTITY_ONLY' });
    expect(result.effects).toHaveLength(1);
    const effect = result.effects[0]!;
    if (effect.kind !== 'RESOLVE_AMBIGUOUS_CREATE') throw new Error('expected resolution');
    expect(effect.observation.exchangeOrderId).toBe('venue-7');
    expect(effect.observation.clientOrderId).toBe(CLIENT_ORDER_ID);
    expect(effect.observation.exchangeClientOrderId).toBe(CLIENT_ORDER_ID);
    expect(result.claimedExchangeOrderIds).toEqual(['venue-7']);
    expect(JSON.stringify(result)).not.toContain('ACCOUNT_CONTINUITY_PROVEN');
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
  });

  it('the same economics WITHOUT a client_order_id match still hit the unchanged TIF gate', () => {
    for (const clientOrderId of [null, 'p17-ffffffffffffffffffffffffffffffff']) {
      const result = resolveAmbiguousCreate(input({
        evidence: evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'venue-7', clientOrderId })] }),
      }));
      expect(codes(result)).toEqual(['RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE']);
      expect(result.effects).toEqual([]);
    }
  });

  it('zero venue orders: unresolved, no effect', () => {
    const result = resolveAmbiguousCreate(input({ evidence: evidenceSet() }));
    expect(codes(result)).toEqual(['RECON_AMBIGUOUS_CREATE_IDENTITY_UNOBSERVABLE']);
    expect(result.effects).toEqual([]);
  });

  it('multiple matches: invariant violation, manual review, nothing adopted, both kept away from orphan cleanup', () => {
    const result = resolveAmbiguousCreate(input({
      evidence: evidenceSet({ orders: [
        venueOrder({ exchangeOrderId: 'venue-a', clientOrderId: CLIENT_ORDER_ID }),
        venueOrder({ exchangeOrderId: 'venue-b', clientOrderId: CLIENT_ORDER_ID }),
      ] }),
    }));
    expect(codes(result)).toEqual(['RECON_CLIENT_ORDER_ID_DUPLICATE_AT_VENUE']);
    expect(result.findings[0]!.category).toBe('MANUAL_REVIEW_REQUIRED');
    expect(result.effects).toEqual([]);
    expect([...result.claimedExchangeOrderIds].sort()).toEqual(['venue-a', 'venue-b']);
  });

  it('an incomplete read cannot prove the match unique: unresolved, no effect', () => {
    const result = resolveAmbiguousCreate(input({
      evidence: evidenceSet({
        orders: [venueOrder({ exchangeOrderId: 'venue-7', clientOrderId: CLIENT_ORDER_ID })],
        ordersProvenance: provenance({ source: 'COINDCX_FUTURES_ORDERS', complete: false, incompleteReason: 'ORDER_PAGINATION_LIMIT_BUY' }),
      }),
    }));
    expect(codes(result)).toEqual(['RECON_AMBIGUOUS_CREATE_UNRESOLVED']);
    expect(result.effects).toEqual([]);
  });

  it('a match whose stated economics contradict the intent is a conflict, never adopted', () => {
    for (const contradiction of [{ orderedQuantity: '0.6', remainingQuantity: '0.6' }, { side: 'SELL' as const }, { price: '64000.6' }, { pair: 'B-ETH_USDT' }]) {
      const result = resolveAmbiguousCreate(input({
        evidence: evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'venue-7', clientOrderId: CLIENT_ORDER_ID, ...contradiction })] }),
      }));
      expect(codes(result)).toEqual(['RECON_AMBIGUOUS_CREATE_CLIENT_ORDER_ID_CONFLICT']);
      expect(result.effects).toEqual([]);
    }
  });

  it('a match already bound to another local order is a conflict', () => {
    const result = resolveAmbiguousCreate(input({ alreadyClaimed: new Set(['venue-7']) }));
    expect(codes(result)).toEqual(['RECON_AMBIGUOUS_CREATE_CLIENT_ORDER_ID_CONFLICT']);
    expect(result.effects).toEqual([]);
  });

  it('a match created outside the persisted submission window stays unresolved', () => {
    const result = resolveAmbiguousCreate(input({
      evidence: evidenceSet({ orders: [venueOrder({ exchangeOrderId: 'venue-7', clientOrderId: CLIENT_ORDER_ID, providerCreatedAtMs: 1 })] }),
    }));
    expect(codes(result)).toEqual(['RECON_AMBIGUOUS_CREATE_UNRESOLVED']);
    expect(result.effects).toEqual([]);
  });

  it('a duplicate-client-order-id error alone never reconciles the order', () => {
    // The durable fault recorded for a provider duplicate rejection changes
    // nothing: without exactly one read-side match the order stays unresolved.
    const duplicateReported = durableOrder({ state: 'SUBMISSION_AMBIGUOUS', exchangeOrderId: null, clientOrderId: CLIENT_ORDER_ID });
    for (const orders of [[], [venueOrder({ exchangeOrderId: 'venue-7', clientOrderId: null })]]) {
      const result = resolveAmbiguousCreate(input({ order: duplicateReported, evidence: evidenceSet({ orders }) }));
      expect(result.effects).toEqual([]);
      expect(result.findings.every((finding) => finding.category !== 'LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE')).toBe(true);
    }
  });
});

describe('orders already bound to a venue id', () => {
  it('a DIFFERENT non-null venue client_order_id is a manual-review conflict with no effect', () => {
    const bound = durableOrder({ clientOrderId: CLIENT_ORDER_ID });
    const result = reconcileIdentifiedOrder(bound, evidenceSet({ orders: [venueOrder({ clientOrderId: 'p17-ffffffffffffffffffffffffffffffff' })] }));
    expect(result.findings.map((finding) => finding.code)).toEqual(['RECON_ORDER_CLIENT_ORDER_ID_CONFLICT']);
    expect(result.effects).toEqual([]);
  });

  it('a null or identical venue client_order_id is not a contradiction', () => {
    const bound = durableOrder({ clientOrderId: CLIENT_ORDER_ID });
    for (const clientOrderId of [null, CLIENT_ORDER_ID]) {
      const result = reconcileIdentifiedOrder(bound, evidenceSet({ orders: [venueOrder({ clientOrderId })] }));
      expect(result.findings.map((finding) => finding.code)).toEqual(['RECON_ORDER_VERIFIED_MATCH']);
    }
  });
});

describe('end to end through the reconciliation service', () => {
  function intentRecord(): LiveExecutionIntentRecord {
    return {
      intentId: 'c'.repeat(64),
      clientOrderId: `p17-${'c'.repeat(32)}`,
      wireOrderType: 'limit_order',
      quantityAdjusted: false,
      priceAdjusted: false,
      content: {
        accountId: ACCOUNT, pair: PAIR, side: 'BUY', action: 'OPEN', quantity: '0.5', orderType: 'LIMIT', price: '64000.5',
        timeInForce: 'IMMEDIATE_OR_CANCEL', leverage: '5', riskDecisionId: 'risk-1', admissionId: 'admission-1',
        strategyInstanceId: 'instance-1', strategyId: 'EMA_TREND', strategyVersion: '1.0.0', parameterHash: 'p'.repeat(64),
        liveExecutionPolicyId: 'policy-1', instrumentSpecSnapshotId: 'spec-1', authorizedNotionalInr: '2560020',
        settlementRateInrPerQuote: '80', positionInstanceId: null, positionRevision: null, reduceOnlyQuantity: null,
      },
      lineage: {
        researchApproval: { validationSubjectId: 'subject-1', validationPlanId: 'plan-1', validationSubjectResultSha256: 'r'.repeat(64) },
        sourceStrategyDecisionId: 'decision-1',
      },
    };
  }

  it('binds the unique client_order_id match durably, and live mutation stays blocked (order identity is not continuity)', async () => {
    const execution = new InMemoryLiveExecutionRepository();
    const reconciliation = new InMemoryReconciliationRepository();
    const intent = intentRecord();
    await execution.ensureIntent(intent);
    const claim = await execution.claimDispatch(intent.intentId, async () => true);
    if (claim.kind !== 'CLAIMED') throw new Error('expected claim');
    await execution.markExpiredDispatchUnresolved(intent.intentId, ACCOUNT);
    execution.setOrderTimestamps(intent.intentId, T_READ_START - 20_000, T_READ_START - 8_000);
    expect((await execution.load(intent.intentId))?.state).toBe('SUBMISSION_AMBIGUOUS');

    const provider = new FakeEvidenceProvider(evidenceSet({
      orders: [venueOrder({ exchangeOrderId: 'venue-9', clientOrderId: intent.clientOrderId })],
    }));
    const service = new LiveReconciliationService({
      repository: reconciliation,
      executionRepository: execution,
      evidenceProvider: provider,
      runtimeIdentity: RUNTIME_IDENTITY,
      credentialAccountId: ACCOUNT,
      expectedProviderAccountFingerprint: EXPECTED_PROVIDER_ACCOUNT_FINGERPRINT,
      clock: new FixedClock(),
    });

    const outcome = await service.reconcileAccount(ACCOUNT);
    if (outcome.kind !== 'COMPLETED') throw new Error('expected completion');
    expect(outcome.result.findings.map((finding) => finding.code)).toContain('RECON_AMBIGUOUS_CREATE_RESOLVED_BY_CLIENT_ORDER_ID');
    const order = await execution.load(intent.intentId);
    expect(order?.exchangeOrderId).toBe('venue-9');
    expect(order?.state).toBe('ACKNOWLEDGED');
    expect(order?.clientOrderId).toBe(intent.clientOrderId);

    await expect(requireCurrentReconciliation(reconciliation, ACCOUNT, RUNTIME_IDENTITY, 'CREATE'))
      .rejects.toMatchObject({ code: 'LIVE_RECONCILIATION_REQUIRED', details: { reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN' } });
    expect(currentAccountContinuityCapability()).toBe('REST_CURRENT_STATE_OBSERVED');
  });
});
