import { defineProject } from 'vitest/config';

// Resolve workspace packages to their TypeScript source (see tsconfig.base.json).
const conditions = ['@fireside/source', 'module', 'node', 'development|production'];

export default defineProject({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    name: 'server',
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    // CI is several times slower than a development machine and its speed
    // varies by 2× between runs: property tests that take 1 s here went over
    // the default 5 s there, a different one each time. Locally the default
    // stays, so a test that turns slow is still noticed.
    ...(process.env.CI ? { testTimeout: 30_000, hookTimeout: 60_000 } : {}),
  },
});
