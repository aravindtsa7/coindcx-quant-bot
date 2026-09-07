import type { StrategyDecision, StrategyDecisionDispatchRecord, StrategyDecisionSink, StrategyDispatchAuditSink } from './types';

export class InMemoryStrategyDecisionSink implements StrategyDecisionSink {
  readonly #decisions: StrategyDecision[] = [];
  public writeDecision(decision: StrategyDecision): void { this.#decisions.push(decision); }
  public get decisions(): readonly StrategyDecision[] { return Object.freeze([...this.#decisions]); }
}

export class InMemoryStrategyDispatchAuditSink implements StrategyDispatchAuditSink {
  readonly #records: StrategyDecisionDispatchRecord[] = [];
  public writeDispatch(record: StrategyDecisionDispatchRecord): void { this.#records.push(record); }
  public get records(): readonly StrategyDecisionDispatchRecord[] { return Object.freeze([...this.#records]); }
}
