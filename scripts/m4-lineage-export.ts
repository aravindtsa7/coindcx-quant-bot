/** Explicit offline-diagnostic composition only. Importing this module does no I/O or client construction. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  exportOfflineLineageDiagnostic, nodeLineagePackageFileSystem, type LineagePackageFileSystem, type LineageSnapshotPort,
  type OfflineLineageExportRequest, type OfflineLineageExportResult,
} from '../src/execution/live/ownership-lineage-export';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const identity = z.object({
  serverUuid: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  databaseName: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
}).strict();
const account = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const outputName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/)
  .refine(name => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name));
const inputSchema = z.object({
  kind: z.literal('M4_OFFLINE_LINEAGE_EXPORT'),
  target: identity,
  // This is a REQUIRED operator-reviewed inventory, not a discovery of the original store or issuer proof.
  protectedStore: z.object({
    identity,
    inventorySha256: hash,
    review: z.literal('OPERATOR_VERIFIED_ORIGINAL_STORE_IDENTITY'),
  }).strict(),
  databaseUrlEnvironmentVariable: z.literal('M4_LINEAGE_DATABASE_URL'),
  accountId: account,
  campaignAccountId: account,
  expectedProviderAccountFingerprint: hash,
  campaignExpectedProviderAccountFingerprint: hash,
  sourceCoverage: z.enum(['ATTESTED', 'NOT_ATTESTED']),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  outputName,
}).strict();
export type LineageInvocation = z.infer<typeof inputSchema>;
type Identity = z.infer<typeof identity>;
export interface CheckoutFacts {
  readonly sourceCommit: string;
  readonly clean: boolean;
  readonly migrations: readonly Readonly<{ name: string; checksum: string }>[];
  readonly lockSha256: string;
}
/** Factories MUST return a newly owned resource; allocation failures must clean up inside the factory. */
export interface OwnedLineageDatabase {
  readIdentity(): Promise<unknown>;
  readAppliedMigrations(): Promise<unknown>;
  snapshots(): LineageSnapshotPort;
  close(): Promise<void>;
}
export interface LineageInvocationDependencies {
  readonly root: string;
  verifyProtectedStoreInventory(statement: LineageInvocation['protectedStore']): Promise<boolean>;
  readCheckout(): Promise<CheckoutFacts>;
  validateOutput(name: string): Promise<string>;
  readDatabaseUrl(variable: string): string | undefined;
  createOwnedDatabase(url: string): OwnedLineageDatabase | Promise<OwnedLineageDatabase>;
  readonly packageFileSystem?: LineagePackageFileSystem;
}
type Failure = 'INPUT_INVALID' | 'PROTECTED_STORE_NOT_EXCLUDED' | 'CHECKOUT_INVALID' | 'OUTPUT_INVALID'
  | 'DATABASE_URL_INVALID' | 'DATABASE_CREATE_FAILED' | 'IDENTITY_PREFLIGHT_FAILED' | 'MIGRATION_PREFLIGHT_FAILED'
  | 'PIPELINE_FAILED' | 'CLEANUP_FAILED';
export interface LineageInvocationResult {
  readonly kind: 'COMPLETED' | 'FAILED';
  readonly failure: Failure | null;
  readonly preflight: 'NOT_PASSED' | 'MATCHED_TARGET_AND_MIGRATIONS_EXCLUDED_OPERATOR_INVENTORY';
  readonly cleanup: 'NOT_CREATED' | 'CLOSED' | 'FAILED';
  readonly export: OfflineLineageExportResult | null;
}
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sameIdentity = (a: Identity, b: Identity): boolean => a.serverUuid === b.serverUuid && a.databaseName === b.databaseName;

