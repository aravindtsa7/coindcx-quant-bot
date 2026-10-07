/**
 * M2 W2: explicit coordinator and client configuration. No defaults; every value is supplied by the caller.
 * Values used in tests are fixtures, not approved production values (U-M2-8).
 */
import path from 'node:path';
import { types } from 'node:util';
import { BUDGET_SCOPES, validateRateLimiterConfig, type BudgetScope, type RateLimiterConfig } from '../config';

/** Windows named pipe in the local namespace. IPC is a trusted-host prototype: no ACL or remote-client exclusion is claimed. */
const PIPE = /^\\\\\.\\pipe\\[A-Za-z0-9._-]{1,200}$/;
export interface CoordinatorConfig {
  readonly limiter: RateLimiterConfig;
  readonly stateDirectory: string;
  readonly pipePath: string;
  readonly maxFrameBytes: number;
  readonly maxStateBytes: number;
  readonly tickMs: number;
  readonly handshakeTimeoutMs: number;
  readonly maxSessions: number;
  readonly maxRegisteredClients: number;
  readonly maxPendingRequestsPerSession: number;
}
export interface ClientConfig {
  readonly pipePath: string;
  readonly maxFrameBytes: number;
  readonly connectTimeoutMs: number;
  readonly probeScopes: readonly BudgetScope[];
  readonly maxOutbox: number;
}
export type ConfigResult<T> = Readonly<{ kind: 'VALID'; config: T }> | Readonly<{ kind: 'INVALID'; reason: string }>;

const COORDINATOR_KEYS = ['limiter', 'stateDirectory', 'pipePath', 'maxFrameBytes', 'maxStateBytes', 'tickMs', 'handshakeTimeoutMs', 'maxSessions', 'maxRegisteredClients', 'maxPendingRequestsPerSession'] as const;
const CLIENT_KEYS = ['pipePath', 'maxFrameBytes', 'connectTimeoutMs', 'probeScopes', 'maxOutbox'] as const;
const INTEGER_KEYS = ['maxFrameBytes', 'maxStateBytes', 'tickMs', 'handshakeTimeoutMs', 'maxSessions', 'maxRegisteredClients', 'maxPendingRequestsPerSession'] as const;

function plain(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || types.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !keys.every((key) => own.includes(key))) return null;
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (d === undefined || !('value' in d)) return null; }
  return value as Readonly<Record<string, unknown>>;
}
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

export function validateCoordinatorConfig(input: unknown): ConfigResult<CoordinatorConfig> {
  const fail = (reason: string): ConfigResult<CoordinatorConfig> => Object.freeze({ kind: 'INVALID', reason });
  const root = plain(input, COORDINATOR_KEYS);
  if (root === null) return fail('CONFIG_SHAPE');
  const limiter = validateRateLimiterConfig(root.limiter);
  if (limiter.kind !== 'VALID') return fail(`LIMITER_${limiter.reason}`);
  if (typeof root.stateDirectory !== 'string' || !path.isAbsolute(root.stateDirectory)) return fail('STATE_DIRECTORY');
  if (typeof root.pipePath !== 'string' || !PIPE.test(root.pipePath)) return fail('PIPE_PATH');
  for (const key of INTEGER_KEYS) if (!positive(root[key])) return fail(key);
  if ((root.maxFrameBytes as number) < 1024 || (root.maxStateBytes as number) < 4096) return fail('SIZE_LIMITS');
  return Object.freeze({ kind: 'VALID', config: Object.freeze({
    limiter: limiter.config, stateDirectory: path.resolve(root.stateDirectory), pipePath: root.pipePath,
    ...Object.fromEntries(INTEGER_KEYS.map((key) => [key, root[key] as number])),
  } as CoordinatorConfig) });
}

export function validateClientConfig(input: unknown): ConfigResult<ClientConfig> {
  const fail = (reason: string): ConfigResult<ClientConfig> => Object.freeze({ kind: 'INVALID', reason });
  const root = plain(input, CLIENT_KEYS);
  if (root === null) return fail('CONFIG_SHAPE');
  if (typeof root.pipePath !== 'string' || !PIPE.test(root.pipePath)) return fail('PIPE_PATH');
  for (const key of ['maxFrameBytes', 'connectTimeoutMs', 'maxOutbox'] as const) if (!positive(root[key])) return fail(key);
  const scopes = root.probeScopes;
  if (!Array.isArray(scopes) || types.isProxy(scopes) || scopes.length > 2 || new Set(scopes).size !== scopes.length || !scopes.every((s) => (BUDGET_SCOPES as readonly unknown[]).includes(s))) return fail('PROBE_SCOPES');
  return Object.freeze({ kind: 'VALID', config: Object.freeze({
    pipePath: root.pipePath, maxFrameBytes: root.maxFrameBytes as number, connectTimeoutMs: root.connectTimeoutMs as number,
    probeScopes: Object.freeze([...scopes] as BudgetScope[]), maxOutbox: root.maxOutbox as number,
  }) });
}
