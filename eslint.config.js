import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// The Node globals the plain-JS files use (bin/ctxlint.mjs, scripts/*.mjs,
// build.mjs). Listed by hand rather than through the `globals` package, which
// is not a dependency here; TypeScript files get their globals from @types/node
// and the type checker instead.
const nodeGlobals = Object.fromEntries(
  ['AbortSignal', 'Buffer', 'URL', 'clearTimeout', 'console', 'fetch', 'process', 'setTimeout'].map(
    (name) => [name, 'readonly'],
  ),
);

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'fixtures/', 'node_modules/', '*.config.*'],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-useless-escape': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: nodeGlobals },
  },
);
