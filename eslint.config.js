// ESLint 9 flat config —— 手写最小集(skip eslint-config-expo preset,与 TS-eslint v8 不兼容)。
// 覆盖目标:
//   - React + React Hooks + React Native (带 react/jsx-runtime)
//   - TypeScript explicit-any/ts-ignore/explicit-return 禁区
//   - Prettier 不冲突(交由独立工具跑)
// 此处故意不加大 expo preset:其内嵌 ban-types/no-redeclare 等规则名
// 已与 typescript-eslint@^8 移除的规则冲突,逐一排查太贵。
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const reactPlugin = require('eslint-plugin-react');
const reactHooksPlugin = require('eslint-plugin-react-hooks');
const prettierConfig = require('eslint-config-prettier');

const reactRecommendedFlat = reactPlugin.configs?.recommended?.flat ?? null;
const reactHooksRecommendedFlat = reactHooksPlugin.configs?.recommended?.flat ?? null;

module.exports = [
  {
    ignores: [
      'node_modules/',
      'ios/Pods/',
      'ios/build/',
      'android/build/',
      'android/app/build/',
      '.expo/',
      'dist/',
      'web-build/',
      // test verify scripts 是 tsx 入口,不会被 Node 当前工程 tsc 编译,跳过
      'scripts/',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      globals: {
        __DEV__: 'readonly',
        ErrorUtils: 'readonly',
        FormData: 'readonly',
        XMLHttpRequest: 'readonly',
        alert: 'readonly',
        cancelAnimationFrame: 'readonly',
        cancelIdleCallback: 'readonly',
        clearImmediate: 'readonly',
        fetch: 'readonly',
        navigator: 'readonly',
        process: 'readonly',
        requestAnimationFrame: 'readonly',
        requestIdleCallback: 'readonly',
        setImmediate: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        console: 'readonly',
        global: 'readonly',
      },
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: __dirname,
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      'react/react-in-jsx-scope': 'off', // react 17+ 不再需要
      'react/prop-types': 'off',         // TS 项目用 prop-types 是冗余
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // 风格规则
      'no-shadow': ['error', { builtinGlobals: true, hoist: 'all' }],
      'no-unused-vars': 'off', // typescript-eslint/no-unused-variants 更准
      // TS: 项目对资金安全敏感,any/ts-ignore/explicit-return 严格化
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': 'allow-with-description',
          'ts-expect-error': 'allow-with-description',
          'ts-nocheck': true,
        },
      ],
      '@typescript-eslint/explicit-module-boundary-types': [
        'error',
        { allowedNames: ['default'] },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/__tests__/**/*.ts', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off', // 测试 mock 常用 any
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  prettierConfig, // 关掉 react/TS 的 format 冲突,最后一行
];
