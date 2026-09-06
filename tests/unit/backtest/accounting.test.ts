import { describe, expect, it } from 'vitest';
import {
  BacktestAccountingLedger,
  BacktestCalcDecimal,
  BacktestDecimal,
  sha256CanonicalJson,
} from '../../../src/backtest';

const instrument = {
  pair: 'B-BTC_INR',
  priceIncrement: new BacktestDecimal('0.01'),
  quantityIncrement: new BacktestDecimal('0.001'),
  minQuantity: new BacktestDecimal('0.001'),
  minTradeSize: new BacktestDecimal('0.001'),
  minNotional: new BacktestDecimal('1'),
  contractMultiplier: new BacktestDecimal('2'),
  instrumentSpecSnapshotId: sha256CanonicalJson({ fixture: 'instrument' }),
};

function fill(ledger: BacktestAccountingLedger, sequence: number, side: 'BUY' | 'SELL', quantity: string, price: string) {
  return ledger.applyFill({
    fillId: `F${sequence}`,
    orderId: `O${sequence}`,
    orderSequence: sequence,
    eventTimeMs: sequence * 60_000,
    side,
    quantity: new BacktestCalcDecimal(quantity),
    fillPrice: new BacktestCalcDecimal(price),
    rawReferencePrice: new BacktestCalcDecimal(price),
    feeClass: sequence % 2 === 0 ? 'MAKER' : 'TAKER',
    feeRate: new BacktestCalcDecimal('0.001'),
    spreadRate: new BacktestCalcDecimal('0'),
    slippageRate: new BacktestCalcDecimal('0'),
  });
}

describe('Phase 9 position and accounting ledger', () => {
  it('opens long/short and computes exact weighted average on increases', () => {
    const long = new BacktestAccountingLedger('10000', instrument);
    fill(long, 1, 'BUY', '1', '100');
    fill(long, 2, 'BUY', '3', '200');
    expect(long.positionSnapshot()).toMatchObject({ side: 'LONG', quantity: { value: '4' } });
    expect(long.positionSnapshot().averageEntryPrice?.value).toBe('175');

    const short = new BacktestAccountingLedger('10000', instrument);
    fill(short, 1, 'SELL', '1', '100');
    expect(short.positionSnapshot().side).toBe('SHORT');
  });

  it('supports partial reduction and full close with linear multiplier PnL', () => {
    const ledger = new BacktestAccountingLedger('10000', instrument);
    fill(ledger, 1, 'BUY', '2', '100');
    fill(ledger, 2, 'SELL', '0.5', '110');
    expect(ledger.positionSnapshot().quantity.value).toBe('1.5');
    expect(ledger.equitySnapshot().realizedGrossPnl.value).toBe('10');
    fill(ledger, 3, 'SELL', '1.5', '90');
    expect(ledger.positionSnapshot().side).toBe('FLAT');
    expect(ledger.equitySnapshot().realizedGrossPnl.value).toBe('-20');
  });

  it.each([
    ['BUY', 'SELL', 'SHORT', '20'],
    ['SELL', 'BUY', 'LONG', '20'],
  ] as const)('reverses %s to %s using closing quantity only and one total fill fee', (entrySide, reversalSide, terminalSide, pnlMagnitude) => {
    const ledger = new BacktestAccountingLedger('10000', instrument);
    fill(ledger, 1, entrySide, '1', '100');
    const reversal = fill(ledger, 2, reversalSide, '2', entrySide === 'BUY' ? '110' : '90');
    expect(ledger.positionSnapshot()).toMatchObject({ side: terminalSide, quantity: { value: '1' } });
    expect(ledger.positionSnapshot().averageEntryPrice?.value).toBe(entrySide === 'BUY' ? '110' : '90');
    expect(reversal.realizedGrossPnl.value).toBe(pnlMagnitude);
    expect(reversal.fee.value).toBe(entrySide === 'BUY' ? '0.44' : '0.36');
    expect(ledger.totalFills).toBe(2);
    expect(ledger.totalClosedTrades).toBe(1);
  });

  it('marks unrealized PnL and preserves the net/equity identity without cost double deduction', () => {
    const ledger = new BacktestAccountingLedger('10000', instrument);
    ledger.applyFill({
      fillId: 'F1', orderId: 'O1', orderSequence: 1, eventTimeMs: 60_000,
      side: 'BUY', quantity: new BacktestCalcDecimal('1'), fillPrice: new BacktestCalcDecimal('101'),
      rawReferencePrice: new BacktestCalcDecimal('100'), feeClass: 'TAKER', feeRate: new BacktestCalcDecimal('0.001'),
      spreadRate: new BacktestCalcDecimal('0.005'), slippageRate: new BacktestCalcDecimal('0.005'),
    });
    ledger.mark(new BacktestCalcDecimal('110'));
    const account = ledger.equitySnapshot();
    expect(account.unrealizedGrossPnl.value).toBe('18');
    expect(account.totalFees.value).toBe('0.202');
    expect(account.spreadCostAttribution.value).toBe('1');
    expect(account.slippageCostAttribution.value).toBe('1');
    expect(account.netPnl.value).toBe('17.798');
    expect(account.equity.value).toBe('10017.798');
  });
});
