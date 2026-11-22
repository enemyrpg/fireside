import { Writable } from 'node:stream';
import {
  BRANDING,
  authMeResponseSchema,
  errorResponseSchema,
  loginResponseSchema,
  type AuthMeResponse,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createApiKey } from '../auth/api-keys.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { AuthLimiters } from '../auth/login-limiter.js';
import { hashSessionToken, SESSION_REFRESH_MS, SESSION_TTL_MS } from '../auth/sessions.js';
import type { Database } from '../db/index.js';
import { auditLog, users, userSessions } from '../db/schema.js';
import { testConfig, testDatabase, TEST_OWNER } from '../test-utils.js';
import { createPasswordHasher, type PasswordHasher } from '../users/password.js';
import { createUser, FIRST_USER_ID, setPasswordHash } from '../users/users.js';

const START = Date.parse('2026-11-18T12:00:00.000Z');
const HOST = 'localhost:3100';
const ORIGIN = `http://${HOST}`;
const PASSWORD = 'correct horse battery';
const CHEAP = { memory: 64, passes: 1, parallelism: 1 };
const INVALID_LOGIN = {
  error: { code: 'UNAUTHORIZED', message: 'Invalid username or password', details: [] },
};

/** Counts verify calls, so "one argon2 verify per attempt" can be checked without timing. */
function countingHasher() {
  const inner = createPasswordHasher({ params: CHEAP });
  const calls = { hash: 0, verify: 0 };
  const hasher: PasswordHasher = {
    hash: (password) => {
      calls.hash += 1;
      return inner.hash(password);
    },
    verify: (password, stored) => {
      calls.verify += 1;
      return inner.verify(password, stored);
    },
  };
  return { hasher, calls };
}

function tokenFrom(response: LightMyRequestResponse): string | undefined {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  const match = value === undefined ? null : new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(value);
  return match?.[1];
}

