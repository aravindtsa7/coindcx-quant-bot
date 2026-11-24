export * from './ema-trend';
export * from './atr-breakout';
export * from './rsi-momentum';
export * from './multi-timeframe-trend';
export * from './supertrend';
export * from './vwap-mean-reversion';
export * from './futures-events';

import { atrBreakoutV1Definition } from './atr-breakout';
import { emaTrendV1Definition } from './ema-trend';
import { multiTimeframeTrendV1Definition } from './multi-timeframe-trend';
import { rsiMomentumV1Definition } from './rsi-momentum';

export const PHASE10_STRATEGY_DEFINITIONS = Object.freeze([
  emaTrendV1Definition,
  atrBreakoutV1Definition,
  rsiMomentumV1Definition,
  multiTimeframeTrendV1Definition,
]);

import { supertrendV1Definition } from './supertrend';
import { vwapMeanReversionV1Definition } from './vwap-mean-reversion';
import { FUTURES_STRATEGY_DEFINITIONS } from './futures-events';
/** Explicit production definitions for research and paper lineage validation; the Phase 10 catalog stays stable. */
export const RESEARCH_STRATEGY_DEFINITIONS = Object.freeze([
  ...PHASE10_STRATEGY_DEFINITIONS, supertrendV1Definition, vwapMeanReversionV1Definition,
  ...Object.values(FUTURES_STRATEGY_DEFINITIONS),
]);
