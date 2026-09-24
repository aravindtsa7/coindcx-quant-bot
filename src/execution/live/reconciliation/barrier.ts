/**
 * The startup reconciliation barrier (§3, §18).
 *
 * This is the gate every normal Phase17 live mutation (OPEN, ordinary CANCEL,
 * CLOSE) passes before it may touch CoinDCX. Reconciliation-owned orphan
 * cancellation is a separate path that does not pass this gate and never
 * grants normal mutation authority: it runs inside a reconciliation run and
 * is bounded by its own orphan-cleanup policy (explicit enablement, account
 * allowlist, 1..20 per-run ceiling), generation fencing, durable
 * claim -> arm -> wire ordering, and sticky ambiguity (§13). It
 * is an ADDITIONAL gate: it never replaces, weakens, or short-circuits the
 * Phase17 enablement, research, kernel, risk-admission, or position-ownership
 * checks — an authority still has to be minted exactly as before, and this
 * refusal happens before that mint is even attempted.
 *
 * WHY A RUNTIME EPOCH, AND WHY IT IS NOT "JUST AN IN-MEMORY BOOLEAN":
 *
 * The authority is the durable `live_reconciliation_state` row. The epoch is
 * only the BINDING between that row and the process that proved it. A restart
 * gets a new epoch, so a row left HEALTHY by a previous process no longer
 * satisfies the barrier and the account is effectively RECONCILIATION_REQUIRED
 * again — without rewriting history, and without the barrier ever being
 * satisfiable by process-local state alone. Deleting the process's memory
 * cannot turn the gate ON; only a committed run of THIS runtime can.
 *
 * An account with no durable row at all reads as RECONCILIATION_REQUIRED, so a
 * database that has never seen the account fails closed rather than defaulting
 * open.
 */
import { randomUUID } from 'node:crypto';
import { LiveExecutionError } from '../errors';
import type { LiveReconciliationRepository, LiveReconciliationStateRecord } from './ports';

/**
 * Mints the identity of one process's live-execution runtime.
 *
 * Deliberately lives here, in execution, rather than in the CoinDCX
 * composition root: the Phase17 architecture test pins an exact list of files
 * under `src/integration/coindcx/` that may use a crypto primitive, and a
 * runtime-epoch generator is not a CoinDCX hashing or signing concern.
 */
const RUNTIME_IDENTITY_ISSUER = Object.freeze({ purpose: 'live-runtime-identity' });

interface LiveRuntimeIdentityRecord {
  readonly epoch: string;
}

/**
 * Uncloneable identity for one composed live runtime.
 *
 * The constructor is intentionally hostile to direct/prototype/Reflect use:
 * only this module owns the issuer object.  The epoch is held in an ECMAScript
 * private slot and there is no public accessor, serializer, or valueOf hook.
 */
export class LiveRuntimeIdentity {
  readonly #record: LiveRuntimeIdentityRecord;

  public constructor(issuer: unknown, epoch: unknown) {
    if (issuer !== RUNTIME_IDENTITY_ISSUER || typeof epoch !== 'string' || epoch.length === 0) {
      throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'A live runtime identity may only be minted by the production runtime factory');
    }
    this.#record = Object.freeze({ epoch });
    Object.freeze(this);
  }

  public static read(value: unknown): LiveRuntimeIdentityRecord | null {
    if (!(value instanceof LiveRuntimeIdentity)) return null;
    try {
      return value.#record;
    } catch {
      return null;
    }
  }
}

/** Mints a fresh, caller-non-selectable runtime identity. */
export function newLiveRuntimeIdentity(): LiveRuntimeIdentity {
  return new LiveRuntimeIdentity(RUNTIME_IDENTITY_ISSUER, randomUUID());
}

/** Internal adapter reader. It returns null for clones and structural fakes. */
export function readLiveRuntimeEpoch(identity: unknown): string | null {
  return LiveRuntimeIdentity.read(identity)?.epoch ?? null;
}

