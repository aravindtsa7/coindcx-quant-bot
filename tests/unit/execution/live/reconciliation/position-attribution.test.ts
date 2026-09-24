import { describe, expect, it } from 'vitest';
import {
  deriveOwnershipShares,
  ownershipLineageSha256,
  reconcilePosition,
  signedFillContribution,
} from '../../../../../src/execution/live/reconciliation';
import type { LivePositionOwnershipRecord } from '../../../../../src/execution/live/repository';
import type { LiveReconciliationFinding } from '../../../../../src/execution/live/reconciliation/types';
import { ACCOUNT, OTHER_PAIR, PAIR, durableOrder, evidenceSet, provenance, venuePosition } from './helpers';

function codes(findings: readonly LiveReconciliationFinding[]): readonly string[] {
  return findings.map((finding) => finding.code);
}

function categories(findings: readonly LiveReconciliationFinding[]): readonly string[] {
  return findings.map((finding) => finding.category);
}

/** A durable order whose fills are final and therefore usable as lineage. */
function filledOrder(overrides: Parameters<typeof durableOrder>[0] = {}) {
  return durableOrder({
    state: 'FILLED',
    cumulativeFilledQuantity: '0.5',
    averageFillPrice: '64000',
    ...overrides,
  });
}

function input(overrides: Partial<Parameters<typeof reconcilePosition>[0]> = {}) {
  return {
    accountId: ACCOUNT,
    pair: PAIR,
    orders: [] as ReturnType<typeof durableOrder>[],
    venuePosition: null,
    durablePosition: null as LivePositionOwnershipRecord | null,
    evidence: evidenceSet(),
    hasUnresolvedOrders: false,
    ...overrides,
  };
}

describe('P18 §10 signed lineage arithmetic', () => {
  it('adds on a BUY and subtracts on a SELL, for OPEN and CLOSE alike', () => {
    expect(signedFillContribution(filledOrder({ side: 'BUY', action: 'OPEN' })).toFixed()).toBe('0.5');
    expect(signedFillContribution(filledOrder({ side: 'SELL', action: 'OPEN' })).toFixed()).toBe('-0.5');
    // A CLOSE of a long IS a sell, and must reduce the same aggregate.
    expect(signedFillContribution(filledOrder({ side: 'SELL', action: 'CLOSE' })).toFixed()).toBe('-0.5');
  });

  it('groups exact shares per strategy instance', () => {
    const derived = deriveOwnershipShares(ACCOUNT, PAIR, [
      filledOrder({ intentId: 'i1', strategyInstanceId: 'a', cumulativeFilledQuantity: '0.3' }),
      filledOrder({ intentId: 'i2', strategyInstanceId: 'a', cumulativeFilledQuantity: '0.2' }),
      filledOrder({ intentId: 'i3', strategyInstanceId: 'b', cumulativeFilledQuantity: '0.1' }),
    ]);
    expect('shares' in derived).toBe(true);
    if (!('shares' in derived)) return;
    expect(derived.shares.map((share) => [share.ownerStrategyInstanceId, share.signedQuantity]))
      .toEqual([['a', '0.5'], ['b', '0.1']]);
  });

  it('refuses lineage where one instance disagrees on its own strategy tuple', () => {
    const derived = deriveOwnershipShares(ACCOUNT, PAIR, [
      filledOrder({ intentId: 'i1', strategyInstanceId: 'a', strategyVersion: '1.0.0' }),
      filledOrder({ intentId: 'i2', strategyInstanceId: 'a', strategyVersion: '2.0.0' }),
    ]);
    expect('incoherentInstanceId' in derived).toBe(true);
  });

  it('produces a stable lineage digest that does not depend on intent ordering', () => {
    const a = ownershipLineageSha256({ accountId: ACCOUNT, pair: PAIR, ownerStrategyInstanceId: 'a', signedQuantity: '0.5', lineageIntentIds: ['i1', 'i2'] });
    const b = ownershipLineageSha256({ accountId: ACCOUNT, pair: PAIR, ownerStrategyInstanceId: 'a', signedQuantity: '0.50', lineageIntentIds: ['i2', 'i1'] });
    expect(a).toBe(b);
  });
});

