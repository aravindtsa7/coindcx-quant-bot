import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineageSnapshotPort } from '../../../src/execution/live/ownership-lineage-export';
import { nodeLineagePackageFileSystem, readLineageDiagnosticPackage } from '../../../src/execution/live/ownership-lineage-export';

const prismaSpies = vi.hoisted(() => ({ construct: vi.fn(), raw: vi.fn(), close: vi.fn() }));
vi.mock('@prisma/client', async importOriginal => ({
  ...await importOriginal<object>(),
  PrismaClient: class {
    constructor(options: unknown) { prismaSpies.construct(options); }
    $queryRaw = prismaSpies.raw;
    $disconnect = prismaSpies.close;
  },
}));
import {
  createOwnedLineageDatabase, lineageEntry, nodeLineageDependencies, readLineageCheckout,
  requireNoPrismaEnvDiscovery, runLineageInvocation, validateLineageOutput, type CheckoutFacts, type LineageEntryDependencies,
  type LineageInvocation,
} from '../../../scripts/m4-lineage-export';

// Only fake DB factories and synthetic local files. Never resolve an ambient database URL or a credential source.
const SECRET = 'mysql://synthetic-user:SYNTHETIC_SECRET@synthetic.invalid/export_copy';
const CANARY = 'SYNTHETIC_RAW_ROW_CANARY';
const UUID = '11111111-1111-1111-1111-111111111111';
const MIGRATION = '20260920000000_phase17_live_execution';
const FP = 'ab'.repeat(32);
const INPUT: LineageInvocation = {
  kind: 'M4_OFFLINE_LINEAGE_EXPORT', target: { serverUuid: UUID, databaseName: 'export_copy' },
  protectedStore: { version: 2, identities: [{ serverUuid: UUID, databaseName: 'original_store' },
    { serverUuid: UUID, databaseName: 'another_original' }], inventorySha256: 'cd'.repeat(32),
    review: 'OPERATOR_VERIFIED_ORIGINAL_STORE_IDENTITIES' },
  databaseUrlEnvironmentVariable: 'M4_LINEAGE_DATABASE_URL', accountId: 'synthetic-account', campaignAccountId: 'synthetic-account',
  expectedProviderAccountFingerprint: FP, campaignExpectedProviderAccountFingerprint: FP, sourceCoverage: 'NOT_ATTESTED',
  sourceCommit: 'a1'.repeat(20), outputName: 'synthetic-package',
};
const CHECKOUT: CheckoutFacts = { sourceCommit: INPUT.sourceCommit, clean: true,
  migrations: [{ name: MIGRATION, checksum: 'ef'.repeat(32) }], lockSha256: '01'.repeat(32) };