/**
 * [P18 Wave B4 / F18-27] The evidence-capability level a reconciliation
 * result was actually established against.
 *
 *   - `REST_CURRENT_STATE_OBSERVED` ("Level 2"): repeated authoritative REST
 *     reads agree at the points they were sampled. This is everything
 *     `LiveVenueEvidenceProvider` can ever produce (`../reconciliation/ports.ts`),
 *     and everything CoinDCX's verified contract supports (§6.2-6.4 of
 *     `docs/PHASE18_RECONCILIATION.md`): no snapshot revision, no monotonic
 *     account event sequence, no authoritative replay of the interval between
 *     reads. It proves the account was quiet AT the sampled instants; it
 *     cannot prove nothing happened BETWEEN them, or after the last one. A
 *     `HEALTHY` status built on nothing but this level is real, useful
 *     information — "no known problem, as of the last sample" — and it is
 *     exactly what `completeRun` still reports (unchanged by this finding).
 *   - `ACCOUNT_CONTINUITY_PROVEN` ("Level 3"): an authoritative, gap-detecting
 *     mechanism (a provider snapshot revision, a monotonic event sequence, or
 *     an authoritative replay) proved no venue-side order or position
 *     mutation happened in the interval this reconciliation run relied on —
 *     including in the window between the FINAL orders read and the moment
 *     the result is used to authorize a mutation. Nothing in this codebase
 *     can currently produce this: there is no CoinDCX-documented sequence,
 *     cursor, or revision number anywhere in the verified read-layer contract
 *     (`docs/COINDCX_READ_LAYER.md`), and the one private account WebSocket
 *     client that exists (`src/integration/coindcx/websocket/private-stream.ts`)
 *     is explicitly documented as a non-authoritative change notification
 *     that itself triggers a REST reconciliation on every reconnect — it is
 *     not wired into any live execution or reconciliation path, and even if
 *     it were, its own contract does not claim gap-free delivery.
 *
 * Only Level 3 may authorize a normal Phase17 live mutation: see
 * `requireCurrentReconciliation`, which is the sole place this value is
 * consulted for that purpose. Level 2 remains a real, reportable account
 * status. Reconciliation-owned orphan cancellation does not consult this value
 * and proves nothing about continuity.
 */
export type LiveAccountContinuityCapability = 'REST_CURRENT_STATE_OBSERVED' | 'ACCOUNT_CONTINUITY_PROVEN';

/**
 * [P18 Wave B4 / F18-27] The ONLY place this value is decided. It takes no
 * argument and reads no request-scoped or caller-supplied data: whether an
 * account-continuity-proving mechanism exists is a fact about THIS RUNTIME's
 * wiring, not about any particular reconciliation run, account, or evidence
 * set — so there is nothing here for a caller to spoof, and nothing that
 * could vary from one call to the next without a code change.
 *
 * It returns `'REST_CURRENT_STATE_OBSERVED'` because that is presently true:
 * no continuity-proving provider adapter exists anywhere in this repository
 * (verified by inventory: no sequence/cursor/revision field in the CoinDCX
 * integration, no wired private-stream consumer outside test files). This is
 * NOT a permanently-hardcoded refusal dressed up as a "genuine evaluation" —
 * it is the honest, currently-correct answer, structured so that the day a
 * real continuity-proving adapter is built and wired in, this function (and
 * only this function) changes to derive its answer from that adapter's own
 * proof instead of a literal. Until that day, no code path anywhere may mint
 * `'ACCOUNT_CONTINUITY_PROVEN'` any other way (§F18-27 "do not create a fake
 * continuityVerified: true").
 */
export function currentAccountContinuityCapability(): LiveAccountContinuityCapability {
  return 'REST_CURRENT_STATE_OBSERVED';
}

/** What a caller is asking permission to do. */
export type LiveMutationKind = 'CREATE' | 'CANCEL' | 'CLOSE';

export type LiveReconciliationBarrierResolution =
  | { readonly kind: 'PERMITTED'; readonly state: LiveReconciliationStateRecord }
  | {
      readonly kind: 'BLOCKED';
      readonly state: LiveReconciliationStateRecord;
      readonly reason: LiveReconciliationBlockReason;
    };

export type LiveReconciliationBlockReason =
  /** No run of this runtime has completed for the account. */
  | 'NO_CURRENT_RECONCILIATION'
  /** A run of this runtime completed, but a previous process owns the result. */
  | 'STALE_RUNTIME_GENERATION'
  /** Reconciliation is in flight; no normal Phase17 mutation may proceed while it is. */
  | 'RECONCILIATION_IN_PROGRESS'
  /** The account reconciled and found blocking faults. */
  | 'RECONCILIATION_UNHEALTHY'
  /** The account reconciled and found something only a human can resolve. */
  | 'MANUAL_REVIEW_REQUIRED'
  /**
   * [P18 Wave B4 / F18-27] The account reconciled HEALTHY at
   * `REST_CURRENT_STATE_OBSERVED` (repeated REST reads agree at the points
   * they were sampled), but no authoritative account-continuity mechanism
   * proved nothing changed between the final read and this authorization
   * attempt — including a brand-new venue order this system has never seen,
   * which no amount of additional REST reads can rule out (§F18-27: "do not
   * patch with one more REST read" — the race simply moves to after
   * whichever read is last). This is not a defect this reconciliation run
   * could have avoided; it is a structural property of polling a venue with
   * no continuity mechanism, and it blocks EVERY REST-only result, including
   * a genuinely clean account, because the two are evidentially
   * indistinguishable from inside a single run.
   */
  | 'ACCOUNT_CONTINUITY_NOT_PROVEN';

