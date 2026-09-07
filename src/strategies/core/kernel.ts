import type { IndicatorPoint } from '../../indicators/types';
import { strategySha256CanonicalJson } from './canonical';
import { StrategyError } from './errors';
import { computeStrategyInstanceId, computeStrategyParameterHash, normalizeIndicatorBootstrapIdentity } from './identity';
import { deepCopyFreeze } from './immutable';
import type {
  StrategyDecision,
  StrategyDecisionStatus,
  StrategyEvaluationSnapshot,
  StrategyIndicatorBootstrapIdentityEntry,
  StrategyIndicatorRequirement,
  StrategyKernel,
  StrategyTargetExposure,
} from './types';

const FIXED_DECIMAL = /^-?[0-9]+(?:\.[0-9]+)?$/;
const MINUTE_MS = 60_000;

export interface StrategyOutcome {
  readonly status: StrategyDecisionStatus;
  readonly targetExposure: StrategyTargetExposure | null;
  readonly reasonCodes: readonly string[];
  readonly commit?: () => void;
}

interface BaseStrategyKernelConfig {
  readonly pair: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly normalizedParameters: Readonly<Record<string, unknown>>;
  readonly indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[];
  readonly triggerTimeframeMinutes: number;
  readonly indicatorRequirements: readonly StrategyIndicatorRequirement[];
}

function invalid(message: string, context?: Readonly<Record<string, unknown>>): never {
  throw new StrategyError('STRATEGY_INPUT_INVALID', message, context === undefined ? undefined : { context });
}

function validSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) % MINUTE_MS === 0;
}

function validateCandle(candle: unknown, expectedPair: string, evaluationTimeMs: number): asserts candle is StrategyEvaluationSnapshot['triggerClosedCandle'] {
  if (candle === null || typeof candle !== 'object' || Array.isArray(candle)) invalid('Strategy candle must be an object');
  const value = candle as Record<string, unknown>;
  if (value.pair !== expectedPair) throw new StrategyError('STRATEGY_PAIR_MISMATCH', 'Strategy candle pair mismatch');
  if (!Number.isSafeInteger(value.timeframeMinutes) || (value.timeframeMinutes as number) < 1) invalid('Strategy candle timeframe is invalid');
  if (!validSafeTimestamp(value.openTimeMs) || !validSafeTimestamp(value.closeTimeExclusiveMs)) invalid('Strategy candle timestamps are invalid');
  const duration = (value.timeframeMinutes as number) * MINUTE_MS;
  if (!Number.isSafeInteger(duration) || (value.closeTimeExclusiveMs as number) - (value.openTimeMs as number) !== duration) {
    invalid('Strategy candle duration does not match its timeframe');
  }
  if ((value.closeTimeExclusiveMs as number) > evaluationTimeMs) {
    throw new StrategyError('STRATEGY_INPUT_FUTURE_DATA', 'Strategy candle is from the future');
  }
  for (const key of ['open', 'high', 'low', 'close', 'volume'] as const) {
    if (typeof value[key] !== 'string' || !FIXED_DECIMAL.test(value[key] as string)) invalid(`Strategy candle ${key} is invalid`);
  }
  if (value.quoteVolume !== null && (typeof value.quoteVolume !== 'string' || !FIXED_DECIMAL.test(value.quoteVolume))) {
    invalid('Strategy candle quoteVolume is invalid');
  }
}

function indicatorDecimalValue(point: IndicatorPoint<unknown>, alias: string): string | null {
  if (point.value === null) return null;
  if (typeof point.value !== 'object' || point.value === null || !('value' in point.value)) {
    invalid(`Indicator ${alias} has an invalid scalar value`);
  }
  const value = (point.value as { readonly value?: unknown }).value;
  if (typeof value !== 'string' || !FIXED_DECIMAL.test(value)) invalid(`Indicator ${alias} has an invalid decimal value`);
  return value;
}

