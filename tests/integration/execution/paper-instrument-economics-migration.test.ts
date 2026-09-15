import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE_DATABASE_URL = process.env['DATABASE_URL'];
const DB_NAME = `p14w3b_migration_${randomBytes(6).toString('hex')}`;
let available = false;
let databaseCreated = false;
let unavailableReason = 'DATABASE_URL is unavailable after the explicit dotenv bootstrap';

function mysqlArgs(extra: readonly string[]): string[] {
  const url = new URL(BASE_DATABASE_URL!);
  const args = ['-h', url.hostname, '-P', url.port || '3306', '-u', decodeURIComponent(url.username)];
  if (url.password) args.push(`-p${decodeURIComponent(url.password)}`);
  return [...args, ...extra];
}

function sourceMigration(name: string): void {
  const sql = path.resolve(__dirname, `../../../prisma/migrations/${name}/migration.sql`).replaceAll('\\', '/');
  execFileSync('mysql', mysqlArgs([DB_NAME, '-e', `source ${sql}`]), { stdio: 'pipe', timeout: 60_000 });
}

function query(sql: string): string[] {
  return execFileSync('mysql', mysqlArgs([
    DB_NAME, '--batch', '--skip-column-names', '-e', sql,
  ]), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  }).trim().split(/\r?\n/);
}

beforeAll(() => {
  if (!BASE_DATABASE_URL) return;
  try {
    execFileSync('mysql', mysqlArgs(['-e', `CREATE DATABASE \`${DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
    databaseCreated = true;
    for (const migration of [
      '20260902000000_init', '20260904000000_add_candles_1m', '20260906000000_add_historical_datasets',
      '20260910050818_phase14_paper_persistence',
    ]) sourceMigration(migration);
    available = true;
  } catch {
    available = false;
    unavailableReason = 'The disposable MySQL test database could not be initialized';
  }
}, 90_000);

afterAll(() => {
  if (!databaseCreated) return;
  try {
    execFileSync('mysql', mysqlArgs(['-e', `DROP DATABASE IF EXISTS \`${DB_NAME}\`;`]), { stdio: 'pipe', timeout: 15_000 });
  } catch { /* best-effort disposable cleanup */ }
});

describe('F14-03 Wave3-B additive migration from an existing Phase14 database', () => {
  it('preserves an old execution intent as NULL and creates no guessed economics backfill', (context) => {
    if (!available) context.skip(unavailableReason);
    const seed = [
      "INSERT INTO paper_account(account_id,starting_capital_inr,peak_equity_inr,updated_at) VALUES('legacy-account',1000,1000,NOW(3))",
      "INSERT INTO paper_execution_policy_snapshot(execution_policy_snapshot_id,policy_version,fill_selection_policy,max_evidence_age_ms,required_health_state,taker_fee_rate,slippage_bps,spread_semantics,tick_rounding_policy,quantity_policy,contract_multiplier,currency_conversion_policy,accounting_policy,execution_semantics_version) VALUES(REPEAT('a',64),'P14_EXECUTION_POLICY_V1','TEST',1000,'HEALTHY',0,0,'TEST','TEST','TEST',0.001,'TEST','TEST','TEST')",
      "INSERT INTO paper_execution_intent(execution_intent_id,action,account_id,pair,strategy_instance_id,strategy_id,strategy_version,parameter_hash,risk_decision_id,evaluation_time_ms,execution_policy_snapshot_id) VALUES(REPEAT('b',64),'CLOSE','legacy-account','B-BTC_USDT',REPEAT('c',64),'TEST','1',REPEAT('d',64),REPEAT('e',64),1,REPEAT('a',64))",
    ].join('; ');
    execFileSync('mysql', mysqlArgs([DB_NAME, '-e', seed]), { stdio: 'pipe', timeout: 15_000 });

    expect(query(
      "SELECT COUNT(*) FROM paper_execution_intent; SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='paper_execution_intent' AND column_name='instrument_economics_snapshot_id';",
    )).toEqual(['1', '0']);

    sourceMigration('20260915000000_phase14_wave3b_instrument_economics');

    const migrated = query([
      'SELECT COUNT(*), SUM(instrument_economics_snapshot_id IS NULL) FROM paper_execution_intent',
      'SELECT COUNT(*) FROM paper_instrument_economics_snapshot',
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='paper_instrument_economics_snapshot'",
      "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='paper_execution_intent' AND column_name='instrument_economics_snapshot_id' AND is_nullable='YES'",
      "SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='paper_instrument_economics_snapshot' AND index_name='paper_instrument_economics_pair_spec_idx'",
      "SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='paper_execution_intent' AND index_name='paper_execution_intent_economics_pair_idx'",
      "SELECT CONCAT(update_rule, ',', delete_rule) FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND table_name='paper_execution_intent' AND constraint_name='paper_execution_intent_instrument_economics_fkey'",
      "SELECT GROUP_CONCAT(CONCAT(column_name, '=', referenced_column_name) ORDER BY ordinal_position SEPARATOR ',') FROM information_schema.key_column_usage WHERE constraint_schema=DATABASE() AND table_name='paper_execution_intent' AND constraint_name='paper_execution_intent_instrument_economics_fkey'",
    ].join('; '));

    expect(migrated).toEqual([
      '1\t1',
      '0',
      '1',
      '1',
      'pair,instrument_spec_identity_policy_id,instrument_spec_snapshot_id',
      'instrument_economics_snapshot_id,pair',
      'RESTRICT,RESTRICT',
      'instrument_economics_snapshot_id=instrument_economics_snapshot_id,pair=pair',
    ]);
    console.info('WAVE3B_MIGRATION_DB_EVIDENCE', JSON.stringify({
      legacyIntentRows: 1,
      legacyNullEconomicsBindings: 1,
      economicsSnapshotRows: 0,
      schemaObjectsVerified: true,
    }));
  });

  it('adds nullable unique account mutation order without guessing legacy order', () => {
    expect(available, unavailableReason).toBe(true);
    query("INSERT INTO paper_order(execution_intent_id,account_id,action,state,updated_at) VALUES(REPEAT('b',64),'legacy-account','CLOSE','FILLED',NOW(3))");
    query("INSERT INTO paper_fill(order_id,account_id,source_strategy_decision_id,source_execution_key,pair,action,side,fill_price,quantity,fee_inr,realized_pnl_inr,quote_snapshot_content_sha256,event_time_ms) VALUES(REPEAT('b',64),'legacy-account',REPEAT('f',64),REPEAT('g',64),'B-BTC_USDT','CLOSE','SELL',1,1,0,0,REPEAT('h',64),2)");
    sourceMigration('20260916000000_phase14_account_mutation_order');
    expect(query('SELECT COUNT(*), SUM(account_mutation_revision IS NULL) FROM paper_fill')).toEqual(['1\t1']);
    expect(query("SELECT CONCAT(is_nullable, ',', column_type) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='paper_fill' AND column_name='account_mutation_revision'")).toEqual(['YES,bigint']);
    expect(query("SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='paper_fill' AND index_name='paper_fill_account_mutation_revision_unique' AND non_unique=0")).toEqual(['account_id,account_mutation_revision']);
    console.info('ACCOUNT_MUTATION_ORDER_MIGRATION_EVIDENCE', { legacyFills: 1, nullOrdering: 1, inventedOrdering: 0, uniqueAccountRevision: true });
  });
});
