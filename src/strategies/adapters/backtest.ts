import type { CanonicalCandle1m } from '../../market-data/types';
import type { HigherTimeframeCandle } from '../../market-data/higher-timeframe/types';
import type {
  BacktestActionBatch,
  BacktestEvaluationContext,
  BacktestIndicatorBinding,
  BacktestOrderIntent,
  BacktestParticipantAdapter,
  BacktestParticipantIdentity,
} from '../../backtest/types';
import { strategySha256CanonicalJson } from '../core/canonical';
import { InMemoryStrategyDispatchAuditSink } from '../core/audit';
import { canonicalStrategyCalc, normalizeCanonicalDecimalString, StrategyCalcDecimal } from '../core/decimal';
import { StrategyError } from '../core/errors';
import { freezeRuntimeObject, StrategyReadonlyMap } from '../core/immutable';
import { createStrategyIndicatorBindings } from '../core/indicator-bindings';
import type {
  StrategyCandleSnapshot,
  StrategyDecision,
  StrategyDecisionDispatchRecord,
  StrategyDecisionSink,
  StrategyDispatchAuditSink,
  StrategyEvaluationSnapshot,
  StrategyIndicatorBinding,
  StrategyKernel,
} from '../core/types';

export interface StrategyBacktestAdapterConfig {
  readonly kernel: StrategyKernel;
  readonly fixedResearchQuantity: string;
  readonly decisionSink: StrategyDecisionSink;
  readonly dispatchSink?: StrategyDispatchAuditSink;
}

function timeframeOf(candle: CanonicalCandle1m | HigherTimeframeCandle): number {
  return 'timeframeMinutes' in candle ? candle.timeframeMinutes : 1;
}

export function toStrategyCandleSnapshot(candle: CanonicalCandle1m | HigherTimeframeCandle): StrategyCandleSnapshot {
  return Object.freeze({
    pair: candle.pair,
    timeframeMinutes: timeframeOf(candle),
    openTimeMs: candle.openTimeMs,
    closeTimeExclusiveMs: candle.closeTimeExclusiveMs,
    open: candle.open.value,
    high: candle.high.value,
    low: candle.low.value,
    close: candle.close.value,
    volume: candle.volume.value,
    quoteVolume: candle.quoteVolume?.value ?? null,
  });
}

export function sanitizeBacktestEvaluationContext(
  context: BacktestEvaluationContext,
  kernel: StrategyKernel,
): StrategyEvaluationSnapshot | null {
  const triggerCandidates = context.candlesClosedAtThisTimestamp.filter((candle) =>
    timeframeOf(candle) === kernel.triggerTimeframeMinutes && candle.closeTimeExclusiveMs === context.simulationTimeMs);
  if (triggerCandidates.length === 0) return null;
  const trigger = triggerCandidates[0];
  if (trigger === undefined) return null;
  const latestCandles = [...context.latestClosedCandleByTimeframe.entries()]
    .map(([timeframe, candle]) => [timeframe, toStrategyCandleSnapshot(candle)] as const);
  const points = kernel.indicatorRequirements.flatMap((requirement) => {
    const point = context.latestIndicatorPointByKey.get(requirement.alias);
    return point === undefined ? [] : [[requirement.alias, freezeRuntimeObject({ ...point })] as const];
  });
  return Object.freeze({
    pair: trigger.pair,
    evaluationTimeMs: context.simulationTimeMs,
    triggerClosedCandle: toStrategyCandleSnapshot(trigger),
    latestClosedCandleByTimeframe: new StrategyReadonlyMap(latestCandles),
    candlesClosedAtThisTimestamp: Object.freeze(context.candlesClosedAtThisTimestamp.map(toStrategyCandleSnapshot)),
    latestIndicatorPointByAlias: new StrategyReadonlyMap(points),
  });
}

export function createStrategyBacktestIndicatorBindings(
  kernel: StrategyKernel,
  bindings: readonly StrategyIndicatorBinding[] = createStrategyIndicatorBindings(kernel),
): readonly BacktestIndicatorBinding[] {
  return Object.freeze(bindings.map((binding) => Object.freeze({
    key: binding.alias,
    timeframeMinutes: binding.requirement.timeframeMinutes,
    kernel: binding.kernel,
  })));
}

export function normalizeFixedResearchQuantity(value: unknown): string {
  const normalized = normalizeCanonicalDecimalString(value, 'fixedResearchQuantity');
  if (!new StrategyCalcDecimal(normalized).gt(0)) {
    throw new StrategyError('INVALID_STRATEGY_PARAMETER', 'fixedResearchQuantity must be greater than zero');
  }
  return normalized;
}

