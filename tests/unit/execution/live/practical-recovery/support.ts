/**
 * Deterministic fakes for the Phase 18B Checkpoint B recovery core.
 *
 * No network, no CoinDCX, no credentials: the venue is a READ-ONLY fake with
 * complete-pagination provenance, the private stream is a fake health +
 * subscription source, and time is a fake clock driven by a fake scheduler.
 * The in-memory persistence fake applies the real Stage 1A pure functions
 * (fence, state machine, certificate) so unit tests see the same transition
 * rules as the Stage 1B1 repository; the real-MySQL suite uses the real one.
 */
import { FakeClock } from '../../../../../src/core/time/clock';
import { PracticalRecoveryCertificate, revokePracticalRecoveryCertificate } from '../../../../../src/execution/live/practical/certificate';
import {
  adoptPracticalFenceForNewRuntime,
  beginPracticalCertification,
  finishPracticalCertification,
  initialPracticalFence,
  type PracticalAccountFence,
} from '../../../../../src/execution/live/practical/fence';
import { issuePracticalLiveSafetyEnablement } from '../../../../../src/execution/live/practical/policy';
import {
  practicalAccountStateOnStartup,
  practicalStateAfterTransitionFailure,
  transitionPracticalAccountState,
  type PracticalTransitionEvent,
} from '../../../../../src/execution/live/practical/state-machine';
import { PracticalLiveSafetyError, type PracticalAccountStateName, type PracticalInvalidationReason } from '../../../../../src/execution/live/practical/types';
import { PracticalPersistenceError, type PracticalAccountSnapshot, type PracticalDurableCertificateRecord } from '../../../../../src/execution/live/practical-persistence/ports';
import { providerAccountFingerprint, type LiveProviderAccountIdentityRead } from '../../../../../src/execution/live/reconciliation/account-identity';
import type { LiveEvidenceProvenance, LiveVenueOrderEvidence, LiveVenuePositionEvidence } from '../../../../../src/execution/live/reconciliation/types';
import type {
  PracticalOrderReadResult,
  PracticalPositionReadResult,
  PracticalPrivateStreamEnvelope,
  PracticalPrivateStreamHealth,
  PracticalPrivateStreamSource,
  PracticalReconciliationStateReader,
  PracticalReconciliationStateView,
  PracticalRecoveryPersistence,
  PracticalRecoveryScheduler,
  PracticalVenueReadPort,
} from '../../../../../src/execution/live/practical-recovery/ports';

export const FINGERPRINT = providerAccountFingerprint('fake-coindcx-trading-account-p18b-checkpoint-b');
export const OTHER_FINGERPRINT = providerAccountFingerprint('another-subaccount');
export const EPOCH = 'runtime-epoch-a';
export const EPOCH_B = 'runtime-epoch-b';
export const T0 = 1_700_000_000_000;

