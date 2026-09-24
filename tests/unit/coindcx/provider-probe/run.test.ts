import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HmacSha256Signer, type RequestSigner } from '../../../../src/integration/coindcx/signer';
import type { ProbeReadEndpoint } from '../../../../scripts/provider-probe/allowlist';
import {
  AUTHORITATIVE_PRIMITIVES,
  CONTINUITY_DISCLAIMER,
  PHASE18_STATUS_UNCHANGED,
  PRIMITIVE,
  PROBE_CONTINUITY_CONCLUSION,
  PROVIDER_GUARANTEE_DISCLAIMER,
  REPLAY_OBSERVATIONS,
  buildReport,
  classifyReplay,
  type ProbeRunResult,
  type ReconnectFacts,
  type ReportInput,
} from '../../../../scripts/provider-probe/report';
import { ProbeReadClient, RecordingSigner, type ProbeReadExecutor } from '../../../../scripts/provider-probe/rest-probe';
import { analyzeEtags, assertGitIgnored, renderArtifacts, runProviderProbe, writeArtifacts } from '../../../../scripts/provider-probe/run';
import { CandidateTracker, SecretRegistry } from '../../../../scripts/provider-probe/sanitize';
import { PROBE_JOIN_SIGNED_BODY, type ProbeSocket, type ProbeSocketFactory } from '../../../../scripts/provider-probe/ws-probe';

// Fully offline: the executor and socket are in-memory fakes, so no test here
// can contact CoinDCX.

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const API_KEY = 'fake-probe-api-key-7c1e9d2a4b6f';
const API_SECRET = 'fake-probe-api-secret-5e3a1c9b7d2f';
const PII = ['cdx-account-44f1b2c3', 'probe.person@example.com', '+919812345678', 'Probeperson', 'order-uuid-aaaa-1111', 'pos-uuid-bbbb-2222'];
const BALANCE = '98765.4321';
const RAW_ETAG = 'W/"DO-NOT-PERSIST-RAW-ETAG-123456"';

class FakeExecutor implements ProbeReadExecutor {
  public readonly calls: ProbeReadEndpoint[] = [];
  public ordersAfterGap = false;
  readonly #signer: RecordingSigner;
  readonly #apiKey: string;
  readonly #apiSecret: string;
  readonly #etag: string | null;

  public constructor(signer: RecordingSigner, apiKey: string, apiSecret: string, etag: string | null) {
    this.#signer = signer;
    this.#apiKey = apiKey;
    this.#apiSecret = apiSecret;
    this.#etag = etag;
  }

  public async executeRead({ endpoint, body }: { endpoint: ProbeReadEndpoint; body: string }) {
    this.calls.push(endpoint);
    const signature = this.#signer.sign(body);
    const headers = {
      'set-cookie': [`sid=${this.#apiSecret}`], 'x-auth-apikey': this.#apiKey, 'x-auth-signature': signature,
      'x-echo': `${this.#apiKey}:${signature}`, date: 'Wed, 23 Sep 2026 10:00:00 GMT', 'content-type': 'application/json',
      'x-request-id': `req-${this.calls.length}`, 'x-seq': String(100 + this.calls.length),
      etag: this.#etag ?? `W/"etag-for-${endpoint}"`,
    };
    const data = {
      USER_INFO: [{ coindcx_id: PII[0], email: PII[1], mobile_number: PII[2], first_name: PII[3] }],
      FUTURES_ORDERS: [{ id: PII[4], pair: 'B-BTC_USDT', status: 'open', created_at: 1_758_620_000_000, updated_at: this.ordersAfterGap ? 1_758_620_009_999 : 1_758_620_001_000, sequence: 7 }],
      FUTURES_POSITIONS: [{ id: PII[5], active_pos: 0, updated_at: 1_758_620_002 }],
      FUTURES_WALLETS: [{ currency_short_name: 'INR', balance: BALANCE }],
    }[endpoint];
    return { status: 200, headers, data };
  }
}

/** Implements the safe production-facing surface: there is no generic emit to fake. */
class FakeSocket implements ProbeSocket {
  public readonly joins: { apiKey: string; authSignature: string; channelName: string }[] = [];
  readonly #listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  readonly #any: ((event: string, args: readonly unknown[]) => void)[] = [];
  readonly #id: string;
  readonly #accountEvent: () => unknown;

