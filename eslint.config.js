import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'demo-dist/', 'node_modules/', 'test-results/', 'playwright-report/', '.bundled-test/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['test/browser/server.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
);
