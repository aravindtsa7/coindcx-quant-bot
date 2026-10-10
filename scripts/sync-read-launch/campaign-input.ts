/** Pure invocation validation. No files, environment, secrets, initialization or network on import. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { inspectLaunchProposal, LaunchProposalSchema } from './proposal';

const text = z.string().min(1).refine(value => value.trim().length > 0), hash = z.string().regex(/^[0-9a-f]{64}$/), date = z.string().datetime({ offset: true });
const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('COINDCX_PROVIDER'), origin: z.literal('https://api.coindcx.com') }).strict(),
  z.object({ kind: z.literal('LOOPBACK_FIXTURE'), origin: text.refine(value => {
    try { const u = new URL(value); return u.protocol === 'http:' && u.hostname === '127.0.0.1' && Boolean(u.port) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash; } catch { return false; }
  }) }).strict(),
]);
export const CampaignInvocationSchema = z.object({
  kind: z.literal('COINDCX_READ_ONLY_CAMPAIGN_INPUT'), target, valuesStatus: z.literal('PROPOSED_NOT_APPROVED'), host: z.unknown(), proposal: LaunchProposalSchema,
  accountMapping: z.object({ accountId: text, expectedProviderAccountFingerprint: hash, sourceReference: text, verifiedAt: date,
    independentlyEstablished: z.literal(true) }).strict(),
  credentialProvenance: z.object({ accountId: text, sourceReference: text, establishedAt: date,
    sourceBinding: z.object({ kind: z.literal('protected-dpapi'), path: text, ciphertextSha256: hash }).strict().optional() }).strict(),
  lineageProvenance: z.discriminatedUnion('kind', [z.object({ kind: z.literal('UNAVAILABLE'), reason: text }).strict(),
    z.object({ kind: z.literal('SUPPLIED'), sourceReference: text, exportedAt: date }).strict()]),
  connectionBinding: z.literal('AUTHENTICATED_CAMPAIGN_SESSION_AT_START'),
  managedTraffic: z.object({ knownConsumers: z.array(z.object({ consumerId: text, coordinatorInstallationId: text,
    operations: z.literal('READ_P1_API_AUTH') }).strict()).nonempty(), externalTraffic: z.literal('UNKNOWN_NOT_CONTROLLED') }).strict(),
}).strict();
export type CampaignInvocation = z.infer<typeof CampaignInvocationSchema>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export const campaignDigest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
/** Bind all proposal fields except separately supplied account, lineage, destination and runtime session ID. */
export function campaignParameters(input: z.infer<typeof LaunchProposalSchema>): unknown {
  const { account: _account, lineage: _lineage, reportDestination: _destination, budget, ...configuration } = input.configuration;
  const { connectionId: _connection, ...policy } = budget;
  return { ...input, configuration: { ...configuration, budget: policy } };
}
export const PROPOSED_PARAMETERS_SHA256 = '61c257519c8aadbf5354a094e6f86f458ffc5eca08bff3912a5e4987b561d9c5';
/** Shared-use collection pin with corrected provider-stated block; client waits retained. Not a production default. */
export const SHARED_USE_PARAMETERS_SHA256 = 'c5274306c77b6336bc102a491e0de6c3bad74903211f57f2f4aa31616d808da5';

export function validateCampaignInvocation(input: unknown, nowMs: number): CampaignInvocation {
  const parsed = CampaignInvocationSchema.safeParse(input);
  if (!parsed.success) throw new Error('CAMPAIGN_INPUT_INVALID'); // Never echo operator input or validation payloads.
  const value = parsed.data, p = value.proposal, c = p.configuration, mapping = value.accountMapping;
  const inspection = inspectLaunchProposal(p);
  if (!inspection.parametersValid || inspection.requestBounds?.maximumRequests !== 39 || campaignDigest(campaignParameters(p)) !== (c.accountScope.assumption === 'SHARED_USE_POSSIBLE' ? SHARED_USE_PARAMETERS_SHA256 : PROPOSED_PARAMETERS_SHA256)) throw new Error('EXACT_39_REQUEST_PROPOSAL_REQUIRED');
  if (c.budget.connectionId !== null || value.connectionBinding !== 'AUTHENTICATED_CAMPAIGN_SESSION_AT_START') throw new Error('EXPLICIT_RUNTIME_SESSION_BINDING_REQUIRED');
  if (mapping.accountId !== c.account.accountId || mapping.expectedProviderAccountFingerprint !== c.account.expectedProviderAccountFingerprint
    || value.credentialProvenance.accountId !== mapping.accountId || Date.parse(mapping.verifiedAt) > nowMs || Date.parse(value.credentialProvenance.establishedAt) > nowMs) throw new Error('INDEPENDENT_ACCOUNT_MAPPING_REQUIRED');
  const lineage = value.lineageProvenance;
  if (lineage.kind === 'UNAVAILABLE' ? campaignDigest(c.lineage) !== campaignDigest(lineage)
    : c.lineage === null || typeof c.lineage !== 'object' || 'kind' in c.lineage || Date.parse(lineage.exportedAt) > nowMs) throw new Error('LINEAGE_INPUT_AND_PROVENANCE_MISMATCH');
  // Check complete runner configuration using a visibly local validation placeholder, never a connection assertion.
  if (!inspectLaunchProposal({ ...p, configuration: { ...c, budget: { ...c.budget, connectionId: 'VALIDATION_ONLY_NOT_A_CONNECTION' } } }).configurationValid) throw new Error('CAMPAIGN_RUNNER_CONFIGURATION_INVALID');
  return structuredClone(value);
}

const AuthorizationSchema = z.object({
  kind: z.literal('RECORDED_READ_ONLY_COLLECTION_AUTHORIZATION'), target: z.literal('COINDCX_PROVIDER'), authorizationId: text,
  authorizedBy: text, authorizedAt: date, expiresAt: date, invocationSha256: hash, accountId: text, expectedProviderAccountFingerprint: hash,
  scope: z.literal('ORDERS_POSITIONS_ONLY_INFORMATION_COLLECTION'), maximumRequests: z.literal(39), approvedProposalParametersSha256: hash,
  reviews: z.object({ hostSecurity: text, credentialCustody: text, supervisorAndStop: text, reportAccess: text,
    stateLifecycle: text, aggregateManagedBudget: text }).strict(),
  residualHostAssumptions: z.literal('EXPLICITLY_REVIEWED_NO_ACL_REMOTE_OR_PROCESS_IDENTITY_PROOF'),
}).strict();
/** Validates a separately supplied record, never creates one or proves its issuer/access-control authenticity. */
export function requireRecordedAuthorization(input: CampaignInvocation, record: unknown, nowMs: number): void {
  const parsed = AuthorizationSchema.safeParse(record);
  if (input.target.kind !== 'COINDCX_PROVIDER' || !parsed.success) throw new Error('RECORDED_PROVIDER_AUTHORIZATION_REQUIRED');
  const a = parsed.data;
  if (a.invocationSha256 !== campaignDigest(input) || a.accountId !== input.accountMapping.accountId
    || a.expectedProviderAccountFingerprint !== input.accountMapping.expectedProviderAccountFingerprint
    || a.approvedProposalParametersSha256 !== campaignDigest(campaignParameters(input.proposal)) || Date.parse(a.authorizedAt) > nowMs
    || Date.parse(a.expiresAt) <= nowMs || Date.parse(a.expiresAt) <= Date.parse(a.authorizedAt)) throw new Error('RECORDED_PROVIDER_AUTHORIZATION_MISMATCH_OR_EXPIRED');
}
