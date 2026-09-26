/**
 * Phase 18B Checkpoint C: shadow campaign configuration.
 *
 * OBSERVATIONAL CONFIGURATION ONLY. The sampling cadence is how often a
 * shadow evaluation starts; it is not a provider guarantee and not an
 * authority threshold. The evaluation window shape (pass count, spacing,
 * span) and the timing values are taken VERBATIM from the Stage 1A safety
 * ceilings and the Checkpoint B timing module, so shadow evidence measures
 * exactly what certification would require; shadow never changes them.
 *
 * The canonical configuration snapshot (versions, cadence, window, timing
 * values, provider endpoint descriptor, paper intents, calibration-review
 * rules) is digested and bound to the campaign: a worker with a different
 * snapshot cannot resume it.
 *
 * `parsePracticalShadowConfigSnapshot` is the ONE strict reader of a
 * PERSISTED snapshot: it recomputes the canonical SHA-256 digest (the exact
 * `sha256CanonicalJson` that created it) and requires it to equal the
 * campaign's bound `configDigest` BEFORE any value is used, then refuses any
 * unsupported config schema, evidence schema, analysis, paper-policy, or
 * review-criteria version, and any unknown or missing field.
 */
import { sha256CanonicalJson } from '../../../risk';
import { PRACTICAL_SAFETY_CEILINGS, PRACTICAL_TIMING_CANDIDATES } from '../practical/policy';
import { PRACTICAL_RECOVERY_HARD_CEILINGS } from '../practical-recovery/timing';
import { practicalPaperIntent } from './classification';
import {
  PRACTICAL_PAPER_ACTIONS,
  PRACTICAL_PAPER_POLICY_VERSION,
  PRACTICAL_PAPER_ROLLOUT_STAGES,
  PRACTICAL_PAPER_SUPPORTED_POLICY_VERSIONS,
  PRACTICAL_SHADOW_ANALYSIS_VERSION,
  PRACTICAL_SHADOW_CONFIG_SCHEMA_VERSION,
  PRACTICAL_SHADOW_EVIDENCE_SCHEMA_VERSION,
  PRACTICAL_SHADOW_SUPPORTED_ANALYSIS_VERSIONS,
  PRACTICAL_SHADOW_SUPPORTED_CONFIG_SCHEMA_VERSIONS,
  PRACTICAL_SHADOW_SUPPORTED_EVIDENCE_SCHEMA_VERSIONS,
  PracticalShadowError,
  type PracticalPaperAction,
  type PracticalPaperIntent,
  type PracticalPaperRolloutStage,
} from './types';

/** The label every review rule set carries: they are provisional criteria for a HUMAN review. */
export const PRACTICAL_SHADOW_REVIEW_CRITERIA_STATUS = 'PROVISIONAL_HUMAN_REVIEW_CRITERIA';

/**
 * PROVISIONAL criteria for flagging a campaign as eligible for HUMAN
 * calibration review. They are NOT authority requirements, NOT CoinDCX
 * guarantees, and NOT calibrated safety thresholds; meeting them changes
 * nothing automatically.
 */
export interface PracticalShadowCalibrationReviewRules {
  readonly status: typeof PRACTICAL_SHADOW_REVIEW_CRITERIA_STATUS;
  readonly minimumDurationMs: number;
  readonly minimumCompletedEvaluations: number;
  /** Required coverage in permille (completed evaluations x cadence / observed duration). */
  readonly minimumCoveragePermille: number;
}

/**
 * WHICH provider endpoints the campaign observes (non-secret): the normalized
 * REST origin and private-stream endpoint. Bound into the configuration
 * digest so a resume against another CoinDCX environment is a binding
 * mismatch. Never carries credentials, paths, or query strings.
 */
export interface PracticalShadowProviderDescriptor {
  readonly restOrigin: string;
  readonly streamEndpoint: string;
}

