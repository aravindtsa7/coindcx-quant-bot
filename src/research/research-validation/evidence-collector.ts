import { createHash, type Hash } from 'node:crypto';
import { sha256CanonicalJson, updateCanonicalEventHash } from '../../backtest/canonical-json';
import { BacktestCalcDecimal } from '../../backtest/decimal';
import type { BacktestEvent, BacktestEventSink, BacktestRunResult } from '../../backtest/types';
import { ResearchValidationError } from './errors';
import { freezeValidationRuntime } from './immutable';
import { canonical, calc } from './numeric';
import { DAY_MS, type CanonicalDailyTerminalEquity, type CanonicalValidationEvidence } from './types';

export interface ValidationEvidenceCollectorBinding {
  readonly validationPlanId: string; readonly validationSubjectId: string; readonly validationFoldId: string; readonly scenarioId: string;
  readonly matrixPlanId: string; readonly matrixCellId: string; readonly expectedRunId: string; readonly analysisStartMs: number; readonly analysisEndExclusiveMs: number;
  readonly pair: string; readonly datasetId: string; readonly bootstrapFromInclusiveMs: number;
}
function fail(message: string): never { throw new ResearchValidationError('EVIDENCE_INTEGRITY_FAILURE', message); }
function decimalPayload(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') fail(`Expected canonical decimal payload '${key}'`);
  try { return canonical(calc(value)); } catch { fail(`Malformed canonical decimal payload '${key}'`); }
}
function nestedRecord(payload: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
  const value = payload[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`Expected object payload '${key}'`);
  return value as Readonly<Record<string, unknown>>;
}

export class ValidationEvidenceCollector implements BacktestEventSink {
  readonly #hash: Hash = createHash('sha256');
  readonly #binding: ValidationEvidenceCollectorBinding;
  readonly #dailyEquities = new Map<number, string>();
  readonly #equityPath: { readonly eventTimeMs: number; readonly equity: string }[] = [];
  readonly #closedTradeGrossPnls: string[] = [];
  #priorSequence = 0; #observedEventCount = 0; #runCompletedCount = 0; #terminalSeen = false; #digested = false;
  #currentTimestamp: number | null = null; #currentEquity: string | null = null;
  #terminalCounts: { readonly totalFills: number; readonly totalClosedTrades: number } | null = null;

  public constructor(binding: ValidationEvidenceCollectorBinding) {
    if (!Number.isSafeInteger(binding.analysisStartMs) || !Number.isSafeInteger(binding.analysisEndExclusiveMs) || binding.analysisStartMs % DAY_MS !== 0 ||
        binding.analysisEndExclusiveMs % DAY_MS !== 0 || binding.analysisEndExclusiveMs <= binding.analysisStartMs) fail('Collector analysis window must be safe, day-aligned, and non-empty');
    this.#binding = freezeValidationRuntime({ ...binding });
  }

