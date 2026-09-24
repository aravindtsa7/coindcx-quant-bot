/**
 * READ-ONLY CoinDCX provider probe: classification and report.
 *
 * Observation is not authorization. Every potential continuity primitive gets
 * exactly one classification from `ProbeClassification`. A field or header
 * NAME match is only ever a candidate observation; authoritative primitives
 * (account-wide ordering, provider replay) are never OBSERVED from a name
 * match or from a generic timestamp. The replay observation is a closed union
 * with no member meaning replay is proven, supported, or unsupported, and the
 * continuity conclusion is a fixed literal the probe cannot change. Nothing
 * here feeds Phase 18.
 */
import type { ProbeReadEndpoint } from './allowlist';
import type { CandidateFieldSummary, JsonKind, KeyPath, SanitizedHeader, TimestampFieldSummary, UserInfoObservation } from './sanitize';
import type { ProbeTiming } from './run';
import type { WsSessionObservation } from './ws-probe';

export type ProbeClassification = 'DOCUMENTED' | 'OBSERVED' | 'INFERRED' | 'NOT_OBSERVED' | 'UNKNOWN';

export type IdentityObservation =
  | 'ACCOUNT_IDENTITY_OBSERVED_STABLE_IN_THIS_RUN'
  | 'ACCOUNT_IDENTITY_OBSERVED_UNSTABLE_IN_THIS_RUN'
  | 'ACCOUNT_IDENTITY_NOT_OBSERVED';

/**
 * What this run saw around the reconnect, in neutral terms. Deliberately has no
 * member meaning replay is proven, supported, or unsupported: CoinDCX documents
 * no event-time, sequence, cursor, or replay contract, so no observation here
 * can settle the provider's replay capability either way.
 */
export const REPLAY_OBSERVATIONS = [
  'REPLAY_NOT_TESTABLE_IN_THIS_RUN',
  'NO_POST_RECONNECT_ACCOUNT_EVENT_OBSERVED_IN_BOUNDED_WINDOW',
  'POST_RECONNECT_ACCOUNT_EVENT_OBSERVED_RELATION_TO_GAP_UNDETERMINED',
] as const;
export type ReplayObservation = typeof REPLAY_OBSERVATIONS[number];

export const PROBE_CONTINUITY_CONCLUSION = 'PROBE_DOES_NOT_ESTABLISH_ACCOUNT_CONTINUITY' as const;
export const PROVIDER_GUARANTEE_DISCLAIMER = 'OBSERVED PROVIDER BEHAVIOR DOES NOT CONSTITUTE A PROVIDER GUARANTEE.';
export const CONTINUITY_DISCLAIMER = 'THIS PROBE DOES NOT SET ACCOUNT_CONTINUITY_PROVEN.';

export const PHASE18_STATUS_UNCHANGED = Object.freeze({
  phase18: 'CURRENT',
  authoritativeAccountContinuity: 'NOT IMPLEMENTED',
  phase18Completion: 'BLOCKED ON PROVIDER CAPABILITY',
  liveAuthorizationReadiness: 'NOT READY',
  liveVenueVerified: 'NO',
} as const);

export interface RestObservation {
  readonly cycle: string;
  readonly endpoint: ProbeReadEndpoint;
  readonly side: string | null;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly ok: boolean;
  readonly status: number | null;
  readonly error: string | null;
  readonly headers: readonly SanitizedHeader[];
  readonly topLevelKind: JsonKind | null;
  readonly resourceCount: number | null;
  readonly keyPaths: readonly KeyPath[];
  readonly structureSha256: string | null;
}

export interface HeaderCandidateSummary {
  readonly name: string;
  readonly endpoints: readonly string[];
  readonly occurrences: number;
  readonly distinctValues: number;
  readonly allNumeric: boolean;
  readonly numericNonDecreasing: boolean | null;
}

export interface EtagAnalysis {
  readonly responsesWithEtag: number;
  readonly distinctEtags: number;
  readonly distinctContents: number;
  readonly verdict: 'NO_ETAG_OBSERVED' | 'CONSISTENT_WITH_RESPONSE_CONTENT_VALIDATOR' | 'NOT_CONSISTENT_WITH_RESPONSE_CONTENT';
}

