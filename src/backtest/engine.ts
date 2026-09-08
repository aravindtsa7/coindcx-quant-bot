import type { CanonicalCandle1m } from '../market-data/types';
import { createCanonicalCandle1m } from '../market-data/models';
import { canonicalFixedPointIdentity } from '../market-data/fixed-point-identity';
import type { HigherTimeframeCandle } from '../market-data/higher-timeframe/types';
import { aggregateExactBucket } from '../market-data/higher-timeframe/aggregate-exact-bucket';
import { bucketEndExclusiveMs } from '../market-data/higher-timeframe/timeframe';
import { adaptCanonicalCandle1m, adaptHigherTimeframeCandle } from '../indicators/candle/adapter';
import type { IndicatorPoint } from '../indicators/types';
import { BacktestAccountingLedger } from './accounting';
import { sha256CanonicalJson } from './canonical-json';
import { replayVerifiedDataset, verifyHistoricalDataset } from './dataset';
import {
  BACKTEST_BPS_DIVISOR,
  BacktestCalcDecimal,
  BacktestDecimal,
  requirePositive,
  toBacktestCalcDecimal,
  type BacktestCalc,
} from './decimal';
import { BacktestEventLedger, InMemoryBacktestSink } from './event-ledger';
import { asBacktestError, BacktestError, type BacktestErrorCode } from './errors';
import { ImmutableReadonlyMap, deepFreeze } from './immutable';
import { validateFillNotional, validateOrderIntent, type ValidatedOrderValues } from './instrument';
import { normalizeBacktestInputs, type NormalizedBacktestInputs } from './manifest';
import type {
  BacktestActionBatch,
  BacktestDatasetSource,
  BacktestEngineConfig,
  BacktestEventSink,
  BacktestFidelityDisclosure,
  BacktestIndicatorBinding,
  BacktestOrderIntent,
  BacktestOrderSnapshot,
  BacktestOrderState,
  BacktestRunManifest,
  BacktestRunOutcome,
  BacktestRunResult,
  BacktestRunState,
  BacktestEvaluationContext,
} from './types';

interface ActiveOrder extends ValidatedOrderValues {
  readonly orderId: string;
  readonly orderSequence: number;
  readonly submittedAtMs: number;
  state: Extract<BacktestOrderState, 'PENDING_ACTIVATION' | 'OPEN'>;
}

interface FillCandidate {
  readonly order: ActiveOrder;
  readonly rawReference: BacktestCalc;
  readonly fillPrice: BacktestCalc;
  readonly feeClass: 'MAKER' | 'TAKER';
  readonly slippageRate: BacktestCalc;
}

interface FrozenBinding {
  readonly key: string;
  readonly timeframeMinutes: number;
  readonly kernel: BacktestIndicatorBinding['kernel'];
  originValidated: boolean;
}

const FIDELITY_BASE = Object.freeze({
  marketDataFidelity: 'CANONICAL_1M' as const,
  executionFidelity: 'CONSERVATIVE_1M_OHLCV' as const,
  partialFillModel: 'NOT_MODELED_PHASE9' as const,
  queueModel: 'NOT_MODELED_PHASE9' as const,
  riskEngine: 'NOT_APPLIED_PHASE9' as const,
  leverageModel: 'NOT_MODELED_PHASE9' as const,
  liquidationModel: 'NOT_MODELED_PHASE9' as const,
});

function candlePayload(candle: CanonicalCandle1m | HigherTimeframeCandle): Readonly<Record<string, unknown>> {
  return {
    pair: candle.pair,
    timeframeMinutes: 'timeframeMinutes' in candle ? candle.timeframeMinutes : 1,
    openTimeMs: candle.openTimeMs,
    closeTimeExclusiveMs: candle.closeTimeExclusiveMs,
    open: canonicalFixedPointIdentity(candle.open.value),
    high: canonicalFixedPointIdentity(candle.high.value),
    low: canonicalFixedPointIdentity(candle.low.value),
    close: canonicalFixedPointIdentity(candle.close.value),
    volume: canonicalFixedPointIdentity(candle.volume.value),
    quoteVolume: candle.quoteVolume === null ? null : canonicalFixedPointIdentity(candle.quoteVolume.value),
  };
}

function immutableCandle(candle: CanonicalCandle1m): CanonicalCandle1m {
  return createCanonicalCandle1m({
    pair: candle.pair,
    openTimeMs: candle.openTimeMs,
    open: candle.open.value,
    high: candle.high.value,
    low: candle.low.value,
    close: candle.close.value,
    volume: candle.volume.value,
    quoteVolume: candle.quoteVolume?.value ?? null,
    source: candle.source,
    finalizedAtMs: candle.finalizedAtMs,
    providerEventTimeMs: candle.providerEventTimeMs,
    generationId: candle.generationId,
  });
}

