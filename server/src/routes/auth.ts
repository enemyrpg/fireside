import { randomBytes } from 'node:crypto';
import {
  changePasswordRequestSchema,
  deleteAccountRequestSchema,
  loginRequestSchema,
  loginTotpRequestSchema,
  totpConfirmRequestSchema,
  totpEnableRequestSchema,
  totpSetupRequestSchema,
  type AuthMeResponse,
  type AuthUser,
  type LoginResponse,
  type RecoveryCodesResponse,
  type TotpSetupResponse,
  type TwoFactorStatusResponse,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { audit, userTarget } from '../audit/audit.js';
import { systemClock, type Clock } from '../auth/api-keys.js';
import {
  clearDeviceCookie,
  clearMfaCookie,
  clearSessionCookie,
  DEVICE_COOKIE,
  MFA_COOKIE,
  readCookie,
  readSessionToken,
  setDeviceCookie,
  setMfaCookie,
  setSessionCookie,
} from '../auth/cookie.js';
import { deleteUserDevices, isKnownDevice, rememberDevice } from '../auth/devices.js';
import { AuthLimiters, type AllowedAttempt, type Attempt } from '../auth/login-limiter.js';
import { MfaChallenges } from '../auth/mfa-challenges.js';
import { createSecretBox, memoryKeyStore, type SecretBox } from '../auth/secret-box.js';
import {
  createSession,
  deleteExpiredSessions,
  deleteSessionByToken,
  deleteUserSessions,
} from '../auth/sessions.js';
import type { Queryable } from '../db/index.js';
import { users, type UserRow } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { logSecurityEvent } from '../auth/security-log.js';
import {
  checkNewPassword,
  createPasswordHasher,
  HasherBusyError,
  InvalidPasswordError,
  needsRehash,
  type PasswordHasher,
} from '../users/password.js';
import {
  disableTwoFactor,
  enableTwoFactor,
  NoPendingSetupError,
  recoveryCodesLeft,
  replaceRecoveryCodes,
  startSetup,
  TwoFactorAlreadyOnError,
  twoFactorEnabled,
  useSecondFactor,
  type SecondFactorResult,
} from '../users/two-factor.js';
import { usernameKey } from '../users/username.js';
import { deleteUser, LastAdminError } from '../users/delete-user.js';
import { findUserById, findUserByUsername, localUserId, setPasswordHash } from '../users/users.js';
import { jsonBodiesOnly } from './json-body.js';
import { parseRequest } from './parse.js';
import { PUBLIC_ROUTE, USER_ROUTE } from '../auth/dashboard-auth.js';
import { requestUser } from './account-scope.js';

// `/api/v1/auth/*`. Registered in the dashboard scope, so the network check and
// the session hook (auth/dashboard-auth.ts) run first. Passwords, tokens, 2FA
// secrets and codes, and typed usernames are never logged.
//
// Limits (auth/login-limiter.ts): a login counts per IP and, from a device
// without a valid device cookie for that user, per username. A password
// check with a session (password change, deleting the account, 2FA
// settings) counts per IP and per user ID (`reauth:user`), never per
// username, so a stranger flooding the name can't block the owner. 2FA codes
// count per user (`totp:user`), and at login per IP too.

export interface AuthRoutesOptions {
  now?: Clock;
  /** Replaced in tests to count or slow down hashing. */
  hasher?: PasswordHasher;
  /** Shared with the invite routes (made in routes/dashboard.ts). Tests pass their own. */
  limiters?: AuthLimiters;
  /** Encrypts 2FA secrets. Set by routes/dashboard.ts from the key store. */
  secretBox?: SecretBox;
  /** The 2FA step between password and code. Tests pass their own. */
  challenges?: MfaChallenges;
}

const INVALID_LOGIN = 'Invalid username or password';
const INVALID_CODE = 'Invalid code';
const LOGIN_TIMED_OUT = 'Your login timed out. Enter your password again.';
const LOCAL_MODE = 'Login is off: this server runs in local mode';

/**
 * The user as the dashboard sees them. In local mode `can_create_api_keys`
 * isn't enforced, so it is always `true` there.
 */
export function toAuthUser(
  user: Pick<UserRow, 'id' | 'username' | 'role' | 'canCreateApiKeys' | 'totpEnabledAt'>,
  mode: 'local' | 'login',
): AuthUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    canCreateApiKeys: mode === 'local' || user.canCreateApiKeys,
    twoFactorEnabled: twoFactorEnabled(user),
  };
}

