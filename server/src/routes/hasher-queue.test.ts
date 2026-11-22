import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { errorResponseSchema } from '@fireside/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { AuthLimiters } from '../auth/login-limiter.js';
import { createSession } from '../auth/sessions.js';
import type { Database } from '../db/index.js';
import { SERVER_BUSY } from '../errors.js';
import { testConfig, testDatabase } from '../test-utils.js';
import {
  HASHER_BUSY_RETRY_AFTER_SECONDS,
  hashPassword,
  Semaphore,
  verifyPassword,
  type PasswordHasher,
} from '../users/password.js';
import { createInvite } from '../users/invites.js';
import { FIRST_USER_ID, setPasswordHash } from '../users/users.js';

// One hasher for every route that hashes, at most `LIMIT` operations at once
// and `QUEUE` waiting. One more is answered `503` with `Retry-After` at once,
// is not counted by the limiters, and a full queue never holds up a request
// that doesn't hash.

const NOW = new Date('2026-11-19T12:00:00.000Z');
const HOST = 'localhost:3100';
const ORIGIN = `http://${HOST}`;
const PASSWORD = 'correct horse battery';
const CHEAP = { memory: 64, passes: 1, parallelism: 1 };
const BUSY_FIXTURE = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../shared/fixtures/api/error-response/valid/server-busy.json'),
    'utf8',
  ),
) as { error: { code: string; message: string; details: unknown[] } };
const LIMIT = 4;
const QUEUE = 6;

