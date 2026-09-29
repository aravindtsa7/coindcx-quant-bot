import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DisposableMysqlGuardError,
  DisposableMysqlLifecycle,
  LOCAL_MYSQL_HOSTNAMES,
  P18B_CANCEL_STORE_TEST_DB_PATTERN,
  PROTECTED_DATABASE_NAMES,
  assertDisposableDatabaseName,
  assertLocalMysqlDatabaseUrl,
  generateDisposableDatabaseName,
  isLocalMysqlHostname,
  mysqlCliArgs,
  type MysqlStatementExecutor,
} from '../../helpers/p18b-disposable-mysql';

// [P18B-1B2-W2B1.1] The Stage 1B2 disposable real-MySQL acceptance harness refuses any non-loopback / non-mysql
// DATABASE_URL before any command, only ever CREATEs/DROPs `p18b_cancel_store_test_<12 hex>`, cleans up after a
// PARTIAL provisioning failure, is idempotent, and surfaces a strict cleanup failure. No message leaks credentials.

const ROOT = join(__dirname, '..', '..', '..');
const USER = 'harnessuser';
const PASSWORD = 'S3cretHarnessPw';
const LOCAL = `mysql://${USER}:${PASSWORD}@localhost:3306/coindcx_shadow`;
const NAME = 'p18b_cancel_store_test_0123456789ab';

