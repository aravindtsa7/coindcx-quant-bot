/**
 * Phase 18B Checkpoint B: timing and evidence telemetry for Stage 2 shadow
 * calibration.
 *
 * Every event is SAFE by construction: numbers, fixed codes, and short digest
 * prefixes only. No provider payload, raw account identifier, order record,
 * credential, or signature can be expressed by these types.
 *
 * Two different timing signals are reported, and never confused:
 *   - `...CandidateExceeded`: a measured duration above a SHADOW-CALIBRATION
 *     CANDIDATE (3 s read / 15 s pass / 2 s between reads,
 *     `../practical/policy.ts`). A calibration marker for Stage 2 only: it
 *     never failed anything and is NOT a provider guarantee violation (there
 *     is no provider guarantee);
 *   - `hardTimeout` / `hardCeilingExceeded`: a HARD OPERATIONAL CEILING
 *     (`./timing.ts`) was hit, and the read or pass failed closed.
 *
 * A telemetry sink can never affect certification: `recordSafely` swallows
 * any sink failure.
 */
import type pino from 'pino';
import type { PracticalInvalidationReason } from '../practical/types';

export type PracticalObservationReadKind = 'IDENTITY' | 'ORDERS' | 'POSITIONS';

/**
 * The seven reads of one bracketed pass, in order: the identity read that
 * opens it, the O-P-O-P-O account-state core, and the identity read that
 * closes it.
 */
export type PracticalPassReadSlot = 'IDENTITY_OPEN' | 'O1' | 'P1' | 'O2' | 'P2' | 'O3' | 'IDENTITY_CLOSE';

/** Which bracket comparison failed inside one pass. */
export type PracticalBracketDisagreement = 'ORDERS_O1_O2' | 'POSITIONS_P1_P2' | 'ORDERS_O2_O3';

export type PracticalRecoveryTelemetryEvent =
  | {
      readonly type: 'P18B_READ';
      readonly runId: string;
      readonly passIndex: number;
      readonly slot: PracticalPassReadSlot;
      readonly read: PracticalObservationReadKind;
      readonly latencyMs: number;
      readonly outcome: string;
      readonly pagesRead: number | null;
      readonly complete: boolean;
      /** Calibration marker: latency above the read-duration CANDIDATE. Not a failure; not a provider violation. */
      readonly readCandidateExceeded: boolean;
      /** The HARD read timeout fired and the read failed closed. */
      readonly hardTimeout: boolean;
    }
  | {
      readonly type: 'P18B_PASS';
      readonly runId: string;
      readonly passIndex: number;
      readonly durationMs: number;
      /** Start of the first read to start of the last read in this pass: how far apart its observations are. */
      readonly observationSkewMs: number;
      /** Largest gap between the end of one read and the start of the next inside this pass. */
      readonly maxInterReadGapMs: number;
      readonly complete: boolean;
      readonly failure: string | null;
      readonly bracketDisagreement: PracticalBracketDisagreement | null;
      readonly stateDigestPrefix: string | null;
      /** Calibration markers: above the pass-window / inter-read-gap CANDIDATES. Not failures; not provider violations. */
      readonly passCandidateExceeded: boolean;
      readonly interReadGapCandidateExceeded: boolean;
      /** The HARD pass-duration ceiling was exceeded and the pass did not count. */
      readonly hardCeilingExceeded: boolean;
    }
  | { readonly type: 'P18B_PASS_SPACING'; readonly runId: string; readonly afterPassIndex: number; readonly spacingMs: number }
  /** Inside one pass (a bracket comparison), or across passes (`STATE_DIGEST_DIFFERS`). */
  | { readonly type: 'P18B_DISAGREEMENT'; readonly runId: string; readonly passIndex: number; readonly reason: PracticalBracketDisagreement | 'STATE_DIGEST_DIFFERS' }
  | {
      readonly type: 'P18B_TRIPWIRE';
      readonly accountId: string;
      readonly reason: PracticalInvalidationReason;
      readonly incarnation: number;
      /** Age of the outstanding certificate at revocation, when one was outstanding. */
      readonly certificateAgeMs: number | null;
    }
  | { readonly type: 'P18B_REVOCATION_FAILED'; readonly accountId: string; readonly reason: PracticalInvalidationReason; readonly failure: string }
  /** An outstanding certificate ended by the authority monitor (expiry or a revoke-only check), with its age. */
  | { readonly type: 'P18B_AUTHORITY_ENDED'; readonly accountId: string; readonly reason: PracticalInvalidationReason; readonly certificateAgeMs: number }
  | {
      readonly type: 'P18B_CERTIFICATION';
      readonly runId: string;
      readonly outcome: 'CERTIFIED' | 'FAILED' | 'SUPERSEDED';
      readonly failure: string | null;
      readonly passCount: number;
      readonly certificationSpanMs: number | null;
      readonly minimumObservedPassSpacingMs: number | null;
    };

export interface PracticalRecoveryTelemetry {
  record(event: PracticalRecoveryTelemetryEvent): void;
}

/** Records to a sink; a failing sink never affects the caller. */
export function recordSafely(sink: PracticalRecoveryTelemetry, event: PracticalRecoveryTelemetryEvent): void {
  try {
    sink.record(Object.freeze({ ...event }));
  } catch {
    // Telemetry is observational only.
  }
}

/** Structured-log sink. The events are already safe; the logger's redaction still applies. */
export function practicalRecoveryLogTelemetry(logger: pino.Logger): PracticalRecoveryTelemetry {
  return Object.freeze({
    record(event: PracticalRecoveryTelemetryEvent): void {
      logger.info({ ...event }, 'P18B practical recovery telemetry');
    },
  });
}

/** In-memory sink (tests and diagnostics). */
export class PracticalRecoveryTelemetryBuffer implements PracticalRecoveryTelemetry {
  readonly #events: PracticalRecoveryTelemetryEvent[] = [];

  public record(event: PracticalRecoveryTelemetryEvent): void {
    this.#events.push(event);
  }

  public get events(): readonly PracticalRecoveryTelemetryEvent[] {
    return Object.freeze([...this.#events]);
  }
}
