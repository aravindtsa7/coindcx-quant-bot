/**
 * M3 (design for review, docs/M3_PRACTICAL_OBSERVATION_DESIGN.md): a PURE, UNWIRED evaluator of the register D4c client
 * proposal, a weaker REST-observation basis. D4c remains CLIENT PROPOSAL (NOT APPROVED). Nothing in `src/` imports
 * this module, and it imports nothing.
 *
 * What it computes. Two agreeing REST read passes within a declared scope, bounded total read duration and bounded
 * evidence age are OBSERVED CONVERGENCE (register B12). That is not atomic consistency, gap detection, "nothing changed
 * between or after the reads", or strict continuity.
 *
 * Modes are explicit. FULL_EVIDENCE blocks on missing fill identifiers. CUMULATIVE_STATE compares the available
 * cumulative state and records missing fill identifiers as non-blocking gaps. In both modes, complete fill
 * reconstruction, exactly-once execution accounting and fee accounting stay UNKNOWN, and a scope that requires any of
 * them is blocked. Ownership, pagination and account-scope gaps block in both modes.
 *
 * What it never does:
 *   - It grants no certificate, budget eligibility, order permission, authority eligibility, strategy lifecycle status,
 *     live readiness or strict continuity. Every result carries `grants: GRANTS_NOTHING`.
 *   - It is never a fallback for a failed strict check. It is a separate client assessment.
 *   - It never treats a quiet private stream as proof of no activity, a tag as proof of ownership, or a join as
 *     acknowledged without positive provider evidence for the current epoch.
 *   - It never reports the provider's REST/WebSocket synchronization procedure (register D4a, E21) as satisfied.
 *   - It reads no clock and no configuration. Every threshold is an explicit input, and none is approved.
 */

export type ObservationComponent = 'ORDERS' | 'POSITIONS' | 'TRANSACTIONS';
const COMPONENTS: readonly ObservationComponent[] = Object.freeze(['ORDERS', 'POSITIONS', 'TRANSACTIONS']);

/** Explicit, caller-supplied bounds. No default exists; none is approved for production. */
export interface PracticalObservationThresholds {
  /** Maximum age of the oldest evidence (first read start) at evaluation time. */
  readonly maxEvidenceAgeMs: number;
  /** Maximum span from the first read start to the last read end, across both passes. */
  readonly maxTotalReadDurationMs: number;
}

/**
 * Fill-level capabilities that depend on stable fill identifiers (register B3, B13). The evaluator never supports them:
 * a scope that needs one is blocked (`ACCOUNTING_UNSUPPORTED_FOR_SCOPE`).
 */
export type AccountingCapability = 'COMPLETE_FILL_RECONSTRUCTION' | 'EXACTLY_ONCE_EXECUTION_ACCOUNTING' | 'FEE_ACCOUNTING';
const ACCOUNTING_CAPABILITIES: readonly AccountingCapability[] = Object.freeze(['COMPLETE_FILL_RECONSTRUCTION', 'EXACTLY_ONCE_EXECUTION_ACCOUNTING', 'FEE_ACCOUNTING']);

/** The declared comparison scope: which account and REST components are compared, and what accounting it needs. */
export interface ObservationScope {
  readonly accountId: string;
  readonly components: readonly ObservationComponent[];
  /** Explicit, possibly empty. Any entry blocks: no fill-level accounting is supported. */
  readonly requiredAccounting: readonly AccountingCapability[];
}

/**
 * Explicit comparison mode (no default).
 * - FULL_EVIDENCE: missing fill identifiers block, as in the first candidate. Unchanged.
 * - CUMULATIVE_STATE: compares the available cumulative state; missing fill identifiers are recorded as non-blocking
 *   gaps, and every fill-level capability stays UNKNOWN. Every other blocker is unchanged.
 */
export type ObservationMode = 'FULL_EVIDENCE' | 'CUMULATIVE_STATE';

/**
 * Ownership evidence for one observed record, in the register §5 classes. A tag is correlation evidence only:
 * `TAG_CORRELATED_ONLY` is treated as UNRESOLVED. OWNED must name established local lineage.
 */