  public constructor(id: string, accountEvent: () => unknown) {
    this.#id = id;
    this.#accountEvent = accountEvent;
  }

  public connect(): void {
    queueMicrotask(() => {
      for (const listener of this.#listeners.get('connect') ?? []) listener();
      for (const listener of this.#any) listener('welcome', [{ server_time: 1_758_620_003_000, session_id: 'srv-session-01' }]);
    });
  }

  public disconnect(): void {
    for (const listener of this.#listeners.get('disconnect') ?? []) listener('io client disconnect');
  }

  public on(event: string, listener: (...args: unknown[]) => void): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }

  public joinPrivateAccountChannel(apiKey: string, signer: RequestSigner): void {
    this.joins.push({ channelName: 'coindcx', authSignature: signer.sign(PROBE_JOIN_SIGNED_BODY), apiKey });
    const event = this.#accountEvent();
    if (event !== null) for (const listener of this.#any) listener('df-order-update', [event]);
  }

  public socketId(): string { return this.#id; }
  public engineId(): string { return `${this.#id}-engine`; }
  public onAnyServerEvent(listener: (event: string, args: readonly unknown[]) => void): void { this.#any.push(listener); }
}

interface FakeRunOptions {
  readonly gapActivity: boolean;
  /** Called at each join; receives a wall-clock ms inside the disconnected gap once the gap has happened (session 2), else null. */
  readonly accountEvent: (gapWallMs: number | null) => unknown;
  readonly apiKey?: string;
  readonly apiSecret?: string;
  readonly etag?: string;
}

const NO_EVENT = (): null => null;

async function runFake(options: FakeRunOptions) {
  const apiKey = options.apiKey ?? API_KEY;
  const apiSecret = options.apiSecret ?? API_SECRET;
  const registry = new SecretRegistry();
  registry.addSecret('api-key', apiKey);
  registry.addSecret('api-secret', apiSecret);
  const signer = new RecordingSigner(new HmacSha256Signer(apiSecret), registry);
  const executor = new FakeExecutor(signer, apiKey, apiSecret, options.etag ?? null);
  const sockets: FakeSocket[] = [];
  let clock = 0;
  let sleeps = 0;
  let gapWallMs: number | null = null;
  const wallNow = () => 1_758_620_005_000 + clock;
  const factory: ProbeSocketFactory = () => {
    const socket = new FakeSocket(`sid-${sockets.length + 1}-0123456789`, () => options.accountEvent(gapWallMs));
    sockets.push(socket);
    return socket;
  };
  const logs: string[] = [];
  const result = await runProviderProbe({
    client: new ProbeReadClient(executor, () => 1_758_620_000_000),
    socketFactory: factory,
    signer,
    apiKey,
    registry,
    log: (line) => logs.push(registry.redact(line)),
    monotonicNow: () => (clock += 5),
    wallNow,
    sleep: async () => {
      sleeps += 1;
      // The gap sleep is the fourth: two cycle delays, then session 1's window.
      if (sleeps === 4) {
        gapWallMs = wallNow();
        if (options.gapActivity) executor.ordersAfterGap = true;
      }
    },
    timing: { restCycles: 3, cycleDelayMs: 1, wsWindowMs: 1, gapMs: 1, connectTimeoutMs: 1_000 },
  });
  return { result, registry, executor, sockets, logs, artifacts: renderArtifacts(result) };
}

function byPrimitive(result: ProbeRunResult) {
  return new Map(result.summary.primitives.map((entry) => [entry.primitive, entry]));
}

function expectNoAuthoritativeObserved(result: ProbeRunResult): void {
  for (const entry of result.summary.primitives) {
    if (AUTHORITATIVE_PRIMITIVES.includes(entry.primitive)) expect(entry.classification, entry.primitive).not.toBe('OBSERVED');
  }
}

const QUIET_FACTS: ReconnectFacts = {
  bothSessionsConnected: true, socketIdChanged: true, engineIdChanged: true, resumeLikeKeysObserved: [],
  gapActivityObservedViaRest: false, postReconnectAccountEventsWithTimestampValueInsideGapInterval: 0,
  accountEventsSession1: 0, accountEventsSession2: 0,
};

function reportInput(overrides: Partial<ReportInput>): ReportInput {
  return {
    runStartedAtIso: '2026-09-24T00:00:00.000Z', durationMs: 1, timing: { restCycles: 1, cycleDelayMs: 0, wsWindowMs: 0, gapMs: 0, connectTimeoutMs: 0 },
    rest: [], identity: [], headerCandidates: [], payloadCandidates: [], timestampFields: [], sessions: [], reconnect: QUIET_FACTS,
    etagAnalysis: { responsesWithEtag: 0, distinctEtags: 0, distinctContents: 0, verdict: 'NO_ETAG_OBSERVED' },
    ...overrides,
  };
}

describe('[probe run] secrets and PII never reach logs or artifacts', () => {
  it('no API key, secret, signature, identifier, PII, or balance appears anywhere', async () => {
    const { artifacts, logs, registry, sockets } = await runFake({ gapActivity: false, accountEvent: NO_EVENT });
    const everything = [...Object.values(artifacts), ...logs].join('\n');
    for (const secret of [API_KEY, API_SECRET, ...PII, BALANCE]) expect(everything).not.toContain(secret);
    const joinSignature = sockets[0]!.joins[0]!.authSignature;
    expect(everything).not.toContain(joinSignature);
    expect(registry.findIn(joinSignature)).toEqual(['signature']);
    for (const content of Object.values(artifacts)) expect(registry.findIn(content)).toEqual([]);
    expect(registry.size).toBeGreaterThan(10);
  });

  it('writeArtifacts refuses to write anything when an artifact contains a registered secret', () => {
    const registry = new SecretRegistry();
    registry.addSecret('api-key', API_KEY);
    const directory = path.join(REPO_ROOT, '.local', 'provider-probe', `unit-refuse-${process.pid}`);
    expect(() => writeArtifacts(REPO_ROOT, directory, {
      'summary.json': '{}', 'rest-observations.json': `{"leak":"${API_KEY}"}`, 'websocket-observations.json': '{}', 'report.md': '',
    }, registry)).toThrow(/PROBE_ARTIFACT_SECRET_SWEEP_FAILED.*api-key/);
    expect(existsSync(directory)).toBe(false);
  });

  it('only ever calls allowlisted reads and only ever joins the coindcx channel', async () => {
    const { executor, sockets } = await runFake({ gapActivity: false, accountEvent: NO_EVENT });
    expect(new Set(executor.calls)).toEqual(new Set(['USER_INFO', 'FUTURES_ORDERS', 'FUTURES_POSITIONS', 'FUTURES_WALLETS']));
    expect(sockets).toHaveLength(2);
    for (const socket of sockets) {
      expect(socket.joins).toHaveLength(1);
      expect(socket.joins[0]!.channelName).toBe('coindcx');
    }
  });
});

describe('[probe run] PROBE-02: tiny explicit credentials are never skipped', () => {
  it('API key "k" and secret "s" are found, redacted, and make the artifact sweep refuse', async () => {
    const { registry, artifacts, logs } = await runFake({ gapActivity: false, accountEvent: NO_EVENT, apiKey: 'k', apiSecret: 's' });
    expect(registry.findIn('k')).toEqual(['api-key']);
    expect(registry.findIn('s')).toEqual(['api-secret']);
    for (const line of logs) {
      expect(line).not.toContain('k');
      expect(line).not.toContain('s');
    }
    const directory = path.join(REPO_ROOT, '.local', 'provider-probe', `unit-tiny-${process.pid}`);
    expect(() => writeArtifacts(REPO_ROOT, directory, artifacts, registry)).toThrow(/PROBE_ARTIFACT_SECRET_SWEEP_FAILED/);
    expect(existsSync(directory)).toBe(false);
  });

  it('RecordingSigner force-registers every signature regardless of length', () => {
    const registry = new SecretRegistry();
    const tiny: RequestSigner = { sign: () => 'z' };
    expect(new RecordingSigner(tiny, registry).sign('{}')).toBe('z');
    expect(registry.findIn('--z--')).toEqual(['signature']);
    expect(registry.redact('sig=z')).not.toContain('z');
  });
});

describe('[probe run] observation is never authorization', () => {
  it('reports stable identity only as an in-run observation, and records candidates as unverified name matches', async () => {
    const { result } = await runFake({ gapActivity: false, accountEvent: NO_EVENT });
    expect(result.summary.identity).toBe('ACCOUNT_IDENTITY_OBSERVED_STABLE_IN_THIS_RUN');
    expect(result.summary.identityCallsObserved).toBe(3);
    const primitives = byPrimitive(result);
    expect(primitives.get(PRIMITIVE.restCandidate)!.classification).toBe('OBSERVED');
    expect(primitives.get(PRIMITIVE.mutationPrecondition)!.classification).toBe('UNKNOWN');
    expect(result.rest.payloadCandidates.every((entry) => entry.note === 'NAME_MATCH_ONLY_SEMANTICS_UNVERIFIED')).toBe(true);
    expectNoAuthoritativeObserved(result);
  });

  it('the result cannot express ACCOUNT_CONTINUITY_PROVEN: fixed conclusion, disclaimers, and unchanged Phase 18 status', async () => {
    const { result, artifacts } = await runFake({
      gapActivity: true,
      accountEvent: (gapWallMs) => (gapWallMs === null ? null : { data: JSON.stringify({ id: 'x', updated_at: gapWallMs }) }),
    });
    expect(result.summary.continuityConclusion).toBe(PROBE_CONTINUITY_CONCLUSION);
    expect(result.summary.phase18Status).toEqual(PHASE18_STATUS_UNCHANGED);
    expect(PHASE18_STATUS_UNCHANGED).toEqual({
      phase18: 'CURRENT', authoritativeAccountContinuity: 'NOT IMPLEMENTED', phase18Completion: 'BLOCKED ON PROVIDER CAPABILITY',
      liveAuthorizationReadiness: 'NOT READY', liveVenueVerified: 'NO',
    });
    for (const content of Object.values(artifacts)) {
      // The only occurrence of the capability name is inside the disclaimer that denies it.
      expect(content.split(CONTINUITY_DISCLAIMER).join('')).not.toContain('ACCOUNT_CONTINUITY_PROVEN');
    }
    expect(artifacts['report.md']).toContain(PROVIDER_GUARANTEE_DISCLAIMER);
    expect(artifacts['report.md']).toContain(CONTINUITY_DISCLAIMER);
  });

  it('a socket session id is recorded as a hash and classified as an inferred transport id, not account state', async () => {
    const { result, artifacts } = await runFake({ gapActivity: false, accountEvent: NO_EVENT });
    expect(result.websocket.reconnect.socketIdChanged).toBe(true);
    expect(JSON.stringify(artifacts)).not.toContain('sid-1-0123456789');
    expect(byPrimitive(result).get(PRIMITIVE.sessionId)?.classification).toBe('INFERRED');
  });
});

describe('[probe run] PROBE-03: generic timestamps never establish replay', () => {
  const gapEvent = (field: string) => (gapWallMs: number | null) => (gapWallMs === null ? null : { data: JSON.stringify({ id: 'order-x', [field]: gapWallMs }) });

  it.each(['created_at', 'updated_at', 'timestamp', 'event_time', 'ts', 'server_timestamp', 'lastUpdatedAt', 'exchange_date'])(
    'a post-reconnect event whose %s falls inside the gap cannot make replay OBSERVED',
    async (field) => {
      const { result, artifacts } = await runFake({ gapActivity: true, accountEvent: gapEvent(field) });
      // The value really was inside the disconnected interval: the neutral count saw it.
      expect(result.websocket.reconnect.postReconnectAccountEventsWithTimestampValueInsideGapInterval).toBe(1);
      expect(result.websocket.reconnect.accountEventsSession2).toBe(1);
      expect(result.summary.replay).toBe('POST_RECONNECT_ACCOUNT_EVENT_OBSERVED_RELATION_TO_GAP_UNDETERMINED');
      const replay = byPrimitive(result).get(PRIMITIVE.replay)!;
      expect(replay.classification).toBe('UNKNOWN');
      expect(replay.basis).toMatch(/Timestamp-named fields are not event-time or replay markers/);
      expect(artifacts['report.md']).toContain('not replay evidence');
      expect(artifacts['report.md']).toContain('Provider replay capability: UNKNOWN');
      expectNoAuthoritativeObserved(result);
    },
  );

  it('classifyReplay never reads the timestamp comparison', () => {
    for (const overrides of [
      {}, { gapActivityObservedViaRest: true }, { gapActivityObservedViaRest: true, accountEventsSession2: 2 },
      { bothSessionsConnected: false, gapActivityObservedViaRest: true, accountEventsSession2: 2 },
    ]) {
      const base = { ...QUIET_FACTS, ...overrides };
      expect(classifyReplay({ ...base, postReconnectAccountEventsWithTimestampValueInsideGapInterval: 999 })).toBe(classifyReplay(base));
    }
  });

  it('every replay observation leaves the provider replay primitive UNKNOWN, whatever the timestamp count', () => {
    const cases: [Partial<ReconnectFacts>, string][] = [
      [{}, 'REPLAY_NOT_TESTABLE_IN_THIS_RUN'],
      [{ bothSessionsConnected: false, gapActivityObservedViaRest: true }, 'REPLAY_NOT_TESTABLE_IN_THIS_RUN'],
      [{ gapActivityObservedViaRest: true }, 'NO_POST_RECONNECT_ACCOUNT_EVENT_OBSERVED_IN_BOUNDED_WINDOW'],
      [{ gapActivityObservedViaRest: true, accountEventsSession2: 3 }, 'POST_RECONNECT_ACCOUNT_EVENT_OBSERVED_RELATION_TO_GAP_UNDETERMINED'],
    ];
    const seen = new Set<string>();
    for (const [overrides, expected] of cases) {
      for (const count of [0, 1, 1000]) {
        const result = buildReport(reportInput({ reconnect: { ...QUIET_FACTS, ...overrides, postReconnectAccountEventsWithTimestampValueInsideGapInterval: count } }));
        expect(result.summary.replay).toBe(expected);
        expect(byPrimitive(result).get(PRIMITIVE.replay)!.classification).toBe('UNKNOWN');
        seen.add(result.summary.replay);
      }
    }
    expect([...seen].sort()).toEqual([...REPLAY_OBSERVATIONS].sort());
  });

  it('no replay observation member or wording implies replay proven, supported, or unsupported', () => {
    for (const member of REPLAY_OBSERVATIONS) expect(member).not.toMatch(/PROVEN|PROOF|GUARANTEE|SUPPORT|DELIVERED|REPLAYED|NO_REPLAY/);
    const noEvent = buildReport(reportInput({ reconnect: { ...QUIET_FACTS, gapActivityObservedViaRest: true } }));
    expect(noEvent.reportMarkdown).toContain('no post-reconnect account event was observed in this bounded observation window');
    expect(noEvent.reportMarkdown).toContain('does not establish that the provider lacks replay');
  });

  it('with no account event at all, replay remains REPLAY_NOT_TESTABLE_IN_THIS_RUN and never proof', async () => {
    const quiet = await runFake({ gapActivity: false, accountEvent: NO_EVENT });
    expect(quiet.result.summary.replay).toBe('REPLAY_NOT_TESTABLE_IN_THIS_RUN');
    expect(byPrimitive(quiet.result).get(PRIMITIVE.replay)!.classification).toBe('UNKNOWN');
    expect(quiet.artifacts['report.md']).toContain('REPLAY_NOT_TESTABLE_IN_THIS_RUN');
    expect(quiet.artifacts['report.md']).toContain('never replay proof');
  });
});

describe('[probe run] PROBE-04: a name match is a candidate, never an authoritative primitive', () => {
  it('a REST payload { sequence: 7 } is an OBSERVED candidate but never an OBSERVED authoritative account-wide sequence', () => {
    const tracker = new CandidateTracker();
    tracker.observe('rest:FUTURES_ORDERS', { sequence: 7 });
    const result = buildReport(reportInput({ payloadCandidates: tracker.summarize() }));
    const primitives = byPrimitive(result);
    expect(primitives.get(PRIMITIVE.restCandidate)!.classification).toBe('OBSERVED');
    expect(primitives.get(PRIMITIVE.restCandidate)!.basis).toMatch(/^Name match only; semantics unverified: rest:FUTURES_ORDERS \$\.sequence/);
    const authoritative = primitives.get(PRIMITIVE.authoritativeSequence)!;
    expect(authoritative.classification).toBe('UNKNOWN');
    expect(authoritative.basis).toMatch(/name match does not establish account-wide semantics/);
    expect(result.reportMarkdown).not.toMatch(/\| Authoritative account-wide sequence or snapshot revision \| OBSERVED \|/);
    expectNoAuthoritativeObserved(result);
  });

  it('the same holds for WebSocket and non-validator header name matches, and with none the authoritative row is NOT_OBSERVED', () => {
    const tracker = new CandidateTracker();
    tracker.observe('ws:df-order-update', { revision: 3 });
    const withCandidates = buildReport(reportInput({
      payloadCandidates: tracker.summarize(),
      headerCandidates: [{ name: 'x-sequence', endpoints: ['FUTURES_ORDERS'], occurrences: 2, distinctValues: 2, allNumeric: true, numericNonDecreasing: true }],
    }));
    expect(byPrimitive(withCandidates).get(PRIMITIVE.wsCandidate)!.classification).toBe('OBSERVED');
    expect(byPrimitive(withCandidates).get(PRIMITIVE.headerCandidate)!.classification).toBe('OBSERVED');
    expect(byPrimitive(withCandidates).get(PRIMITIVE.authoritativeSequence)!.classification).toBe('UNKNOWN');
    expectNoAuthoritativeObserved(withCandidates);
    expect(byPrimitive(buildReport(reportInput({}))).get(PRIMITIVE.authoritativeSequence)!.classification).toBe('NOT_OBSERVED');
  });

  it('the full fake run (orders carry `sequence`) never reports an authoritative primitive as OBSERVED', async () => {
    const { result } = await runFake({ gapActivity: true, accountEvent: (gapWallMs) => (gapWallMs === null ? null : { sequence: 9, updated_at: gapWallMs }) });
    expect(byPrimitive(result).get(PRIMITIVE.restCandidate)!.classification).toBe('OBSERVED');
    expect(byPrimitive(result).get(PRIMITIVE.wsCandidate)!.classification).toBe('OBSERVED');
    expect(byPrimitive(result).get(PRIMITIVE.authoritativeSequence)!.classification).toBe('UNKNOWN');
    expectNoAuthoritativeObserved(result);
  });
});

describe('[probe run] standard HTTP validators and observed fields are not overstated', () => {
  it('classifies an ETag as a content validator only when content and ETag correspond one-to-one', () => {
    expect(analyzeEtags([])).toMatchObject({ verdict: 'NO_ETAG_OBSERVED' });
    expect(analyzeEtags([
      { etag: 'a', content: 'x' }, { etag: 'a', content: 'x' }, { etag: 'b', content: 'y' },
    ])).toEqual({ responsesWithEtag: 3, distinctEtags: 2, distinctContents: 2, verdict: 'CONSISTENT_WITH_RESPONSE_CONTENT_VALIDATOR' });
    expect(analyzeEtags([{ etag: 'a', content: 'x' }, { etag: 'b', content: 'x' }]).verdict).toBe('NOT_CONSISTENT_WITH_RESPONSE_CONTENT');
    expect(analyzeEtags([{ etag: 'a', content: 'x' }, { etag: 'a', content: 'y' }]).verdict).toBe('NOT_CONSISTENT_WITH_RESPONSE_CONTENT');
  });

  it('an ETag alone is INFERRED to be a per-response validator, never an account-wide revision', () => {
    const result = buildReport(reportInput({
      rest: [{
        cycle: 'cycle-1', endpoint: 'FUTURES_ORDERS', side: 'buy', startedAtMs: 0, endedAtMs: 1, ok: true, status: 200, error: null, headers: [],
        topLevelKind: 'array', resourceCount: 1, structureSha256: 'x',
        keyPaths: [{ path: '$', types: ['array'] }, { path: '$[].client_order_id', types: ['null'] }],
      }],
      etagAnalysis: { responsesWithEtag: 3, distinctEtags: 2, distinctContents: 2, verdict: 'CONSISTENT_WITH_RESPONSE_CONTENT_VALIDATOR' },
      headerCandidates: [{ name: 'etag', endpoints: ['FUTURES_ORDERS'], occurrences: 3, distinctValues: 2, allNumeric: false, numericNonDecreasing: null }],
    }));
    const primitives = byPrimitive(result);
    const header = primitives.get(PRIMITIVE.headerCandidate)!;
    expect(header.classification).toBe('INFERRED');
    expect(header.basis).toMatch(/per-response content validator, not account-wide ordering/);
    expect(primitives.get(PRIMITIVE.authoritativeSequence)!.classification).toBe('NOT_OBSERVED');
    const field = primitives.get(PRIMITIVE.clientOrderIdField)!;
    expect(field.classification).toBe('OBSERVED');
    expect(field.basis).toMatch(/FIELD is present.*Field presence only/);
    expect(primitives.get(PRIMITIVE.clientOrderIdOnCreate)!.classification).toBe('UNKNOWN');
  });
});

describe('[probe run] PROBE-05: a raw ETag never reaches any artifact', () => {
  it('runProviderProbe -> renderArtifacts keeps the raw ETag memory-only; only shape, digest, counts, and verdict persist', async () => {
    const { result, artifacts, logs } = await runFake({ gapActivity: false, accountEvent: NO_EVENT, etag: RAW_ETAG });
    expect(Object.keys(artifacts).sort()).toEqual(['report.md', 'rest-observations.json', 'summary.json', 'websocket-observations.json']);
    for (const [file, content] of Object.entries(artifacts)) {
      expect(content, file).not.toContain(RAW_ETAG);
      expect(content, file).not.toContain('DO-NOT-PERSIST-RAW-ETAG-123456');
      // Also not in JSON-escaped form.
      expect(content, file).not.toContain(JSON.stringify(RAW_ETAG).slice(1, -1));
    }
    for (const line of logs) expect(line).not.toContain('DO-NOT-PERSIST-RAW-ETAG');
    // The ETag was really seen and analysed.
    expect(result.rest.etagAnalysis).toMatchObject({ responsesWithEtag: 21, distinctEtags: 1 });
    expect(result.rest.observations[0]!.headers.find((header) => header.name === 'etag')).toMatchObject({ treatment: 'SHAPE_ONLY', shape: { length: RAW_ETAG.length } });
    expect(artifacts['report.md']).toContain(`ETag: ${result.rest.etagAnalysis.verdict}`);
  });
});

describe('[probe run] artifacts are local only', () => {
  const created: string[] = [];
  afterAll(() => { for (const directory of created) rmSync(directory, { recursive: true, force: true }); });

  it('the artifact directory is git-ignored, and a tracked path is refused', () => {
    expect(() => assertGitIgnored(REPO_ROOT, path.join(REPO_ROOT, '.local', 'provider-probe', 'x', 'summary.json'))).not.toThrow();
    expect(() => assertGitIgnored(REPO_ROOT, path.join(REPO_ROOT, 'docs', 'probe-summary.json'))).toThrow(/PROBE_ARTIFACT_PATH_NOT_IGNORED/);
  });

  it('writes the four sanitized files into an ignored directory that git never lists', async () => {
    const { artifacts, registry } = await runFake({ gapActivity: false, accountEvent: NO_EVENT });
    const directory = path.join(REPO_ROOT, '.local', 'provider-probe', `unit-${process.pid}-${Date.now()}`);
    created.push(directory);
    writeArtifacts(REPO_ROOT, directory, artifacts, registry);
    expect(readdirSync(directory).sort()).toEqual(['report.md', 'rest-observations.json', 'summary.json', 'websocket-observations.json']);
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.local'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(status).toBe('');
  });
});

describe('[probe CLI] refuses to run without explicit opt-in and credentials, and never prints them', () => {
  const run = (env: Record<string, string>) => spawnSync(process.execPath, [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), 'scripts/coindcx-readonly-provider-probe.ts'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env['PATH'] ?? '', SYSTEMROOT: process.env['SYSTEMROOT'] ?? '', ...env },
  });

  it('without COINDCX_READONLY_PROVIDER_PROBE=true it refuses before doing anything', () => {
    for (const flag of [undefined, 'TRUE', '1', 'yes', ' true']) {
      const result = run({ COINDCX_API_KEY: API_KEY, COINDCX_API_SECRET: API_SECRET, ...(flag === undefined ? {} : { COINDCX_READONLY_PROVIDER_PROBE: flag }) });
      expect(result.status).toBe(2);
      expect(`${result.stdout}${result.stderr}`).toContain('Refusing to run');
      expect(`${result.stdout}${result.stderr}`).not.toContain(API_KEY);
      expect(`${result.stdout}${result.stderr}`).not.toContain(API_SECRET);
    }
  }, 120_000);

  it('with the opt-in but without credentials it refuses', () => {
    const result = run({ COINDCX_READONLY_PROVIDER_PROBE: 'true', COINDCX_API_KEY: '', COINDCX_API_SECRET: '' });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain('must both be set');
  }, 60_000);
});
