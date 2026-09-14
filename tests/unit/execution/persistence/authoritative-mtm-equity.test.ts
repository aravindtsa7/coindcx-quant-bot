import { describe, expect, it } from 'vitest';
import { RiskAdmissionCoordinator } from '../../../../src/dispatch/admission';
import {
  deriveCloseRiskInput, deriveMarkToMarketRiskInput,
  type AuthoritativeOpenPositionValuation, type AuthoritativePaperRiskBase, type AuthoritativePaperRiskInput,
  type AuthoritativeValuationEvidence,
} from '../../../../src/execution/persistence/authoritative-risk-input';
import { buildBaseExposureSnapshot } from '../../../../src/execution/persistence/account-repository';
import { paperDecimal } from '../../../../src/execution/decimal';
import { evidenceContentSha256, type PortfolioExposureSnapshot } from '../../../../src/risk';
import { buildContext, evaluateDecision, makeKernel, policyFor } from '../../dispatch/helpers';
import { makePolicy } from '../../risk/helpers';

// [F14-01 final correction] Mark-to-market equity — the exact frozen Phase13
// definition (`docs/RISK_LEVERAGE_ENGINE.md` §12.3: `currentEquityInr`
// INCLUDES unrealized PnL) applied over EVERY durable OPEN position, using the
// frozen `computeUnrealizedPnlInr` formula and the same
// `markPriceInr = markPriceUsdt × conversionRate` step P14-E applies to
// `fillPriceUsdt`. Pure derivation only — no DB, no provider, no network.

const POLICY = makePolicy();
const T0 = 1_200_000;
const PAIR_A = 'B-BTC_USDT';
const PAIR_B = 'B-ETH_USDT';

function exposureFor(positions: readonly AuthoritativeOpenPositionValuation[]): PortfolioExposureSnapshot {
  const projection = buildBaseExposureSnapshot(
    'acc-1',
    positions.map((position) => ({ pair: position.pair, strategyId: 'EMA_TREND', quantity: position.quantity, averageEntryPriceInr: position.averageEntryPriceInr })),
    T0,
    POLICY.sourceAuthorityPolicy.exposureSourceId,
  );
  const { accountId: _accountId, ...fields } = projection as PortfolioExposureSnapshot & { readonly accountId?: string };
  const snapshot = fields as PortfolioExposureSnapshot;
  return { ...snapshot, provenance: { ...snapshot.provenance, contentSha256: evidenceContentSha256(snapshot) } };
}

function position(overrides: Partial<AuthoritativeOpenPositionValuation> = {}): AuthoritativeOpenPositionValuation {
  return {
    pair: PAIR_A, positionInstanceId: 'pos-1', side: 'LONG', quantity: '1000',
    averageEntryPriceInr: '8000', contractMultiplier: '0.001', ...overrides,
  };
}

function base(overrides: Partial<AuthoritativePaperRiskBase> = {}): AuthoritativePaperRiskBase {
  const openPositions = overrides.openPositions ?? [];
  return {
    accountId: 'acc-1', fence: 1n, revision: 1n, evaluationTimeMs: T0,
    cashBalanceInr: '1000000', lockedMarginInr: '0', reservedCapacityInr: '0', peakEquityInr: '1000000',
    consecutiveLossCount: 0, cooldownActiveUntilMs: null,
    dailyPnl: { realizedTradingPnlInr: '0', fundingPnlInr: '0', feesInr: '0', otherAccountAdjustmentsInr: '0', netDailyPnlInr: '0' },
    openPositions,
    exposureSnapshot: exposureFor(openPositions),
    pairSlots: [],
    ...overrides,
  };
}

function valuation(markPriceUsdtByPair: Record<string, string>, conversionRateInrPerUsdt = '80'): AuthoritativeValuationEvidence {
  return { conversionRateInrPerUsdt, markPriceUsdtByPair: new Map(Object.entries(markPriceUsdtByPair)) };
}

function derive(riskBase: AuthoritativePaperRiskBase, evidence: AuthoritativeValuationEvidence | null) {
  return deriveMarkToMarketRiskInput({ base: riskBase, policy: POLICY, valuation: evidence });
}

function derived(riskBase: AuthoritativePaperRiskBase, evidence: AuthoritativeValuationEvidence | null) {
  const result = derive(riskBase, evidence);
  if (result.status !== 'DERIVED') throw new Error(`expected DERIVED, got ${result.status}: ${result.reason}`);
  return result.input;
}

// Entry 8000 INR/contract-unit, multiplier 0.001, quantity 1000
// => unit INR notional per USDT-of-price = quantity * multiplier = 1.
// markInr = markUsdt * 80, so U(LONG) = (markUsdt*80 - 8000) * 1000 * 0.001.