export type ObservationOwnership =
  | Readonly<{ kind: 'OWNED'; lineage: 'BOT_CREATE_RESPONSE' | 'RESOLVED_UNDER_CONFIRMED_CONTRACT' }>
  | Readonly<{ kind: 'TAG_CORRELATED_ONLY' }>
  | Readonly<{ kind: 'UNRESOLVED' }>
  | Readonly<{ kind: 'FOREIGN_OBSERVED' }>
  | Readonly<{ kind: 'VENUE_GENERATED' }>;

/** One scoped record: a stable key and a canonical fingerprint of its compared fields. */
export interface ObservedRecord {
  readonly key: string;
  readonly fingerprint: string;
  readonly ownership: ObservationOwnership;
}

export type ComponentRead =
  | Readonly<{ component: ObservationComponent; kind: 'FAILED' }>
  | Readonly<{
    component: ObservationComponent;
    kind: 'READ';
    /** CONFIRMED only when the read is positively bound to the declared account. */
    accountScope: Readonly<{ kind: 'CONFIRMED'; accountId: string }> | Readonly<{ kind: 'UNKNOWN' }>;
    pagination: 'COMPLETE' | 'TRUNCATED' | 'UNKNOWN';
    recordTimestamps: 'PRESENT' | 'MISSING';
    fillIds: 'PRESENT' | 'MISSING' | 'NOT_APPLICABLE';
    startedAtMs: number;
    endedAtMs: number;
    records: readonly ObservedRecord[];
  }>;

export interface RestObservationPass {
  readonly reads: readonly ComponentRead[];
}

/** What is observable about the private stream. Nothing here is inferred from silence. */
export interface PrivateStreamObservation {
  readonly connected: boolean;
  /** Current incarnation, or null when unknown. */
  readonly epoch: number | null;
  /** Incarnation when the first read started, or null when unknown. */
  readonly epochAtWindowStart: number | null;
  readonly disconnectObservedSinceWindowStart: boolean;
  /** The client's sticky reconnect latch (register D5). */
  readonly reconnectLatched: boolean;
  /** Positive provider-origin acknowledgement for a given epoch, or UNKNOWN (register D2). */
  readonly joinAcknowledgement: Readonly<{ kind: 'PROVIDER_CONFIRMED'; epoch: number }> | Readonly<{ kind: 'UNKNOWN' }>;
  /** Every private event observed, with its local observation time. */
  readonly events: readonly Readonly<{ observedAtMs: number }>[];
  /** Events received but not yet applied. */
  readonly bufferedUnprocessedEvents: number;
}

export interface PracticalObservationInput {
  readonly mode: ObservationMode;
  readonly scope: ObservationScope;
  readonly thresholds: PracticalObservationThresholds;
  readonly passes: readonly RestObservationPass[];
  readonly stream: PrivateStreamObservation;
  /** Caller-supplied local evaluation time. */
  readonly evaluatedAtMs: number;
}

export type ObservationReason =
  | 'INVALID_INPUT' | 'INVALID_THRESHOLDS' | 'PASS_COUNT_INVALID'
  | 'SCOPE_COMPONENT_MISSING' | 'SCOPE_COMPONENT_UNDECLARED' | 'READ_FAILED'
  | 'ACCOUNT_SCOPE_UNKNOWN' | 'ACCOUNT_SCOPE_MISMATCH' | 'PAGINATION_TRUNCATED' | 'PAGINATION_UNKNOWN'
  | 'RECORD_TIMESTAMPS_MISSING' | 'FILL_IDS_MISSING' | 'ACCOUNTING_UNSUPPORTED_FOR_SCOPE'
  | 'READ_ORDER_INVALID' | 'READ_DURATION_EXCEEDED' | 'EVIDENCE_STALE' | 'EVIDENCE_AFTER_EVALUATION'
  | 'RECORDS_DISAGREE' | 'DUPLICATE_RECORD_KEY' | 'OWNERSHIP_CONFLICT' | 'OWNERSHIP_UNRESOLVED'
  | 'FOREIGN_ACTIVITY_OBSERVED' | 'VENUE_GENERATED_CHANGE'
  | 'STREAM_DISCONNECTED' | 'DISCONNECT_DURING_WINDOW' | 'RECONNECT_LATCHED' | 'EPOCH_UNKNOWN' | 'EPOCH_CHANGED'
  | 'EVENT_DURING_OR_AFTER_WINDOW' | 'BUFFERED_EVENTS_PENDING';

