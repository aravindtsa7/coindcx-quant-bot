import { describe, it, expect } from 'vitest';
import {
  toDecimal,
  add,
  sub,
  mul,
  div,
  eq,
  gt,
  gte,
  lt,
  lte,
  roundTo,
  toFixedString,
  zeroDecimal,
  oneDecimal,
  minDecimal,
  maxDecimal,
} from '../../src/core/decimal/decimal';

describe('Decimal Safety & Arithmetic', () => {
  it('proves 0.1 + 0.2 equals 0.3 without binary floating point inaccuracy', () => {
    // Native JavaScript IEEE-754 binary floating point failure demonstration:
    const nativeSum = 0.1 + 0.2;
    expect(nativeSum).not.toBe(0.3);
    expect(nativeSum).toBe(0.30000000000000004);

    // Decimal-safe execution demonstration:
    const decimalSum = add('0.1', '0.2');
    expect(eq(decimalSum, '0.3')).toBe(true);
    expect(decimalSum.toString()).toBe('0.3');
  });

  it('proves 0.3 - 0.2 equals 0.1 without floating point drift', () => {
    const nativeDiff = 0.3 - 0.2;
    expect(nativeDiff).not.toBe(0.1);

    const decimalDiff = sub('0.3', '0.2');
    expect(eq(decimalDiff, '0.1')).toBe(true);
  });

  it('accurately calculates high-precision crypto satoshi/wei values (18 decimals)', () => {
    const amountA = '0.000000000000000001';
    const amountB = '0.000000000000000002';
    const total = add(amountA, amountB);

    expect(total.toString()).toBe('0.000000000000000003');
    expect(eq(total, '0.000000000000000003')).toBe(true);
  });

  it('performs exact multiplication and fee calculations', () => {
    // e.g. 0.05% fee on 75,432.15 INR position
    const notional = '75432.15';
    const feeRate = '0.0005';
    const fee = mul(notional, feeRate);

    expect(fee.toString()).toBe('37.716075');
    expect(toFixedString(fee, 2)).toBe('37.72');
  });

  it('safely handles division and throws on division by zero', () => {
    const result = div('100', '3');
    // Default 30 precision
    expect(result.toString().startsWith('33.3333333333333333333333333333')).toBe(true);

    expect(() => div('100', '0')).toThrow('Division by zero in decimal calculation');
    expect(() => div('100', zeroDecimal())).toThrow('Division by zero in decimal calculation');
  });

  it('correctly evaluates all comparison operators', () => {
    expect(gt('10.00001', '10.00000')).toBe(true);
    expect(gte('10.000', '10')).toBe(true);
    expect(lt('9.999999', '10.0')).toBe(true);
    expect(lte('10.00', '10.0')).toBe(true);
    expect(eq('42.0000', '42')).toBe(true);
  });

  it('rounds correctly using standard financial rounding (ROUND_HALF_UP)', () => {
    expect(toFixedString(roundTo('1.005', 2), 2)).toBe('1.01');
    expect(toFixedString(roundTo('1.004', 2), 2)).toBe('1.00');
  });

  it('correctly finds min and max across arbitrary decimal sets', () => {
    const vals = ['10.5', '2.3', '99.1', '-4.5', '0'];
    expect(minDecimal(...vals).toString()).toBe('-4.5');
    expect(maxDecimal(...vals).toString()).toBe('99.1');
  });

  it('provides zero and one constants', () => {
    expect(zeroDecimal().isZero()).toBe(true);
    expect(oneDecimal().equals(1)).toBe(true);
    expect(toDecimal(0).equals(zeroDecimal())).toBe(true);
  });
});

