/**
 * Phase 18B Checkpoint B (Stage 1C): ports of the READ-ONLY practical recovery
 * core.
 *
 * Every dependency of the recovery engine is a NARROW, structural port:
 *
 *   - venue access is READ-ONLY. `PracticalVenueReadPort` is exactly the read
 *     half of the Phase 18 `LiveVenueEvidenceProvider`
 *     (`../reconciliation/ports.ts`): orders, positions, and the provider
 *     account identity fingerprint. It cannot express a create, cancel, close,
 *     arm, or any other venue operation. The existing CoinDCX evidence adapter
 *     (`src/integration/coindcx/live/reconciliation-evidence-adapter.ts`)
 *     satisfies it unchanged;
 *   - Phase 18 reconciliation state is READ-ONLY (`loadState` only). The
 *     engine never claims, runs, or completes a Phase 18 generation, and it
 *     never reaches the strict barrier;
 *   - the private stream is observed, never driven. `PracticalPrivateStreamSource`
 *     is the subscribe + health half of the existing CoinDCX private account
 *     stream (`src/integration/coindcx/websocket/private-stream.ts`), which
 *     satisfies it unchanged. Nothing here can start, stop, or send on it;
 *   - durable practical state goes only through the reviewed Stage 1B1
 *     repository, and only through the SUBSET a read-only recovery core needs.
 *     `consumeCertificateAndLease` and `releaseLease` (the Stage 1B2 lease
 *     path) are deliberately absent;
 *   - the private-stream tripwire receives an even narrower port: `invalidate`
 *     only. It can revoke; it cannot certify, finish, or mint anything.
 *
 * This file names no CoinDCX module, no HTTP client, no signer, and no
 * credential, and imports types only.
 */
import type { Clock } from '../../../core/time/clock';
import type { LiveProviderAccountIdentityRead } from '../reconciliation/account-identity';
import type { LiveEvidenceProvenance, LiveVenueOrderEvidence, LiveVenuePositionEvidence } from '../reconciliation/types';
import type { PracticalSafetyRepository } from '../practical-persistence/ports';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Local wall clock. Injected: the recovery core never reads a clock primitive directly. */
export type PracticalRecoveryClock = Clock;

/**
 * Timer port (the `setTimeout`/`clearTimeout` half of the existing stream
 * scheduler). Used for the pauses between passes and for the HARD read
 * timeout (`./timing.ts`).
 */
export interface PracticalRecoveryScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

// ---------------------------------------------------------------------------
// Venue reads (read-only)
// ---------------------------------------------------------------------------

export interface PracticalOrderReadResult {
  readonly orders: readonly LiveVenueOrderEvidence[];
  readonly provenance: LiveEvidenceProvenance;
}

export interface PracticalPositionReadResult {
  readonly positions: readonly LiveVenuePositionEvidence[];
  readonly provenance: LiveEvidenceProvenance;
}

/**
 * READ-ONLY authoritative venue evidence: exactly the read methods of the
 * Phase 18 `LiveVenueEvidenceProvider`. Each read reports its own
 * pagination completeness; the engine accepts only complete reads.
 */
export interface PracticalVenueReadPort {
  readOrders(request: { readonly accountId: string; readonly pairs: readonly string[]; readonly timeoutMs: number }): Promise<PracticalOrderReadResult>;
  readPositions(request: { readonly accountId: string; readonly timeoutMs: number }): Promise<PracticalPositionReadResult>;
  /** Fingerprint only: the raw provider identifier never crosses this port. */
  readAccountIdentity(request: { readonly accountId: string; readonly timeoutMs: number }): Promise<LiveProviderAccountIdentityRead>;
}

// ---------------------------------------------------------------------------
// Phase 18 reconciliation state (read-only)
// ---------------------------------------------------------------------------

/** The fields of the Phase 18 durable reconciliation row the recovery core reads. */
export interface PracticalReconciliationStateView {
  readonly accountId: string;
  readonly status: string;
  readonly currentGeneration: number;
  readonly currentRuntimeEpoch: string | null;
  readonly healthyGeneration: number | null;
}