describe('P18 §11 position reconciliation cases', () => {
  it('DB flat + venue flat is a verified match', () => {
    const result = reconcilePosition(input());
    expect(codes(result.findings)).toEqual(['RECON_POSITION_VERIFIED_MATCH']);
    expect(result.effects).toEqual([]);
  });

  it('DB flat + venue flat with a stale durable row clears that row', () => {
    const result = reconcilePosition(input({
      durablePosition: {
        accountId: ACCOUNT, pair: PAIR, positionInstanceId: 'p1', positionRevision: 0, side: 'LONG',
        ownedQuantity: '0.5', instrumentSpecSnapshotId: 'spec-1', ownerStrategyInstanceId: 'instance-1',
        ownerStrategyId: 'EMA_TREND', ownerStrategyVersion: '1.0.0', ownerParameterHash: 'p'.repeat(64),
      },
    }));
    expect(categories(result.findings)).toEqual(['VERIFIED_MATCH']);
    expect(result.effects[0]).toMatchObject({ kind: 'CLEAR_OWNERSHIP', pair: PAIR });
  });

  it('exact venue/local reconstruction establishes single-owner ownership', () => {
    const result = reconcilePosition(input({
      orders: [filledOrder({ cumulativeFilledQuantity: '0.5' })],
      venuePosition: venuePosition({ signedQuantity: '0.5' }),
    }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_OWNERSHIP_ESTABLISHED']);
    expect(result.effects[0]).toMatchObject({ kind: 'APPLY_OWNERSHIP', materializeSingleOwner: true });
    const effect = result.effects[0]!;
    expect(effect.kind === 'APPLY_OWNERSHIP' && effect.shares[0]).toMatchObject({ side: 'LONG', quantity: '0.5' });
  });

  it('establishes SHORT ownership from signed lineage', () => {
    const result = reconcilePosition(input({
      orders: [filledOrder({ side: 'SELL', cumulativeFilledQuantity: '0.5' })],
      venuePosition: venuePosition({ signedQuantity: '-0.5' }),
    }));
    const effect = result.effects[0]!;
    expect(effect.kind === 'APPLY_OWNERSHIP' && effect.shares[0]?.side).toBe('SHORT');
  });

  it('DB open + venue flat is a durable CONFLICT, never a silent close', () => {
    const result = reconcilePosition(input({ orders: [filledOrder()], venuePosition: venuePosition({ signedQuantity: '0' }) }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_LOCAL_OPEN_VENUE_FLAT']);
    expect(categories(result.findings)).toEqual(['CONFLICT']);
    expect(result.effects).toEqual([]);
  });

  it('DB flat + venue open is UNATTRIBUTED exposure, never assigned to anyone', () => {
    const result = reconcilePosition(input({ orders: [], venuePosition: venuePosition({ signedQuantity: '0.5' }) }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_UNATTRIBUTED_EXPOSURE']);
    expect(categories(result.findings)).toEqual(['CONFLICT']);
    expect(result.effects).toEqual([]);
  });

  it('CANNOT fabricate ownership from the aggregate just because one strategy exists', () => {
    // The single local strategy filled 0.3 but the venue holds 0.5. The extra
    // 0.2 is NOT handed to the only candidate owner.
    const result = reconcilePosition(input({
      orders: [filledOrder({ cumulativeFilledQuantity: '0.3' })],
      venuePosition: venuePosition({ signedQuantity: '0.5' }),
    }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_QUANTITY_MISMATCH']);
    expect(result.effects).toEqual([]);
  });

  it('refuses a quantity mismatch of even one ulp, with no tolerance band', () => {
    const result = reconcilePosition(input({
      orders: [filledOrder({ cumulativeFilledQuantity: '0.5' })],
      venuePosition: venuePosition({ signedQuantity: '0.500000000000000001' }),
    }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_QUANTITY_MISMATCH']);
  });

  it('detects a direction mismatch', () => {
    const result = reconcilePosition(input({
      orders: [filledOrder({ side: 'BUY', cumulativeFilledQuantity: '0.5' })],
      venuePosition: venuePosition({ signedQuantity: '-0.5' }),
    }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_DIRECTION_MISMATCH']);
    expect(result.effects).toEqual([]);
  });

  it('accepts several instances whose shares sum EXACTLY to the aggregate', () => {
    const result = reconcilePosition(input({
      orders: [
        filledOrder({ intentId: 'i1', strategyInstanceId: 'a', cumulativeFilledQuantity: '0.3' }),
        filledOrder({ intentId: 'i2', strategyInstanceId: 'b', cumulativeFilledQuantity: '0.2' }),
      ],
      venuePosition: venuePosition({ signedQuantity: '0.5' }),
    }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_OWNERSHIP_SHARED']);
    // Fully attributed, so not blocking — but Phase17's single-owner
    // `live_position` is deliberately NOT materialized, so CLOSE stays
    // fail-closed for this pair.
    expect(categories(result.findings)).toEqual(['LOCAL_INCOMPLETE_BUT_PROVABLY_RECONSTRUCTABLE']);
    expect(result.effects[0]).toMatchObject({ kind: 'APPLY_OWNERSHIP', materializeSingleOwner: false });
  });

  it('refuses shares that fail to sum to the aggregate', () => {
    const result = reconcilePosition(input({
      orders: [
        filledOrder({ intentId: 'i1', strategyInstanceId: 'a', cumulativeFilledQuantity: '0.3' }),
        filledOrder({ intentId: 'i2', strategyInstanceId: 'b', cumulativeFilledQuantity: '0.1' }),
      ],
      venuePosition: venuePosition({ signedQuantity: '0.5' }),
    }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_OWNERSHIP_SUM_MISMATCH']);
    expect(result.effects).toEqual([]);
  });

  it('refuses shares that net correctly only by offsetting opposite exposure', () => {
    const result = reconcilePosition(input({
      orders: [
        filledOrder({ intentId: 'i1', strategyInstanceId: 'a', side: 'BUY', cumulativeFilledQuantity: '0.8' }),
        filledOrder({ intentId: 'i2', strategyInstanceId: 'b', side: 'SELL', cumulativeFilledQuantity: '0.3' }),
      ],
      venuePosition: venuePosition({ signedQuantity: '0.5' }),
    }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_OWNERSHIP_SUM_MISMATCH']);
    expect(result.effects).toEqual([]);
  });

  it('refuses ownership resting on an order whose true fill is unknown', () => {
    const result = reconcilePosition(input({
      orders: [filledOrder({ cumulativeFilledQuantity: '0.5' })],
      venuePosition: venuePosition({ signedQuantity: '0.5' }),
      hasUnresolvedOrders: true,
    }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_UNATTRIBUTED_EXPOSURE']);
    expect(categories(result.findings)).toEqual(['AMBIGUOUS']);
    expect(result.effects).toEqual([]);
  });

  it('refuses to establish any aggregate from an INCOMPLETE position read', () => {
    const result = reconcilePosition(input({
      orders: [filledOrder()],
      venuePosition: venuePosition({ signedQuantity: '0.5' }),
      evidence: evidenceSet({
        positionsProvenance: provenance({ source: 'COINDCX_FUTURES_POSITIONS', complete: false, incompleteReason: 'POSITION_PAGINATION_LIMIT' }),
      }),
    }));
    expect(codes(result.findings)).toEqual(['RECON_EVIDENCE_INCOMPLETE']);
    expect(categories(result.findings)).toEqual(['AMBIGUOUS']);
    expect(result.effects).toEqual([]);
  });

  it('detects a durable position contradicting proven ownership identity', () => {
    const result = reconcilePosition(input({
      orders: [filledOrder({ strategyInstanceId: 'instance-1', cumulativeFilledQuantity: '0.5' })],
      venuePosition: venuePosition({ signedQuantity: '0.5' }),
      durablePosition: {
        accountId: ACCOUNT, pair: PAIR, positionInstanceId: 'p1', positionRevision: 0, side: 'LONG',
        ownedQuantity: '0.5', instrumentSpecSnapshotId: 'spec-1', ownerStrategyInstanceId: 'SOMEONE-ELSE',
        ownerStrategyId: 'EMA_TREND', ownerStrategyVersion: '1.0.0', ownerParameterHash: 'p'.repeat(64),
      },
    }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_IDENTITY_MISMATCH']);
    expect(result.effects).toEqual([]);
  });

  it('detects a durable position contradicting the proven quantity', () => {
    const result = reconcilePosition(input({
      orders: [filledOrder({ cumulativeFilledQuantity: '0.5' })],
      venuePosition: venuePosition({ signedQuantity: '0.5' }),
      durablePosition: {
        accountId: ACCOUNT, pair: PAIR, positionInstanceId: 'p1', positionRevision: 0, side: 'LONG',
        ownedQuantity: '0.4', instrumentSpecSnapshotId: 'spec-1', ownerStrategyInstanceId: 'instance-1',
        ownerStrategyId: 'EMA_TREND', ownerStrategyVersion: '1.0.0', ownerParameterHash: 'p'.repeat(64),
      },
    }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_QUANTITY_MISMATCH']);
  });

  it('refuses owners validated against different instrument snapshots', () => {
    const result = reconcilePosition(input({
      orders: [
        filledOrder({ intentId: 'i1', strategyInstanceId: 'a', cumulativeFilledQuantity: '0.3', instrumentSpecSnapshotId: 'spec-1' }),
        filledOrder({ intentId: 'i2', strategyInstanceId: 'b', cumulativeFilledQuantity: '0.2', instrumentSpecSnapshotId: 'spec-2' }),
      ],
      venuePosition: venuePosition({ signedQuantity: '0.5' }),
    }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_IDENTITY_MISMATCH']);
  });

  it('reconstructs a position from local fills after a restart, including partials', () => {
    // A crash after a partial fill but before any local position existed: the
    // fills are durable facts, so the reconstruction is exactly provable.
    const result = reconcilePosition(input({
      orders: [durableOrder({ state: 'PARTIALLY_FILLED', cumulativeFilledQuantity: '0.2', averageFillPrice: '64000' })],
      venuePosition: venuePosition({ signedQuantity: '0.2' }),
    }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_OWNERSHIP_ESTABLISHED']);
    const effect = result.effects[0]!;
    expect(effect.kind === 'APPLY_OWNERSHIP' && effect.shares[0]?.quantity).toBe('0.2');
  });

  it('treats a completed CLOSE that crashed before the local update as flat/flat', () => {
    const result = reconcilePosition(input({
      orders: [
        filledOrder({ intentId: 'i1', side: 'BUY', action: 'OPEN', cumulativeFilledQuantity: '0.5' }),
        filledOrder({ intentId: 'i2', side: 'SELL', action: 'CLOSE', cumulativeFilledQuantity: '0.5' }),
      ],
      venuePosition: venuePosition({ signedQuantity: '0' }),
    }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_VERIFIED_MATCH']);
  });

  it('is pair-generic: identical logic on a different pair', () => {
    const result = reconcilePosition(input({
      pair: OTHER_PAIR,
      orders: [filledOrder({ pair: OTHER_PAIR, cumulativeFilledQuantity: '0.5' })],
      venuePosition: venuePosition({ pair: OTHER_PAIR, signedQuantity: '0.5' }),
    }));
    expect(codes(result.findings)).toEqual(['RECON_POSITION_OWNERSHIP_ESTABLISHED']);
    expect(result.effects[0]).toMatchObject({ pair: OTHER_PAIR });
  });
});
