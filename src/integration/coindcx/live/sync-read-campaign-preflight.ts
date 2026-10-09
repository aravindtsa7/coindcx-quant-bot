/**
 * M4 (unwired review candidate): preflight for a bounded, read-only synchronization collection campaign
 * (docs/M4_READ_ONLY_CAMPAIGN_PLAN.md, docs/M4_READ_ONLY_CAMPAIGN_LAUNCH_CHECKLIST.md). Pure: it checks an explicit
 * configuration and a runtime status snapshot, performs no I/O, and has no defaults. No value here is approved.
 *
 * It reports two lists separately:
 *   - blockers: the read-only collection must not start;
 *   - limitations: collection may start, but the result cannot converge (PREVENTS_CONVERGENCE) or cannot support
 *     milestone acceptance (PREVENTS_MILESTONE_ACCEPTANCE).
 *
 * Decisions. D4c and AS1 stay pending. Configuration cannot record them as made (any other value is a blocker), and
 * no collection output can make them. Exclusive account use is never attested here.
 *
 * Scope. Unsupported required components stay in the scope and visible: TRANSACTIONS is CLIENT_ADAPTER_UNSUPPORTED,
 * which prevents convergence of any scope that requires it. A run without TRANSACTIONS is labelled as exactly the
 * components it reads, never as full account synchronization.
 *
 * Limiter. The budget section is checked against the existing limiter constraints: a valid limiter configuration, a
 * known priority class, the authenticated scope, an admission deadline within the limiter's request-deadline cap, and
 * a campaign share within the class ceiling. The worst-case request count is compared with the declared share.
 */
import { PRIORITY_CLASSES, validateRateLimiterConfig, type PriorityClass } from '../rate-limit/config';
import {
  GRANTS_NOTHING,
  isValidSynchronizationConfig,
  type ObservationComponent,
  type SynchronizationConfig,
  type SyncHistoryScope,
  type SyncLineageInput,
  type SyncScanLimits,
} from '../../../execution/live/practical-synchronization/engine';

export { GRANTS_NOTHING };

/** The same representation as the provider account fingerprint (lowercase 64-hex SHA-256). */
export const SYNC_CAMPAIGN_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

const COMPONENTS: readonly ObservationComponent[] = Object.freeze(['ORDERS', 'POSITIONS', 'TRANSACTIONS']);
/** Components the client read adapter supports; the rest are CLIENT_ADAPTER_UNSUPPORTED. */
export const SYNC_CAMPAIGN_SUPPORTED_COMPONENTS: readonly ObservationComponent[] = Object.freeze(['ORDERS', 'POSITIONS']);
/** Requests per page read: orders are read once per side. */
const SEGMENTS_PER_COMPONENT: Readonly<Record<ObservationComponent, number>> = Object.freeze({ ORDERS: 2, POSITIONS: 1, TRANSACTIONS: 0 });
const ACCOUNTING = Object.freeze(['COMPLETE_FILL_RECONSTRUCTION', 'EXACTLY_ONCE_EXECUTION_ACCOUNTING', 'FEE_ACCOUNTING']);

export interface SyncReadCampaignConfig {
  readonly account: Readonly<{ accountId: string; expectedProviderAccountFingerprint: string }>;
  readonly scope: Readonly<{
    mode: 'FULL_EVIDENCE' | 'CUMULATIVE_STATE';
    components: readonly ObservationComponent[];
    requiredAccounting: readonly string[];
    history: SyncHistoryScope;
    orderStatuses: readonly string[];
  }>;
  /** What is assumed about other activity on the account. Never attested here. */
  readonly accountScope: Readonly<{ assumption: 'EXCLUSIVE_USE_DECLARED_UNATTESTED' | 'SHARED_USE_POSSIBLE' | 'UNKNOWN'; attestation: 'NONE' }>;
  readonly decisions: Readonly<{ d4c: 'PENDING'; as1: 'PENDING' }>;
  /** Declared composition parameters of the injected client's shared read budget (they must match its construction). */
  readonly budget: Readonly<{
    connectionId: string;
    kind: 'SHARED_COORDINATOR_READ_BUDGET';
    scope: 'API_AUTH';
    priorityClass: PriorityClass;
    admissionDeadlineMs: number;
    transportRequestTimeoutMs: number;
    limiter: unknown;
    campaignShare: Readonly<{ maxStartsPerFairnessWindow: number }> | 'UNASSIGNED';
  }>;
  readonly scanLimits: Readonly<Partial<Record<ObservationComponent, SyncScanLimits>>>;
  readonly timeouts: Readonly<{ identityReadTimeoutMs: number; readTimeoutMs: number; streamTimeoutMs: number }>;
  readonly maxCycles: number;
  readonly thresholds: Readonly<{ maxEvidenceAgeMs: number; maxTotalReadDurationMs: number }>;
  readonly campaign: Readonly<{ durationMs: number; evaluationIntervalMs: number; maxEvaluations: number; maxConsecutiveFailedReadEvaluations: number }>;
  /** Durable lineage, supplied explicitly (this candidate reads no repository). */
  readonly lineage: SyncLineageInput;
  /** Provider contracts: only the fail-closed state is accepted; no recorded provider answer confirms any of them. */
  readonly contracts: 'ALL_UNCONFIRMED';
  readonly reportDestination: Readonly<{ kind: 'LOCAL_FILE'; path: string }>;
}

