import {
  BACKTEST_ZERO,
  BacktestCalcDecimal,
  BacktestDecimal,
  publicDecimal,
  toBacktestCalcDecimal,
  type BacktestCalc,
} from './decimal';
import { BacktestError } from './errors';
import { deepFreeze } from './immutable';
import type {
  BacktestEquitySnapshot,
  BacktestFeeClass,
  BacktestFillSnapshot,
  BacktestInstrumentSpec,
  BacktestOrderSide,
  BacktestPositionSide,
  BacktestPositionSnapshot,
  BacktestFinancialSummary,
} from './types';

export interface ApplyBacktestFillInput {
  readonly fillId: string;
  readonly orderId: string;
  readonly orderSequence: number;
  readonly eventTimeMs: number;
  readonly side: BacktestOrderSide;
  readonly quantity: BacktestCalc;
  readonly fillPrice: BacktestCalc;
  readonly rawReferencePrice: BacktestCalc;
  readonly feeClass: BacktestFeeClass;
  readonly feeRate: BacktestCalc;
  readonly spreadRate: BacktestCalc;
  readonly slippageRate: BacktestCalc;
}

export class BacktestAccountingLedger {
  readonly #initialEquity: BacktestCalc;
  readonly #multiplier: BacktestCalc;
  #side: BacktestPositionSide = 'FLAT';
  #quantity: BacktestCalc = new BacktestCalcDecimal(BACKTEST_ZERO);
  #averageEntryPrice: BacktestCalc | null = null;
  #markPrice: BacktestCalc | null = null;
  #realizedGrossPnl: BacktestCalc = new BacktestCalcDecimal(BACKTEST_ZERO);
  #unrealizedGrossPnl: BacktestCalc = new BacktestCalcDecimal(BACKTEST_ZERO);
  #makerFees: BacktestCalc = new BacktestCalcDecimal(BACKTEST_ZERO);
  #takerFees: BacktestCalc = new BacktestCalcDecimal(BACKTEST_ZERO);
  #fundingPnl: BacktestCalc = new BacktestCalcDecimal(BACKTEST_ZERO);
  #spreadCostAttribution: BacktestCalc = new BacktestCalcDecimal(BACKTEST_ZERO);
  #slippageCostAttribution: BacktestCalc = new BacktestCalcDecimal(BACKTEST_ZERO);
  #totalFills = 0;
  #totalClosedTrades = 0;

  public constructor(initialEquity: BacktestDecimal | string, instrumentSpec: BacktestInstrumentSpec) {
    this.#initialEquity = toBacktestCalcDecimal(initialEquity);
    this.#multiplier = toBacktestCalcDecimal(instrumentSpec.contractMultiplier);
    if (this.#initialEquity.lessThanOrEqualTo(0) || this.#multiplier.lessThanOrEqualTo(0)) {
      throw new BacktestError('BACKTEST_NUMERIC_FAILURE', 'Initial equity and contract multiplier must be positive');
    }
  }

