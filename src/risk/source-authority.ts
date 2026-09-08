import { evidenceContentSha256 } from './canonical';
import type { RiskRejectionCode } from './reason-codes';
import type { EvidenceProvenance, RiskFreshnessPolicy } from './types';

export function verifyEvidence(
  snapshot: { readonly provenance: EvidenceProvenance },
  expectedSourceId: string,
  evaluationTimeMs: number,
  maxAgeMs: number,
  staleCode: RiskRejectionCode,
): { readonly contentHash: string; readonly reasons: readonly RiskRejectionCode[] } {
  const reasons: RiskRejectionCode[] = [];
  const computed = evidenceContentSha256(snapshot);
  if (computed !== snapshot.provenance.contentSha256) reasons.push('DECISION_IDENTITY_MISMATCH');
  if (snapshot.provenance.sourceId !== expectedSourceId) reasons.push('SOURCE_ID_MISMATCH');
  const causal = (snapshot.provenance.sourceTimeMs === null || snapshot.provenance.sourceTimeMs <= snapshot.provenance.observedAtMs) &&
    snapshot.provenance.observedAtMs <= evaluationTimeMs;
  if (!causal) reasons.push('EVIDENCE_TEMPORAL_CAUSALITY_VIOLATION');
  else if (evaluationTimeMs - snapshot.provenance.observedAtMs > maxAgeMs) reasons.push(staleCode);
  return { contentHash: computed, reasons };
}

export function freshnessFor(kind: 'account' | 'pair' | 'exposure' | 'tier' | 'settlement', policy: RiskFreshnessPolicy): number {
  switch (kind) {
    case 'account': return policy.maxAccountSnapshotAgeMs;
    case 'pair': return policy.maxPairSnapshotAgeMs;
    case 'exposure': return policy.maxExposureSnapshotAgeMs;
    case 'tier': return policy.maxLeverageTierSnapshotAgeMs;
    case 'settlement': return policy.maxSettlementRateSnapshotAgeMs;
  }
}
