/**
 * Applies all migrations to an isolated MySQL database, compares that database
 * with the current Prisma datamodel, and always removes the isolated database.
 * It never touches the configured database name itself.
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';

const baseDatabaseUrl = process.env['DATABASE_URL'];
if (!baseDatabaseUrl) throw new Error('[P17-MIGRATION-PARITY] DATABASE_URL is required');

const base = new URL(baseDatabaseUrl);
const databaseName = `p17_parity_${randomBytes(6).toString('hex')}`;
if (!/^p17_parity_[0-9a-f]{12}$/.test(databaseName)) {
  throw new Error('[P17-MIGRATION-PARITY] refused unsafe disposable database name');
}

const disposable = new URL(baseDatabaseUrl);
disposable.pathname = `/${databaseName}`;
const mysqlArgs = ['-h', base.hostname, '-P', base.port || '3306', '-u', decodeURIComponent(base.username)];
if (base.password) mysqlArgs.push(`-p${decodeURIComponent(base.password)}`);

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { env, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`[P17-MIGRATION-PARITY] ${command} failed with status ${result.status ?? 'launch-error'}`);
  }
}

const prismaCli = require.resolve('prisma/build/index.js');
let created = false;
try {
  run('mysql', [...mysqlArgs, '-e', `CREATE DATABASE \`${databaseName}\`;`]);
  created = true;
  run(process.execPath, [prismaCli, 'migrate', 'deploy'], { ...process.env, DATABASE_URL: disposable.toString() });
  const diff = spawnSync(process.execPath, [
    prismaCli, 'migrate', 'diff', '--script',
    '--from-url', disposable.toString(),
    '--to-schema-datamodel', 'prisma/schema.prisma',
  ], { env: process.env, encoding: 'utf8' });
  if (diff.error || diff.status !== 0) {
    throw new Error(`[P17-MIGRATION-PARITY] schema diff failed (status ${diff.status ?? 'launch-error'})`);
  }
  if (/`live_[a-z_]+`/i.test(diff.stdout)) {
    process.stdout.write(diff.stdout);
    throw new Error('[P17-MIGRATION-PARITY] Phase17-owned database objects differ from the Prisma datamodel');
  }
  const summary = spawnSync(process.execPath, [
    prismaCli, 'migrate', 'diff',
    '--from-url', disposable.toString(),
    '--to-schema-datamodel', 'prisma/schema.prisma',
  ], { env: process.env, encoding: 'utf8' });
  if (summary.error || summary.status !== 0) {
    throw new Error(`[P17-MIGRATION-PARITY] summary diff failed (status ${summary.status ?? 'launch-error'})`);
  }
  const changedTables = [...summary.stdout.matchAll(/Changed the `([^`]+)` table/g)].map((match) => match[1]);
  const unexpected = changedTables.filter((table) => !['paper_execution_intent', 'ranking_result'].includes(table));
  if (unexpected.length > 0) throw new Error(`[P17-MIGRATION-PARITY] unexpected non-Phase17 drift: ${unexpected.join(', ')}`);
  process.stdout.write('[P17-MIGRATION-PARITY] Phase17-owned database objects match the Prisma datamodel\n');
  if (changedTables.length > 0) {
    process.stdout.write(`[P17-MIGRATION-PARITY] pre-existing non-Phase17 foreign-key drift remains: ${changedTables.join(', ')}\n`);
  }
} finally {
  if (created) {
    run('mysql', [...mysqlArgs, '-e', `DROP DATABASE IF EXISTS \`${databaseName}\`;`]);
    process.stdout.write(`[P17-MIGRATION-PARITY] removed disposable database ${databaseName}\n`);
  }
}
