// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'src/generated'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The assignment forbids `any`. Make it an error, not a warning.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
