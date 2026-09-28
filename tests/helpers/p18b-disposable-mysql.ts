/**
 * [P18B-1B2-W2B1.1] Fail-closed guard + lifecycle for the Stage 1B2 disposable real-MySQL acceptance database.
 *
 * TEST TOOLING ONLY, with ZERO repository imports. It exists so an accidental DATABASE_URL naming a remote or
 * operational MySQL server can never have a disposable database created on (or dropped from) it:
 *
 *   - `assertLocalMysqlDatabaseUrl` accepts ONLY a `mysql:` URL whose host is exactly `localhost`, `127.0.0.1`,
 *     `::1` or `[::1]`, and refuses everything else BEFORE any mysql/prisma command or PrismaClient exists.
 *   - `assertDisposableDatabaseName` accepts ONLY `p18b_cancel_store_test_<12 lowercase hex>`, never a protected
 *     operational name and never the base DATABASE_URL's own database.
 *   - `DisposableMysqlLifecycle` issues CREATE / DROP only for that validated name, records that CREATE succeeded,
 *     and owns ONE idempotent cleanup that disconnects every client it tracked and drops the database whenever it
 *     was created — including after a PARTIAL provisioning failure.
 *
 * No message produced here contains a URL, a username, a password, a host, or a child-process error message
 * (an `execFileSync` failure message echoes its argv, which carries the password).
 *
 * Residual boundary: a loopback host proves the server is reached over the local loopback interface, not what is
 * listening there; a local port-forward to a remote server is outside what a URL check can see.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const LOCAL_MYSQL_HOSTNAMES: readonly string[] = Object.freeze(['localhost', '127.0.0.1', '::1', '[::1]']);
export const PROTECTED_DATABASE_NAMES: readonly string[] = Object.freeze(['coindcx_shadow', 'coindcx_quant']);
export const P18B_CANCEL_STORE_TEST_DB_PATTERN = /^p18b_cancel_store_test_[0-9a-f]{12}$/;

/** A credential-free refusal. Its message never contains the URL or any part of it. */
export class DisposableMysqlGuardError extends Error {
  constructor(message: string) {
    super(`[P18B-DISPOSABLE-MYSQL] ${message}`);
    this.name = 'DisposableMysqlGuardError';
  }
}

export function isLocalMysqlHostname(hostname: string): boolean {
  return LOCAL_MYSQL_HOSTNAMES.includes(hostname);
}

/** Parses and validates the base DATABASE_URL. Throws a credential-free DisposableMysqlGuardError on any doubt. */
export function assertLocalMysqlDatabaseUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new DisposableMysqlGuardError('refused: DATABASE_URL is not set.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DisposableMysqlGuardError('refused: DATABASE_URL is not a parseable URL.');
  }
  if (url.protocol !== 'mysql:') {
    throw new DisposableMysqlGuardError('refused: DATABASE_URL protocol is not mysql:.');
  }
  if (!isLocalMysqlHostname(url.hostname)) {
    throw new DisposableMysqlGuardError('refused: DATABASE_URL host is not a local loopback host (localhost, 127.0.0.1, ::1, [::1]).');
  }
  return url;
}

