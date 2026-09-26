/**
 * Phase 18B Checkpoint C: READ-ONLY shadow evidence collection for one
 * evaluation window.
 *
 * It reuses Checkpoint B's EXACT bracket semantics and pure observation
 * functions (`../practical-recovery/observation.ts`): each pass is identity,
 * O1 P1 O2 P2 O3, identity, back to back, stopping at the first failed read
 * or bracket disagreement; passes are paced by the Stage 1A spacing and span
 * ceilings; each read is bounded by the provisional hard read timeout.
 * Unlike certification, a failed pass does not end the window: later passes
 * are still observed, because every sample is calibration data.
 *
 * It does NOT require PROVEN_READY to collect: the real CoinDCX private
 * stream is UNPROVEN, and REST timing/stability is still useful. It records
 * the stream's readiness EXACTLY as the Checkpoint B derivation reports it
 * (never upgraded), private-event COUNTS by classification, Phase 18
 * generation samples, and a read-only summary of the durable practical
 * account.
 *
 * READ-ONLY. Its only venue access is the read-only port; it holds no
 * durable write capability at all (the practical account port is
 * `loadAccount` only), no revocation port, no certificate issuer, and no
 * mutation, lease, dispatch, or arm path. It cannot change practical
 * authority state, and a crash inside it changes nothing durable.
 */
import { bindPracticalPrivateStream, classifyPracticalPrivateEvent, practicalPrivateStreamReadiness, practicalStreamHealthTrip, type PracticalStreamBinding } from '../practical-recovery/private-events';
import {
  PRACTICAL_PASS_READ_PLAN,
  assemblePracticalPass,
  observeIdentityRead,
  observeOrderRead,
  observePositionRead,
  practicalBracketDisagreement,
  type PracticalReadContent,
  type PracticalReadObservation,
} from '../practical-recovery/observation';
import type {
  PracticalPrivateStreamEnvelope,
  PracticalPrivateStreamSource,
  PracticalReconciliationStateReader,
  PracticalRecoveryClock,
  PracticalRecoveryScheduler,
  PracticalVenueReadPort,
} from '../practical-recovery/ports';
import type { PracticalObservationReadKind } from '../practical-recovery/telemetry';
import type { PracticalSafetyRepository } from '../practical-persistence/ports';
import type { PracticalShadowConfig } from './config';
import {
  PRACTICAL_SHADOW_EVIDENCE_SCHEMA_VERSION,
  type PracticalShadowStreamReadiness,
} from './types';
import type {
  PracticalShadowEvidence,
  PracticalShadowPracticalAccountSummary,
  PracticalShadowReadRecord,
  PracticalShadowReadinessSample,
  PracticalShadowReconciliationSample,
} from './evidence';

/** READ-ONLY view of the durable practical account (Stage 1B1 `loadAccount` only). */
export type PracticalShadowPracticalAccountReader = Pick<PracticalSafetyRepository, 'loadAccount'>;

/** Every read-only source a shadow evaluation observes. */
export interface PracticalShadowSources {
  readonly venue: PracticalVenueReadPort;
  readonly privateStream: PracticalPrivateStreamSource;
  readonly reconciliation: PracticalReconciliationStateReader;
  readonly practicalAccount: PracticalShadowPracticalAccountReader;
  readonly clock: PracticalRecoveryClock;
  readonly scheduler: PracticalRecoveryScheduler;
}

export interface PracticalShadowTierBStatus {
  readonly status: 'ELIGIBLE' | 'DISABLED';
  readonly disabledReason: string | null;
  readonly accountAllowlisted: boolean;
}

export interface PracticalShadowCollectionInput {
  readonly sources: PracticalShadowSources;
  readonly config: PracticalShadowConfig;
  readonly accountId: string;
  readonly expectedProviderAccountFingerprint: string;
  readonly runtimeEpoch: string;
  readonly campaignId: string;
  readonly evaluationId: string;
  readonly tierB: PracticalShadowTierBStatus;
  /** The Phase 18 generation first observed with this incarnation (null: this incarnation is new). */
  readonly generationBaselineFor: (incarnation: number | null) => number | null;
}

const READ_TIMED_OUT: unique symbol = Symbol('P18B shadow read timed out');

class ShadowClock {
  #last: number;
  public anomaly = false;

  public constructor(private readonly clock: PracticalRecoveryClock) {
    this.#last = Number.MIN_SAFE_INTEGER;
  }

  /** Monotonic local time; a clock that runs backwards (or is malformed) marks the evaluation anomalous. */
  public tick(): number {
    const now = this.clock.nowMs();
    if (!Number.isSafeInteger(now) || now < this.#last) {
      this.anomaly = true;
      return this.#last === Number.MIN_SAFE_INTEGER ? 0 : this.#last;
    }
    this.#last = now;
    return now;
  }
}

