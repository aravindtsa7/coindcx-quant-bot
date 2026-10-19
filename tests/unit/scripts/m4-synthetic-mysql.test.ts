import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyntheticMysql } from '../../../scripts/m4-synthetic-mysql';
import { syntheticResourceNames, type SyntheticAcceptanceConfig } from '../../../scripts/m4-synthetic-acceptance';

// No native Prisma client or Prisma CLI can run in this suite. Files and SQL are synthetic.
const fake = vi.hoisted(() => ({ queries: vi.fn(), execute: vi.fn(), child: vi.fn(), constructed: vi.fn(), disconnect: vi.fn() }));
vi.mock('@prisma/client', () => ({ Prisma: { TransactionIsolationLevel: { RepeatableRead: 'RepeatableRead' } },
  PrismaClient: class {
    constructor() { fake.constructed(); }
    $queryRawUnsafe = fake.queries; $executeRawUnsafe = fake.execute; $disconnect = fake.disconnect;
  },
}));
vi.mock('node:child_process', () => ({ execFileSync: fake.child }));
const UUID = 'b6a4df59-954b-11f1-9408-f43bd84d24a1', COMMIT = 'ab'.repeat(20);
const NAME = '20260902000000_synthetic', BYTES = Buffer.from('SELECT 1;\r\n'), LOCK = Buffer.from('provider = "mysql"\r\n');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let root: string, marker = '', readerMarker = '', wrongServer = false, collision = false, failMigration = false;
const sql: string[] = [];
const resources = syntheticResourceNames('0123456789ab');
const config = (): SyntheticAcceptanceConfig => ({ kind: 'SYNTHETIC_M4_MYSQL_ACCEPTANCE', runId: resources.runId,
  sourceCommit: COMMIT, host: 'KANI', port: 3306, serverUuid: UUID, deadlineMs: 240000,
  invocationFile: path.join(root, '.local/m4-lineage-exports/SYNTHETIC.json'),
  authorization: 'AUTHORIZE_FRESH_SYNTHETIC_SETUP_SELECT_EXPORT_AND_OWNED_CLEANUP' });
const checkout = () => ({ sourceCommit: COMMIT, clean: true, migrations: [{ name: NAME, checksum: sha(BYTES) }], lockSha256: sha(LOCK) });
const port = () => createSyntheticMysql(root, config(), resources, 'mysql://SYNTHETIC:DO_NOT_ECHO@127.0.0.1:3306/information_schema', 'ef'.repeat(32));