/**
 * `429` with `Retry-After` for a blocked attempt; the attempt otherwise.
 * `what` names the attempts in the message ("Too many login attempts. …").
 */
export function allowed(
  attempt: Attempt,
  request: FastifyRequest,
  reply: FastifyReply,
  what = 'login attempts',
): AllowedAttempt {
  if (attempt.status === 'blocked') {
    const seconds = String(attempt.retryAfterSeconds);
    void reply.header('retry-after', seconds);
    // The client's IP is logged once per block, as for ingest: a flood of
    // refused attempts can't fill the log. A new failure after the wait starts
    // a new block, which is logged again.
    if (attempt.firstRefusal) {
      logSecurityEvent(request, 'rate_limited', 'Refused: too many attempts', {
        retryAfterSeconds: attempt.retryAfterSeconds,
      });
    } else {
      request.log.debug({}, 'Refused: too many attempts');
    }
    throw new ApiError(429, 'RATE_LIMITED', `Too many ${what}. Try again in ${seconds} seconds.`);
  }
  return attempt;
}

/**
 * Runs a password check that `attempt` was started for. When the hasher's
 * queue is full (`HasherBusyError`, answered `503`), nothing was checked, so
 * the attempt is taken back: a flood that fills the queue never counts
 * against the IP or the username of someone it held up.
 */
export async function checking(
  attempt: AllowedAttempt,
  check: () => Promise<boolean>,
): Promise<boolean> {
  let ok = false;
  try {
    ok = await check();
  } catch (error) {
    if (error instanceof HasherBusyError) attempt.finish(true);
    throw error;
  } finally {
    attempt.finish(ok);
  }
  return ok;
}

export function fieldError(path: string, message: string): ApiError {
  return new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [{ path, message }]);
}

function passwordError(error: unknown, path: string): never {
  if (error instanceof InvalidPasswordError) throw fieldError(path, error.message);
  throw error;
}

/** Logs a code check that failed because the secret can't be decrypted (key file). */
export function logSecondFactor(
  request: FastifyRequest,
  userId: number,
  result: SecondFactorResult,
): void {
  if (!result.ok && result.reason === 'undecryptable') {
    request.log.error(
      { userId },
      'The 2FA secret could not be decrypted: is the key file missing or wrong? ' +
        'The operator can turn 2FA off with: pnpm cli users reset-2fa <name>',
    );
  }
}