describe('a full password queue', () => {
  let database: Database;
  let app: FastifyInstance;
  let limiters: AuthLimiters;
  let semaphore: Semaphore;
  let logs: string[];
  /** While set, every hash and verify waits for it. */
  let gate: Promise<void> | undefined;
  let openGate: () => void = () => undefined;
  let session: string;
  let requests = 0;

  beforeEach(async () => {
    database = testDatabase();
    semaphore = new Semaphore(LIMIT, QUEUE);
    gate = undefined;
    // The real hasher's queue, with operations that can be held.
    const hasher: PasswordHasher = {
      hash: (password) =>
        semaphore.run(async () => {
          await gate;
          return hashPassword(password, CHEAP);
        }),
      verify: (password, stored) =>
        semaphore.run(async () => {
          await gate;
          return verifyPassword(password, stored);
        }),
    };
    limiters = new AuthLimiters({ now: () => NOW });
    logs = [];
    app = buildApp({
      db: database,
      config: testConfig({ LOG_LEVEL: 'info' }),
      logStream: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          logs.push(chunk.toString());
          callback();
        },
      }),
      // No hasher for the invite routes: they must get the same one.
      dashboard: { now: () => NOW, auth: { hasher, limiters } },
    });
    setPasswordHash(database.db, FIRST_USER_ID, await hashPassword(PASSWORD, CHEAP));
    session = createSession(database.db, FIRST_USER_ID, { now: NOW }).token;
  });
  afterEach(async () => {
    openGate();
    await app.close();
  });

  // Each request from its own loopback address, so `login:ip` never refuses.
  const send = (method: 'GET' | 'POST', url: string, options: InjectOptions = {}) => {
    requests += 1;
    return app.inject({
      method,
      url,
      ...options,
      headers: { host: HOST, ...(method === 'GET' ? {} : { origin: ORIGIN }), ...options.headers },
      remoteAddress: `127.2.${String(requests >> 8)}.${String(requests & 255)}`,
    });
  };
  const login = (username: string, password = 'wrong') =>
    send('POST', '/api/v1/auth/login', { payload: { username, password } });
  const withSession = () => ({ cookie: `${SESSION_COOKIE}=${session}` });
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  /** Holds the hasher and fills it: `LIMIT` running and `QUEUE` waiting logins. */
  async function fill() {
    // Unknown usernames are checked against a dummy hash made on first use:
    // make it now, so each held login is one verify.
    expect((await login('warm-up')).statusCode).toBe(401);
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const held = Array.from({ length: LIMIT + QUEUE }, (_, index) => login(`held${String(index)}`));
    while (semaphore.running < LIMIT || semaphore.queued < QUEUE) await tick();
    return held;
  }

  it('answers 503 with Retry-After at once, and counts nothing against the IP or the username', async () => {
    const held = await fill();
    const usersBefore = limiters.loginUser.size;
    const ipsBefore = limiters.loginIp.size;

    for (const [username, password] of [
      ['admin', PASSWORD],
      ['admin', 'wrong'],
      ['nobody', 'wrong'],
    ] as const) {
      const response = await login(username, password);
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe(String(HASHER_BUSY_RETRY_AFTER_SECONDS));
      expect(response.headers['cache-control']).toBe('no-store');
      // Exactly the contract's fixture (1.37.0).
      expect(errorResponseSchema.parse(response.json())).toEqual(BUSY_FIXTURE);
      expect(BUSY_FIXTURE.error.message).toBe(SERVER_BUSY);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(limiters.loginUser.size).toBe(usersBefore);
    expect(limiters.loginIp.size).toBe(ipsBefore);
    expect(semaphore.queued).toBe(QUEUE);
    // An expected answer, not a server failure: no error log, no stack.
    expect(logs.some((line) => line.includes('"level":50'))).toBe(false);

    openGate();
    for (const response of await Promise.all(held)) expect(response.statusCode).toBe(401);
    // Room again: the right password logs in.
    expect((await login('admin', PASSWORD)).statusCode).toBe(200);
  });

  it('refuses every other route that hashes the same way: one queue for all', async () => {
    const invite = createInvite(database.db, {
      createdBy: FIRST_USER_ID,
      label: null,
      role: 'member',
      canCreateApiKeys: true,
      days: 7,
      maxUsers: null,
      now: NOW,
    });
    const held = await fill();
    const invitesBefore = limiters.inviteIp.size;
    const reauthBefore = limiters.reauth.size;

    const hashing = [
      send('POST', '/api/v1/auth/invite/accept', {
        payload: { token: invite.token, username: 'friend', password: PASSWORD },
      }),
      send('POST', '/api/v1/auth/password', {
        headers: withSession(),
        payload: { currentPassword: PASSWORD, newPassword: 'another long password' },
      }),
      send('POST', '/api/v1/auth/totp/setup', {
        headers: withSession(),
        payload: { password: PASSWORD },
      }),
      send('POST', '/api/v1/auth/delete-account', {
        headers: withSession(),
        payload: { password: PASSWORD },
      }),
    ];
    for (const response of await Promise.all(hashing)) {
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe(String(HASHER_BUSY_RETRY_AFTER_SECONDS));
    }
    expect(limiters.inviteIp.size).toBe(invitesBefore);
    expect(limiters.reauth.size).toBe(reauthBefore);

    openGate();
    await Promise.all(held);
    // Nothing was used up: the invite still works, and so does the password.
    const accepted = await send('POST', '/api/v1/auth/invite/accept', {
      payload: { token: invite.token, username: 'friend', password: PASSWORD },
    });
    expect(accepted.statusCode).toBe(201);
    expect((await login('admin', PASSWORD)).statusCode).toBe(200);
  });

  it('never holds up a request that does not hash', async () => {
    const held = await fill();
    // None of these may wait for the gate: each must answer while it is shut.
    const answers = await Promise.all([
      send('GET', '/api/v1/health'),
      send('GET', '/api/v1/auth/me'),
      send('GET', '/api/v1/auth/me', { headers: withSession() }),
      send('GET', '/api/v1/about'),
      send('GET', '/api/v1/accounts', { headers: withSession() }),
      send('GET', '/api/v1/keys', { headers: withSession() }),
      send('GET', '/api/v1/auth/totp', { headers: withSession() }),
      send('POST', '/api/v1/keys', { headers: withSession(), payload: { name: 'while busy' } }),
      send('POST', '/api/v1/auth/invite/lookup', { payload: { token: 'A'.repeat(43) } }),
      send('POST', '/api/v1/auth/login/totp', { payload: { code: '123456' } }),
      send('GET', '/api/v1/ingest/verify'),
      send('GET', '/api/v1/accounts'),
    ]);
    expect(answers.map((response) => response.statusCode)).toEqual([
      200, 200, 200, 200, 200, 200, 200, 201, 404, 401, 401, 401,
    ]);
    expect(semaphore.running).toBe(LIMIT);
    expect(semaphore.queued).toBe(QUEUE);
    // Logging out works too, and frees nothing it shouldn't.
    expect((await send('POST', '/api/v1/auth/logout', { headers: withSession() })).statusCode).toBe(
      204,
    );

    openGate();
    await Promise.all(held);
  });

  it('the last place in the queue still logs in, the next request is refused', async () => {
    expect((await login('warm-up')).statusCode).toBe(401);
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const held = Array.from({ length: LIMIT + QUEUE - 1 }, (_, index) =>
      login(`held${String(index)}`),
    );
    while (semaphore.running < LIMIT || semaphore.queued < QUEUE - 1) await tick();
    const last = login('admin', PASSWORD);
    while (semaphore.queued < QUEUE) await tick();
    expect((await login('late')).statusCode).toBe(503);
    openGate();
    expect((await last).statusCode).toBe(200);
    await Promise.all(held);
  });
});
