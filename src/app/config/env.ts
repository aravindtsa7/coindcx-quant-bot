import dotenv from 'dotenv';
import { z } from 'zod';
import { ConfigError } from '../../core/errors/app-error';

// Load environment variables from .env file if available
dotenv.config();

const STRICT_DECIMAL_PORT_REGEX = /^[1-9]\d*$/;

/**
 * Validates that a string is a strictly formatted MySQL connection URL:
 * - Scheme must be mysql:
 * - Hostname must exist and not be empty
 * - Database name must exist in pathname
 * - Port (if present) must be a decimal integer between 1 and 65535
 */
export function validateMySqlUrl(urlString: string): { valid: boolean; reason?: string } {
  try {
    const parsed = new URL(urlString);

    if (parsed.protocol !== 'mysql:') {
      return { valid: false, reason: 'Protocol must be mysql:' };
    }

    if (!parsed.hostname || parsed.hostname.trim() === '') {
      return { valid: false, reason: 'Database hostname is required' };
    }

    const dbName = parsed.pathname.replace(/^\/+/, '');
    if (!dbName || dbName.trim() === '') {
      return { valid: false, reason: 'Database name is required' };
    }

    if (parsed.port) {
      if (!STRICT_DECIMAL_PORT_REGEX.test(parsed.port)) {
        return { valid: false, reason: 'Port must be a decimal integer' };
      }
      const portNum = Number(parsed.port);
      if (portNum < 1 || portNum > 65535) {
        return { valid: false, reason: 'Port must be between 1 and 65535' };
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'Malformed URL format' };
  }
}

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z
    .string()
    .default('3000')
    .transform((val) => (val === '' ? '3000' : val))
    .refine((val) => STRICT_DECIMAL_PORT_REGEX.test(val), {
      message: 'PORT must be a valid decimal integer string representing a TCP port',
    })
    .transform((val) => Number(val))
    .refine((val) => val >= 1 && val <= 65535, {
      message: 'PORT must be a valid TCP port between 1 and 65535',
    }),
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL is required')
    .refine((val) => validateMySqlUrl(val).valid, {
      message:
        'DATABASE_URL must be a valid MySQL connection string with a valid hostname and database name (e.g. mysql://user:pass@localhost:3306/dbname)',
    }),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  // Reserved for future phases - not required or validated in Phase 1
  COINDCX_API_KEY: z.string().optional().default(''),
  COINDCX_API_SECRET: z.string().optional().default(''),
  // CoinDCX does not expose a safely documented pre-mutation credential-owner
  // proof in Phase 17, so deployment must bind credentials to this trusted
  // configured account identity.
  COINDCX_LIVE_ACCOUNT_ID: z.string().optional().default(''),
  // Provider trading-account binding for live execution: the lowercase
  // 64-hex SHA-256 of the expected users/info `coindcx_id` (never the raw
  // identifier). CoinDCX has confirmed `coindcx_id` is permanent across API-key
  // rotation and distinct per subaccount. Empty (the default) keeps live
  // execution disabled; see `resolveLiveExecutionGate`.
  COINDCX_EXPECTED_ACCOUNT_FINGERPRINT: z.string().optional().default(''),

  // -------------------------------------------------------------------------
  // Phase 17 — live order mutation. DISABLED BY DEFAULT (P17-I04).
  //
  // Every default below is the closed one: the flag defaults to the exact
  // string 'false', and both allowlists plus the notional ceiling default to
  // empty. The authoritative decision is made by `resolveLiveExecutionGate`
  // (`src/execution/live/gate.ts`), which additionally requires
  // NODE_ENV=production and non-empty CoinDCX credentials. Nothing here can
  // enable live trading on its own, and an absent or malformed value can never
  // flip it on.
  // -------------------------------------------------------------------------
  LIVE_EXECUTION_ENABLED: z.string().optional().default('false'),
  LIVE_EXECUTION_ACCOUNT_ALLOWLIST: z.string().optional().default(''),
  LIVE_EXECUTION_PAIR_ALLOWLIST: z.string().optional().default(''),
  LIVE_EXECUTION_MAX_ORDER_NOTIONAL_INR: z.string().optional().default(''),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cachedConfig: AppConfig | null = null;

/**
 * Validates and loads application configuration from environment variables.
 * Sensitive values are never printed in error messages.
 */
export function loadConfig(envInput: Record<string, unknown> = process.env): AppConfig {
  const parseResult = EnvSchema.safeParse(envInput);

  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    const message = issues.map((i) => `${i.field}: ${i.message}`).join('; ');

    throw new ConfigError(`Configuration validation failed: ${message}`, {
      issues,
    });
  }

  return parseResult.data;
}

/**
 * Returns cached application config or loads it if not already initialized.
 */
export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

/**
 * Reset cached config (primarily for testing).
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}
