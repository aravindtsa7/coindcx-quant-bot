import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');

async function lintFixture(code: string, relativeFilePath: string) {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const results = await eslint.lintText(code, { filePath: path.resolve(REPO_ROOT, relativeFilePath) });
  return results.flatMap((result) => result.messages);
}

// This suite proves DIRECT import protection only: ESLint's `no-restricted-imports`
// flags an import statement that a `src/execution/**` file itself writes naming
// the CoinDCX integration surface. It does NOT prove transitive dependency-graph
// isolation (e.g. `src/execution/a` importing some `src/shared/b` that in turn
// imports `src/integration/coindcx`) — every fixture below, including the
// deep-subpath one, is still a direct import string written in the linted file
// itself. Full transitive dependency-graph enforcement is a P14-J mandatory
// final CI gate, not attempted here.
describe('P14-A paper/live structural isolation — direct import protection (V2 §25)', () => {
  it('flags a direct import of the CoinDCX integration client from src/execution', async () => {
    const messages = await lintFixture(
      "import { CoinDcxClient } from '../integration/coindcx/client';\nexport const x = 1;\n",
      'src/execution/__lint_fixture_direct__.ts',
    );
    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
  }, 20_000);

  it('flags a direct import of a deep subpath under the CoinDCX integration surface (still a direct import, not a transitive-graph test)', async () => {
    const messages = await lintFixture(
      "import type { CoinDcxStreamEnvelope } from '../integration/coindcx/websocket/types';\nexport const x = 1;\n",
      'src/execution/__lint_fixture_deep__.ts',
    );
    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
  }, 20_000);

  it('does not flag an ordinary intra-execution import', async () => {
    const messages = await lintFixture(
      "import { PaperEngineError } from './errors';\nexport const x = 1;\n",
      'src/execution/__lint_fixture_ok__.ts',
    );
    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(false);
  }, 20_000);

  it('does not flag the CoinDCX integration client import from outside src/execution', async () => {
    const messages = await lintFixture(
      "import { CoinDcxClient } from '../src/integration/coindcx/client';\nexport const x = 1;\n",
      'tests/unit/execution/__lint_fixture_outside__.ts',
    );
    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(false);
  }, 20_000);
});
