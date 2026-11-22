import { managedUserSchema, usersResponseSchema, type ErrorResponse } from '@fireside/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import { auditLog, users, userSessions } from '../db/schema.js';
import { testDatabase } from '../test-utils.js';
import { loginApp, PASSWORD, START, type LoginApp } from '../users/testing.js';
import { FIRST_USER_ID, findUserById } from '../users/users.js';

const LAST_ADMIN = {
  error: {
    code: 'CONFLICT',
    message: 'The last admin can’t be deleted, disabled or demoted',
    details: [],
  },
};

describe('/api/v1/users', () => {
  let database: Database;
  let t: LoginApp & { adminToken: string };
  let member: { id: number; token: string };

  beforeEach(async () => {
    database = testDatabase();
    t = await loginApp(database);
    member = await t.addUser('ola');
  });
  afterEach(() => t.app.close());

  const patch = (id: number, payload: object, token = t.adminToken) =>
    t.send('PATCH', `/api/v1/users/${String(id)}`, { token, payload });
  const actions = () =>
    database.db
      .select({ action: auditLog.action, actor: auditLog.actorUserId, target: auditLog.target })
      .from(auditLog)
      .all();
  const sessionsOf = (userId: number) =>
    database.db.select().from(userSessions).where(eq(userSessions.userId, userId)).all();

  it('lists users with role, key permission, times and who is asking', async () => {
    database.db
      .update(users)
      .set({ lastLoginAt: '2026-11-18T11:00:00.000Z' })
      .where(eq(users.id, FIRST_USER_ID))
      .run();
    const response = await t.send('GET', '/api/v1/users', { token: t.adminToken });
    expect(response.statusCode).toBe(200);
    const body = usersResponseSchema.parse(response.json());
    expect(body.users).toEqual([
      {
        id: FIRST_USER_ID,
        username: 'admin',
        role: 'admin',
        canCreateApiKeys: true,
        createdAt: expect.any(String) as string,
        lastLoginAt: '2026-11-18T11:00:00.000Z',
        disabledAt: null,
        isSelf: true,
        activeApiKeys: 0,
        twoFactorEnabled: false,
      },
      {
        id: member.id,
        username: 'ola',
        role: 'member',
        canCreateApiKeys: true,
        createdAt: new Date(START).toISOString(),
        lastLoginAt: null,
        disabledAt: null,
        isSelf: false,
        activeApiKeys: 0,
        twoFactorEnabled: false,
      },
    ]);
    expect(response.body).not.toMatch(/argon2|password/i);
  });

  it('changes role, key permission and name, with one audit row each', async () => {
    const response = await patch(member.id, {
      role: 'admin',
      canCreateApiKeys: false,
      username: ' Kari ',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(managedUserSchema.parse(response.json())).toMatchObject({
      username: 'kari',
      role: 'admin',
      canCreateApiKeys: false,
    });
    const target = `user:${String(member.id)}`;
    expect(actions()).toEqual([
      { action: 'user.rename', actor: FIRST_USER_ID, target },
      { action: 'user.promote', actor: FIRST_USER_ID, target },
      { action: 'user.keys_deny', actor: FIRST_USER_ID, target },
    ]);
    // Unchanged values write nothing.
    await patch(member.id, { role: 'admin', canCreateApiKeys: false, username: 'kari' });
    expect(actions()).toHaveLength(3);
    await patch(member.id, { role: 'member', canCreateApiKeys: true });
    expect(
      actions()
        .slice(3)
        .map((row) => row.action),
    ).toEqual(['user.demote', 'user.keys_allow']);
  });

  it('refuses an empty change, a bad name and a taken name', async () => {
    expect((await patch(member.id, {})).json<ErrorResponse>().error.details).toEqual([
      { path: 'body', message: 'Change at least one field' },
    ]);
    expect(
      (await patch(member.id, { username: 'x' })).json<ErrorResponse>().error.details[0]?.path,
    ).toBe('body.username');
    const taken = await patch(member.id, { username: 'admin' });
    expect(taken.statusCode).toBe(400);
    expect(taken.json<ErrorResponse>().error.details[0]?.message).toBe('That username is taken');
    expect((await patch(999, { role: 'admin' })).statusCode).toBe(404);
  });

  it('deactivating ends the sessions and blocks login; activating allows it again', async () => {
    expect(sessionsOf(member.id)).toHaveLength(1);
    const response = await patch(member.id, { disabled: true });
    expect(response.json()).toMatchObject({ disabledAt: new Date(START).toISOString() });
    expect(sessionsOf(member.id)).toEqual([]);
    expect((await t.send('GET', '/api/v1/keys', { token: member.token })).statusCode).toBe(401);
    const login = () =>
      t.send('POST', '/api/v1/auth/login', { payload: { username: 'ola', password: PASSWORD } });
    expect((await login()).statusCode).toBe(401);

    expect((await patch(member.id, { disabled: false })).json()).toMatchObject({
      disabledAt: null,
    });
    expect((await login()).statusCode).toBe(200);
    expect(actions().map((row) => row.action)).toEqual([
      'user.disable',
      'user.enable',
      'auth.login',
    ]);
  });

  it('an admin can’t deactivate themselves', async () => {
    const response = await patch(FIRST_USER_ID, { disabled: true });
    expect(response.statusCode).toBe(409);
    expect(findUserById(database.db, FIRST_USER_ID)?.disabledAt).toBeNull();
  });

  it('never leaves the server without an active admin', async () => {
    const other = await t.addUser('kari', 'admin');
    // Demoting yourself is fine while another admin is active.
    expect((await patch(FIRST_USER_ID, { role: 'member' }, other.token)).statusCode).toBe(200);
    // Now `kari` is the last active admin.
    expect((await patch(other.id, { role: 'member' }, other.token)).json()).toEqual(LAST_ADMIN);
    expect((await patch(other.id, { disabled: true }, other.token)).statusCode).toBe(409);
    // A disabled admin doesn't count.
    database.db
      .update(users)
      .set({ role: 'admin', disabledAt: new Date(START).toISOString() })
      .where(eq(users.id, FIRST_USER_ID))
      .run();
    // The admin route never deletes the caller; the last admin can't delete themselves.
    const deleting = await t.send('DELETE', `/api/v1/users/${String(other.id)}`, {
      token: other.token,
    });
    expect(deleting.statusCode).toBe(409);
    const selfDelete = await t.send('POST', '/api/v1/auth/delete-account', {
      token: other.token,
      payload: { password: PASSWORD },
    });
    expect(selfDelete.json()).toEqual(LAST_ADMIN);
    expect(findUserById(database.db, other.id)).toBeDefined();
  });

  it('deletes a user, and refuses an unknown one', async () => {
    const response = await t.send('DELETE', `/api/v1/users/${String(member.id)}`, {
      token: t.adminToken,
    });
    expect(response.statusCode).toBe(204);
    expect(findUserById(database.db, member.id)).toBeUndefined();
    expect((await t.send('GET', '/api/v1/keys', { token: member.token })).statusCode).toBe(401);
    expect(actions()).toContainEqual({
      action: 'user.delete',
      actor: FIRST_USER_ID,
      target: `user:${String(member.id)}`,
    });
    const again = await t.send('DELETE', `/api/v1/users/${String(member.id)}`, {
      token: t.adminToken,
    });
    expect(again.statusCode).toBe(404);
  });

  it('a user deletes themselves after confirming their password', async () => {
    const wrong = await t.send('POST', '/api/v1/auth/delete-account', {
      token: member.token,
      payload: { password: 'not the password' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<ErrorResponse>().error.details).toEqual([
      { path: 'body.password', message: 'Wrong password' },
    ]);
    expect(findUserById(database.db, member.id)).toBeDefined();

    const response = await t.send('POST', '/api/v1/auth/delete-account', {
      token: member.token,
      payload: { password: PASSWORD },
    });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect(findUserById(database.db, member.id)).toBeUndefined();
    expect(actions()).toContainEqual({
      action: 'user.delete_self',
      actor: null,
      target: `user:${String(member.id)}`,
    });
  });

  it('refuses changes in local mode', async () => {
    database.db.update(users).set({ passwordHash: null }).run();
    database.db.delete(users).where(eq(users.id, member.id)).run();
    expect((await t.send('GET', '/api/v1/users')).statusCode).toBe(200);
    const response = await t.send('PATCH', `/api/v1/users/${String(FIRST_USER_ID)}`, {
      payload: { canCreateApiKeys: false },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorResponse>().error.message).toMatch(/Turn on login first/);
  });
});
