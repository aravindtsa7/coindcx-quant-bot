import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('.dockerignore Validation', () => {
  const dockerignorePath = path.resolve(__dirname, '../../.dockerignore');

  it('verifies that .dockerignore exists in the repository root', () => {
    expect(fs.existsSync(dockerignorePath)).toBe(true);
  });

  it('verifies that .dockerignore is non-empty', () => {
    const stats = fs.statSync(dockerignorePath);
    expect(stats.size).toBeGreaterThan(0);
  });

  it('excludes at minimum all required sensitive files and build caches', () => {
    const rawContent = fs.readFileSync(dockerignorePath, 'utf8');
    const lines = rawContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    const requiredExclusions = [
      '.git',
      '.env',
      '.env.*',
      'node_modules',
      'dist',
      'coverage',
      'logs',
      '*.log',
    ];

    for (const pattern of requiredExclusions) {
      expect(lines).toContain(pattern);
    }
  });

  it('does NOT accidentally exclude essential Dockerfile build inputs', () => {
    const rawContent = fs.readFileSync(dockerignorePath, 'utf8');
    const lines = rawContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    const requiredBuildInputs = [
      'package.json',
      'package-lock.json',
      'src',
      'prisma',
      'tsconfig.json',
    ];

    for (const input of requiredBuildInputs) {
      expect(lines).not.toContain(input);
    }
  });
});