/** Runtime facts the preflight needs; supplied by the caller, never read here. */
export type SyncReadCampaignRuntimeStatus = Readonly<{
  /** Supplied by the composition that constructed this client; never inferred from the requested account. */
  authenticatedClient: Readonly<{ kind: 'CREDENTIAL_BOUND'; accountId: string; budgetConnectionId: string }> | null;
  coordinator: Readonly<{ connected: boolean; localStop: boolean; coordinatorStop: string }> | null;
  stream: 'INJECTED' | 'NOT_CONFIGURED';
  reportSink: boolean;
}>;

export type SyncCampaignLimitationEffect = 'PREVENTS_CONVERGENCE' | 'PREVENTS_MILESTONE_ACCEPTANCE';
export type SyncCampaignBlocker = Readonly<{ code: string; detail?: string }>;
export type SyncCampaignLimitation = Readonly<{ code: string; effect: SyncCampaignLimitationEffect; detail?: string }>;
export type SyncCampaignScopeLabel =
  | 'ORDERS_AND_POSITIONS_ONLY_NOT_FULL_ACCOUNT_SYNCHRONIZATION'
  | 'ORDERS_ONLY_NOT_FULL_ACCOUNT_SYNCHRONIZATION'
  | 'POSITIONS_ONLY_NOT_FULL_ACCOUNT_SYNCHRONIZATION'
  | 'DECLARED_SCOPE_INCLUDES_CLIENT_ADAPTER_UNSUPPORTED_COMPONENT'
  | 'INVALID_SCOPE';

export const SYNC_CAMPAIGN_DECISIONS = Object.freeze({ D4c: 'PENDING_NOT_DECIDED_BY_COLLECTION' as const, AS1: 'PENDING_NOT_DECIDED_BY_COLLECTION' as const });

/** What the runner needs once the preflight allows collection. */
export type SyncReadCampaignPlan = Readonly<{
  synchronization: SynchronizationConfig;
  orchestration: Readonly<{ readTimeoutMs: number; streamTimeoutMs: number }>;
  identityReadTimeoutMs: number;
  orderStatuses: readonly string[];
  campaign: SyncReadCampaignConfig['campaign'];
  account: SyncReadCampaignConfig['account'];
  reportDestination: SyncReadCampaignConfig['reportDestination'];
  worstCaseRequestsPerEvaluation: number;
}>;