describe('/api/v1/auth', () => {
  let database: Database;
  let app: FastifyInstance;
  let now: number;
  let hasher: PasswordHasher;
  let calls: { hash: number; verify: number };
  let logs: string[];

  function makeApp(env: Record<string, string> = {}) {
    ({ hasher, calls } = countingHasher());
    const limiters = new AuthLimiters({ now: () => new Date(now) });
    logs = [];
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logs.push(chunk.toString());
        callback();
      },
    });
    return buildApp({
      db: database,
      config: testConfig({ LOG_LEVEL: 'trace', ...env }),
      logStream,
      dashboard: { now: () => new Date(now), auth: { hasher, limiters } },
    });
  }

  beforeEach(() => {
    now = START;
    database = testDatabase();
    app = makeApp();
  });
  afterEach(() => app.close());

  async function setPassword(userId = FIRST_USER_ID, password = PASSWORD) {
    setPasswordHash(database.db, userId, await hasher.hash(password));
  }

  const send = (method: 'GET' | 'POST' | 'DELETE', url: string, options: InjectOptions = {}) =>
    app.inject({
      method,
      url,
      ...options,
      headers: {
        host: HOST,
        ...(method === 'GET' ? {} : { origin: ORIGIN }),
        ...options.headers,
      },
    });
  const withCookie = (token: string | undefined) => ({
    cookie: `${SESSION_COOKIE}=${token ?? ''}`,
  });
  const login = (username: string, password: string, headers: Record<string, string> = {}) =>
    send('POST', '/api/v1/auth/login', { payload: { username, password }, headers });
  const me = async (token?: string): Promise<AuthMeResponse> =>
    authMeResponseSchema.parse(
      (await send('GET', '/api/v1/auth/me', token ? { headers: withCookie(token) } : {})).json(),
    );
  const sessionRows = () => database.db.select().from(userSessions).all();

  async function loggedIn(username = 'admin', password = PASSWORD): Promise<string> {
    const response = await login(username, password);
    expect(response.statusCode).toBe(200);
    const token = tokenFrom(response);
    expect(token).toBeDefined();
    return token ?? '';
  }

  describe('local mode (no password set)', () => {
    it('is the default and acts as user 1 without login', async () => {
      expect(await me()).toEqual({
        mode: 'local',
        user: {
          id: 1,
          username: 'admin',
          role: 'admin',
          canCreateApiKeys: true,
          twoFactorEnabled: false,
        },
      });
      expect((await send('GET', '/api/v1/keys')).statusCode).toBe(200);
      expect((await send('GET', '/api/v1/accounts')).statusCode).toBe(200);
      // A POST without Origin (curl) still works, as before.
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/keys',
            payload: { name: 'curl' },
            headers: { host: HOST },
          })
        ).statusCode,
      ).toBe(201);
    });

    it('refuses login with 409', async () => {
      const response = await login('admin', PASSWORD);
      expect(response.statusCode).toBe(409);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('CONFLICT');
    });

    it('stays local with a second user that has no password (made outside the CLI)', async () => {
      createUser(database.db, 'second');
      expect((await me()).mode).toBe('local');
    });

    it('sets the first password from the dashboard, which turns login on and logs in', async () => {
      const response = await send('POST', '/api/v1/auth/password', {
        payload: { newPassword: PASSWORD },
      });
      expect(response.statusCode).toBe(204);
      const token = tokenFrom(response);
      expect(await me(token)).toEqual({
        mode: 'login',
        user: {
          id: 1,
          username: 'admin',
          role: 'admin',
          canCreateApiKeys: true,
          twoFactorEnabled: false,
        },
      });
      expect((await send('GET', '/api/v1/keys')).statusCode).toBe(401);
      expect(database.db.select().from(auditLog).all()).toMatchObject([
        { action: 'user.set_password', actorUserId: 1, target: 'user:1' },
      ]);
    });

    it('refuses currentPassword and a short first password', async () => {
      const withCurrent = await send('POST', '/api/v1/auth/password', {
        payload: { currentPassword: 'x', newPassword: PASSWORD },
      });
      expect(withCurrent.statusCode).toBe(400);
      expect(withCurrent.json()).toMatchObject({
        error: { details: [{ path: 'body.currentPassword' }] },
      });
      const short = await send('POST', '/api/v1/auth/password', {
        payload: { newPassword: 'too short' },
      });
      expect(short.statusCode).toBe(400);
      expect(short.json()).toMatchObject({ error: { details: [{ path: 'body.newPassword' }] } });
      expect((await me()).mode).toBe('local');
    });

    it('keeps the local-only check, now with Cloudflare headers too', async () => {
      const remote = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        remoteAddress: '192.168.1.20',
        headers: { host: HOST },
      });
      expect(remote.statusCode).toBe(403);
      for (const header of ['cf-connecting-ip', 'cf-ray', 'cdn-loop', 'cf-visitor']) {
        const proxied = await app.inject({
          url: '/api/v1/auth/me',
          headers: { host: HOST, [header]: 'x' },
        });
        expect(proxied.statusCode, header).toBe(403);
      }
    });
  });

  describe('login mode', () => {
    beforeEach(async () => {
      await setPassword();
    });

    it('starts as soon as a user has a password, logged out', async () => {
      expect(await me()).toEqual({ mode: 'login', user: null });
    });

    it('logs in and sets a strict __Host- cookie with only its hash stored', async () => {
      const response = await login('Admin ', PASSWORD);
      expect(response.statusCode).toBe(200);
      expect(loginResponseSchema.parse(response.json())).toEqual({
        user: {
          id: 1,
          username: 'admin',
          role: 'admin',
          canCreateApiKeys: true,
          twoFactorEnabled: false,
        },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      const header = response.headers['set-cookie'];
      const lines = Array.isArray(header) ? header : [String(header)];
      const cookie = lines.find((line) => line.startsWith(`${SESSION_COOKIE}=`)) ?? '';
      expect(SESSION_COOKIE).toBe(`__Host-${BRANDING.shortName}_session`);
      expect(cookie).toMatch(
        new RegExp(
          `^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Strict$`,
        ),
      );
      // The device cookie: same attributes, one year.
      const device = lines.find((line) => line.startsWith(`__Host-${BRANDING.shortName}_device=`));
      expect(device).toMatch(
        /^__Host-[a-z]+_device=[A-Za-z0-9_-]{43}; Max-Age=31536000; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
      );
      expect(lines).toHaveLength(2);
      expect(lines.join('\n')).not.toMatch(/Domain/i);
      const token = tokenFrom(response) ?? '';
      const rows = sessionRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(hashSessionToken(token));
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(database.db.select().from(users).get()?.lastLoginAt).toBe(
        new Date(START).toISOString(),
      );
      expect(await me(token)).toMatchObject({ mode: 'login', user: { username: 'admin' } });
      expect((await send('GET', '/api/v1/keys', { headers: withCookie(token) })).statusCode).toBe(
        200,
      );
    });

    it('needs a session on every other dashboard route', async () => {
      for (const url of ['/api/v1/keys', '/api/v1/accounts', '/api/v1/admin/icons']) {
        const response = await send('GET', url);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          error: { code: 'UNAUTHORIZED', message: 'Log in to continue', details: [] },
        });
      }
      expect((await send('POST', '/api/v1/admin/rebuild')).statusCode).toBe(401);
      // Health and ingest are outside the dashboard scope, as before.
      expect((await send('GET', '/api/v1/health')).statusCode).toBe(200);
    });

    it('answers unknown dashboard paths with 401 before login, like a real route', async () => {
      const unknown = await send('GET', '/api/v1/no-such-route');
      const known = await send('GET', '/api/v1/keys');
      expect(unknown.statusCode).toBe(401);
      expect(unknown.body).toBe(known.body);
      expect(unknown.headers).toEqual(known.headers);
    });

    it.each([
      ['an unknown user', 'nobody', PASSWORD],
      ['a wrong password', 'admin', 'wrong password!'],
    ])('gives the same 401 and one verify for %s', async (_name, username, password) => {
      calls.verify = 0;
      const response = await login(username, password);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(INVALID_LOGIN);
      expect(calls.verify).toBe(1);
      expect(tokenFrom(response)).toBeUndefined();
      expect(sessionRows()).toEqual([]);
    });

    it('gives the same 401 for a disabled user and a user without password', async () => {
      const second = createUser(database.db, 'second');
      const third = createUser(database.db, 'third');
      await setPassword(second);
      database.db
        .update(users)
        .set({ disabledAt: new Date(START).toISOString() })
        .where(eq(users.id, second))
        .run();
      for (const name of ['second', 'third']) {
        calls.verify = 0;
        const response = await login(name, PASSWORD);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual(INVALID_LOGIN);
        expect(calls.verify).toBe(1);
      }
      expect(third).toBeGreaterThan(second);
    });

    it.each([
      [{ username: 'admin' }, 'body.password'],
      [{ password: PASSWORD }, 'body.username'],
      [{ username: 'admin', password: PASSWORD, remember: true }, 'body'],
      [{ username: 'admin', password: 'x'.repeat(1025) }, 'body.password'],
      [{ username: 'admin', password: 123 }, 'body.password'],
    ])('validates the body %j', async (payload, path) => {
      const response = await send('POST', '/api/v1/auth/login', { payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'VALIDATION_ERROR', details: [{ path }] },
      });
    });

    it('rejects broken JSON with 400 and a non-JSON body with 415', async () => {
      const broken = await send('POST', '/api/v1/auth/login', {
        payload: '{"username":',
        headers: { 'content-type': 'application/json' },
      });
      expect(broken.statusCode).toBe(400);
      expect(broken.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
      const text = await send('POST', '/api/v1/auth/login', {
        payload: 'username=admin&password=x',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(text.statusCode).toBe(415);
      const plain = await send('POST', '/api/v1/auth/login', {
        payload: '{"username":"admin","password":"correct horse battery"}',
        headers: { 'content-type': 'text/plain' },
      });
      expect(plain.statusCode).toBe(415);
    });

    it('refuses a login with no Origin (CSRF)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'admin', password: PASSWORD },
        headers: { host: HOST },
      });
      expect(response.statusCode).toBe(403);
      expect(sessionRows()).toEqual([]);
    });

    it.each([
      ['a foreign Origin', { origin: 'https://evil.example' }],
      ['another port', { origin: 'http://localhost:5555' }],
      ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
      ['Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }],
    ])('refuses a login with %s (CSRF)', async (_name, headers) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'admin', password: PASSWORD },
        headers: { host: HOST, origin: ORIGIN, ...headers },
      });
      expect(response.statusCode).toBe(403);
      expect(sessionRows()).toEqual([]);
    });

    it('refuses a change without Origin even with a valid session', async () => {
      const token = await loggedIn();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/keys',
        payload: { name: 'x' },
        headers: { host: HOST, ...withCookie(token) },
      });
      expect(response.statusCode).toBe(403);
      // A read without Origin is fine.
      expect(
        (await app.inject({ url: '/api/v1/keys', headers: { host: HOST, ...withCookie(token) } }))
          .statusCode,
      ).toBe(200);
    });

    it('keeps the network check in login mode: loopback, own host, no proxy headers', async () => {
      const token = await loggedIn();
      for (const extra of [
        { remoteAddress: '192.168.1.20' },
        { headers: { host: 'evil.example', ...withCookie(token) } },
        { headers: { host: HOST, 'x-forwarded-for': '1.2.3.4', ...withCookie(token) } },
        { headers: { host: HOST, 'cf-connecting-ip': '1.2.3.4', ...withCookie(token) } },
        { headers: { host: HOST, 'cf-ray': 'abc-OSL', ...withCookie(token) } },
        { headers: { host: HOST, 'cdn-loop': 'cloudflare', ...withCookie(token) } },
      ]) {
        const response = await app.inject({
          url: '/api/v1/keys',
          headers: { host: HOST, ...withCookie(token) },
          ...extra,
        });
        expect(response.statusCode, JSON.stringify(extra)).toBe(403);
      }
    });

    describe('with PUBLIC_URL', () => {
      const PUBLIC = 'app.example.com';
      beforeEach(async () => {
        // The app owns the database and closes it: start over with a new one.
        await app.close();
        database = testDatabase();
        app = makeApp({ PUBLIC_URL: `https://${PUBLIC}` });
        await setPassword();
      });

      it('also answers to its host, with Origin checks against it', async () => {
        const viaPublic = { host: PUBLIC, origin: `https://${PUBLIC}` };
        const response = await login('admin', PASSWORD, viaPublic);
        expect(response.statusCode).toBe(200);
        const token = tokenFrom(response);
        const headers = { ...viaPublic, ...withCookie(token) };
        expect((await app.inject({ url: '/api/v1/keys', headers })).statusCode).toBe(200);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/keys',
              payload: { name: 'Phone' },
              headers,
            })
          ).statusCode,
        ).toBe(201);
        // Another site's Origin, or one for the other allowed host, is refused.
        for (const origin of ['https://evil.example', `http://${HOST}`]) {
          const crossSite = await app.inject({
            method: 'POST',
            url: '/api/v1/keys',
            payload: { name: 'x' },
            headers: { ...headers, origin },
          });
          expect(crossSite.statusCode, origin).toBe(403);
        }
        // Localhost keeps working.
        expect(
          (await app.inject({ url: '/api/v1/keys', headers: { host: HOST, ...withCookie(token) } }))
            .statusCode,
        ).toBe(200);
      });

      it('still refuses proxy headers, other hosts and remote sockets on its host', async () => {
        const token = await loggedIn();
        for (const extra of [
          { remoteAddress: '203.0.113.9' },
          { headers: { host: `evil.${PUBLIC}`, ...withCookie(token) } },
          { headers: { host: `${PUBLIC}:444`, ...withCookie(token) } },
          { headers: { host: PUBLIC, 'cf-connecting-ip': '1.2.3.4', ...withCookie(token) } },
          { headers: { host: PUBLIC, 'x-forwarded-for': '1.2.3.4', ...withCookie(token) } },
        ]) {
          const response = await app.inject({
            url: '/api/v1/keys',
            headers: { host: PUBLIC, ...withCookie(token) },
            ...extra,
          });
          expect(response.statusCode, JSON.stringify(extra)).toBe(403);
        }
      });

      it('is ignored in local mode', async () => {
        setPasswordHash(database.db, FIRST_USER_ID, null);
        const response = await app.inject({ url: '/api/v1/keys', headers: { host: PUBLIC } });
        expect(response.statusCode).toBe(403);
        expect(
          (await app.inject({ url: '/api/v1/keys', headers: { host: HOST } })).statusCode,
        ).toBe(200);
      });
    });

    describe('with PUBLIC_URL and TRUSTED_PROXY', () => {
      const PUBLIC = 'app.example.com';
      /** What cloudflared adds to a visitor's request. */
      const TUNNEL = {
        'cf-connecting-ip': '203.0.113.9',
        'cf-ray': '8f00000000000000-OSL',
        'cf-visitor': '{"scheme":"https"}',
        'cdn-loop': 'cloudflare',
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-proto': 'https',
      };
      const viaPublic = { host: PUBLIC, origin: `https://${PUBLIC}` };
      beforeEach(async () => {
        await app.close();
        database = testDatabase();
        app = makeApp({ PUBLIC_URL: `https://${PUBLIC}`, TRUSTED_PROXY: 'cloudflare' });
        await setPassword();
      });

      it('refuses the public host on a request that did not come through the proxy', async () => {
        const token = await loggedIn();
        const direct = await app.inject({
          url: '/api/v1/auth/me',
          headers: { host: PUBLIC, ...withCookie(token) },
        });
        expect(direct.statusCode).toBe(403);
        // No login either, so no session with the shared client IP 127.0.0.1.
        const before = sessionRows().length;
        const response = await login('admin', PASSWORD, viaPublic);
        expect(response.statusCode).toBe(403);
        expect(tokenFrom(response)).toBeUndefined();
        expect(sessionRows()).toHaveLength(before);
        expect(calls.verify).toBe(1);
      });

      it('answers the public host through the proxy, and localhost without headers', async () => {
        const response = await login('admin', PASSWORD, { ...viaPublic, ...TUNNEL });
        expect(response.statusCode).toBe(200);
        const token = tokenFrom(response);
        const tunnelled = await app.inject({
          url: '/api/v1/auth/me',
          headers: { host: PUBLIC, ...TUNNEL, ...withCookie(token) },
        });
        expect(tunnelled.statusCode).toBe(200);
        expect((await me(token)).user?.username).toBe('admin');
      });

      it('still refuses localhost as Host through the proxy', async () => {
        const token = await loggedIn();
        const response = await app.inject({
          url: '/api/v1/auth/me',
          headers: { host: HOST, ...TUNNEL, ...withCookie(token) },
        });
        expect(response.statusCode).toBe(403);
      });
    });

    it('rate limits an unknown device by username with 429, lifted within 15 min', async () => {
      // Different IPs, so only the username rule applies.
      const from = (i: number) => ({ remoteAddress: `127.0.0.${String(i + 2)}` });
      for (let i = 0; i < 10; i++) {
        const response = await send('POST', '/api/v1/auth/login', {
          payload: { username: 'admin', password: `wrong ${String(i)}` },
          ...from(i),
        });
        expect(response.statusCode).toBe(401);
      }
      calls.verify = 0;
      const blocked = await login('admin', PASSWORD);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('2');
      expect(calls.verify).toBe(0);
      now += 15 * 60 * 1000;
      expect((await login('admin', PASSWORD)).statusCode).toBe(200);
    });

    it('rate limits by IP with 429 and Retry-After', async () => {
      for (let i = 0; i < 20; i++) {
        expect((await login(`user${String(i)}`, 'wrong password')).statusCode).toBe(401);
      }
      calls.verify = 0;
      const response = await login('admin', PASSWORD);
      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('2');
      expect(response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      // Refused before any argon2 work.
      expect(calls.verify).toBe(0);
      now += 2000;
      expect((await login('admin', PASSWORD)).statusCode).toBe(200);
    });

    it('gives a new token at every login and ends the one the browser had', async () => {
      const first = await loggedIn();
      const response = await login('admin', PASSWORD, withCookie(first));
      const second = tokenFrom(response);
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      expect(sessionRows().map((row) => row.id)).toEqual([hashSessionToken(second ?? '')]);
      expect((await me(first)).user).toBeNull();
    });

    it('rolls the expiry forward once an hour, and expires after 30 idle days', async () => {
      const token = await loggedIn();
      now += SESSION_REFRESH_MS - 1;
      const early = await send('GET', '/api/v1/keys', { headers: withCookie(token) });
      expect(early.headers['set-cookie']).toBeUndefined();
      now += 1;
      const refreshed = await send('GET', '/api/v1/keys', { headers: withCookie(token) });
      expect(String(refreshed.headers['set-cookie'])).toContain('Max-Age=2592000');
      expect(sessionRows()[0]?.expiresAt).toBe(new Date(now + SESSION_TTL_MS).toISOString());

      now += SESSION_TTL_MS - 1;
      expect((await me(token)).user).not.toBeNull();
      now += SESSION_TTL_MS;
      expect((await me(token)).user).toBeNull();
      expect(sessionRows()).toEqual([]);
    });

    it.each([
      ['garbage', 'not-a-token'],
      ['a well-formed unknown token', 'A'.repeat(43)],
    ])('refuses %s as a session', async (_name, token) => {
      expect((await send('GET', '/api/v1/keys', { headers: withCookie(token) })).statusCode).toBe(
        401,
      );
    });

    it('refuses a session of a user who was disabled since (same 401)', async () => {
      const token = await loggedIn();
      database.db
        .update(users)
        .set({ disabledAt: new Date(now).toISOString() })
        .where(eq(users.id, FIRST_USER_ID))
        .run();
      const response = await send('GET', '/api/v1/keys', { headers: withCookie(token) });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { message: 'Log in to continue' } });
    });

    it('logs out: the session row is gone and the cookie cleared', async () => {
      const token = await loggedIn();
      const response = await send('POST', '/api/v1/auth/logout', { headers: withCookie(token) });
      expect(response.statusCode).toBe(204);
      expect(String(response.headers['set-cookie'])).toBe(
        `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`,
      );
      expect(sessionRows()).toEqual([]);
      expect((await send('GET', '/api/v1/keys', { headers: withCookie(token) })).statusCode).toBe(
        401,
      );
      // Again, without a session: still 204.
      expect((await send('POST', '/api/v1/auth/logout')).statusCode).toBe(204);
    });

    it('logs out everywhere', async () => {
      const a = await loggedIn();
      const b = await loggedIn();
      expect(sessionRows()).toHaveLength(2);
      const response = await send('POST', '/api/v1/auth/logout-all', { headers: withCookie(a) });
      expect(response.statusCode).toBe(204);
      expect(sessionRows()).toEqual([]);
      expect((await me(b)).user).toBeNull();
      expect(
        database.db
          .select()
          .from(auditLog)
          .all()
          .map((row) => row.action),
      ).toEqual(['auth.login', 'auth.login', 'auth.logout_all']);
      expect((await send('POST', '/api/v1/auth/logout-all')).statusCode).toBe(401);
    });

    describe('password change', () => {
      it('needs the current password, ends other sessions and rotates this one', async () => {
        const mine = await loggedIn();
        const other = await loggedIn();
        const response = await send('POST', '/api/v1/auth/password', {
          payload: { currentPassword: PASSWORD, newPassword: 'a new long passphrase' },
          headers: withCookie(mine),
        });
        expect(response.statusCode).toBe(204);
        const rotated = tokenFrom(response);
        expect(rotated).toBeDefined();
        expect(rotated).not.toBe(mine);
        expect((await me(mine)).user).toBeNull();
        expect((await me(other)).user).toBeNull();
        expect((await me(rotated)).user).not.toBeNull();
        expect((await login('admin', PASSWORD)).statusCode).toBe(401);
        expect((await login('admin', 'a new long passphrase')).statusCode).toBe(200);
      });

      it.each([
        [{ newPassword: 'a new long passphrase' }, 'body.currentPassword'],
        [
          { currentPassword: 'wrong one', newPassword: 'a new long passphrase' },
          'body.currentPassword',
        ],
        [{ currentPassword: PASSWORD, newPassword: 'short' }, 'body.newPassword'],
      ])('gives 400 for %j and changes nothing', async (payload, path) => {
        const token = await loggedIn();
        const response = await send('POST', '/api/v1/auth/password', {
          payload,
          headers: withCookie(token),
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { details: [{ path }] } });
        expect((await me(token)).user).not.toBeNull();
      });

      it('needs a session', async () => {
        const response = await send('POST', '/api/v1/auth/password', {
          payload: { currentPassword: PASSWORD, newPassword: 'a new long passphrase' },
        });
        expect(response.statusCode).toBe(401);
      });
    });

    it('a CLI password change takes effect on the next request (no restart)', async () => {
      const token = await loggedIn();
      setPasswordHash(database.db, FIRST_USER_ID, await hasher.hash('set from the CLI!!'));
      expect((await send('GET', '/api/v1/keys', { headers: withCookie(token) })).statusCode).toBe(
        401,
      );
      // And clearing it brings local mode back at once.
      setPasswordHash(database.db, FIRST_USER_ID, null);
      expect((await me()).mode).toBe('local');
      expect((await send('GET', '/api/v1/keys')).statusCode).toBe(200);
    });

    it('lets every user use the dashboard, and only admins the admin routes', async () => {
      const member = createUser(database.db, 'friend');
      await setPassword(member, 'friends password');
      const token = await loggedIn('friend', 'friends password');
      expect(await me(token)).toMatchObject({ user: { username: 'friend', role: 'member' } });
      // Their own (empty) data.
      const keys = await send('GET', '/api/v1/keys', { headers: withCookie(token) });
      expect(keys.statusCode).toBe(200);
      expect(keys.json()).toEqual({ keys: [] });
      const accountList = await send('GET', '/api/v1/accounts', { headers: withCookie(token) });
      expect(accountList.json()).toEqual({ accounts: [] });
      // Admin routes are 403 for a member, and 200 for an admin.
      const icons = await send('GET', '/api/v1/admin/icons', { headers: withCookie(token) });
      expect(icons.statusCode).toBe(403);
      expect(icons.json()).toEqual({
        error: { code: 'FORBIDDEN', message: 'Only an admin can do this', details: [] },
      });
      const owner = await loggedIn();
      expect(
        (await send('GET', '/api/v1/admin/icons', { headers: withCookie(owner) })).statusCode,
      ).toBe(200);
      // Without a session an admin route is 401 like any other.
      expect((await send('GET', '/api/v1/admin/icons')).statusCode).toBe(401);
    });

    describe('API keys and sessions never cross', () => {
      it('never accepts an API key as login on the dashboard', async () => {
        const { key } = createApiKey(database.db, TEST_OWNER, 'Plugin');
        const asBearer = await send('GET', '/api/v1/keys', {
          headers: { authorization: `Bearer ${key}` },
        });
        expect(asBearer.statusCode).toBe(401);
        const asCookie = await send('GET', '/api/v1/keys', { headers: withCookie(key) });
        expect(asCookie.statusCode).toBe(401);
        expect((await me(key)).user).toBeNull();
      });

      it('never accepts a session on ingest', async () => {
        const token = await loggedIn();
        for (const url of ['/api/v1/ingest/verify']) {
          const withSession = await send('GET', url, { headers: withCookie(token) });
          expect(withSession.statusCode).toBe(401);
          const asBearer = await send('GET', url, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(asBearer.statusCode).toBe(401);
        }
        const post = await send('POST', '/api/v1/ingest', {
          payload: { events: [] },
          headers: withCookie(token),
        });
        expect(post.statusCode).toBe(401);
      });
    });

    it('never logs passwords, tokens or the cookie', async () => {
      const token = await loggedIn();
      await login('admin', 'a wrong password here');
      await send('GET', '/api/v1/keys', { headers: withCookie(token) });
      await send('POST', '/api/v1/auth/password', {
        payload: { currentPassword: PASSWORD, newPassword: 'another new passphrase' },
        headers: withCookie(token),
      });
      const output = logs.join('');
      expect(output).toContain('Logged in');
      for (const secret of [PASSWORD, 'a wrong password here', 'another new passphrase', token]) {
        expect(output).not.toContain(secret);
      }
      expect(output).not.toContain(SESSION_COOKIE);
    });
  });
});

