import { describe, expect, it } from 'vitest';
import {
  assertQuantityAligned, canonicalPaperDecimalString, ceilToTick, floorToTick, paperDecimal, PaperDecimal,
} from '../../../src/execution/decimal';
import { PaperEngineError } from '../../../src/execution/errors';

describe('P14-A tick rounding — BUY ceil / SELL floor', () => {
  it('BUY ceils up to the next tick when not already aligned', () => {
    const result = ceilToTick(paperDecimal('100.0001'), paperDecimal('0.01'));
    expect(result.toFixed()).toBe('100.01');
  });

  it('SELL floors down to the previous tick when not already aligned', () => {
    const result = floorToTick(paperDecimal('100.0099'), paperDecimal('0.01'));
    expect(result.toFixed()).toBe('100');
  });

  it('leaves an exactly-aligned value unchanged under ceil', () => {
    const result = ceilToTick(paperDecimal('100.05'), paperDecimal('0.01'));
    expect(result.toFixed()).toBe('100.05');
  });

  it('leaves an exactly-aligned value unchanged under floor', () => {
    const result = floorToTick(paperDecimal('100.05'), paperDecimal('0.01'));
    expect(result.toFixed()).toBe('100.05');
  });

  it('handles a difficult decimal increment (0.00000001 tick, 18-decimal boundary)', () => {
    const ceiled = ceilToTick(paperDecimal('0.000000019999999999'), paperDecimal('0.00000001'));
    expect(ceiled.toFixed()).toBe('0.00000002');
    const floored = floorToTick(paperDecimal('0.000000019999999999'), paperDecimal('0.00000001'));
    expect(floored.toFixed()).toBe('0.00000001');
  });

  it('handles a 1e-18 boundary value exactly', () => {
    const tiny = paperDecimal('0.000000000000000001');
    const ceiled = ceilToTick(tiny, paperDecimal('0.000000000000000001'));
    expect(ceiled.toFixed()).toBe(tiny.toFixed());
  });

  it('rejects a non-positive tick size', () => {
    expect(() => ceilToTick(paperDecimal('1'), paperDecimal('0'))).toThrow(PaperEngineError);
    expect(() => floorToTick(paperDecimal('1'), paperDecimal('-0.01'))).toThrow(PaperEngineError);
  });

  it('handles a negative value under ceil/floor correctly (magnitude-safe rounding toward the correct multiple)', () => {
    expect(ceilToTick(paperDecimal('-100.0099'), paperDecimal('0.01')).toFixed()).toBe('-100');
    expect(floorToTick(paperDecimal('-100.0001'), paperDecimal('0.01')).toFixed()).toBe('-100.01');
  });
});

describe('P14-A quantity policy — reject, never resize', () => {
  it('accepts an already-aligned quantity silently', () => {
    expect(() => assertQuantityAligned(paperDecimal('10'), paperDecimal('1'))).not.toThrow();
    expect(() => assertQuantityAligned(paperDecimal('0.006'), paperDecimal('0.001'))).not.toThrow();
  });

  it('rejects a misaligned quantity rather than resizing it', () => {
    expect(() => assertQuantityAligned(paperDecimal('10.5'), paperDecimal('1'))).toThrow(PaperEngineError);
    try {
      assertQuantityAligned(paperDecimal('10.5'), paperDecimal('1'));
    } catch (error) {
      expect(error).toBeInstanceOf(PaperEngineError);
      expect((error as PaperEngineError).code).toBe('PAPER_QUANTITY_MISALIGNED');
    }
  });
});

describe('P14-A canonical decimal string normalization', () => {
  it('normalizes numerically equivalent representations identically', () => {
    expect(canonicalPaperDecimalString('2')).toBe(canonicalPaperDecimalString('2.0'));
    expect(canonicalPaperDecimalString('002.000')).toBe(canonicalPaperDecimalString('2'));
    expect(canonicalPaperDecimalString('0.0010')).toBe(canonicalPaperDecimalString('0.001'));
  });

  it('normalizes "-0" to "0"', () => {
    expect(canonicalPaperDecimalString('-0')).toBe('0');
    expect(canonicalPaperDecimalString('-0.000')).toBe('0');
  });

  it('rejects scientific notation and non-fixed-point input', () => {
    expect(() => canonicalPaperDecimalString('1e10')).toThrow(PaperEngineError);
    expect(() => canonicalPaperDecimalString('not-a-decimal')).toThrow(PaperEngineError);
    expect(() => canonicalPaperDecimalString(123 as unknown as string)).toThrow(PaperEngineError);
  });
});

describe('P14-A PaperDecimal — Q18 ROUND_HALF_UP durable-posting boundary', () => {
  it('quantizes to 18 fractional digits with ROUND_HALF_UP', () => {
    const value = new PaperDecimal(paperDecimal('1.1234567890123456785'));
    expect(value.value).toBe('1.123456789012345679');
  });

  it('fails closed on overflow beyond the Decimal(36,18) envelope', () => {
    const huge = paperDecimal('9'.repeat(19));
    expect(() => new PaperDecimal(huge)).toThrow(PaperEngineError);
    try {
      new PaperDecimal(huge);
    } catch (error) {
      expect((error as PaperEngineError).code).toBe('PAPER_OVERFLOW');
    }
  });

  it('fails closed on non-finite input', () => {
    expect(() => new PaperDecimal('not-a-number' as never)).toThrow(PaperEngineError);
  });

  it('round-trips a 1e-18 value exactly', () => {
    const value = new PaperDecimal(paperDecimal('0.000000000000000001'));
    expect(value.value).toBe('0.000000000000000001');
  });
});
