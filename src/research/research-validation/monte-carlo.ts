import { createHash, createHmac } from 'node:crypto';
import { canonicalJson } from '../../backtest/canonical-json';
import { BacktestCalcDecimal } from '../../backtest/decimal';
import { ResearchValidationError } from './errors';
import { freezeValidationRuntime } from './immutable';
import { calc, canonical, finite } from './numeric';
import type { ValidationMonteCarloConfig, ValidationMonteCarloResult } from './types';

export function deriveMonteCarloSeed(validationPlanId: string, validationSubjectId: string): Buffer {
  return createHmac('sha256', Buffer.from(validationPlanId, 'utf8')).update(Buffer.from(canonicalJson({ validationSubjectId, validationFoldId: 'AGGREGATE_OOS', scenarioId: 'BASELINE', policyId: 'P12_MONTE_CARLO_PERMUTATION_V1' }), 'utf8')).digest();
}
export function monteCarloCounterBlock(seed: Buffer, counter: number): Buffer {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new ResearchValidationError('MONTE_CARLO_FAILURE', 'PRNG counter is invalid');
  const encoded = Buffer.alloc(8); encoded.writeBigUInt64BE(BigInt(counter));
  return createHash('sha256').update(seed).update(encoded).digest();
}
export class DeterministicCounterPrng {
  #counter = 0; #words: number[] = [];
  public constructor(private readonly seed: Buffer) { if (seed.length !== 32) throw new ResearchValidationError('MONTE_CARLO_FAILURE', 'PRNG seed must contain 32 bytes'); }
  public nextUint32(): number {
    if (this.#words.length === 0) { const block = monteCarloCounterBlock(this.seed, this.#counter++); for (let offset = 0; offset < 32; offset += 4) this.#words.push(block.readUInt32BE(offset)); }
    const word = this.#words.shift(); if (word === undefined) throw new ResearchValidationError('MONTE_CARLO_FAILURE', 'PRNG word stream is empty'); return word;
  }
  public nextIndex(range: number): number {
    return unbiasedIndex(range, () => this.nextUint32());
  }
}
export function unbiasedIndex(range: number, nextWord: () => number): number {
  if (!Number.isSafeInteger(range) || range < 1 || range > 0x1_0000_0000) throw new ResearchValidationError('MONTE_CARLO_FAILURE', 'PRNG range is invalid');
  const limit = Math.floor(0x1_0000_0000 / range) * range; let word: number;
  do { word = nextWord(); if (!Number.isSafeInteger(word) || word < 0 || word > 0xffff_ffff) throw new ResearchValidationError('MONTE_CARLO_FAILURE', 'PRNG word is invalid'); } while (word >= limit);
  return word % range;
}
export function deterministicPermutation<T>(values: readonly T[], prng: DeterministicCounterPrng): readonly T[] {
  const result = [...values]; for (let index = result.length - 1; index >= 1; index--) { const target = prng.nextIndex(index + 1); [result[index], result[target]] = [result[target] as T, result[index] as T]; }
  return Object.freeze(result);
}
export function runMonteCarlo(validationPlanId: string, validationSubjectId: string, returns: readonly string[], config: ValidationMonteCarloConfig): ValidationMonteCarloResult {
  returns.forEach(calc);
  if (config.policyId !== 'P12_MONTE_CARLO_PERMUTATION_V1' || config.seedDerivationPolicy !== 'HMAC_SHA256_V1' ||
      !Number.isSafeInteger(config.simulationCount) || config.simulationCount < 1 || !Number.isSafeInteger(config.adversePercentile) || config.adversePercentile < 1 || config.adversePercentile > 99) {
    throw new ResearchValidationError('MONTE_CARLO_FAILURE', 'Monte Carlo configuration is invalid');
  }
  const seed = deriveMonteCarloSeed(validationPlanId, validationSubjectId); const seedHex = seed.toString('hex'); const prng = new DeterministicCounterPrng(seed); const drawdowns: string[] = [];
  if (returns.length === 0) return freezeValidationRuntime({ status: 'INSUFFICIENT_DATA', adversePercentile: config.adversePercentile, simulationCount: config.simulationCount, seedHex, adverseDrawdownPercent: null, reason: 'NO_OOS_DAILY_RETURNS' });
  try {
    for (let simulation = 0; simulation < config.simulationCount; simulation++) {
      const permutation = deterministicPermutation(returns, prng); let equity = new BacktestCalcDecimal(1); let peak = equity; let maximum = new BacktestCalcDecimal(0);
      for (const item of permutation) { const multiplier = calc(item).plus(1); if (multiplier.lessThanOrEqualTo(0)) return freezeValidationRuntime({ status: 'UNDEFINED', adversePercentile: config.adversePercentile, simulationCount: config.simulationCount, seedHex, adverseDrawdownPercent: null, reason: 'NON_POSITIVE_SIMULATED_EQUITY' }); equity = finite(equity.times(multiplier)); if (equity.greaterThan(peak)) peak = equity; const drawdown = finite(peak.minus(equity).div(peak).times(100)); if (drawdown.greaterThan(maximum)) maximum = drawdown; }
      drawdowns.push(canonical(maximum));
    }
    drawdowns.sort((left, right) => calc(left).comparedTo(calc(right)));
    const nearestRank = Math.floor((config.adversePercentile * config.simulationCount + 99) / 100); const selected = drawdowns[nearestRank - 1];
    if (selected === undefined) throw new ResearchValidationError('MONTE_CARLO_FAILURE', 'Configured percentile could not be selected');
    return freezeValidationRuntime({ status: 'VALUE', adversePercentile: config.adversePercentile, simulationCount: config.simulationCount, seedHex, adverseDrawdownPercent: selected });
  } catch (error) { if (error instanceof ResearchValidationError) throw error; throw new ResearchValidationError('MONTE_CARLO_FAILURE', 'Monte Carlo permutation failed', { cause: error }); }
}
