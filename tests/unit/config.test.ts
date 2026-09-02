import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, resetConfigCache, validateMySqlUrl } from '../../src/app/config/env';
import { ConfigError } from '../../src/core/errors/app-error';

describe('Configuration & Environment Validation', () => {
  beforeEach(() => {
    resetConfigCache();
  });

  describe('General Configuration Parsing', () => {
    it('successfully parses valid environment configuration with defaults', () => {
      const validEnv = {
        DATABASE_URL: 'mysql://user:pass@localhost:3306/coindcx_quant',
      };

      const config = loadConfig(validEnv);

      expect(config.NODE_ENV).toBe('development');
      expect(config.PORT).toBe(3000);
      expect(config.LOG_LEVEL).toBe('info');
      expect(config.DATABASE_URL).toBe('mysql://user:pass@localhost:3306/coindcx_quant');
      expect(config.COINDCX_API_KEY).toBe('');
      expect(config.COINDCX_API_SECRET).toBe('');
    });

    it('correctly parses custom PORT and LOG_LEVEL', () => {
      const customEnv = {
        PORT: '8080',
        LOG_LEVEL: 'debug',
        NODE_ENV: 'production',
        DATABASE_URL: 'mysql://prod_user:secure@db.internal:3306/prod_quant',
      };

      const config = loadConfig(customEnv);

      expect(config.PORT).toBe(8080);
      expect(config.LOG_LEVEL).toBe('debug');
      expect(config.NODE_ENV).toBe('production');
    });

    it('throws ConfigError when NODE_ENV is unrecognized', () => {
      const invalidEnv = {
        NODE_ENV: 'staging',
        DATABASE_URL: 'mysql://u:p@localhost:3306/db',
      };

      expect(() => loadConfig(invalidEnv)).toThrow(ConfigError);
    });

    it('safely holds optional CoinDCX keys without enforcing real values in Phase 1', () => {
      const envWithKeys = {
        DATABASE_URL: 'mysql://u:p@localhost:3306/db',
        COINDCX_API_KEY: 'test-api-key',
        COINDCX_API_SECRET: 'test-api-secret',
      };

      const config = loadConfig(envWithKeys);
      expect(config.COINDCX_API_KEY).toBe('test-api-key');
      expect(config.COINDCX_API_SECRET).toBe('test-api-secret');
    });
  });

  describe('Strict PORT Validation', () => {
    const validDbUrl = 'mysql://u:p@localhost:3306/db';

    it('accepts valid TCP ports across the valid range [1, 65535]', () => {
      expect(loadConfig({ PORT: '3000', DATABASE_URL: validDbUrl }).PORT).toBe(3000);
      expect(loadConfig({ PORT: '1', DATABASE_URL: validDbUrl }).PORT).toBe(1);
      expect(loadConfig({ PORT: '65535', DATABASE_URL: validDbUrl }).PORT).toBe(65535);
      expect(loadConfig({ PORT: '80', DATABASE_URL: validDbUrl }).PORT).toBe(80);
    });

    it('falls back to default 3000 when PORT is empty string or undefined', () => {
      expect(loadConfig({ PORT: '', DATABASE_URL: validDbUrl }).PORT).toBe(3000);
      expect(loadConfig({ DATABASE_URL: validDbUrl }).PORT).toBe(3000);
    });

    it('rejects malformed non-integer string PORT=3000junk', () => {
      expect(() => loadConfig({ PORT: '3000junk', DATABASE_URL: validDbUrl })).toThrow(ConfigError);
    });

    it('rejects floating point string PORT=12.5', () => {
      expect(() => loadConfig({ PORT: '12.5', DATABASE_URL: validDbUrl })).toThrow(ConfigError);
    });

    it('rejects hexadecimal prefix string PORT=0x123', () => {
      expect(() => loadConfig({ PORT: '0x123', DATABASE_URL: validDbUrl })).toThrow(ConfigError);
    });

    it('rejects negative port string PORT=-1', () => {
      expect(() => loadConfig({ PORT: '-1', DATABASE_URL: validDbUrl })).toThrow(ConfigError);
    });

    it('rejects zero port string PORT=0', () => {
      expect(() => loadConfig({ PORT: '0', DATABASE_URL: validDbUrl })).toThrow(ConfigError);
    });

    it('rejects out of range port PORT=65536', () => {
      expect(() => loadConfig({ PORT: '65536', DATABASE_URL: validDbUrl })).toThrow(ConfigError);
    });
  });

  describe('Strict MySQL DATABASE_URL Validation', () => {
    it('accepts valid standard MySQL connection strings', () => {
      const validCases = [
        'mysql://user:pass@localhost:3306/coindcx_quant',
        'mysql://user:pass@localhost/coindcx_quant',
        'mysql://localhost:3306/coindcx_quant',
        'mysql://localhost/coindcx_quant',
        'mysql://root:secret@127.0.0.1:3306/quant_db?connection_limit=5&sslaccept=strict',
      ];

      for (const url of validCases) {
        expect(validateMySqlUrl(url).valid).toBe(true);
        expect(() => loadConfig({ DATABASE_URL: url })).not.toThrow();
      }
    });

    it('rejects missing or empty DATABASE_URL', () => {
      expect(() => loadConfig({})).toThrow(ConfigError);
      expect(() => loadConfig({ DATABASE_URL: '' })).toThrow(ConfigError);
    });

    it('rejects incomplete URL "mysql://"', () => {
      expect(validateMySqlUrl('mysql://').valid).toBe(false);
      expect(() => loadConfig({ DATABASE_URL: 'mysql://' })).toThrow(ConfigError);
    });

    it('rejects missing host URL "mysql://user:pass"', () => {
      expect(validateMySqlUrl('mysql://user:pass').valid).toBe(false);
      expect(() => loadConfig({ DATABASE_URL: 'mysql://user:pass' })).toThrow(ConfigError);
    });

    it('rejects empty hostname URL "mysql:///dbname"', () => {
      expect(validateMySqlUrl('mysql:///dbname').valid).toBe(false);
      expect(() => loadConfig({ DATABASE_URL: 'mysql:///dbname' })).toThrow(ConfigError);
    });

    it('rejects non-mysql protocols e.g. "postgresql://user:pass@localhost/db"', () => {
      expect(validateMySqlUrl('postgresql://user:pass@localhost/db').valid).toBe(false);
      expect(() => loadConfig({ DATABASE_URL: 'postgresql://user:pass@localhost/db' })).toThrow(ConfigError);
    });

    it('rejects URLs with invalid port numbers', () => {
      expect(validateMySqlUrl('mysql://u:p@localhost:99999/db').valid).toBe(false);
      expect(validateMySqlUrl('mysql://u:p@localhost:junk/db').valid).toBe(false);
      expect(() => loadConfig({ DATABASE_URL: 'mysql://u:p@localhost:99999/db' })).toThrow(ConfigError);
    });

    it('never leaks raw credentials in the validation error message', () => {
      const secretUrl = 'mysql://sensitiveUser:sensitivePass12345@localhost:99999/db';
      try {
        loadConfig({ DATABASE_URL: secretUrl });
        expect.unreachable('Should have thrown ConfigError');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const errMsg = (err as Error).message;
        expect(errMsg).not.toContain('sensitiveUser');
        expect(errMsg).not.toContain('sensitivePass12345');
      }
    });
  });
});
