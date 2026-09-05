/**
 * SOL-P5-001 / cross-run persistence barrier.
 *
 * PairCanonicalStateMachine owns an intra-run ordered commit queue, but that queue is scoped to ONE
 * state-machine instance. A stop()/start() cycle discards the old instance and installs a brand-new one
 * with a brand-new (empty) queue for the same pair. Without something ABOVE that instance boundary, an
 * old run's still-in-flight physical `repository.insertCandle` call and a new run's own commits for the
 * SAME pair share no ordering authority — they could physically land in the database out of order (e.g.
 * a later minute committing before an earlier one that was merely slow).
 *
 * This coordinator lives at the ENGINE level and is constructed once, never reset across stop()/start()
 * — its entire purpose is to survive state-machine replacement and run boundaries. Every physical
 * canonical write for a pair, regardless of which run's state machine or which origin
 * (LIVE_FINALIZATION or REST_RECOVERY) produced it, must be routed through `enqueueWrite` so they all
 * share one FIFO physical-write ordering per pair. A new run establishing its durable baseline for a
 * pair must await `awaitSettled(pair)` first, so it never reads the baseline while a predecessor run's
 * write for that same pair is still unresolved — and can distinguish "nothing was ever written" from "a
 * predecessor write failed" (the latter must fail closed, never be silently treated as an innocent cold
 * start). Pairs are fully isolated from one another: an outstanding operation for one pair never blocks
 * any other pair.
 */
export type PersistenceBarrierOutcome =
  | { readonly kind: 'SETTLED' }
  | { readonly kind: 'FAILED'; readonly error: unknown };

export class PairPersistenceCoordinator {
  readonly #tails = new Map<string, Promise<PersistenceBarrierOutcome>>();

  /**
   * Serializes one physical write for `pair` behind whatever is currently the tail of that pair's
   * physical-write chain — regardless of which run, state-machine instance, or origin enqueued it —
   * then runs it. The next write enqueued for the same pair will not even be attempted until this one
   * has settled (successfully or not). Resolves/rejects with `run()`'s own outcome.
   */
  public async enqueueWrite<T>(pair: string, run: () => Promise<T>): Promise<T> {
    const previousTail = this.#tails.get(pair) ?? Promise.resolve<PersistenceBarrierOutcome>({ kind: 'SETTLED' });

    let settleTail!: (outcome: PersistenceBarrierOutcome) => void;
    const thisTail = new Promise<PersistenceBarrierOutcome>((resolve) => {
      settleTail = resolve;
    });
    this.#tails.set(pair, thisTail);

    // Wait for the PRIOR physical write for this pair (from any run) to settle before this one is even
    // attempted — this is what gives cross-run physical ordering.
    await previousTail;

    try {
      const result = await run();
      settleTail({ kind: 'SETTLED' });
      return result;
    } catch (err: unknown) {
      settleTail({ kind: 'FAILED', error: err });
      throw err;
    }
  }

  /**
   * Resolves once every physical write enqueued so far for `pair` has settled (successfully or not),
   * reporting whether the LAST such write succeeded or failed. A pair with no tracked writes settles
   * immediately as SETTLED (a genuine cold start, safe to read the baseline right away).
   */
  public awaitSettled(pair: string): Promise<PersistenceBarrierOutcome> {
    return this.#tails.get(pair) ?? Promise.resolve({ kind: 'SETTLED' });
  }
}