describe('F14-01 mark-to-market equity — LONG/SHORT direction (§15)', () => {
  it('LONG with the mark BELOW entry produces a negative unrealized PnL and reduces equity exactly', () => {
    // markInr = 60 * 80 = 4800; U = (4800 - 8000) * 1000 * 0.001 = -3200
    const input = derived(base({ openPositions: [position()] }), valuation({ [PAIR_A]: '60' }));
    expect(input.totalUnrealizedPnlInr).toBe('-3200');
    expect(input.accountSnapshot.currentEquityInr).toBe('996800');
  });

  it('LONG with the mark ABOVE entry produces a positive unrealized PnL (§14 — never clamped away)', () => {
    // markInr = 120 * 80 = 9600; U = (9600 - 8000) * 1 = 1600
    const input = derived(base({ openPositions: [position()] }), valuation({ [PAIR_A]: '120' }));
    expect(input.totalUnrealizedPnlInr).toBe('1600');
    expect(input.accountSnapshot.currentEquityInr).toBe('1001600');
  });

  it('SHORT with the mark ABOVE entry produces a negative unrealized PnL', () => {
    // U(SHORT) = (entry - mark) * qty * multiplier = (8000 - 9600) * 1 = -1600
    const input = derived(base({ openPositions: [position({ side: 'SHORT' })] }), valuation({ [PAIR_A]: '120' }));
    expect(input.totalUnrealizedPnlInr).toBe('-1600');
    expect(input.accountSnapshot.currentEquityInr).toBe('998400');
  });

  it('SHORT with the mark BELOW entry produces a positive unrealized PnL', () => {
    // U(SHORT) = (8000 - 4800) * 1 = 3200
    const input = derived(base({ openPositions: [position({ side: 'SHORT' })] }), valuation({ [PAIR_A]: '60' }));
    expect(input.totalUnrealizedPnlInr).toBe('3200');
    expect(input.accountSnapshot.currentEquityInr).toBe('1003200');
  });

  it('applies the conversion rate exactly (markPriceInr = markPriceUsdt × rate), mirroring P14-E\'s own fillPriceInr step', () => {
    // Same mark, different rate: 100 * 83 = 8300 INR => U = (8300 - 8000) * 1 = 300
    const input = derived(base({ openPositions: [position()] }), valuation({ [PAIR_A]: '100' }, '83'));
    expect(input.totalUnrealizedPnlInr).toBe('300');
    // A rate that makes mark exactly equal entry gives exactly zero, never a rounded approximation.
    expect(derived(base({ openPositions: [position()] }), valuation({ [PAIR_A]: '100' }, '80')).totalUnrealizedPnlInr).toBe('0');
  });

  it('keeps full Decimal precision through the conversion and multiplier (no float rounding)', () => {
    // entry 8000.000000000000000001, mark 100 * 80 = 8000 => U = -0.000000000000000001 * 1000 * 0.001
    const input = derived(
      base({ openPositions: [position({ averageEntryPriceInr: '8000.000000000000000001' })] }),
      valuation({ [PAIR_A]: '100' }),
    );
    expect(input.totalUnrealizedPnlInr).toBe('-0.000000000000000001');
  });
});

describe('F14-01 mark-to-market equity — every OPEN position participates (§11/§16)', () => {
  it('sums mixed profit and loss across all pairs exactly, and never values only the candidate pair', () => {
    const positions = [
      position({ pair: PAIR_A, positionInstanceId: 'pos-a', side: 'LONG', quantity: '1000', averageEntryPriceInr: '8000' }),   // U = -3200 at mark 60
      position({ pair: PAIR_B, positionInstanceId: 'pos-b', side: 'SHORT', quantity: '2000', averageEntryPriceInr: '4000' }),  // U = (4000 - 3200) * 2000 * 0.001 = 1600 at mark 40
    ];
    const input = derived(base({ openPositions: positions }), valuation({ [PAIR_A]: '60', [PAIR_B]: '40' }));
    expect(input.totalUnrealizedPnlInr).toBe('-1600'); // -3200 + 1600
    expect(input.accountSnapshot.currentEquityInr).toBe('998400');
  });

  it('two positions on the same pair are both valued (never deduplicated by pair)', () => {
    const positions = [
      position({ pair: PAIR_A, positionInstanceId: 'pos-a', quantity: '1000' }),
      position({ pair: PAIR_A, positionInstanceId: 'pos-b', quantity: '3000' }),
    ];
    // U = (4800-8000)*1000*0.001 + (4800-8000)*3000*0.001 = -3200 + -9600
    const input = derived(base({ openPositions: positions }), valuation({ [PAIR_A]: '60' }));
    expect(input.totalUnrealizedPnlInr).toBe('-12800');
  });

  it('zero OPEN positions means exactly zero unrealized PnL and requires no valuation evidence at all (§21)', () => {
    const input = derived(base(), null);
    expect(input.totalUnrealizedPnlInr).toBe('0');
    expect(input.accountSnapshot.currentEquityInr).toBe('1000000');
    expect(input.accountSnapshot.availableMarginInr).toBe('1000000');
  });
});