export type EvidenceGap = Readonly<{
  pass: number;
  component: ObservationComponent;
  gap: 'ACCOUNT_SCOPE_UNKNOWN' | 'PAGINATION_TRUNCATED' | 'PAGINATION_UNKNOWN' | 'RECORD_TIMESTAMPS_MISSING' | 'FILL_IDS_MISSING';
  /** False only for missing fill identifiers in CUMULATIVE_STATE mode. */
  blocking: boolean;
}>;

/** Fill-level accounting is never established by this evaluator (B3, B13): every status is the literal UNKNOWN. */
export type FillLevelAccounting = Readonly<{
  completeFillReconstruction: 'UNKNOWN';
  exactlyOnceExecutionAccounting: 'UNKNOWN';
  feeAccounting: 'UNKNOWN';
  reasons: readonly ('STABLE_FILL_ID_CONTRACT_UNRESOLVED' | 'FILL_IDS_MISSING' | 'CUMULATIVE_STATE_MODE')[];
}>;

/** Constant: this evaluator grants nothing. The literal `false` types make any other value a type error. */
export const GRANTS_NOTHING = Object.freeze({
  certificate: false,
  mutationBudget: false,
  orderPermission: false,
  authorityEligibility: false,
  strategyLifecyclePromotion: false,
  liveReadiness: false,
  strictContinuity: false,
} as const);

export type PracticalObservationAssessment = Readonly<{
  kind: 'OBSERVED_CONVERGENCE' | 'NOT_CONVERGED' | 'INVALID_INPUT';
  mode: ObservationMode | null;
  /** Empty exactly when kind is OBSERVED_CONVERGENCE. */
  reasons: readonly ObservationReason[];
  evidenceGaps: readonly EvidenceGap[];
  semantics: 'OBSERVED_CONVERGENCE_IS_NOT_ATOMIC_CONSISTENCY';
  scope: Readonly<{ accountId: string; components: readonly ObservationComponent[]; requiredAccounting: readonly AccountingCapability[] }> | null;
  fillLevelAccounting: FillLevelAccounting;
  window: Readonly<{ startedAtMs: number; endedAtMs: number; evaluatedAtMs: number }> | null;
  stream: Readonly<{
    epoch: number | null;
    /** This evaluator never assesses private-stream readiness; that remains the existing, unchanged predicate. */
    privateStreamReadiness: 'NOT_ASSESSED';
    /** Recorded only. An UNKNOWN acknowledgement does not block the REST observation comparison. */
    joinAcknowledgement: 'PROVIDER_CONFIRMED_FOR_EPOCH' | 'UNKNOWN';
    joinAcknowledgementBlocksComparison: false;
    eventsInWindow: number;
    quietStream: boolean;
    quietStreamProvesNoActivity: false;
  }> | null;
  /** The provider's REST/WebSocket procedure (D4a) is never established by a REST-only assessment. */
  providerSynchronization: Readonly<{ status: 'NOT_ESTABLISHED'; reasons: readonly string[] }>;
  grants: typeof GRANTS_NOTHING;
}>;

export type CandidateRecheck =
  | Readonly<{ kind: 'NOT_A_CANDIDATE'; grants: typeof GRANTS_NOTHING }>
  | Readonly<{ kind: 'INVALIDATED'; reasons: readonly ObservationReason[]; grants: typeof GRANTS_NOTHING }>
  | Readonly<{ kind: 'CANDIDATE_UNCHANGED'; grants: typeof GRANTS_NOTHING }>;

const produced = new WeakSet<object>();
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isEpoch = (value: unknown): value is number | null => value === null || isPositive(value);
const isComponent = (value: unknown): value is ObservationComponent => COMPONENTS.includes(value as ObservationComponent);
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function providerSynchronization(acknowledged: boolean): PracticalObservationAssessment['providerSynchronization'] {
  return Object.freeze({
    status: 'NOT_ESTABLISHED' as const,
    reasons: Object.freeze(['REST_ONLY_ASSESSMENT', 'WEBSOCKET_DERIVED_STATE_NOT_COMPARED', ...(acknowledged ? [] : ['JOIN_ACKNOWLEDGEMENT_UNKNOWN'])]),
  });
}

