import {
  acceptInviteResponseSchema,
  type AuthMeResponse,
  type ErrorResponse,
  createdInviteResponseSchema,
  invitesResponseSchema,
  type CreatedInviteResponse,
  type Invite,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiKey, ownKey } from '../auth/api-keys.js';
import type { Database } from '../db/index.js';
import { accountIds, apiKeys, auditLog, invites, users, userSessions } from '../db/schema.js';
import { testDatabase } from '../test-utils.js';
import { MAX_ACTIVE_INVITES, RESET_TTL_MS } from '../users/invites.js';
import {
  cookieToken,
  loginApp,
  PASSWORD,
  START,
  tokenOf,
  type LoginApp,
} from '../users/testing.js';
import { createUser, FIRST_USER_ID, findUserByUsername } from '../users/users.js';
import { INVALID_LINK } from './invites.js';

const DAY = 24 * 60 * 60 * 1000;
const INVALID = { error: { code: 'NOT_FOUND', message: INVALID_LINK, details: [] } };
const NEW_PASSWORD = 'another long password';

/** Status, headers and body, without what differs per response anyway. */
function comparable(response: LightMyRequestResponse) {
  const headers: Record<string, unknown> = { ...response.headers };
  delete headers.date;
  return { status: response.statusCode, headers, body: response.body };
}