export interface PracticalShadowConfigInput {
  readonly provider: PracticalShadowProviderDescriptor;
  readonly cadenceMs: number;
  readonly paperIntents?: readonly { readonly action: PracticalPaperAction; readonly stage: PracticalPaperRolloutStage }[] | undefined;
  readonly calibrationReview?: Partial<Omit<PracticalShadowCalibrationReviewRules, 'status'>> | undefined;
}

export interface PracticalShadowConfig {
  readonly provider: PracticalShadowProviderDescriptor;
  readonly cadenceMs: number;
  readonly window: { readonly minimumPasses: number; readonly minimumPassSpacingMs: number; readonly minimumCertificationSpanMs: number };
  readonly timing: {
    readonly readCandidateMs: number;
    readonly passCandidateMs: number;
    readonly interReadGapCandidateMs: number;
    readonly hardReadTimeoutMs: number;
    readonly hardPassDurationMs: number;
  };
  readonly paperIntents: readonly PracticalPaperIntent[];
  readonly calibrationReview: PracticalShadowCalibrationReviewRules;
  /** The canonical snapshot the digest covers (safe; persisted with the campaign). */
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly digest: string;
}

const DAY_MS = 86_400_000;

/**
 * The default PROVISIONAL_HUMAN_REVIEW_CRITERIA: about 14 days, 1000 completed
 * evaluations, 80% coverage. Provisional human-review criteria only -- not
 * authority requirements, CoinDCX guarantees, or calibrated safety thresholds.
 */
export const PRACTICAL_SHADOW_PROVISIONAL_REVIEW_CRITERIA: PracticalShadowCalibrationReviewRules = Object.freeze({
  status: PRACTICAL_SHADOW_REVIEW_CRITERIA_STATUS,
  minimumDurationMs: 14 * DAY_MS,
  minimumCompletedEvaluations: 1_000,
  minimumCoveragePermille: 800,
});

function invalid(message: string): never {
  throw new PracticalShadowError('SHADOW_CONFIG_INVALID', message);
}

function positiveInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(`${name} must be a positive safe integer`);
  return value;
}

