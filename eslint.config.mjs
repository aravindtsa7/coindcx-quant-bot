import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Phase14 paper/live structural isolation (V2 §25): this rule gives
    // DIRECT import protection only — it flags a `src/execution/**` file that
    // itself writes an import statement naming the CoinDCX integration
    // surface (order-placement client, websocket order streams). It does NOT
    // prove true transitive dependency-graph isolation (e.g. `src/execution/a`
    // importing `src/shared/b`, which in turn imports
    // `src/integration/coindcx`) — that full-graph enforcement is a P14-J
    // mandatory final CI gate, not solved here. Read-only market evidence
    // must flow through Phase14's own evidence interfaces
    // (`src/execution/evidence.ts`, `src/execution/mark.ts`), never the raw
    // exchange client.
    files: ['src/execution/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/integration/coindcx/**', '**/integration/coindcx'],
              message: 'src/execution (paper trading) must never directly import the CoinDCX integration surface — it is a mutation-capable exchange client boundary Phase14 must stay structurally isolated from. (Direct import protection only; full transitive dependency-graph isolation is a P14-J gate.)',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'src/generated/**'],
  }
);

