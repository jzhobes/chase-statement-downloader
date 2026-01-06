module.exports = {
  env: {
    node: true,
    commonjs: true,
    es2021: true,
  },
  extends: ['airbnb-base', 'prettier', 'plugin:playwright/recommended'],
  parserOptions: {
    ecmaVersion: 'latest',
  },
  rules: {
    'no-console': 'off',
    'no-await-in-loop': 'off',
    'no-restricted-syntax': 'off',
    'consistent-return': 'off',
    'no-continue': 'off',
    'one-var': 'off',
    'arrow-body-style': 'off',
  },
  globals: {
    window: 'readonly',
    document: 'readonly',
  },
};