function jsonMaterialize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(jsonMaterialize);
  if (typeof value === 'object') {
    const candidate = value as { toJSON?: () => unknown };
    if (typeof candidate.toJSON === 'function') return jsonMaterialize(candidate.toJSON());
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) output[key] = jsonMaterialize(entry);
    return output;
  }
  throw new BacktestError('BACKTEST_RUN_FAILED', 'Indicator output is not canonically serializable');
}

export class BacktestEngine {
  readonly #inputs: NormalizedBacktestInputs;
  readonly #source: BacktestDatasetSource;
  readonly #sink: BacktestEventSink;
  readonly #participantEvaluation: BacktestEngineConfig['participant']['onEvaluation'];
  readonly #bindings: FrozenBinding[];
  readonly #orders = new Map<string, ActiveOrder>();
  readonly #pendingCancellations = new Set<string>();
  readonly #latestCandleByTimeframe = new Map<number, CanonicalCandle1m | HigherTimeframeCandle>();
  readonly #latestIndicatorByKey = new Map<string, IndicatorPoint<unknown>>();
  readonly #htfBuffers = new Map<number, CanonicalCandle1m[]>();
  readonly #account: BacktestAccountingLedger;
  #state: BacktestRunState = 'CREATED';
  #orderSequence = 0;
  #fillSequence = 0;
  #fundingIndex = 0;
  #hasRun = false;

