import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveExecutionIntentRecord } from '../../../../src/execution/live/intent';
import { buildOfflineLineageDiagnostic, type OfflineLineageDiagnosticInput } from '../../../../src/execution/live/ownership-lineage-diagnostic';
import {
  exportOfflineLineageDiagnostic,
  LINEAGE_DIAGNOSTIC_FILE,
  LINEAGE_MANIFEST_FILE,
  nodeLineagePackageFileSystem,
  readLineageDiagnosticPackage,
  writeLineageDiagnosticPackage,
  type LineagePackageFileSystem,
  type LineageSnapshotPort,
} from '../../../../src/execution/live/ownership-lineage-export';
import { liveExecutionIntentContentSha256, PrismaLiveExecutionRepository } from '../../../../src/execution/live/repository';

// SYNTHETIC rows, statements and packages only. The fake transaction client verifies routing and failure handling
// through the REAL repository method; it proves nothing about MySQL isolation, locking or deployment suitability.
const ACCOUNT = 'synthetic-account';
const FP = 'f0'.repeat(32);
const CANARY = 'SYNTHETIC_CANARY_9K';
const intentId = (n: number): string => n.toString(16).padStart(64, '0');
const tag = (n: number): string => `p17-${n.toString(16).padStart(32, '0')}`;
const STATEMENTS: OfflineLineageDiagnosticInput['statements'] = Object.freeze({
  expectedProviderAccountFingerprint: FP, campaignExpectedProviderAccountFingerprint: FP, campaignAccountId: ACCOUNT,
  sourceCommit: 'c0'.repeat(20), migrationIdentity: { directories: ['20260920000000_phase17_live_execution'], lockSha256: 'ab'.repeat(32) },
  sourceCoverage: 'NOT_ATTESTED',
});

type Row = Record<string, unknown>;

function intentRecord(n: number, overrides: Partial<LiveExecutionIntentRecord['content']> = {}): LiveExecutionIntentRecord {
  return {
    intentId: intentId(n), clientOrderId: tag(n), wireOrderType: 'limit_order', quantityAdjusted: false, priceAdjusted: false,
    content: {
      accountId: ACCOUNT, pair: 'B-BTC_USDT', side: 'BUY', action: 'OPEN', quantity: '0.123456789012345678', orderType: 'LIMIT', price: '64000.5',
      timeInForce: 'UNSPECIFIED', leverage: '5', riskDecisionId: 'risk-1', admissionId: `admission-${n}`, strategyInstanceId: 'instance-1',
      strategyId: CANARY, strategyVersion: '1.0.0', parameterHash: 'p'.repeat(64), liveExecutionPolicyId: 'policy-1', instrumentSpecSnapshotId: 'spec-1',
      authorizedNotionalInr: '2560020', settlementRateInrPerQuote: '80', positionInstanceId: null, positionRevision: null, reduceOnlyQuantity: null,
      ...overrides,
    },
    lineage: { researchApproval: null, sourceStrategyDecisionId: `decision-${n}` },
  };
}