  public get totalFills(): number { return this.#totalFills; }
  public get totalClosedTrades(): number { return this.#totalClosedTrades; }
  public get positionSide(): BacktestPositionSide { return this.#side; }
  public get positionQuantityCalc(): BacktestCalc { return new BacktestCalcDecimal(this.#quantity); }

  public applyFill(input: ApplyBacktestFillInput): BacktestFillSnapshot {
    if (!input.quantity.isFinite() || input.quantity.lessThanOrEqualTo(0) ||
        !input.fillPrice.isFinite() || input.fillPrice.lessThanOrEqualTo(0) ||
        input.feeRate.isNegative() || input.spreadRate.isNegative() || input.slippageRate.isNegative()) {
      throw new BacktestError('BACKTEST_NUMERIC_FAILURE', 'Invalid fill arithmetic input');
    }
    const notional = input.quantity.times(input.fillPrice).times(this.#multiplier);
    const fee = notional.times(input.feeRate);
    const spread = input.rawReferencePrice.times(input.spreadRate).times(input.quantity).times(this.#multiplier);
    const slippage = input.rawReferencePrice.times(input.slippageRate).times(input.quantity).times(this.#multiplier);
    let realized = new BacktestCalcDecimal(BACKTEST_ZERO);
    let closingQuantityForFill = new BacktestCalcDecimal(BACKTEST_ZERO);
    const incomingSide: Exclude<BacktestPositionSide, 'FLAT'> = input.side === 'BUY' ? 'LONG' : 'SHORT';

    if (this.#side === 'FLAT') {
      this.#side = incomingSide;
      this.#quantity = new BacktestCalcDecimal(input.quantity);
      this.#averageEntryPrice = new BacktestCalcDecimal(input.fillPrice);
    } else if (this.#side === incomingSide) {
      const oldNotionalPrice = this.#quantity.times(this.requireEntry());
      const newQuantity = this.#quantity.plus(input.quantity);
      this.#averageEntryPrice = oldNotionalPrice.plus(input.quantity.times(input.fillPrice)).dividedBy(newQuantity);
      this.#quantity = newQuantity;
    } else {
      const closingQuantity = BacktestCalcDecimal.min(this.#quantity, input.quantity);
      closingQuantityForFill = new BacktestCalcDecimal(closingQuantity);
      realized = this.#side === 'LONG'
        ? input.fillPrice.minus(this.requireEntry()).times(closingQuantity).times(this.#multiplier)
        : this.requireEntry().minus(input.fillPrice).times(closingQuantity).times(this.#multiplier);
      this.#realizedGrossPnl = this.#realizedGrossPnl.plus(realized);
      this.#totalClosedTrades++;
      if (input.quantity.lessThan(this.#quantity)) {
        this.#quantity = this.#quantity.minus(input.quantity);
      } else if (input.quantity.equals(this.#quantity)) {
        this.#side = 'FLAT';
        this.#quantity = new BacktestCalcDecimal(BACKTEST_ZERO);
        this.#averageEntryPrice = null;
        this.#unrealizedGrossPnl = new BacktestCalcDecimal(BACKTEST_ZERO);
      } else {
        this.#side = incomingSide;
        this.#quantity = input.quantity.minus(closingQuantity);
        this.#averageEntryPrice = new BacktestCalcDecimal(input.fillPrice);
      }
    }

    if (input.feeClass === 'MAKER') this.#makerFees = this.#makerFees.plus(fee);
    else this.#takerFees = this.#takerFees.plus(fee);
    this.#spreadCostAttribution = this.#spreadCostAttribution.plus(spread);
    this.#slippageCostAttribution = this.#slippageCostAttribution.plus(slippage);
    this.#totalFills++;
    if (this.#markPrice !== null) this.mark(this.#markPrice);
    this.assertInternalState();
    return deepFreeze({
      fillId: input.fillId,
      orderId: input.orderId,
      orderSequence: input.orderSequence,
      eventTimeMs: input.eventTimeMs,
      side: input.side,
      quantity: publicDecimal(input.quantity),
      fillPrice: publicDecimal(input.fillPrice),
      rawReferencePrice: publicDecimal(input.rawReferencePrice),
      feeClass: input.feeClass,
      fee: publicDecimal(fee),
      realizedGrossPnl: publicDecimal(realized),
      closingQuantity: publicDecimal(closingQuantityForFill),
      spreadCostAttribution: publicDecimal(spread),
      slippageCostAttribution: publicDecimal(slippage),
    });
  }

  public mark(markPrice: BacktestCalc): void {
    if (!markPrice.isFinite() || markPrice.lessThanOrEqualTo(0)) {
      throw new BacktestError('BACKTEST_NUMERIC_FAILURE', 'Mark price must be strictly positive');
    }
    this.#markPrice = new BacktestCalcDecimal(markPrice);
    if (this.#side === 'FLAT') {
      this.#unrealizedGrossPnl = new BacktestCalcDecimal(BACKTEST_ZERO);
    } else {
      const delta = this.#side === 'LONG'
        ? markPrice.minus(this.requireEntry())
        : this.requireEntry().minus(markPrice);
      this.#unrealizedGrossPnl = delta.times(this.#quantity).times(this.#multiplier);
    }
    this.assertInternalState();
  }

  public applyFunding(fundingRate: BacktestCalc, referencePrice: BacktestCalc): BacktestCalc {
    if (!fundingRate.isFinite() || !referencePrice.isFinite() || referencePrice.lessThanOrEqualTo(0)) {
      throw new BacktestError('BACKTEST_NUMERIC_FAILURE', 'Funding inputs must be finite and reference price positive');
    }
    const sign = this.#side === 'LONG' ? new BacktestCalcDecimal('1')
      : this.#side === 'SHORT' ? new BacktestCalcDecimal('-1') : new BacktestCalcDecimal('0');
    const fundingNotional = this.#quantity.abs().times(referencePrice).times(this.#multiplier);
    const applied = sign.negated().times(fundingNotional).times(fundingRate);
    this.#fundingPnl = this.#fundingPnl.plus(applied);
    this.assertInternalState();
    return applied;
  }

  public positionSnapshot(): BacktestPositionSnapshot {
    return deepFreeze({
      side: this.#side,
      quantity: publicDecimal(this.#quantity),
      averageEntryPrice: this.#averageEntryPrice === null ? null : publicDecimal(this.#averageEntryPrice),
      markPrice: this.#markPrice === null ? null : publicDecimal(this.#markPrice),
      unrealizedGrossPnl: publicDecimal(this.#unrealizedGrossPnl),
    });
  }

  public equitySnapshot(): BacktestEquitySnapshot {
    const totalFees = this.#makerFees.plus(this.#takerFees);
    const netPnl = this.#realizedGrossPnl.plus(this.#unrealizedGrossPnl).plus(this.#fundingPnl).minus(totalFees);
    const equity = this.#initialEquity.plus(netPnl);
    return deepFreeze({
      initialEquity: publicDecimal(this.#initialEquity),
      equity: publicDecimal(equity),
      realizedGrossPnl: publicDecimal(this.#realizedGrossPnl),
      unrealizedGrossPnl: publicDecimal(this.#unrealizedGrossPnl),
      makerFees: publicDecimal(this.#makerFees),
      takerFees: publicDecimal(this.#takerFees),
      totalFees: publicDecimal(totalFees),
      fundingPnl: publicDecimal(this.#fundingPnl),
      spreadCostAttribution: publicDecimal(this.#spreadCostAttribution),
      slippageCostAttribution: publicDecimal(this.#slippageCostAttribution),
      netPnl: publicDecimal(netPnl),
    });
  }

  public financialSummary(): BacktestFinancialSummary {
    const snapshot = this.equitySnapshot();
    return deepFreeze({
      initialEquity: snapshot.initialEquity,
      finalEquity: snapshot.equity,
      realizedGrossPnl: snapshot.realizedGrossPnl,
      unrealizedGrossPnl: snapshot.unrealizedGrossPnl,
      netPnl: snapshot.netPnl,
      makerFees: snapshot.makerFees,
      takerFees: snapshot.takerFees,
      totalFees: snapshot.totalFees,
      fundingPnl: snapshot.fundingPnl,
      spreadCostAttribution: snapshot.spreadCostAttribution,
      slippageCostAttribution: snapshot.slippageCostAttribution,
    });
  }

  private requireEntry(): BacktestCalc {
    if (this.#averageEntryPrice === null) throw new BacktestError('POSITION_CONFLICT', 'Non-flat position has no entry price');
    return this.#averageEntryPrice;
  }

  private assertInternalState(): void {
    const values = [this.#initialEquity, this.#quantity, this.#realizedGrossPnl, this.#unrealizedGrossPnl,
      this.#makerFees, this.#takerFees, this.#fundingPnl, this.#spreadCostAttribution, this.#slippageCostAttribution];
    if (values.some((value) => !value.isFinite() || value.isNaN()) || this.#quantity.isNegative() ||
        ((this.#side === 'FLAT') !== this.#quantity.isZero()) ||
        (this.#side === 'FLAT' ? this.#averageEntryPrice !== null : this.#averageEntryPrice === null)) {
      throw new BacktestError('BACKTEST_NUMERIC_FAILURE', 'Accounting state invariant failed');
    }
  }
}
