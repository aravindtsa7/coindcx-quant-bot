import type { IndicatorKernel, IndicatorPoint, PriceSource } from '../../indicators/types';

export type StrategyIndicatorType = 'EMA' | 'ATR' | 'RSI' | 'SMA' | 'MACD' | 'BOLLINGER' | 'SUPERTREND';
export type StrategyDecisionStatus = 'WARMING' | 'READY';
export type StrategyTargetExposure = 'LONG' | 'SHORT' | 'FLAT';

export interface StrategyIndicatorBootstrapIdentityEntry {
  readonly timeframeMinutes: number;
  readonly bootstrapStartOpenTimeMs: number;
}

export interface StrategyIndicatorRequirement {
  readonly alias: string;
  readonly indicatorType: StrategyIndicatorType;
  readonly timeframeMinutes: number;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly priceSource?: PriceSource;
}

export interface StrategyCandleSnapshot {
  readonly pair: string;
  readonly timeframeMinutes: number;
  readonly openTimeMs: number;
  readonly closeTimeExclusiveMs: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly quoteVolume: string | null;
}

export interface StrategyEvaluationSnapshot {
  readonly pair: string;
  readonly evaluationTimeMs: number;
  readonly triggerClosedCandle: StrategyCandleSnapshot;
  readonly latestClosedCandleByTimeframe: ReadonlyMap<number, StrategyCandleSnapshot>;
  readonly candlesClosedAtThisTimestamp: readonly StrategyCandleSnapshot[];
  readonly latestIndicatorPointByAlias: ReadonlyMap<string, IndicatorPoint<unknown>>;
}

export interface StrategyDecision {
  readonly decisionId: string;
  readonly decisionSequence: number;
  readonly strategyInstanceId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly parameterHash: string;
  readonly pair: string;
  readonly evaluationTimeMs: number;
  readonly triggerTimeframeMinutes: number;
  readonly status: StrategyDecisionStatus;
  readonly targetExposure: StrategyTargetExposure | null;
  readonly reasonCodes: readonly string[];
}

export interface StrategyKernel {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly normalizedParameters: Readonly<Record<string, unknown>>;
  readonly parameterHash: string;
  readonly strategyInstanceId: string;
  readonly pair: string;
  readonly indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[];
  readonly triggerTimeframeMinutes: number;
  readonly indicatorRequirements: readonly StrategyIndicatorRequirement[];
  readonly isTerminated: boolean;
  evaluate(snapshot: StrategyEvaluationSnapshot): StrategyDecision;
}

export interface StrategyKernelConfig<TParameters> {
  readonly pair: string;
  readonly parameters: TParameters;
  readonly indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[];
}

export interface StrategyConstructionDescription<TParameters extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  readonly normalizedParameters: TParameters;
  readonly triggerTimeframeMinutes: number;
  readonly indicatorRequirements: readonly StrategyIndicatorRequirement[];
}

export interface StrategyDefinition<TParameters extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  readonly strategyId: string;
  readonly strategyVersion: string;
  normalizeParameters(parameters: unknown): TParameters;
  describeConstruction(parameters: unknown): StrategyConstructionDescription<TParameters>;
  createKernel(config: StrategyKernelConfig<unknown>): StrategyKernel;
}

export interface StrategyIndicatorBinding {
  readonly alias: string;
  readonly requirement: StrategyIndicatorRequirement;
  readonly kernel: IndicatorKernel<unknown>;
}

export interface StrategyDecisionSink {
  writeDecision(decision: StrategyDecision): Promise<void> | void;
}

export type StrategyDispatchStatus =
  | 'WARMING_NO_ACTION'
  | 'READY_NO_ACTION'
  | 'ACTION_BATCH_RETURNED'
  | 'ADAPTER_REJECTED';

export interface StrategyDecisionDispatchRecord {
  readonly decisionId: string;
  readonly strategyInstanceId: string;
  readonly evaluationTimeMs: number;
  readonly dispatchStatus: StrategyDispatchStatus;
  readonly actionBatchSha256: string | null;
}

export interface StrategyDispatchAuditSink {
  writeDispatch(record: StrategyDecisionDispatchRecord): Promise<void> | void;
}
