import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Flat config. Two worlds in this repo:
//   src/    — TypeScript browser engine (ESM)
//   server/ — Node multiplayer host + tests (CommonJS: require/module/process)
// Prettier owns formatting; eslint-config-prettier (last) disables any rule that
// would fight it. Rules are kept pragmatic — this lints an existing codebase, so
// the noisy stylistic defaults are dialed down rather than flooding the diff.
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/assets/**',
      'eb_project/**',
      '**/*.bak',
      '**/*.tmp',
    ],
  },

  // TypeScript engine (browser, ESM)
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        requestAnimationFrame: 'readonly',
        localStorage: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off', // the engine leans on `any` at the Canvas/WS boundary
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Advisory on an existing codebase — flags dead assignments without auto-
      // fix, so don't block the build or risk rewriting working logic.
      'no-useless-assignment': 'warn',
      // Stylistic: the editor tools use `status: 'ready' = 'ready'`, which is
      // valid; not worth blocking the build over `as const`.
      '@typescript-eslint/prefer-as-const': 'warn',
    },
  },

  // Node server + tests (CommonJS)
  {
    files: ['server/**/*.js', '*.config.{js,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-assignment': 'warn',
    },
  },

  prettier
);
