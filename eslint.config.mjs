import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      'no-await-in-loop': 'off',
      'no-console': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  prettier,
  {
    rules: {
      curly: ['error', 'all'],
    },
  },
);
