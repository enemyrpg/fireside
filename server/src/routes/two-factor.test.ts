import {
  createdInviteResponseSchema,
  loginResponseSchema,
  recoveryCodesResponseSchema,
  totpSetupResponseSchema,
  twoFactorStatusResponseSchema,
} from '@fireside/shared';
import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_COOKIE, MFA_COOKIE } from '../auth/cookie.js';
import { isKnownDevice, rememberDevice } from '../auth/devices.js';
import { LOGIN_USER_RULE, TOTP_RULE } from '../auth/login-limiter.js';
import { createSession } from '../auth/sessions.js';
import { totpCode } from '../auth/totp.js';
import type { Database } from '../db/index.js';
import { auditLog, recoveryCodes, trustedDevices, users, userSessions } from '../db/schema.js';
import { testDatabase } from '../test-utils.js';
import {
  cookieToken,
  loginApp,
  PASSWORD,
  setCookies,
  tokenOf,
  type LoginApp,
} from '../users/testing.js';
import { twoFactorKeyWarnings } from '../users/two-factor.js';
import { FIRST_USER_ID, findUserById } from '../users/users.js';

// Two-factor authentication and device cookies.

const STEP_MS = 30_000;
const NEW_PASSWORD = 'another long password';

describe('two-factor authentication', () => {
  let database: Database;
  let t: LoginApp & { adminToken: string };

  beforeEach(async () => {
    database = testDatabase();
    t = await loginApp(database);
  });
  afterEach(() => t.app.close());

  const now = () => new Date(t.clock.now);
  /** Moves to the next 30 s step, so a new code is accepted. */
  const nextStep = () => {
    t.clock.now += STEP_MS;
  };
  const audits = () =>
    database.db
      .select({ action: auditLog.action, actor: auditLog.actorUserId, target: auditLog.target })
      .from(auditLog)
      .orderBy(asc(auditLog.id))
      .all();

  const login = (
    username: string,
    password: string,
    cookies: Record<string, string> = {},
    remoteAddress?: string,
  ) =>
    t.send('POST', '/api/v1/auth/login', {
      payload: { username, password },
      cookies,
      ...(remoteAddress ? { remoteAddress } : {}),
    });
  const loginCode = (code: string, mfa: string | undefined, cookies: Record<string, string> = {}) =>
    t.send('POST', '/api/v1/auth/login/totp', {
      payload: { code },
      cookies: { ...cookies, ...(mfa === undefined ? {} : { [MFA_COOKIE]: mfa }) },
    });

  /** Turns 2FA on for the session's user; returns the secret and recovery codes. */
  async function enable(token: string): Promise<{ secret: string; codes: string[] }> {
    const setup = await t.send('POST', '/api/v1/auth/totp/setup', {
      token,
      payload: { password: PASSWORD },
    });
    expect(setup.statusCode, setup.body).toBe(200);
    const { secret } = totpSetupResponseSchema.parse(setup.json());
    const enabled = await t.send('POST', '/api/v1/auth/totp/enable', {
      token,
      payload: { code: totpCode(secret, now()) },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    nextStep();
    return { secret, codes: recoveryCodesResponseSchema.parse(enabled.json()).recoveryCodes };
  }

  /** The password step; returns the challenge cookie. */
  async function passwordStep(username = 'admin', password = PASSWORD): Promise<string> {
    const response = await login(username, password);
    expect(response.statusCode, response.body).toBe(200);
    expect(loginResponseSchema.parse(response.json())).toEqual({ twoFactorRequired: true });
    const cookies = setCookies(response);
    expect(cookieToken(response)).toBeUndefined();
    expect(cookies.has(DEVICE_COOKIE)).toBe(false);
    const mfa = cookies.get(MFA_COOKIE);
    expect(mfa).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return mfa ?? '';
  }

  const status = async (token: string) =>
    twoFactorStatusResponseSchema.parse(
      (await t.send('GET', '/api/v1/auth/totp', { token })).json(),
    );
  const errorPath = (response: LightMyRequestResponse) =>
    response.json<{ error: { details: { path: string }[] } }>().error.details[0]?.path;

  describe('setup', () => {
    it('needs the password, stores the secret encrypted, and turns on with the first code', async () => {
      const wrong = await t.send('POST', '/api/v1/auth/totp/setup', {
        token: t.adminToken,
        payload: { password: 'not my password' },
      });
      expect(wrong.statusCode).toBe(400);
      expect(errorPath(wrong)).toBe('body.password');

      const setup = await t.send('POST', '/api/v1/auth/totp/setup', {
        token: t.adminToken,
        payload: { password: PASSWORD },
      });
      const { secret, otpauthUri } = totpSetupResponseSchema.parse(setup.json());
      expect(otpauthUri).toContain(`secret=${secret}`);
      expect(otpauthUri).toContain(':admin?');
      const pending = findUserById(database.db, FIRST_USER_ID);
      expect(pending?.totpPendingSecret).toMatch(/^v1:/);
      expect(pending?.totpPendingSecret).not.toContain(secret);
      expect((await status(t.adminToken)).enabled).toBe(false);

      const bad = await t.send('POST', '/api/v1/auth/totp/enable', {
        token: t.adminToken,
        payload: { code: '000000' === totpCode(secret, now()) ? '111111' : '000000' },
      });
      expect(bad.statusCode).toBe(400);
      expect(errorPath(bad)).toBe('body.code');

      const ok = await t.send('POST', '/api/v1/auth/totp/enable', {
        token: t.adminToken,
        payload: { code: totpCode(secret, now()) },
      });
      expect(ok.statusCode).toBe(200);
      const { recoveryCodes: codes } = recoveryCodesResponseSchema.parse(ok.json());
      expect(new Set(codes).size).toBe(10);
      const row = findUserById(database.db, FIRST_USER_ID);
      expect(row?.totpSecret).toMatch(/^v1:/);
      expect(row?.totpPendingSecret).toBeNull();
      // Only hashes are stored.
      const stored = database.db.select().from(recoveryCodes).all();
      expect(stored).toHaveLength(10);
      for (const code of codes) expect(JSON.stringify(stored)).not.toContain(code);
      expect(await status(t.adminToken)).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
      expect(audits().at(-1)).toEqual({ action: 'auth.totp_enable', actor: 1, target: 'user:1' });

      // On already: 409.
      const again = await t.send('POST', '/api/v1/auth/totp/setup', {
        token: t.adminToken,
        payload: { password: PASSWORD },
      });
      expect(again.statusCode).toBe(409);
      // Codes and secrets never reach the logs.
      const logs = t.logs.join('\n');
      expect(logs).not.toContain(secret);
      for (const code of codes) expect(logs).not.toContain(code);
    });

    it('lets a pending setup time out after 10 minutes', async () => {
      const setup = await t.send('POST', '/api/v1/auth/totp/setup', {
        token: t.adminToken,
        payload: { password: PASSWORD },
      });
      const { secret } = totpSetupResponseSchema.parse(setup.json());
      t.clock.now += 10 * 60 * 1000;
      const late = await t.send('POST', '/api/v1/auth/totp/enable', {
        token: t.adminToken,
        payload: { code: totpCode(secret, now()) },
      });
      expect(late.statusCode).toBe(409);
      expect((await status(t.adminToken)).enabled).toBe(false);
    });

    it('is refused in local mode', async () => {
      const local = testDatabase();
      const app = await loginApp(local);
      local.db.update(users).set({ passwordHash: null }).run();
      const response = await app.send('POST', '/api/v1/auth/totp/setup', {
        payload: { password: PASSWORD },
      });
      expect(response.statusCode).toBe(409);
      await app.app.close();
    });
  });

  describe('login', () => {
    it('asks for a code only after the right password, then logs in with a device cookie', async () => {
      const { secret } = await enable(t.adminToken);
      // A wrong password gives the usual 401, no hint of 2FA.
      const wrong = await login('admin', 'not my password');
      expect(wrong.statusCode).toBe(401);
      expect(wrong.body).not.toContain('twoFactor');

      const mfa = await passwordStep();
      const response = await loginCode(totpCode(secret, now()), mfa);
      expect(response.statusCode, response.body).toBe(200);
      expect(loginResponseSchema.parse(response.json())).toMatchObject({
        user: { id: 1, twoFactorEnabled: true },
      });
      const cookies = setCookies(response);
      expect(cookieToken(response)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(cookies.get(DEVICE_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(cookies.get(MFA_COOKIE)).toBe('');
      expect(audits().filter((row) => row.action === 'auth.login')).toHaveLength(1);
    });

    it('never accepts a code twice, nor an older one after a newer', async () => {
      const { secret } = await enable(t.adminToken);
      const code = totpCode(secret, now());
      expect((await loginCode(code, await passwordStep())).statusCode).toBe(200);
      // The same code in the same 30 s.
      const again = await loginCode(code, await passwordStep());
      expect(again.statusCode).toBe(401);
      expect(again.json()).toMatchObject({ error: { message: 'Invalid code' } });
      // The previous step's code, still inside the drift window.
      const older = totpCode(secret, new Date(t.clock.now - STEP_MS));
      expect((await loginCode(older, await passwordStep())).statusCode).toBe(401);
    });

    it('lets two parallel requests with one code log in only once', async () => {
      const { secret } = await enable(t.adminToken);
      const [first, second] = [await passwordStep(), await passwordStep()];
      const code = totpCode(secret, now());
      const results = await Promise.all([loginCode(code, first), loginCode(code, second)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    });

    it('stores recovery codes as an HMAC bound to the user, which the key file is needed for', async () => {
      const { codes } = await enable(t.adminToken);
      const stored = database.db.select().from(recoveryCodes).all();
      const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
      for (const code of codes) {
        const plain = code.replace('-', '');
        expect(stored.some((row) => row.codeHash === sha256(plain))).toBe(false);
      }
      // Without the key file the codes stop working too (reset-2fa covers it).
      t.keyStore.key = undefined;
      expect((await loginCode(codes[0] ?? '', await passwordStep())).statusCode).toBe(401);
      expect(t.logs.join('\n')).toContain('pnpm cli users reset-2fa');
    });

    it('takes a recovery code once, in any case and spacing', async () => {
      const { codes } = await enable(t.adminToken);
      const code = codes[0] ?? '';
      const ok = await loginCode(` ${code.toUpperCase()} `, await passwordStep());
      expect(ok.statusCode, ok.body).toBe(200);
      expect(audits().some((row) => row.action === 'auth.recovery_code_use')).toBe(true);
      expect((await loginCode(code, await passwordStep())).statusCode).toBe(401);
      expect((await status(t.adminToken)).recoveryCodesLeft).toBe(9);
    });

    it('lets one recovery code log in only once, also in parallel', async () => {
      const { codes } = await enable(t.adminToken);
      const [first, second] = [await passwordStep(), await passwordStep()];
      const results = await Promise.all([
        loginCode(codes[1] ?? '', first),
        loginCode(codes[1] ?? '', second),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    });

    it('allows 5 codes per password, then asks for the password again', async () => {
      await enable(t.adminToken);
      const mfa = await passwordStep();
      for (let i = 0; i < 5; i++) {
        expect((await loginCode('000000', mfa)).json()).toMatchObject({
          error: { message: 'Invalid code' },
        });
      }
      const sixth = await loginCode('000000', mfa);
      expect(sixth.statusCode).toBe(401);
      expect(sixth.json()).toMatchObject({
        error: { message: 'Your login timed out. Enter your password again.' },
      });
    });

    it('times out after 5 minutes, and without a challenge', async () => {
      const { secret } = await enable(t.adminToken);
      const mfa = await passwordStep();
      t.clock.now += 5 * 60 * 1000;
      const late = await loginCode(totpCode(secret, now()), mfa);
      expect(late.statusCode).toBe(401);
      expect(late.json()).toMatchObject({ error: { message: /timed out/ } });
      expect((await loginCode(totpCode(secret, now()), undefined)).statusCode).toBe(401);
    });

    it('ends the code step when the password changes in between', async () => {
      const { secret } = await enable(t.adminToken);
      const mfa = await passwordStep();
      const change = await t.send('POST', '/api/v1/auth/password', {
        token: t.adminToken,
        payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      });
      expect(change.statusCode).toBe(204);
      const late = await loginCode(totpCode(secret, now()), mfa);
      expect(late.statusCode).toBe(401);
      expect(late.json()).toMatchObject({ error: { message: /timed out/ } });
      expect(cookieToken(late)).toBeUndefined();
    });

    it('ends the code step when 2FA is turned off in between', async () => {
      const ola = await t.addUser('ola');
      const { secret } = await enable(ola.token);
      const mfa = await passwordStep('ola');
      await t.send('POST', `/api/v1/users/${String(ola.id)}/totp-reset`, { token: t.adminToken });
      expect((await loginCode(totpCode(secret, now()), mfa)).statusCode).toBe(401);
    });

    it('uses no try of the step on a 429', async () => {
      const { secret } = await enable(t.adminToken);
      for (let i = 0; i < TOTP_RULE.free; i++) await loginCode('000000', await passwordStep());
      const mfa = await passwordStep();
      // Blocked several times while waiting: no tries used.
      for (let i = 0; i < 6; i++) expect((await loginCode('000000', mfa)).statusCode).toBe(429);
      t.clock.now += 2000;
      const ok = await loginCode(totpCode(secret, now()), mfa);
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it('limits codes per user (totp:user) across challenges and IPs, with 429', async () => {
      const { secret } = await enable(t.adminToken);
      for (let i = 0; i < TOTP_RULE.free; i++) {
        expect((await loginCode('000000', await passwordStep())).statusCode).toBe(401);
      }
      const blocked = await loginCode(totpCode(secret, now()), await passwordStep());
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('2');
      t.clock.now += 2000;
      expect((await loginCode(totpCode(secret, now()), await passwordStep())).statusCode).toBe(200);
    });

    it('treats an undecryptable secret (lost key file) as a wrong code, and logs why', async () => {
      const { secret } = await enable(t.adminToken);
      t.keyStore.key = undefined;
      const response = await loginCode(totpCode(secret, now()), await passwordStep());
      expect(response.statusCode).toBe(401);
      expect(t.logs.join('\n')).toContain('pnpm cli users reset-2fa');
      expect(twoFactorKeyWarnings(database.db, t.keyStore)).toEqual([
        expect.stringMatching(
          /^admin has two-factor authentication on, but the key file is missing.*pnpm cli users reset-2fa admin$/,
        ),
      ]);
    });
  });

  describe('turning off and new recovery codes', () => {
    it('needs password and a current code to turn off, and deletes the recovery codes', async () => {
      const { secret } = await enable(t.adminToken);
      const noCode = await t.send('POST', '/api/v1/auth/totp/disable', {
        token: t.adminToken,
        payload: { password: PASSWORD, code: '000000' },
      });
      expect(noCode.statusCode).toBe(400);
      expect(errorPath(noCode)).toBe('body.code');
      const wrongPassword = await t.send('POST', '/api/v1/auth/totp/disable', {
        token: t.adminToken,
        payload: { password: 'not my password', code: totpCode(secret, now()) },
      });
      expect(errorPath(wrongPassword)).toBe('body.password');
      const ok = await t.send('POST', '/api/v1/auth/totp/disable', {
        token: t.adminToken,
        payload: { password: PASSWORD, code: totpCode(secret, now()) },
      });
      expect(ok.statusCode, ok.body).toBe(204);
      expect(await status(t.adminToken)).toEqual({
        enabled: false,
        enabledAt: null,
        recoveryCodesLeft: 0,
      });
      expect(database.db.select().from(recoveryCodes).all()).toEqual([]);
      expect(findUserById(database.db, 1)?.totpSecret).toBeNull();
      // Login is one step again.
      expect(loginResponseSchema.parse((await login('admin', PASSWORD)).json())).toHaveProperty(
        'user',
      );
    });

    it('replaces every recovery code', async () => {
      const { secret, codes } = await enable(t.adminToken);
      const response = await t.send('POST', '/api/v1/auth/totp/recovery-codes', {
        token: t.adminToken,
        payload: { password: PASSWORD, code: totpCode(secret, now()) },
      });
      expect(response.statusCode, response.body).toBe(200);
      const fresh = recoveryCodesResponseSchema.parse(response.json()).recoveryCodes;
      expect(fresh.some((code) => codes.includes(code))).toBe(false);
      expect((await loginCode(codes[0] ?? '', await passwordStep())).statusCode).toBe(401);
      expect((await loginCode(fresh[0] ?? '', await passwordStep())).statusCode).toBe(200);
    });
  });

  describe('other logins end when 2FA changes', () => {
    /** Another browser of `userId`: its own session and device cookie. */
    function otherBrowser(userId = FIRST_USER_ID) {
      const token = createSession(database.db, userId, { now: now() }).token;
      const device = rememberDevice(database.db, userId, undefined, now());
      return { token, device };
    }
    const meStatus = async (token: string) =>
      (await t.send('GET', '/api/v1/keys', { token })).statusCode;
    const devicesOf = (userId: number) =>
      database.db.select().from(trustedDevices).where(eq(trustedDevices.userId, userId)).all();

    it('ends other sessions and forgets other devices when 2FA is turned on', async () => {
      const other = otherBrowser();
      const ola = await t.addUser('ola');
      const olaDevice = rememberDevice(database.db, ola.id, undefined, now());
      expect(await meStatus(other.token)).toBe(200);

      const setup = await t.send('POST', '/api/v1/auth/totp/setup', {
        token: t.adminToken,
        payload: { password: PASSWORD },
      });
      const { secret } = totpSetupResponseSchema.parse(setup.json());

      // A wrong code ends nothing.
      const wrong = await t.send('POST', '/api/v1/auth/totp/enable', {
        token: t.adminToken,
        payload: { code: '000000' === totpCode(secret, now()) ? '111111' : '000000' },
      });
      expect(wrong.statusCode).toBe(400);
      expect(setCookies(wrong).has(DEVICE_COOKIE)).toBe(false);
      expect(await meStatus(other.token)).toBe(200);
      expect(isKnownDevice(database.db, other.device, FIRST_USER_ID, now())).toBe(true);

      const enabled = await t.send('POST', '/api/v1/auth/totp/enable', {
        token: t.adminToken,
        payload: { code: totpCode(secret, now()) },
      });
      expect(enabled.statusCode, enabled.body).toBe(200);
      // Only the recovery codes in the body, as before.
      expect(Object.keys(enabled.json<object>())).toEqual(['recoveryCodes']);

      // The other browser is logged out and unknown again.
      expect(await meStatus(other.token)).toBe(401);
      expect(isKnownDevice(database.db, other.device, FIRST_USER_ID, now())).toBe(false);
      // This one stays logged in, with the same session and a new device cookie.
      expect(await meStatus(t.adminToken)).toBe(200);
      expect(cookieToken(enabled)).toBeUndefined();
      const device = setCookies(enabled).get(DEVICE_COOKIE);
      expect(device).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isKnownDevice(database.db, device, FIRST_USER_ID, now())).toBe(true);
      expect(devicesOf(FIRST_USER_ID)).toHaveLength(1);
      // Nobody else is touched.
      expect(await meStatus(ola.token)).toBe(200);
      expect(isKnownDevice(database.db, olaDevice, ola.id, now())).toBe(true);
    });

    it('ends other sessions and forgets other devices when new recovery codes are made', async () => {
      const { secret } = await enable(t.adminToken);
      const other = otherBrowser();
      const ola = await t.addUser('ola');
      expect(await meStatus(other.token)).toBe(200);

      const wrong = await t.send('POST', '/api/v1/auth/totp/recovery-codes', {
        token: t.adminToken,
        payload: { password: PASSWORD, code: '000000' },
      });
      expect(wrong.statusCode).toBe(400);
      expect(await meStatus(other.token)).toBe(200);
      expect(isKnownDevice(database.db, other.device, FIRST_USER_ID, now())).toBe(true);

      const response = await t.send('POST', '/api/v1/auth/totp/recovery-codes', {
        token: t.adminToken,
        payload: { password: PASSWORD, code: totpCode(secret, now()) },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(Object.keys(response.json<object>())).toEqual(['recoveryCodes']);

      expect(await meStatus(other.token)).toBe(401);
      expect(isKnownDevice(database.db, other.device, FIRST_USER_ID, now())).toBe(false);
      expect(await meStatus(t.adminToken)).toBe(200);
      const device = setCookies(response).get(DEVICE_COOKIE);
      expect(isKnownDevice(database.db, device, FIRST_USER_ID, now())).toBe(true);
      expect(devicesOf(FIRST_USER_ID)).toHaveLength(1);
      expect(await meStatus(ola.token)).toBe(200);
    });
  });

  describe('admin turns off a user’s 2FA', () => {
    it('turns it off, ends sessions, devices and recovery codes, audited', async () => {
      const ola = await t.addUser('ola');
      await enable(ola.token);
      database.db
        .insert(trustedDevices)
        .values({
          userId: ola.id,
          tokenHash: 'x',
          createdAt: now().toISOString(),
          lastUsedAt: now().toISOString(),
          expiresAt: new Date(t.clock.now + 1e9).toISOString(),
        })
        .run();
      const response = await t.send('POST', `/api/v1/users/${String(ola.id)}/totp-reset`, {
        token: t.adminToken,
      });
      expect(response.statusCode, response.body).toBe(204);
      expect(findUserById(database.db, ola.id)?.totpEnabledAt).toBeNull();
      expect(
        database.db.select().from(userSessions).where(eq(userSessions.userId, ola.id)).all(),
      ).toEqual([]);
      expect(
        database.db.select().from(trustedDevices).where(eq(trustedDevices.userId, ola.id)).all(),
      ).toEqual([]);
      expect(database.db.select().from(recoveryCodes).all()).toEqual([]);
      expect(audits().at(-1)).toEqual({
        action: 'user.totp_reset',
        actor: 1,
        target: `user:${String(ola.id)}`,
      });
      const users = await t.send('GET', '/api/v1/users', { token: t.adminToken });
      expect(users.json()).toMatchObject({ users: [{}, { id: ola.id, twoFactorEnabled: false }] });
    });

    it('refuses a user without 2FA, without logging them out', async () => {
      const ola = await t.addUser('ola');
      const response = await t.send('POST', `/api/v1/users/${String(ola.id)}/totp-reset`, {
        token: t.adminToken,
      });
      expect(response.statusCode).toBe(409);
      expect((await t.send('GET', '/api/v1/auth/me', { token: ola.token })).json()).toMatchObject({
        user: { id: ola.id },
      });
      expect(audits().some((row) => row.action === 'user.totp_reset')).toBe(false);
    });

    it('gives the same 404 as other unknown IDs, and 409 for yourself', async () => {
      const unknown = await t.send('POST', '/api/v1/users/99/totp-reset', { token: t.adminToken });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ error: { message: 'User not found' } });
      const self = await t.send('POST', '/api/v1/users/1/totp-reset', { token: t.adminToken });
      expect(self.statusCode).toBe(409);
    });
  });

  describe('a reset link keeps 2FA', () => {
    async function resetLink(userId: number): Promise<string> {
      const response = await t.send('POST', `/api/v1/users/${String(userId)}/password-reset`, {
        token: t.adminToken,
      });
      return tokenOf(createdInviteResponseSchema.parse(response.json()).url);
    }
    const reset = (token: string, code?: string) =>
      t.send('POST', '/api/v1/auth/password-reset', {
        payload: { token, password: NEW_PASSWORD, ...(code === undefined ? {} : { code }) },
      });

    it('asks for a code, keeps the link on a wrong one, and works with the right one', async () => {
      const ola = await t.addUser('ola');
      const { secret } = await enable(ola.token);
      const link = await resetLink(ola.id);
      const lookup = await t.send('POST', '/api/v1/auth/invite/lookup', {
        payload: { token: link },
      });
      expect(lookup.json()).toEqual({
        type: 'password_reset',
        username: 'ola',
        twoFactorRequired: true,
      });

      const missing = await reset(link);
      expect(missing.statusCode).toBe(400);
      expect(errorPath(missing)).toBe('body.code');
      const wrong = await reset(link, '000000');
      expect(wrong.statusCode).toBe(400);
      expect(errorPath(wrong)).toBe('body.code');
      // Still unused, password unchanged.
      expect(
        (await t.send('POST', '/api/v1/auth/invite/lookup', { payload: { token: link } }))
          .statusCode,
      ).toBe(200);

      const ok = await reset(link, totpCode(secret, now()));
      expect(ok.statusCode, ok.body).toBe(204);
      expect(setCookies(ok).get(DEVICE_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // 2FA stays on.
      expect(findUserById(database.db, ola.id)?.totpEnabledAt).not.toBeNull();
      expect((await reset(link, totpCode(secret, now()))).statusCode).toBe(404);
    });

    it('counts wrong codes in totp:user', async () => {
      const ola = await t.addUser('ola');
      const { secret } = await enable(ola.token);
      const link = await resetLink(ola.id);
      for (let i = 0; i < TOTP_RULE.free; i++)
        expect((await reset(link, '000000')).statusCode).toBe(400);
      expect((await reset(link, totpCode(secret, now()))).statusCode).toBe(429);
    });
  });

  describe('device cookies', () => {
    /**
     * Fails `login:user` for `username` from other IPs until an unknown
     * device must wait the full 15 minutes (an attacker who keeps at it).
     */
    async function floodUsername(username = 'admin') {
      let ip = 0;
      for (;;) {
        ip += 1;
        const response = await login(
          username,
          'wrong password',
          {},
          `127.0.${String(ip >> 8)}.${String(ip & 255)}`,
        );
        if (response.statusCode === 429) {
          const wait = Number(response.headers['retry-after']);
          if (wait >= 15 * 60) break;
          t.clock.now += wait * 1000;
        } else {
          expect(response.statusCode).toBe(401);
        }
      }
      expect(ip).toBeGreaterThan(LOGIN_USER_RULE.free);
      expect((await login(username, PASSWORD)).statusCode).toBe(429);
    }

    async function deviceOf(): Promise<string> {
      const response = await login('admin', PASSWORD);
      expect(response.statusCode).toBe(200);
      return setCookies(response).get(DEVICE_COOKIE) ?? '';
    }

    it('lets a known device past the username limit, but not another user’s device', async () => {
      const device = await deviceOf();
      const ola = await t.addUser('ola');
      const olaDevice = setCookies(await login('ola', PASSWORD)).get(DEVICE_COOKIE) ?? '';
      expect(olaDevice).not.toBe('');
      await floodUsername();
      // Ola's device doesn't help on admin.
      expect((await login('admin', PASSWORD, { [DEVICE_COOKIE]: olaDevice })).statusCode).toBe(429);
      expect((await login('admin', PASSWORD, { [DEVICE_COOKIE]: device })).statusCode).toBe(200);
      expect(ola.id).toBeGreaterThan(1);
    });

    it('lets the owner’s login clear what an attacker built up against the name', async () => {
      const device = await deviceOf();
      await floodUsername();
      // The owner logs in from a known browser…
      expect((await login('admin', PASSWORD, { [DEVICE_COOKIE]: device })).statusCode).toBe(200);
      // …and a new browser is no longer blocked by the earlier failures.
      expect((await login('admin', PASSWORD)).statusCode).toBe(200);
    });

    it('is not set after the password step alone, only after the code', async () => {
      await enable(t.adminToken);
      // Turning 2FA on remembers the browser that did it; nothing else.
      const devices = () => database.db.select().from(trustedDevices).all();
      const before = devices();
      expect(before).toHaveLength(1);
      await passwordStep();
      expect(devices()).toEqual(before);
    });

    it('is kept on logout, and forgotten on logout-all, deactivation and a password change', async () => {
      const device = await deviceOf();
      const known = () => database.db.select().from(trustedDevices).all().length;
      expect(known()).toBe(1);
      await t.send('POST', '/api/v1/auth/logout', { token: t.adminToken });
      expect(known()).toBe(1);

      const session =
        cookieToken(await login('admin', PASSWORD, { [DEVICE_COOKIE]: device })) ?? '';
      const logoutAll = await t.send('POST', '/api/v1/auth/logout-all', { token: session });
      expect(setCookies(logoutAll).get(DEVICE_COOKIE)).toBe('');
      expect(known()).toBe(0);

      await deviceOf();
      const token = cookieToken(await login('admin', PASSWORD, { [DEVICE_COOKIE]: device })) ?? '';
      const change = await t.send('POST', '/api/v1/auth/password', {
        token,
        payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      });
      expect(change.statusCode).toBe(204);
      // Every old device forgotten; this browser gets a new one.
      const rows = database.db.select().from(trustedDevices).all();
      expect(rows).toHaveLength(1);
      expect(setCookies(change).get(DEVICE_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(setCookies(change).get(DEVICE_COOKIE)).not.toBe(device);

      const ola = await t.addUser('ola');
      await login('ola', PASSWORD);
      expect(
        database.db.select().from(trustedDevices).where(eq(trustedDevices.userId, ola.id)).all(),
      ).toHaveLength(1);
      const disable = await t.send('PATCH', `/api/v1/users/${String(ola.id)}`, {
        token: cookieToken(await login('admin', NEW_PASSWORD)) ?? '',
        payload: { disabled: true },
      });
      expect(disable.statusCode).toBe(200);
      expect(
        database.db.select().from(trustedDevices).where(eq(trustedDevices.userId, ola.id)).all(),
      ).toEqual([]);
    });

    it('is forgotten when a reset link is used', async () => {
      const ola = await t.addUser('ola');
      await login('ola', PASSWORD);
      const link = await t.send('POST', `/api/v1/users/${String(ola.id)}/password-reset`, {
        token: t.adminToken,
      });
      const token = tokenOf(createdInviteResponseSchema.parse(link.json()).url);
      const before = database.db
        .select()
        .from(trustedDevices)
        .where(eq(trustedDevices.userId, ola.id))
        .all();
      expect(before).toHaveLength(1);
      await t.send('POST', '/api/v1/auth/password-reset', {
        payload: { token, password: NEW_PASSWORD },
      });
      const after = database.db
        .select()
        .from(trustedDevices)
        .where(eq(trustedDevices.userId, ola.id))
        .all();
      // Only the one the link's browser got now.
      expect(after).toHaveLength(1);
      expect(after[0]?.id).not.toBe(before[0]?.id);
    });

    it('lets the owner’s session change everything while login:user is used up from other IPs', async () => {
      await floodUsername();
      const token = t.adminToken;
      // Set up and turn on 2FA.
      const { secret } = await enable(token);
      // New recovery codes.
      const codes = await t.send('POST', '/api/v1/auth/totp/recovery-codes', {
        token,
        payload: { password: PASSWORD, code: totpCode(secret, now()) },
      });
      expect(codes.statusCode, codes.body).toBe(200);
      nextStep();
      // Turn 2FA off.
      const off = await t.send('POST', '/api/v1/auth/totp/disable', {
        token,
        payload: { password: PASSWORD, code: totpCode(secret, now()) },
      });
      expect(off.statusCode, off.body).toBe(204);
      // Change the password.
      const change = await t.send('POST', '/api/v1/auth/password', {
        token,
        payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      });
      expect(change.statusCode, change.body).toBe(204);
      // Still flooded for an unknown device.
      expect((await login('admin', NEW_PASSWORD)).statusCode).toBe(429);
      // Delete the account (as a second admin, so the last-admin rule doesn't apply).
      const ola = await t.addUser('ola', 'admin');
      await floodUsername('ola');
      const deleted = await t.send('POST', '/api/v1/auth/delete-account', {
        token: ola.token,
        payload: { password: PASSWORD },
      });
      expect(deleted.statusCode, deleted.body).toBe(204);
    });
  });
});