describe('invites', () => {
  let database: Database;
  let t: LoginApp & { adminToken: string };

  beforeEach(async () => {
    database = testDatabase();
    t = await loginApp(database);
  });
  afterEach(() => t.app.close());

  async function createInvite(body: object = {}, token = t.adminToken) {
    const response = await t.send('POST', '/api/v1/invites', {
      token,
      payload: { role: 'member', canCreateApiKeys: true, ...body },
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdInviteResponseSchema.parse(response.json());
  }
  const accept = (token: string, username = 'ola', password = PASSWORD) =>
    t.send('POST', '/api/v1/auth/invite/accept', { payload: { token, username, password } });
  const lookup = (token: string) =>
    t.send('POST', '/api/v1/auth/invite/lookup', { payload: { token } });
  const list = async () => {
    const response = await t.send('GET', '/api/v1/invites', { token: t.adminToken });
    expect(response.statusCode).toBe(200);
    return invitesResponseSchema.parse(response.json()).invites;
  };
  const listed = async (id: string): Promise<Invite | undefined> =>
    (await list()).find((invite) => invite.id === id);
  const auditActions = () =>
    database.db
      .select({ action: auditLog.action, actor: auditLog.actorUserId, target: auditLog.target })
      .from(auditLog)
      .all()
      .filter((row) => row.action !== 'auth.login');

  describe('creating', () => {
    it('shows the link once, with the token in the fragment, and stores only its hash', async () => {
      const created = await createInvite({ label: '  For a friend  ', days: 30 });
      expect(created.url).toMatch(/^http:\/\/localhost:3100\/invite#[A-Za-z0-9_-]{43}$/);
      expect(created.localOnly).toBe(true);
      expect(created.invite).toMatchObject({
        type: 'invite',
        label: 'For a friend',
        role: 'member',
        canCreateApiKeys: true,
        status: 'active',
        createdBy: { id: FIRST_USER_ID, username: 'admin' },
        createdAt: new Date(START).toISOString(),
        expiresAt: new Date(START + 30 * DAY).toISOString(),
      });
      const row = database.db.select().from(invites).get();
      expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(tokenOf(created.url));
    });

    it('lasts 7 days by default', async () => {
      const { invite } = await createInvite();
      expect(invite.expiresAt).toBe(new Date(START + 7 * DAY).toISOString());
    });

    it('uses PUBLIC_URL for the link when set', async () => {
      await t.app.close();
      t = await loginApp(testDatabase(), { env: { PUBLIC_URL: 'https://app.example.com' } });
      const created = await createInvite();
      expect(created.url).toMatch(/^https:\/\/app\.example\.com\/invite#/);
      expect(created.localOnly).toBe(false);
    });

    it('refuses a label with control characters, on body.label', async () => {
      const response = await t.send('POST', '/api/v1/invites', {
        token: t.adminToken,
        payload: { role: 'member', canCreateApiKeys: true, label: 'a\u0000b' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorResponse>().error.details[0]?.path).toBe('body.label');
    });

    it(`allows at most ${String(MAX_ACTIVE_INVITES)} active invites`, async () => {
      const ids: string[] = [];
      for (let i = 0; i < MAX_ACTIVE_INVITES; i += 1) ids.push((await createInvite()).invite.id);
      const over = await t.send('POST', '/api/v1/invites', {
        token: t.adminToken,
        payload: { role: 'member', canCreateApiKeys: true },
      });
      expect(over.statusCode).toBe(409);
      expect(over.json<ErrorResponse>().error.message).toMatch(/already 20 active invites/);
      // Reset links don't count, and a revoked invite frees a place.
      const member = await t.addUser('kari');
      const reset = await t.send('POST', `/api/v1/users/${String(member.id)}/password-reset`, {
        token: t.adminToken,
      });
      expect(reset.statusCode).toBe(201);
      await t.send('DELETE', `/api/v1/invites/${ids[0] ?? ''}`, { token: t.adminToken });
      await createInvite();
    });

    it('refuses when MAX_USERS users exist', async () => {
      await t.app.close();
      t = await loginApp(testDatabase(), { env: { MAX_USERS: '1' } });
      const response = await t.send('POST', '/api/v1/invites', {
        token: t.adminToken,
        payload: { role: 'member', canCreateApiKeys: true },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<ErrorResponse>().error.message).toBe(
        'This server has no room for more users',
      );
    });

    it('retries a taken random ID instead of failing', async () => {
      await t.app.close();
      const ids = ['AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'BBBBBBBB'];
      t = await loginApp(testDatabase(), { generateId: () => ids.shift() ?? 'CCCCCCCC' });
      expect((await createInvite()).invite.id).toBe('AAAAAAAA');
      expect((await createInvite()).invite.id).toBe('BBBBBBBB');
    });

    it('is refused in local mode', async () => {
      await t.app.close();
      const local = testDatabase();
      t = await loginApp(local);
      // Back to local mode: no password at all.
      local.db.update(users).set({ passwordHash: null }).run();
      const response = await t.send('POST', '/api/v1/invites', {
        payload: { role: 'member', canCreateApiKeys: true },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<ErrorResponse>().error.message).toMatch(/Turn on login first/);
    });
  });

  describe('accepting', () => {
    it('creates the user, logs them in, and the link works once', async () => {
      const { invite, url } = await createInvite({ role: 'admin', canCreateApiKeys: false });
      const token = tokenOf(url);
      expect((await lookup(token)).json()).toEqual({ type: 'invite' });

      const response = await accept(token, '  Ola  ');
      expect(response.statusCode, response.body).toBe(201);
      const { user } = acceptInviteResponseSchema.parse(response.json());
      expect(user).toMatchObject({ username: 'ola', role: 'admin' });
      const row = findUserByUsername(database.db, 'ola');
      expect(row).toMatchObject({ canCreateApiKeys: false, role: 'admin' });
      expect(row?.lastLoginAt).toBe(new Date(START).toISOString());

      // Logged in as the new user.
      const session = cookieToken(response);
      const me = await t.send('GET', '/api/v1/auth/me', { token: session });
      expect(me.json<AuthMeResponse>().user).toMatchObject({ username: 'ola' });

      // No accounts and no keys.
      expect(
        database.db.select().from(accountIds).where(eq(accountIds.userId, user.id)).all(),
      ).toEqual([]);
      expect(database.db.select().from(apiKeys).where(eq(apiKeys.userId, user.id)).all()).toEqual(
        [],
      );

      // Used, and shows who it became.
      expect(await listed(invite.id)).toMatchObject({
        status: 'used',
        usedAt: new Date(START).toISOString(),
        usedBy: { id: user.id, username: 'ola' },
      });
      expect(comparable(await accept(token, 'kari'))).toMatchObject({ status: 404 });
      expect((await accept(token, 'kari')).json()).toEqual(INVALID);
      expect(findUserByUsername(database.db, 'kari')).toBeUndefined();
      expect(auditActions()).toEqual([
        { action: 'invite.create', actor: FIRST_USER_ID, target: `invite:${invite.id}` },
        { action: 'invite.use', actor: user.id, target: `invite:${invite.id}` },
        { action: 'user.create', actor: user.id, target: `user:${String(user.id)}` },
      ]);
    });

    it('counts a name taken by a concurrent accept, found only in the transaction', async () => {
      await t.app.close();
      const slow = testDatabase();
      t = await loginApp(slow, {
        // Both accepts pass the first name check before either has hashed.
        wrapHasher: (inner) => ({
          ...inner,
          hash: async (password) => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            return inner.hash(password);
          },
        }),
      });
      const first = tokenOf((await createInvite()).url);
      const second = tokenOf((await createInvite()).url);
      const results = await Promise.all([accept(first, 'ola'), accept(second, 'ola')]);
      expect(results.map((response) => response.statusCode).sort()).toEqual([201, 400]);
      // The race counted as one failure: 19 more taken names reach the limit of 20.
      const third = tokenOf((await createInvite()).url);
      for (let i = 0; i < 19; i += 1) expect((await accept(third, 'ADMIN')).statusCode).toBe(400);
      expect((await accept(third, 'ADMIN')).statusCode).toBe(429);
    });

    it('gives exactly one user for two concurrent attempts', async () => {
      await t.app.close();
      const slow = testDatabase();
      t = await loginApp(slow, {
        // Both attempts get past the first check before either has hashed.
        wrapHasher: (inner) => ({
          ...inner,
          hash: async (password) => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            return inner.hash(password);
          },
        }),
      });
      const token = tokenOf((await createInvite()).url);
      const [first, second] = await Promise.all([accept(token, 'ola'), accept(token, 'kari')]);
      expect([first.statusCode, second.statusCode].sort()).toEqual([201, 404]);
      const loser = first.statusCode === 404 ? first : second;
      expect(loser.json()).toEqual(INVALID);
      expect(
        slow.db
          .select()
          .from(users)
          .all()
          .map((user) => user.username)
          .sort(),
      ).toHaveLength(2);
      expect(slow.db.select().from(invites).get()?.usedBy).not.toBeNull();
    });

    it('answers used, expired, revoked, unknown and wrong-type links exactly alike', async () => {
      const used = tokenOf((await createInvite()).url);
      expect((await accept(used, 'ola')).statusCode).toBe(201);
      const expired = tokenOf((await createInvite({ days: 1 })).url);
      const revokedInvite = await createInvite();
      await t.send('DELETE', `/api/v1/invites/${revokedInvite.invite.id}`, { token: t.adminToken });
      const member = await t.addUser('kari');
      const resetResponse = await t.send(
        'POST',
        `/api/v1/users/${String(member.id)}/password-reset`,
        { token: t.adminToken },
      );
      const resetToken = tokenOf(createdInviteResponseSchema.parse(resetResponse.json()).url);
      t.clock.now += DAY;

      const cases = {
        used,
        expired,
        revoked: tokenOf(revokedInvite.url),
        unknown: 'A'.repeat(43),
        malformed: 'not a token',
        'reset link on the invite page': resetToken,
      };
      const reference = comparable(await accept(cases.unknown, 'newname'));
      expect(reference.status).toBe(404);
      expect(JSON.parse(reference.body)).toEqual(INVALID);
      for (const [name, token] of Object.entries(cases)) {
        expect(comparable(await accept(token, 'newname')), name).toEqual(reference);
      }
      // The lookup answers the same way, for all but the reset link (still valid there).
      const lookupReference = comparable(await lookup(cases.unknown));
      for (const [name, token] of Object.entries(cases)) {
        if (token === resetToken) continue;
        expect(comparable(await lookup(token)), name).toEqual(lookupReference);
      }
      expect(findUserByUsername(database.db, 'newname')).toBeUndefined();
    });

    it('checks the username and password rules, and keeps the link on an error', async () => {
      const token = tokenOf((await createInvite()).url);
      const short = await accept(token, 'ola', 'short');
      expect(short.statusCode).toBe(400);
      expect(short.json<ErrorResponse>().error.details[0]?.path).toBe('body.password');
      const badName = await accept(token, 'o!');
      expect(badName.json<ErrorResponse>().error.details[0]?.path).toBe('body.username');
      const taken = await accept(token, 'ADMIN');
      expect(taken.statusCode).toBe(400);
      expect(taken.json<ErrorResponse>().error.details[0]).toEqual({
        path: 'body.username',
        message: 'That username is taken',
      });
      expect((await accept(token, 'ola')).statusCode).toBe(201);
    });

    it('checks MAX_USERS when the link is used, and leaves the link unused', async () => {
      await t.app.close();
      const limited = testDatabase();
      t = await loginApp(limited, { env: { MAX_USERS: '2' } });
      const token = tokenOf((await createInvite()).url);
      // Someone else took the last place after the invite was made.
      createUser(limited.db, 'kari');
      const response = await accept(token, 'ola');
      expect(response.statusCode).toBe(409);
      expect(response.json<ErrorResponse>().error.message).toBe(
        'This server has no room for more users. Ask the admin.',
      );
      expect(limited.db.select().from(invites).get()?.usedAt).toBeNull();
      expect(findUserByUsername(limited.db, 'ola')).toBeUndefined();
    });

    it('limits lookups and attempts per IP', async () => {
      let last: LightMyRequestResponse | undefined;
      for (let i = 0; i < 25; i += 1) last = await lookup('B'.repeat(43));
      expect(last?.statusCode).toBe(429);
      expect(last?.headers['retry-after']).toMatch(/^\d+$/);
      // A valid link from the same IP waits too: the limit is per IP.
      const token = tokenOf((await createInvite()).url);
      expect((await accept(token)).statusCode).toBe(429);
    });

    it('counts a taken username as a failed attempt, but not other typing mistakes', async () => {
      const token = tokenOf((await createInvite()).url);
      // Typing mistakes with a valid link are free.
      for (let i = 0; i < 25; i += 1) {
        expect((await accept(token, 'ola', 'short')).statusCode).toBe(400);
      }
      // Each taken name counts, as a guessed link would: names can't be probed for free.
      let last: LightMyRequestResponse | undefined;
      for (let i = 0; i < 25 && last?.statusCode !== 429; i += 1)
        last = await accept(token, 'ADMIN');
      expect(last?.statusCode).toBe(429);
      expect(last?.headers['retry-after']).toMatch(/^\d+$/);
      expect(database.db.select().from(invites).get()?.usedAt).toBeNull();
    });

    it('is the same invalid link in local mode', async () => {
      const token = tokenOf((await createInvite()).url);
      database.db.update(users).set({ passwordHash: null }).run();
      expect((await lookup(token)).json()).toEqual(INVALID);
      expect((await accept(token)).json()).toEqual(INVALID);
    });

    it('never logs the token or the link', async () => {
      const { url } = await createInvite();
      const token = tokenOf(url);
      await lookup(token);
      await accept(token, 'ola');
      await accept(token, 'kari');
      const logs = t.logs.join('');
      expect(logs).toContain('Invite used');
      expect(logs).not.toContain(token);
      expect(logs).not.toContain(url);
      const audit = JSON.stringify(database.db.select().from(auditLog).all());
      expect(audit).not.toContain(token);
    });
  });

  describe('the list', () => {
    it('shows every status, and never the token, hash or link', async () => {
      const active = await createInvite({ label: 'active' });
      const used = await createInvite({ label: 'used' });
      await accept(tokenOf(used.url), 'ola');
      const revoked = await createInvite({ label: 'revoked' });
      await t.send('DELETE', `/api/v1/invites/${revoked.invite.id}`, { token: t.adminToken });
      t.clock.now += DAY;
      const expired = await createInvite({ label: 'expired', days: 1 });
      t.clock.now += DAY + 1;

      const rows = await list();
      const status = Object.fromEntries(
        rows.map((row) => [row.type === 'invite' ? (row.label ?? '') : row.id, row.status]),
      );
      expect(status).toEqual({
        active: 'active',
        used: 'used',
        revoked: 'revoked',
        expired: 'expired',
      });
      // Newest first.
      expect(rows[0]?.id).toBe(expired.invite.id);

      const response = await t.send('GET', '/api/v1/invites', { token: t.adminToken });
      const text = response.body;
      const hashes = database.db.select({ hash: invites.tokenHash }).from(invites).all();
      for (const { url } of [active, used, revoked, expired]) {
        expect(text).not.toContain(tokenOf(url));
        expect(text).not.toContain(url);
      }
      for (const { hash } of hashes) expect(text).not.toContain(hash);
      expect(text).not.toMatch(/token|hash|url/i);
    });

    it('revoking is idempotent and keeps the row', async () => {
      const { invite, url } = await createInvite();
      const path = `/api/v1/invites/${invite.id}`;
      expect((await t.send('DELETE', path, { token: t.adminToken })).statusCode).toBe(204);
      expect((await t.send('DELETE', path, { token: t.adminToken })).statusCode).toBe(204);
      expect(await listed(invite.id)).toMatchObject({
        status: 'revoked',
        revokedAt: new Date(START).toISOString(),
      });
      expect((await accept(tokenOf(url))).json()).toEqual(INVALID);
      expect(auditActions().filter((row) => row.action === 'invite.revoke')).toEqual([
        { action: 'invite.revoke', actor: FIRST_USER_ID, target: `invite:${invite.id}` },
      ]);
      expect(
        (await t.send('DELETE', '/api/v1/invites/ZZZZZZZZ', { token: t.adminToken })).statusCode,
      ).toBe(404);
      expect(
        (await t.send('DELETE', '/api/v1/invites/nope', { token: t.adminToken })).statusCode,
      ).toBe(400);
    });

    it('a revoked used invite stays used', async () => {
      const { invite, url } = await createInvite();
      await accept(tokenOf(url));
      await t.send('DELETE', `/api/v1/invites/${invite.id}`, { token: t.adminToken });
      expect((await listed(invite.id))?.status).toBe('used');
    });
  });
});

describe('password reset links', () => {
  let database: Database;
  let t: LoginApp & { adminToken: string };
  let member: { id: number; token: string };

  beforeEach(async () => {
    database = testDatabase();
    t = await loginApp(database);
    member = await t.addUser('ola');
  });
  afterEach(() => t.app.close());

  const createReset = async (userId = member.id): Promise<CreatedInviteResponse> => {
    const response = await t.send('POST', `/api/v1/users/${String(userId)}/password-reset`, {
      token: t.adminToken,
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdInviteResponseSchema.parse(response.json());
  };
  const useReset = (token: string, password = NEW_PASSWORD) =>
    t.send('POST', '/api/v1/auth/password-reset', { payload: { token, password } });

  it('works for 24 hours, sets the password, ends every session and logs in', async () => {
    const { url, invite } = await createReset();
    expect(url).toMatch(/^http:\/\/localhost:3100\/reset-password#/);
    expect(invite).toMatchObject({
      type: 'password_reset',
      targetUser: { id: member.id, username: 'ola' },
      expiresAt: new Date(START + RESET_TTL_MS).toISOString(),
    });
    const token = tokenOf(url);
    expect(
      (await t.send('POST', '/api/v1/auth/invite/lookup', { payload: { token } })).json(),
    ).toEqual({ type: 'password_reset', username: 'ola', twoFactorRequired: false });

    const response = await useReset(token);
    expect(response.statusCode, response.body).toBe(204);
    // The old session is gone; the new one works.
    expect((await t.send('GET', '/api/v1/keys', { token: member.token })).statusCode).toBe(401);
    const fresh = cookieToken(response);
    expect((await t.send('GET', '/api/v1/keys', { token: fresh })).statusCode).toBe(200);
    expect(
      database.db.select().from(userSessions).where(eq(userSessions.userId, member.id)).all(),
    ).toHaveLength(1);
    // The new password logs in.
    const login = await t.send('POST', '/api/v1/auth/login', {
      payload: { username: 'ola', password: NEW_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    // Once only.
    expect((await useReset(token)).json()).toEqual(INVALID);
  });

  it('writes password_reset.create and password_reset.use, with actor and target', async () => {
    // An admin can make a reset link and use it themselves. That is allowed
    // (the admin has the database file anyway), but it must show.
    const { url } = await createReset();
    await useReset(tokenOf(url));
    const rows = database.db
      .select({ action: auditLog.action, actor: auditLog.actorUserId, target: auditLog.target })
      .from(auditLog)
      .all()
      .filter((row) => row.action.startsWith('password_reset.'));
    expect(rows).toEqual([
      {
        action: 'password_reset.create',
        actor: FIRST_USER_ID,
        target: `user:${String(member.id)}`,
      },
      { action: 'password_reset.use', actor: member.id, target: `user:${String(member.id)}` },
    ]);
  });

  it('expires after 24 hours', async () => {
    const { url } = await createReset();
    t.clock.now += RESET_TTL_MS;
    expect((await useReset(tokenOf(url))).json()).toEqual(INVALID);
  });

  it('a new link revokes the previous one', async () => {
    const first = await createReset();
    const second = await createReset();
    expect((await useReset(tokenOf(first.url))).json()).toEqual(INVALID);
    const rows = invitesResponseSchema.parse(
      (await t.send('GET', '/api/v1/invites', { token: t.adminToken })).json(),
    ).invites;
    expect(rows.find((row) => row.id === first.invite.id)?.status).toBe('revoked');
    expect(rows.find((row) => row.id === second.invite.id)?.status).toBe('active');
    expect((await useReset(tokenOf(second.url))).statusCode).toBe(204);
  });

  it('is refused for a disabled user, and disabling revokes the link', async () => {
    const { url } = await createReset();
    await t.send('PATCH', `/api/v1/users/${String(member.id)}`, {
      token: t.adminToken,
      payload: { disabled: true },
    });
    expect((await useReset(tokenOf(url))).json()).toEqual(INVALID);
    const again = await t.send('POST', `/api/v1/users/${String(member.id)}/password-reset`, {
      token: t.adminToken,
    });
    expect(again.statusCode).toBe(409);
  });

  it('is not an invite: the invite page refuses it', async () => {
    const { url } = await createReset();
    const response = await t.send('POST', '/api/v1/auth/invite/accept', {
      payload: { token: tokenOf(url), username: 'newname', password: PASSWORD },
    });
    expect(response.json()).toEqual(INVALID);
  });

  it('a revoked reset link is listed and logged as revoked', async () => {
    const { invite, url } = await createReset();
    await t.send('DELETE', `/api/v1/invites/${invite.id}`, { token: t.adminToken });
    expect((await useReset(tokenOf(url))).json()).toEqual(INVALID);
    const revoked = database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'password_reset.revoke'))
      .all();
    expect(revoked).toHaveLength(1);
  });

  it('a member gets 403 on every invite and user admin route', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/invites'],
      ['POST', '/api/v1/invites'],
      ['DELETE', '/api/v1/invites/AAAAAAAA'],
      ['POST', `/api/v1/users/${String(FIRST_USER_ID)}/password-reset`],
    ] as const) {
      const response = await t.send(method, url, {
        token: member.token,
        payload: method === 'POST' ? {} : undefined,
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('a disabled user’s key gives 401 on ingest, and works again once enabled', async () => {
    const key = createApiKey(database.db, ownKey(member.id), 'PC', new Date(START));
    const verify = () =>
      t.app.inject({
        method: 'GET',
        url: '/api/v1/ingest/verify',
        headers: { authorization: `Bearer ${key.key}` },
      });
    expect((await verify()).statusCode).toBe(200);
    await t.send('PATCH', `/api/v1/users/${String(member.id)}`, {
      token: t.adminToken,
      payload: { disabled: true },
    });
    expect((await verify()).statusCode).toBe(401);
    await t.send('PATCH', `/api/v1/users/${String(member.id)}`, {
      token: t.adminToken,
      payload: { disabled: false },
    });
    expect((await verify()).statusCode).toBe(200);
  });
});