/** Reject aliases to a protected schema conservatively, even if the operator names a different server. */
function excludesProtected(target: Identity, protectedIdentity: Identity): boolean {
  return target.databaseName.toLowerCase() !== protectedIdentity.databaseName.toLowerCase();
}
function validUrl(value: string | undefined, target: Identity): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    return url.protocol === 'mysql:' && !!url.hostname && !!url.username && !url.hash
      && decodeURIComponent(url.pathname) === `/${target.databaseName}`
      && keys.length === 3 && new Set(keys).size === 3
      && url.searchParams.get('connection_limit') === '1'
      && ['connect_timeout', 'pool_timeout'].every(key => /^[1-9][0-9]?$/.test(url.searchParams.get(key) ?? ''));
  } catch { return false; }
}
function validCheckout(facts: CheckoutFacts, commit: string): boolean {
  return facts.clean && facts.sourceCommit === commit && /^[0-9a-f]{64}$/.test(facts.lockSha256)
    && facts.migrations.length > 0 && new Set(facts.migrations.map(row => row.name)).size === facts.migrations.length
    && facts.migrations.every(row => /^\d{14}_[a-z0-9_]{1,100}$/.test(row.name) && /^[0-9a-f]{64}$/.test(row.checksum));
}
function migrationsMatch(value: unknown, expected: CheckoutFacts['migrations']): boolean {
  const schema = z.array(z.object({ migrationName: z.string(), checksum: hash,
    finishedAt: z.date(), rolledBackAt: z.null() }).strict());
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data.length !== expected.length) return false;
  const rows = new Map(parsed.data.map(row => [row.migrationName, row.checksum]));
  return rows.size === expected.length && expected.every(row => rows.get(row.name) === row.checksum);
}

/** Validate everything non-DB first. Failed metadata preflight never constructs a repository or reads account rows. */
export async function runLineageInvocation(raw: unknown, deps: LineageInvocationDependencies): Promise<LineageInvocationResult> {
  let failure: Failure | null = 'INPUT_INVALID';
  let preflight: LineageInvocationResult['preflight'] = 'NOT_PASSED';
  let cleanup: LineageInvocationResult['cleanup'] = 'NOT_CREATED';
  let exported: OfflineLineageExportResult | null = null;
  let owned: OwnedLineageDatabase | undefined;
  try {
    // Zod returns a private copy; mutation by the caller across awaits cannot change the checked inputs.
    const input = inputSchema.parse(raw);
    if (input.accountId !== input.campaignAccountId
      || input.expectedProviderAccountFingerprint !== input.campaignExpectedProviderAccountFingerprint) throw new Error();
    failure = 'PROTECTED_STORE_NOT_EXCLUDED';
    if (!excludesProtected(input.target, input.protectedStore.identity)) throw new Error();
    if (!await deps.verifyProtectedStoreInventory(input.protectedStore)) throw new Error();
    failure = 'CHECKOUT_INVALID';
    const checkout = await deps.readCheckout();
    if (!validCheckout(checkout, input.sourceCommit)) throw new Error();
    failure = 'OUTPUT_INVALID';
    const directory = await deps.validateOutput(input.outputName);
    failure = 'DATABASE_URL_INVALID';
    const url = deps.readDatabaseUrl(input.databaseUrlEnvironmentVariable);
    if (!validUrl(url, input.target)) throw new Error();
    failure = 'DATABASE_CREATE_FAILED';
    owned = await deps.createOwnedDatabase(url);
    failure = 'IDENTITY_PREFLIGHT_FAILED';
    const observed = z.array(identity).length(1).parse(await owned.readIdentity())[0]!;
    if (!sameIdentity(observed, input.target) || !excludesProtected(observed, input.protectedStore.identity)) throw new Error();
    failure = 'MIGRATION_PREFLIGHT_FAILED';
    if (!migrationsMatch(await owned.readAppliedMigrations(), checkout.migrations)) throw new Error();
    preflight = 'MATCHED_TARGET_AND_MIGRATIONS_EXCLUDED_OPERATOR_INVENTORY';
    failure = 'PIPELINE_FAILED';
    const statements: OfflineLineageExportRequest['statements'] = {
      expectedProviderAccountFingerprint: input.expectedProviderAccountFingerprint,
      campaignExpectedProviderAccountFingerprint: input.campaignExpectedProviderAccountFingerprint,
      campaignAccountId: input.campaignAccountId, sourceCommit: checkout.sourceCommit,
      migrationIdentity: { directories: checkout.migrations.map(row => row.name), lockSha256: checkout.lockSha256 },
      sourceCoverage: input.sourceCoverage,
    };
    const fileSystem = deps.packageFileSystem ?? nodeLineagePackageFileSystem;
    // The snapshot can take time. Recheck the approved parent and freshness at the writer's first filesystem action.
    const guardedFileSystem: LineagePackageFileSystem = { ...fileSystem, async makeDirectory(candidate) {
      if (candidate !== await deps.validateOutput(input.outputName)) throw new Error();
      await fileSystem.makeDirectory(candidate);
    } };
    exported = await exportOfflineLineageDiagnostic({ snapshots: owned.snapshots(), accountId: input.accountId,
      statements, directory, fileSystem: guardedFileSystem });
    if (exported.kind !== 'EXPORTED') throw new Error();
    failure = null;
  } catch { /* Fixed stage only. Never propagate dependency errors, URLs or account rows. */ }
  finally {
    if (owned) {
      try { await owned.close(); cleanup = 'CLOSED'; }
      catch { cleanup = 'FAILED'; if (failure === null) failure = 'CLEANUP_FAILED'; }
    }
  }
  return Object.freeze({ kind: failure === null ? 'COMPLETED' : 'FAILED', failure, preflight, cleanup, export: exported });
}