export abstract class BaseStrategyKernel implements StrategyKernel {
  public readonly strategyId: string;
  public readonly strategyVersion: string;
  public readonly normalizedParameters: Readonly<Record<string, unknown>>;
  public readonly parameterHash: string;
  public readonly strategyInstanceId: string;
  public readonly pair: string;
  public readonly indicatorBootstrapIdentity: readonly StrategyIndicatorBootstrapIdentityEntry[];
  public readonly triggerTimeframeMinutes: number;
  public readonly indicatorRequirements: readonly StrategyIndicatorRequirement[];
  #terminated = false;
  #nextDecisionSequence = 1;
  #lastEvaluationTimeMs: number | null = null;
  readonly #indicatorReadySeenByAlias = new Set<string>();

  protected constructor(config: BaseStrategyKernelConfig) {
    this.strategyId = config.strategyId;
    this.strategyVersion = config.strategyVersion;
    this.pair = config.pair;
    this.normalizedParameters = deepCopyFreeze(config.normalizedParameters);
    this.parameterHash = computeStrategyParameterHash(this.normalizedParameters);
    this.triggerTimeframeMinutes = config.triggerTimeframeMinutes;
    const aliases = new Set<string>();
    for (const requirement of config.indicatorRequirements) {
      if (!/^[A-Za-z0-9_.:@/-]{1,256}$/.test(requirement.alias) || aliases.has(requirement.alias)) {
        throw new StrategyError('INVALID_STRATEGY_PARAMETER', 'Indicator aliases must be unique stable identifiers');
      }
      aliases.add(requirement.alias);
    }
    this.indicatorRequirements = deepCopyFreeze(config.indicatorRequirements);
    this.indicatorBootstrapIdentity = normalizeIndicatorBootstrapIdentity(
      config.indicatorBootstrapIdentity,
      this.indicatorRequirements,
    );
    this.strategyInstanceId = computeStrategyInstanceId({
      pair: this.pair,
      strategyId: this.strategyId,
      strategyVersion: this.strategyVersion,
      parameterHash: this.parameterHash,
      indicatorBootstrapIdentity: this.indicatorBootstrapIdentity,
    });
    Object.freeze(this.indicatorBootstrapIdentity);
  }

