/** One unapproved information-collection proposal; pure validation, never contact or credential loading. */
import { z } from 'zod';
import { validateRateLimiterConfig } from '../../src/integration/coindcx/rate-limit/config';
import { ListInrOrdersRequestSchema, ListInrPositionsRequestSchema } from '../../src/integration/coindcx/schemas';
import { preflightSyncReadCampaign } from '../../src/integration/coindcx/live/sync-read-campaign-preflight';
import { runSyncReadCampaign, type SyncReadCampaignDependencies } from '../../src/integration/coindcx/live/sync-read-campaign';

const positive = z.number().int().positive().refine(Number.isSafeInteger);
const bounds = z.object({ pageSize: positive, maxPages: positive }).strict();
export const LaunchProposalSchema = z.object({
  proposalId: z.string().min(1), valuesStatus: z.literal('PROPOSED_NOT_APPROVED'),
  purpose: z.literal('ORDERS_POSITIONS_ONLY_INFORMATION_COLLECTION'),
  providerOrigin: z.literal('https://api.coindcx.com'), stream: z.literal('NOT_CONFIGURED'),
  configuration: z.object({
    account: z.object({ accountId: z.string().min(1).nullable(), expectedProviderAccountFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable() }).strict(),
    scope: z.object({ mode: z.literal('CUMULATIVE_STATE'), components: z.tuple([z.literal('ORDERS'), z.literal('POSITIONS')]),
      requiredAccounting: z.tuple([]), history: z.object({ kind: z.literal('AVAILABLE_HISTORY') }).strict(), orderStatuses: z.array(z.string()).nonempty() }).strict(),
    accountScope: z.object({ assumption: z.enum(['UNKNOWN', 'SHARED_USE_POSSIBLE']), attestation: z.literal('NONE') }).strict(),
    decisions: z.object({ d4c: z.literal('PENDING'), as1: z.literal('PENDING') }).strict(),
    budget: z.object({ connectionId: z.string().min(1).nullable(), kind: z.literal('SHARED_COORDINATOR_READ_BUDGET'), scope: z.literal('API_AUTH'),
      priorityClass: z.literal('P1'), admissionDeadlineMs: positive, transportRequestTimeoutMs: positive, limiter: z.unknown(),
      campaignShare: z.object({ maxStartsPerFairnessWindow: positive }).strict() }).strict(),
    scanLimits: z.object({ ORDERS: bounds, POSITIONS: bounds }).strict(),
    timeouts: z.object({ identityReadTimeoutMs: positive, readTimeoutMs: positive, streamTimeoutMs: positive }).strict(), maxCycles: positive,
    thresholds: z.object({ maxEvidenceAgeMs: positive, maxTotalReadDurationMs: positive }).strict(),
    campaign: z.object({ durationMs: positive, evaluationIntervalMs: positive, maxEvaluations: positive, maxConsecutiveFailedReadEvaluations: positive }).strict(),
    lineage: z.unknown(), contracts: z.literal('ALL_UNCONFIRMED'),
    reportDestination: z.object({ kind: z.literal('LOCAL_FILE'), path: z.string().regex(/^([A-Za-z]:[\\/]|\/)/).endsWith('.json') }).strict(),
  }).strict(),
}).strict();
export type LaunchProposal = z.infer<typeof LaunchProposalSchema>;
export type LaunchBlocker = { kind: 'REQUIRED_INPUT' | 'MISSING_IMPLEMENTATION' | 'AUTHORIZATION'; code: string; required: string };

/** These are real-launch blockers, never discharged by test initialization or a fixture capability declaration. */
export const REAL_LAUNCH_REQUIREMENTS: readonly LaunchBlocker[] = Object.freeze([
  { kind: 'REQUIRED_INPUT', code: 'ACCOUNT_BINDING_REQUIRED', required: 'account.accountId and independently established expectedProviderAccountFingerprint; no old fingerprint assumed fresh' },
  { kind: 'REQUIRED_INPUT', code: 'LINEAGE_AVAILABILITY_REQUIRED', required: 'explicit supplied durable lineage with source/date, or UNAVAILABLE with reason; unavailable ownership stays unresolved and prevents convergence; account identity is not ownership' },
  { kind: 'REQUIRED_INPUT', code: 'CLIENT_AND_COORDINATOR_PROVENANCE_REQUIRED', required: 'actual credential-bound client and shared connectionId, same limiter/policy/transport timeout, authenticated scope, connected not-stopped status' },
  { kind: 'REQUIRED_INPUT', code: 'PROVIDER_INVOCATION_REVIEW_REQUIRED', required: 'review the explicit run-provider bootstrap entry, closed endpoint boundary and campaign-only environment loader; default collect CLI remains hard-blocked' },
  { kind: 'REQUIRED_INPUT', code: 'CAMPAIGN_STATE_LIFECYCLE_REVIEW_REQUIRED', required: 'review explicit NEW_READ_ONLY_CAMPAIGN namespace/installation, configuration binding, ownership, conservative restore and storage guarantees; no production installation initialized or approved' },
  { kind: 'REQUIRED_INPUT', code: 'HOST_SECURITY_AND_SUPERVISION_REVIEW_REQUIRED', required: 'review actual supervisor/operator key custody, OS ownership, restricted pipe/state/report access and aggregate budget allocation; campaign capabilities authenticate READ versus STOP-only, but no Windows ACL enforcement, remote exclusion or process identity proof is claimed' },
  { kind: 'REQUIRED_INPUT', code: 'REPORT_DESTINATION_ACCESS_REQUIRED', required: 'operator-approved writable destination and verified owner/ACL; sink must refuse overwrite, flush and record delivery failures' },
  { kind: 'AUTHORIZATION', code: 'VALUES_AND_REAL_COLLECTION_NOT_AUTHORIZED', required: 'approval of this one proposal plus a separate real read-only authorization for the named account and scope; no execution/live authorization inferred' },
]);