// With `login:user` full of usernames that must wait, nothing an unknown device
// sends can free a slot, and a known device and a logged-in user are never held
// up.
describe('a full login:user bucket', () => {
  const DEVICE = `__Host-${BRANDING.shortName}_device`;
  const MAX = 5;
  let database: Database;
  let app: FastifyInstance;
  let now: number;

  beforeEach(async () => {
    now = START;
    database = testDatabase();
    const hasher = createPasswordHasher({ params: CHEAP });
    app = buildApp({
      db: database,
      config: testConfig(),
      dashboard: {
        now: () => new Date(now),
        auth: {
          hasher,
          limiters: new AuthLimiters({ now: () => new Date(now), maxEntries: MAX }),
        },
      },
    });
    setPasswordHash(database.db, FIRST_USER_ID, await hasher.hash(PASSWORD));
  });
  afterEach(() => app.close());

  // Every request from its own loopback address, so `login:ip` never refuses.
  let requests = 0;
  const post = (url: string, payload: object, headers: Record<string, string> = {}) => {
    requests += 1;
    return app.inject({
      method: 'POST',
      url,
      payload,
      headers: { host: HOST, origin: ORIGIN, ...headers },
      remoteAddress: `127.1.${String(requests >> 8)}.${String(requests & 255)}`,
    });
  };
  const login = (username: string, password: string, headers: Record<string, string> = {}) =>
    post('/api/v1/auth/login', { username, password }, headers);
  const cookieOf = (response: LightMyRequestResponse, name: string) => {
    const header = response.headers['set-cookie'];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    const line = lines.find((value) => value.startsWith(`${name}=`));
    return line?.slice(name.length + 1).split(';')[0];
  };

  it('keeps every wait through a flood, refuses new usernames, and lets a known device and a session through', async () => {
    const first = await login('admin', PASSWORD);
    expect(first.statusCode).toBe(200);
    const cookies = `${DEVICE}=${cookieOf(first, DEVICE) ?? ''}; ${SESSION_COOKIE}=${cookieOf(first, SESSION_COOKIE) ?? ''}`;

    // The attacker blocks `admin` and four other names: the bucket is full,
    // and every name in it must wait.
    for (const name of ['admin', 'n1', 'n2', 'n3', 'n4']) {
      for (let i = 0; i < 10; i++) expect((await login(name, 'wrong')).statusCode).toBe(401);
      expect((await login(name, 'wrong')).statusCode).toBe(429);
    }

    // The flood: new usernames are refused and change nothing.
    for (let i = 0; i < 50; i++) {
      const refused = await login(`flood${String(i)}`, 'wrong');
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    }
    // Still blocked, with the right password too (an unknown device).
    expect((await login('admin', PASSWORD)).statusCode).toBe(429);

    // The owner's known browser logs in, and their session can confirm a password.
    const known = await login('admin', PASSWORD, { cookie: cookies });
    expect(known.statusCode).toBe(200);
    const session = `${SESSION_COOKIE}=${cookieOf(known, SESSION_COOKIE) ?? ''}`;
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { host: HOST, cookie: session },
    });
    expect(authMeResponseSchema.parse(me.json()).user?.username).toBe('admin');
    const setup = await post(
      '/api/v1/auth/totp/setup',
      { password: PASSWORD },
      { cookie: session },
    );
    expect(setup.statusCode).toBe(200);
  });
});

