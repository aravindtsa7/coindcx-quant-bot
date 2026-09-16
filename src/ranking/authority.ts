import type { StrategyRankingRun, StrategyRankingRunSet } from './types';

/**
 * Isolated Phase15 ranking-authority channel.
 *
 * `attestRankingRunSet` and the two `isAuthoritative*` verifiers close over a
 * WeakSet pair created FRESH by this specific call - never a module-level
 * shared WeakSet. There is no canonical/global channel anywhere in this file:
 * every invocation of `createRankingAuthorityChannel` is a brand-new, fully
 * disjoint sandbox, so calling this factory carries no risk no matter who
 * calls it or how many times. Two different calls never share state, and
 * calling it again can never influence, seize, or observe a channel created
 * by an earlier call - including the ranking engine's own channel.
 *
 * This module is deliberately a leaf: it imports nothing but `./types`, so it
 * never transitively reaches the Phase12 evaluation graph, `evidence.ts`,
 * `engine.ts`, or the process-wide Prisma singleton.
 */
export interface RankingAuthorityChannel {
  /**
   * Marks `runSet` and every run inside it as genuine, for THIS channel only.
   * Intended to be called exactly once, by the ranking engine, immediately
   * after it composes a run set - and kept out of every export list from that
   * point on. There is no way to "reacquire" a specific channel's attest
   * function by importing this module again: each import-time call to
   * `createRankingAuthorityChannel` yields an unrelated channel.
   */
  readonly attestRankingRunSet: (runSet: StrategyRankingRunSet) => void;
  readonly isAuthoritativeRankingRun: (run: unknown) => boolean;
  readonly isAuthoritativeRankingRunSet: (runSet: unknown) => boolean;
}

export function createRankingAuthorityChannel(): RankingAuthorityChannel {
  const genuineRuns = new WeakSet<StrategyRankingRun>();
  const genuineRunSets = new WeakSet<StrategyRankingRunSet>();

  function attestRankingRunSet(runSet: StrategyRankingRunSet): void {
    if (typeof runSet !== 'object' || runSet === null || !Object.isFrozen(runSet) || !Array.isArray(runSet.runs)) {
      return;
    }
    genuineRunSets.add(runSet);
    for (const run of runSet.runs) {
      if (typeof run === 'object' && run !== null && Object.isFrozen(run)) {
        genuineRuns.add(run);
      }
    }
  }

  function isAuthoritativeRankingRun(run: unknown): boolean {
    return typeof run === 'object' && run !== null && genuineRuns.has(run as StrategyRankingRun);
  }

  function isAuthoritativeRankingRunSet(runSet: unknown): boolean {
    return typeof runSet === 'object' && runSet !== null && genuineRunSets.has(runSet as StrategyRankingRunSet);
  }

  return Object.freeze({ attestRankingRunSet, isAuthoritativeRankingRun, isAuthoritativeRankingRunSet });
}

// Pin the CommonJS export surface to the lexical factory implementation. This
// module intentionally exports NOTHING else: no canonical channel, no mint
// function bound to shared state, no verifier bound to a specific instance.
// Anyone importing this module - including the ranking engine itself - gets
// only the ability to create their OWN isolated sandbox.
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  if (Object.getOwnPropertyDescriptor(module.exports, 'createRankingAuthorityChannel')?.configurable !== false) {
    Object.defineProperty(module.exports, 'createRankingAuthorityChannel', { get: () => createRankingAuthorityChannel, configurable: false });
  }
  Object.freeze(module.exports);
}