describe('F14-01 mark-to-market equity — fail closed, never fall back (§17)', () => {
  it('rejects when OPEN positions exist but no valuation evidence was supplied', () => {
    expect(derive(base({ openPositions: [position()] }), null))
      .toEqual({ status: 'VALUATION_UNAVAILABLE', reason: 'NO_VALUATION_EVIDENCE_FOR_OPEN_POSITIONS' });
  });

  it('rejects when ANY open position has no mark — it is never skipped, zeroed, or valued at its entry price', () => {
    const positions = [position({ pair: PAIR_A, positionInstanceId: 'pos-a' }), position({ pair: PAIR_B, positionInstanceId: 'pos-b' })];
    const result = derive(base({ openPositions: positions }), valuation({ [PAIR_A]: '60' })); // PAIR_B missing
    expect(result).toEqual({ status: 'VALUATION_UNAVAILABLE', reason: `NO_MARK_FOR_OPEN_POSITION:${PAIR_B}` });
  });

  it('rejects a non-positive mark or conversion rate rather than producing a degenerate equity', () => {
    expect(derive(base({ openPositions: [position()] }), valuation({ [PAIR_A]: '0' })))
      .toEqual({ status: 'VALUATION_UNAVAILABLE', reason: `MARK_NOT_POSITIVE:${PAIR_A}` });
    expect(derive(base({ openPositions: [position()] }), valuation({ [PAIR_A]: '100' }, '0')))
      .toEqual({ status: 'VALUATION_UNAVAILABLE', reason: 'CONVERSION_RATE_NOT_POSITIVE' });
  });
});

describe('F14-01 mark-to-market equity — frozen V2 §12 margin interaction', () => {
  it('an unrealized LOSS reduces availableMargin through min(cashBalance, equity)', () => {
    const riskBase = base({ openPositions: [position()], lockedMarginInr: '100000', reservedCapacityInr: '50000' });
    const input = derived(riskBase, valuation({ [PAIR_A]: '60' })); // U = -3200
    expect(input.accountSnapshot.currentEquityInr).toBe('996800');
    // max(0, min(1000000, 996800) - 100000 - 50000) = 846800
    expect(input.accountSnapshot.availableMarginInr).toBe('846800');
  });

  it('an unrealized PROFIT raises equity but never becomes spendable collateral', () => {
    const riskBase = base({ openPositions: [position()], lockedMarginInr: '100000', reservedCapacityInr: '50000' });
    const input = derived(riskBase, valuation({ [PAIR_A]: '120' })); // U = +1600
    expect(input.accountSnapshot.currentEquityInr).toBe('1001600');
    // max(0, min(1000000, 1001600) - 100000 - 50000) = 850000 — the positive U is excluded.
    expect(input.accountSnapshot.availableMarginInr).toBe('850000');
  });

  it('never clamps a genuinely insolvent equity — insolvency stays visible', () => {
    // U = (4800 - 8000) * 500000 * 0.001 = -1600000 on a 1,000,000 cash balance.
    const input = derived(base({ openPositions: [position({ quantity: '500000' })] }), valuation({ [PAIR_A]: '60' }));
    expect(input.accountSnapshot.currentEquityInr).toBe('-600000');
    expect(input.accountSnapshot.availableMarginInr).toBe('0'); // only availableMargin has the documented max(0, ...) floor
  });

  it('leaves the realized-only §12.1 daily PnL untouched — unrealized PnL never leaks into the daily-loss gate', () => {
    const riskBase = base({
      openPositions: [position()],
      dailyPnl: { realizedTradingPnlInr: '-500', fundingPnlInr: '0', feesInr: '100', otherAccountAdjustmentsInr: '0', netDailyPnlInr: '-600' },
    });
    const input = derived(riskBase, valuation({ [PAIR_A]: '60' }));
    expect(input.accountSnapshot.dailyPnl).toEqual(riskBase.dailyPnl);
  });
});