export function buildStrategyBacktestParticipantIdentity(input: {
  readonly kernel: StrategyKernel;
  readonly fixedResearchQuantity: string;
  readonly gitCommitHash: string;
}): BacktestParticipantIdentity {
  const fixedResearchQuantity = normalizeFixedResearchQuantity(input.fixedResearchQuantity);
  if (typeof input.gitCommitHash !== 'string' || input.gitCommitHash.length === 0 || input.gitCommitHash.length > 256) {
    throw new StrategyError('INVALID_STRATEGY_PARAMETER', 'gitCommitHash must be a non-empty string of at most 256 characters');
  }
  return Object.freeze({
    participantId: 'STRATEGY_BACKTEST_ADAPTER',
    participantVersion: '1.0.0',
    parameterHash: strategySha256CanonicalJson({ fixedResearchQuantity, strategyInstanceId: input.kernel.strategyInstanceId }),
    gitCommitHash: input.gitCommitHash,
  });
}

function dispatchRecord(decision: StrategyDecision, status: StrategyDecisionDispatchRecord['dispatchStatus'], actionBatchSha256: string | null): StrategyDecisionDispatchRecord {
  return Object.freeze({
    decisionId: decision.decisionId,
    strategyInstanceId: decision.strategyInstanceId,
    evaluationTimeMs: decision.evaluationTimeMs,
    dispatchStatus: status,
    actionBatchSha256,
  });
}

function immutableBatch(submitOrders: readonly BacktestOrderIntent[]): BacktestActionBatch {
  return Object.freeze({ submitOrders: Object.freeze([...submitOrders]) });
}

export function strategyActionBatchSha256(batch: BacktestActionBatch): string {
  return strategySha256CanonicalJson(batch);
}

export class StrategyBacktestParticipantAdapter implements BacktestParticipantAdapter {
  public readonly kernel: StrategyKernel;
  public readonly fixedResearchQuantity: string;
  public readonly decisionSink: StrategyDecisionSink;
  public readonly dispatchSink: StrategyDispatchAuditSink;

  public constructor(config: StrategyBacktestAdapterConfig) {
    this.kernel = config.kernel;
    this.fixedResearchQuantity = normalizeFixedResearchQuantity(config.fixedResearchQuantity);
    this.decisionSink = config.decisionSink;
    this.dispatchSink = config.dispatchSink ?? new InMemoryStrategyDispatchAuditSink();
  }

  public async onEvaluation(context: BacktestEvaluationContext): Promise<BacktestActionBatch> {
    const snapshot = sanitizeBacktestEvaluationContext(context, this.kernel);
    if (snapshot === null) return immutableBatch([]);
    const decision = this.kernel.evaluate(snapshot);
    await this.decisionSink.writeDecision(decision);

    let batch: BacktestActionBatch;
    let status: StrategyDecisionDispatchRecord['dispatchStatus'];
    try {
      if (context.openOrders.length > 0) {
        throw new StrategyError('STRATEGY_BACKTEST_ADAPTER_BUSY', 'Cannot reconcile strategy target exposure while active open orders exist');
      }
      ({ batch, status } = this.reconcile(decision, context));
    } catch (error) {
      await this.dispatchSink.writeDispatch(dispatchRecord(decision, 'ADAPTER_REJECTED', null));
      throw error;
    }

    const hash = status === 'ACTION_BATCH_RETURNED' ? strategyActionBatchSha256(batch) : null;
    await this.dispatchSink.writeDispatch(dispatchRecord(decision, status, hash));
    return batch;
  }

  private reconcile(decision: StrategyDecision, context: BacktestEvaluationContext): {
    readonly batch: BacktestActionBatch;
    readonly status: StrategyDecisionDispatchRecord['dispatchStatus'];
  } {
    if (decision.status === 'WARMING') return { batch: immutableBatch([]), status: 'WARMING_NO_ACTION' };
    const target = decision.targetExposure;
    const current = context.currentPosition.side;
    if (target === current || (target === 'FLAT' && current === 'FLAT')) {
      return { batch: immutableBatch([]), status: 'READY_NO_ACTION' };
    }
    let side: 'BUY' | 'SELL';
    let quantity: string;
    let reduceOnly: boolean;
    if (target === 'FLAT') {
      side = current === 'LONG' ? 'SELL' : 'BUY';
      quantity = context.currentPosition.quantity.value;
      reduceOnly = true;
    } else {
      side = target === 'LONG' ? 'BUY' : 'SELL';
      quantity = current === 'FLAT'
        ? this.fixedResearchQuantity
        : canonicalStrategyCalc(new StrategyCalcDecimal(context.currentPosition.quantity.value).plus(this.fixedResearchQuantity), 'reversal quantity');
      reduceOnly = false;
    }
    const order = Object.freeze({ pair: decision.pair, type: 'MARKET' as const, side, quantity, reduceOnly });
    return { batch: immutableBatch([order]), status: 'ACTION_BATCH_RETURNED' };
  }
}