/** Standard HTTP cache validators: per-representation, never account-wide ordering by themselves. */
const HTTP_VALIDATOR_HEADERS: ReadonlySet<string> = new Set(['etag', 'last-modified']);

export interface ReconnectFacts {
  readonly bothSessionsConnected: boolean;
  readonly socketIdChanged: boolean | null;
  readonly engineIdChanged: boolean | null;
  readonly resumeLikeKeysObserved: readonly string[];
  readonly gapActivityObservedViaRest: boolean;
  /**
   * Neutral observation only: post-reconnect account events containing a
   * timestamp-named value whose magnitude fell inside the disconnected
   * wall-clock interval. Not replay evidence; never read by `classifyReplay`.
   */
  readonly postReconnectAccountEventsWithTimestampValueInsideGapInterval: number;
  readonly accountEventsSession1: number;
  readonly accountEventsSession2: number;
}

export interface ReportInput {
  readonly runStartedAtIso: string;
  readonly durationMs: number;
  readonly timing: ProbeTiming;
  readonly rest: readonly RestObservation[];
  readonly identity: readonly UserInfoObservation[];
  readonly headerCandidates: readonly HeaderCandidateSummary[];
  readonly etagAnalysis: EtagAnalysis;
  readonly payloadCandidates: readonly CandidateFieldSummary[];
  readonly timestampFields: readonly TimestampFieldSummary[];
  readonly sessions: readonly WsSessionObservation[];
  readonly reconnect: ReconnectFacts;
}

export interface PrimitiveClassification {
  readonly primitive: string;
  readonly classification: ProbeClassification;
  readonly basis: string;
}

export interface ProbeSummary {
  readonly probe: 'COINDCX_READ_ONLY_PROVIDER_PROBE';
  readonly runStartedAtIso: string;
  readonly durationMs: number;
  readonly restRequests: { readonly total: number; readonly ok: number; readonly failed: number };
  readonly identity: IdentityObservation;
  readonly identitySha256: string | null;
  readonly identityCallsObserved: number;
  readonly replay: ReplayObservation;
  readonly primitives: readonly PrimitiveClassification[];
  readonly continuityConclusion: typeof PROBE_CONTINUITY_CONCLUSION;
  readonly providerGuarantee: typeof PROVIDER_GUARANTEE_DISCLAIMER;
  readonly continuityDisclaimer: typeof CONTINUITY_DISCLAIMER;
  readonly phase18Status: typeof PHASE18_STATUS_UNCHANGED;
}

export interface ProbeRunResult {
  readonly summary: ProbeSummary;
  readonly rest: {
    readonly observations: readonly RestObservation[];
    readonly identity: readonly UserInfoObservation[];
    readonly headerCandidates: readonly HeaderCandidateSummary[];
    readonly etagAnalysis: EtagAnalysis;
    readonly payloadCandidates: readonly CandidateFieldSummary[];
    readonly timestampFields: readonly TimestampFieldSummary[];
  };
  readonly websocket: { readonly sessions: readonly WsSessionObservation[]; readonly reconnect: ReconnectFacts };
  readonly reportMarkdown: string;
}

export function classifyIdentity(identity: readonly UserInfoObservation[]): IdentityObservation {
  if (identity.length === 0 || identity.some((entry) => !entry.coindcxIdPresent)) return 'ACCOUNT_IDENTITY_NOT_OBSERVED';
  const hashes = new Set(identity.map((entry) => entry.coindcxIdSha256));
  return hashes.size === 1 && identity.every((entry) => entry.cardinalityExpected)
    ? 'ACCOUNT_IDENTITY_OBSERVED_STABLE_IN_THIS_RUN'
    : 'ACCOUNT_IDENTITY_OBSERVED_UNSTABLE_IN_THIS_RUN';
}