function fillLevelAccounting(fillIdsMissing: boolean, mode: ObservationMode | null): FillLevelAccounting {
  return Object.freeze({
    completeFillReconstruction: 'UNKNOWN' as const,
    exactlyOnceExecutionAccounting: 'UNKNOWN' as const,
    feeAccounting: 'UNKNOWN' as const,
    reasons: Object.freeze([
      'STABLE_FILL_ID_CONTRACT_UNRESOLVED' as const,
      ...(fillIdsMissing ? ['FILL_IDS_MISSING' as const] : []),
      ...(mode === 'CUMULATIVE_STATE' ? ['CUMULATIVE_STATE_MODE' as const] : []),
    ]),
  });
}

function invalid(reason: 'INVALID_INPUT' | 'INVALID_THRESHOLDS'): PracticalObservationAssessment {
  const result: PracticalObservationAssessment = Object.freeze({
    kind: 'INVALID_INPUT' as const, mode: null, reasons: Object.freeze([reason]), evidenceGaps: Object.freeze([]),
    semantics: 'OBSERVED_CONVERGENCE_IS_NOT_ATOMIC_CONSISTENCY' as const, scope: null, fillLevelAccounting: fillLevelAccounting(false, null),
    window: null, stream: null, providerSynchronization: providerSynchronization(false), grants: GRANTS_NOTHING,
  });
  produced.add(result);
  return result;
}

function validThresholds(value: unknown): value is PracticalObservationThresholds {
  return isRecord(value) && isPositive(value['maxEvidenceAgeMs']) && isPositive(value['maxTotalReadDurationMs']);
}

const OWNERSHIP_KINDS = ['OWNED', 'TAG_CORRELATED_ONLY', 'UNRESOLVED', 'FOREIGN_OBSERVED', 'VENUE_GENERATED'];
function validOwnership(value: unknown): value is ObservationOwnership {
  if (!isRecord(value) || !OWNERSHIP_KINDS.includes(value['kind'] as string)) return false;
  return value['kind'] !== 'OWNED' || value['lineage'] === 'BOT_CREATE_RESPONSE' || value['lineage'] === 'RESOLVED_UNDER_CONFIRMED_CONTRACT';
}
function validRead(value: unknown): value is ComponentRead {
  if (!isRecord(value) || !isComponent(value['component'])) return false;
  if (value['kind'] === 'FAILED') return true;
  if (value['kind'] !== 'READ') return false;
  const scope = value['accountScope'];
  if (!isRecord(scope) || !(scope['kind'] === 'UNKNOWN' || (scope['kind'] === 'CONFIRMED' && isNonEmptyString(scope['accountId'])))) return false;
  if (!['COMPLETE', 'TRUNCATED', 'UNKNOWN'].includes(value['pagination'] as string)) return false;
  if (!['PRESENT', 'MISSING'].includes(value['recordTimestamps'] as string)) return false;
  if (!['PRESENT', 'MISSING', 'NOT_APPLICABLE'].includes(value['fillIds'] as string)) return false;
  if (!isTime(value['startedAtMs']) || !isTime(value['endedAtMs'])) return false;
  const records = value['records'];
  return Array.isArray(records) && records.every((record: unknown) => isRecord(record) && isNonEmptyString(record['key'])
    && isNonEmptyString(record['fingerprint']) && validOwnership(record['ownership']));
}
function validStream(value: unknown): value is PrivateStreamObservation {
  if (!isRecord(value)) return false;
  const ack = value['joinAcknowledgement'];
  const events = value['events'];
  return typeof value['connected'] === 'boolean' && isEpoch(value['epoch']) && isEpoch(value['epochAtWindowStart'])
    && typeof value['disconnectObservedSinceWindowStart'] === 'boolean' && typeof value['reconnectLatched'] === 'boolean'
    && isRecord(ack) && (ack['kind'] === 'UNKNOWN' || (ack['kind'] === 'PROVIDER_CONFIRMED' && isPositive(ack['epoch'])))
    && Array.isArray(events) && events.every((event: unknown) => isRecord(event) && isTime(event['observedAtMs']))
    && Number.isSafeInteger(value['bufferedUnprocessedEvents']) && (value['bufferedUnprocessedEvents'] as number) >= 0;
}
function validScope(value: unknown): value is ObservationScope {
  if (!isRecord(value) || !isNonEmptyString(value['accountId'])) return false;
  const components = value['components'];
  const accounting = value['requiredAccounting'];
  return Array.isArray(components) && components.length > 0 && components.every(isComponent) && new Set(components).size === components.length
    && Array.isArray(accounting) && accounting.every((entry: unknown) => ACCOUNTING_CAPABILITIES.includes(entry as AccountingCapability))
    && new Set(accounting).size === accounting.length;
}
const isMode = (value: unknown): value is ObservationMode => value === 'FULL_EVIDENCE' || value === 'CUMULATIVE_STATE';

