import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defaultClientConditions, defineConfig, loadEnv, type Plugin } from 'vite';
import { pwaPlugin } from './src/branding/pwa-plugin.ts';
import { themeInitPlugin } from './src/theme/theme-init-plugin.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** A module of the libraries every page needs, in pnpm's layout or a flat one. */
const VENDOR_MODULE =
  /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(?:react|react-dom|scheduler|react-router|@tanstack[\\/](?:react-query|query-core))[\\/]/;

/**
 * Fails a production build that bundles Zod. Responses are only validated in
 * development and tests; a value import from a schema module in `shared/` would
 * otherwise pull Zod in without anyone noticing.
 */
function noZodInBuild(): Plugin {
  return {
    name: 'no-zod-in-build',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        const zodModule = chunk.moduleIds.find((id) => id.includes('/node_modules/zod/'));
        if (zodModule) {
          this.error(
            `Zod ended up in ${chunk.fileName} (${zodModule}). Import plain constants from a ` +
              'module without Zod instead of a schema module.',
          );
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // PORT from the repo's .env (the server reads the same file).
  const env = loadEnv(mode, repoRoot, '');
  const apiPort = env.PORT ?? '3100';

  return {
    plugins: [react(), tailwindcss(), themeInitPlugin(), pwaPlugin(), noZodInBuild()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
      // Use the TypeScript source of workspace packages (see tsconfig.base.json).
      conditions: ['@fireside/source', ...defaultClientConditions],
    },
    build: {
      // Never inline files as data: URIs (Vite inlines small fonts by default):
      // the CSP allows fonts from this origin only.
      assetsInlineLimit: 0,
      rolldownOptions: {
        output: {
          codeSplitting: {
            // React, React Router and TanStack Query change far less often than
            // our own code, so they get their own file that stays cached across
            // releases (docs/architecture.md, "The dashboard bundle").
            groups: [{ name: 'vendor', test: VENDOR_MODULE }],
          },
        },
      },
    },
    server: {
      // The dashboard only talks to our own server. In dev, Vite forwards /api to it.
      proxy: { '/api': { target: `http://127.0.0.1:${apiPort}` } },
    },
  };
});