/** Generated Prisma clients can discover env files even on import. Refuse that configuration before importing one. */
export function requireNoPrismaEnvDiscovery(source: string): void {
  const match = /"relativeEnvPaths":\s*(\{[^}]*\})/.exec(source);
  if (!match) throw new Error();
  z.object({ rootEnvPath: z.null().optional(), schemaEnvPath: z.null().optional() }).strict().parse(JSON.parse(match[1]!));
}
/** No shared/global Prisma singleton, logger, environment loader, campaign or runtime. */
export async function createOwnedLineageDatabase(url: string): Promise<OwnedLineageDatabase> {
  requireNoPrismaEnvDiscovery(await readFile(require.resolve('.prisma/client/index.js'), 'utf8'));
  const { PrismaClient } = await import('@prisma/client');
  const { PrismaLiveExecutionRepository } = await import('../src/execution/live/repository');
  const prisma = new PrismaClient({ datasourceUrl: url, log: [], errorFormat: 'minimal' });
  return {
    async readIdentity() {
      return prisma.$queryRaw`SELECT DATABASE() AS databaseName, @@server_uuid AS serverUuid`;
    },
    async readAppliedMigrations() {
      return prisma.$queryRaw`SELECT migration_name AS migrationName, checksum, finished_at AS finishedAt,
        rolled_back_at AS rolledBackAt FROM _prisma_migrations`;
    },
    snapshots: () => new PrismaLiveExecutionRepository(prisma),
    close: () => prisma.$disconnect(),
  };
}