/** Stream conditions that revoke a candidate observed after `windowStartMs` for `epoch`. */
function streamRevocations(stream: PrivateStreamObservation, windowStartMs: number, candidateEpoch: number | null): ObservationReason[] {
  const reasons: ObservationReason[] = [];
  if (!stream.connected) reasons.push('STREAM_DISCONNECTED');
  if (stream.disconnectObservedSinceWindowStart) reasons.push('DISCONNECT_DURING_WINDOW');
  if (stream.reconnectLatched) reasons.push('RECONNECT_LATCHED');
  if (stream.epoch === null || stream.epochAtWindowStart === null || candidateEpoch === null) reasons.push('EPOCH_UNKNOWN');
  else if (stream.epoch !== stream.epochAtWindowStart || stream.epoch !== candidateEpoch) reasons.push('EPOCH_CHANGED');
  if (stream.events.some((event) => event.observedAtMs >= windowStartMs)) reasons.push('EVENT_DURING_OR_AFTER_WINDOW');
  if (stream.bufferedUnprocessedEvents > 0) reasons.push('BUFFERED_EVENTS_PENDING');
  return reasons;
}

const ownershipKey = (ownership: ObservationOwnership): string => (ownership.kind === 'OWNED' ? `OWNED:${ownership.lineage}` : ownership.kind);