  public get isTerminated(): boolean { return this.#terminated; }

  public evaluate(snapshot: StrategyEvaluationSnapshot): StrategyDecision {
    if (this.#terminated) throw new StrategyError('STRATEGY_TERMINATED', 'Strategy kernel is terminated');
    try {
      const points = this.validateSnapshot(snapshot);
      const outcome = this.evaluateValidated(snapshot, points);
      this.validateOutcome(outcome);
      if (!Number.isSafeInteger(this.#nextDecisionSequence)) {
        throw new StrategyError('STRATEGY_NUMERIC_FAILURE', 'Strategy decision sequence overflow');
      }
      const reasonCodes = Object.freeze([...outcome.reasonCodes]);
      const identity = {
        strategyInstanceId: this.strategyInstanceId,
        decisionSequence: this.#nextDecisionSequence,
        evaluationTimeMs: snapshot.evaluationTimeMs,
        triggerTimeframeMinutes: this.triggerTimeframeMinutes,
        status: outcome.status,
        targetExposure: outcome.targetExposure,
        reasonCodes,
      };
      const decision: StrategyDecision = Object.freeze({
        decisionId: strategySha256CanonicalJson(identity),
        decisionSequence: this.#nextDecisionSequence,
        strategyInstanceId: this.strategyInstanceId,
        strategyId: this.strategyId,
        strategyVersion: this.strategyVersion,
        parameterHash: this.parameterHash,
        pair: this.pair,
        evaluationTimeMs: snapshot.evaluationTimeMs,
        triggerTimeframeMinutes: this.triggerTimeframeMinutes,
        status: outcome.status,
        targetExposure: outcome.targetExposure,
        reasonCodes,
      });

      this.#nextDecisionSequence += 1;
      this.#lastEvaluationTimeMs = snapshot.evaluationTimeMs;
      for (const [alias, point] of points) {
        if (point.value !== null) this.#indicatorReadySeenByAlias.add(alias);
      }
      outcome.commit?.();
      return decision;
    } catch (error) {
      this.#terminated = true;
      if (error instanceof StrategyError) throw error;
      throw new StrategyError('STRATEGY_NUMERIC_FAILURE', 'Strategy evaluation failed', { cause: error });
    }
  }

  protected indicatorValue(points: ReadonlyMap<string, IndicatorPoint<unknown>>, alias: string): string | null {
    const point = points.get(alias);
    if (point === undefined) invalid(`Required indicator alias is missing: ${alias}`);
    return indicatorDecimalValue(point, alias);
  }

  protected abstract evaluateValidated(
    snapshot: StrategyEvaluationSnapshot,
    points: ReadonlyMap<string, IndicatorPoint<unknown>>,
  ): StrategyOutcome;

  private validateSnapshot(snapshot: StrategyEvaluationSnapshot): ReadonlyMap<string, IndicatorPoint<unknown>> {
    if (snapshot === null || typeof snapshot !== 'object') invalid('Strategy snapshot must be an object');
    if (snapshot.pair !== this.pair) throw new StrategyError('STRATEGY_PAIR_MISMATCH', 'Strategy snapshot pair mismatch');
    if (!validSafeTimestamp(snapshot.evaluationTimeMs)) invalid('Strategy evaluationTimeMs is invalid');
    if (this.#lastEvaluationTimeMs !== null && snapshot.evaluationTimeMs <= this.#lastEvaluationTimeMs) {
      throw new StrategyError('STRATEGY_EVALUATION_ORDER_VIOLATION', 'Trigger evaluations must be strictly increasing');
    }
    validateCandle(snapshot.triggerClosedCandle, this.pair, snapshot.evaluationTimeMs);
    if (snapshot.triggerClosedCandle.timeframeMinutes !== this.triggerTimeframeMinutes) {
      throw new StrategyError('STRATEGY_TIMEFRAME_MISMATCH', 'Trigger candle timeframe mismatch');
    }
    if (snapshot.triggerClosedCandle.closeTimeExclusiveMs !== snapshot.evaluationTimeMs) {
      invalid('Trigger candle must close at evaluationTimeMs');
    }
    if (!Array.isArray(snapshot.candlesClosedAtThisTimestamp)) invalid('candlesClosedAtThisTimestamp must be an array');
    const closedByTimeframe = new Map<number, StrategyEvaluationSnapshot['triggerClosedCandle']>();
    for (const candle of snapshot.candlesClosedAtThisTimestamp) {
      validateCandle(candle, this.pair, snapshot.evaluationTimeMs);
      if (candle.closeTimeExclusiveMs !== snapshot.evaluationTimeMs) invalid('Same-timestamp candle has a different close time');
      if (closedByTimeframe.has(candle.timeframeMinutes)) invalid('Duplicate closed candle timeframe at evaluation timestamp');
      closedByTimeframe.set(candle.timeframeMinutes, candle);
    }
    const closedTrigger = closedByTimeframe.get(this.triggerTimeframeMinutes);
    if (closedTrigger === undefined || closedTrigger.openTimeMs !== snapshot.triggerClosedCandle.openTimeMs) {
      invalid('Trigger timeframe did not close at this evaluation timestamp');
    }
    if (snapshot.latestClosedCandleByTimeframe === null || typeof snapshot.latestClosedCandleByTimeframe?.get !== 'function') {
      invalid('latestClosedCandleByTimeframe must be a read-only map');
    }
    for (const [timeframe, candle] of snapshot.latestClosedCandleByTimeframe) {
      if (timeframe !== candle.timeframeMinutes) invalid('Latest candle map key does not match candle timeframe');
      validateCandle(candle, this.pair, snapshot.evaluationTimeMs);
    }
    if (snapshot.latestIndicatorPointByAlias === null || typeof snapshot.latestIndicatorPointByAlias?.get !== 'function') {
      invalid('latestIndicatorPointByAlias must be a read-only map');
    }
    const validated = new Map<string, IndicatorPoint<unknown>>();
    for (const requirement of this.indicatorRequirements) {
      const point = snapshot.latestIndicatorPointByAlias.get(requirement.alias);
      if (point === undefined) invalid(`Required indicator alias is missing: ${requirement.alias}`);
      if (point === null || typeof point !== 'object') invalid(`Indicator ${requirement.alias} is malformed`);
      if (point.pair !== this.pair) throw new StrategyError('STRATEGY_PAIR_MISMATCH', `Indicator ${requirement.alias} pair mismatch`);
      if (point.timeframeMinutes !== requirement.timeframeMinutes) {
        throw new StrategyError('STRATEGY_TIMEFRAME_MISMATCH', `Indicator ${requirement.alias} timeframe mismatch`);
      }
      if (!validSafeTimestamp(point.openTimeMs) || !validSafeTimestamp(point.closeTimeExclusiveMs) ||
          point.openTimeMs >= point.closeTimeExclusiveMs) invalid(`Indicator ${requirement.alias} timestamps are malformed`);
      const expectedDuration = requirement.timeframeMinutes * MINUTE_MS;
      if (!Number.isSafeInteger(expectedDuration) || point.closeTimeExclusiveMs - point.openTimeMs !== expectedDuration) {
        invalid(`Indicator ${requirement.alias} duration is malformed`);
      }
      if (point.closeTimeExclusiveMs > snapshot.evaluationTimeMs) {
        throw new StrategyError('STRATEGY_INPUT_FUTURE_DATA', `Indicator ${requirement.alias} contains future data`);
      }
      const closedCandle = closedByTimeframe.get(requirement.timeframeMinutes);
      if (closedCandle !== undefined) {
        if (point.closeTimeExclusiveMs !== snapshot.evaluationTimeMs || point.openTimeMs !== closedCandle.openTimeMs) {
          invalid(`Indicator ${requirement.alias} is stale at a timeframe close`);
        }
      } else {
        if (requirement.timeframeMinutes === this.triggerTimeframeMinutes || point.closeTimeExclusiveMs >= snapshot.evaluationTimeMs) {
          invalid(`Indicator ${requirement.alias} freshness is invalid`);
        }
        const latestCandle = snapshot.latestClosedCandleByTimeframe.get(requirement.timeframeMinutes);
        if (latestCandle === undefined || latestCandle.openTimeMs !== point.openTimeMs ||
            latestCandle.closeTimeExclusiveMs !== point.closeTimeExclusiveMs) {
          invalid(`Indicator ${requirement.alias} does not match the latest prior closed candle`);
        }
      }
      indicatorDecimalValue(point, requirement.alias);
      if (point.value === null && this.#indicatorReadySeenByAlias.has(requirement.alias)) {
        invalid(`Indicator ${requirement.alias} regressed to null after readiness`);
      }
      validated.set(requirement.alias, point);
    }
    return validated;
  }

  private validateOutcome(outcome: StrategyOutcome): void {
    if (outcome.status === 'WARMING' ? outcome.targetExposure !== null : outcome.targetExposure === null) {
      invalid('Strategy outcome status and target exposure are inconsistent');
    }
    if (!Array.isArray(outcome.reasonCodes) || outcome.reasonCodes.length === 0 ||
        outcome.reasonCodes.some((code) => typeof code !== 'string' || code.length === 0) ||
        new Set(outcome.reasonCodes).size !== outcome.reasonCodes.length) {
      invalid('Strategy reason codes must be non-empty, unique strings');
    }
  }
}