// A refused attempt (`429`) logs the client's IP once per block, not once per
// attempt. Failed attempts before the block log as before.
describe('logging refused attempts', () => {
  let database: Database;
  let app: FastifyInstance;
  let now: number;
  let logs: string[];

  beforeEach(async () => {
    now = START;
    database = testDatabase();
    logs = [];
    const hasher = createPasswordHasher({ params: CHEAP });
    app = buildApp({
      db: database,
      config: testConfig({ LOG_LEVEL: 'info' }),
      logStream: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          logs.push(chunk.toString());
          callback();
        },
      }),
      dashboard: {
        now: () => new Date(now),
        auth: { hasher, limiters: new AuthLimiters({ now: () => new Date(now) }) },
      },
    });
    setPasswordHash(database.db, FIRST_USER_ID, await hasher.hash(PASSWORD));
  });
  afterEach(() => app.close());

  const attempt = (username: string, remoteAddress = '127.0.0.1') =>
    app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password: 'wrong' },
        headers: { host: HOST, origin: ORIGIN },
        remoteAddress,
      })
      .then((response) => response.statusCode);
  const lines = (event: string) =>
    logs.filter((line) => line.includes(`"securityEvent":"${event}"`));

  it('logs every failed login, and a blocked IP once per block', async () => {
    for (let i = 0; i < 20; i++) expect(await attempt(`user${String(i)}`)).toBe(401);
    expect(lines('login_failed')).toHaveLength(20);
    expect(lines('rate_limited')).toHaveLength(0);

    for (let i = 0; i < 100; i++) expect(await attempt(`more${String(i)}`)).toBe(429);
    expect(lines('rate_limited')).toHaveLength(1);
    expect(lines('rate_limited')[0]).toContain('"clientIp":"127.0.0.1"');
    expect(lines('rate_limited')[0]).toContain('"retryAfterSeconds":2');
    // Refused attempts are no failed logins, and write no other line with the IP.
    expect(lines('login_failed')).toHaveLength(20);
    expect(
      logs.filter((line) => line.includes('127.0.0.1') && !line.includes('"host"')),
    ).toHaveLength(21);

    // The wait ends; one more failure starts the next block, logged once again.
    now += 2000;
    expect(await attempt('after')).toBe(401);
    for (let i = 0; i < 100; i++) expect(await attempt(`again${String(i)}`)).toBe(429);
    expect(lines('login_failed')).toHaveLength(21);
    expect(lines('rate_limited')).toHaveLength(2);
    expect(lines('rate_limited')[1]).toContain('"retryAfterSeconds":4');
    // Never the typed username.
    expect(logs.join('')).not.toMatch(/user\d|more\d|again\d|"after"/);
  });

  it('logs a blocked username once, however many IPs keep trying', async () => {
    const ip = (i: number) => `127.3.${String(i >> 8)}.${String(i & 255)}`;
    for (let i = 0; i < 10; i++) expect(await attempt('admin', ip(i))).toBe(401);
    for (let i = 10; i < 110; i++) expect(await attempt('admin', ip(i))).toBe(429);
    expect(lines('login_failed')).toHaveLength(10);
    expect(lines('rate_limited')).toHaveLength(1);
    expect(lines('rate_limited')[0]).toContain(`"clientIp":"${ip(10)}"`);
  });
});