function refusal(raw: unknown): DisposableMysqlGuardError {
  try {
    assertLocalMysqlDatabaseUrl(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(DisposableMysqlGuardError);
    return error as DisposableMysqlGuardError;
  }
  throw new Error('expected a refusal');
}

function expectCredentialFree(text: string, raw?: string): void {
  expect(text).not.toContain(USER);
  expect(text).not.toContain(PASSWORD);
  if (raw) {
    expect(text).not.toContain(raw);
    try {
      const host = new URL(raw).hostname;
      if (host) expect(text).not.toContain(host);
    } catch { /* malformed: nothing more to check */ }
  }
}

function recordingExecutor(failOn?: RegExp): { execute: MysqlStatementExecutor; statements: string[]; hosts: string[] } {
  const statements: string[] = [];
  const hosts: string[] = [];
  const execute: MysqlStatementExecutor = (url, sql) => {
    statements.push(sql);
    hosts.push(url.hostname);
    if (failOn?.test(sql)) throw new Error(`Command failed: mysql -h localhost -u ${USER} -p${PASSWORD} -e ${sql}`);
  };
  return { execute, statements, hosts };
}

function client(fail = false): { $disconnect: ReturnType<typeof vi.fn> } {
  return {
    $disconnect: vi.fn(async () => {
      if (fail) throw new Error(`disconnect failed for mysql://${USER}:${PASSWORD}@localhost/x`);
    }),
  };
}

describe('assertLocalMysqlDatabaseUrl — loopback mysql: only', () => {
  it('pins the accepted host set exactly', () => {
    expect([...LOCAL_MYSQL_HOSTNAMES]).toEqual(['localhost', '127.0.0.1', '::1', '[::1]']);
  });

  it.each([
    ['localhost', `mysql://${USER}:${PASSWORD}@localhost:3306/db`, 'localhost'],
    ['127.0.0.1', `mysql://${USER}:${PASSWORD}@127.0.0.1:3306/db`, '127.0.0.1'],
    ['[::1]', `mysql://${USER}:${PASSWORD}@[::1]:3306/db`, '[::1]'],
    ['no port / no db', 'mysql://root@localhost', 'localhost'],
  ])('accepts %s', (_label, raw, hostname) => {
    expect(assertLocalMysqlDatabaseUrl(raw).hostname).toBe(hostname);
  });

  it('accepts both the bare and the bracketed IPv6 loopback hostname forms', () => {
    expect(isLocalMysqlHostname('::1')).toBe(true);
    expect(isLocalMysqlHostname('[::1]')).toBe(true);
  });

  it('passes a bracketed IPv6 loopback to the mysql CLI without brackets', () => {
    const args = mysqlCliArgs(assertLocalMysqlDatabaseUrl(`mysql://${USER}:${PASSWORD}@[::1]:3307/db`), 'SELECT 1');
    expect(args.slice(0, 4)).toEqual(['-h', '::1', '-P', '3307']);
  });

  it.each([
    'db.example.com',
    'mysql.internal',
    'localhost.example.com',
    'localhost.',
    'LOCALHOST',
    'prod-mysql',
    '[::2]',
    '[::ffff:7f00:1]',
  ])('refuses remote/non-exact hostname %s, credential-free', (host) => {
    const raw = `mysql://${USER}:${PASSWORD}@${host}:3306/coindcx_shadow`;
    const error = refusal(raw);
    expect(error.message).toMatch(/not a local loopback host/);
    expectCredentialFree(error.message, raw);
  });

  it.each(['10.0.0.5', '192.168.1.10', '172.16.0.9', '8.8.8.8', '0.0.0.0', '127.0.0.2', '127.1.1.1'])('refuses IPv4 %s', (host) => {
    const raw = `mysql://${USER}:${PASSWORD}@${host}:3306/coindcx_quant`;
    const error = refusal(raw);
    expect(error.message).toMatch(/not a local loopback host/);
    expectCredentialFree(error.message, raw);
  });

  it.each([
    ['undefined', undefined, /not set/],
    ['empty', '', /not set/],
    ['a number', 3306, /not set/],
    ['scheme-less', `//${USER}:${PASSWORD}@localhost/db`, /not a parseable URL/],
    ['userinfo parsed as a scheme', `${USER}:${PASSWORD}@localhost/db`, /protocol is not mysql:/],
    ['spaces', 'mysql:// user pass @ localhost', /not a parseable URL|not a local loopback host/],
    ['host-less', 'mysql://', /not a local loopback host/],
    ['bad port', `mysql://${USER}:${PASSWORD}@localhost:99999/db`, /not a parseable URL/],
  ])('refuses malformed input: %s', (_label, raw, pattern) => {
    const error = refusal(raw);
    expect(error.message).toMatch(pattern);
    expectCredentialFree(error.message, typeof raw === 'string' ? raw : undefined);
  });

  it.each([
    `postgresql://${USER}:${PASSWORD}@localhost:5432/db`,
    `mysqlx://${USER}:${PASSWORD}@localhost:33060/db`,
    `mariadb://${USER}:${PASSWORD}@localhost:3306/db`,
    `http://${USER}:${PASSWORD}@localhost/db`,
    'file:///C:/db.sqlite',
    'sqlserver://localhost:1433',
  ])('refuses non-mysql protocol %s', (raw) => {
    const error = refusal(raw);
    expect(error.message).toMatch(/protocol is not mysql:/);
    expectCredentialFree(error.message, raw);
  });
});

describe('disposable database names', () => {
  const base = assertLocalMysqlDatabaseUrl(LOCAL);

  it('generates names matching exactly /^p18b_cancel_store_test_[0-9a-f]{12}$/', () => {
    expect(P18B_CANCEL_STORE_TEST_DB_PATTERN.source).toBe('^p18b_cancel_store_test_[0-9a-f]{12}$');
    const names = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const name = generateDisposableDatabaseName();
      expect(name).toMatch(/^p18b_cancel_store_test_[0-9a-f]{12}$/);
      expect(assertDisposableDatabaseName(name, base)).toBe(name);
      names.add(name);
    }
    expect(names.size).toBe(200);
  });

  it.each([
    ...PROTECTED_DATABASE_NAMES,
    'COINDCX_SHADOW',
    'Coindcx_Quant',
    'mysql',
    'information_schema',
    'p18b_cancel_store_test_',
    'p18b_cancel_store_test_0123456789a',
    'p18b_cancel_store_test_0123456789abc',
    'p18b_cancel_store_test_0123456789AB',
    'P18B_CANCEL_STORE_TEST_0123456789ab',
    'p18b_cancel_store_test_0123456789ab\n',
    'p18b_cancel_store_test_0123456789ab`; DROP DATABASE coindcx_shadow; --',
    'x_p18b_cancel_store_test_0123456789ab',
    'p18b_test_0123456789ab',
    '',
  ])('refuses %j as a disposable name', (name) => {
    expect(() => assertDisposableDatabaseName(name, base)).toThrow(DisposableMysqlGuardError);
  });

  it.each([undefined, null, 12, {}])('refuses a non-string name %j', (name) => {
    expect(() => assertDisposableDatabaseName(name, base)).toThrow(DisposableMysqlGuardError);
  });

  it("refuses a name equal to the base DATABASE_URL's own database, whatever its case", () => {
    const sameBase = assertLocalMysqlDatabaseUrl(`mysql://${USER}:${PASSWORD}@localhost:3306/${NAME}`);
    expect(() => assertDisposableDatabaseName(NAME, sameBase)).toThrow(/equals the base DATABASE_URL/);
    const upperBase = assertLocalMysqlDatabaseUrl(`mysql://${USER}:${PASSWORD}@localhost:3306/${NAME.toUpperCase()}`);
    expect(() => assertDisposableDatabaseName(NAME, upperBase)).toThrow(/equals the base DATABASE_URL/);
  });

  it('a lifecycle is never constructed for a protected or malformed name, and executes nothing', () => {
    for (const name of [...PROTECTED_DATABASE_NAMES, 'p18b_cancel_store_test_nothex000000']) {
      const { execute, statements } = recordingExecutor();
      expect(() => new DisposableMysqlLifecycle({ rawBaseUrl: LOCAL, name, strict: true, execute })).toThrow(DisposableMysqlGuardError);
      expect(statements).toEqual([]);
    }
  });

  it('a lifecycle is never constructed for a remote/non-mysql/malformed URL, and executes nothing', () => {
    for (const rawBaseUrl of [`mysql://${USER}:${PASSWORD}@db.example.com/x`, `mysql://${USER}:${PASSWORD}@10.0.0.5/x`, 'postgresql://localhost/x', 'nope', undefined]) {
      const { execute, statements } = recordingExecutor();
      expect(() => new DisposableMysqlLifecycle({ rawBaseUrl, name: NAME, strict: true, execute })).toThrow(DisposableMysqlGuardError);
      expect(statements).toEqual([]);
    }
  });
});

