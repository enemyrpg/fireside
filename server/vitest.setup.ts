import { vi } from 'vitest';

// No test may reach the network (see
// docs/decisions/0014-external-calls-through-one-module.md). Code that calls
// out takes a `fetch` argument, and tests pass a mock.
vi.stubGlobal('fetch', () => {
  throw new Error('Tests must not use the real fetch. Pass a mocked fetch instead.');
});