async function regular(file: string, directory: boolean): Promise<void> {
  const entry = await lstat(file);
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())) throw new Error();
}
/** All path components below the canonical checkout must already be real directories, not junctions/links. */
async function localRoot(root: string): Promise<string> {
  if (await realpath(root) !== path.resolve(root)) throw new Error();
  const local = path.join(root, '.local');
  const approved = path.join(local, 'm4-lineage-exports');
  await regular(local, true); await regular(approved, true);
  if (await realpath(approved) !== approved) throw new Error();
  return approved;
}
function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export async function readLineageCheckout(root: string): Promise<CheckoutFacts> {
  const migrations = path.join(root, 'prisma', 'migrations');
  await regular(migrations, true);
  const names = (await readdir(migrations)).filter(name => name !== 'migration_lock.toml').sort();
  const rows = [];
  for (const name of names) {
    if (!/^\d{14}_[a-z0-9_]{1,100}$/.test(name)) throw new Error();
    await regular(path.join(migrations, name), true);
    const sql = path.join(migrations, name, 'migration.sql');
    await regular(sql, false);
    rows.push({ name, checksum: digest(await readFile(sql)) });
  }
  const lock = path.join(migrations, 'migration_lock.toml');
  await regular(lock, false);
  return { sourceCommit: git(root, ['rev-parse', 'HEAD']), clean: git(root, ['status', '--porcelain=v1', '--untracked-files=all']) === '',
    migrations: rows, lockSha256: digest(await readFile(lock)) };
}
export async function validateLineageOutput(root: string, name: string): Promise<string> {
  outputName.parse(name);
  const directory = path.join(await localRoot(root), name);
  const relative = path.relative(root, directory).split(path.sep).join('/');
  // Check the effective ignore rule, including negations; --no-index refuses even an already tracked ignored path.
  if (git(root, ['check-ignore', '--no-index', '--', relative]) !== relative) throw new Error();
  if (git(root, ['ls-files', '--', relative]) !== '') throw new Error();
  try { await lstat(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return directory;
    throw error;
  }
  throw new Error();
}

export interface LineageEntryDependencies extends LineageInvocationDependencies {
  readInput(file: string): Promise<unknown>;
}
/** CLI input is a non-secret JSON file directly in the approved ignored directory. URL comes only from the named env. */
export function nodeLineageDependencies(root: string): LineageEntryDependencies {
  return {
    root,
    async verifyProtectedStoreInventory(statement) {
      const file = path.join(await localRoot(root), 'protected-store-inventory.json');
      await regular(file, false);
      if ((await lstat(file)).size > 65536) return false;
      const bytes = await readFile(file);
      if (digest(bytes) !== statement.inventorySha256) return false;
      const schema = z.object({ kind: z.literal('M4_PROTECTED_ORIGINAL_STORE_INVENTORY'), identity,
        review: z.literal('OPERATOR_VERIFIED_ORIGINAL_STORE_IDENTITY') }).strict();
      const inventory = schema.parse(JSON.parse(bytes.toString('utf8')));
      return sameIdentity(inventory.identity, statement.identity) && inventory.review === statement.review;
    },
    readCheckout: () => readLineageCheckout(root),
    validateOutput: name => validateLineageOutput(root, name),
    readDatabaseUrl(variable) {
      // Prisma's debug/native traces can bypass its ordinary log configuration. Refuse before loading the client.
      if (process.env['DEBUG'] || process.env['RUST_LOG'] || process.env['PRISMA_LOG_LEVEL']) return undefined;
      return process.env[variable];
    },
    createOwnedDatabase: createOwnedLineageDatabase,
    async readInput(file) {
      const approved = await localRoot(root);
      if (!path.isAbsolute(file) || path.dirname(file) !== approved || path.extname(file) !== '.json') throw new Error();
      await regular(file, false);
      if ((await lstat(file)).size > 65536) throw new Error();
      return JSON.parse(await readFile(file, 'utf8')) as unknown;
    },
  };
}
export async function lineageEntry(args: readonly string[], deps: LineageEntryDependencies): Promise<LineageInvocationResult> {
  try {
    if (args.length !== 2 || args[0] !== '--input' || !path.isAbsolute(args[1]!)) throw new Error();
    return await runLineageInvocation(await deps.readInput(args[1]!), deps);
  } catch {
    return Object.freeze({ kind: 'FAILED', failure: 'INPUT_INVALID', preflight: 'NOT_PASSED', cleanup: 'NOT_CREATED', export: null });
  }
}
if (require.main === module) {
  void lineageEntry(process.argv.slice(2), nodeLineageDependencies(path.resolve(__dirname, '..'))).then(result => {
    console.log(JSON.stringify(result)); process.exitCode = result.kind === 'COMPLETED' ? 0 : 1;
  }).catch(() => { console.error('M4_LINEAGE_EXPORT_FAILED'); process.exitCode = 1; });
}