/** Assesses REST observed convergence. Pure: the result depends only on `input`. */
export function assessPracticalObservation(input: unknown): PracticalObservationAssessment {
  if (!isRecord(input)) return invalid('INVALID_INPUT');
  if (!validThresholds(input['thresholds'])) return invalid('INVALID_THRESHOLDS');
  const passesValue = input['passes'];
  if (!isMode(input['mode']) || !validScope(input['scope']) || !validStream(input['stream']) || !isTime(input['evaluatedAtMs']) || !Array.isArray(passesValue)) return invalid('INVALID_INPUT');
  if (!passesValue.every((pass: unknown) => isRecord(pass) && Array.isArray(pass['reads']) && (pass['reads'] as unknown[]).every(validRead))) return invalid('INVALID_INPUT');
  const mode = input['mode'];
  const scope = input['scope'];
  const thresholds = input['thresholds'];
  const stream = input['stream'];
  const evaluatedAtMs = input['evaluatedAtMs'];
  const passes = passesValue as readonly RestObservationPass[];

  const reasons = new Set<ObservationReason>();
  const gaps: EvidenceGap[] = [];
  let fillIdsMissing = false;
  if (passes.length !== 2) reasons.add('PASS_COUNT_INVALID');
  // No fill-level accounting is supported in either mode, so a scope that needs it is blocked.
  if (scope.requiredAccounting.length > 0) reasons.add('ACCOUNTING_UNSUPPORTED_FOR_SCOPE');

  // Per pass: every declared component read exactly once; nothing undeclared; each read's evidence explicit.
  const byPass: Array<Map<ObservationComponent, Extract<ComponentRead, { kind: 'READ' }>>> = [];
  passes.forEach((pass, index) => {
    const reads = new Map<ObservationComponent, Extract<ComponentRead, { kind: 'READ' }>>();
    const seen = new Set<ObservationComponent>();
    for (const read of pass.reads) {
      if (!scope.components.includes(read.component)) { reasons.add('SCOPE_COMPONENT_UNDECLARED'); continue; }
      if (seen.has(read.component)) { reasons.add('INVALID_INPUT'); continue; }
      seen.add(read.component);
      if (read.kind === 'FAILED') { reasons.add('READ_FAILED'); continue; }
      const gap = (kind: EvidenceGap['gap'], blocking = true): void => {
        if (blocking) reasons.add(kind);
        gaps.push(Object.freeze({ pass: index, component: read.component, gap: kind, blocking }));
      };
      if (read.accountScope.kind === 'UNKNOWN') gap('ACCOUNT_SCOPE_UNKNOWN');
      else if (read.accountScope.accountId !== scope.accountId) reasons.add('ACCOUNT_SCOPE_MISMATCH');
      if (read.pagination === 'TRUNCATED') gap('PAGINATION_TRUNCATED');
      if (read.pagination === 'UNKNOWN') gap('PAGINATION_UNKNOWN');
      if (read.recordTimestamps === 'MISSING') gap('RECORD_TIMESTAMPS_MISSING');
      if (read.fillIds === 'MISSING') { fillIdsMissing = true; gap('FILL_IDS_MISSING', mode === 'FULL_EVIDENCE'); }
      if (read.endedAtMs < read.startedAtMs) reasons.add('READ_ORDER_INVALID');
      reads.set(read.component, read);
    }
    for (const component of scope.components) if (!seen.has(component)) reasons.add('SCOPE_COMPONENT_MISSING');
    byPass.push(reads);
  });

  // Timing: the second pass starts after the first ends; bounded total duration and evidence age.
  const all = byPass.flatMap((reads) => [...reads.values()]);
  const window = all.length === 0 ? null : Object.freeze({
    startedAtMs: Math.min(...all.map((read) => read.startedAtMs)),
    endedAtMs: Math.max(...all.map((read) => read.endedAtMs)),
    evaluatedAtMs,
  });
  if (window !== null) {
    const [first, second] = byPass;
    if (first !== undefined && second !== undefined && first.size > 0 && second.size > 0) {
      const firstEnd = Math.max(...[...first.values()].map((read) => read.endedAtMs));
      const secondStart = Math.min(...[...second.values()].map((read) => read.startedAtMs));
      if (secondStart < firstEnd) reasons.add('READ_ORDER_INVALID');
    }
    if (window.endedAtMs > evaluatedAtMs) reasons.add('EVIDENCE_AFTER_EVALUATION');
    if (window.endedAtMs - window.startedAtMs > thresholds.maxTotalReadDurationMs) reasons.add('READ_DURATION_EXCEEDED');
    if (evaluatedAtMs - window.startedAtMs > thresholds.maxEvidenceAgeMs) reasons.add('EVIDENCE_STALE');
  }

  // Agreement and ownership, per declared component, across the two passes.
  const [first, second] = byPass;
  if (first !== undefined && second !== undefined) {
    for (const component of scope.components) {
      const a = first.get(component);
      const b = second.get(component);
      if (a === undefined || b === undefined) continue;
      const index = (read: typeof a): Map<string, ObservedRecord> => {
        const map = new Map<string, ObservedRecord>();
        for (const record of read.records) { if (map.has(record.key)) reasons.add('DUPLICATE_RECORD_KEY'); map.set(record.key, record); }
        return map;
      };
      const left = index(a);
      const right = index(b);
      if (left.size !== right.size || [...left.keys()].some((key) => !right.has(key))) reasons.add('RECORDS_DISAGREE');
      for (const [key, record] of left) {
        const other = right.get(key);
        if (other === undefined) continue;
        if (other.fingerprint !== record.fingerprint) reasons.add('RECORDS_DISAGREE');
        if (ownershipKey(other.ownership) !== ownershipKey(record.ownership)) reasons.add('OWNERSHIP_CONFLICT');
      }
      for (const record of [...left.values(), ...right.values()]) {
        if (record.ownership.kind === 'UNRESOLVED' || record.ownership.kind === 'TAG_CORRELATED_ONLY') reasons.add('OWNERSHIP_UNRESOLVED');
        if (record.ownership.kind === 'FOREIGN_OBSERVED') reasons.add('FOREIGN_ACTIVITY_OBSERVED');
        if (record.ownership.kind === 'VENUE_GENERATED') reasons.add('VENUE_GENERATED_CHANGE');
      }
    }
  }

  // The private stream: revocation inputs only. Silence is recorded, never credited.
  const windowStart = window?.startedAtMs ?? evaluatedAtMs;
  for (const reason of streamRevocations(stream, windowStart, stream.epoch)) reasons.add(reason);
  const acknowledged = stream.joinAcknowledgement.kind === 'PROVIDER_CONFIRMED' && stream.epoch !== null && stream.joinAcknowledgement.epoch === stream.epoch;

  const ordered = Object.freeze([...reasons].sort());
  const result: PracticalObservationAssessment = Object.freeze({
    kind: ordered.length === 0 ? 'OBSERVED_CONVERGENCE' as const : 'NOT_CONVERGED' as const,
    mode,
    reasons: ordered,
    evidenceGaps: Object.freeze(gaps),
    semantics: 'OBSERVED_CONVERGENCE_IS_NOT_ATOMIC_CONSISTENCY' as const,
    scope: Object.freeze({ accountId: scope.accountId, components: Object.freeze([...scope.components]), requiredAccounting: Object.freeze([...scope.requiredAccounting]) }),
    fillLevelAccounting: fillLevelAccounting(fillIdsMissing, mode),
    window,
    stream: Object.freeze({
      epoch: stream.epoch,
      privateStreamReadiness: 'NOT_ASSESSED' as const,
      joinAcknowledgement: acknowledged ? 'PROVIDER_CONFIRMED_FOR_EPOCH' as const : 'UNKNOWN' as const,
      joinAcknowledgementBlocksComparison: false as const,
      eventsInWindow: stream.events.filter((event) => event.observedAtMs >= windowStart).length,
      quietStream: stream.events.length === 0,
      quietStreamProvesNoActivity: false as const,
    }),
    providerSynchronization: providerSynchronization(acknowledged),
    grants: GRANTS_NOTHING,
  });
  produced.add(result);
  return result;
}