/**
 * Evaluates the barrier for one account against one runtime epoch.
 *
 * Pure, so the decision table is directly unit-testable with no database.
 *
 * Deliberately carries NO knowledge of `LiveAccountContinuityCapability`
 * (F18-27): this function's job is the REPOSITORY-level question "is this
 * durable row, at this epoch, internally consistent enough to have produced a
 * genuine HEALTHY authorization" — the exact same question
 * `authorizeCurrentHealthy` (`repository.ts`) reuses this function to answer
 * when deciding whether to MINT an authorization object at all. F18-27 is a
 * different, higher-level policy question — "should reconciliation ever be
 * allowed to RELEASE that authorization for an actual live mutation" — and it
 * is answered exactly once, at the one production choke point every normal
 * Phase17 live mutation actually passes through: `requireCurrentReconciliation`,
 * below.
 * Folding it in here too would make `authorizeCurrentHealthy` itself
 * permanently unable to mint ANY authorization, which would be wrong: that
 * object is also used, by its 'RUNNING' mode (via `claimGeneration`), for
 * fencing writes reconciliation performs on ITSELF mid-run — a concern F18-27
 * has nothing to do with — and Wave A/A2/A3's own crash-recovery and
 * generation-fencing proofs need a genuine 'HEALTHY'-mode object to exercise
 * their (F18-27-orthogonal) properties against.
 */
export function evaluateReconciliationBarrier(
  state: LiveReconciliationStateRecord,
  runtimeEpoch: string,
): LiveReconciliationBarrierResolution {
  const blocked = (reason: LiveReconciliationBlockReason): LiveReconciliationBarrierResolution =>
    Object.freeze({ kind: 'BLOCKED' as const, state, reason });

  if (state.status === 'RUNNING') return blocked('RECONCILIATION_IN_PROGRESS');
  if (state.status === 'MANUAL_REVIEW_REQUIRED') return blocked('MANUAL_REVIEW_REQUIRED');
  if (state.status === 'UNHEALTHY') return blocked('RECONCILIATION_UNHEALTHY');
  if (state.status !== 'HEALTHY') return blocked('NO_CURRENT_RECONCILIATION');

  // HEALTHY, but by whom and when?
  if (state.currentRuntimeEpoch === null || state.currentRuntimeEpoch !== runtimeEpoch) {
    // A healthy verdict from a previous process never authorizes a new one.
    return blocked('STALE_RUNTIME_GENERATION');
  }
  if (state.healthyGeneration === null || state.healthyGeneration !== state.currentGeneration) {
    // A newer generation was claimed after the healthy one completed, so the
    // healthy verdict has been fenced out.
    return blocked('STALE_RUNTIME_GENERATION');
  }
  if (state.blockingFindingCount > 0) {
    // Defensive: a HEALTHY status with blocking findings is contradictory, so
    // the conservative reading wins.
    return blocked('RECONCILIATION_UNHEALTHY');
  }
  return Object.freeze({ kind: 'PERMITTED' as const, state });
}

/**
 * The durable barrier check used by the production live path.
 *
 * Throws `LIVE_RECONCILIATION_REQUIRED` (or the manual-review code) rather than
 * returning a boolean, so a caller cannot accidentally proceed by ignoring a
 * falsy result.
 *
 * [P18 Wave B4 / F18-27, closed for forgery Wave B5 / F18-28] This is the ONE
 * place the account-continuity gate is enforced, deliberately downstream of
 * every fencing/state check above passing and a genuine authorization already
 * having been minted — see `evaluateReconciliationBarrier`'s doc for why the
 * gate lives HERE and not there.
 *
 * There is DELIBERATELY no parameter through which a caller can supply or
 * influence the continuity capability. Wave B4 first shipped one
 * (`continuityCapability: LiveAccountContinuityCapability = currentAccountContinuityCapability()`)
 * and independent review correctly flagged it as forgeable (F18-28): any
 * caller — test or, had it ever been wired up, production — could pass the
 * literal `'ACCOUNT_CONTINUITY_PROVEN'` positionally and mint a real
 * authorization with zero actual continuity proof behind it. The fix is not a
 * stronger unforgeable token type; it is removing the input entirely. No
 * production call site (`production-runtime.ts`, the only caller) ever passed
 * anything beyond the first four arguments, so nothing is lost by making that
 * permanent: this function now calls `currentAccountContinuityCapability()`
 * itself, exactly once, reading no caller-supplied value of any kind. The day
 * a genuine continuity-proving adapter exists, `currentAccountContinuityCapability`
 * (and only that function) changes to derive its answer from that adapter —
 * this call site does not change at all.
 */