function readinessSample(health: unknown, atMs: number): PracticalShadowReadinessSample {
  const readiness = practicalPrivateStreamReadiness(health);
  const generationId = typeof health === 'object' && health !== null ? (health as Record<string, unknown>)['generationId'] : null;
  return Object.freeze({
    atMs,
    readiness: readiness.kind as PracticalShadowStreamReadiness,
    unprovenReason: readiness.kind === 'UNPROVEN' ? readiness.reason : null,
    incarnation: typeof generationId === 'number' && Number.isSafeInteger(generationId) && generationId >= 1 ? generationId : null,
  });
}

function readHealth(source: PracticalPrivateStreamSource): unknown {
  try {
    return source.getHealthSnapshot();
  } catch {
    return null;
  }
}

async function reconciliationSample(input: PracticalShadowCollectionInput, atMs: number): Promise<PracticalShadowReconciliationSample> {
  try {
    const state = await input.sources.reconciliation.loadState(input.accountId);
    const valid = typeof state === 'object' && state !== null && state.accountId === input.accountId
      && Number.isSafeInteger(state.currentGeneration) && state.currentGeneration >= 0;
    if (!valid) return Object.freeze({ atMs, available: false, status: null, currentGeneration: null, healthyGeneration: null, runtimeEpochMatches: false });
    return Object.freeze({
      atMs,
      available: true,
      status: typeof state.status === 'string' ? state.status : null,
      currentGeneration: state.currentGeneration,
      healthyGeneration: Number.isSafeInteger(state.healthyGeneration) ? state.healthyGeneration : null,
      runtimeEpochMatches: state.currentRuntimeEpoch === input.runtimeEpoch,
    });
  } catch {
    return Object.freeze({ atMs, available: false, status: null, currentGeneration: null, healthyGeneration: null, runtimeEpochMatches: false });
  }
}

async function practicalAccountSummary(input: PracticalShadowCollectionInput): Promise<PracticalShadowPracticalAccountSummary> {
  const unreadable = (problem: string): PracticalShadowPracticalAccountSummary => Object.freeze({
    readable: false, problem, state: null, fenceMode: null, fenceGeneration: null, fenceRuntimeEpochMatches: null, hasCurrentCertificate: null, hasLease: null,
  });
  try {
    const load = await input.sources.practicalAccount.loadAccount(input.accountId);
    if (load.kind === 'NOT_FOUND') return unreadable('NOT_FOUND');
    if (load.kind === 'MALFORMED') return unreadable('MALFORMED');
    if (load.kind !== 'FOUND') return unreadable('UNREADABLE');
    const account = load.account;
    return Object.freeze({
      readable: true,
      problem: null,
      state: account.state,
      fenceMode: account.fence.mode.kind,
      fenceGeneration: account.fence.reconciliationGeneration,
      fenceRuntimeEpochMatches: account.fence.runtimeEpoch === input.runtimeEpoch,
      hasCurrentCertificate: account.currentCertificate !== null,
      hasLease: account.currentLease !== null || account.fence.mode.kind === 'MUTATION_LEASED',
    });
  } catch {
    return unreadable('UNREADABLE');
  }
}

function pause(scheduler: PracticalRecoveryScheduler, delayMs: number): Promise<void> {
  if (!(delayMs > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    scheduler.setTimeout(resolve, delayMs);
  });
}

function withTimeout(scheduler: PracticalRecoveryScheduler, call: () => Promise<unknown>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const handle = scheduler.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(READ_TIMED_OUT);
    }, timeoutMs);
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      scheduler.clearTimeout(handle);
      outcome();
    };
    let pending: Promise<unknown>;
    try {
      pending = call();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    Promise.resolve(pending).then((value) => settle(() => resolve(value)), (error: unknown) => settle(() => reject(error)));
  });
}

/**
 * Collects one shadow evaluation window. Read-only; never throws for a
 * provider, stream, or state failure (each is recorded as evidence).
 */