/** Reads only connectivity, REST-observed gap activity, and whether session 2 saw any account event; never timestamps. */
export function classifyReplay(facts: ReconnectFacts): ReplayObservation {
  if (!facts.bothSessionsConnected || !facts.gapActivityObservedViaRest) return 'REPLAY_NOT_TESTABLE_IN_THIS_RUN';
  return facts.accountEventsSession2 > 0
    ? 'POST_RECONNECT_ACCOUNT_EVENT_OBSERVED_RELATION_TO_GAP_UNDETERMINED'
    : 'NO_POST_RECONNECT_ACCOUNT_EVENT_OBSERVED_IN_BOUNDED_WINDOW';
}

const REPLAY_OBSERVATION_BASIS: Readonly<Record<ReplayObservation, string>> = {
  REPLAY_NOT_TESTABLE_IN_THIS_RUN: 'Not testable in this run: no account activity was seen via REST during the disconnected gap (or a session did not connect), and the probe never creates activity.',
  NO_POST_RECONNECT_ACCOUNT_EVENT_OBSERVED_IN_BOUNDED_WINDOW: 'Account activity was seen via REST during the gap, and no post-reconnect account event was observed in this bounded observation window. This does not establish that the provider lacks replay.',
  POST_RECONNECT_ACCOUNT_EVENT_OBSERVED_RELATION_TO_GAP_UNDETERMINED: 'Account activity was seen via REST during the gap and a post-reconnect account event arrived, but nothing provider-defined relates that event to the gap. Timestamp-named fields are not event-time or replay markers.',
};

/** Primitive names, shared with the tests so a rename cannot silently weaken an assertion. */
export const PRIMITIVE = Object.freeze({
  identity: 'Provider account identity: /users/info coindcx_id (point-in-time)',
  headerCandidate: 'REST response header candidate (name suggests ordering/revision: ETag, revision, sequence, cursor, snapshot, watermark, generation)',
  restCandidate: 'REST payload candidate field (name suggests sequence/revision/cursor/snapshot)',
  wsCandidate: 'Private WebSocket event candidate field (name suggests sequence/revision)',
  sessionId: 'Private WebSocket connection/session identifier',
  resumeCandidate: 'WebSocket resume-like key candidate (name suggests resume token or last-sequence request)',
  clientCursor: 'Client-supplied cursor/sequence on join',
  replay: 'Provider replay of account events missed while disconnected',
  authoritativeSequence: 'Authoritative account-wide sequence or snapshot revision',
  mutationPrecondition: 'Futures mutation precondition (expected revision on create/cancel)',
  clientOrderIdField: 'Futures client_order_id field in List Orders responses',
  clientOrderIdOnCreate: 'Futures client_order_id accepted on create (caller-chosen idempotency key)',
  hft: 'HFT API continuity capabilities',
} as const);

/** Primitives that state a provider-level semantic. They are never OBSERVED from a name match or a generic timestamp. */
export const AUTHORITATIVE_PRIMITIVES: readonly string[] = Object.freeze([PRIMITIVE.replay, PRIMITIVE.authoritativeSequence, PRIMITIVE.clientOrderIdOnCreate]);