export async function requireCurrentReconciliation(
  repository: LiveReconciliationRepository,
  accountId: string,
  runtimeIdentity: LiveRuntimeIdentity,
  mutation: LiveMutationKind,
): Promise<unknown> {
  const outcome = await repository.authorizeCurrentHealthy(accountId, runtimeIdentity);
  const resolution = evaluateReconciliationBarrier(outcome.state, readLiveRuntimeEpoch(runtimeIdentity) ?? '');
  if (resolution.kind === 'PERMITTED' && outcome.authorization !== null) {
    if (currentAccountContinuityCapability() === 'ACCOUNT_CONTINUITY_PROVEN') return outcome.authorization;
    // [P18 Wave B4 / F18-27] Every fencing/state precondition passed and a
    // genuine authorization was minted — this is refused ONLY because REST-only
    // evidence can never prove no venue-side mutation happened between the
    // final read and this very call, including a brand-new order this system
    // has never seen (§F18-27: "do not patch with one more REST read" — the
    // race simply moves to after whichever read is last). This blocks EVERY
    // REST-only result, including a genuinely clean account, because the two
    // are evidentially indistinguishable from inside a single reconciliation
    // run.
    throw new LiveExecutionError('LIVE_RECONCILIATION_REQUIRED', 'Live mutation is blocked pending an authoritative account-continuity proof; repeated REST reads alone can never establish one (§F18-27)', {
      details: {
        accountId,
        mutation,
        reason: 'ACCOUNT_CONTINUITY_NOT_PROVEN',
        status: outcome.state.status,
        currentGeneration: outcome.state.currentGeneration,
        blockingFindingCount: outcome.state.blockingFindingCount,
      },
    });
  }

  const reason = resolution.kind === 'BLOCKED' ? resolution.reason : 'NO_CURRENT_RECONCILIATION';
  const code = reason === 'MANUAL_REVIEW_REQUIRED'
    ? 'LIVE_RECONCILIATION_MANUAL_REVIEW_REQUIRED' as const
    : 'LIVE_RECONCILIATION_REQUIRED' as const;
  throw new LiveExecutionError(code, 'Live mutation is blocked until startup reconciliation proves this account safe', {
    details: {
      accountId,
      mutation,
      reason,
      status: outcome.state.status,
      currentGeneration: outcome.state.currentGeneration,
      blockingFindingCount: outcome.state.blockingFindingCount,
    },
  });
}

/** The status an account with no durable row reads as. Fail-closed by construction. */
export function initialReconciliationState(accountId: string): LiveReconciliationStateRecord {
  return Object.freeze({
    accountId,
    status: 'RECONCILIATION_REQUIRED' as const,
    currentGeneration: 0,
    currentRunId: null,
    currentRuntimeEpoch: null,
    healthyGeneration: null,
    lastEvaluatedAtMs: null,
    blockingFindingCount: 0,
    revision: 0,
  });
}

Object.freeze(LiveRuntimeIdentity.prototype);
Object.freeze(LiveRuntimeIdentity);

// The production composition imports these bindings from CommonJS output.
// Make that namespace non-replaceable so a caller cannot preload this module,
// retain an old genuine identity, and monkey-patch the factory to replay it in
// a later production runtime.
if (typeof module !== 'undefined' && typeof exports !== 'undefined') {
  for (const [name, value] of Object.entries({
    LiveRuntimeIdentity,
    newLiveRuntimeIdentity,
    readLiveRuntimeEpoch,
    currentAccountContinuityCapability,
    evaluateReconciliationBarrier,
    requireCurrentReconciliation,
    initialReconciliationState,
  })) {
    if (Object.getOwnPropertyDescriptor(module.exports, name)?.configurable !== false) {
      Object.defineProperty(module.exports, name, { get: () => value, configurable: false });
    }
  }
  Object.freeze(module.exports);
}