export async function collectPracticalShadowEvidence(input: PracticalShadowCollectionInput): Promise<PracticalShadowEvidence> {
  const { sources, config } = input;
  const time = new ShadowClock(sources.clock);
  const startedAtMs = time.tick();
  const readinessSamples: PracticalShadowReadinessSample[] = [];
  const reconciliation: PracticalShadowReconciliationSample[] = [];
  const reads: PracticalShadowReadRecord[] = [];
  const byReason: Record<string, number> = {};
  let totalEvents = 0;

  const startHealth = readHealth(sources.privateStream);
  const atStart = readinessSample(startHealth, startedAtMs);
  const bound = bindPracticalPrivateStream(startHealth);
  const binding: PracticalStreamBinding | null = bound.kind === 'BOUND' ? bound.binding : null;
  let streamHealthTrip: string | null = null;
  const sampleStream = (): void => {
    const health = readHealth(sources.privateStream);
    readinessSamples.push(readinessSample(health, time.tick()));
    if (binding !== null && streamHealthTrip === null) {
      try {
        streamHealthTrip = practicalStreamHealthTrip(health, binding);
      } catch {
        streamHealthTrip = 'UNKNOWN_PRIVATE_EVENT';
      }
    }
  };

  // Observation only: events are COUNTED by classification; nothing is revoked or granted.
  let unsubscribe: (() => void) | null = null;
  try {
    unsubscribe = sources.privateStream.subscribe((envelope: PracticalPrivateStreamEnvelope) => {
      let reason = 'UNKNOWN_PRIVATE_EVENT';
      try {
        const classification = classifyPracticalPrivateEvent(envelope, atStart.incarnation ?? 0);
        reason = classification.kind === 'TRIP' ? classification.reason : 'NOISE';
      } catch {
        // counted as unknown
      }
      totalEvents += 1;
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    });
  } catch {
    // An unsubscribable stream is recorded through its readiness samples.
  }

  try {
    reconciliation.push(await reconciliationSample(input, time.tick()));
    const practicalAccount = await practicalAccountSummary(input);
    const timeoutMs = config.timing.hardReadTimeoutMs;
    const steps: Readonly<Record<PracticalObservationReadKind, { readonly call: () => Promise<unknown>; readonly observe: (value: unknown) => PracticalReadContent }>> = {
      IDENTITY: {
        call: () => sources.venue.readAccountIdentity({ accountId: input.accountId, timeoutMs }),
        observe: (value) => observeIdentityRead(value, input.expectedProviderAccountFingerprint),
      },
      ORDERS: { call: () => sources.venue.readOrders({ accountId: input.accountId, pairs: [], timeoutMs }), observe: observeOrderRead },
      POSITIONS: { call: () => sources.venue.readPositions({ accountId: input.accountId, timeoutMs }), observe: observePositionRead },
    };

    let firstPassStartedAtMs: number | null = null;
    let previousPassEndedAtMs: number | null = null;
    for (let passIndex = 1; passIndex <= config.window.minimumPasses; passIndex += 1) {
      if (previousPassEndedAtMs !== null && firstPassStartedAtMs !== null) {
        let target = previousPassEndedAtMs + config.window.minimumPassSpacingMs;
        if (passIndex === config.window.minimumPasses) target = Math.max(target, firstPassStartedAtMs + config.window.minimumCertificationSpanMs);
        await pause(sources.scheduler, target - time.tick());
      }
      const passReads: PracticalReadObservation[] = [];
      for (const planned of PRACTICAL_PASS_READ_PLAN) {
        sampleStream();
        const step = steps[planned.kind];
        const readStartedAtMs = time.tick();
        let content: PracticalReadContent;
        try {
          content = step.observe(await withTimeout(sources.scheduler, step.call, timeoutMs));
        } catch (error) {
          content = Object.freeze({ failure: error === READ_TIMED_OUT ? 'READ_HARD_TIMEOUT' as const : 'PROVIDER_UNAVAILABLE' as const, pagesRead: null, complete: false, contentDigest: null });
        }
        const readEndedAtMs = time.tick();
        const failure = time.anomaly && content.failure === null ? 'CLOCK_ANOMALY' as const : content.failure;
        const observation: PracticalReadObservation = Object.freeze({
          slot: planned.slot,
          kind: planned.kind,
          startedAtMs: readStartedAtMs,
          endedAtMs: readEndedAtMs,
          latencyMs: readEndedAtMs - readStartedAtMs,
          failure,
          pagesRead: content.pagesRead,
          complete: failure === null && content.complete,
          contentDigest: failure === null ? content.contentDigest : null,
        });
        passReads.push(observation);
        reads.push(Object.freeze({ passIndex, ...observation }));
        if (observation.failure !== null || practicalBracketDisagreement(passReads) !== null) break;
      }
      const pass = assemblePracticalPass(passIndex, passReads);
      if (firstPassStartedAtMs === null) firstPassStartedAtMs = pass.startedAtMs;
      previousPassEndedAtMs = pass.endedAtMs;
      reconciliation.push(await reconciliationSample(input, time.tick()));
    }
    sampleStream();
    const endedAtMs = time.tick();
    const atEnd = readinessSample(readHealth(sources.privateStream), endedAtMs);
    const baseline = input.generationBaselineFor(atStart.incarnation);
    return Object.freeze({
      schemaVersion: PRACTICAL_SHADOW_EVIDENCE_SCHEMA_VERSION,
      evaluationId: input.evaluationId,
      campaignId: input.campaignId,
      accountId: input.accountId,
      expectedProviderAccountFingerprint: input.expectedProviderAccountFingerprint,
      runtimeEpoch: input.runtimeEpoch,
      window: config.window,
      timing: config.timing,
      startedAtMs,
      endedAtMs,
      clockAnomaly: time.anomaly,
      reads: Object.freeze(reads),
      readiness: Object.freeze({ atStart, samples: Object.freeze(readinessSamples), atEnd }),
      streamHealthTrip,
      events: Object.freeze({ total: totalEvents, byReason: Object.freeze({ ...byReason }) }),
      reconciliation: Object.freeze(reconciliation),
      generationBaseline: baseline,
      practicalAccount,
      tierB: input.tierB,
    });
  } finally {
    if (unsubscribe !== null) {
      try {
        unsubscribe();
      } catch {
        // Observation only.
      }
    }
  }
}