function classifyPrimitives(input: ReportInput, identity: IdentityObservation, replay: ReplayObservation): readonly PrimitiveClassification[] {
  const restCandidates = input.payloadCandidates.filter((entry) => entry.scope.startsWith('rest:'));
  const wsCandidates = input.payloadCandidates.filter((entry) => entry.scope.startsWith('ws:'));
  const accountEvents = input.reconnect.accountEventsSession1 + input.reconnect.accountEventsSession2;
  const sessionIds = input.sessions.some((session) => session.socketIdSha256 !== null);
  const orderingHeaders = input.headerCandidates.filter((header) => /etag|revision|version|sequence|seq|cursor|snapshot|watermark|generation/i.test(header.name));
  const nonValidatorOrderingHeaders = orderingHeaders.filter((header) => !HTTP_VALIDATOR_HEADERS.has(header.name));
  const nameMatchCandidates = restCandidates.length + wsCandidates.length + nonValidatorOrderingHeaders.length;
  const clientOrderIdTypes = [...new Set(input.rest
    .filter((entry) => entry.ok && entry.endpoint === 'FUTURES_ORDERS')
    .flatMap((entry) => entry.keyPaths.filter((keyPath) => keyPath.path.endsWith('.client_order_id')).flatMap((keyPath) => keyPath.types)))].sort();
  const headerBasis = orderingHeaders.length === 0
    ? 'No such header on any successful authenticated read in this run.'
    : nonValidatorOrderingHeaders.length === 0
      ? `Only standard HTTP cache validators: ${orderingHeaders.map((header) => header.name).join(', ')} (${input.etagAnalysis.verdict}; ${input.etagAnalysis.distinctEtags} distinct ETags for ${input.etagAnalysis.distinctContents} distinct response contents over ${input.etagAnalysis.responsesWithEtag} responses). Inferred to be a per-response content validator, not account-wide ordering.`
      : `Name match only; semantics unverified: ${nonValidatorOrderingHeaders.map((header) => header.name).join(', ')}`;
  return [
    {
      primitive: PRIMITIVE.identity,
      classification: identity === 'ACCOUNT_IDENTITY_NOT_OBSERVED' ? 'NOT_OBSERVED' : 'OBSERVED',
      basis: `${identity}; documented by the provider (prior research). A point-in-time attestation only; says nothing about state between reads.`,
    },
    {
      primitive: PRIMITIVE.headerCandidate,
      classification: orderingHeaders.length === 0 ? 'NOT_OBSERVED' : nonValidatorOrderingHeaders.length === 0 ? 'INFERRED' : 'OBSERVED',
      basis: headerBasis,
    },
    {
      primitive: PRIMITIVE.restCandidate,
      classification: restCandidates.length > 0 ? 'OBSERVED' : 'NOT_OBSERVED',
      basis: restCandidates.length > 0
        ? `Name match only; semantics unverified: ${restCandidates.map((entry) => `${entry.scope} ${entry.path}`).join('; ')}`
        : 'No candidate field name in any successful read payload in this run.',
    },
    {
      primitive: PRIMITIVE.wsCandidate,
      classification: wsCandidates.length > 0 ? 'OBSERVED' : accountEvents === 0 ? 'UNKNOWN' : 'NOT_OBSERVED',
      basis: wsCandidates.length > 0
        ? `Name match only; semantics unverified: ${wsCandidates.map((entry) => `${entry.scope} ${entry.path}`).join('; ')}`
        : accountEvents === 0 ? 'No private account event arrived during either session, so event payloads could not be inspected.' : 'Account events arrived and carried no candidate field.',
    },
    {
      primitive: PRIMITIVE.sessionId,
      classification: sessionIds ? 'INFERRED' : 'NOT_OBSERVED',
      basis: sessionIds
        ? `A socket.io transport session id exists (changed on reconnect: ${String(input.reconnect.socketIdChanged)}). Inferred to be a transport-level id with no documented account-state meaning.`
        : 'No socket id was available.',
    },
    {
      primitive: PRIMITIVE.resumeCandidate,
      classification: input.reconnect.resumeLikeKeysObserved.length > 0 ? 'OBSERVED' : input.reconnect.bothSessionsConnected ? 'NOT_OBSERVED' : 'UNKNOWN',
      basis: input.reconnect.resumeLikeKeysObserved.length > 0
        ? `Name match only; semantics unverified: ${input.reconnect.resumeLikeKeysObserved.join(', ')}`
        : 'No resume-like key in any server event across connect, join, and reconnect.',
    },
    {
      primitive: PRIMITIVE.clientCursor,
      classification: 'UNKNOWN',
      basis: 'Not tested: no documented mechanism exists, and the probe only sends the fixed documented join payload.',
    },
    {
      primitive: PRIMITIVE.replay,
      classification: 'UNKNOWN',
      basis: `${replay}: ${REPLAY_OBSERVATION_BASIS[replay]} No provider-defined sequence, cursor, or replay contract is documented, so the capability stays UNKNOWN whatever this run observed.`,
    },
    {
      primitive: PRIMITIVE.authoritativeSequence,
      classification: nameMatchCandidates > 0 ? 'UNKNOWN' : 'NOT_OBSERVED',
      basis: nameMatchCandidates > 0
        ? 'Not documented by the provider (prior research). Candidate fields/headers exist (see the candidate rows), but a name match does not establish account-wide semantics; unverified.'
        : 'Not documented by the provider (prior research) and nothing of the kind observed: no candidate payload field, and only standard per-response HTTP validators in headers.',
    },
    {
      primitive: PRIMITIVE.mutationPrecondition,
      classification: 'UNKNOWN',
      basis: 'Not documented (prior research) and not testable without a mutation, which this probe never performs.',
    },
    {
      primitive: PRIMITIVE.clientOrderIdField,
      classification: clientOrderIdTypes.length > 0 ? 'OBSERVED' : 'UNKNOWN',
      basis: clientOrderIdTypes.length > 0
        ? `A client_order_id FIELD is present in List Orders responses (observed types: ${clientOrderIdTypes.join('|')}). Field presence only; see the create-side row.`
        : 'Not seen in List Orders responses in this run (an empty listing exposes no fields).',
    },
    {
      primitive: PRIMITIVE.clientOrderIdOnCreate,
      classification: 'UNKNOWN',
      basis: 'Whether create accepts, stores, or echoes a caller-chosen value is not documented (prior research) and not testable without a mutation.',
    },
    {
      primitive: PRIMITIVE.hft,
      classification: 'UNKNOWN',
      basis: 'No HFT endpoint was called; entitlement and read-only semantics are unverified.',
    },
  ];
}