describe('F14-01 CLOSE derivation (§23)', () => {
  it('needs no valuation evidence and reports the realized-only cash balance, because no CLOSE gate reads equity', () => {
    const riskBase = base({ openPositions: [position()] });
    const input = deriveCloseRiskInput({ base: riskBase, policy: POLICY });
    expect(input.totalUnrealizedPnlInr).toBe('0');
    expect(input.accountSnapshot.currentEquityInr).toBe('1000000');
    // Still fully authoritative on everything CLOSE does consume.
    expect(input.accountSnapshot.accountId).toBe('acc-1');
    expect(input.accountSnapshot.accountStateKnown).toBe(true);
    expect(input.revision).toBe(riskBase.revision);
  });
});

describe('F14-01 MTM equity adversarial risk gates (§12.3/§12.4)', () => {
  const ACCOUNT_ID = 'account-1';

  function shortPositionWithUnboundedLoss(): AuthoritativeOpenPositionValuation {
    // Entry exposure remains only ₹1 (`quantity × averageEntryPriceInr`), so
    // exposure ceilings cannot mask either assertion below. A SHORT can still
    // carry a large genuine MTM loss as its mark rises.
    return position({
      pair: PAIR_A, positionInstanceId: 'short-pos', side: 'SHORT',
      quantity: '1', averageEntryPriceInr: '1', contractMultiplier: '1',
    });
  }

  async function admitCandidate(currentEquityInput: AuthoritativePaperRiskInput, policy = policyFor(PAIR_B)) {
    const kernel = makeKernel(PAIR_B);
    const decision = evaluateDecision(kernel, T0);
    const context = buildContext(kernel, decision, {
      accountSnapshot: currentEquityInput.accountSnapshot,
      exposureSnapshot: currentEquityInput.exposureSnapshot,
    });
    return new RiskAdmissionCoordinator().admit({ accountId: ACCOUNT_ID, policy, context });
  }

  it('an unrealized loss alone crosses the 40% drawdown breaker; realized-only cash would have admitted', async () => {
    const openPosition = shortPositionWithUnboundedLoss();
    const riskBase = base({
      accountId: ACCOUNT_ID, openPositions: [openPosition],
      exposureSnapshot: exposureFor([openPosition]),
    });

    // Break-even mark: 0.0125 USDT × 80 = ₹1, so U=0 and drawdown=0.
    const realizedOnlyControl = await admitCandidate(derived(riskBase, valuation({ [PAIR_A]: '0.0125' })));
    expect(realizedOnlyControl.status).toBe('ADMITTED');

    // 5000.0125 USDT × 80 = ₹400001; SHORT U=(₹1-₹400001)×1×1=-₹400000.
    // Equity is therefore ₹600000 against a ₹1000000 peak: exactly the mode
    // limit, whose frozen comparison is inclusive (`>= 40%`).
    const markedToMarket = await admitCandidate(derived(riskBase, valuation({ [PAIR_A]: '5000.0125' })));
    expect(markedToMarket.status).toBe('REJECTED');
    if (markedToMarket.status !== 'REJECTED') return;
    expect(markedToMarket.decision).toMatchObject({
      status: 'REJECTED', primaryReasonCode: 'DRAWDOWN_LIMIT', approved: null,
    });
  });

  it('an unrealized loss reduces the risk budget and final quantity exactly, while no unrelated cap is binding', async () => {
    const openPosition = shortPositionWithUnboundedLoss();
    const riskBase = base({
      accountId: ACCOUNT_ID, openPositions: [openPosition],
      exposureSnapshot: exposureFor([openPosition]),
    });

    const sizingPolicy = makePolicy({
      pairConfig: { ...POLICY.pairConfig, pair: PAIR_B },
      modeConfig: { ...POLICY.modeConfig, riskPerTradePercent: '0.5' },
    });
    const breakEven = await admitCandidate(derived(riskBase, valuation({ [PAIR_A]: '0.0125' })), sizingPolicy);
    expect(breakEven.status).toBe('ADMITTED');
    if (breakEven.status !== 'ADMITTED') return;
    // Equity ₹1,000,000 × 0.5% / ₹0.8 stop risk per unit = 6,250.
    expect(breakEven.decision.approved.approvedQuantity).toBe('6250');

    // 2500.0125 USDT × 80 = ₹200001 => U=-₹200000, equity=₹800000.
    const losing = await admitCandidate(derived(riskBase, valuation({ [PAIR_A]: '2500.0125' })), sizingPolicy);
    expect(losing.status).toBe('ADMITTED');
    if (losing.status !== 'ADMITTED') return;
    // Equity ₹800,000 × 0.5% / ₹0.8 = 5,000 exactly.
    expect(losing.decision.approved.approvedQuantity).toBe('5000');
    expect(paperDecimal(losing.decision.approved.approvedQuantity).lt(breakEven.decision.approved.approvedQuantity)).toBe(true);
  });
});