export type SyncReadCampaignPreflight = Readonly<{
  kind: 'SYNC_READ_CAMPAIGN_PREFLIGHT';
  startable: boolean;
  blockers: readonly SyncCampaignBlocker[];
  limitations: readonly SyncCampaignLimitation[];
  scopeLabel: SyncCampaignScopeLabel;
  declaredComponents: readonly string[];
  unsupportedRequiredComponents: readonly Readonly<{ component: string; support: 'CLIENT_ADAPTER_UNSUPPORTED' }>[];
  fullAccountSynchronization: 'NOT_CLAIMED';
  decisions: typeof SYNC_CAMPAIGN_DECISIONS;
  plan: SyncReadCampaignPlan | null;
  grants: typeof GRANTS_NOTHING;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function scopeLabelOf(components: readonly string[] | null): SyncCampaignScopeLabel {
  if (components === null || components.length === 0) return 'INVALID_SCOPE';
  if (components.some((component) => !SYNC_CAMPAIGN_SUPPORTED_COMPONENTS.includes(component as ObservationComponent))) return 'DECLARED_SCOPE_INCLUDES_CLIENT_ADAPTER_UNSUPPORTED_COMPONENT';
  if (components.includes('ORDERS') && components.includes('POSITIONS')) return 'ORDERS_AND_POSITIONS_ONLY_NOT_FULL_ACCOUNT_SYNCHRONIZATION';
  return components.includes('ORDERS') ? 'ORDERS_ONLY_NOT_FULL_ACCOUNT_SYNCHRONIZATION' : 'POSITIONS_ONLY_NOT_FULL_ACCOUNT_SYNCHRONIZATION';
}


/** Collects blockers and limitations for one preflight. */
class Findings {
  public readonly blockers: SyncCampaignBlocker[] = [];
  public readonly limitations: SyncCampaignLimitation[] = [];
  public block(code: string, detail?: string): void { this.blockers.push(Object.freeze(detail === undefined ? { code } : { code, detail })); }
  public limit(code: string, effect: SyncCampaignLimitationEffect, detail?: string): void {
    this.limitations.push(Object.freeze(detail === undefined ? { code, effect } : { code, effect, detail }));
  }
  /** A required configuration section, or an empty record (and a blocker) when it is missing. */
  public section(config: Record<string, unknown>, name: string): Record<string, unknown> {
    const value = config[name];
    if (isRecord(value)) return value;
    this.block('CONFIG_MISSING', name);
    return {};
  }
}

function checkAccountAndScope(config: Record<string, unknown>, f: Findings): { components: string[] | null; declared: ObservationComponent[]; unsupported: string[] } {
  const account = f.section(config, 'account');
  if (!isNonEmpty(account['accountId'])) f.block('CONFIG_MISSING', 'account.accountId');
  const fingerprint = account['expectedProviderAccountFingerprint'];
  if (!(typeof fingerprint === 'string' && SYNC_CAMPAIGN_FINGERPRINT_PATTERN.test(fingerprint))) f.block('EXPECTED_ACCOUNT_FINGERPRINT_INVALID');

  const scope = f.section(config, 'scope');
  const raw = scope['components'];
  const components = Array.isArray(raw) && raw.every((entry) => typeof entry === 'string') ? raw as string[] : null;
  if (components === null || components.length === 0) f.block('CONFIG_MISSING', 'scope.components');
  else {
    if (new Set(components).size !== components.length) f.block('SCOPE_COMPONENTS_DUPLICATED');
    for (const component of components.filter((entry) => !COMPONENTS.includes(entry as ObservationComponent))) f.block('SCOPE_COMPONENT_UNKNOWN', component);
  }
  if (scope['mode'] !== 'FULL_EVIDENCE' && scope['mode'] !== 'CUMULATIVE_STATE') f.block('CONFIG_MISSING', 'scope.mode');
  const accounting = scope['requiredAccounting'];
  if (!Array.isArray(accounting) || !accounting.every((entry) => ACCOUNTING.includes(entry as string))) f.block('CONFIG_MISSING', 'scope.requiredAccounting');
  else if (accounting.length > 0) f.limit('REQUIRED_ACCOUNTING_DECLARED', 'PREVENTS_CONVERGENCE', accounting.join(','));
  const history = scope['history'];
  if (!isRecord(history) || (history['kind'] !== 'AVAILABLE_HISTORY' && history['kind'] !== 'DECLARED_WINDOW')) f.block('CONFIG_MISSING', 'scope.history');
  else if (history['kind'] === 'DECLARED_WINDOW') f.limit('DATE_FILTER_UNSUPPORTED_BY_ENDPOINTS_WINDOW_FLAGGED_NOT_APPLIED', 'PREVENTS_MILESTONE_ACCEPTANCE');
  const statuses = scope['orderStatuses'];
  if (!(Array.isArray(statuses) && statuses.length > 0 && statuses.every((status) => typeof status === 'string' && /^[a-z_]+$/.test(status)))) {
    f.block('CONFIG_MISSING', 'scope.orderStatuses');
  }

  const declared = (components ?? []).filter((component) => COMPONENTS.includes(component as ObservationComponent)) as ObservationComponent[];
  // Unsupported required components stay in the scope and visible; they are never dropped.
  const unsupported = declared.filter((component) => !SYNC_CAMPAIGN_SUPPORTED_COMPONENTS.includes(component));
  for (const component of unsupported) f.limit('REQUIRED_COMPONENT_CLIENT_ADAPTER_UNSUPPORTED', 'PREVENTS_CONVERGENCE', component);
  const label = scopeLabelOf(components);
  if (label.endsWith('_NOT_FULL_ACCOUNT_SYNCHRONIZATION')) f.limit('SCOPE_EXCLUDES_TRANSACTIONS_NOT_FULL_ACCOUNT_SYNCHRONIZATION', 'PREVENTS_MILESTONE_ACCEPTANCE', label);
  return { components, declared, unsupported };
}

/** Account scope and decisions: configuration can neither attest exclusive use nor record D4c or AS1 as decided. */
function checkDecisions(config: Record<string, unknown>, f: Findings): void {
  const accountScope = f.section(config, 'accountScope');
  if (!['EXCLUSIVE_USE_DECLARED_UNATTESTED', 'SHARED_USE_POSSIBLE', 'UNKNOWN'].includes(accountScope['assumption'] as string)) f.block('CONFIG_MISSING', 'accountScope.assumption');
  if (accountScope['attestation'] !== 'NONE') f.block('ACCOUNT_SCOPE_ATTESTATION_NOT_ACCEPTED_FROM_CONFIGURATION');
  f.limit('EXCLUSIVE_ACCOUNT_USE_NOT_ATTESTED_NOT_ESTABLISHABLE_BY_PASSIVE_READS', 'PREVENTS_MILESTONE_ACCEPTANCE');
  const decisions = f.section(config, 'decisions');
  if (decisions['d4c'] !== 'PENDING') f.block('DECISION_STATE_NOT_ACCEPTED_FROM_CONFIGURATION', 'd4c');
  if (decisions['as1'] !== 'PENDING') f.block('DECISION_STATE_NOT_ACCEPTED_FROM_CONFIGURATION', 'as1');
  f.limit('D4C_PENDING', 'PREVENTS_MILESTONE_ACCEPTANCE');
  f.limit('AS1_PENDING', 'PREVENTS_MILESTONE_ACCEPTANCE');
}

/** The shared read budget against the existing limiter constraints. Returns the per-request bound and declared share. */
function checkBudget(config: Record<string, unknown>, f: Findings): { perRequestMs: number | null; shareStarts: number | null } {
  const budget = f.section(config, 'budget');
  if (!isNonEmpty(budget['connectionId'])) f.block('CONFIG_MISSING', 'budget.connectionId');
  if (budget['kind'] !== 'SHARED_COORDINATOR_READ_BUDGET') f.block('CONFIG_MISSING', 'budget.kind');
  if (budget['scope'] !== 'API_AUTH') f.block('BUDGET_SCOPE_NOT_AUTHENTICATED_READ_SCOPE');
  const priorityClass = PRIORITY_CLASSES.includes(budget['priorityClass'] as PriorityClass) ? budget['priorityClass'] as PriorityClass : null;
  if (priorityClass === null) f.block('BUDGET_PRIORITY_CLASS_INVALID');
  const limiter = validateRateLimiterConfig(budget['limiter']);
  if (limiter.kind !== 'VALID') f.block('LIMITER_CONFIG_INVALID', limiter.reason);
  const deadline = budget['admissionDeadlineMs'];
  const timeout = budget['transportRequestTimeoutMs'];
  if (!isPositive(deadline)) f.block('CONFIG_MISSING', 'budget.admissionDeadlineMs');
  else if (limiter.kind === 'VALID' && deadline > limiter.config.maxRequestDeadlineMs) f.block('ADMISSION_DEADLINE_EXCEEDS_LIMITER_REQUEST_DEADLINE_CAP');
  if (!isPositive(timeout)) f.block('CONFIG_MISSING', 'budget.transportRequestTimeoutMs');
  const share = budget['campaignShare'];
  let shareStarts: number | null = null;
  if (share === 'UNASSIGNED') f.block('CAMPAIGN_BUDGET_SHARE_UNASSIGNED');
  else if (!isRecord(share) || !isPositive(share['maxStartsPerFairnessWindow'])) f.block('CONFIG_MISSING', 'budget.campaignShare');
  else {
    shareStarts = share['maxStartsPerFairnessWindow'];
    if (limiter.kind === 'VALID' && priorityClass !== null && shareStarts > limiter.config.classShares[priorityClass].maxPerWindow) f.block('CAMPAIGN_SHARE_EXCEEDS_CLASS_CEILING');
    f.limit('CAMPAIGN_SHARE_DECLARED_NOT_ENFORCED_BY_COORDINATOR', 'PREVENTS_MILESTONE_ACCEPTANCE');
  }
  f.limit('PRODUCTION_READ_BUDGET_BINDING_ABSENT', 'PREVENTS_MILESTONE_ACCEPTANCE');
  return { perRequestMs: isPositive(deadline) && isPositive(timeout) ? deadline + timeout : null, shareStarts };
}

function checkRuntime(config: Record<string, unknown>, runtime: SyncReadCampaignRuntimeStatus, f: Findings): void {
  const provenance = runtime.authenticatedClient;
  if (!isRecord(provenance) || provenance.kind !== 'CREDENTIAL_BOUND' || !isNonEmpty(provenance.accountId) || !isNonEmpty(provenance.budgetConnectionId)) {
    f.block('AUTHENTICATED_CLIENT_PROVENANCE_UNKNOWN');
  } else {
    if (!isRecord(config['account']) || provenance.accountId !== config['account']['accountId']) f.block('AUTHENTICATED_CLIENT_ACCOUNT_MISMATCH');
    if (!isRecord(config['budget']) || provenance.budgetConnectionId !== config['budget']['connectionId']) f.block('AUTHENTICATED_CLIENT_BUDGET_CONNECTION_MISMATCH');
  }
  const coordinator = runtime.coordinator;
  if (coordinator === null) f.block('BUDGET_COORDINATOR_NOT_CONFIGURED');
  else {
    if (coordinator.connected !== true) f.block('BUDGET_COORDINATOR_NOT_CONNECTED');
    if (coordinator.localStop !== false || coordinator.coordinatorStop !== 'NONE') f.block('BUDGET_COORDINATOR_STOP_ACTIVE');
  }
  // A missing stream observation stays UNKNOWN: it is never synthesized as a quiet stream.
  if (runtime.stream !== 'INJECTED') f.limit('PRIVATE_STREAM_OBSERVATION_NOT_CONFIGURED_EVERY_CYCLE_REVOKES', 'PREVENTS_CONVERGENCE');
  if (!runtime.reportSink) f.block('REPORT_SINK_NOT_CONFIGURED');
}

/** Bounds, timeouts and schedule; the worst-case request count against the share and the scan bounds against the timeouts. */
function checkBounds(config: Record<string, unknown>, declared: readonly ObservationComponent[], budget: { perRequestMs: number | null; shareStarts: number | null }, f: Findings): number {
  const scanLimits = isRecord(config['scanLimits']) ? config['scanLimits'] : null;
  if (scanLimits === null) f.block('CONFIG_MISSING', 'scanLimits');
  const limits = new Map<ObservationComponent, SyncScanLimits>();
  for (const component of declared) {
    const entry = scanLimits?.[component];
    if (isRecord(entry) && isPositive(entry['pageSize']) && isPositive(entry['maxPages'])) limits.set(component, { pageSize: entry['pageSize'], maxPages: entry['maxPages'] });
    else f.block('CONFIG_MISSING', `scanLimits.${component}`);
  }
  const timeouts = f.section(config, 'timeouts');
  for (const key of ['identityReadTimeoutMs', 'readTimeoutMs', 'streamTimeoutMs']) if (!isPositive(timeouts[key])) f.block('CONFIG_MISSING', `timeouts.${key}`);
  const maxCycles = config['maxCycles'];
  if (!isPositive(maxCycles)) f.block('CONFIG_MISSING', 'maxCycles');
  const thresholds = f.section(config, 'thresholds');
  for (const key of ['maxEvidenceAgeMs', 'maxTotalReadDurationMs']) if (!isPositive(thresholds[key])) f.block('CONFIG_MISSING', `thresholds.${key}`);
  const campaign = f.section(config, 'campaign');
  for (const key of ['durationMs', 'evaluationIntervalMs', 'maxEvaluations', 'maxConsecutiveFailedReadEvaluations']) if (!isPositive(campaign[key])) f.block('CONFIG_MISSING', `campaign.${key}`);
  f.limit('ACCEPTANCE_CRITERIA_AND_VALUES_NOT_APPROVED', 'PREVENTS_MILESTONE_ACCEPTANCE');
  f.limit('PROVIDER_PAGE_SIZE_CAP_UNVERIFIED', 'PREVENTS_MILESTONE_ACCEPTANCE');
  f.limit('HISTORY_COMPLETENESS_UNPROVABLE_BY_PASSIVE_READS', 'PREVENTS_MILESTONE_ACCEPTANCE');

  const { perRequestMs, shareStarts } = budget;
  if (perRequestMs !== null && isPositive(timeouts['identityReadTimeoutMs']) && timeouts['identityReadTimeoutMs'] < perRequestMs) {
    f.limit('IDENTITY_READ_TIMEOUT_BELOW_WORST_CASE_REQUEST', 'PREVENTS_CONVERGENCE');
  }
  if (limits.size !== declared.length || !isPositive(maxCycles)) return 0;
  // One identity read, then per cycle two passes over every page of every segment.
  const perPass = declared.reduce((sum, component) => sum + SEGMENTS_PER_COMPONENT[component] * limits.get(component)!.maxPages, 0);
  const worstCase = 1 + maxCycles * 2 * perPass;
  if (!Number.isSafeInteger(worstCase)) f.block('REQUEST_BOUND_NOT_SAFE_INTEGER');
  if (shareStarts !== null && worstCase > shareStarts) f.limit('WORST_CASE_EVALUATION_REQUESTS_EXCEED_CAMPAIGN_SHARE', 'PREVENTS_CONVERGENCE', `${worstCase}>${shareStarts}`);
  const readTimeoutMs = timeouts['readTimeoutMs'];
  if (perRequestMs !== null && isPositive(readTimeoutMs)) {
    for (const component of declared.filter((entry) => SEGMENTS_PER_COMPONENT[entry] > 0)) {
      if (readTimeoutMs < SEGMENTS_PER_COMPONENT[component] * limits.get(component)!.maxPages * perRequestMs) f.limit('READ_TIMEOUT_BELOW_WORST_CASE_SCAN', 'PREVENTS_CONVERGENCE', component);
    }
  }
  return worstCase;
}

function checkInputsAndDestination(config: Record<string, unknown>, f: Findings): void {
  const lineage = config['lineage'];
  if (!isRecord(lineage)) f.block('CONFIG_MISSING', 'lineage');
  else if ('kind' in lineage) {
    if (lineage['kind'] === 'UNAVAILABLE' && isNonEmpty(lineage['reason']) && Object.keys(lineage).every(key => ['kind', 'reason'].includes(key))) f.limit('OWNERSHIP_LINEAGE_UNAVAILABLE', 'PREVENTS_CONVERGENCE');
    else f.block('LINEAGE_INVALID');
  }
  else {
    const listOf = (value: unknown, valid: (entry: unknown) => boolean): boolean => Array.isArray(value) && value.every(valid);
    const nullableString = (value: unknown): boolean => value === null || isNonEmpty(value);
    if (!isNonEmpty(lineage['botTagNamespace'])
      || !listOf(lineage['ownedOrders'], entry => isRecord(entry) && isNonEmpty(entry['exchangeOrderId']) && isNonEmpty(entry['intentId']))
      || !listOf(lineage['ownedPositions'], isNonEmpty) || !listOf(lineage['closedIntentTags'], isNonEmpty)
      || !listOf(lineage['ambiguousCreates'], entry => isRecord(entry)
        && ['intentId', 'accountId', 'tag', 'pair', 'orderedQuantity', 'wireOrderType'].every(key => isNonEmpty(entry[key]))
        && (entry['side'] === 'BUY' || entry['side'] === 'SELL') && nullableString(entry['price']) && nullableString(entry['leverage']))) f.block('LINEAGE_INVALID');
  }
  f.limit('DURABLE_LINEAGE_FROM_EXPLICIT_INPUT_NOT_READ_FROM_REPOSITORY', 'PREVENTS_MILESTONE_ACCEPTANCE');
  if (config['contracts'] !== 'ALL_UNCONFIRMED') f.block('PROVIDER_CONTRACT_CONFIRMATION_NOT_ACCEPTED_FROM_CONFIGURATION');
  f.limit('PROVIDER_CONTRACTS_UNCONFIRMED', 'PREVENTS_MILESTONE_ACCEPTANCE');
  const destination = f.section(config, 'reportDestination');
  const target = destination['path'];
  if (destination['kind'] !== 'LOCAL_FILE' || typeof target !== 'string' || !/^([A-Za-z]:[\\/]|\/)/.test(target) || !target.endsWith('.json')
    || /(^|[\\/])\.\.([\\/]|$)/.test(target)) f.block('REPORT_DESTINATION_INVALID');
}

/** The orchestration configuration, with every provider contract in its fail-closed state. Null if the engine rejects it. */
function planOf(cfg: SyncReadCampaignConfig, worstCase: number): SyncReadCampaignPlan | null {
  const synchronization: SynchronizationConfig = {
    mode: cfg.scope.mode,
    scope: { accountId: cfg.account.accountId, components: [...cfg.scope.components],
      requiredAccounting: [...cfg.scope.requiredAccounting] as SynchronizationConfig['scope']['requiredAccounting'], history: { ...cfg.scope.history } },
    scanLimits: Object.fromEntries(cfg.scope.components.map(component => [component, { ...cfg.scanLimits[component]! }])),
    thresholds: { maxEvidenceAgeMs: cfg.thresholds.maxEvidenceAgeMs, maxTotalReadDurationMs: cfg.thresholds.maxTotalReadDurationMs },
    maxCycles: cfg.maxCycles,
    lineage: structuredClone(cfg.lineage),
    contracts: { tagContract: { confirmed: false }, venueGeneratedOrderTypes: null, venueGeneratedWalletStages: null, terminalShortPage: {} },
  };
  if (!isValidSynchronizationConfig(synchronization)) return null;
  return Object.freeze({
    synchronization,
    orchestration: Object.freeze({ readTimeoutMs: cfg.timeouts.readTimeoutMs, streamTimeoutMs: cfg.timeouts.streamTimeoutMs }),
    identityReadTimeoutMs: cfg.timeouts.identityReadTimeoutMs,
    orderStatuses: Object.freeze([...cfg.scope.orderStatuses]),
    campaign: Object.freeze({ ...cfg.campaign }),
    account: Object.freeze({ ...cfg.account }),
    reportDestination: Object.freeze({ ...cfg.reportDestination }),
    worstCaseRequestsPerEvaluation: worstCase,
  });
}

/** Checks the configuration and runtime status. Blockers and limitations are reported separately; nothing is defaulted. */
export function preflightSyncReadCampaign(input: unknown, runtime: SyncReadCampaignRuntimeStatus): SyncReadCampaignPreflight {
  const f = new Findings();
  const config = isRecord(input) ? input : {};
  const { components, declared, unsupported } = checkAccountAndScope(config, f);
  checkDecisions(config, f);
  const budget = checkBudget(config, f);
  checkRuntime(config, runtime, f);
  const worstCase = checkBounds(config, declared, budget, f);
  checkInputsAndDestination(config, f);
  let plan: SyncReadCampaignPlan | null = null;
  if (f.blockers.length === 0) {
    try { plan = planOf(config as unknown as SyncReadCampaignConfig, worstCase); } catch { plan = null; }
    if (plan === null) f.block('SYNCHRONIZATION_CONFIG_INVALID');
  }
  return Object.freeze({
    kind: 'SYNC_READ_CAMPAIGN_PREFLIGHT' as const,
    startable: f.blockers.length === 0 && plan !== null,
    blockers: Object.freeze([...f.blockers]),
    limitations: Object.freeze([...f.limitations]),
    scopeLabel: scopeLabelOf(components),
    declaredComponents: Object.freeze([...(components ?? [])]),
    unsupportedRequiredComponents: Object.freeze(unsupported.map((component) => Object.freeze({ component, support: 'CLIENT_ADAPTER_UNSUPPORTED' as const }))),
    fullAccountSynchronization: 'NOT_CLAIMED' as const,
    decisions: SYNC_CAMPAIGN_DECISIONS,
    plan,
    grants: GRANTS_NOTHING,
  });
}