  public write(event: BacktestEvent): void {
    if (this.#digested) fail('Event received after collector hash finalization');
    if (this.#terminalSeen) fail('Event received after RUN_COMPLETED');
    if (event.runId !== this.#binding.expectedRunId) fail('Event runId differs from expectedRunId');
    if (event.sequence !== this.#priorSequence + 1) fail('Event sequence is not exact and contiguous');
    if (!Number.isSafeInteger(event.eventTimeMs)) fail('Event timestamp is unsafe');
    if (this.#currentTimestamp !== null && event.eventTimeMs < this.#currentTimestamp) fail('Event timestamps are reordered');
    updateCanonicalEventHash(this.#hash, event);
    this.#priorSequence = event.sequence; this.#observedEventCount += 1;
    if (event.type === 'RUN_COMPLETED') {
      const totalFills = event.payload.totalFills; const totalClosedTrades = event.payload.totalClosedTrades;
      if (!Number.isSafeInteger(totalFills) || (totalFills as number) < 0 || !Number.isSafeInteger(totalClosedTrades) || (totalClosedTrades as number) < 0) fail('RUN_COMPLETED contains malformed terminal counts');
      this.#terminalCounts = { totalFills: totalFills as number, totalClosedTrades: totalClosedTrades as number };
      this.#runCompletedCount += 1; this.#flush(); this.#terminalSeen = true; return;
    }
    if (this.#currentTimestamp !== null && event.eventTimeMs > this.#currentTimestamp) this.#flush();
    if (this.#currentTimestamp === null || event.eventTimeMs > this.#currentTimestamp) { this.#currentTimestamp = event.eventTimeMs; this.#currentEquity = null; }
    if (event.type === 'ACCOUNT_MARKED') this.#currentEquity = decimalPayload(event.payload, 'equity');
    if (event.type === 'FUNDING_APPLIED') this.#currentEquity = decimalPayload(nestedRecord(event.payload, 'accountEquity'), 'equity');
    if (event.type === 'TRADE_CLOSED' && event.eventTimeMs > this.#binding.analysisStartMs && event.eventTimeMs <= this.#binding.analysisEndExclusiveMs) {
      this.#closedTradeGrossPnls.push(decimalPayload(event.payload, 'realizedGrossPnl'));
    }
  }

  #flush(): void {
    const timestamp = this.#currentTimestamp; const equity = this.#currentEquity;
    if (timestamp === null || equity === null) return;
    if (timestamp >= this.#binding.analysisStartMs && timestamp <= this.#binding.analysisEndExclusiveMs) {
      this.#equityPath.push({ eventTimeMs: timestamp, equity });
      if (timestamp % DAY_MS === 0) {
        if (this.#dailyEquities.has(timestamp)) fail('Duplicate UTC equity boundary');
        this.#dailyEquities.set(timestamp, equity);
      }
    }
    this.#currentEquity = null;
  }

  public finalize(outcome: BacktestRunResult): CanonicalValidationEvidence {
    if (this.#digested) fail('Validation evidence collector was already finalized');
    if (!this.#terminalSeen || this.#runCompletedCount !== 1) fail('RUN_COMPLETED must be observed exactly once as the final event');
    this.#digested = true;
    const observedEventLedgerSha256 = this.#hash.digest('hex');
    if (outcome.runId !== this.#binding.expectedRunId || outcome.terminalStatus !== 'COMPLETED' || outcome.isValid !== true) fail('Phase 9 outcome lineage is invalid');
    if (outcome.pair !== this.#binding.pair || outcome.datasetId !== this.#binding.datasetId || outcome.timeRange.bootstrapFromInclusiveMs !== this.#binding.bootstrapFromInclusiveMs ||
        outcome.timeRange.evaluationFromInclusiveMs !== this.#binding.analysisStartMs || outcome.timeRange.evaluationToExclusiveMs !== this.#binding.analysisEndExclusiveMs || outcome.timeRange.replayToExclusiveMs !== this.#binding.analysisEndExclusiveMs) fail('Phase 9 outcome does not match matrix-cell execution lineage');
    if (this.#terminalCounts === null || this.#terminalCounts.totalFills !== outcome.totalFills || this.#terminalCounts.totalClosedTrades !== outcome.totalClosedTrades) fail('RUN_COMPLETED terminal counts differ from Phase 9 outcome');
    const { resultSha256, ...hashPayload } = outcome;
    if (sha256CanonicalJson(hashPayload) !== resultSha256) fail('Phase 9 resultSha256 authenticity check failed');
    if (observedEventLedgerSha256 !== outcome.eventLedgerSha256) fail('Observed event ledger hash does not match Phase 9 outcome');
    const dayCount = (this.#binding.analysisEndExclusiveMs - this.#binding.analysisStartMs) / DAY_MS;
    const dailyEquities: CanonicalDailyTerminalEquity[] = [];
    for (let index = 0; index <= dayCount; index++) {
      const boundaryTimeMs = this.#binding.analysisStartMs + index * DAY_MS;
      const equity = this.#dailyEquities.get(boundaryTimeMs);
      if (equity === undefined) fail(`Missing UTC equity boundary at ${boundaryTimeMs}`);
      dailyEquities.push({ boundaryTimeMs, equity });
    }
    const dailyReturnValues: string[] = []; let dailyReturnsUndefined = false;
    for (let index = 1; index < dailyEquities.length; index++) {
      const prior = calc(dailyEquities[index - 1]?.equity ?? '0');
      if (prior.lessThanOrEqualTo(0)) { dailyReturnsUndefined = true; continue; }
      dailyReturnValues.push(canonical(calc(dailyEquities[index]?.equity ?? '0').minus(prior).div(prior)));
    }
    const dailyReturns = dailyReturnsUndefined
      ? freezeValidationRuntime({ status: 'UNDEFINED' as const, reason: 'NON_POSITIVE_PRIOR_EQUITY' as const, value: null })
      : freezeValidationRuntime({ status: 'VALUE' as const, value: Object.freeze(dailyReturnValues) });
    const baselineEquity = dailyEquities[0]?.equity; const terminalAnalysisEquity = dailyEquities[dailyEquities.length - 1]?.equity;
    if (baselineEquity === undefined || terminalAnalysisEquity === undefined) fail('Baseline or terminal equity is missing');
    const baseline = calc(baselineEquity); const terminal = calc(terminalAnalysisEquity);
    const totalNetReturn = baseline.lessThanOrEqualTo(0) ? '0' : canonical(terminal.minus(baseline).div(baseline));
    let peak = baseline; let maxAmount = new BacktestCalcDecimal(0); let maxPercent = new BacktestCalcDecimal(0);
    for (const point of this.#equityPath) {
      const equity = calc(point.equity); if (equity.greaterThan(peak)) peak = equity;
      const amount = peak.minus(equity); if (amount.greaterThan(maxAmount)) maxAmount = amount;
      if (peak.greaterThan(0)) { const percent = amount.div(peak).times(100); if (percent.greaterThan(maxPercent)) maxPercent = percent; }
    }
    const payload = freezeValidationRuntime({ schemaVersion: 1 as const, validationPlanId: this.#binding.validationPlanId, validationSubjectId: this.#binding.validationSubjectId,
      validationFoldId: this.#binding.validationFoldId, scenarioId: this.#binding.scenarioId, matrixPlanId: this.#binding.matrixPlanId, matrixCellId: this.#binding.matrixCellId,
      expectedRunId: this.#binding.expectedRunId, runId: outcome.runId, resultSha256, observedEventLedgerSha256, phase9EventLedgerSha256: outcome.eventLedgerSha256,
      observedEventCount: this.#observedEventCount, baselineEquity, terminalAnalysisEquity, totalNetReturn, maxDrawdownAmount: canonical(maxAmount), maxDrawdownPercent: canonical(maxPercent),
      totalFills: outcome.totalFills, totalClosedTrades: outcome.totalClosedTrades, totalFees: outcome.financialSummary.totalFees.value, fundingPnl: outcome.financialSummary.fundingPnl.value,
      equityPath: Object.freeze([...this.#equityPath]), dailyEquities: Object.freeze(dailyEquities), dailyReturns, closedTradeGrossPnls: Object.freeze([...this.#closedTradeGrossPnls]) });
    return freezeValidationRuntime({ ...payload, validationEvidenceSha256: sha256CanonicalJson(payload) });
  }
}