export function enablementFor(accountId: string, extra: Record<string, string> = {}) {
  const resolution = issuePracticalLiveSafetyEnablement({ LIVE_PRACTICAL_SAFETY_ENABLED: 'true', LIVE_PRACTICAL_SAFETY_ACCOUNT_ALLOWLIST: accountId, ...extra });
  if (resolution.status !== 'ENABLED') throw new Error('fixture enablement');
  return resolution.enablement;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

interface TimerHandle { cleared: boolean }

/**
 * Fires every timer on a later macrotask, advancing the fake clock by the
 * timer's delay first. A read that resolves (microtask) always beats its
 * timeout timer; a read that never resolves times out. `hold()` stops all
 * firing (a "dead process").
 */
export class FakeScheduler implements PracticalRecoveryScheduler {
  #held = false;
  readonly #waiting: (() => void)[] = [];

  public constructor(private readonly clock: FakeClock) {}

  public setTimeout(callback: () => void, delayMs: number): unknown {
    const handle: TimerHandle = { cleared: false };
    const fire = (): void => {
      if (handle.cleared) return;
      if (this.#held) {
        this.#waiting.push(fire);
        return;
      }
      this.clock.advance(delayMs);
      callback();
    };
    setImmediate(fire);
    return handle;
  }

  public clearTimeout(handle: unknown): void {
    (handle as TimerHandle).cleared = true;
  }

  public hold(): void { this.#held = true; }

  public release(): void {
    this.#held = false;
    for (const fire of this.#waiting.splice(0)) setImmediate(fire);
  }
}

// ---------------------------------------------------------------------------
// Venue (read-only)
// ---------------------------------------------------------------------------

export function order(id: string, overrides: Partial<LiveVenueOrderEvidence> = {}): LiveVenueOrderEvidence {
  return {
    exchangeOrderId: id, pair: 'B-BTC_USDT', side: 'BUY', venueStatus: 'open', orderedQuantity: '1', filledQuantity: '0', remainingQuantity: '1',
    cancelledQuantity: '0', averageFillPrice: null, price: '100', wireOrderType: 'limit_order', leverage: '1', providerCreatedAtMs: 1, providerEventTimeMs: 1,
    clientOrderId: null, ...overrides,
  };
}

export function position(id: string, overrides: Partial<LiveVenuePositionEvidence> = {}): LiveVenuePositionEvidence {
  return { venuePositionId: id, pair: 'B-BTC_USDT', signedQuantity: '0', averageEntryPrice: null, leverage: '1', providerEventTimeMs: 1, ...overrides };
}

export type VenueReadKind = 'IDENTITY' | 'ORDERS' | 'POSITIONS';
/** What one venue call does. `undefined` = the default complete, successful read. */
export type VenueBehavior =
  | { readonly kind: 'THROW' }
  | { readonly kind: 'HANG' }
  | { readonly kind: 'VALUE'; readonly value: unknown }
  | undefined;

/**
 * A READ-ONLY fake venue. It has no create/cancel/close method at all. Every
 * call advances the clock by `latencyMs` and returns complete provenance
 * unless a behavior says otherwise.
 */
export class FakeVenue implements PracticalVenueReadPort {
  public identity: LiveProviderAccountIdentityRead = { kind: 'OBSERVED', fingerprint: FINGERPRINT };
  public orders: readonly LiveVenueOrderEvidence[] = [order('ord-1')];
  public positions: readonly LiveVenuePositionEvidence[] = [position('pos-1')];
  public latencyMs = 100;
  public readonly calls: { kind: VenueReadKind; atMs: number }[] = [];
  /** Per-call override: (kind, 0-based index of calls of that kind). */
  public behavior: (kind: VenueReadKind, index: number) => VenueBehavior = () => undefined;
  /** Hook run at the start of each call (e.g. to emit a private event mid-pass). */
  public onCall: (kind: VenueReadKind, index: number) => void = () => undefined;

  public constructor(private readonly clock: FakeClock) {}

  #provenance(source: LiveEvidenceProvenance['source'], startedAtMs: number): LiveEvidenceProvenance {
    return { source, localReadStartedAtMs: startedAtMs, localReadEndedAtMs: this.clock.nowMs(), complete: true, pagesRead: 2, incompleteReason: null };
  }

  async #call<T>(kind: VenueReadKind, produce: (startedAtMs: number) => T): Promise<T> {
    const index = this.calls.filter((call) => call.kind === kind).length;
    this.calls.push({ kind, atMs: this.clock.nowMs() });
    this.onCall(kind, index);
    const behavior = this.behavior(kind, index);
    const startedAtMs = this.clock.nowMs();
    this.clock.advance(this.latencyMs);
    if (behavior?.kind === 'THROW') throw new Error('simulated provider failure');
    if (behavior?.kind === 'HANG') return new Promise<T>(() => undefined);
    if (behavior?.kind === 'VALUE') return behavior.value as T;
    return produce(startedAtMs);
  }

  public readAccountIdentity(): Promise<LiveProviderAccountIdentityRead> {
    return this.#call('IDENTITY', () => this.identity);
  }

  public readOrders(): Promise<PracticalOrderReadResult> {
    return this.#call('ORDERS', (startedAtMs) => ({ orders: this.orders, provenance: this.#provenance('COINDCX_FUTURES_ORDERS', startedAtMs) }));
  }

  public readPositions(): Promise<PracticalPositionReadResult> {
    return this.#call('POSITIONS', (startedAtMs) => ({ positions: this.positions, provenance: this.#provenance('COINDCX_FUTURES_POSITIONS', startedAtMs) }));
  }
}

// ---------------------------------------------------------------------------
// Private stream (observed only)
// ---------------------------------------------------------------------------

/**
 * A DETERMINISTIC TEST STREAM that can explicitly provide PROVEN_READY, which
 * the real CoinDCX adapter cannot (it has no provider subscription
 * confirmation). By default it starts PROVEN_READY: the first clean
 * connection of a stream instance (connected, join sent, AUTH_JOIN_SENT, no
 * reconnect) WITH a provider confirmation for incarnation 1. `unprove()`
 * makes it look exactly like the real adapter (join sent, no confirmation).
 * `reconnect()` behaves like the real adapter: a new incarnation that starts
 * UNPROVEN and stays RECONCILIATION_REQUIRED with the sticky flag set.
 */
export class FakePrivateStream implements PracticalPrivateStreamSource {
  public health: PracticalPrivateStreamHealth = {
    state: 'AUTH_JOIN_SENT', generationId: 1, connected: true, authJoinSent: true, invalidEventCount: 0, reconciliationRequired: false,
    subscriptionConfirmation: { source: 'PROVIDER', incarnation: 1, confirmedAtMs: T0 },
  };

  /** The real adapter's shape: connected, join sent, AUTH_JOIN_SENT, no reconnect, and NO provider confirmation. */
  public unprove(): this {
    this.health = { ...this.health, subscriptionConfirmation: null };
    return this;
  }

  /** A provider confirmation for the CURRENT incarnation (a deterministic test signal only). */
  public confirmSubscription(confirmedAtMs = T0): void {
    this.health = { ...this.health, subscriptionConfirmation: { source: 'PROVIDER', incarnation: this.health.generationId, confirmedAtMs } };
  }
  readonly #listeners = new Set<(envelope: PracticalPrivateStreamEnvelope) => void>();

  public subscribe(listener: (envelope: PracticalPrivateStreamEnvelope) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  public getHealthSnapshot(): PracticalPrivateStreamHealth {
    return { ...this.health };
  }

  public get listenerCount(): number { return this.#listeners.size; }

  public emit(eventType: string, overrides: Partial<PracticalPrivateStreamEnvelope> = {}): void {
    const envelope: PracticalPrivateStreamEnvelope = {
      stream: 'PRIVATE_ACCOUNT', generationId: this.health.generationId, eventType, receivedAtMs: 0, payload: {}, ...overrides,
    };
    for (const listener of [...this.#listeners]) listener(envelope);
  }

  /** A disconnect followed by a reconnect: a NEW incarnation, UNPROVEN and left RECONCILIATION_REQUIRED (sticky), as the real adapter does. */
  public reconnect(): void {
    this.emit('PRIVATE_STREAM_DISCONNECTED', { payload: { reason: 'TRANSPORT_CLOSE' } });
    this.health = {
      ...this.health, generationId: this.health.generationId + 1, state: 'RECONCILIATION_REQUIRED', reconciliationRequired: true, subscriptionConfirmation: null,
    };
    this.emit('PRIVATE_RECONCILIATION_REQUIRED');
    this.emit('PRIVATE_STREAM_CONNECTED');
  }
}

// ---------------------------------------------------------------------------
// Phase 18 reconciliation state (read-only stub)
// ---------------------------------------------------------------------------

export class FakeReconciliation implements PracticalReconciliationStateReader {
  public state: PracticalReconciliationStateView;
  public fail = false;
  /** Runs inside every loadState, before the state is read (to inject changes during that await). */
  public onLoad: () => void = () => undefined;
  /** Rewrites the returned row (e.g. a row of ANOTHER account). */
  public transform: (state: PracticalReconciliationStateView) => PracticalReconciliationStateView = (state) => state;

  public constructor(accountId: string, runtimeEpoch = EPOCH) {
    this.state = { accountId, status: 'HEALTHY', currentGeneration: 0, currentRuntimeEpoch: runtimeEpoch, healthyGeneration: 0 };
  }

  public async loadState(): Promise<PracticalReconciliationStateView> {
    this.onLoad();
    await Promise.resolve();
    if (this.fail) throw new Error('reconciliation state unavailable');
    return this.transform({ ...this.state });
  }

  /** Simulates a Phase 18 run of `runtimeEpoch` claiming the next generation and completing HEALTHY. */
  public completeHealthyRun(runtimeEpoch = this.state.currentRuntimeEpoch ?? EPOCH): number {
    const generation = this.state.currentGeneration + 1;
    this.state = { ...this.state, status: 'HEALTHY', currentGeneration: generation, healthyGeneration: generation, currentRuntimeEpoch: runtimeEpoch };
    return generation;
  }
}

// ---------------------------------------------------------------------------
// In-memory persistence (Stage 1A semantics)
// ---------------------------------------------------------------------------

interface MemoryCertificate { record: PracticalDurableCertificateRecord }

/**
 * The Stage 1B1 subset, in memory, applying the REAL Stage 1A pure functions.
 * Not a substitute for the MySQL suite: it has no locking; it exists so the
 * engine's decisions can be unit tested deterministically.
 */
export class MemoryPracticalPersistence implements PracticalRecoveryPersistence {
  public state: PracticalAccountStateName | null = null;
  public stateRevision = 0;
  public fence: PracticalAccountFence | null = null;
  public certificate: MemoryCertificate | null = null;
  public reviewEpisodeId: string | null = null;
  public malformed = false;
  public readonly operations: string[] = [];
  /** Runs before finishCertification commits (to inject races). */
  public beforeFinish: () => Promise<void> = async () => undefined;
  /** Runs after finishCertification COMMITTED, before it returns. */
  public afterFinish: () => Promise<void> = async () => undefined;
  public failFinish = false;
  /** Every invalidate throws a persistence FAULT (the durable revocation cannot be written). */
  public failInvalidate = false;
  /** Every loadAccount throws (durable state unreadable). */
  public failLoad = false;
  /** Every loadAccount SUCCESSFULLY returns NOT_FOUND (rows unexpectedly absent). */
  public forceNotFound = false;
  #episodes = 0;

  public constructor(private readonly accountId: string) {}

  #snapshot(): PracticalAccountSnapshot {
    const state = this.state!;
    const recovering = state === 'QUARANTINED' || state === 'CERTIFYING' || state === 'PROVIDER_UNAVAILABLE';
    return {
      accountId: this.accountId,
      state,
      stateRevision: this.stateRevision,
      fence: this.fence!,
      currentRecoveryEpisode: recovering ? {
        episodeId: 'recovery-1', accountId: this.accountId, startedAtMs: 0, endedAtMs: null, startCause: 'RUNTIME_STARTUP', status: 'OPEN',
        runtimeEpoch: this.fence!.runtimeEpoch, reconciliationGeneration: 0, certifiedCertificateId: null, reviewEpisodeId: null, openedByResolutionId: null,
      } : null,
      currentReviewEpisode: state === 'MANUAL_REVIEW_REQUIRED' ? {
        reviewEpisodeId: this.reviewEpisodeId!, accountId: this.accountId, kind: 'INVALIDATION', enteredAtMs: 0, reason: 'ORPHAN_ORDER', malformedProblem: null,
        runtimeEpoch: this.fence!.runtimeEpoch, status: 'OPEN', resolvedAtMs: null, resolutionId: null,
      } : null,
      currentCertificate: state === 'CERTIFIED_IDLE' && this.certificate !== null ? this.certificate.record : null,
      currentLease: null,
      leasedCertificate: null,
    };
  }

  #setState(next: PracticalAccountStateName, reason: PracticalInvalidationReason | null): void {
    if (next === 'MANUAL_REVIEW_REQUIRED' && this.state !== 'MANUAL_REVIEW_REQUIRED') {
      this.#episodes += 1;
      this.reviewEpisodeId = `review-${this.#episodes}`;
    }
    if (this.state === 'CERTIFIED_IDLE' && next !== 'CERTIFIED_IDLE' && this.certificate !== null && this.certificate.record.status === 'ISSUED') {
      this.certificate.record = { ...this.certificate.record, status: reason === 'CERTIFICATE_EXPIRED' ? 'EXPIRED' : 'REVOKED', terminalAtMs: 1, terminalReason: reason ?? 'EVIDENCE_STALE' };
    }
    this.state = next;
    this.stateRevision += 1;
  }

  #requireFound(): void {
    if (this.malformed) throw new PracticalLiveSafetyError('PRACTICAL_FENCE_INVALID', 'malformed');
    if (this.state === null) throw new Error('PRACTICAL_PERSISTENCE_NOT_FOUND');
  }

  public async loadAccount() {
    this.operations.push('loadAccount');
    if (this.failLoad) throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_FAULT', 'simulated unreadable durable state');
    if (this.forceNotFound) return { kind: 'NOT_FOUND' as const };
    if (this.malformed) return { kind: 'MALFORMED' as const, problem: 'FENCE_ROW_INVALID' as const, reviewEpisodeId: null };
    if (this.state === null) return { kind: 'NOT_FOUND' as const };
    return { kind: 'FOUND' as const, account: this.#snapshot() };
  }

  public async escalateMalformedAccount() {
    this.operations.push('escalateMalformedAccount');
    return { kind: 'LATCHED' as const, reviewEpisodeId: 'latched-1', problem: 'FENCE_ROW_INVALID' as const };
  }

  public async initializeAccount(input: { readonly runtimeEpoch: string; readonly reconciliationGeneration: number }) {
    this.operations.push('initializeAccount');
    this.state = 'QUARANTINED';
    this.fence = initialPracticalFence({ accountId: this.accountId, runtimeEpoch: input.runtimeEpoch, reconciliationGeneration: input.reconciliationGeneration });
    return { kind: 'CREATED' as const, account: this.#snapshot() };
  }

  public async adoptForNewRuntime(input: { readonly previousRuntimeEpoch: string; readonly expectedFenceRevision: number; readonly newRuntimeEpoch: string }) {
    this.operations.push('adoptForNewRuntime');
    this.#requireFound();
    const fence = adoptPracticalFenceForNewRuntime(this.fence!, { accountId: this.accountId, previousRuntimeEpoch: input.previousRuntimeEpoch, revision: input.expectedFenceRevision }, input.newRuntimeEpoch);
    this.fence = fence;
    this.#setState(practicalAccountStateOnStartup(this.state), 'RUNTIME_EPOCH_CHANGED');
    return this.#snapshot();
  }

  public async startCertification(input: { readonly expected: Parameters<typeof beginPracticalCertification>[1]; readonly runId: string }) {
    this.operations.push('startCertification');
    this.#requireFound();
    const fence = beginPracticalCertification(this.fence!, input.expected, input.runId);
    const next = transitionPracticalAccountState(this.state!, { kind: 'CERTIFICATION_STARTED' });
    this.fence = fence;
    this.#setState(next, null);
    return this.#snapshot();
  }

  public async finishCertification(input: {
    readonly expected: Parameters<typeof finishPracticalCertification>[1];
    readonly runId: string;
    readonly resultingGeneration: number;
    readonly certificate: unknown;
    readonly nowMs: number;
  }) {
    this.operations.push('finishCertification');
    await this.beforeFinish();
    this.#requireFound();
    if (this.failFinish) throw new Error('simulated rollback during certificate persistence');
    const record = PracticalRecoveryCertificate.read(input.certificate);
    if (record === null) throw new Error('not genuine');
    const fence = finishPracticalCertification(this.fence!, input.expected, input.runId, input.resultingGeneration);
    const next = transitionPracticalAccountState(this.state!, { kind: 'CERTIFICATION_SUCCEEDED' });
    if (record.reconciliationGeneration !== fence.reconciliationGeneration || record.runtimeEpoch !== fence.runtimeEpoch) throw new Error('unbound certificate');
    this.fence = fence;
    this.certificate = {
      record: {
        certificateId: record.certificateId, accountId: record.accountId, providerAccountFingerprint: record.providerAccountFingerprint, runtimeEpoch: record.runtimeEpoch,
        reconciliationGeneration: record.reconciliationGeneration, streamIncarnation: record.streamIncarnation, evidenceDigest: record.evidenceDigest,
        issuedAtMs: record.issuedAtMs, expiresAtMs: record.expiresAtMs, status: 'ISSUED', terminalAtMs: null, terminalReason: null,
      },
    };
    this.#setState(next, null);
    await this.afterFinish();
    return this.#snapshot();
  }

  public async failCertification(input: {
    readonly expected: Parameters<typeof finishPracticalCertification>[1];
    readonly runId: string;
    readonly resultingGeneration: number;
    readonly failure: { readonly kind: 'PROVIDER_UNAVAILABLE' } | { readonly kind: 'INVALIDATED'; readonly reason: PracticalInvalidationReason };
  }) {
    this.operations.push(`failCertification:${input.failure.kind === 'INVALIDATED' ? input.failure.reason : 'PROVIDER_UNAVAILABLE'}`);
    this.#requireFound();
    const fence = finishPracticalCertification(this.fence!, input.expected, input.runId, input.resultingGeneration);
    const event: PracticalTransitionEvent = input.failure.kind === 'PROVIDER_UNAVAILABLE' ? { kind: 'PROVIDER_UNAVAILABLE' } : { kind: 'INVALIDATED', reason: input.failure.reason };
    let next: PracticalAccountStateName;
    try {
      next = transitionPracticalAccountState(this.state!, event);
    } catch {
      next = practicalStateAfterTransitionFailure(this.state);
    }
    this.fence = fence;
    this.#setState(next, input.failure.kind === 'INVALIDATED' ? input.failure.reason : null);
    return this.#snapshot();
  }

  public async recordProviderRecovered() {
    this.operations.push('recordProviderRecovered');
    this.#requireFound();
    this.#setState(transitionPracticalAccountState(this.state!, { kind: 'PROVIDER_RECOVERED' }), null);
    return this.#snapshot();
  }

  public async invalidate(input: { readonly reason: PracticalInvalidationReason }) {
    this.operations.push(`invalidate:${input.reason}`);
    if (this.failInvalidate) throw new PracticalPersistenceError('PRACTICAL_PERSISTENCE_FAULT', 'simulated durable revocation failure');
    this.#requireFound();
    this.#setState(transitionPracticalAccountState(this.state!, { kind: 'INVALIDATED', reason: input.reason }), input.reason);
    return { account: this.#snapshot(), reviewEpisodeId: this.state === 'MANUAL_REVIEW_REQUIRED' ? this.reviewEpisodeId : null };
  }

  public async expireCertificate(input: { readonly trustedNowMs: number }) {
    this.operations.push('expireCertificate');
    this.#requireFound();
    const certificate = this.certificate!.record;
    if (input.trustedNowMs < certificate.expiresAtMs) throw new Error('not yet expired');
    this.#setState(transitionPracticalAccountState(this.state!, { kind: 'INVALIDATED', reason: 'CERTIFICATE_EXPIRED' }), 'CERTIFICATE_EXPIRED');
    return { kind: 'TERMINATED' as const, certificate: this.certificate!.record, account: this.#snapshot() };
  }
}

/** Revokes a certificate object, ignoring terminal state (test helper). */
export function revokeQuietly(certificate: unknown): void {
  try {
    revokePracticalRecoveryCertificate(certificate, 'EVIDENCE_STALE', T0);
  } catch {
    // already terminal
  }
}
