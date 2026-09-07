export * from './ema-trend';
export * from './atr-breakout';
export * from './rsi-momentum';
export * from './multi-timeframe-trend';

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