export const authRoutes: FastifyPluginCallback<AuthRoutesOptions> = (app, options, done) => {
  const now = options.now ?? systemClock;
  const hasher = options.hasher ?? createPasswordHasher();
  const limiters = options.limiters ?? new AuthLimiters({ now });
  const box = options.secretBox ?? createSecretBox(memoryKeyStore());
  const challenges = options.challenges ?? new MfaChallenges();

  // Unknown users are checked against this, so every failed login costs one
  // argon2 verify and takes about as long. Made once, on first use.
  let dummyHash: Promise<string> | undefined;
  const getDummyHash = () =>
    (dummyHash ??= hasher.hash(randomBytes(32).toString('base64')).catch((error: unknown) => {
      // Not kept: a full queue now must not fail every later login.
      dummyHash = undefined;
      throw error;
    }));

  jsonBodiesOnly(app);

  const startSession = (request: FastifyRequest, userId: number) => {
    const at = now();
    deleteExpiredSessions(app.db, at);
    const session = createSession(app.db, userId, {
      now: at,
      userAgent: request.headers['user-agent'],
    });
    return session;
  };

  /** The session's user in login mode; `409` in local mode (2FA needs login). */
  const sessionUser = (request: FastifyRequest): UserRow => {
    if (request.authMode === 'local') throw new ApiError(409, 'CONFLICT', LOCAL_MODE);
    const session = request.session;
    if (!session) throw new ApiError(401, 'UNAUTHORIZED', 'Log in to continue');
    return session.user;
  };

  /** Checks the password of a logged-in user (`reauth:user`). `400` on `path` if wrong. */
  const checkPassword = async (
    request: FastifyRequest,
    reply: FastifyReply,
    user: UserRow,
    password: string,
    path: string,
  ): Promise<void> => {
    const attempt = allowed(limiters.reauthenticate(request.clientIp, user.id), request, reply);
    const ok = await checking(attempt, () => hasher.verify(password, user.passwordHash ?? ''));
    // 400, not 401: the session is fine, only the field is wrong.
    if (!ok) {
      logSecurityEvent(request, 'reauth_failed', 'Wrong password', { userId: user.id });
      throw fieldError(path, 'Wrong password');
    }
  };

  /**
   * Checks and uses up a 2FA or recovery code of a logged-in user
   * (`totp:user`), running `then` in the same transaction. `400` on
   * `body.code` if wrong.
   */
  const withCode = <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    user: UserRow,
    code: string,
    then: (tx: Parameters<Parameters<typeof app.db.transaction>[0]>[0]) => T,
  ): T => {
    const attempt = allowed(limiters.totpCode(user.id), request, reply);
    const at = now();
    let result: SecondFactorResult = { ok: false, reason: 'wrong' };
    try {
      return app.db.transaction(
        (tx) => {
          result = useSecondFactor(tx, box, user, code, at);
          if (!result.ok) {
            logSecurityEvent(request, 'code_failed', 'Wrong 2FA code', { userId: user.id });
            throw fieldError('body.code', 'Wrong code');
          }
          if (result.method === 'recovery_code') {
            audit(tx, {
              actorUserId: user.id,
              action: 'auth.recovery_code_use',
              target: userTarget(user.id),
              now: at,
            });
          }
          return then(tx);
        },
        { behavior: 'immediate' },
      );
    } finally {
      logSecondFactor(request, user.id, result);
      attempt.finish(result.ok);
    }
  };

  /**
   * After turning 2FA on or making new recovery codes, in the same transaction:
   * ends every other session of the user and forgets every device, as a
   * password change does, so a stolen session or device cookie doesn't outlive
   * it. This session is kept. Returns a new device token for this browser.
   */
  const endOtherLogins = (
    tx: Queryable,
    request: FastifyRequest,
    userId: number,
    at: Date,
  ): string => {
    deleteUserSessions(tx, userId, request.session?.id);
    deleteUserDevices(tx, userId);
    return rememberDevice(tx, userId, undefined, at);
  };

  /** A full login: new session, device cookie, audit. */
  const completeLogin = (request: FastifyRequest, reply: FastifyReply, user: UserRow) => {
    // A new token every time; the one the browser had (if any) ends here.
    const old = readSessionToken(request);
    if (old !== undefined) deleteSessionByToken(app.db, old);
    const session = startSession(request, user.id);
    const at = now();
    app.db.update(users).set({ lastLoginAt: at.toISOString() }).where(eq(users.id, user.id)).run();
    const device = rememberDevice(app.db, user.id, readCookie(request, DEVICE_COOKIE), at);
    audit(app.db, {
      actorUserId: user.id,
      action: 'auth.login',
      target: userTarget(user.id),
      now: at,
    });
    // The owner is in: what an attacker built up against the name is forgotten.
    limiters.loginSucceeded(usernameKey(user.username));
    request.log.info({ userId: user.id }, 'Logged in');
    setSessionCookie(reply, session.token);
    setDeviceCookie(reply, device);
  };

  app.get('/auth/me', PUBLIC_ROUTE, (request): AuthMeResponse => {
    if (request.authMode === 'local') {
      const user = findUserById(app.db, localUserId(app.db));
      return { mode: 'local', user: user ? toAuthUser(user, 'local') : null };
    }
    return {
      mode: 'login',
      user: request.session ? toAuthUser(request.session.user, 'login') : null,
    };
  });

  app.post('/auth/login', PUBLIC_ROUTE, async (request, reply) => {
    const { username, password } = parseRequest(loginRequestSchema, request.body, 'body');
    if (request.authMode === 'local') throw new ApiError(409, 'CONFLICT', LOCAL_MODE);

    const user = findUserByUsername(app.db, username);
    // A valid device cookie of this very user skips the per-username limit.
    const knownDevice = isKnownDevice(app.db, readCookie(request, DEVICE_COOKIE), user?.id, now());
    const attempt = allowed(
      limiters.login(request.clientIp, usernameKey(username), { knownDevice }),
      request,
      reply,
    );

    const usable = user?.disabledAt === null && user.passwordHash !== null;
    let stored = '';
    const ok = await checking(attempt, async () => {
      stored = usable ? (user.passwordHash ?? '') : await getDummyHash();
      return (await hasher.verify(password, stored)) && usable;
    });
    if (!ok || !user) {
      logSecurityEvent(request, 'login_failed', 'Login failed');
      throw new ApiError(401, 'UNAUTHORIZED', INVALID_LOGIN);
    }

    // Parameters were raised since this hash was made: store a new one.
    let currentHash = stored;
    if (needsRehash(stored)) {
      try {
        currentHash = await hasher.hash(password);
        app.db.update(users).set({ passwordHash: currentHash }).where(eq(users.id, user.id)).run();
      } catch (error) {
        // A full queue never fails a login whose password was right: the
        // hash is renewed at the next login instead.
        if (!(error instanceof HasherBusyError)) throw error;
      }
    }

    if (twoFactorEnabled(user)) {
      // Only after a correct password: no session until the code. The step is
      // tied to this password hash, so a password change ends it.
      challenges.delete(readCookie(request, MFA_COOKIE));
      setMfaCookie(reply, challenges.create(user.id, currentHash, now()));
      request.log.info({ userId: user.id }, 'Password accepted, waiting for the 2FA code');
      const body: LoginResponse = { twoFactorRequired: true };
      return body;
    }

    completeLogin(request, reply, user);
    const body: LoginResponse = { user: toAuthUser(user, 'login') };
    return body;
  });

  app.post('/auth/login/totp', PUBLIC_ROUTE, (request, reply) => {
    const { code } = parseRequest(loginTotpRequestSchema, request.body, 'body');
    if (request.authMode === 'local') throw new ApiError(409, 'CONFLICT', LOCAL_MODE);
    const token = readCookie(request, MFA_COOKIE);
    const at = now();
    const timedOut = () => {
      challenges.delete(token);
      clearMfaCookie(reply);
      return new ApiError(401, 'UNAUTHORIZED', LOGIN_TIMED_OUT);
    };
    const challenge = challenges.peek(token, at);
    const user = challenge ? findUserById(app.db, challenge.userId) : undefined;
    // Disabled, password removed or changed (also by a reset link or the
    // CLI), or 2FA turned off since the password was checked: start over.
    if (
      !challenge ||
      user?.disabledAt !== null ||
      user.passwordHash !== challenge.passwordHash ||
      !twoFactorEnabled(user)
    ) {
      throw timedOut();
    }
    // The limits first: a refused attempt costs no try of the challenge.
    const attempt = allowed(limiters.totpLogin(request.clientIp, user.id), request, reply);
    if (!challenges.takeTry(token, at)) {
      attempt.finish(true);
      throw timedOut();
    }
    let result: SecondFactorResult = { ok: false, reason: 'wrong' };
    try {
      result = app.db.transaction((tx) => useSecondFactor(tx, box, user, code, at), {
        behavior: 'immediate',
      });
    } finally {
      logSecondFactor(request, user.id, result);
      attempt.finish(result.ok);
    }
    if (!result.ok) {
      logSecurityEvent(request, 'code_failed', 'Login failed: wrong 2FA code', {
        userId: user.id,
      });
      throw new ApiError(401, 'UNAUTHORIZED', INVALID_CODE);
    }
    if (result.method === 'recovery_code') {
      audit(app.db, {
        actorUserId: user.id,
        action: 'auth.recovery_code_use',
        target: userTarget(user.id),
        now: at,
      });
    }
    challenges.delete(token);
    completeLogin(request, reply, user);
    clearMfaCookie(reply);
    const body: LoginResponse = { user: toAuthUser(user, 'login') };
    return body;
  });

  // --- 2FA settings (Settings → Profile) ------------------------------------

  app.get('/auth/totp', USER_ROUTE, (request): TwoFactorStatusResponse => {
    const user = findUserById(app.db, requestUser(request).id);
    const enabled = user !== undefined && twoFactorEnabled(user);
    return {
      enabled,
      enabledAt: enabled ? (user.totpEnabledAt ?? null) : null,
      recoveryCodesLeft: enabled ? recoveryCodesLeft(app.db, user.id) : 0,
    };
  });

  app.post('/auth/totp/setup', USER_ROUTE, async (request, reply) => {
    const { password } = parseRequest(totpSetupRequestSchema, request.body, 'body');
    const user = sessionUser(request);
    if (twoFactorEnabled(user))
      throw new ApiError(409, 'CONFLICT', new TwoFactorAlreadyOnError().message);
    await checkPassword(request, reply, user, password, 'body.password');
    const fresh = findUserById(app.db, user.id) ?? user;
    try {
      const setup: TotpSetupResponse = startSetup(app.db, box, fresh, now());
      return setup;
    } catch (error) {
      if (error instanceof TwoFactorAlreadyOnError) {
        throw new ApiError(409, 'CONFLICT', error.message);
      }
      throw error;
    }
  });

  app.post('/auth/totp/enable', USER_ROUTE, (request, reply) => {
    const { code } = parseRequest(totpEnableRequestSchema, request.body, 'body');
    const sessionRow = sessionUser(request);
    const user = findUserById(app.db, sessionRow.id) ?? sessionRow;
    const attempt = allowed(limiters.totpCode(user.id), request, reply);
    const at = now();
    let codes: string[] | undefined;
    let device: string | undefined;
    try {
      codes = app.db.transaction(
        (tx) => {
          const made = enableTwoFactor(tx, box, user, code, at);
          // Only when it was turned on: a wrong code ends nothing.
          if (made) device = endOtherLogins(tx, request, user.id, at);
          return made;
        },
        { behavior: 'immediate' },
      );
    } catch (error) {
      attempt.finish(false);
      if (error instanceof TwoFactorAlreadyOnError || error instanceof NoPendingSetupError) {
        throw new ApiError(409, 'CONFLICT', error.message);
      }
      throw error;
    }
    attempt.finish(codes !== undefined);
    if (!codes) {
      logSecurityEvent(request, 'code_failed', 'Wrong 2FA code', { userId: user.id });
      throw fieldError('body.code', 'Wrong code. Check the time on your phone.');
    }
    audit(app.db, {
      actorUserId: user.id,
      action: 'auth.totp_enable',
      target: userTarget(user.id),
      now: at,
    });
    request.log.info({ userId: user.id }, 'Two-factor authentication turned on');
    if (device !== undefined) setDeviceCookie(reply, device);
    const body: RecoveryCodesResponse = { recoveryCodes: codes };
    return body;
  });

  app.post('/auth/totp/disable', USER_ROUTE, async (request, reply) => {
    const { password, code } = parseRequest(totpConfirmRequestSchema, request.body, 'body');
    const user = sessionUser(request);
    if (!twoFactorEnabled(user))
      throw new ApiError(409, 'CONFLICT', 'Two-factor authentication is off');
    await checkPassword(request, reply, user, password, 'body.password');
    const at = now();
    withCode(request, reply, user, code, (tx) => {
      disableTwoFactor(tx, user.id);
      audit(tx, {
        actorUserId: user.id,
        action: 'auth.totp_disable',
        target: userTarget(user.id),
        now: at,
      });
    });
    request.log.info({ userId: user.id }, 'Two-factor authentication turned off');
    return reply.code(204).send();
  });

  app.post('/auth/totp/recovery-codes', USER_ROUTE, async (request, reply) => {
    const { password, code } = parseRequest(totpConfirmRequestSchema, request.body, 'body');
    const user = sessionUser(request);
    if (!twoFactorEnabled(user))
      throw new ApiError(409, 'CONFLICT', 'Two-factor authentication is off');
    await checkPassword(request, reply, user, password, 'body.password');
    const at = now();
    const { codes, device } = withCode(request, reply, user, code, (tx) => {
      const fresh = replaceRecoveryCodes(tx, box, user.id, at);
      audit(tx, {
        actorUserId: user.id,
        action: 'auth.recovery_codes_regenerate',
        target: userTarget(user.id),
        now: at,
      });
      return { codes: fresh, device: endOtherLogins(tx, request, user.id, at) };
    });
    request.log.info({ userId: user.id }, 'New recovery codes made');
    setDeviceCookie(reply, device);
    const body: RecoveryCodesResponse = { recoveryCodes: codes };
    return body;
  });

  app.post('/auth/logout', PUBLIC_ROUTE, (request, reply) => {
    const token = readSessionToken(request);
    if (token !== undefined) deleteSessionByToken(app.db, token);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.post('/auth/logout-all', USER_ROUTE, (request, reply) => {
    if (!request.session) {
      throw new ApiError(409, 'CONFLICT', LOCAL_MODE);
    }
    const { user } = request.session;
    deleteUserSessions(app.db, user.id);
    // Every browser is unknown again.
    deleteUserDevices(app.db, user.id);
    audit(app.db, {
      actorUserId: user.id,
      action: 'auth.logout_all',
      target: userTarget(user.id),
      now: now(),
    });
    request.log.info({ userId: user.id }, 'Logged out everywhere');
    clearSessionCookie(reply);
    clearDeviceCookie(reply);
    return reply.code(204).send();
  });

  app.post('/auth/password', USER_ROUTE, async (request, reply) => {
    const { currentPassword, newPassword } = parseRequest(
      changePasswordRequestSchema,
      request.body,
      'body',
    );
    let checked: string;
    try {
      checked = checkNewPassword(newPassword);
    } catch (error) {
      passwordError(error, 'body.newPassword');
    }

    let userId: number;
    if (request.authMode === 'local') {
      // Setting the first password turns login on.
      if (currentPassword !== undefined) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
          { path: 'body.currentPassword', message: 'No password is set yet' },
        ]);
      }
      userId = localUserId(app.db);
    } else {
      const session = request.session;
      if (!session) throw new ApiError(401, 'UNAUTHORIZED', 'Log in to continue');
      if (currentPassword === undefined) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
          { path: 'body.currentPassword', message: 'Enter your current password' },
        ]);
      }
      await checkPassword(request, reply, session.user, currentPassword, 'body.currentPassword');
      userId = session.user.id;
    }

    const hash = await hasher.hash(checked);
    const at = now();
    // Ends every session of the user, this one included, and forgets their
    // devices; a new session and device cookie follow for this browser.
    setPasswordHash(app.db, userId, hash);
    deleteUserSessions(app.db, userId);
    const session = startSession(request, userId);
    const device = rememberDevice(app.db, userId, undefined, at);
    audit(app.db, {
      actorUserId: userId,
      action: request.authMode === 'local' ? 'user.set_password' : 'auth.password_change',
      target: userTarget(userId),
      now: at,
    });
    request.log.info({ userId }, 'Password changed');
    setSessionCookie(reply, session.token);
    setDeviceCookie(reply, device);
    return reply.code(204).send();
  });

  // The user deletes themselves and all their data, after confirming their
  // password. Login mode only: in local mode the only user is the last admin,
  // who can never be deleted.
  app.post('/auth/delete-account', USER_ROUTE, async (request, reply) => {
    const { password } = parseRequest(deleteAccountRequestSchema, request.body, 'body');
    const session = request.session;
    if (!session) {
      throw new ApiError(409, 'CONFLICT', LOCAL_MODE);
    }
    await checkPassword(request, reply, session.user, password, 'body.password');
    const userId = session.user.id;
    try {
      const result = deleteUser(app.db, userId, { actorUserId: userId, now: now() });
      request.log.info(
        { userId, accounts: result.accounts, events: result.events },
        'User deleted themselves',
      );
    } catch (error) {
      if (error instanceof LastAdminError) throw new ApiError(409, 'CONFLICT', error.message);
      throw error;
    }
    clearSessionCookie(reply);
    clearDeviceCookie(reply);
    return reply.code(204).send();
  });

  done();
};