/** The stored intent row, column for column as the repository writes it, with Prisma decimals. */
function intentRow(intent: LiveExecutionIntentRecord): Row {
  const { content } = intent;
  const dec = (value: string | null): unknown => (value === null ? null : new Prisma.Decimal(value));
  return {
    intentId: intent.intentId, clientOrderId: intent.clientOrderId, contentSha256: liveExecutionIntentContentSha256(intent),
    accountId: content.accountId, pair: content.pair, side: content.side, action: content.action, quantity: dec(content.quantity),
    orderType: content.orderType, price: dec(content.price), timeInForce: content.timeInForce, leverage: dec(content.leverage),
    riskDecisionId: content.riskDecisionId, admissionId: content.admissionId, strategyInstanceId: content.strategyInstanceId,
    strategyId: content.strategyId, strategyVersion: content.strategyVersion, parameterHash: content.parameterHash,
    liveExecutionPolicyId: content.liveExecutionPolicyId, instrumentSpecSnapshotId: content.instrumentSpecSnapshotId,
    authorizedNotionalInr: dec(content.authorizedNotionalInr), settlementRateInrPerQuote: dec(content.settlementRateInrPerQuote),
    positionInstanceId: content.positionInstanceId, positionRevision: content.positionRevision, reduceOnlyQuantity: dec(content.reduceOnlyQuantity),
    wireOrderType: intent.wireOrderType, sourceStrategyDecisionId: intent.lineage.sourceStrategyDecisionId,
    validationSubjectId: null, validationPlanId: null, validationSubjectResultSha256: null,
  };
}
function orderRow(intent: LiveExecutionIntentRecord, state: string, exchangeOrderId: string | null, overrides: Row = {}): Row {
  return {
    intentId: intent.intentId, clientOrderId: intent.clientOrderId, accountId: intent.content.accountId, pair: intent.content.pair, state, exchangeOrderId,
    orderedQuantity: new Prisma.Decimal(intent.content.quantity), cumulativeFilledQuantity: new Prisma.Decimal('0'),
    remainingQuantity: new Prisma.Decimal(intent.content.quantity), averageFillPrice: null, lastExchangeStatus: null, lastProviderEventTimeMs: null,
    faultCode: null, cancelState: 'NONE', cancelGeneration: 0, cancelExchangeOrderId: null, cancelFaultCode: null,
    dispatchWireArmed: false, cancelWireArmed: false, revision: 1, createdAt: new Date(0), updatedAt: new Date(0), ...overrides,
  };
}

const READS = ['liveOrder.findMany', '$queryRaw', 'liveReconciliationFinding.findMany', 'livePracticalCertificate.findMany',
  'livePositionOwnershipShare.count', 'liveReconciliationState.findUnique'] as const;

/**
 * A fake database exposing ONLY `$transaction` on the root client and ONLY the snapshot reads on the transaction
 * client. Any other root, delegate or nested-transaction access throws, so a write or a root-client read fails the test.
 */
class FakeLineageDb {
  public readonly transactions: unknown[] = [];
  public readonly calls: { read: string; client: object; args: unknown }[] = [];
  public orders: Row[] = [];
  public findings: unknown = [];
  public certificates: unknown = [];
  public shareCount: unknown = 0;
  public state: unknown = null;
  public leases: unknown[] = [];
  public failRead: string | null = null;
  public failCommit = false;
  /** false emulates MySQL's case-insensitive, pad-space equality returning a row whose account differs exactly. */
  public exactAccountFilter = true;
  public readonly root: PrismaClient;
  #tx: object | null = null;

  public constructor() {
    this.root = new Proxy({}, { get: (_target, key) => {
      if (key === '$transaction') return this.#transaction.bind(this);
      if (key === 'then') return undefined;
      throw new Error(`ROOT_CLIENT_USED:${String(key)}`);
    } }) as PrismaClient;
  }