/** The database named by the base URL's path (empty when it names none). */
export function baseDatabaseName(url: URL): string {
  const path = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function generateDisposableDatabaseName(): string {
  return `p18b_cancel_store_test_${randomBytes(6).toString('hex')}`;
}

/**
 * The ONLY names CREATE/DROP may ever use. Comparisons against protected names are case-insensitive, since MySQL
 * database names are case-insensitive on Windows/macOS servers.
 */
export function assertDisposableDatabaseName(name: unknown, baseUrl: URL): string {
  if (typeof name !== 'string' || !P18B_CANCEL_STORE_TEST_DB_PATTERN.test(name)) {
    throw new DisposableMysqlGuardError('refused: the disposable database name does not match p18b_cancel_store_test_<12 hex>.');
  }
  const lowered = name.toLowerCase();
  if (PROTECTED_DATABASE_NAMES.includes(lowered)) {
    throw new DisposableMysqlGuardError('refused: the disposable database name is a protected operational database.');
  }
  if (lowered === baseDatabaseName(baseUrl).toLowerCase()) {
    throw new DisposableMysqlGuardError("refused: the disposable database name equals the base DATABASE_URL's own database.");
  }
  return name;
}

/** The host for the mysql CLI: a bracketed IPv6 literal is passed without its brackets. */
export function mysqlCliHost(url: URL): string {
  return url.hostname === '[::1]' ? '::1' : url.hostname;
}

export function mysqlCliArgs(url: URL, sql: string): string[] {
  const args = ['-h', mysqlCliHost(url), '-P', url.port || '3306', '-u', decodeURIComponent(url.username)];
  if (url.password) args.push(`-p${decodeURIComponent(url.password)}`);
  return [...args, '-e', sql];
}

/** Executes one server-level SQL statement against the (already validated) local base URL. */
export type MysqlStatementExecutor = (baseUrl: URL, sql: string) => void;

export const mysqlCliExecutor: MysqlStatementExecutor = (baseUrl, sql) => {
  execFileSync('mysql', mysqlCliArgs(baseUrl, sql), { stdio: 'pipe', timeout: 15_000 });
};

export interface DisconnectableClient {
  $disconnect(): Promise<void>;
}

export interface DisposableMysqlLifecycleOptions {
  readonly rawBaseUrl: unknown;
  readonly name: unknown;
  readonly strict: boolean;
  readonly execute?: MysqlStatementExecutor;
  readonly warn?: (message: string) => void;
}

/** A credential-free description of a failure: its class name only, never its message. */
function failureKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export class DisposableMysqlLifecycle {
  readonly #baseUrl: URL;
  readonly #name: string;
  readonly #strict: boolean;
  readonly #execute: MysqlStatementExecutor;
  readonly #warn: (message: string) => void;
  #databaseCreated = false;
  #createAttempted = false;
  #clients: DisconnectableClient[] = [];

  /** Validates the base URL, THEN the name. Nothing is executed and no client exists until both pass. */
  constructor(options: DisposableMysqlLifecycleOptions) {
    this.#baseUrl = assertLocalMysqlDatabaseUrl(options.rawBaseUrl);
    this.#name = assertDisposableDatabaseName(options.name, this.#baseUrl);
    this.#strict = options.strict;
    this.#execute = options.execute ?? mysqlCliExecutor;
    this.#warn = options.warn ?? ((message) => console.warn(message));
  }

  get name(): string {
    return this.#name;
  }

  get databaseCreated(): boolean {
    return this.#databaseCreated;
  }

  /** CREATE DATABASE for the validated name, once. `databaseCreated` is set immediately after it succeeds. */
  createDatabase(): void {
    if (this.#createAttempted) throw new DisposableMysqlGuardError('refused: CREATE DATABASE was already attempted by this lifecycle.');
    this.#createAttempted = true;
    const name = assertDisposableDatabaseName(this.#name, this.#baseUrl);
    this.#execute(this.#baseUrl, `CREATE DATABASE \`${name}\`;`);
    this.#databaseCreated = true;
  }

  /** The disposable database's URL (server part of the validated base URL, database replaced). */
  databaseUrl(parameters: Readonly<Record<string, string>> = {}): string {
    const url = new URL(this.#baseUrl.toString());
    url.pathname = `/${assertDisposableDatabaseName(this.#name, this.#baseUrl)}`;
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    return url.toString();
  }

  /** Registers a client that cleanup must disconnect. Register it immediately after constructing it. */
  track<C extends DisconnectableClient>(client: C): C {
    this.#clients.push(client);
    return client;
  }

  /**
   * Idempotent. Disconnects every tracked client (each once), then drops the database iff it was created.
   * Tracked clients are always released; `databaseCreated` is reset only after a successful DROP, so a failed
   * DROP is retried by the next cleanup call. In strict mode any failure REJECTS; otherwise it is reported via
   * `warn`. Every message is credential-free.
   */
  async cleanup(): Promise<void> {
    const failures: string[] = [];
    const clients = this.#clients;
    this.#clients = [];
    for (const client of clients) {
      try {
        await client.$disconnect();
      } catch (error) {
        failures.push(`client disconnect failed (${failureKind(error)})`);
      }
    }
    if (this.#databaseCreated) {
      try {
        const name = assertDisposableDatabaseName(this.#name, this.#baseUrl);
        this.#execute(this.#baseUrl, `DROP DATABASE IF EXISTS \`${name}\`;`);
        this.#databaseCreated = false;
      } catch (error) {
        failures.push(`DROP DATABASE ${this.#name} failed (${failureKind(error)})`);
      }
    }
    if (failures.length === 0) return;
    const error = new DisposableMysqlGuardError(`cleanup of disposable database ${this.#name} failed: ${failures.join('; ')}.`);
    if (this.#strict) throw error;
    this.#warn(error.message);
  }
}
