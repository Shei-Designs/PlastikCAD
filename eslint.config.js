// Lint for the mistakes the type checker does not see: React hooks called out of
// order or with stale values, and a few plain correctness rules. Style is left
// to the code itself; this is not a formatter.
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'src-tauri/', 'fixtures/', 'node_modules/', 'e2e-report/', 'e2e-results/', 'docs/', 'public/'] },
  {
    files: ['src/**/*.{ts,tsx}', 'e2e/**/*.ts'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { 'react-hooks': reactHooks, '@typescript-eslint': tseslint.plugin },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // What tsc with noUnusedLocals already says is not said twice; these it does not say.
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-dupe-else-if': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-fallthrough': 'error',
      'no-async-promise-executor': 'error',
      'no-cond-assign': 'error',
      'no-debugger': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
);