/** The normalized origin of an endpoint URL; refuses credentials, paths, queries, fragments, and other schemes. */
function endpointOrigin(value: unknown, name: string, protocol: 'https:' | 'wss:'): string {
  if (typeof value !== 'string') invalid(`${name} must be a URL string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(`${name} must be a URL`);
  }
  if (url.protocol !== protocol) invalid(`${name} must use ${protocol}`);
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== '')) {
    invalid(`${name} must be a bare origin (no credentials, path, query, or fragment)`);
  }
  return url.origin;
}

/** Validates and normalizes a provider descriptor (safe, non-secret). */
export function practicalShadowProviderDescriptor(input: { readonly restOrigin: unknown; readonly streamEndpoint: unknown } | null | undefined): PracticalShadowProviderDescriptor {
  if (typeof input !== 'object' || input === null) invalid('provider must name the REST origin and the stream endpoint');
  return Object.freeze({
    restOrigin: endpointOrigin(input.restOrigin, 'provider.restOrigin', 'https:'),
    streamEndpoint: endpointOrigin(input.streamEndpoint, 'provider.streamEndpoint', 'wss:'),
  });
}

/**
 * Validates and freezes a shadow configuration. The cadence must leave room
 * for a full evaluation window (at least twice the certification span) and
 * be at most one day.
 */
export function resolvePracticalShadowConfig(input: PracticalShadowConfigInput): PracticalShadowConfig {
  if (typeof input !== 'object' || input === null) invalid('configuration must be an object');
  const provider = practicalShadowProviderDescriptor(input.provider);
  const window = Object.freeze({
    minimumPasses: PRACTICAL_SAFETY_CEILINGS.minimumPasses,
    minimumPassSpacingMs: PRACTICAL_SAFETY_CEILINGS.minimumPassSpacingMs,
    minimumCertificationSpanMs: PRACTICAL_SAFETY_CEILINGS.minimumCertificationSpanMs,
  });
  const cadenceMs = positiveInt(input.cadenceMs, 'cadenceMs');
  if (cadenceMs < 2 * window.minimumCertificationSpanMs) invalid('cadenceMs must be at least twice the certification span (an evaluation window must fit)');
  if (cadenceMs > DAY_MS) invalid('cadenceMs must be at most one day');

  const requested = input.paperIntents ?? PRACTICAL_PAPER_ROLLOUT_STAGES.flatMap((stage) => PRACTICAL_PAPER_ACTIONS.map((action) => ({ action, stage })));
  if (!Array.isArray(requested) || requested.length === 0) invalid('paperIntents must be a non-empty list');
  const seen = new Set<string>();
  const paperIntents = requested.map((entry) => {
    if (!(PRACTICAL_PAPER_ACTIONS as readonly string[]).includes(entry?.action) || !(PRACTICAL_PAPER_ROLLOUT_STAGES as readonly string[]).includes(entry?.stage)) {
      invalid('paperIntents entries must name a known action and rollout stage');
    }
    const key = `${entry.action}@${entry.stage}`;
    if (seen.has(key)) invalid(`duplicate paper intent ${key}`);
    seen.add(key);
    return practicalPaperIntent(entry.action, entry.stage);
  });

  const review = input.calibrationReview ?? {};
  const calibrationReview: PracticalShadowCalibrationReviewRules = Object.freeze({
    status: PRACTICAL_SHADOW_REVIEW_CRITERIA_STATUS,
    minimumDurationMs: positiveInt(review.minimumDurationMs ?? PRACTICAL_SHADOW_PROVISIONAL_REVIEW_CRITERIA.minimumDurationMs, 'calibrationReview.minimumDurationMs'),
    minimumCompletedEvaluations: positiveInt(review.minimumCompletedEvaluations ?? PRACTICAL_SHADOW_PROVISIONAL_REVIEW_CRITERIA.minimumCompletedEvaluations, 'calibrationReview.minimumCompletedEvaluations'),
    minimumCoveragePermille: positiveInt(review.minimumCoveragePermille ?? PRACTICAL_SHADOW_PROVISIONAL_REVIEW_CRITERIA.minimumCoveragePermille, 'calibrationReview.minimumCoveragePermille'),
  });
  if (calibrationReview.minimumCoveragePermille > 1_000) invalid('calibrationReview.minimumCoveragePermille must be at most 1000');

  const timing = Object.freeze({
    readCandidateMs: PRACTICAL_TIMING_CANDIDATES.readDuration.valueMs,
    passCandidateMs: PRACTICAL_TIMING_CANDIDATES.passWindow.valueMs,
    interReadGapCandidateMs: PRACTICAL_TIMING_CANDIDATES.interReadGap.valueMs,
    hardReadTimeoutMs: PRACTICAL_RECOVERY_HARD_CEILINGS.readTimeoutMs,
    hardPassDurationMs: PRACTICAL_RECOVERY_HARD_CEILINGS.passDurationMs,
  });
  const snapshot = Object.freeze({
    schema: PRACTICAL_SHADOW_CONFIG_SCHEMA_VERSION,
    evidenceSchemaVersion: PRACTICAL_SHADOW_EVIDENCE_SCHEMA_VERSION,
    analysisVersion: PRACTICAL_SHADOW_ANALYSIS_VERSION,
    paperPolicyVersion: PRACTICAL_PAPER_POLICY_VERSION,
    provider,
    cadenceMs,
    window,
    timing,
    paperIntents: paperIntents.map((intent) => ({ action: intent.requestedAction, stage: intent.rolloutStage })),
    calibrationReview,
  });
  return Object.freeze({
    provider,
    cadenceMs,
    window,
    timing,
    paperIntents: Object.freeze(paperIntents),
    calibrationReview,
    snapshot,
    digest: sha256CanonicalJson(snapshot),
  });
}

// ---------------------------------------------------------------------------
// The ONE strict reader of a persisted campaign configuration snapshot
// ---------------------------------------------------------------------------

/** A persisted snapshot, validated against its bound digest and every version. */
export interface PracticalShadowPersistedConfig {
  readonly schema: string;
  readonly evidenceSchemaVersion: string;
  readonly analysisVersion: string;
  readonly paperPolicyVersion: string;
  readonly provider: PracticalShadowProviderDescriptor;
  readonly cadenceMs: number;
  readonly window: PracticalShadowConfig['window'];
  readonly timing: PracticalShadowConfig['timing'];
  readonly paperIntents: readonly PracticalPaperIntent[];
  readonly calibrationReview: PracticalShadowCalibrationReviewRules;
  readonly digest: string;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SNAPSHOT_KEYS = ['analysisVersion', 'cadenceMs', 'calibrationReview', 'evidenceSchemaVersion', 'paperIntents', 'paperPolicyVersion', 'provider', 'schema', 'timing', 'window'];

function insufficient(message: string): never {
  throw new PracticalShadowError('SHADOW_EVIDENCE_INSUFFICIENT', `Stored campaign configuration: ${message}; nothing is invented`);
}

function unsupportedVersion(what: string, value: unknown): never {
  throw new PracticalShadowError('SHADOW_UNSUPPORTED_VERSION', `Unsupported ${what} ${JSON.stringify(value)}; it is refused, never reinterpreted`);
}

function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) insufficient(`${path} is not an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    unsupportedVersion(`${path} field set`, actual);
  }
  return value as Record<string, unknown>;
}

