import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { testConfig, testDatabase } from './test-utils.js';

describe('listen', () => {
  const config = testConfig();
  let app: FastifyInstance;
  beforeEach(() => {
    app = buildApp({ db: testDatabase(), config });
  });
  afterEach(() => app.close());

  it('listens only on 127.0.0.1 with the default config', async () => {
    // Port 0 (random) is for tests only; config requires 1–65535.
    await app.listen({ host: config.host, port: 0 });

    const address = app.server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    expect(address.port).toBeGreaterThan(0);
  });
});
