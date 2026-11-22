import { defineProject, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

export default mergeConfig(
  viteConfig({ mode: 'test', command: 'serve' }),
  defineProject({
    test: {
      name: 'web',
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      // A browser zone far from the server's TZ, so tests catch any date
      // formatted in browser time instead of the server's.
      env: { TZ: 'America/Los_Angeles' },
    },
  }),
);
