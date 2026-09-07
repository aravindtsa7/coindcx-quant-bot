import { StrategyCalcDecimal, normalizeCanonicalDecimalString } from '../../strategies/core/decimal';
import type { StrategyDefinition } from '../../strategies/core/types';
import { computeStrategyParameterHash } from '../../strategies/core/identity';
import { StrategyCoinMatrixError } from './errors';
import { matrixDeepCopyFreeze } from './immutable';
import type { StrategyParameterCandidateSpace } from './types';

const DECIMAL = /^-?[0-9]+(?:\.[0-9]+)?$/;

function ascii(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function normalizedValue(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Numeric candidates must be safe integers');
    return value;
  }
  if (typeof value === 'string') return DECIMAL.test(value) ? normalizeCanonicalDecimalString(value) : value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const entries = value.map(normalizedValue);
    if (!entries.every((entry) => typeof entry === 'number')) {
      throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Array candidates must contain safe integers');
    }
    return Object.freeze([...entries].sort((left, right) => (left as number) - (right as number)));
  }
  throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Candidate values must be strings, safe integers, booleans, or safe-integer arrays');
}

function compareArrays(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = (left[index] as number) - (right[index] as number);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') {
    if (DECIMAL.test(left) && DECIMAL.test(right)) return new StrategyCalcDecimal(left).comparedTo(new StrategyCalcDecimal(right));
    return ascii(left, right);
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') return (left ? 1 : 0) - (right ? 1 : 0);
  if (Array.isArray(left) && Array.isArray(right)) return compareArrays(left as readonly number[], right as readonly number[]);
  const rank = (value: unknown): number => typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : typeof value === 'boolean' ? 2 : 3;
  return rank(left) - rank(right);
}

export function normalizeCandidateSpace(space: StrategyParameterCandidateSpace): StrategyParameterCandidateSpace {
  if (space === null || typeof space !== 'object' || typeof space.strategyId !== 'string' || typeof space.strategyVersion !== 'string' ||
      space.strategyId.length === 0 || space.strategyVersion.length === 0 || space.dimensions === null || typeof space.dimensions !== 'object' || Array.isArray(space.dimensions)) {
    throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Candidate space is malformed');
  }
  const dimensions: Record<string, readonly unknown[]> = {};
  const keys = Object.keys(space.dimensions).sort(ascii);
  if (keys.length === 0) throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Candidate space must declare at least one dimension');
  for (const key of keys) {
    const values = space.dimensions[key];
    if (key.length === 0 || !Array.isArray(values) || values.length === 0) {
      throw new StrategyCoinMatrixError('INVALID_PARAMETER_SPACE', 'Dimension must contain at least one candidate value', { details: { key } });
    }
    dimensions[key] = Object.freeze(values.map(normalizedValue).sort(compareValues));
  }
  return matrixDeepCopyFreeze({ strategyId: space.strategyId, strategyVersion: space.strategyVersion, dimensions });
}

export interface NormalizedParameterCandidate {
  readonly normalizedParameters: Readonly<Record<string, unknown>>;
  readonly parameterHash: string;
}

export function expandNormalizedCandidates(
  space: StrategyParameterCandidateSpace,
  definition: StrategyDefinition,
): readonly NormalizedParameterCandidate[] {
  const keys = Object.keys(space.dimensions);
  let rawCandidates: Readonly<Record<string, unknown>>[] = [Object.freeze({})];
  for (const key of keys) {
    const values = space.dimensions[key] as readonly unknown[];
    rawCandidates = rawCandidates.flatMap((candidate) => values.map((value) => Object.freeze({ ...candidate, [key]: value })));
  }
  const seen = new Set<string>();
  const normalized = rawCandidates.map((candidate) => {
    try {
      const normalizedParameters = definition.normalizeParameters(candidate);
      const parameterHash = computeStrategyParameterHash(normalizedParameters);
      if (seen.has(parameterHash)) {
        throw new StrategyCoinMatrixError('DUPLICATE_PARAMETER_CANDIDATE', 'Multiple raw candidates normalize to the same logical parameters', { details: { parameterHash } });
      }
      seen.add(parameterHash);
      return matrixDeepCopyFreeze({ normalizedParameters, parameterHash });
    } catch (error) {
      if (error instanceof StrategyCoinMatrixError) throw error;
      throw new StrategyCoinMatrixError('STRATEGY_PARAM_VALIDATION_FAILED', 'Phase 10 rejected a parameter candidate', { cause: error });
    }
  });
  return Object.freeze(normalized.sort((left, right) => ascii(left.parameterHash, right.parameterHash)));
}
