import { sha256CanonicalJson } from '../../backtest/canonical-json';
import type { MatrixCompletedResultCache, MatrixCellCompletedResult, StrategyCoinMatrixCell, StrategyCoinMatrixCellResult } from './types';

export function validateCachedCompletedResult(
  cell: StrategyCoinMatrixCell,
  cached: unknown,
): cached is MatrixCellCompletedResult {
  if (cached === null || typeof cached !== 'object' || Array.isArray(cached)) return false;
  const candidate = cached as Partial<MatrixCellCompletedResult>;
  const outcome = candidate.outcome;
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome) ||
      candidate.status !== 'COMPLETED' || candidate.failure !== null ||
      candidate.matrixCellId !== cell.matrixCellId || candidate.expectedRunId !== cell.expectedRunId ||
      candidate.runId !== cell.expectedRunId || outcome.runId !== cell.expectedRunId ||
      outcome.terminalStatus !== 'COMPLETED' || outcome.isValid !== true || typeof outcome.resultSha256 !== 'string' ||
      !Object.isFrozen(outcome)) return false;
  const { resultSha256, ...phase9HashPayload } = outcome;
  try { return sha256CanonicalJson(phase9HashPayload) === resultSha256; }
  catch { return false; }
}

export class InMemoryMatrixCompletedResultCache implements MatrixCompletedResultCache {
  readonly #entries = new Map<string, StrategyCoinMatrixCellResult>();
  public constructor(entries: readonly StrategyCoinMatrixCellResult[] = []) {
    for (const entry of entries) this.#entries.set(entry.matrixCellId, entry);
  }
  public get(matrixCellId: string): unknown { return this.#entries.get(matrixCellId) ?? null; }
}