  async #transaction(work: unknown, options: unknown): Promise<unknown> {
    if (typeof work !== 'function') throw new Error('BATCH_TRANSACTION_USED');
    this.transactions.push(options);
    const client = this.#client();
    this.#tx = client;
    const result = await (work as (tx: object) => Promise<unknown>)(client);
    this.#tx = null;
    if (this.failCommit) throw new Error(`COMMIT_FAILED ${CANARY}`);
    return result;
  }

  #read(read: string, args: unknown, client: object, value: () => unknown): Promise<unknown> {
    this.calls.push({ read, client, args });
    if (this.#tx !== client) return Promise.reject(new Error('READ_OUTSIDE_TRANSACTION'));
    if (this.failRead === read) return Promise.reject(new Error(`READ_FAILED ${CANARY}`));
    return Promise.resolve(value());
  }

  #client(): object {
    const delegate = (name: string, methods: Record<string, (args: never) => Promise<unknown>>): object => new Proxy(methods, { get(target, key) {
      if (typeof key === 'string' && key in target) return target[key];
      throw new Error(`UNEXPECTED_DELEGATE_USE:${name}.${String(key)}`);
    } });
    const client: Record<string, unknown> = {};
    const tx = new Proxy(client, { get(target, key) {
      if (typeof key === 'string' && key in target) return target[key];
      if (key === 'then') return undefined;
      throw new Error(`UNEXPECTED_TX_USE:${String(key)}`);
    } });
    const byAccount = (rows: unknown, accountId: string): unknown => (Array.isArray(rows) && this.exactAccountFilter
      ? rows.filter((row) => (row as Row | null)?.['accountId'] === accountId || row === null) : rows);
    Object.assign(client, {
      liveOrder: delegate('liveOrder', { findMany: (args: { where: { accountId: string } }) => this.#read('liveOrder.findMany', args, tx, () =>
        this.orders.filter((row) => row['accountId'] === args.where.accountId)) }),
      $queryRaw: (query: unknown) => this.#read('$queryRaw', query, tx, () => this.leases),
      liveReconciliationFinding: delegate('liveReconciliationFinding', { findMany: (args: { where: { accountId: string } }) =>
        this.#read('liveReconciliationFinding.findMany', args, tx, () => byAccount(this.findings, args.where.accountId)) }),
      livePracticalCertificate: delegate('livePracticalCertificate', { findMany: (args: { where: { accountId: string } }) =>
        this.#read('livePracticalCertificate.findMany', args, tx, () => byAccount(this.certificates, args.where.accountId)) }),
      livePositionOwnershipShare: delegate('livePositionOwnershipShare', { count: (args: unknown) =>
        this.#read('livePositionOwnershipShare.count', args, tx, () => this.shareCount) }),
      liveReconciliationState: delegate('liveReconciliationState', { findUnique: (args: unknown) =>
        this.#read('liveReconciliationState.findUnique', args, tx, () => this.state) }),
    });
    return tx;
  }
}

function seeded(): { db: FakeLineageDb; repository: PrismaLiveExecutionRepository; intents: LiveExecutionIntentRecord[] } {
  const db = new FakeLineageDb();
  const intents = [1, 2, 3, 4].map((n) => intentRecord(n));
  const [filled, ambiguous, created, acknowledged] = intents as [LiveExecutionIntentRecord, LiveExecutionIntentRecord, LiveExecutionIntentRecord, LiveExecutionIntentRecord];
  db.orders = [
    { ...orderRow(filled, 'FILLED', `ex-${CANARY}-1`), intent: intentRow(filled) },
    { ...orderRow(ambiguous, 'SUBMISSION_AMBIGUOUS', null), intent: intentRow(ambiguous) },
    { ...orderRow(created, 'CREATED', null), intent: intentRow(created) },
    { ...orderRow(acknowledged, 'ACKNOWLEDGED', `ex-${CANARY}-4`, { cancelGeneration: 1 }), intent: intentRow(acknowledged) },
  ];
  db.findings = [
    { accountId: ACCOUNT, intentId: intentId(1), exchangeOrderId: `ex-${CANARY}-1`, code: 'RECON_AMBIGUOUS_CREATE_RESOLVED' },
    { accountId: ACCOUNT, intentId: null, exchangeOrderId: `ex-${CANARY}-9`, code: 'RECON_ORPHAN_VENUE_ORDER' },
  ];
  db.certificates = [{ accountId: ACCOUNT, providerAccountFingerprint: FP }, { accountId: ACCOUNT, providerAccountFingerprint: FP }];
  db.shareCount = 2;
  db.state = { accountId: ACCOUNT, currentGeneration: 7, healthyGeneration: 6 };
  return { db, repository: new PrismaLiveExecutionRepository(db.root), intents };
}

let workspace: string;
beforeEach(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-export-test-')); });
afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });
const destination = (name = 'package'): string => path.join(workspace, name);
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('readLineageDiagnosticSnapshot (real repository method over a fake transaction client)', () => {
  it('reads everything in ONE explicit REPEATABLE READ interactive transaction through the same transaction client', async () => {
    const { db, repository } = seeded();
    const snapshot = await repository.readLineageDiagnosticSnapshot(ACCOUNT);
    expect(db.transactions).toEqual([{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 }]);
    expect(db.calls.map((call) => call.read)).toEqual([...READS]);
    expect(new Set(db.calls.map((call) => call.client)).size).toBe(1);
    expect(db.calls.find((call) => call.read === 'liveReconciliationFinding.findMany')?.args).toEqual({
      where: { accountId: ACCOUNT, OR: [{ intentId: { not: null } }, { exchangeOrderId: { not: null } }] },
      select: { accountId: true, intentId: true, exchangeOrderId: true, code: true }, orderBy: { findingId: 'asc' } });
    expect(db.calls.find((call) => call.read === 'livePracticalCertificate.findMany')?.args).toEqual({
      where: { accountId: ACCOUNT }, select: { accountId: true, providerAccountFingerprint: true }, orderBy: { certificateId: 'asc' } });
    expect(db.calls.find((call) => call.read === 'livePositionOwnershipShare.count')?.args).toEqual({ where: { accountId: ACCOUNT } });
    expect(db.calls.find((call) => call.read === 'liveReconciliationState.findUnique')?.args).toEqual({
      where: { accountId: ACCOUNT }, select: { accountId: true, currentGeneration: true, healthyGeneration: true } });
    expect(snapshot).toMatchObject({ accountId: ACCOUNT, ownershipShareCount: 2, isolationRequested: 'REPEATABLE_READ',
      certificates: [{ accountId: ACCOUNT, providerAccountFingerprint: FP }], reconciliationState: { accountId: ACCOUNT, currentGeneration: 7, healthyGeneration: 6 } });
    // Exact decimals survive (no Number conversion): 18 fractional digits.
    expect(snapshot.orders.map((order) => order.orderedQuantity)).toEqual(Array(4).fill('0.123456789012345678'));
  });

  it('leaves listAccountOrderViews unchanged: same verified rows, its own single transaction, order and binding reads only', async () => {
    const { db, repository } = seeded();
    const listed = await repository.listAccountOrderViews(ACCOUNT);
    expect(db.transactions).toEqual([{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 }]);
    expect(db.calls.map((call) => call.read)).toEqual(['liveOrder.findMany', '$queryRaw']);
    const snapshot = await repository.readLineageDiagnosticSnapshot(ACCOUNT);
    expect(snapshot.orders).toEqual(listed);
  });

  it('runs the existing order-integrity checks: a tampered intent column fails the whole snapshot', async () => {
    const { db, repository } = seeded();
    db.orders[1] = { ...db.orders[1], intent: { ...(db.orders[1]?.['intent'] as Row), price: new Prisma.Decimal('1') } };
    await expect(repository.readLineageDiagnosticSnapshot(ACCOUNT)).rejects.toThrow(/LIVE_DURABLE_INTEGRITY_VIOLATION|sealed content digest/);
    const mirror = seeded();
    mirror.db.orders[0] = { ...mirror.db.orders[0], pair: 'B-ETH_USDT' };
    await expect(mirror.repository.readLineageDiagnosticSnapshot(ACCOUNT)).rejects.toThrow(/contradicts its verified immutable intent/);
  });

  it.each([...READS.filter((read) => read !== '$queryRaw')])('rejects, never returning a partial snapshot, when %s fails', async (read) => {
    const { db, repository } = seeded();
    db.failRead = read;
    await expect(repository.readLineageDiagnosticSnapshot(ACCOUNT)).rejects.toThrow(/READ_FAILED/);
  });

  it('rejects on a commit failure, and on malformed finding, certificate, count or state results', async () => {
    const commit = seeded();
    commit.db.failCommit = true;
    await expect(commit.repository.readLineageDiagnosticSnapshot(ACCOUNT)).rejects.toThrow(/COMMIT_FAILED/);
    for (const mutate of [
      (db: FakeLineageDb) => { db.findings = { rows: [] }; },
      (db: FakeLineageDb) => { db.certificates = [null]; },
      (db: FakeLineageDb) => { db.shareCount = 2n; },
      (db: FakeLineageDb) => { db.shareCount = -1; },
      (db: FakeLineageDb) => { db.state = [1]; },
    ]) {
      const { db, repository } = seeded();
      mutate(db);
      await expect(repository.readLineageDiagnosticSnapshot(ACCOUNT)).rejects.toThrow(/LIVE_DURABLE_INTEGRITY_VIOLATION|Lineage snapshot/);
    }
  });

  it('projects only selected fields and keeps rows of a collation-matched account for the exact downstream re-check', async () => {
    const { db, repository } = seeded();
    db.findings = [{ accountId: ACCOUNT, intentId: intentId(2), exchangeOrderId: null, code: 'RECON_AMBIGUOUS_CREATE_UNRESOLVED', evidenceJson: CANARY }];
    const snapshot = await repository.readLineageDiagnosticSnapshot(ACCOUNT);
    expect(snapshot.findings).toEqual([{ accountId: ACCOUNT, intentId: intentId(2), exchangeOrderId: null, code: 'RECON_AMBIGUOUS_CREATE_UNRESOLVED' }]);
    const padded = seeded();
    padded.db.exactAccountFilter = false;
    padded.db.certificates = [{ accountId: ACCOUNT.toUpperCase(), providerAccountFingerprint: FP }];
    const kept = await padded.repository.readLineageDiagnosticSnapshot(ACCOUNT);
    expect(kept.certificates).toEqual([{ accountId: ACCOUNT.toUpperCase(), providerAccountFingerprint: FP }]);
    const result = await exportOfflineLineageDiagnostic({ snapshots: padded.repository, accountId: ACCOUNT, statements: STATEMENTS, directory: destination() });
    expect(result).toEqual({ kind: 'EXPORT_REFUSED', reason: 'ROW_ACCOUNT_SCOPE_VIOLATION' });
    expect(fs.existsSync(destination())).toBe(false);
  });
});

describe('exportOfflineLineageDiagnostic (real repository, real filesystem, synthetic rows)', () => {
  it('exports a verified package containing only the allowlisted diagnostic', async () => {
    const { db, repository } = seeded();
    const port: LineageSnapshotPort = repository;
    const result = await exportOfflineLineageDiagnostic({ snapshots: port, accountId: ACCOUNT, statements: STATEMENTS, directory: destination() });
    expect(result.kind).toBe('EXPORTED');
    expect(db.transactions).toHaveLength(1);
    expect(fs.readdirSync(destination()).sort()).toEqual([LINEAGE_MANIFEST_FILE, LINEAGE_DIAGNOSTIC_FILE].sort());
    const text = fs.readFileSync(path.join(destination(), LINEAGE_DIAGNOSTIC_FILE), 'utf8');
    expect(fs.readFileSync(path.join(destination(), LINEAGE_MANIFEST_FILE), 'utf8')).toBe(`${sha(text)}  ${LINEAGE_DIAGNOSTIC_FILE}\n`);
    expect(text).not.toContain(CANARY); // neither the intent's strategy id nor any exchange id
    expect(text).not.toContain(FP);
    const readback = await readLineageDiagnosticPackage(destination());
    expect(readback.kind).toBe('VERIFIED');
    if (readback.kind !== 'VERIFIED' || result.kind !== 'EXPORTED') return;
    expect(readback.diagnosticSha256).toBe(result.diagnosticSha256);
    expect(readback.diagnostic.recordSha256).toBe(result.recordSha256);
    expect(readback.diagnostic.policyEmpty).toEqual({ ownedOrderLineage: { status: 'EMPTY_BY_POLICY', decision: 'D4' },
      closedIntentTagLineage: { status: 'EMPTY_BY_POLICY', decision: 'D2' }, ownedPositionLineage: { status: 'EMPTY_BY_POLICY', decision: 'D3' } });
    expect(readback.diagnostic.diagnostics.excluded.map((entry) => [entry.intentId, entry.reasons])).toEqual([
      [intentId(1), ['OWNED_ORDERS_DISABLED', 'RECONCILIATION_RESOLVED']], [intentId(4), ['OWNED_ORDERS_DISABLED']]]);
    expect(readback.diagnostic.ambiguousCreateCandidates.entries.map((entry) => [entry.intentId, entry.orderedQuantity])).toEqual([[intentId(2), '0.123456789012345678']]);
    expect(readback.diagnostic.diagnostics.omitted).toEqual([{ intentId: intentId(3), reason: 'CLAIM_RELEASED_UNSENT', findingCodes: [] }]);
    expect(readback.diagnostic.provenance.checkedOnSuppliedRows.certificateBinding).toBe('SUPPLIED_CERTIFICATE_ROWS_MATCH_STATEMENT');
    expect(readback.diagnostic.provenance.callerStatements.sourceCoverage).toBe('NOT_ATTESTED');
    // The persisted diagnostic is exactly the in-memory one built from the same snapshot.
    const direct = buildOfflineLineageDiagnostic({ accountId: ACCOUNT, statements: STATEMENTS, rows: {
      ...(await seeded().repository.readLineageDiagnosticSnapshot(ACCOUNT)) } as never });
    expect(direct.kind === 'OFFLINE_LINEAGE_DIAGNOSTIC' ? direct.recordSha256 : null).toBe(result.recordSha256);
  });

  it('never overwrites: a second export to the same directory fails and leaves the package byte-identical', async () => {
    const first = await exportOfflineLineageDiagnostic({ snapshots: seeded().repository, accountId: ACCOUNT, statements: STATEMENTS, directory: destination() });
    expect(first.kind).toBe('EXPORTED');
    const before = fs.readFileSync(path.join(destination(), LINEAGE_DIAGNOSTIC_FILE));
    const second = seeded();
    second.db.shareCount = 5;
    expect(await exportOfflineLineageDiagnostic({ snapshots: second.repository, accountId: ACCOUNT, statements: STATEMENTS, directory: destination() }))
      .toEqual({ kind: 'EXPORT_FAILED', stage: 'PACKAGE_WRITE_FAILED', category: 'DESTINATION_EXISTS', packageState: 'NOT_CREATED' });
    expect(fs.readFileSync(path.join(destination(), LINEAGE_DIAGNOSTIC_FILE)).equals(before)).toBe(true);
    fs.mkdirSync(destination('empty'));
    expect(await exportOfflineLineageDiagnostic({ snapshots: seeded().repository, accountId: ACCOUNT, statements: STATEMENTS, directory: destination('empty') }))
      .toMatchObject({ category: 'DESTINATION_EXISTS' });
    expect(fs.readdirSync(destination('empty'))).toEqual([]);
  });

  it('writes nothing on a snapshot read failure, an integrity failure, a commit failure, a foreign snapshot or a diagnostic refusal', async () => {
    const reading = seeded();
    reading.db.failRead = 'liveReconciliationFinding.findMany';
    const tampered = seeded();
    tampered.db.orders[0] = { ...tampered.db.orders[0], intent: { ...(tampered.db.orders[0]?.['intent'] as Row), strategyId: 'other' } };
    const committing = seeded();
    committing.db.failCommit = true;
    const foreign: LineageSnapshotPort = { readLineageDiagnosticSnapshot: async () => ({ ...(await seeded().repository.readLineageDiagnosticSnapshot(ACCOUNT)), accountId: 'other-account' }) };
    const cases: [LineageSnapshotPort, OfflineLineageDiagnosticInput['statements'], unknown][] = [
      [reading.repository, STATEMENTS, { kind: 'EXPORT_FAILED', stage: 'SNAPSHOT_READ_FAILED' }],
      [tampered.repository, STATEMENTS, { kind: 'EXPORT_FAILED', stage: 'SNAPSHOT_READ_FAILED' }],
      [committing.repository, STATEMENTS, { kind: 'EXPORT_FAILED', stage: 'SNAPSHOT_READ_FAILED' }],
      [foreign, STATEMENTS, { kind: 'EXPORT_FAILED', stage: 'SNAPSHOT_MALFORMED' }],
      [seeded().repository, { ...STATEMENTS, campaignExpectedProviderAccountFingerprint: '0f'.repeat(32) }, { kind: 'EXPORT_REFUSED', reason: 'FINGERPRINT_STATEMENTS_DISAGREE' }],
    ];
    for (const [snapshots, statements, expected] of cases) {
      const result = await exportOfflineLineageDiagnostic({ snapshots, accountId: ACCOUNT, statements, directory: destination() });
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain(CANARY);
      expect(fs.existsSync(destination())).toBe(false);
    }
  });

  it('refuses an invalid destination before reading any snapshot', async () => {
    const { db, repository } = seeded();
    expect(await exportOfflineLineageDiagnostic({ snapshots: repository, accountId: ACCOUNT, statements: STATEMENTS, directory: 'relative/package' }))
      .toEqual({ kind: 'EXPORT_FAILED', stage: 'DESTINATION_INVALID' });
    expect(db.transactions).toEqual([]);
    let reads = 0;
    const swapping = { snapshots: repository, accountId: ACCOUNT, statements: STATEMENTS,
      get directory() { reads += 1; return reads === 1 ? destination('validated') : 'relative/swapped'; } };
    expect((await exportOfflineLineageDiagnostic(swapping)).kind).toBe('EXPORTED');
    expect(reads).toBe(1);
    expect(fs.existsSync(path.join(process.cwd(), 'relative'))).toBe(false);
  });
});

describe('lineage package write-once and readback', () => {
  async function written(): Promise<string> {
    const result = await exportOfflineLineageDiagnostic({ snapshots: seeded().repository, accountId: ACCOUNT, statements: STATEMENTS, directory: destination() });
    expect(result.kind).toBe('EXPORTED');
    return destination();
  }
  const rewrite = (directory: string, file: string, text: string): void => { fs.rmSync(path.join(directory, file)); fs.writeFileSync(path.join(directory, file), text); };

  it('rejects missing files, extra files, a malformed manifest and tampering', async () => {
    const reasons: string[] = [];
    const check = async (mutate: (directory: string) => void): Promise<void> => {
      const directory = await written();
      mutate(directory);
      const result = await readLineageDiagnosticPackage(directory);
      reasons.push(result.kind === 'REJECTED' ? result.reason : 'VERIFIED');
      expect(JSON.stringify(result)).not.toContain(CANARY);
      fs.rmSync(directory, { recursive: true, force: true });
    };
    const diagnosticOf = (directory: string): Row => JSON.parse(fs.readFileSync(path.join(directory, LINEAGE_DIAGNOSTIC_FILE), 'utf8')) as Row;
    const reseal = (directory: string, value: unknown): void => {
      const text = `${JSON.stringify(value, null, 2)}\n`;
      rewrite(directory, LINEAGE_DIAGNOSTIC_FILE, text);
      rewrite(directory, LINEAGE_MANIFEST_FILE, `${sha(text)}  ${LINEAGE_DIAGNOSTIC_FILE}\n`);
    };
    await check((directory) => fs.rmSync(path.join(directory, LINEAGE_MANIFEST_FILE)));
    await check((directory) => fs.rmSync(path.join(directory, LINEAGE_DIAGNOSTIC_FILE)));
    await check((directory) => fs.writeFileSync(path.join(directory, `${CANARY}.json`), '{}'));
    await check((directory) => rewrite(directory, LINEAGE_MANIFEST_FILE, `${'0'.repeat(64)} *${LINEAGE_DIAGNOSTIC_FILE}\n`));
    await check((directory) => fs.appendFileSync(path.join(directory, LINEAGE_DIAGNOSTIC_FILE), ' '));
    await check((directory) => reseal(directory, { ...diagnosticOf(directory), accountId: CANARY }));
    await check((directory) => reseal(directory, { ...diagnosticOf(directory), ownedOrders: [] }));
    await check((directory) => reseal(directory, { ...diagnosticOf(directory), engineInput: 'PERMITTED' }));
    await check((directory) => { const text = `${CANARY}\n`; rewrite(directory, LINEAGE_DIAGNOSTIC_FILE, text); rewrite(directory, LINEAGE_MANIFEST_FILE, `${sha(text)}  ${LINEAGE_DIAGNOSTIC_FILE}\n`); });
    expect(reasons).toEqual(['INCOMPLETE', 'FILE_SET_INVALID', 'FILE_SET_INVALID', 'MANIFEST_MALFORMED', 'DIGEST_MISMATCH',
      'RECORD_DIGEST_MISMATCH', 'DIAGNOSTIC_MALFORMED', 'DIAGNOSTIC_MALFORMED', 'DIAGNOSTIC_MALFORMED']);
    expect(await readLineageDiagnosticPackage(destination('missing'))).toEqual({ kind: 'REJECTED', reason: 'UNREADABLE' });
    expect(await readLineageDiagnosticPackage('relative')).toEqual({ kind: 'REJECTED', reason: 'PATH_INVALID' });
  });

  it('never accepts a package whose write failed part-way, and reports the incomplete state', async () => {
    const snapshot = await seeded().repository.readLineageDiagnosticSnapshot(ACCOUNT);
    const diagnostic = buildOfflineLineageDiagnostic({ accountId: ACCOUNT, statements: STATEMENTS, rows: { ...snapshot } as never });
    if (diagnostic.kind !== 'OFFLINE_LINEAGE_DIAGNOSTIC') throw new Error('synthetic diagnostic refused');
    let writes = 0;
    const failingManifest: LineagePackageFileSystem = { ...nodeLineagePackageFileSystem, async writeNewFile(file, text) {
      writes += 1;
      if (writes === 2) throw new Error(`DISK_FULL ${CANARY}`);
      await nodeLineagePackageFileSystem.writeNewFile(file, text);
    } };
    const result = await writeLineageDiagnosticPackage(destination(), diagnostic, failingManifest);
    expect(result).toEqual({ kind: 'WRITE_FAILED', category: 'WRITE_FAILED', packageState: 'INCOMPLETE_OR_UNVERIFIED' });
    expect(await readLineageDiagnosticPackage(destination())).toEqual({ kind: 'REJECTED', reason: 'INCOMPLETE' });
    const failingDirectory: LineagePackageFileSystem = { ...nodeLineagePackageFileSystem, async makeDirectory() { throw Object.assign(new Error(CANARY), { code: 'EACCES' }); } };
    expect(await writeLineageDiagnosticPackage(destination('denied'), diagnostic, failingDirectory))
      .toEqual({ kind: 'WRITE_FAILED', category: 'DIRECTORY_CREATE_FAILED', packageState: 'NOT_CREATED' });
    const lyingReadback: LineagePackageFileSystem = { ...nodeLineagePackageFileSystem, async readText(file) {
      return file.endsWith(LINEAGE_DIAGNOSTIC_FILE) ? `${CANARY}\n` : nodeLineagePackageFileSystem.readText(file);
    } };
    expect(await writeLineageDiagnosticPackage(destination('lying'), diagnostic, lyingReadback))
      .toEqual({ kind: 'WRITE_FAILED', category: 'READBACK_FAILED', packageState: 'INCOMPLETE_OR_UNVERIFIED' });
    expect(await writeLineageDiagnosticPackage(destination('complete'), diagnostic)).toMatchObject({ kind: 'WRITTEN' });
    const linked: LineagePackageFileSystem = { ...nodeLineagePackageFileSystem, async describe() { return { regularFile: false, size: 1 }; } };
    expect(await readLineageDiagnosticPackage(destination('complete'), linked)).toEqual({ kind: 'REJECTED', reason: 'NOT_REGULAR_FILE' });
    const oversized: LineagePackageFileSystem = { ...nodeLineagePackageFileSystem, async describe() { return { regularFile: true, size: 9 * 1024 * 1024 }; } };
    expect(await readLineageDiagnosticPackage(destination('complete'), oversized)).toEqual({ kind: 'REJECTED', reason: 'TOO_LARGE' });
    expect(await writeLineageDiagnosticPackage(destination('linked'), diagnostic, linked)).toMatchObject({ category: 'READBACK_FAILED' });
    expect(await writeLineageDiagnosticPackage(destination('shape'), { ...diagnostic, ownedOrders: [] } as never))
      .toEqual({ kind: 'WRITE_FAILED', category: 'DESTINATION_INVALID', packageState: 'NOT_CREATED' });
    expect(fs.existsSync(destination('shape'))).toBe(false);
  });
});