export function inspectLaunchProposal(input: unknown) {
  const parsed = LaunchProposalSchema.safeParse(input);
  if (!parsed.success) return { proposal: null, parametersValid: false, configurationValid: false, readyToContactProvider: false as const,
    errors: parsed.error.issues.map(issue => `PROPOSAL_SHAPE:${issue.path.join('.')}`), blockers: REAL_LAUNCH_REQUIREMENTS };
  const proposal = parsed.data;
  const c = proposal.configuration;
  const errors: string[] = [];
  const limiter = validateRateLimiterConfig(c.budget.limiter);
  if (limiter.kind !== 'VALID') errors.push(`LIMITER_INVALID:${limiter.reason}`);
  for (const side of ['buy', 'sell'] as const) {
    if (!ListInrOrdersRequestSchema.safeParse({ side, status: c.scope.orderStatuses.join(','), page: '1', size: String(c.scanLimits.ORDERS.pageSize) }).success) errors.push(`ORDER_FILTER_INVALID:${side}`);
  }
  if (!ListInrPositionsRequestSchema.safeParse({ page: '1', size: String(c.scanLimits.POSITIONS.pageSize) }).success) errors.push('POSITION_FILTER_INVALID');
  const perPass = 2 * c.scanLimits.ORDERS.maxPages + c.scanLimits.POSITIONS.maxPages;
  const perEvaluation = 1 + c.maxCycles * 2 * perPass;
  const maximumRequests = c.campaign.maxEvaluations * perEvaluation;
  if (!Number.isSafeInteger(maximumRequests)) errors.push('REQUEST_COUNT_OVERFLOW');
  const perRequestMs = c.budget.admissionDeadlineMs + c.budget.transportRequestTimeoutMs;
  if (c.timeouts.identityReadTimeoutMs < perRequestMs) errors.push('IDENTITY_TIMEOUT_TOO_SHORT');
  if (c.timeouts.readTimeoutMs < Math.max(2 * c.scanLimits.ORDERS.maxPages, c.scanLimits.POSITIONS.maxPages) * perRequestMs) errors.push('SCAN_TIMEOUT_TOO_SHORT');
  if (perEvaluation > c.budget.campaignShare.maxStartsPerFairnessWindow) errors.push('EVALUATION_EXCEEDS_PROPOSED_SHARE');
  if (limiter.kind === 'VALID') {
    if (c.budget.admissionDeadlineMs > limiter.config.maxRequestDeadlineMs) errors.push('ADMISSION_DEADLINE_EXCEEDS_CAP');
    if (c.budget.campaignShare.maxStartsPerFairnessWindow > limiter.config.classShares.P1.maxPerWindow) errors.push('SHARE_EXCEEDS_CLASS_CEILING');
  }
  const preflight = preflightSyncReadCampaign(c, { authenticatedClient: null, coordinator: null, stream: 'NOT_CONFIGURED', reportSink: false });
  const runtimeOnly = ['AUTHENTICATED_CLIENT_PROVENANCE_UNKNOWN', 'BUDGET_COORDINATOR_NOT_CONFIGURED', 'REPORT_SINK_NOT_CONFIGURED'];
  const configBlockers = preflight.blockers.filter(entry => !runtimeOnly.includes(entry.code));
  // The literal proposal is incomplete when account/lineage/provenance are null; no synthetic stand-ins here.
  const unresolved = ['account.accountId', 'account.expectedProviderAccountFingerprint', 'budget.connectionId', 'lineage'].filter(dotted => {
    const [parent, field] = dotted.split('.');
    const value = c[parent as keyof typeof c];
    return field === undefined ? value === null || value === undefined : typeof value === 'object' && value !== null && (value as Record<string, unknown>)[field] === null;
  });
  return { proposal, parametersValid: errors.length === 0, configurationValid: errors.length === 0 && configBlockers.length === 0,
    readyToContactProvider: false as const, errors, limiterValidation: limiter.kind, orderFilterValidation: errors.some(error => error.startsWith('ORDER_FILTER')) ? 'INVALID' : 'VALID',
    requestBounds: { identityReads: c.campaign.maxEvaluations, pagesPerPass: perPass, passesPerCycle: 2, cyclesPerEvaluation: c.maxCycles, requestsPerEvaluation: perEvaluation, maximumRequests },
    unresolvedInputs: unresolved, preflight, blockers: REAL_LAUNCH_REQUIREMENTS };
}

/** Shared collection entry path. Production callers must supply independently reviewed real dependencies. */
export async function runPreparedCollection(proposal: LaunchProposal, deps: Omit<SyncReadCampaignDependencies, 'config'>) {
  const inspection = inspectLaunchProposal(proposal);
  if (!inspection.parametersValid || !inspection.configurationValid) throw new Error('LAUNCH_CONFIGURATION_INCOMPLETE_OR_INVALID');
  return runSyncReadCampaign({ ...deps, config: proposal.configuration });
}
