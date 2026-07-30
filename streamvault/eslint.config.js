import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'playwright-report', 'playwright-report-staging', 'playwright-report-canary', 'test-results', 'coverage']),
  // ── Browser code (app, e2e) ──────────────────────────────────────────
  {
    files: ['src/**/*.{js,jsx}', 'e2e/**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  // ── Node / Vitest files (tests, configs, scripts) ────────────────────
  {
    files: ['tests/**/*.{js,jsx}', 'vitest.config.js', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  // ── Playwright config files (use Node globals) ───────────────────────
  {
    files: ['playwright*.config.{js,ts}'],
    languageOptions: {
      globals: globals.node,
    },
  },
])
