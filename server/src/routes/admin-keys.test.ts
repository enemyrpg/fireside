import {
  adminKeysResponseSchema,
  authMeResponseSchema,
  createKeyResponseSchema,
  createUserKeyResponseSchema,
  keysResponseSchema,
  managedUserSchema,
  serverSettingsSchema,
  usersResponseSchema,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createApiKey,
  hashApiKey,
  listApiKeys,
  MAX_ACTIVE_KEYS_PER_USER,
  ownKey,
} from '../auth/api-keys.js';
import type { Database } from '../db/index.js';
import { apiKeys, auditLog, users } from '../db/schema.js';
import { eventFactory } from '../projections/testing.js';
import { buildApp } from '../app.js';
import { testConfig, testDatabase } from '../test-utils.js';
import { loginApp, START, type LoginApp } from '../users/testing.js';
import { FIRST_USER_ID } from '../users/users.js';

// The key permission, the admin's keys, the limit, blocking with revoking,
// server settings and the audit rows.

const KEYS = '/api/v1/keys';
const ADMIN_KEYS = '/api/v1/admin/keys';
const SETTINGS = '/api/v1/admin/settings';
const NOT_ALLOWED = 'You can’t create API keys on this server. Ask the server’s admin for a key.';

describe('API keys in login mode', () => {
  let database: Database;
  let t: LoginApp & { adminToken: string };
  let member: { id: number; token: string };

  beforeEach(async () => {
    database = testDatabase();
    t = await loginApp(database);
    member = await t.addUser('ola');
  });
  afterEach(() => t.app.close());

  const setPermission = (userId: number, allowed: boolean) =>
    database.db.update(users).set({ canCreateApiKeys: allowed }).where(eq(users.id, userId)).run();
  const createOwn = (token: string, name = 'PC') =>
    t.send('POST', KEYS, { token, payload: { name } });
  const createFor = (userId: number, name = 'For you', token = t.adminToken) =>
    t.send('POST', `/api/v1/users/${String(userId)}/keys`, { token, payload: { name } });
  const adminRevoke = (keyId: number, token = t.adminToken) =>
    t.send('DELETE', `${ADMIN_KEYS}/${String(keyId)}`, { token });
  const audits = () =>
    database.db
      .select({ action: auditLog.action, actor: auditLog.actorUserId, target: auditLog.target })
      .from(auditLog)
      .all()
      .filter((row) => row.action.startsWith('key.') || row.action.startsWith('settings.'));
  const verify = (key: string) =>
    t.send('GET', '/api/v1/ingest/verify', { headers: { authorization: `Bearer ${key}` } });
  const ingest = (key: string) => {
    const event = eventFactory().sessionStart('19:00');
    return t.send('POST', '/api/v1/ingest', {
      payload: { events: [event] },
      headers: { authorization: `Bearer ${key}` },
    });
  };

  describe('can_create_api_keys', () => {
    it('gives 403 to a user without it, and creates nothing', async () => {
      setPermission(member.id, false);
      const response = await createOwn(member.token);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: { code: 'FORBIDDEN', message: NOT_ALLOWED, details: [] },
      });
      expect(listApiKeys(database.db, member.id)).toEqual([]);
      expect(audits()).toEqual([]);
    });

    it('applies to an admin too', async () => {
      setPermission(FIRST_USER_ID, false);
      expect((await createOwn(t.adminToken)).statusCode).toBe(403);
    });

    it('takes effect on the next request, with no new login', async () => {
      expect((await createOwn(member.token)).statusCode).toBe(201);
      setPermission(member.id, false);
      expect((await createOwn(member.token)).statusCode).toBe(403);
    });

    it('still lets the user list and revoke their keys, which keep working', async () => {
      const { key, id } = createApiKey(database.db, ownKey(member.id), 'Mine', new Date(START));
      setPermission(member.id, false);

      expect((await ingest(key)).statusCode).toBe(200);
      const list = keysResponseSchema.parse(
        (await t.send('GET', KEYS, { token: member.token })).json(),
      );
      expect(list.keys.map((row) => row.id)).toEqual([id]);

      const revoked = await t.send('DELETE', `${KEYS}/${String(id)}`, { token: member.token });
      expect(revoked.statusCode).toBe(204);
      expect((await ingest(key)).statusCode).toBe(401);
    });

    it('is in auth/me', async () => {
      setPermission(member.id, false);
      const me = authMeResponseSchema.parse(
        (await t.send('GET', '/api/v1/auth/me', { token: member.token })).json(),
      );
      expect(me.user?.canCreateApiKeys).toBe(false);
    });
  });

  describe('limit per user', () => {
    const fill = (userId: number, n: number) => {
      for (let i = 0; i < n; i += 1) createApiKey(database.db, ownKey(userId), `PC ${String(i)}`);
    };

    it(`allows ${String(MAX_ACTIVE_KEYS_PER_USER)} active keys and refuses the next with 409`, async () => {
      fill(member.id, MAX_ACTIVE_KEYS_PER_USER - 1);
      expect((await createOwn(member.token)).statusCode).toBe(201);
      const response = await createOwn(member.token);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: 'CONFLICT',
          message: `You already have ${String(MAX_ACTIVE_KEYS_PER_USER)} active API keys. Revoke one you no longer use first.`,
        },
      });
      expect(listApiKeys(database.db, member.id)).toHaveLength(MAX_ACTIVE_KEYS_PER_USER);
    });

    it('counts keys an admin made, and refuses the admin at the limit too', async () => {
      fill(member.id, MAX_ACTIVE_KEYS_PER_USER - 1);
      expect((await createFor(member.id)).statusCode).toBe(201);
      expect((await createOwn(member.token)).statusCode).toBe(409);
      const response = await createFor(member.id);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          message: `This user already has ${String(MAX_ACTIVE_KEYS_PER_USER)} active API keys. Revoke one first.`,
        },
      });
    });

    it('frees a place when a key is revoked, and counts per user', async () => {
      fill(member.id, MAX_ACTIVE_KEYS_PER_USER);
      expect((await createOwn(t.adminToken)).statusCode).toBe(201);
      const first = listApiKeys(database.db, member.id)[0];
      expect((await adminRevoke(first?.id ?? 0)).statusCode).toBe(204);
      expect((await createOwn(member.token)).statusCode).toBe(201);
    });
  });

  describe('admin creates a key for a user', () => {
    it('shows it once to the admin, owned by the user and made by the admin', async () => {
      setPermission(member.id, false);
      const response = await createFor(member.id, '  Ola’s laptop ');
      expect(response.statusCode).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = createUserKeyResponseSchema.parse(response.json());
      expect(body.apiKey).toMatchObject({
        name: 'Ola’s laptop',
        owner: { id: member.id, username: 'ola' },
        createdBy: { id: FIRST_USER_ID, username: 'admin' },
        createdByAdmin: true,
        revokedAt: null,
      });
      const [row] = database.db.select().from(apiKeys).all();
      expect(row).toMatchObject({ userId: member.id, createdByUserId: FIRST_USER_ID });
      expect(row?.keyHash).toBe(hashApiKey(body.key));

      // The key works for the user's data, and the user sees it, without the key.
      expect((await verify(body.key)).statusCode).toBe(200);
      const own = await t.send('GET', KEYS, { token: member.token });
      expect(own.body).not.toContain(body.key);
      expect(keysResponseSchema.parse(own.json()).keys).toEqual([
        expect.objectContaining({ id: body.apiKey.id, createdByAdmin: true }),
      ]);
      expect(audits()).toEqual([
        { action: 'key.create', actor: FIRST_USER_ID, target: `key:${String(body.apiKey.id)}` },
      ]);
    });

    it('refuses an unknown or deactivated user and a bad name', async () => {
      expect((await createFor(999)).statusCode).toBe(404);
      database.db
        .update(users)
        .set({ disabledAt: new Date(START).toISOString() })
        .where(eq(users.id, member.id))
        .run();
      const disabled = await createFor(member.id);
      expect(disabled.statusCode).toBe(409);
      expect(disabled.json()).toMatchObject({
        error: { message: 'This user is deactivated. Activate them first.' },
      });
      const other = await t.addUser('kari');
      const bad = await createFor(other.id, '   ');
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: { details: [{ path: 'body.name' }] } });
      expect(listApiKeys(database.db)).toEqual([]);
    });
  });

  describe('admin sees and revokes every key', () => {
    it('lists all keys with owner, creator and status, never the key or hash', async () => {
      const mine = createApiKey(database.db, ownKey(FIRST_USER_ID), 'Admin PC', new Date(START));
      const theirs = createApiKey(database.db, ownKey(member.id), 'Ola PC', new Date(START));
      await verify(theirs.key);
      expect((await adminRevoke(mine.id)).statusCode).toBe(204);

      const response = await t.send('GET', ADMIN_KEYS, { token: t.adminToken });
      expect(response.statusCode).toBe(200);
      const body = adminKeysResponseSchema.parse(response.json());
      expect(body.keys).toEqual([
        expect.objectContaining({
          id: mine.id,
          owner: { id: FIRST_USER_ID, username: 'admin' },
          createdBy: { id: FIRST_USER_ID, username: 'admin' },
          revokedAt: new Date(START).toISOString(),
          revokedBy: 'owner',
          revokedByUser: { id: FIRST_USER_ID, username: 'admin' },
          lastUsedAt: null,
        }),
        expect.objectContaining({
          id: theirs.id,
          name: 'Ola PC',
          prefix: theirs.prefix,
          owner: { id: member.id, username: 'ola' },
          revokedAt: null,
          revokedBy: null,
          revokedByUser: null,
          lastUsedAt: expect.any(String) as string,
        }),
      ]);
      for (const { key } of [mine, theirs]) {
        expect(response.body).not.toContain(key);
        expect(response.body).not.toContain(hashApiKey(key));
      }
    });

    it('revokes another user’s key at once; the owner sees “admin”', async () => {
      const { key, id } = createApiKey(database.db, ownKey(member.id), 'Ola PC');
      expect((await ingest(key)).statusCode).toBe(200);

      expect((await adminRevoke(id)).statusCode).toBe(204);
      const next = await ingest(key);
      expect(next.statusCode).toBe(401);
      expect(next.json()).toMatchObject({ error: { message: 'Invalid or revoked API key' } });

      const own = keysResponseSchema.parse(
        (await t.send('GET', KEYS, { token: member.token })).json(),
      );
      expect(own.keys[0]?.revokedBy).toBe('admin');
      expect(listApiKeys(database.db)[0]?.revokedByUserId).toBe(FIRST_USER_ID);
      expect(audits()).toEqual([
        { action: 'key.create', actor: member.id, target: `key:${String(id)}` },
        { action: 'key.revoke', actor: FIRST_USER_ID, target: `key:${String(id)}` },
      ]);
    });

    it('is idempotent, and 404 for an unknown key', async () => {
      const { id } = createApiKey(database.db, ownKey(member.id), 'Ola PC');
      expect((await adminRevoke(id)).statusCode).toBe(204);
      expect((await adminRevoke(id)).statusCode).toBe(204);
      expect(audits().filter((row) => row.action === 'key.revoke')).toHaveLength(1);
      expect((await adminRevoke(999)).statusCode).toBe(404);
    });

    it('is admin only', async () => {
      const { id } = createApiKey(database.db, ownKey(FIRST_USER_ID), 'Admin PC');
      for (const response of [
        await t.send('GET', ADMIN_KEYS, { token: member.token }),
        await adminRevoke(id, member.token),
        await createFor(FIRST_USER_ID, 'x', member.token),
      ]) {
        expect(response.statusCode).toBe(403);
      }
      expect(listApiKeys(database.db)).toEqual([expect.objectContaining({ revokedAt: null })]);
    });
  });

  describe('owner revokes their own key', () => {
    it('gives 401 on the next ingest request, and records the owner', async () => {
      const created = createKeyResponseSchema.parse((await createOwn(member.token)).json());
      expect((await ingest(created.key)).statusCode).toBe(200);
      const id = String(created.apiKey.id);
      expect((await t.send('DELETE', `${KEYS}/${id}`, { token: member.token })).statusCode).toBe(
        204,
      );
      expect((await ingest(created.key)).statusCode).toBe(401);
      expect((await verify(created.key)).statusCode).toBe(401);
      expect(audits()).toEqual([
        { action: 'key.create', actor: member.id, target: `key:${id}` },
        { action: 'key.revoke', actor: member.id, target: `key:${id}` },
      ]);
    });
  });

  describe('blocking a user’s keys (PATCH /users/:id)', () => {
    const block = (payload: object) =>
      t.send('PATCH', `/api/v1/users/${String(member.id)}`, { token: t.adminToken, payload });

    it('counts active keys in the user list', async () => {
      createApiKey(database.db, ownKey(member.id), 'A');
      const b = createApiKey(database.db, ownKey(member.id), 'B');
      await adminRevoke(b.id);
      const list = usersResponseSchema.parse(
        (await t.send('GET', '/api/v1/users', { token: t.adminToken })).json(),
      );
      expect(list.users.find((user) => user.id === member.id)?.activeApiKeys).toBe(1);
    });

    it('“Block only” keeps the keys working', async () => {
      const { key } = createApiKey(database.db, ownKey(member.id), 'A');
      const response = await block({ canCreateApiKeys: false });
      expect(response.statusCode).toBe(200);
      expect(managedUserSchema.parse(response.json())).toMatchObject({
        canCreateApiKeys: false,
        activeApiKeys: 1,
      });
      expect((await ingest(key)).statusCode).toBe(200);
      expect((await createOwn(member.token)).statusCode).toBe(403);
      expect(
        database.db
          .select({ action: auditLog.action })
          .from(auditLog)
          .all()
          .map((r) => r.action),
      ).toContain('user.keys_deny');
      expect(audits().filter((row) => row.action === 'key.revoke')).toEqual([]);
    });

    it('“Block and revoke” revokes every active key at once, as the admin route does', async () => {
      const a = createApiKey(database.db, ownKey(member.id), 'A');
      const b = createApiKey(database.db, ownKey(member.id), 'B');
      const old = createApiKey(database.db, ownKey(member.id), 'Old');
      await t.send('DELETE', `${KEYS}/${String(old.id)}`, { token: member.token });
      const mine = createApiKey(database.db, ownKey(FIRST_USER_ID), 'Admin PC');

      const response = await block({ canCreateApiKeys: false, revokeActiveKeys: true });
      expect(response.statusCode).toBe(200);
      expect(managedUserSchema.parse(response.json())).toMatchObject({
        canCreateApiKeys: false,
        activeApiKeys: 0,
      });
      expect((await ingest(a.key)).statusCode).toBe(401);
      expect((await ingest(b.key)).statusCode).toBe(401);
      expect((await ingest(mine.key)).statusCode).toBe(200);

      const own = keysResponseSchema.parse(
        (await t.send('GET', KEYS, { token: member.token })).json(),
      );
      expect(own.keys.map((row) => [row.name, row.revokedBy])).toEqual([
        ['A', 'admin'],
        ['B', 'admin'],
        ['Old', 'owner'],
      ]);
      expect(audits().filter((row) => row.action === 'key.revoke')).toEqual([
        { action: 'key.revoke', actor: member.id, target: `key:${String(old.id)}` },
        { action: 'key.revoke', actor: FIRST_USER_ID, target: `key:${String(a.id)}` },
        { action: 'key.revoke', actor: FIRST_USER_ID, target: `key:${String(b.id)}` },
      ]);
    });

    it('revokes when the permission was already off', async () => {
      setPermission(member.id, false);
      const a = createApiKey(database.db, ownKey(member.id), 'A');
      expect((await block({ canCreateApiKeys: false, revokeActiveKeys: true })).statusCode).toBe(
        200,
      );
      expect((await ingest(a.key)).statusCode).toBe(401);
    });

    it('only revokes together with blocking', async () => {
      const a = createApiKey(database.db, ownKey(member.id), 'A');
      for (const payload of [
        { revokeActiveKeys: true },
        { canCreateApiKeys: true, revokeActiveKeys: true },
      ]) {
        const response = await block(payload);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error: { details: [{ path: 'body.revokeActiveKeys' }] },
        });
      }
      expect((await ingest(a.key)).statusCode).toBe(200);
    });
  });

  describe('server settings', () => {
    it('defaults new invites to “can create API keys”, and stores a change', async () => {
      const get = () => t.send('GET', SETTINGS, { token: t.adminToken });
      expect(serverSettingsSchema.parse((await get()).json())).toMatchObject({
        defaultInviteCanCreateApiKeys: true,
        instanceText: null,
      });
      const patch = await t.send('PATCH', SETTINGS, {
        token: t.adminToken,
        payload: { defaultInviteCanCreateApiKeys: false },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json()).toMatchObject({ defaultInviteCanCreateApiKeys: false });
      expect((await get()).json()).toMatchObject({ defaultInviteCanCreateApiKeys: false });

      // The same value again writes no audit row.
      await t.send('PATCH', SETTINGS, {
        token: t.adminToken,
        payload: { defaultInviteCanCreateApiKeys: false },
      });
      expect(audits()).toEqual([
        {
          action: 'settings.update',
          actor: FIRST_USER_ID,
          target: 'setting:default_invite_can_create_api_keys',
        },
      ]);
    });

    it('needs a field, and is admin only', async () => {
      const empty = await t.send('PATCH', SETTINGS, { token: t.adminToken, payload: {} });
      expect(empty.statusCode).toBe(400);
      expect((await t.send('GET', SETTINGS, { token: member.token })).statusCode).toBe(403);
      const denied = await t.send('PATCH', SETTINGS, {
        token: member.token,
        payload: { defaultInviteCanCreateApiKeys: false },
      });
      expect(denied.statusCode).toBe(403);
      expect(audits()).toEqual([]);
    });
  });

  it('deleting a user removes their own key actions from audit_log, not the admin’s', async () => {
    const own = createKeyResponseSchema.parse((await createOwn(member.token)).json());
    const given = createUserKeyResponseSchema.parse((await createFor(member.id)).json());
    await t.send('DELETE', `${KEYS}/${String(own.apiKey.id)}`, { token: member.token });
    await adminRevoke(given.apiKey.id);
    const removed = await t.send('DELETE', `/api/v1/users/${String(member.id)}`, {
      token: t.adminToken,
    });
    expect(removed.statusCode).toBe(204);
    expect(audits()).toEqual([
      { action: 'key.create', actor: FIRST_USER_ID, target: `key:${String(given.apiKey.id)}` },
      { action: 'key.revoke', actor: FIRST_USER_ID, target: `key:${String(given.apiKey.id)}` },
    ]);
  });

  it('never writes a key, its hash or its name to audit_log or the logs', async () => {
    const created = createKeyResponseSchema.parse(
      (await createOwn(member.token, 'Secret name')).json(),
    );
    const forUser = createUserKeyResponseSchema.parse(
      (await createFor(member.id, 'Other name')).json(),
    );
    await adminRevoke(created.apiKey.id);
    await t.send('PATCH', `/api/v1/users/${String(member.id)}`, {
      token: t.adminToken,
      payload: { canCreateApiKeys: false, revokeActiveKeys: true },
    });
    const everything = JSON.stringify(database.db.select().from(auditLog).all()) + t.logs.join('');
    for (const key of [created.key, forUser.key]) {
      expect(everything).not.toContain(key);
      expect(everything).not.toContain(hashApiKey(key));
    }
    expect(everything).not.toContain('Secret name');
    expect(everything).not.toContain('Other name');
  });
});

describe('API keys in local mode', () => {
  it('ignores can_create_api_keys, and auth/me says keys can be made', async () => {
    const database = testDatabase();
    database.db
      .update(users)
      .set({ canCreateApiKeys: false })
      .where(eq(users.id, FIRST_USER_ID))
      .run();
    const app = buildApp({ db: database, config: testConfig() });
    try {
      const headers = { host: 'localhost:3100', origin: 'http://localhost:3100' };
      const created = await app.inject({
        method: 'POST',
        url: KEYS,
        headers,
        payload: { name: 'PC' },
      });
      expect(created.statusCode).toBe(201);
      const me = authMeResponseSchema.parse(
        (await app.inject({ url: '/api/v1/auth/me', headers })).json(),
      );
      expect(me.user?.canCreateApiKeys).toBe(true);
      // Changes to other users' keys need login mode, like the rest of user management.
      const revoke = await app.inject({ method: 'DELETE', url: `${ADMIN_KEYS}/1`, headers });
      expect(revoke.statusCode).toBe(409);
      expect((await app.inject({ url: ADMIN_KEYS, headers })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