const applied = () => [{ migrationName: MIGRATION, checksum: 'ef'.repeat(32), finishedAt: new Date(0), rolledBackAt: null }];
const emptySnapshot = (): Awaited<ReturnType<LineageSnapshotPort['readLineageDiagnosticSnapshot']>> => ({
  accountId: INPUT.accountId, orders: [], findings: [], certificates: [], reconciliationState: null, ownershipShareCount: 0,
});
let root: string;
let approved: string;
function fixture() {
  const calls: string[] = [];
  const identity = vi.fn(async (): Promise<unknown> => { calls.push('identity'); return [INPUT.target]; });
  const migrations = vi.fn(async (): Promise<unknown> => { calls.push('migrations'); return applied(); });
  const snapshot = vi.fn(async (): Promise<Awaited<ReturnType<LineageSnapshotPort['readLineageDiagnosticSnapshot']>>> => {
    calls.push('snapshot'); return emptySnapshot();
  });
  const close = vi.fn(async () => { calls.push('close'); });
  const snapshots = vi.fn(() => { calls.push('repository'); return { readLineageDiagnosticSnapshot: snapshot }; });
  const create = vi.fn(() => { calls.push('create'); return { readIdentity: identity, readAppliedMigrations: migrations, snapshots, close }; });
  const deps: LineageEntryDependencies = {
    root, verifyProtectedStoreInventory: vi.fn(async () => { calls.push('inventory'); return true; }),
    readCheckout: vi.fn(async () => { calls.push('checkout'); return structuredClone(CHECKOUT); }),
    validateOutput: vi.fn(async name => { calls.push('output'); return path.join(approved, name); }),
    readDatabaseUrl: vi.fn(() => { calls.push('url'); return `${SECRET}?connection_limit=1&connect_timeout=5&pool_timeout=5`; }),
    createOwnedDatabase: create, readInput: vi.fn(async () => structuredClone(INPUT)),
  };
  return { calls, deps, create, identity, migrations, snapshot, close, snapshots };
}
beforeEach(() => {
  vi.clearAllMocks();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'm4-lineage-synthetic-')));
  approved = path.join(root, '.local', 'm4-lineage-exports');
  fs.mkdirSync(approved, { recursive: true });
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('explicit controlled lineage invocation', () => {
  it('imports without constructing any Prisma client or resolving environment inputs', async () => {
    await import('../../../scripts/m4-lineage-export');
    expect(prismaSpies.construct).not.toHaveBeenCalled();
    expect(prismaSpies.raw).not.toHaveBeenCalled();
    expect(prismaSpies.close).not.toHaveBeenCalled();
  });
  it.each([[], ['--input'], ['--input', 'relative.json'], ['--input', path.resolve('synthetic.json'), '--extra']].map(args => ({ args })))(
    'requires exactly an explicit absolute input path: $args', async ({ args }) => {
      const f = fixture();
      expect((await lineageEntry(args, f.deps)).failure).toBe('INPUT_INVALID');
      expect(f.deps.readInput).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
    });
  it.each([
    null, {}, { ...INPUT, accountId: '' }, { ...INPUT, accountId: 'bad account' },
    { ...INPUT, campaignAccountId: 'different' }, { ...INPUT, campaignExpectedProviderAccountFingerprint: '00'.repeat(32) },
    { ...INPUT, sourceCoverage: undefined },
    { ...INPUT, target: { ...INPUT.target, serverUuid: 'unknown' } },
    { ...INPUT, outputName: '../escape' }, { ...INPUT, databaseUrlEnvironmentVariable: 'DATABASE_URL' }, { ...INPUT, unexpected: SECRET },
    { ...INPUT, outputName: 'con' }, { ...INPUT, outputName: 'nul' },
  ])('refuses malformed/missing operator inputs before any dependency access (%#)', async raw => {
    const f = fixture(); expect((await runLineageInvocation(raw, f.deps)).failure).toBe('INPUT_INVALID');
    expect(f.calls).toEqual([]);
  });
  it('excludes the original schema even with a different server or case', async () => {
    const f = fixture();
    const raw = structuredClone(INPUT); raw.target.databaseName = 'ORIGINAL_STORE'; raw.target.serverUuid = '22222222-2222-2222-2222-222222222222';
    expect((await runLineageInvocation(raw, f.deps)).failure).toBe('PROTECTED_STORE_NOT_EXCLUDED');
    expect(f.calls).toEqual([]);
  });
  it.each(['coindcx_shadow', 'COINDCX_SHADOW', 'CoInDcX_ShAdOw', 'coindcx_quant', 'COINDCX_QUANT', 'CoInDcX_QuAnT'])(
    'always excludes known protected schema %s even when the operator list omits both known names', async databaseName => {
      for (const serverUuid of [UUID, '22222222-2222-2222-2222-222222222222']) {
        const f = fixture();
        const result = await runLineageInvocation({ ...INPUT, target: { serverUuid, databaseName } }, f.deps);
        expect(result).toMatchObject({ failure: 'PROTECTED_STORE_NOT_EXCLUDED', cleanup: 'NOT_CREATED', export: null });
        expect(f.calls).toEqual([]); expect(fs.readdirSync(approved)).toEqual([]);
      }
    });
  it.each([0, 1, 2])('checks a protected identity at list position %s across servers and cases', async position => {
    const raw = structuredClone(INPUT);
    raw.protectedStore.identities = [0, 1, 2].map(n => ({ serverUuid: UUID, databaseName: `original_${n}` }));
    raw.protectedStore.identities[position] = { serverUuid: '22222222-2222-2222-2222-222222222222', databaseName: 'EXPORT_COPY' };
    const f = fixture();
    expect((await runLineageInvocation(raw, f.deps)).failure).toBe('PROTECTED_STORE_NOT_EXCLUDED');
    expect(f.calls).toEqual([]); expect(fs.readdirSync(approved)).toEqual([]);
  });
  it.each([
    undefined, {}, { identity: INPUT.protectedStore.identities[0], inventorySha256: 'cd'.repeat(32), review: 'OPERATOR_VERIFIED_ORIGINAL_STORE_IDENTITY' },
    { ...INPUT.protectedStore, version: undefined }, { ...INPUT.protectedStore, version: 1 },
    { ...INPUT.protectedStore, version: 3 }, { ...INPUT.protectedStore, identities: [] },
    { ...INPUT.protectedStore, identities: undefined }, { ...INPUT.protectedStore, review: 'NOT_VERIFIED' },
    { ...INPUT.protectedStore, inventorySha256: 'bad' }, { ...INPUT.protectedStore, identities: 'not-an-array' },
    { ...INPUT.protectedStore, identities: [INPUT.protectedStore.identities[0], { serverUuid: UUID }] },
    { ...INPUT.protectedStore, identities: [null] },
    { ...INPUT.protectedStore, identities: [{ serverUuid: 'unknown', databaseName: 'old' }] },
    { ...INPUT.protectedStore, identities: [{ serverUuid: UUID, databaseName: '../old' }] },
    { ...INPUT.protectedStore, identities: [{ serverUuid: UUID, databaseName: 'old', unsupported: true }] },
    { ...INPUT.protectedStore, identities: [{ serverUuid: UUID, databaseName: 'old' }, { serverUuid: UUID, databaseName: 'OLD' }] },
  ])('refuses invalid/legacy/incomplete inventories with a fixed actionable message (%#)', async protectedStore => {
    const f = fixture();
    const result = await runLineageInvocation({ ...INPUT, protectedStore }, f.deps);
    expect(result).toMatchObject({ kind: 'FAILED', failure: 'PROTECTED_INVENTORY_INVALID', cleanup: 'NOT_CREATED', export: null });
    expect(result.message).toContain('version 2'); expect(result.message).toContain('recompute inventorySha256');
    expect(f.calls).toEqual([]); expect(fs.readdirSync(approved)).toEqual([]);
  });
  it.each([0, 1, 2])('validates a malformed inventory entry at list position %s before any dependency call', async position => {
    const identities: unknown[] = [0, 1, 2].map(n => ({ serverUuid: UUID, databaseName: `original_${n}` }));
    identities[position] = { serverUuid: UUID, databaseName: '' };
    const f = fixture();
    expect((await runLineageInvocation({ ...INPUT, protectedStore: { ...INPUT.protectedStore, identities } }, f.deps)).failure)
      .toBe('PROTECTED_INVENTORY_INVALID');
    expect(f.calls).toEqual([]);
  });
  it('allows an unrelated synthetic candidate on the same UUID as multiple protected identities', async () => {
    const f = fixture(), raw = structuredClone(INPUT);
    raw.protectedStore.identities = ['coindcx_shadow', 'coindcx_quant', 'custom_original'].map(databaseName => ({ serverUuid: UUID, databaseName }));
    const result = await runLineageInvocation(raw, f.deps);
    expect(result).toMatchObject({ kind: 'COMPLETED', cleanup: 'CLOSED', export: { kind: 'EXPORTED' } });
    expect(f.snapshot).toHaveBeenCalledWith('synthetic-account'); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('refuses unverifiable protected-store evidence before checkout, URL or database access', async () => {
    const f = fixture(); f.deps.verifyProtectedStoreInventory = vi.fn(async () => false);
    expect((await runLineageInvocation(INPUT, f.deps)).failure).toBe('PROTECTED_STORE_NOT_EXCLUDED');
    expect(f.create).not.toHaveBeenCalled(); expect(f.deps.readCheckout).not.toHaveBeenCalled();
    expect(f.deps.readDatabaseUrl).not.toHaveBeenCalled();
  });
  it.each(['dirty', 'commit', 'hash', 'empty', 'duplicate'])('refuses invalid checkout %s before URL access', async kind => {
    const f = fixture(), facts = structuredClone(CHECKOUT);
    f.deps.readCheckout = vi.fn(async () => kind === 'dirty' ? { ...facts, clean: false }
      : kind === 'commit' ? { ...facts, sourceCommit: 'b2'.repeat(20) }
        : kind === 'hash' ? { ...facts, lockSha256: 'bad' }
          : { ...facts, migrations: kind === 'empty' ? [] : [...facts.migrations, ...facts.migrations] });
    expect((await runLineageInvocation(INPUT, f.deps)).failure).toBe('CHECKOUT_INVALID');
    expect(f.create).not.toHaveBeenCalled(); expect(f.deps.readDatabaseUrl).not.toHaveBeenCalled();
  });
  it.each([undefined, '', SECRET, `${SECRET}?connection_limit=2&connect_timeout=5&pool_timeout=5`,
    `${SECRET}?connection_limit=1&connect_timeout=0&pool_timeout=5`,
    `${SECRET}?connection_limit=1&connect_timeout=5&pool_timeout=5&socket=synthetic`,
    `${SECRET}?connection_limit=1&connect_timeout=5&pool_timeout=5&connection_limit=1`,
    'mysql://synthetic-user:synthetic@synthetic.invalid/other?connection_limit=1&connect_timeout=5&pool_timeout=5'])(
    'refuses missing/unbounded/redirecting/mismatched DB URLs before constructing a client (%#)', async url => {
    const f = fixture(); f.deps.readDatabaseUrl = vi.fn(() => url);
    expect((await runLineageInvocation(INPUT, f.deps)).failure).toBe('DATABASE_URL_INVALID');
    expect(f.create).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });
  it.each([[], [INPUT.target, INPUT.target], [{ ...INPUT.target, databaseName: 'original_store' }],
    [{ ...INPUT.target, databaseName: 'coindcx_shadow' }], [{ ...INPUT.target, databaseName: 'COINDCX_QUANT' }],
    [{ ...INPUT.target, databaseName: 'foreign_candidate' }],
    [{ ...INPUT.target, serverUuid: '22222222-2222-2222-2222-222222222222' }], [{ databaseName: 'export_copy' }]].map(observed => ({ observed })))(
    'identity preflight failure cannot construct repository or read account rows (%#)', async ({ observed }) => {
    const f = fixture(); f.identity.mockResolvedValue(observed);
    const result = await runLineageInvocation(INPUT, f.deps);
    expect(result.failure).toBe('IDENTITY_PREFLIGHT_FAILED'); expect(result.cleanup).toBe('CLOSED');
    expect(f.migrations).not.toHaveBeenCalled(); expect(f.snapshots).not.toHaveBeenCalled();
    expect(f.snapshot).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(approved)).toEqual([]);
  });
  it.each(['empty', 'checksum', 'unfinished', 'rolledback', 'extra', 'duplicate', 'unknown'])(
    'migration preflight %s cannot read account rows', async kind => {
    const f = fixture(), rows = applied();
    const observed = kind === 'empty' ? [] : kind === 'checksum' ? [{ ...rows[0], checksum: '00'.repeat(32) }]
      : kind === 'unfinished' ? [{ ...rows[0], finishedAt: null }]
        : kind === 'rolledback' ? [{ ...rows[0], rolledBackAt: new Date(0) }]
          : kind === 'unknown' ? [{ ...rows[0], migrationName: 'unknown' }]
            : [...rows, { ...rows[0], migrationName: kind === 'duplicate' ? MIGRATION : 'extra' }];
    f.migrations.mockResolvedValue(observed);
    expect((await runLineageInvocation(INPUT, f.deps)).failure).toBe('MIGRATION_PREFLIGHT_FAILED');
    expect(f.snapshots).not.toHaveBeenCalled(); expect(f.snapshot).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('does not silently accept an LF-normalized checksum instead of the checkout working-copy byte checksum', async () => {
    const f = fixture(), sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const workingCopy = sha('-- SYNTHETIC\r\n'), lfBaseline = sha('-- SYNTHETIC\n');
    expect(workingCopy).not.toBe(lfBaseline);
    f.deps.readCheckout = async () => ({ ...CHECKOUT, migrations: [{ name: MIGRATION, checksum: workingCopy }] });
    f.migrations.mockResolvedValue([{ ...applied()[0], checksum: lfBaseline }]);
    expect(await runLineageInvocation(INPUT, f.deps)).toMatchObject({ failure: 'MIGRATION_PREFLIGHT_FAILED', cleanup: 'CLOSED' });
    expect(f.snapshot).not.toHaveBeenCalled(); expect(fs.readdirSync(approved)).toEqual([]);
  });
  it('composes the existing export and readback, keeps binding statements distinct, and closes only its own resource', async () => {
    const f = fixture();
    const result = await runLineageInvocation(INPUT, f.deps);
    expect(result).toMatchObject({ kind: 'COMPLETED', failure: null, cleanup: 'CLOSED', export: { kind: 'EXPORTED' } });
    expect(f.calls).toEqual(['inventory', 'checkout', 'output', 'url', 'create', 'identity', 'migrations', 'repository', 'snapshot', 'output', 'close']);
    expect(f.snapshot).toHaveBeenCalledWith(INPUT.accountId);
    const readback = await readLineageDiagnosticPackage(path.join(approved, INPUT.outputName));
    expect(readback.kind).toBe('VERIFIED');
    if (readback.kind !== 'VERIFIED') throw new Error();
    expect(readback.diagnostic.provenance.callerStatements).toMatchObject({ sourceCoverage: 'NOT_ATTESTED',
      fingerprintStatements: 'STATEMENTS_AGREE_BINDS_NOTHING', expectedFingerprintPrefix: FP.slice(0, 12) });
    expect(readback.diagnostic.provenance.notEstablished).toContain('DATABASE_IDENTITY');
    expect(readback.diagnostic.provenance.notEstablished).toContain('ACCOUNT_WIDE_ABSENCE');
    expect(JSON.stringify(result)).not.toContain(FP);
    const again = await runLineageInvocation(INPUT, f.deps);
    expect(again.export).toMatchObject({ stage: 'PACKAGE_WRITE_FAILED', category: 'DESTINATION_EXISTS' });
  });
  it.each(['input', 'inventory', 'checkout', 'output', 'url', 'create', 'identity', 'migrations', 'repository', 'snapshot', 'write', 'readback', 'close'])(
    'handles %s exceptions with safe errors and owned cleanup', async stage => {
    const f = fixture(), error = new Error(`${SECRET} ${CANARY} ${FP}`);
    if (stage === 'input') f.deps.readInput = vi.fn(async () => { throw error; });
    if (stage === 'inventory') f.deps.verifyProtectedStoreInventory = vi.fn(async () => { throw error; });
    if (stage === 'checkout') f.deps.readCheckout = vi.fn(async () => { throw error; });
    if (stage === 'output') f.deps.validateOutput = vi.fn(async () => { throw error; });
    if (stage === 'url') f.deps.readDatabaseUrl = vi.fn(() => { throw error; });
    if (stage === 'create') f.deps.createOwnedDatabase = vi.fn(() => { throw error; });
    if (stage === 'identity') f.identity.mockRejectedValue(error);
    if (stage === 'migrations') f.migrations.mockRejectedValue(error);
    if (stage === 'repository') f.snapshots.mockImplementation(() => { throw error; });
    if (stage === 'snapshot') f.snapshot.mockRejectedValue(error);
    if (stage === 'close') f.close.mockRejectedValue(error);
    if (stage === 'write' || stage === 'readback') Object.assign(f.deps, { packageFileSystem: { ...nodeLineagePackageFileSystem,
      ...(stage === 'write' ? { writeNewFile: async () => { throw error; } } : { readText: async () => { throw error; } }) } });
    const result = await lineageEntry(['--input', path.join(approved, 'input.json')], f.deps);
    expect(result.kind).toBe('FAILED');
    const allocated = ['identity', 'migrations', 'repository', 'snapshot', 'write', 'readback', 'close'].includes(stage);
    expect(f.close).toHaveBeenCalledTimes(allocated ? 1 : 0);
    expect(JSON.stringify(result)).not.toMatch(/mysql:|SYNTHETIC_SECRET|SYNTHETIC_RAW_ROW_CANARY/);
    expect(JSON.stringify(result)).not.toContain(FP);
    if (stage === 'write' || stage === 'readback') {
      expect(result.export).toMatchObject({ stage: 'PACKAGE_WRITE_FAILED', packageState: 'INCOMPLETE_OR_UNVERIFIED' });
      expect(fs.existsSync(path.join(approved, INPUT.outputName))).toBe(true);
    }
    if (stage === 'close') expect(result).toMatchObject({ failure: 'CLEANUP_FAILED', cleanup: 'FAILED', export: { kind: 'EXPORTED' } });
  });
  it('retains the first failure if cleanup also fails', async () => {
    const f = fixture(); f.identity.mockRejectedValue(new Error(SECRET)); f.close.mockRejectedValue(new Error(CANARY));
    expect(await runLineageInvocation(INPUT, f.deps)).toMatchObject({ failure: 'IDENTITY_PREFLIGHT_FAILED', cleanup: 'FAILED' });
  });
  it.each(['foreign', 'certificate', 'malformed'])('cleans up a %s snapshot refusal with no package', async kind => {
    const f = fixture(), snapshot = emptySnapshot();
    f.snapshot.mockResolvedValue(kind === 'foreign' ? { ...snapshot, accountId: 'foreign-account' }
      : kind === 'certificate' ? { ...snapshot, certificates: [{ accountId: INPUT.accountId, providerAccountFingerprint: '00'.repeat(32) }] }
        : { ...snapshot, ownershipShareCount: -1 });
    expect((await runLineageInvocation(INPUT, f.deps)).kind).toBe('FAILED');
    expect(f.close).toHaveBeenCalledTimes(1); expect(fs.readdirSync(approved)).toEqual([]);
  });
  it('does not let a caller mutate checked inputs across awaits', async () => {
    const f = fixture(), input = structuredClone(INPUT);
    f.deps.readCheckout = async () => { input.accountId = CANARY; input.target.databaseName = 'original_store'; return CHECKOUT; };
    expect((await runLineageInvocation(input, f.deps)).kind).toBe('COMPLETED');
    expect(f.snapshot).toHaveBeenCalledWith(INPUT.accountId);
  });
  it('uses the real factory only over a mocked Prisma class, fixed metadata SQL, and a fresh owned client', async () => {
    const owned = await createOwnedLineageDatabase(SECRET);
    expect(prismaSpies.construct).toHaveBeenCalledWith({ datasourceUrl: SECRET, log: [], errorFormat: 'minimal' });
    await owned.readIdentity(); await owned.readAppliedMigrations();
    const sql = prismaSpies.raw.mock.calls.map(call => (call[0] as TemplateStringsArray).join('')).join('\n');
    expect(sql).toContain('@@server_uuid'); expect(sql).toContain('FROM _prisma_migrations');
    expect(sql).not.toMatch(/live_|INSERT|UPDATE|DELETE|ALTER|SET /);
    expect(owned.snapshots()).toHaveProperty('readLineageDiagnosticSnapshot');
    await owned.close(); expect(prismaSpies.close).toHaveBeenCalledTimes(1);
  });
  it('refuses generated Prisma env discovery before client loading, without reading any env file', () => {
    expect(() => requireNoPrismaEnvDiscovery('"relativeEnvPaths": {"rootEnvPath":null}')).not.toThrow();
    for (const source of ['', '"relativeEnvPaths": {"rootEnvPath":".env"}',
      '"relativeEnvPaths": {"schemaEnvPath":"../.env"}', '"relativeEnvPaths": {"other":".env"}']) {
      expect(() => requireNoPrismaEnvDiscovery(source)).toThrow();
    }
    expect(prismaSpies.construct).not.toHaveBeenCalled();
  });
});

function git(args: string[]) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim(); }
function syntheticGit() {
  git(['init', '--quiet']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.local/\n');
  const migration = path.join(root, 'prisma', 'migrations', MIGRATION);
  fs.mkdirSync(migration, { recursive: true }); fs.writeFileSync(path.join(migration, 'migration.sql'), '-- synthetic SQL only\n');
  fs.writeFileSync(path.join(root, 'prisma', 'migrations', 'migration_lock.toml'), 'provider = "mysql"\n');
  git(['add', '.']);
  git(['-c', 'user.name=Offline Synthetic', '-c', 'user.email=offline@example.invalid', '-c', 'core.hooksPath=.no-hooks',
    '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'synthetic fixture']);
}
describe('synthetic filesystem and checkout validation', () => {
  it('rechecks output custody after the snapshot and refuses a parent replaced by a junction before package creation', async () => {
    syntheticGit();
    const f = fixture(), outside = path.join(root, 'outside-approved-storage');
    fs.mkdirSync(outside);
    f.deps.validateOutput = name => validateLineageOutput(root, name);
    f.snapshot.mockImplementation(async () => {
      fs.renameSync(approved, `${approved}-saved`);
      fs.symlinkSync(outside, approved, process.platform === 'win32' ? 'junction' : 'dir');
      return emptySnapshot();
    });
    expect(await runLineageInvocation(INPUT, f.deps)).toMatchObject({ kind: 'FAILED', cleanup: 'CLOSED',
      export: { stage: 'PACKAGE_WRITE_FAILED', category: 'DIRECTORY_CREATE_FAILED', packageState: 'NOT_CREATED' } });
    expect(fs.readdirSync(outside)).toEqual([]); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('refuses ambient dependency tracing and reads only the explicit synthetic URL variable', () => {
    const deps = nodeLineageDependencies(root);
    vi.stubEnv('DEBUG', ''); vi.stubEnv('RUST_LOG', ''); vi.stubEnv('PRISMA_LOG_LEVEL', '');
    vi.stubEnv('M4_LINEAGE_DATABASE_URL', SECRET);
    expect(deps.readDatabaseUrl('M4_LINEAGE_DATABASE_URL')).toBe(SECRET);
    for (const name of ['DEBUG', 'RUST_LOG', 'PRISMA_LOG_LEVEL']) {
      vi.stubEnv(name, 'synthetic-debug'); expect(deps.readDatabaseUrl('M4_LINEAGE_DATABASE_URL')).toBeUndefined(); vi.stubEnv(name, '');
    }
  });
  it('requires inventory bytes matching the reviewed digest and all protected identities, with no credential discovery', async () => {
    const deps = nodeLineageDependencies(root), statement = structuredClone(INPUT.protectedStore);
    await expect(deps.verifyProtectedStoreInventory(statement)).rejects.toThrow();
    const bytes = JSON.stringify({ kind: 'M4_PROTECTED_ORIGINAL_STORE_INVENTORY', version: 2,
      identities: [...statement.identities].reverse(), review: statement.review });
    fs.writeFileSync(path.join(approved, 'protected-store-inventory.json'), bytes);
    expect(await deps.verifyProtectedStoreInventory(statement)).toBe(false);
    statement.inventorySha256 = createHash('sha256').update(bytes).digest('hex');
    expect(await deps.verifyProtectedStoreInventory(statement)).toBe(true);
    statement.identities[1]!.databaseName = 'different'; expect(await deps.verifyProtectedStoreInventory(statement)).toBe(false);
  });
  it.each(['legacy', 'version', 'kind', 'empty', 'duplicate', 'malformed-first', 'malformed-middle', 'malformed-last',
    'missing-entry', 'foreign-uuid', 'foreign-schema', 'bad-json'])(
    'rejects inventory-file %s before connection or account reads even when its byte digest matches', async kind => {
      const f = fixture(), input = structuredClone(INPUT);
      const identities = structuredClone(input.protectedStore.identities);
      if (kind === 'foreign-uuid') identities[1]!.serverUuid = '22222222-2222-2222-2222-222222222222';
      if (kind === 'foreign-schema') identities[1]!.databaseName = 'different';
      const inventory = kind === 'legacy' ? { kind: 'M4_PROTECTED_ORIGINAL_STORE_INVENTORY', identity: identities[0], review: 'OPERATOR_VERIFIED_ORIGINAL_STORE_IDENTITY' }
        : { kind: kind === 'kind' ? 'UNSUPPORTED' : 'M4_PROTECTED_ORIGINAL_STORE_INVENTORY', version: kind === 'version' ? 3 : 2,
          identities: kind === 'empty' ? [] : kind === 'duplicate' ? [...identities, identities[0]]
            : kind === 'malformed-first' ? [{}, ...identities] : kind === 'malformed-middle' ? [identities[0], {}, identities[1]]
              : kind === 'malformed-last' ? [...identities, {}]
            : kind === 'missing-entry' ? identities.slice(0, 1) : identities,
          review: input.protectedStore.review };
      const bytes = kind === 'bad-json' ? '{invalid' : JSON.stringify(inventory);
      fs.writeFileSync(path.join(approved, 'protected-store-inventory.json'), bytes);
      input.protectedStore.inventorySha256 = createHash('sha256').update(bytes).digest('hex');
      f.deps.verifyProtectedStoreInventory = nodeLineageDependencies(root).verifyProtectedStoreInventory;
      const result = await runLineageInvocation(input, f.deps);
      expect(result).toMatchObject({ kind: 'FAILED', cleanup: 'NOT_CREATED', export: null,
        failure: ['missing-entry', 'foreign-uuid', 'foreign-schema'].includes(kind) ? 'PROTECTED_STORE_NOT_EXCLUDED' : 'PROTECTED_INVENTORY_INVALID' });
      if (result.failure === 'PROTECTED_INVENTORY_INVALID') expect(result.message).toContain('version 2');
      expect(f.calls).toEqual([]); expect(f.create).not.toHaveBeenCalled(); expect(f.snapshot).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(approved, INPUT.outputName))).toBe(false);
    });
  it('reads source-bound migration file checksums and clean Git identity, and validates fresh ignored output', async () => {
    syntheticGit();
    const facts = await readLineageCheckout(root);
    expect(facts).toMatchObject({ sourceCommit: git(['rev-parse', 'HEAD']), clean: true,
      migrations: [{ name: MIGRATION, checksum: createHash('sha256').update('-- synthetic SQL only\n').digest('hex') }] });
    expect(await validateLineageOutput(root, 'fresh')).toBe(path.join(approved, 'fresh'));
    fs.mkdirSync(path.join(approved, 'fresh'));
    await expect(validateLineageOutput(root, 'fresh')).rejects.toThrow();
  });
  it('refuses a negated ignore rule, tracked output, traversal, missing approved parent and junction escape', async () => {
    syntheticGit();
    fs.writeFileSync(path.join(root, '.gitignore'), '.local/*\n!.local/m4-lineage-exports/\n');
    await expect(validateLineageOutput(root, 'fresh')).rejects.toThrow();
    fs.writeFileSync(path.join(root, '.gitignore'), '.local/\n');
    fs.writeFileSync(path.join(approved, 'tracked'), 'synthetic'); git(['add', '-f', '.local/m4-lineage-exports/tracked']);
    await expect(validateLineageOutput(root, 'tracked')).rejects.toThrow();
    await expect(validateLineageOutput(root, '../escape')).rejects.toThrow();
    fs.renameSync(approved, `${approved}-saved`);
    await expect(validateLineageOutput(root, 'fresh')).rejects.toThrow();
    fs.symlinkSync(`${approved}-saved`, approved, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(validateLineageOutput(root, 'fresh')).rejects.toThrow();
  });
  it('accepts only bounded non-secret JSON files directly under approved local storage', async () => {
    syntheticGit(); const deps = nodeLineageDependencies(root), file = path.join(approved, 'input.json');
    fs.writeFileSync(file, JSON.stringify(INPUT)); expect(await deps.readInput(file)).toEqual(INPUT);
    await expect(deps.readInput(path.join(root, 'outside.json'))).rejects.toThrow();
    await expect(deps.readInput(path.join(approved, 'file.env'))).rejects.toThrow();
    fs.writeFileSync(file, 'x'.repeat(65537)); await expect(deps.readInput(file)).rejects.toThrow();
    fs.writeFileSync(file, '{bad'); await expect(deps.readInput(file)).rejects.toThrow();
  });
});