  public constructor(config: BacktestEngineConfig, sink: BacktestEventSink = new InMemoryBacktestSink()) {
    if (config.datasetSource.immutable !== true) {
      throw new BacktestError('INVALID_BACKTEST_CONFIG', 'Backtest dataset source must guarantee immutability');
    }
    const suppliedSource = config.datasetSource;
    this.#source = Object.freeze({
      sourceIdentity: suppliedSource.sourceIdentity,
      immutable: true as const,
      getRange: suppliedSource.getRange.bind(suppliedSource),
      ...(suppliedSource.assertIdentity === undefined
        ? {}
        : { assertIdentity: suppliedSource.assertIdentity.bind(suppliedSource) }),
    });
    this.#sink = sink;
    this.#participantEvaluation = config.participant.onEvaluation.bind(config.participant);
    this.#inputs = normalizeBacktestInputs({
      datasetManifest: config.datasetManifest,
      bootstrapFromInclusiveMs: config.bootstrapFromInclusiveMs,
      evaluationFromInclusiveMs: config.evaluationFromInclusiveMs,
      evaluationToExclusiveMs: config.evaluationToExclusiveMs,
      replayToExclusiveMs: config.replayToExclusiveMs,
      instrumentSpec: config.instrumentSpec,
      costModel: config.costModel,
      fundingSchedule: config.fundingSchedule,
      participantIdentity: config.participantIdentity,
      initialEquity: config.initialEquity,
      sourceIdentity: this.#source.sourceIdentity,
      ...(config.configuredTimeframes === undefined ? {} : { configuredTimeframes: config.configuredTimeframes }),
      ...(config.intrabarAmbiguityPolicy === undefined ? {} : { intrabarAmbiguityPolicy: config.intrabarAmbiguityPolicy }),
      ...(config.maxOpenOrders === undefined ? {} : { maxOpenOrders: config.maxOpenOrders }),
      ...(config.engineSemanticVersion === undefined ? {} : { engineSemanticVersion: config.engineSemanticVersion }),
      ...(config.verificationPageMinutes === undefined ? {} : { verificationPageMinutes: config.verificationPageMinutes }),
    });
    this.#bindings = this.normalizeBindings(config.indicatorBindings ?? []);
    for (const timeframe of this.#inputs.configuredTimeframes) this.#htfBuffers.set(timeframe, []);
    this.#account = new BacktestAccountingLedger(this.#inputs.manifest.initialEquity, this.#inputs.instrumentSpec);
  }

  public get state(): BacktestRunState { return this.#state; }
  public get runId(): string { return this.#inputs.runId; }
  public get manifest(): BacktestRunManifest { return this.#inputs.manifest; }

  public async run(): Promise<BacktestRunOutcome> {
    if (this.#hasRun) {
      return deepFreeze({
        runId: this.#inputs.runId,
        terminalStatus: 'FAILED',
        isValid: false,
        terminalError: 'BacktestEngine instances are single-use',
        errorCode: 'BACKTEST_RUN_FAILED',
      });
    }
    this.#hasRun = true;
    let ledger: BacktestEventLedger | null = null;
    try {
      this.#state = 'VALIDATING';
      const verified = await verifyHistoricalDataset(this.#inputs, this.#source);
      ledger = new BacktestEventLedger(this.#inputs.runId, this.#sink);
      await ledger.emit(this.#inputs.manifest.bootstrapFromInclusiveMs, 'DATASET_VERIFIED', verified.datasetId, {
        actualCandleCount: verified.actualCandleCount,
        contentSha256: verified.contentSha256,
        datasetId: verified.datasetId,
        firstOpenTimeMs: verified.firstOpenTimeMs,
        lastOpenTimeMs: verified.lastOpenTimeMs,
        sourceIdentity: verified.sourceIdentity,
      });
      this.#state = 'REPLAYING';
      await ledger.emit(this.#inputs.manifest.bootstrapFromInclusiveMs, 'REPLAY_STARTED', this.#inputs.runId, {
        bootstrapFromInclusiveMs: this.#inputs.manifest.bootstrapFromInclusiveMs,
        replayToExclusiveMs: this.#inputs.manifest.replayToExclusiveMs,
      });
      for await (const sourceCandle of replayVerifiedDataset(this.#inputs, this.#source, verified.replayContentSha256)) {
        await this.processBar(immutableCandle(sourceCandle), ledger);
      }
      if (this.#fundingIndex !== this.#inputs.fundingSchedule.events.length) {
        throw new BacktestError('FUNDING_SCHEDULE_INVALID', 'Not every funding event was processed');
      }
      const terminalOpenOrders = Object.freeze([...this.#orders.values()]
        .sort((left, right) => left.orderSequence - right.orderSequence)
        .map((order) => this.orderSnapshot(order)));
      const terminalPositionSnapshot = this.#account.positionSnapshot();
      const terminalPosition = terminalPositionSnapshot.side === 'FLAT' ? null : terminalPositionSnapshot;
      const financialSummary = this.#account.financialSummary();
      const fidelity = this.fidelity();
      await ledger.emit(this.#inputs.manifest.replayToExclusiveMs, 'RUN_COMPLETED', this.#inputs.runId, {
        terminalOpenOrderCount: terminalOpenOrders.length,
        terminalPosition,
        totalClosedTrades: this.#account.totalClosedTrades,
        totalFills: this.#account.totalFills,
      });
      const eventLedgerSha256 = ledger.finalize();
      const hashPayload = deepFreeze({
        runId: this.#inputs.runId,
        terminalStatus: 'COMPLETED' as const,
        isValid: true as const,
        pair: this.#inputs.manifest.pair,
        datasetId: this.#inputs.manifest.datasetId,
        timeRange: {
          bootstrapFromInclusiveMs: this.#inputs.manifest.bootstrapFromInclusiveMs,
          evaluationFromInclusiveMs: this.#inputs.manifest.evaluationFromInclusiveMs,
          evaluationToExclusiveMs: this.#inputs.manifest.evaluationToExclusiveMs,
          replayToExclusiveMs: this.#inputs.manifest.replayToExclusiveMs,
        },
        financialSummary,
        fidelity,
        totalFills: this.#account.totalFills,
        totalClosedTrades: this.#account.totalClosedTrades,
        terminalPosition,
        terminalOpenOrders,
        eventLedgerSha256,
      });
      const result: BacktestRunResult = deepFreeze({ ...hashPayload, resultSha256: sha256CanonicalJson(hashPayload) });
      this.#state = 'COMPLETED';
      return result;
    } catch (error) {
      this.#state = 'FAILED';
      const failure = asBacktestError(error, 'Backtest run failed');
      return deepFreeze({
        runId: this.#inputs.runId,
        terminalStatus: 'FAILED',
        isValid: false,
        terminalError: failure.message,
        errorCode: failure.code,
      });
    }
  }

  private normalizeBindings(bindings: readonly BacktestIndicatorBinding[]): FrozenBinding[] {
    const keys = new Set<string>();
    return bindings.map((binding) => {
      if (!/^[A-Za-z0-9_.:@/-]{1,256}$/.test(binding.key) || keys.has(binding.key)) {
        throw new BacktestError('INVALID_BACKTEST_CONFIG', 'Indicator binding keys must be unique stable identifiers');
      }
      keys.add(binding.key);
      if (binding.timeframeMinutes !== 1 && !this.#inputs.configuredTimeframes.includes(binding.timeframeMinutes)) {
        throw new BacktestError('TIMEFRAME_CONFIGURATION_INVALID', 'Indicator binding timeframe is not configured');
      }
      if (binding.kernel.segment.pair !== this.#inputs.manifest.pair ||
          binding.kernel.segment.timeframeMinutes !== binding.timeframeMinutes || binding.kernel.isTerminated) {
        throw new BacktestError('INDICATOR_FAILURE', 'Indicator binding segment does not match the backtest');
      }
      if (binding.timeframeMinutes === 1 &&
          binding.kernel.segment.bootstrapStartOpenTimeMs !== this.#inputs.manifest.bootstrapFromInclusiveMs) {
        throw new BacktestError('INDICATOR_FAILURE', '1m indicator origin must equal backtest bootstrap origin');
      }
      return { key: binding.key, timeframeMinutes: binding.timeframeMinutes, kernel: binding.kernel, originValidated: binding.timeframeMinutes === 1 };
    });
  }

  private async processBar(candle: CanonicalCandle1m, events: BacktestEventLedger): Promise<void> {
    await this.applyPendingCancellations(candle.openTimeMs, events);
    await this.activateOrders(candle, events);
    await this.processIntrabar(candle, events);
    this.#account.mark(toBacktestCalcDecimal(candle.close.value));
    await events.emit(candle.closeTimeExclusiveMs, 'ACCOUNT_MARKED', this.#inputs.runId, { ...this.#account.equitySnapshot() });
    this.#latestCandleByTimeframe.set(1, candle);
    const closedAtTimestamp: (CanonicalCandle1m | HigherTimeframeCandle)[] = [candle];
    await events.emit(candle.closeTimeExclusiveMs, 'CANDLE_CLOSED', `${this.#inputs.manifest.pair}:1:${candle.openTimeMs}`, candlePayload(candle));
    await this.updateIndicators(candle, 1, events);

    for (const timeframe of this.#inputs.configuredTimeframes) {
      const buffer = this.#htfBuffers.get(timeframe);
      if (!buffer) throw new BacktestError('TIMEFRAME_CONFIGURATION_INVALID', 'Missing timeframe constituent buffer');
      buffer.push(candle);
      if (candle.closeTimeExclusiveMs === bucketEndExclusiveMs(candle.openTimeMs, timeframe)) {
        let derived: HigherTimeframeCandle;
        try { derived = aggregateExactBucket(buffer, timeframe); }
        catch (error) { throw new BacktestError('TIMEFRAME_CONFIGURATION_INVALID', 'Exact higher-timeframe aggregation failed', { cause: error }); }
        buffer.length = 0;
        this.#latestCandleByTimeframe.set(timeframe, derived);
        closedAtTimestamp.push(derived);
        await events.emit(derived.closeTimeExclusiveMs, 'CANDLE_CLOSED', `${derived.pair}:${timeframe}:${derived.openTimeMs}`, candlePayload(derived));
        await this.updateIndicators(derived, timeframe, events);
      } else if (buffer.length >= timeframe) {
        throw new BacktestError('TIMEFRAME_CONFIGURATION_INVALID', 'Higher-timeframe buffer crossed a bucket boundary');
      }
    }

    await this.applyFundingAt(candle.closeTimeExclusiveMs, events);
    if (candle.closeTimeExclusiveMs >= this.#inputs.manifest.evaluationFromInclusiveMs &&
        candle.closeTimeExclusiveMs < this.#inputs.manifest.evaluationToExclusiveMs) {
      await this.evaluate(candle, closedAtTimestamp, events);
    }
  }

  private async applyPendingCancellations(eventTimeMs: number, events: BacktestEventLedger): Promise<void> {
    const ids = [...this.#pendingCancellations].sort((left, right) => {
      const leftOrder = this.#orders.get(left);
      const rightOrder = this.#orders.get(right);
      return (leftOrder?.orderSequence ?? 0) - (rightOrder?.orderSequence ?? 0);
    });
    this.#pendingCancellations.clear();
    for (const id of ids) {
      const order = this.#orders.get(id);
      if (!order) continue;
      await this.cancelOrder(order, eventTimeMs, events, 'PARTICIPANT_REQUEST');
    }
  }

  private async activateOrders(candle: CanonicalCandle1m, events: BacktestEventLedger): Promise<void> {
    const pending = [...this.#orders.values()]
      .filter((order) => order.state === 'PENDING_ACTIVATION')
      .sort((left, right) => left.orderSequence - right.orderSequence);
    const market: ActiveOrder[] = [];
    const open = toBacktestCalcDecimal(candle.open.value);
    for (const order of pending) {
      if (!this.#orders.has(order.orderId)) continue;
      if (order.type === 'POST_ONLY_LIMIT') {
        const limit = toBacktestCalcDecimal(this.requireLimit(order));
        const wouldTake = order.side === 'BUY' ? limit.greaterThanOrEqualTo(open) : limit.lessThanOrEqualTo(open);
        if (wouldTake) {
          await this.rejectActiveOrder(order, candle.openTimeMs, events, 'POST_ONLY_WOULD_TAKE', 'Post-only order is marketable at raw bar open');
          continue;
        }
      }
      order.state = 'OPEN';
      await events.emit(candle.openTimeMs, 'ORDER_ACTIVATED', order.orderId, { ...this.orderSnapshot(order) });
      if (order.type === 'MARKET') market.push(order);
    }
    for (const order of market.sort((left, right) => left.orderSequence - right.orderSequence)) {
      if (!this.#orders.has(order.orderId)) continue;
      const candidate = this.marketCandidate(order, open);
      await this.executeCandidate(candidate, candle.openTimeMs, events);
    }
  }

  private marketCandidate(order: ActiveOrder, rawReference: BacktestCalc): FillCandidate {
    const halfSpreadRate = toBacktestCalcDecimal(this.#inputs.costModel.halfSpreadBps).dividedBy(BACKTEST_BPS_DIVISOR);
    const slippageRate = toBacktestCalcDecimal(this.#inputs.costModel.marketSlippageBps).dividedBy(BACKTEST_BPS_DIVISOR);
    const adjustment = halfSpreadRate.plus(slippageRate);
    const fillPrice = order.side === 'BUY'
      ? rawReference.times(new BacktestCalcDecimal('1').plus(adjustment))
      : rawReference.times(new BacktestCalcDecimal('1').minus(adjustment));
    requirePositive(fillPrice, 'Market execution price');
    return { order, rawReference, fillPrice, feeClass: 'TAKER', slippageRate };
  }

  private intrabarCandidate(order: ActiveOrder, candle: CanonicalCandle1m): FillCandidate | null {
    if (order.state !== 'OPEN') return null;
    if (order.type === 'POST_ONLY_LIMIT') {
      const limit = toBacktestCalcDecimal(this.requireLimit(order));
      const eligible = order.side === 'BUY'
        ? toBacktestCalcDecimal(candle.low.value).lessThan(limit)
        : toBacktestCalcDecimal(candle.high.value).greaterThan(limit);
      return eligible ? { order, rawReference: limit, fillPrice: limit, feeClass: 'MAKER', slippageRate: new BacktestCalcDecimal('0') } : null;
    }
    if (order.type === 'STOP_MARKET') {
      const stop = toBacktestCalcDecimal(this.requireStop(order));
      const open = toBacktestCalcDecimal(candle.open.value);
      const eligible = order.side === 'BUY'
        ? toBacktestCalcDecimal(candle.high.value).greaterThanOrEqualTo(stop)
        : toBacktestCalcDecimal(candle.low.value).lessThanOrEqualTo(stop);
      if (!eligible) return null;
      const gapThrough = order.side === 'BUY' ? open.greaterThan(stop) : open.lessThan(stop);
      const rawReference = gapThrough ? open : stop;
      const halfSpreadRate = toBacktestCalcDecimal(this.#inputs.costModel.halfSpreadBps).dividedBy(BACKTEST_BPS_DIVISOR);
      const slippageRate = toBacktestCalcDecimal(this.#inputs.costModel.stopSlippageBps).dividedBy(BACKTEST_BPS_DIVISOR);
      const adjustment = halfSpreadRate.plus(slippageRate);
      const fillPrice = order.side === 'BUY'
        ? rawReference.times(new BacktestCalcDecimal('1').plus(adjustment))
        : rawReference.times(new BacktestCalcDecimal('1').minus(adjustment));
      requirePositive(fillPrice, 'Stop execution price');
      return { order, rawReference, fillPrice, feeClass: 'TAKER', slippageRate };
    }
    return null;
  }

  private async processIntrabar(candle: CanonicalCandle1m, events: BacktestEventLedger): Promise<void> {
    const all = [...this.#orders.values()]
      .sort((left, right) => left.orderSequence - right.orderSequence)
      .map((order) => this.intrabarCandidate(order, candle))
      .filter((candidate): candidate is FillCandidate => candidate !== null);
    const independent = all.filter((candidate) => candidate.order.ocoGroupId === null);
    const groupIds = [...new Set(all.flatMap((candidate) => candidate.order.ocoGroupId === null ? [] : [candidate.order.ocoGroupId]))].sort();
    const selected: FillCandidate[] = [...independent];
    const positionSide = this.#account.positionSide;
    for (const groupId of groupIds) {
      const candidates = all.filter((candidate) => candidate.order.ocoGroupId === groupId)
        .sort((left, right) => left.order.orderSequence - right.order.orderSequence);
      const adverse = positionSide === 'LONG'
        ? candidates.find((candidate) => candidate.order.type === 'STOP_MARKET' && candidate.order.side === 'SELL')
        : positionSide === 'SHORT'
          ? candidates.find((candidate) => candidate.order.type === 'STOP_MARKET' && candidate.order.side === 'BUY')
          : undefined;
      const chosen = adverse ?? candidates[0];
      if (chosen) selected.push(chosen);
    }
    selected.sort((left, right) => left.order.orderSequence - right.order.orderSequence);
    for (const originalCandidate of selected) {
      const order = this.#orders.get(originalCandidate.order.orderId);
      if (!order || order.state !== 'OPEN') continue;
      const candidate = this.intrabarCandidate(order, candle);
      if (candidate === null) continue;
      const filled = await this.executeCandidate(candidate, candle.closeTimeExclusiveMs, events);
      if (filled && order.ocoGroupId !== null) {
        const siblings = [...this.#orders.values()]
          .filter((candidateOrder) => candidateOrder.ocoGroupId === order.ocoGroupId && candidateOrder.orderId !== order.orderId)
          .sort((left, right) => left.orderSequence - right.orderSequence);
        for (const sibling of siblings) await this.cancelOrder(sibling, candle.closeTimeExclusiveMs, events, 'OCO_SIBLING_FILLED');
      }
    }
  }

  private async executeCandidate(candidate: FillCandidate, eventTimeMs: number, events: BacktestEventLedger): Promise<boolean> {
    const { order } = candidate;
    if (!this.#orders.has(order.orderId) || order.state !== 'OPEN') return false;
    if (order.reduceOnly) {
      const positionSide = this.#account.positionSide;
      const sameSide = (positionSide === 'LONG' && order.side === 'BUY') || (positionSide === 'SHORT' && order.side === 'SELL');
      if (positionSide === 'FLAT' || sameSide || toBacktestCalcDecimal(order.quantity).greaterThan(this.#account.positionQuantityCalc)) {
        await this.rejectActiveOrder(order, eventTimeMs, events, 'ORDER_INVALID', 'Reduce-only order became invalid before fill');
        return false;
      }
    }
    const quantity = toBacktestCalcDecimal(order.quantity);
    try { validateFillNotional(quantity, candidate.fillPrice, this.#inputs.instrumentSpec); }
    catch (error) {
      const rejection = error instanceof BacktestError ? error : asBacktestError(error, 'Fill constraint validation failed');
      await this.rejectActiveOrder(order, eventTimeMs, events, rejection.code, rejection.message);
      return false;
    }
    this.#fillSequence++;
    const fillId = `${this.#inputs.runId}:FILL:${this.#fillSequence}`;
    const feeRate = candidate.feeClass === 'MAKER'
      ? toBacktestCalcDecimal(this.#inputs.costModel.makerFeeRate)
      : toBacktestCalcDecimal(this.#inputs.costModel.takerFeeRate);
    const spreadRate = candidate.feeClass === 'MAKER'
      ? new BacktestCalcDecimal('0')
      : toBacktestCalcDecimal(this.#inputs.costModel.halfSpreadBps).dividedBy(BACKTEST_BPS_DIVISOR);
    const closedTradesBefore = this.#account.totalClosedTrades;
    const fill = this.#account.applyFill({
      fillId,
      orderId: order.orderId,
      orderSequence: order.orderSequence,
      eventTimeMs,
      side: order.side,
      quantity,
      fillPrice: candidate.fillPrice,
      rawReferencePrice: candidate.rawReference,
      feeClass: candidate.feeClass,
      feeRate,
      spreadRate,
      slippageRate: candidate.slippageRate,
    });
    this.#orders.delete(order.orderId);
    await events.emit(eventTimeMs, 'ORDER_FILLED', fill.fillId, { ...fill, orderState: 'FILLED' });
    if (this.#account.totalClosedTrades !== closedTradesBefore) {
      await events.emit(eventTimeMs, 'TRADE_CLOSED', fill.fillId, {
        closingQuantity: fill.closingQuantity,
        exitPrice: fill.fillPrice,
        orderId: fill.orderId,
        realizedGrossPnl: fill.realizedGrossPnl,
        side: fill.side,
      });
    }
    await events.emit(eventTimeMs, 'POSITION_UPDATED', order.orderId, { ...this.#account.positionSnapshot() });
    return true;
  }

  private async updateIndicators(
    candle: CanonicalCandle1m | HigherTimeframeCandle,
    timeframeMinutes: number,
    events: BacktestEventLedger,
  ): Promise<void> {
    const bindings = this.#bindings.filter((binding) => binding.timeframeMinutes === timeframeMinutes);
    for (const binding of bindings) {
      if (!binding.originValidated) {
        if (binding.kernel.segment.bootstrapStartOpenTimeMs !== candle.openTimeMs) {
          throw new BacktestError('INDICATOR_FAILURE', 'HTF indicator origin differs from actual first derived candle origin');
        }
        binding.originValidated = true;
      }
      let point: IndicatorPoint<unknown>;
      try {
        point = binding.kernel.update(timeframeMinutes === 1
          ? adaptCanonicalCandle1m(candle as CanonicalCandle1m)
          : adaptHigherTimeframeCandle(candle as HigherTimeframeCandle));
      } catch (error) {
        throw new BacktestError('INDICATOR_FAILURE', `Indicator binding '${binding.key}' failed`, { cause: error });
      }
      if (point.pair !== candle.pair || point.timeframeMinutes !== timeframeMinutes ||
          point.openTimeMs !== candle.openTimeMs || point.closeTimeExclusiveMs !== candle.closeTimeExclusiveMs) {
        throw new BacktestError('INDICATOR_FAILURE', `Indicator binding '${binding.key}' returned a point outside its input candle`);
      }
      const stablePoint = deepFreeze(point);
      this.#latestIndicatorByKey.set(binding.key, stablePoint);
      await events.emit(candle.closeTimeExclusiveMs, 'INDICATOR_UPDATED', binding.key, {
        key: binding.key,
        pair: point.pair,
        timeframeMinutes: point.timeframeMinutes,
        openTimeMs: point.openTimeMs,
        closeTimeExclusiveMs: point.closeTimeExclusiveMs,
        value: jsonMaterialize(point.value),
      });
    }
  }

  private async applyFundingAt(eventTimeMs: number, events: BacktestEventLedger): Promise<void> {
    const funding = this.#inputs.fundingSchedule.events[this.#fundingIndex];
    if (!funding || funding.fundingTimeMs !== eventTimeMs) return;
    const positionBefore = this.#account.positionSnapshot();
    const applied = this.#account.applyFunding(
      toBacktestCalcDecimal(funding.fundingRate),
      toBacktestCalcDecimal(funding.referencePrice),
    );
    this.#fundingIndex++;
    await events.emit(eventTimeMs, 'FUNDING_APPLIED', `${this.#inputs.fundingSchedule.sourceId}:${eventTimeMs}`, {
      fundingRate: funding.fundingRate,
      referencePrice: funding.referencePrice,
      fundingPnl: new BacktestDecimal(applied),
      positionSide: positionBefore.side,
      positionQuantity: positionBefore.quantity,
      accountEquity: this.#account.equitySnapshot(),
    });
  }

  private async evaluate(
    candle: CanonicalCandle1m,
    candlesClosedAtThisTimestamp: readonly (CanonicalCandle1m | HigherTimeframeCandle)[],
    events: BacktestEventLedger,
  ): Promise<void> {
    const context: BacktestEvaluationContext = deepFreeze({
      simulationTimeMs: candle.closeTimeExclusiveMs,
      latestClosed1mCandle: candle,
      latestClosedCandleByTimeframe: new ImmutableReadonlyMap(this.#latestCandleByTimeframe.entries()),
      candlesClosedAtThisTimestamp: Object.freeze([...candlesClosedAtThisTimestamp]),
      latestIndicatorPointByKey: new ImmutableReadonlyMap(this.#latestIndicatorByKey.entries()),
      currentPosition: this.#account.positionSnapshot(),
      accountEquity: this.#account.equitySnapshot(),
      openOrders: Object.freeze([...this.#orders.values()]
        .sort((left, right) => left.orderSequence - right.orderSequence)
        .map((order) => this.orderSnapshot(order))),
    });
    let actions: BacktestActionBatch;
    try { actions = (await this.#participantEvaluation(context)) ?? {}; }
    catch (error) { throw new BacktestError('BACKTEST_RUN_FAILED', 'Backtest participant evaluation failed', { cause: error }); }
    const cancelOrderIds = [...(actions.cancelOrderIds ?? [])];
    const submitOrders = [...(actions.submitOrders ?? [])];
    for (const id of cancelOrderIds) {
      if (typeof id !== 'string' || id.length === 0) throw new BacktestError('ORDER_INVALID', 'Cancellation ID must be non-empty');
      const order = this.#orders.get(id);
      if (!order || this.#pendingCancellations.has(id)) continue;
      this.#pendingCancellations.add(id);
      await events.emit(candle.closeTimeExclusiveMs, 'ORDER_CANCELLATION_ACCEPTED', id, { orderId: id });
    }
    for (const intent of submitOrders) await this.acceptOrder(intent, candle.closeTimeExclusiveMs, events);
    await events.emit(candle.closeTimeExclusiveMs, 'EVALUATION_COMPLETED', this.#inputs.manifest.participant.participantId, {
      acceptedCancellationCount: cancelOrderIds.filter((id) => this.#pendingCancellations.has(id)).length,
      requestedOrderCount: submitOrders.length,
    });
  }

  private async acceptOrder(intent: BacktestOrderIntent, eventTimeMs: number, events: BacktestEventLedger): Promise<void> {
    this.#orderSequence++;
    if (!Number.isSafeInteger(this.#orderSequence)) throw new BacktestError('BACKTEST_OVERFLOW', 'Order sequence overflow');
    const orderId = `${this.#inputs.runId}:ORDER:${this.#orderSequence}`;
    if (this.#orders.size >= this.#inputs.manifest.maxOpenOrders) {
      await events.emit(eventTimeMs, 'ORDER_REJECTED', orderId, { code: 'ORDER_INVALID', message: 'maxOpenOrders exceeded', orderSequence: this.#orderSequence });
      return;
    }
    try {
      if (!intent) throw new BacktestError('ORDER_INVALID', 'Order intent is missing');
      const validated = validateOrderIntent(intent, this.#inputs.instrumentSpec, {
        side: this.#account.positionSide,
        quantity: this.#account.positionQuantityCalc,
      });
      if (validated.ocoGroupId !== null) {
        const siblings = [...this.#orders.values()].filter((order) => order.ocoGroupId === validated.ocoGroupId);
        if (siblings.length >= 2) throw new BacktestError('ORDER_INVALID', 'An OCO group may contain only two active legs');
      }
      const order: ActiveOrder = { ...validated, orderId, orderSequence: this.#orderSequence, submittedAtMs: eventTimeMs, state: 'PENDING_ACTIVATION' };
      this.#orders.set(orderId, order);
      await events.emit(eventTimeMs, 'ORDER_ACCEPTED', orderId, { ...this.orderSnapshot(order) });
    } catch (error) {
      const rejection = error instanceof BacktestError ? error : asBacktestError(error, 'Order validation failed');
      if (rejection.code === 'BACKTEST_NUMERIC_FAILURE' || rejection.code === 'BACKTEST_OVERFLOW' || rejection.code === 'BACKTEST_RUN_FAILED') {
        throw rejection;
      }
      await events.emit(eventTimeMs, 'ORDER_REJECTED', orderId, {
        code: rejection.code,
        message: rejection.message,
        orderSequence: this.#orderSequence,
      });
    }
  }

  private async rejectActiveOrder(
    order: ActiveOrder,
    eventTimeMs: number,
    events: BacktestEventLedger,
    code: BacktestErrorCode,
    message: string,
  ): Promise<void> {
    this.#orders.delete(order.orderId);
    this.#pendingCancellations.delete(order.orderId);
    await events.emit(eventTimeMs, 'ORDER_REJECTED', order.orderId, {
      ...this.orderSnapshot(order, 'REJECTED', code),
      message,
    });
  }

  private async cancelOrder(order: ActiveOrder, eventTimeMs: number, events: BacktestEventLedger, reason: string): Promise<void> {
    this.#orders.delete(order.orderId);
    this.#pendingCancellations.delete(order.orderId);
    await events.emit(eventTimeMs, 'ORDER_CANCELLED', order.orderId, {
      ...this.orderSnapshot(order, 'CANCELLED'),
      reason,
    });
  }

  private orderSnapshot(order: ActiveOrder, state: BacktestOrderState = order.state, rejectionCode: BacktestErrorCode | null = null): BacktestOrderSnapshot {
    return deepFreeze({
      orderId: order.orderId,
      orderSequence: order.orderSequence,
      pair: order.pair,
      type: order.type,
      side: order.side,
      quantity: order.quantity,
      limitPrice: order.limitPrice,
      stopPrice: order.stopPrice,
      reduceOnly: order.reduceOnly,
      ocoGroupId: order.ocoGroupId,
      state,
      submittedAtMs: order.submittedAtMs,
      rejectionCode,
    });
  }

  private requireLimit(order: { readonly limitPrice: BacktestDecimal | null }): BacktestDecimal {
    if (order.limitPrice === null) throw new BacktestError('ORDER_STATE_INVALID', 'Limit order has no limit price');
    return order.limitPrice;
  }

  private requireStop(order: { readonly stopPrice: BacktestDecimal | null }): BacktestDecimal {
    if (order.stopPrice === null) throw new BacktestError('ORDER_STATE_INVALID', 'Stop order has no stop price');
    return order.stopPrice;
  }

  private fidelity(): BacktestFidelityDisclosure {
    return deepFreeze({ ...FIDELITY_BASE, fundingFidelity: this.#inputs.fundingSchedule.fidelity });
  }
}

export async function runBacktest(config: BacktestEngineConfig, sink?: BacktestEventSink): Promise<BacktestRunOutcome> {
  return new BacktestEngine(config, sink).run();
}
