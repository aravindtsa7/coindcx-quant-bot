import { createHash, Hash } from 'node:crypto';
import { canonicalJson, updateCanonicalEventHash } from './canonical-json';
import { BacktestError } from './errors';
import { deepFreeze } from './immutable';
import type { BacktestEvent, BacktestEventSink, BacktestEventType } from './types';

export class InMemoryBacktestSink implements BacktestEventSink {
  readonly #events: BacktestEvent[] = [];
  public write(event: BacktestEvent): void { this.#events.push(event); }
  public get events(): readonly BacktestEvent[] { return Object.freeze([...this.#events]); }
}

export class BacktestEventLedger {
  readonly #hash: Hash = createHash('sha256');
  #sequence = 0;
  #finalized = false;

  public constructor(private readonly runId: string, private readonly sink: BacktestEventSink) {}

  public get sequence(): number { return this.#sequence; }

  public async emit(
    eventTimeMs: number,
    type: BacktestEventType,
    entityId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<BacktestEvent> {
    if (this.#finalized) throw new BacktestError('BACKTEST_RUN_FAILED', 'Cannot emit after event ledger finalization');
    if (!Number.isSafeInteger(eventTimeMs) || !Number.isSafeInteger(this.#sequence + 1)) {
      throw new BacktestError('BACKTEST_RUN_FAILED', 'Unsafe event timestamp or sequence');
    }
    let copiedPayload: Readonly<Record<string, unknown>>;
    try {
      copiedPayload = deepFreeze(JSON.parse(canonicalJson(payload)) as Record<string, unknown>);
    } catch (error) {
      throw new BacktestError('BACKTEST_RUN_FAILED', 'Event payload canonicalization failed', { cause: error });
    }
    const event = deepFreeze<BacktestEvent>({
      sequence: this.#sequence + 1,
      eventTimeMs,
      type,
      runId: this.runId,
      entityId,
      payload: copiedPayload,
    });
    try { await this.sink.write(event); }
    catch (error) { throw new BacktestError('BACKTEST_RUN_FAILED', 'Backtest event sink failed', { cause: error }); }
    updateCanonicalEventHash(this.#hash, event);
    this.#sequence = event.sequence;
    return event;
  }

  public finalize(): string {
    if (this.#finalized) throw new BacktestError('BACKTEST_RUN_FAILED', 'Event ledger was already finalized');
    this.#finalized = true;
    return this.#hash.digest('hex');
  }
}