beforeEach(() => {
  vi.clearAllMocks(); marker = ''; readerMarker = ''; wrongServer = collision = failMigration = false; sql.length = 0;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'm4-adapter-SYNTHETIC-')));
  fs.mkdirSync(path.join(root, '.local/m4-lineage-exports'), { recursive: true });
  fs.mkdirSync(path.join(root, 'prisma/migrations', NAME), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests/architecture'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prisma/migrations', NAME, 'migration.sql'), BYTES);
  fs.writeFileSync(path.join(root, 'prisma/migrations/migration_lock.toml'), LOCK);
  fs.writeFileSync(path.join(root, 'tests/architecture/phase18-migration-freeze.test.ts'), `'${NAME}': '${sha(Buffer.from('SELECT 1;\n'))}'`);
  fake.queries.mockImplementation(async (statement: string) => {
    if (statement.startsWith('SELECT @@hostname')) return [{ host: 'KANI', port: 3306, serverUuid: wrongServer ? 'foreign' : UUID, mandatoryRoles: '' }];
    if (statement.includes('information_schema.SCHEMATA')) return collision ? [{ SCHEMA_NAME: resources.schema }] : [];
    if (statement.includes('mysql.user')) return [];
    if (statement.startsWith('SELECT token')) return marker ? [{ token: marker }] : [];
    if (statement.includes('information_schema.USER_ATTRIBUTES')) return readerMarker ? [{ marker: readerMarker }] : [];
    throw new Error('UNEXPECTED_FAKE_QUERY');
  });
  fake.execute.mockImplementation(async (statement: string, value?: string) => {
    sql.push(statement);
    if (statement.startsWith('INSERT INTO')) marker = value!;
    if (statement.startsWith('CREATE USER')) readerMarker = statement.match(/"m4_synthetic_run":"([^"]+)"/)![1]!;
    return 1;
  });
  fake.disconnect.mockResolvedValue(undefined);
  fake.child.mockImplementation((executable: string, args: string[], options: { encoding?: string }) => {
    if (executable === 'git' && args.includes('check-ignore')) return args.at(-1)! + '\n';
    if (executable === 'git' && args.includes('ls-files')) return '';
    if (executable === 'git' && args[0] === 'show') return Buffer.from('SELECT 1;\n');
    if (executable === process.execPath && args.includes('deploy')) {
      expect(sql).toEqual([`CREATE DATABASE \`${resources.schema}\``]); // No marker table before migrate deploy.
      const stage = path.dirname(args.at(-1)!);
      expect(fs.readFileSync(path.join(stage, 'migrations', NAME, 'migration.sql'))).toEqual(BYTES);
      if (failMigration) throw new Error('SYNTHETIC_CLI_SECRET_DO_NOT_ECHO');
      return options.encoding ? '' : Buffer.alloc(0);
    }
    throw new Error('UNEXPECTED_FAKE_CHILD');
  });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('real synthetic adapter over fake Prisma/child dependencies (no MySQL)', () => {
  it('preserves CRLF bytes, records independent hash bases, migrates before the marker and drops only marked acknowledged objects', async () => {
    const db = await port(); await db.assertAbsent(); await db.createSchema();
    await expect(db.markSchema()).rejects.toThrow();
    await db.migrateExactBytes(checkout()); await db.markSchema(); await db.createReader();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.local/m4-lineage-exports', `synthetic-setup-${resources.runId}`, 'SYNTHETIC-MIGRATION-BYTES.json'), 'utf8'));
    expect(manifest).toMatchObject({ checksumBasis: 'SHA256_WORKING_COPY_BYTES', bases: [{ name: NAME,
      workingCopySha256: sha(BYTES), gitBlobSha256: sha(Buffer.from('SELECT 1;\n')), reviewedLfSha256: sha(Buffer.from('SELECT 1;\n')) }] });
    expect(fs.readFileSync(path.join(root, 'prisma/migrations', NAME, 'migration.sql'))).toEqual(BYTES);
    expect(JSON.stringify(manifest)).not.toContain('DO_NOT_ECHO');
    await db.dropOwnedReader(); await db.dropOwnedSchema(); await db.close();
    expect(sql.slice(-2)).toEqual([`DROP USER '${resources.user}'@'localhost'`, `DROP DATABASE \`${resources.schema}\``]);
    expect(fake.disconnect).toHaveBeenCalledTimes(3);
  });
  it('does not mutate on collision or drop anything that has not been acknowledged', async () => {
    const db = await port(); collision = true;
    await expect(db.assertAbsent()).rejects.toThrow();
    await expect(db.dropOwnedSchema()).rejects.toThrow(); await expect(db.dropOwnedReader()).rejects.toThrow();
    expect(sql).toEqual([]); await db.close();
  });
  it('does not mark or drop an unbaselined schema after a failed migration child', async () => {
    const db = await port(); await db.createSchema(); failMigration = true;
    await expect(db.migrateExactBytes(checkout())).rejects.toThrow();
    await expect(db.markSchema()).rejects.toThrow(); await expect(db.dropOwnedSchema()).rejects.toThrow();
    expect(sql).toEqual([`CREATE DATABASE \`${resources.schema}\``]); await db.close();
  });
  it.each(['schema-marker', 'reader-marker', 'server'])('refuses cleanup when %s no longer matches', async what => {
    const db = await port(); await db.createSchema(); await db.migrateExactBytes(checkout()); await db.markSchema(); await db.createReader();
    sql.length = 0;
    if (what === 'schema-marker') { marker = 'FOREIGN'; await expect(db.dropOwnedSchema()).rejects.toThrow(); }
    if (what === 'reader-marker') { readerMarker = 'FOREIGN'; await expect(db.dropOwnedReader()).rejects.toThrow(); }
    if (what === 'server') { wrongServer = true; await expect(db.dropOwnedSchema()).rejects.toThrow(); await expect(db.dropOwnedReader()).rejects.toThrow(); }
    expect(sql).toEqual([]); await db.close();
  });
});