function table(rows: readonly (readonly string[])[], header: readonly string[]): string {
  const escape = (cell: string) => cell.replace(/\|/g, '\\|');
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => ':---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`)].join('\n');
}

export function buildReport(input: ReportInput): ProbeRunResult {
  const identity = classifyIdentity(input.identity);
  const replay = classifyReplay(input.reconnect);
  const primitives = classifyPrimitives(input, identity, replay);
  const ok = input.rest.filter((entry) => entry.ok).length;
  const summary: ProbeSummary = {
    probe: 'COINDCX_READ_ONLY_PROVIDER_PROBE',
    runStartedAtIso: input.runStartedAtIso,
    durationMs: input.durationMs,
    restRequests: { total: input.rest.length, ok, failed: input.rest.length - ok },
    identity,
    identitySha256: identity === 'ACCOUNT_IDENTITY_OBSERVED_STABLE_IN_THIS_RUN' ? input.identity[0]!.coindcxIdSha256 : null,
    identityCallsObserved: input.identity.length,
    replay,
    primitives,
    continuityConclusion: PROBE_CONTINUITY_CONCLUSION,
    providerGuarantee: PROVIDER_GUARANTEE_DISCLAIMER,
    continuityDisclaimer: CONTINUITY_DISCLAIMER,
    phase18Status: PHASE18_STATUS_UNCHANGED,
  };

  const headerNames = [...new Set(input.rest.flatMap((entry) => entry.headers.map((header) => `${header.name} (${header.treatment})`)))].sort();
  const suppressed = [...new Set(input.rest.flatMap((entry) => entry.headers.filter((header) => header.treatment === 'SUPPRESSED').map((header) => header.name)))].sort();
  const restFields = new Map<string, Set<string>>();
  for (const entry of input.rest) {
    if (!entry.ok) continue;
    const set = restFields.get(entry.endpoint) ?? new Set<string>();
    for (const keyPath of entry.keyPaths) set.add(`${keyPath.path}: ${keyPath.types.join('|')}`);
    restFields.set(entry.endpoint, set);
  }
  const mixedUnits = input.timestampFields.filter((field) => Object.keys(field.units).length > 1);

  const md = `# CoinDCX read-only provider probe report

> ${PROVIDER_GUARANTEE_DISCLAIMER}
> ${CONTINUITY_DISCLAIMER}

## 1. Run metadata

- Started: ${input.runStartedAtIso}; duration ${input.durationMs} ms
- REST requests: ${summary.restRequests.total} (${ok} ok, ${summary.restRequests.failed} failed); ${input.timing.restCycles} cycles, ${input.timing.cycleDelayMs} ms apart
- Private socket: two sessions of ${input.timing.wsWindowMs} ms, disconnected gap ${input.timing.gapMs} ms
- Allowlisted endpoints only: USER_INFO, FUTURES_ORDERS (list), FUTURES_POSITIONS (list), FUTURES_WALLETS; socket emission: the \`coindcx\` join only

## 2. Account identity observation

- Result: **${identity}** (never "permanently proven", never continuity)
- \`coindcx_id\` SHA-256: ${summary.identitySha256 ?? 'n/a'} (a local observational fingerprint, not provider credential/session authority)
${table(input.identity.map((entry, index) => [String(index + 1), entry.shape, String(entry.arrayLength ?? '-'), String(entry.cardinalityExpected), String(entry.coindcxIdPresent), entry.coindcxIdSha256?.slice(0, 16) ?? '-']), ['call', 'shape', 'array length', 'cardinality expected', 'coindcx_id present', 'sha256 (prefix)'])}
- Field names present (values never recorded): ${input.identity[0]?.fieldNames.join(', ') ?? 'n/a'}

## 3. REST response headers

- Names seen (treatment): ${headerNames.join(', ') || 'none'}
- Suppressed (never recorded): ${suppressed.join(', ') || 'none'}
- ETag: ${input.etagAnalysis.verdict} (${input.etagAnalysis.responsesWithEtag} responses, ${input.etagAnalysis.distinctEtags} distinct ETags, ${input.etagAnalysis.distinctContents} distinct response contents). Values recorded as shape/digest only.
${input.headerCandidates.length === 0 ? '- No candidate headers.' : table(input.headerCandidates.map((header) => [header.name, header.endpoints.join(', '), String(header.occurrences), String(header.distinctValues), String(header.allNumeric), String(header.numericNonDecreasing)]), ['candidate header', 'endpoints', 'occurrences', 'distinct values', 'all numeric', 'numeric non-decreasing'])}

## 4. REST field discovery

${[...restFields.entries()].map(([endpoint, fields]) => `### ${endpoint}\n\n${endpoint === 'USER_INFO' ? '- Field names only, listed in section 2; no paths or values are recorded for this endpoint.' : [...fields].sort().map((field) => `- \`${field}\``).join('\n') || '- (no fields: empty listing)'}`).join('\n\n') || 'No successful non-identity reads.'}

Resource counts: ${input.rest.filter((entry) => entry.ok && entry.resourceCount !== null).map((entry) => `${entry.cycle} ${entry.endpoint}${entry.side === null ? '' : `(${entry.side})`}=${entry.resourceCount}`).join(', ') || 'n/a'}

## 5. Private WebSocket field discovery

${input.sessions.map((session) => `### ${session.label}

- Connected: ${session.connected}; connect latency ${session.connectLatencyMs ?? '-'} ms; join emitted: ${session.joinEmitted}
- Socket id SHA-256 prefix: ${session.socketIdSha256?.slice(0, 16) ?? '-'}; engine id SHA-256 prefix: ${session.engineIdSha256?.slice(0, 16) ?? '-'}
- Lifecycle: ${session.lifecycle.map((entry) => `${entry.event}@${entry.atMs}ms${entry.detail === null ? '' : `(${entry.detail})`}`).join(', ')}
- Server events: ${session.serverEvents.length === 0 ? 'none' : session.serverEvents.map((event) => `${event.event}×${event.count}`).join(', ')}
${session.serverEvents.map((event) => `\n#### ${event.event}\n\n${event.keyPaths.map((keyPath) => `- \`${keyPath.path}: ${keyPath.types.join('|')}\``).join('\n')}`).join('\n')}`).join('\n\n')}

## 6. Reconnect observation

- Both sessions connected: ${input.reconnect.bothSessionsConnected}
- Socket id changed on reconnect: ${String(input.reconnect.socketIdChanged)}; engine id changed: ${String(input.reconnect.engineIdChanged)}
- Resume-like keys observed: ${input.reconnect.resumeLikeKeysObserved.join(', ') || 'none'}
- Server asked for a last sequence: ${input.reconnect.resumeLikeKeysObserved.length > 0 ? 'candidate keys observed (unverified)' : 'not observed'}
- Client cursor on join: not tested (no documented mechanism)
- Account activity during the gap (REST before/after comparison): ${input.reconnect.gapActivityObservedViaRest}
- Account events: session 1 = ${input.reconnect.accountEventsSession1}, session 2 = ${input.reconnect.accountEventsSession2}
- Post-reconnect account events containing a timestamp value whose magnitude fell inside the disconnected wall-clock interval: ${input.reconnect.postReconnectAccountEventsWithTimestampValueInsideGapInterval}. A neutral observation, not replay evidence: CoinDCX documents no event-time or replay semantics, and a timestamp-named field (\`created_at\`, \`updated_at\`, \`timestamp\`, ...) may be old or belong to another resource.
- **Replay observation: ${replay}.** ${REPLAY_OBSERVATION_BASIS[replay]}
- Provider replay capability: UNKNOWN (no provider-defined sequence, cursor, or replay contract). No venue action was taken to create an event; this is observation only and never replay proof.

## 7. Timestamp observation

${input.timestampFields.length === 0 ? 'No timestamp-named fields observed.' : table(input.timestampFields.map((field) => [field.scope, field.path, Object.entries(field.units).map(([unit, count]) => `${unit}×${count}`).join(', ')]), ['scope', 'field', 'observed unit (by magnitude)'])}

${mixedUnits.length > 0 ? `Fields with more than one observed unit: ${mixedUnits.map((field) => `${field.scope} ${field.path}`).join('; ')}.` : 'No single field showed mixed units in this run.'} Public CoinDCX documentation is inconsistent about timestamp units; these are OBSERVED magnitudes only, and production parsing is not changed by this probe.

## 8. Candidate continuity primitives

${table(primitives.map((entry) => [entry.primitive, entry.classification, entry.basis]), ['primitive', 'classification', 'basis'])}

## 9. Not observed

${primitives.filter((entry) => entry.classification === 'NOT_OBSERVED').map((entry) => `- ${entry.primitive}`).join('\n') || '- (none)'}

## 10. Unknown / could not test

${primitives.filter((entry) => entry.classification === 'UNKNOWN').map((entry) => `- ${entry.primitive}: ${entry.basis}`).join('\n') || '- (none)'}

## 11. Security / redaction check

- Raw provider payload values are not serialized into artifacts: payloads are reduced to key paths, types, counts, shapes, and digests.
- The API key, API secret, and every generated HMAC signature are force-registered in memory at any length; every artifact is swept against the registry before writing, and the probe refuses to write any artifact that still contains a registered value.
- Provider identifiers and PII (ids, \`coindcx_id\`, PII-named fields, socket/engine ids) are also registered, on a bounded defense-in-depth basis: the scan is limited in depth and array width and skips very short values, so it is not a guarantee on its own.
- Authentication and cookie headers (${suppressed.join(', ') || 'none seen'}) are suppressed entirely.
- \`/users/info\` is recorded as field names and a \`coindcx_id\` SHA-256 only; balances and order/position values are never recorded.

## 12. Phase 18 impact

- None. ${PROVIDER_GUARANTEE_DISCLAIMER} ${CONTINUITY_DISCLAIMER}
- Phase18 = ${PHASE18_STATUS_UNCHANGED.phase18}; authoritative account continuity = ${PHASE18_STATUS_UNCHANGED.authoritativeAccountContinuity}; Phase18 completion = ${PHASE18_STATUS_UNCHANGED.phase18Completion}; live authorization readiness = ${PHASE18_STATUS_UNCHANGED.liveAuthorizationReadiness}; LIVE-VENUE VERIFIED = ${PHASE18_STATUS_UNCHANGED.liveVenueVerified}.
- Any OBSERVED candidate above is for independent analysis only and is not wired into authorization.
`;

  return {
    summary,
    rest: {
      observations: input.rest,
      identity: input.identity,
      headerCandidates: input.headerCandidates,
      etagAnalysis: input.etagAnalysis,
      payloadCandidates: input.payloadCandidates,
      timestampFields: input.timestampFields,
    },
    websocket: { sessions: input.sessions, reconnect: input.reconnect },
    reportMarkdown: md,
  };
}
