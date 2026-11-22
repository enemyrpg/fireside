import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { testConfig, testDatabase } from '../test-utils.js';
import { loginApp, type LoginApp, type Method } from '../users/testing.js';

// An unknown path under /api/v1 goes through the dashboard hook, so in login
// mode it gives the same 401 as a real route before login, and the routes can't
// be mapped without a session.

const UNKNOWN = '/api/v1/no-such-route';

/** A real `user` route per method, all of which need a session. */
const KNOWN: [Method, string][] = [
  ['GET', '/api/v1/keys'],
  ['POST', '/api/v1/keys'],
  ['PATCH', '/api/v1/accounts/1'],
  ['DELETE', '/api/v1/keys/1'],
];

describe('unknown /api/v1 paths in login mode', () => {
  let t: LoginApp & { adminToken: string };

  beforeEach(async () => {
    t = await loginApp(testDatabase());
  });
  afterEach(() => t.app.close());

  it.each(KNOWN)('%s gives the same 401 as %s without a session', async (method, known) => {
    const payload = method === 'GET' || method === 'DELETE' ? undefined : {};
    const unknown = await t.send(method, UNKNOWN, { payload });
    const real = await t.send(method, known, { payload });
    expect(real.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(unknown.body).toBe(real.body);
    expect(unknown.headers).toEqual(real.headers);
  });

  it.each([UNKNOWN, '/api/v1/admin/nope', '/api/v1/accounts/1/nope', '/api/v1/ingestfoo'])(
    'gives 401 for %s without a session',
    async (url) => {
      expect((await t.send('GET', url)).statusCode).toBe(401);
    },
  );

  it('gives 404 once logged in, to admins and members alike', async () => {
    expect((await t.send('GET', UNKNOWN, { token: t.adminToken })).statusCode).toBe(404);
    const member = await t.addUser('kari');
    const response = await t.send('GET', '/api/v1/admin/nope', { token: member.token });
    expect(response.statusCode).toBe(404);
  });

  it('checks the network and CSRF first', async () => {
    const remote = await t.send('GET', UNKNOWN, { remoteAddress: '192.0.2.4' });
    expect(remote.statusCode).toBe(403);
    const crossSite = await t.send('POST', UNKNOWN, {
      payload: {},
      headers: { origin: 'https://evil.example.com' },
    });
    expect(crossSite.statusCode).toBe(403);
  });

  it('leaves health, ingest and paths outside /api/v1 as they were', async () => {
    expect((await t.send('GET', '/api/v1/health')).statusCode).toBe(200);
    // Unknown ingest paths: 401 without a key, as before (ingest's own handler).
    const ingest = await t.send('GET', '/api/v1/ingest/nope');
    expect(ingest.statusCode).toBe(401);
    expect(ingest.headers['www-authenticate']).toBe('Bearer');
    expect((await t.send('GET', '/api/v2/anything')).statusCode).toBe(404);
  });
});

describe('unknown /api/v1 paths in local mode', () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = buildApp({ db: testDatabase(), config: testConfig() });
  });
  afterEach(() => app.close());

  it('gives 404 on this machine, as before', async () => {
    const response = await app.inject({
      method: 'GET',
      url: UNKNOWN,
      headers: { host: 'localhost' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('gives the local-only 403 from elsewhere', async () => {
    const response = await app.inject({
      method: 'GET',
      url: UNKNOWN,
      headers: { host: 'localhost' },
      remoteAddress: '192.0.2.4',
    });
    expect(response.statusCode).toBe(403);
  });
});
