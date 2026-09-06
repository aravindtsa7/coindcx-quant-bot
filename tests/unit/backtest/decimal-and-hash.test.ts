import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  BacktestCalcDecimal,
  BacktestDecimal,
  BacktestError,
  canonicalJson,
  sha256CanonicalJson,
} from '../../../src/backtest';

describe('Phase 9 decimal and canonical hash', () => {
  it('uses an isolated 128 digit context without changing global Decimal', () => {
    const globalPrecision = Decimal.precision;
    expect(BacktestCalcDecimal.precision).toBe(128);
    expect(BacktestCalcDecimal.rounding).toBe(Decimal.ROUND_HALF_UP);
    expect(Decimal.precision).toBe(globalPrecision);
    expect(new BacktestCalcDecimal('9'.repeat(70)).plus('1').toFixed()).toBe(`1${'0'.repeat(70)}`);
  });

  it('quantizes once at 18dp, normalizes negative zero, and rejects post-rounding overflow', () => {
    expect(new BacktestDecimal('1.1234567890123456785').value).toBe('1.123456789012345679');
    expect(new BacktestDecimal('-0.0000000000000000001').value).toBe('0');
    expect(() => new BacktestDecimal(`${'9'.repeat(30)}.9999999999999999995`)).toThrowError(BacktestError);
  });

  it('rejects exponents and non-finite values', () => {
    expect(() => new BacktestDecimal('1e3')).toThrowError(BacktestError);
    expect(() => new BacktestDecimal(new BacktestCalcDecimal('Infinity'))).toThrowError(BacktestError);
  });

  it('sorts object keys recursively while preserving arrays', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [3, 2, 1] })).toBe('{"a":{"x":3,"y":2},"list":[3,2,1],"z":1}');
    expect(sha256CanonicalJson({ b: 2, a: 1 })).toBe(sha256CanonicalJson({ a: 1, b: 2 }));
  });

  it('rejects unsafe integer, undefined, Date, and cyclic canonical inputs', () => {
    expect(() => canonicalJson({ bad: 1.5 })).toThrowError(BacktestError);
    expect(() => canonicalJson({ bad: undefined })).toThrowError(BacktestError);
    expect(() => canonicalJson(new Date(0))).toThrowError(BacktestError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrowError(BacktestError);
  });
});