function storedPositive(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) insufficient(`${path} is not a positive integer`);
  return value;
}

/**
 * Parses a PERSISTED configuration snapshot. The canonical SHA-256 digest of
 * the parsed JSON must equal `expectedDigest` (the campaign's bound
 * configDigest) BEFORE any value is read: a snapshot changed without its
 * digest is SHADOW_EVIDENCE_TAMPERED. Every version must be supported
 * (SHADOW_UNSUPPORTED_VERSION otherwise), and every field is validated.
 */
export function parsePracticalShadowConfigSnapshot(configJson: string, expectedDigest: string): PracticalShadowPersistedConfig {
  if (typeof expectedDigest !== 'string' || !DIGEST_PATTERN.test(expectedDigest)) {
    throw new PracticalShadowError('SHADOW_EVIDENCE_TAMPERED', 'The campaign configuration digest is not an exact lowercase 64-hex digest');
  }
  if (typeof configJson !== 'string') insufficient('it is not a string');
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return insufficient('it is not JSON');
  }
  if (sha256CanonicalJson(parsed) !== expectedDigest) {
    throw new PracticalShadowError('SHADOW_EVIDENCE_TAMPERED', 'The campaign configuration does not match its bound configuration digest');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) insufficient('it is not an object');
  const raw = parsed as Record<string, unknown>;
  // Versions first: an unknown version is refused before its shape is interpreted.
  if (!PRACTICAL_SHADOW_SUPPORTED_CONFIG_SCHEMA_VERSIONS.includes(String(raw['schema']))) unsupportedVersion('config schema', raw['schema']);
  if (!PRACTICAL_SHADOW_SUPPORTED_EVIDENCE_SCHEMA_VERSIONS.includes(String(raw['evidenceSchemaVersion']))) unsupportedVersion('evidence schema version', raw['evidenceSchemaVersion']);
  if (!PRACTICAL_SHADOW_SUPPORTED_ANALYSIS_VERSIONS.includes(String(raw['analysisVersion']))) unsupportedVersion('analysis version', raw['analysisVersion']);
  if (!PRACTICAL_PAPER_SUPPORTED_POLICY_VERSIONS.includes(String(raw['paperPolicyVersion']))) unsupportedVersion('paper policy version', raw['paperPolicyVersion']);
  const snapshot = record(raw, 'config', SNAPSHOT_KEYS);
  const review = record(snapshot['calibrationReview'], 'calibrationReview', ['status', 'minimumDurationMs', 'minimumCompletedEvaluations', 'minimumCoveragePermille']);
  if (review['status'] !== PRACTICAL_SHADOW_REVIEW_CRITERIA_STATUS) unsupportedVersion('calibration review criteria status', review['status']);
  const calibrationReview: PracticalShadowCalibrationReviewRules = Object.freeze({
    status: PRACTICAL_SHADOW_REVIEW_CRITERIA_STATUS,
    minimumDurationMs: storedPositive(review['minimumDurationMs'], 'calibrationReview.minimumDurationMs'),
    minimumCompletedEvaluations: storedPositive(review['minimumCompletedEvaluations'], 'calibrationReview.minimumCompletedEvaluations'),
    minimumCoveragePermille: storedPositive(review['minimumCoveragePermille'], 'calibrationReview.minimumCoveragePermille'),
  });
  if (calibrationReview.minimumCoveragePermille > 1_000) insufficient('calibrationReview.minimumCoveragePermille is above 1000');
  const window = record(snapshot['window'], 'window', ['minimumPasses', 'minimumPassSpacingMs', 'minimumCertificationSpanMs']);
  const timing = record(snapshot['timing'], 'timing', ['readCandidateMs', 'passCandidateMs', 'interReadGapCandidateMs', 'hardReadTimeoutMs', 'hardPassDurationMs']);
  const providerRecord = record(snapshot['provider'], 'provider', ['restOrigin', 'streamEndpoint']);
  let provider: PracticalShadowProviderDescriptor;
  try {
    provider = practicalShadowProviderDescriptor({ restOrigin: providerRecord['restOrigin'], streamEndpoint: providerRecord['streamEndpoint'] });
  } catch {
    return insufficient('provider is not a valid endpoint descriptor');
  }
  if (provider.restOrigin !== providerRecord['restOrigin'] || provider.streamEndpoint !== providerRecord['streamEndpoint']) insufficient('provider is not normalized');
  const intents = snapshot['paperIntents'];
  if (!Array.isArray(intents) || intents.length === 0) insufficient('paperIntents is not a non-empty list');
  const seen = new Set<string>();
  const paperIntents = intents.map((entry: unknown, index: number) => {
    const intent = record(entry, `paperIntents[${index}]`, ['action', 'stage']);
    const key = `${String(intent['action'])}@${String(intent['stage'])}`;
    if (seen.has(key)) insufficient(`paperIntents repeats ${key}`);
    seen.add(key);
    try {
      return practicalPaperIntent(intent['action'] as PracticalPaperAction, intent['stage'] as PracticalPaperRolloutStage);
    } catch {
      return insufficient(`paperIntents[${index}] is not a known action and rollout stage`);
    }
  });
  return Object.freeze({
    schema: String(snapshot['schema']),
    evidenceSchemaVersion: String(snapshot['evidenceSchemaVersion']),
    analysisVersion: String(snapshot['analysisVersion']),
    paperPolicyVersion: String(snapshot['paperPolicyVersion']),
    provider,
    cadenceMs: storedPositive(snapshot['cadenceMs'], 'cadenceMs'),
    window: Object.freeze({
      minimumPasses: storedPositive(window['minimumPasses'], 'window.minimumPasses'),
      minimumPassSpacingMs: storedPositive(window['minimumPassSpacingMs'], 'window.minimumPassSpacingMs'),
      minimumCertificationSpanMs: storedPositive(window['minimumCertificationSpanMs'], 'window.minimumCertificationSpanMs'),
    }),
    timing: Object.freeze({
      readCandidateMs: storedPositive(timing['readCandidateMs'], 'timing.readCandidateMs'),
      passCandidateMs: storedPositive(timing['passCandidateMs'], 'timing.passCandidateMs'),
      interReadGapCandidateMs: storedPositive(timing['interReadGapCandidateMs'], 'timing.interReadGapCandidateMs'),
      hardReadTimeoutMs: storedPositive(timing['hardReadTimeoutMs'], 'timing.hardReadTimeoutMs'),
      hardPassDurationMs: storedPositive(timing['hardPassDurationMs'], 'timing.hardPassDurationMs'),
    }),
    paperIntents: Object.freeze(paperIntents),
    calibrationReview,
    digest: expectedDigest,
  });
}
