import { sha256CanonicalJson } from '../risk';
import { paperSourceInvalid } from './errors';
import { canonicalPositivePersistedDecimal } from './snapshot-decimal';

export const INSTRUMENT_ECONOMICS_IDENTITY_POLICY_ID = 'P14_INSTRUMENT_ECONOMICS_SNAPSHOT_V1' as const;

export interface InstrumentEconomicsSnapshotContent {
  readonly identityPolicyId: typeof INSTRUMENT_ECONOMICS_IDENTITY_POLICY_ID;
  readonly sourceId: string;
  readonly instrumentSpecIdentityPolicyId: string;
  readonly instrumentSpecSnapshotId: string;
  readonly pair: string;
  readonly contractMultiplier: string;
  readonly priceIncrement: string;
  readonly quantityIncrement: string;
}

export interface InstrumentEconomicsSnapshot extends InstrumentEconomicsSnapshotContent {
  readonly instrumentEconomicsSnapshotId: string;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) paperSourceInvalid(`${label} must be a non-empty exact string`);
  return value;
}

export function normalizeInstrumentEconomicsSnapshotContent(
  input: InstrumentEconomicsSnapshotContent,
): InstrumentEconomicsSnapshotContent {
  if (input.identityPolicyId !== INSTRUMENT_ECONOMICS_IDENTITY_POLICY_ID) {
    paperSourceInvalid('instrument economics identityPolicyId is not supported');
  }
  return Object.freeze({
    identityPolicyId: INSTRUMENT_ECONOMICS_IDENTITY_POLICY_ID,
    sourceId: exactString(input.sourceId, 'instrument economics sourceId'),
    instrumentSpecIdentityPolicyId: exactString(input.instrumentSpecIdentityPolicyId, 'instrumentSpecIdentityPolicyId'),
    instrumentSpecSnapshotId: exactString(input.instrumentSpecSnapshotId, 'instrumentSpecSnapshotId'),
    pair: exactString(input.pair, 'instrument economics pair'),
    contractMultiplier: canonicalPositivePersistedDecimal(input.contractMultiplier, 'contractMultiplier'),
    priceIncrement: canonicalPositivePersistedDecimal(input.priceIncrement, 'priceIncrement'),
    quantityIncrement: canonicalPositivePersistedDecimal(input.quantityIncrement, 'quantityIncrement'),
  });
}

export function buildInstrumentEconomicsSnapshot(
  input: Omit<InstrumentEconomicsSnapshotContent, 'identityPolicyId'> & { readonly identityPolicyId?: typeof INSTRUMENT_ECONOMICS_IDENTITY_POLICY_ID },
): InstrumentEconomicsSnapshot {
  const content = normalizeInstrumentEconomicsSnapshotContent({
    ...input,
    identityPolicyId: input.identityPolicyId ?? INSTRUMENT_ECONOMICS_IDENTITY_POLICY_ID,
  });
  return Object.freeze({ instrumentEconomicsSnapshotId: sha256CanonicalJson(content), ...content });
}

/** Recomputes the one canonical identity and rejects ID/content spoofing. */
export function validateInstrumentEconomicsSnapshot(input: InstrumentEconomicsSnapshot): InstrumentEconomicsSnapshot {
  const rebuilt = buildInstrumentEconomicsSnapshot(input);
  if (input.instrumentEconomicsSnapshotId !== rebuilt.instrumentEconomicsSnapshotId) {
    paperSourceInvalid('INSTRUMENT_ECONOMICS_IDENTITY_MISMATCH');
  }
  return rebuilt;
}