/**
 * Re-checks a candidate against newer observations. It can only invalidate, never upgrade: anything other than an
 * OBSERVED_CONVERGENCE produced by `assessPracticalObservation` (including a structural copy) is NOT_A_CANDIDATE. New
 * observed events, an epoch change, a disconnect or latch, buffered events, or stale evidence invalidate it.
 */
export function recheckObservationCandidate(candidate: unknown, current: unknown): CandidateRecheck {
  if (!isRecord(candidate) || !produced.has(candidate)) return Object.freeze({ kind: 'NOT_A_CANDIDATE' as const, grants: GRANTS_NOTHING });
  const assessment = candidate as PracticalObservationAssessment;
  if (assessment.kind !== 'OBSERVED_CONVERGENCE' || assessment.window === null || assessment.stream === null) {
    return Object.freeze({ kind: 'NOT_A_CANDIDATE' as const, grants: GRANTS_NOTHING });
  }
  if (!isRecord(current) || !validThresholds(current['thresholds']) || !validStream(current['stream']) || !isTime(current['evaluatedAtMs'])) {
    return Object.freeze({ kind: 'INVALIDATED' as const, reasons: Object.freeze(['INVALID_INPUT' as const]), grants: GRANTS_NOTHING });
  }
  const reasons = new Set<ObservationReason>(streamRevocations(current['stream'], assessment.window.startedAtMs, assessment.stream.epoch));
  if (current['evaluatedAtMs'] - assessment.window.startedAtMs > current['thresholds'].maxEvidenceAgeMs) reasons.add('EVIDENCE_STALE');
  if (current['evaluatedAtMs'] < assessment.window.evaluatedAtMs) reasons.add('EVIDENCE_AFTER_EVALUATION');
  if (reasons.size > 0) return Object.freeze({ kind: 'INVALIDATED' as const, reasons: Object.freeze([...reasons].sort()), grants: GRANTS_NOTHING });
  return Object.freeze({ kind: 'CANDIDATE_UNCHANGED' as const, grants: GRANTS_NOTHING });
}
