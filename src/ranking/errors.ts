export type RankingErrorCode =
  /** The caller supplied no candidate subject at all — Phase15 never invents a universe. */
  | 'EMPTY_RANKING_UNIVERSE'
  /** Two candidate subjects resolved to the same canonical candidate identity. */
  | 'DUPLICATE_RANKING_CANDIDATE'
  /** A ranking decimal was absent, non-canonical, or outside the finite decimal contract. */
  | 'RANKING_NUMERIC_FAILURE'
  /** A frozen `P15_RANKING_V1` structural guarantee was violated (weights, directions, tie-break table). */
  | 'RANKING_POLICY_INVALID'
  /** A Phase15 result was asked to declare an economic status the frozen Phase14 limitation forbids. */
  | 'RANKING_ECONOMIC_LIMIT_VIOLATION'
  /** Persisted ranking evidence disagreed with recomputed ranking evidence under the same identity. */
  | 'RANKING_EVIDENCE_CONFLICT'
  /** Caller attempted to persist ranking evidence without genuine Phase15 engine authority. */
  | 'RANKING_EVIDENCE_NOT_AUTHORITATIVE'
  /** Attempted to persist a forged or structurally fabricated ranking run. */
  | 'RANKING_EVIDENCE_FORGERY'
  /** Ranking evidence internal fields or hashes failed cryptographic recomputation or consistency checks. */
  | 'RANKING_EVIDENCE_CORRUPTED'
  /** Ranking engine persistence authority registration was invalid or already bound. */
  | 'RANKING_AUTHORITY_INVALID';

export class RankingError extends Error {
  public readonly code: RankingErrorCode;
  public readonly details?: Readonly<Record<string, string | number | boolean | null>>;

  public constructor(
    code: RankingErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly details?: Readonly<Record<string, string | number | boolean | null>> },
  ) {
    super(`[${code}] ${message}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RankingError';
    this.code = code;
    if (options?.details !== undefined) this.details = Object.freeze({ ...options.details });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
