import type { IndicatorCalc } from './decimal/indicator-calc-decimal';
import type { IndicatorDecimal } from './decimal/indicator-decimal';

export const PRICE_SOURCES = ['CLOSE', 'OPEN', 'HIGH', 'LOW', 'HL2', 'HLC3', 'OHLC4'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export interface IndicatorCandle {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly openTimeMs: number;
  readonly closeTimeExclusiveMs: number;
  readonly open: IndicatorCalc;
  readonly high: IndicatorCalc;
  readonly low: IndicatorCalc;
  readonly close: IndicatorCalc;
  readonly volume: IndicatorCalc;
  readonly quoteVolume: IndicatorCalc | null;
}

export interface IndicatorPoint<T> {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly openTimeMs: number;
  readonly closeTimeExclusiveMs: number;
  readonly value: T | null;
}

export interface IndicatorCalculationSegmentIdentity {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly indicatorType: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly priceSource?: PriceSource;
  readonly bootstrapStartOpenTimeMs: number;
}

export interface IndicatorKernel<T> {
  readonly segment: IndicatorCalculationSegmentIdentity;
  readonly isTerminated: boolean;
  update(candle: IndicatorCandle): IndicatorPoint<T>;
}

export interface ScalarIndicatorConfig {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly bootstrapStartOpenTimeMs: number;
  readonly period: number;
  readonly priceSource?: PriceSource;
}

export interface PeriodIndicatorConfig {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly bootstrapStartOpenTimeMs: number;
  readonly period: number;
}

export interface BollingerValue {
  readonly middle: IndicatorDecimal;
  readonly upper: IndicatorDecimal;
  readonly lower: IndicatorDecimal;
  readonly stdDev: IndicatorDecimal;
}
export interface MacdValue {
  readonly macd: IndicatorDecimal;
  readonly signal: IndicatorDecimal | null;
  readonly histogram: IndicatorDecimal | null;
}
export interface DmiAdxValue {
  readonly plusDI: IndicatorDecimal;
  readonly minusDI: IndicatorDecimal;
  readonly adx: IndicatorDecimal | null;
}
export interface SuperTrendValue {
  readonly value: IndicatorDecimal;
  readonly direction: 'UP' | 'DOWN';
}
export interface DonchianValue {
  readonly upper: IndicatorDecimal;
  readonly lower: IndicatorDecimal;
  readonly middle: IndicatorDecimal;
}
