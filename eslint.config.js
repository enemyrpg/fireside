// @ts-check
import js from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The project name and API key prefix must only appear in
// shared/src/branding.ts. Scoped package names (`@fireside/...`) are allowed.
const brandingMessage =
  'Do not hardcode the project name or API key prefix. Use BRANDING from @fireside/shared.';
const brandingPatterns = [String.raw`/(?<!@)fireside/i`, String.raw`/\bfs_/`];
const brandingRules = brandingPatterns.flatMap((pattern) => [
  { selector: `Literal[value=${pattern}]`, message: brandingMessage },
  { selector: `TemplateElement[value.raw=${pattern}]`, message: brandingMessage },
  { selector: `JSXText[value=${pattern}]`, message: brandingMessage },
]);

// The server may only reach the network through server/src/external/client.ts
// (see docs/decisions/0014-external-calls-through-one-module.md): off unless
// enabled in `.env`, with our User-Agent, a timeout, retries, a rate limit and
// safe logging.
const networkMessage =
  'External calls must go through server/src/external/client.ts (createExternalClient).';
const networkGlobals = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];
const networkModules = ['http', 'https', 'http2', 'tls', 'dgram'];
// `import('node:https')` and `require('node:https')` get past
// no-restricted-imports, so they are matched by name here. A dynamic import
// can't be limited to some exports, so `net` is banned whole in that form.
const networkModulePattern = String.raw`/^(node:)?(${[...networkModules, 'net', 'undici'].join('|')})(\/.*)?$/`;
const networkSyntaxRules = [
  `ImportExpression[source.value=${networkModulePattern}]`,
  `ImportExpression[source.quasis.0.value.raw=${networkModulePattern}]`,
  `CallExpression[callee.name='require'][arguments.0.value=${networkModulePattern}]`,
  `CallExpression[callee.name='require'][arguments.0.quasis.0.value.raw=${networkModulePattern}]`,
  `TSImportEqualsDeclaration[moduleReference.expression.value=${networkModulePattern}]`,
].map((selector) => ({ selector, message: networkMessage }));

/** @type {import('eslint').Linter.RulesRecord} */
const networkRules = {
  // Replaces the general rule for server/, so the branding patterns are repeated.
  'no-restricted-syntax': ['error', ...brandingRules, ...networkSyntaxRules],
  'no-restricted-globals': [
    'error',
    ...networkGlobals.map((name) => ({ name, message: networkMessage })),
  ],
  'no-restricted-properties': [
    'error',
    ...['globalThis', 'global'].flatMap((object) =>
      networkGlobals.map((property) => ({ object, property, message: networkMessage })),
    ),
  ],
  'no-restricted-imports': [
    'error',
    {
      paths: [
        ...[...networkModules, 'undici'].flatMap((name) => [
          { name, message: networkMessage },
          { name: `node:${name}`, message: networkMessage },
        ]),
        // Address helpers like isIP and types are fine; opening a connection is not.
        ...['net', 'node:net'].map((name) => ({
          name,
          importNames: ['connect', 'createConnection', 'Socket', 'default'],
          message: networkMessage,
        })),
      ],
    },
  ],
};

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/', 'docs/']),
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
  },
  comments.recommended,
  {
    rules: {
      // `any` needs an eslint-disable comment, and that comment needs a reason.
      '@typescript-eslint/no-explicit-any': 'error',
      '@eslint-community/eslint-comments/require-description': 'error',
      '@eslint-community/eslint-comments/no-unused-disable': 'error',
      'no-restricted-syntax': ['error', ...brandingRules],
    },
  },
  {
    // branding.ts defines the name; this file defines the patterns above.
    files: ['shared/src/branding.ts', 'eslint.config.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['server/**/*.{ts,js}'],
    rules: networkRules,
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
  {
    // No import cycles in the dashboard. A cycle can leave an import
    // undefined (or throw) while a module loads, depending on which file is
    // loaded first. That broke Settings → Server. Type-only imports are erased
    // and don't count. A cycle that is truly safe gets an eslint-disable
    // comment that says why.
    files: ['web/src/**/*.{ts,tsx}'],
    plugins: { 'import-x': importX },
    settings: {
      // Without these, import-x can't parse the imported .ts/.tsx files and
      // silently sees no cycles.
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts', '.tsx'] },
      'import-x/extensions': ['.ts', '.tsx'],
      'import-x/resolver-next': [createTypeScriptImportResolver({ project: 'web/tsconfig.json' })],
    },
    rules: { 'import-x/no-cycle': ['error', { ignoreExternal: true }] },
  },
  {
    // shadcn/ui components export their variant helpers next to the component.
    files: ['web/src/components/ui/**/*.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  prettier,
);