/**
 * READ-ONLY: the Phase 18 repository's `loadState`. The recovery core never
 * claims a generation; it only binds a certification to one that a Phase 18
 * run of this runtime claimed and completed HEALTHY.
 */
export interface PracticalReconciliationStateReader {
  loadState(accountId: string): Promise<PracticalReconciliationStateView>;
}

// ---------------------------------------------------------------------------
// Private stream (observed only)
// ---------------------------------------------------------------------------

/** The envelope fields the tripwire classifies. Private payload contents are never logged or persisted. */
export interface PracticalPrivateStreamEnvelope {
  readonly stream: string;
  readonly generationId: number;
  readonly eventType: string;
  readonly receivedAtMs: number;
  readonly payload: unknown;
}

export interface PracticalPrivateStreamHealth {
  readonly state: string;
  /** The stream's connection incarnation. Every (re)connect creates a new one. */
  readonly generationId: number;
  readonly connected: boolean;
  /** The authenticated join was SENT. CoinDCX sends no join acknowledgement, so this never proves authentication. */
  readonly authJoinSent: boolean;
  /** Private events the stream refused as malformed (it drops them; the tripwire must not). */
  readonly invalidEventCount: number;
  /**
   * STICKY: set by the stream at the first reconnect and never cleared by the
   * existing CoinDCX adapter. While it is set, private-event continuity of the
   * stream is unresolved, and no watch may bind (`./private-events.ts`).
   */
  readonly reconciliationRequired: boolean;
  /**
   * POSITIVE subscription readiness: a PROVIDER-ORIGINATED confirmation that
   * the authenticated private subscription of THIS incarnation was accepted
   * and is delivering events. Absent (or null) means UNPROVEN.
   *
   * The existing CoinDCX adapter has no such signal (CoinDCX sends no join or
   * subscription acknowledgement) and never sets this field, so it is always
   * UNPROVEN and cannot support a certification. "Join sent" is NOT this.
   * Only a future, reviewed adapter step that observes a genuine provider
   * confirmation may populate it; nothing may synthesize one.
   */
  readonly subscriptionConfirmation?: PracticalPrivateSubscriptionConfirmation | null | undefined;
}

/** A provider-originated positive subscription confirmation, bound to one incarnation and one subscription attempt. */
export interface PracticalPrivateSubscriptionConfirmation {
  readonly source: 'PROVIDER';
  /** The stream incarnation (`generationId`) whose subscription was confirmed. */
  readonly incarnation: number;
  /** When the confirmation was observed; identifies the subscription attempt it confirms. */
  readonly confirmedAtMs: number;
}

/** Observation-only view of the private account stream. */
export interface PracticalPrivateStreamSource {
  subscribe(listener: (envelope: PracticalPrivateStreamEnvelope) => void): () => void;
  getHealthSnapshot(): PracticalPrivateStreamHealth;
}

// ---------------------------------------------------------------------------
// Durable practical state (Stage 1B1), narrowed
// ---------------------------------------------------------------------------

/**
 * The Stage 1B1 operations the read-only recovery core uses. The lease path
 * (`consumeCertificateAndLease`, `releaseLease`) belongs to Stage 1B2 and is
 * not reachable through this type.
 */
export type PracticalRecoveryPersistence = Pick<
  PracticalSafetyRepository,
  | 'loadAccount'
  | 'escalateMalformedAccount'
  | 'initializeAccount'
  | 'adoptForNewRuntime'
  | 'startCertification'
  | 'finishCertification'
  | 'failCertification'
  | 'recordProviderRecovered'
  | 'invalidate'
  | 'expireCertificate'
>;

/** The ONLY durable capability the private-stream tripwire holds: invalidation (revocation). */
export type PracticalRevocationPort = Pick<PracticalSafetyRepository, 'invalidate'>;