describe('DisposableMysqlLifecycle — provisioning and cleanup', () => {
  it('CREATE and DROP use only the validated name, against the validated local base URL', async () => {
    const { execute, statements, hosts } = recordingExecutor();
    const lifecycle = new DisposableMysqlLifecycle({ rawBaseUrl: LOCAL, name: NAME, strict: true, execute });
    lifecycle.createDatabase();
    expect(lifecycle.databaseCreated).toBe(true);
    await lifecycle.cleanup();
    expect(statements).toEqual([`CREATE DATABASE \`${NAME}\`;`, `DROP DATABASE IF EXISTS \`${NAME}\`;`]);
    expect(hosts).toEqual(['localhost', 'localhost']);
    expect(lifecycle.databaseCreated).toBe(false);
  });

  it('databaseUrl() replaces only the database and never names a protected database', () => {
    const lifecycle = new DisposableMysqlLifecycle({ rawBaseUrl: LOCAL, name: NAME, strict: true, execute: recordingExecutor().execute });
    const url = new URL(lifecycle.databaseUrl({ connection_limit: '1' }));
    expect(url.hostname).toBe('localhost');
    expect(url.pathname).toBe(`/${NAME}`);
    expect(url.searchParams.get('connection_limit')).toBe('1');
  });

  it('a provisioning failure AFTER CREATE still DROPs the database and disconnects every tracked client', async () => {
    const { execute, statements } = recordingExecutor();
    const lifecycle = new DisposableMysqlLifecycle({ rawBaseUrl: LOCAL, name: NAME, strict: true, execute });
    const clients = [client(), client()];
    let caught: unknown = null;
    try {
      lifecycle.createDatabase();
      for (const c of clients) lifecycle.track(c);
      throw new Error('simulated prisma migrate deploy failure');
    } catch (error) {
      caught = error;
      await lifecycle.cleanup();
    }
    expect((caught as Error).message).toBe('simulated prisma migrate deploy failure');
    expect(statements).toEqual([`CREATE DATABASE \`${NAME}\`;`, `DROP DATABASE IF EXISTS \`${NAME}\`;`]);
    for (const c of clients) expect(c.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('a failed CREATE marks nothing created, so cleanup issues NO DROP', async () => {
    const { execute, statements } = recordingExecutor(/^CREATE/);
    const lifecycle = new DisposableMysqlLifecycle({ rawBaseUrl: LOCAL, name: NAME, strict: true, execute });
    expect(() => lifecycle.createDatabase()).toThrow();
    expect(lifecycle.databaseCreated).toBe(false);
    await lifecycle.cleanup();
    expect(statements).toEqual([`CREATE DATABASE \`${NAME}\`;`]);
  });

  it('CREATE is attempted at most once per lifecycle', () => {
    const { execute, statements } = recordingExecutor();
    const lifecycle = new DisposableMysqlLifecycle({ rawBaseUrl: LOCAL, name: NAME, strict: true, execute });
    lifecycle.createDatabase();
    expect(() => lifecycle.createDatabase()).toThrow(/already attempted/);
    expect(statements).toHaveLength(1);
  });

  it('cleanup is idempotent: one DROP, one disconnect per client, however often it is called', async () => {
    const { execute, statements } = recordingExecutor();
    const lifecycle = new DisposableMysqlLifecycle({ rawBaseUrl: LOCAL, name: NAME, strict: true, execute });
    lifecycle.createDatabase();
    const tracked = lifecycle.track(client());
    await lifecycle.cleanup();
    await lifecycle.cleanup();
    await lifecycle.cleanup();
    expect(statements.filter((sql) => sql.startsWith('DROP'))).toHaveLength(1);
    expect(tracked.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('cleanup before any CREATE is a no-op', async () => {
    const { execute, statements } = recordingExecutor();
    const lifecycle = new DisposableMysqlLifecycle({ rawBaseUrl: LOCAL, name: NAME, strict: true, execute });
    await lifecycle.cleanup();
    expect(statements).toEqual([]);
  });

  it('STRICT: a DROP failure rejects cleanup, credential-free, and the next cleanup retries the DROP', async () => {
    let failDrop = true;
    const statements: string[] = [];
    const execute: MysqlStatementExecutor = (_url, sql) => {
      statements.push(sql);
      if (failDrop && sql.startsWith('DROP')) throw new Error(`Command failed: mysql -u ${USER} -p${PASSWORD} -e ${sql}`);
    };
    const lifecycle = new DisposableMysqlLifecycle({ rawBaseUrl: LOCAL, name: NAME, strict: true, execute });
    lifecycle.createDatabase();
    const error = await lifecycle.cleanup().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(DisposableMysqlGuardError);
    expect((error as Error).message).toMatch(new RegExp(`DROP DATABASE ${NAME} failed \\(Error\\)`));
    expectCredentialFree((error as Error).message, LOCAL);
    expect(lifecycle.databaseCreated).toBe(true);
    failDrop = false;
    await lifecycle.cleanup();
    expect(lifecycle.databaseCreated).toBe(false);
    expect(statements.filter((sql) => sql.startsWith('DROP'))).toHaveLength(2);
  });

  it('STRICT: a disconnect failure rejects cleanup, but every other client is disconnected and the DROP still runs', async () => {
    const { execute, statements } = recordingExecutor();
    const lifecycle = new DisposableMysqlLifecycle({ rawBaseUrl: LOCAL, name: NAME, strict: true, execute });
    lifecycle.createDatabase();
    const failing = lifecycle.track(client(true));
    const healthy = lifecycle.track(client());
    await expect(lifecycle.cleanup()).rejects.toThrow(/client disconnect failed \(Error\)/);
    expect(failing.$disconnect).toHaveBeenCalledTimes(1);
    expect(healthy.$disconnect).toHaveBeenCalledTimes(1);
    expect(statements).toContain(`DROP DATABASE IF EXISTS \`${NAME}\`;`);
    await expect(lifecycle.cleanup()).resolves.toBeUndefined();
  });

  it('NON-STRICT: a cleanup failure is reported via warn, credential-free, and does not reject', async () => {
    const { execute } = recordingExecutor(/^DROP/);
    const warn = vi.fn();
    const lifecycle = new DisposableMysqlLifecycle({ rawBaseUrl: LOCAL, name: NAME, strict: false, execute, warn });
    lifecycle.createDatabase();
    lifecycle.track(client(true));
    await expect(lifecycle.cleanup()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toMatch(/client disconnect failed \(Error\); DROP DATABASE p18b_cancel_store_test_0123456789ab failed \(Error\)/);
    expectCredentialFree(message, LOCAL);
  });
});

describe('the Stage 1B2 strict runner and the new suite apply the guard first', () => {
  const RUNNER = 'scripts/run-live-practical-mutation-db-integration.ts';
  // [Wave 2B2a] Every Stage 1B2 suite that provisions a disposable database gets the same pins.
  const SUITES = [
    'tests/integration/execution/live-practical-cancel-mutation.integration.test.ts',
    'tests/integration/execution/live-practical-cancel-interlock.integration.test.ts',
  ] as const;

  function runRunner(databaseUrl: string | undefined): { status: number | null; output: string } {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!/^COINDCX_/i.test(key) && key !== 'DATABASE_URL') env[key] = value;
    if (databaseUrl !== undefined) env['DATABASE_URL'] = databaseUrl;
    const result = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, RUNNER)], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 60_000,
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  }

  it.each([
    ['a remote hostname', `mysql://${USER}:${PASSWORD}@db.example.invalid:3306/coindcx_shadow`, /host is not a local loopback host/],
    ['a remote IPv4', `mysql://${USER}:${PASSWORD}@192.0.2.10:3306/coindcx_quant`, /host is not a local loopback host/],
    ['a non-mysql protocol', `postgresql://${USER}:${PASSWORD}@localhost:5432/x`, /protocol is not mysql:/],
    ['a malformed URL', 'not a url at all', /not a parseable URL/],
    ['no DATABASE_URL', undefined, /DATABASE_URL is not set/],
  ])('the runner refuses %s and exits 1 WITHOUT spawning vitest, credential-free', (_label, databaseUrl, pattern) => {
    const { status, output } = runRunner(databaseUrl);
    expect(status).toBe(1);
    expect(output).toMatch(/\[P18B-1B2-DB-INTEGRATION\] refused before launching vitest/);
    expect(output).toMatch(pattern);
    // vitest's own banner/summary never appears: it was not spawned.
    expect(output).not.toMatch(/RUN\s+v\d|Test Files|Tests\s+\d|live-practical-cancel-mutation/);
    expectCredentialFree(output, databaseUrl);
  }, 60_000);

  it('the runner guards DATABASE_URL before its only spawnSync', () => {
    const source = readFileSync(join(ROOT, RUNNER), 'utf8');
    const guard = source.indexOf("assertLocalMysqlDatabaseUrl(process.env['DATABASE_URL'])");
    const spawn = source.indexOf('spawnSync(');
    expect(guard).toBeGreaterThan(0);
    expect(spawn).toBeGreaterThan(guard);
    expect(source.split('spawnSync(')).toHaveLength(2);
    expect(source.slice(guard, spawn)).toContain('process.exit(1)');
  });

  it.each(SUITES)('%s constructs the guarded lifecycle before any command or client, and issues no raw CREATE/DROP', (suite) => {
    const source = readFileSync(join(ROOT, suite), 'utf8');
    const beforeAllAt = source.indexOf('beforeAll(async () => {');
    const guard = source.indexOf('new DisposableMysqlLifecycle(', beforeAllAt);
    expect(beforeAllAt).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(beforeAllAt);
    for (const later of ['createDatabase()', "execFileSync('npx'", 'new PrismaClient(']) {
      const at = source.indexOf(later, beforeAllAt);
      expect(at).toBeGreaterThan(guard);
    }
    expect(source).not.toMatch(/CREATE DATABASE|DROP DATABASE/);
    expect(source).not.toMatch(/execFileSync\('mysql'/);
    expect(source).not.toContain('BASE_DATABASE_URL!');
    expect(source.match(/new PrismaClient\(/g)).toHaveLength(3);
    expect(source.match(/\.track\(new PrismaClient\(/g)).toHaveLength(3);
  });

  it.each(SUITES)('%s cleans up on the beforeAll failure path and unconditionally in afterAll', (suite) => {
    const source = readFileSync(join(ROOT, suite), 'utf8');
    const beforeAllBody = source.slice(source.indexOf('beforeAll(async () => {'), source.indexOf('afterAll(async () => {'));
    expect(beforeAllBody).toMatch(/catch \(error\) \{\s*dbAvailable = false;[\s\S]*await guarded\.cleanup\(\);/);
    const afterAllBody = source.slice(source.indexOf('afterAll(async () => {'), source.indexOf('function skip()'));
    expect(afterAllBody).toContain('if (lifecycle !== null) await lifecycle.cleanup();');
    expect(afterAllBody).not.toMatch(/if \(!dbAvailable\) return/);
    expect(afterAllBody).not.toMatch(/catch \{/);
  });

  it('the harness module imports nothing from the repository', () => {
    const source = readFileSync(join(ROOT, 'tests/helpers/p18b-disposable-mysql.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual(['node:child_process', 'node:crypto']);
  });
});
