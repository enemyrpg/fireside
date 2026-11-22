import {
  acceptInviteRequestSchema,
  createInviteRequestSchema,
  DEFAULT_INVITE_DURATION_DAYS,
  inviteLookupRequestSchema,
  inviteParamsSchema,
  passwordResetRequestSchema,
  type AcceptInviteResponse,
  type CreatedInviteResponse,
  type InviteLookupResponse,
  type InvitesResponse,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { audit, inviteTarget, userTarget } from '../audit/audit.js';
import { systemClock, type Clock } from '../auth/api-keys.js';
import {
  DEVICE_COOKIE,
  readCookie,
  readSessionToken,
  setDeviceCookie,
  setSessionCookie,
} from '../auth/cookie.js';
import { ADMIN_ROUTE, PUBLIC_ROUTE } from '../auth/dashboard-auth.js';
import { rememberDevice } from '../auth/devices.js';
import { AuthLimiters, type AllowedAttempt } from '../auth/login-limiter.js';
import { createSecretBox, memoryKeyStore, type SecretBox } from '../auth/secret-box.js';
import { createSession, deleteExpiredSessions, deleteSessionByToken } from '../auth/sessions.js';
import { invites, users } from '../db/schema.js';
import { ApiError } from '../errors.js';
import {
  assertRoomForUser,
  consumeInvite,
  createInvite,
  findActiveInvite,
  InvalidLabelError,
  inviteUrl,
  listInvites,
  normalizeLabel,
  revokeInvite,
  toApiInvite,
  TooManyInvitesError,
  UserLimitError,
  usernamesById,
  type IdSource,
} from '../users/invites.js';
import {
  checkNewPassword,
  createPasswordHasher,
  InvalidPasswordError,
  type PasswordHasher,
} from '../users/password.js';
import { twoFactorEnabled, useSecondFactor, type SecondFactorResult } from '../users/two-factor.js';
import { InvalidUsernameError, normalizeUsername, usernameKey } from '../users/username.js';
import {
  createUser,
  findUserById,
  findUserByUsername,
  setPasswordHash,
  UsernameTakenError,
} from '../users/users.js';
import { requestUser } from './account-scope.js';
import { logSecurityEvent } from '../auth/security-log.js';
import { allowed, fieldError, logSecondFactor, toAuthUser } from './auth.js';
import { jsonBodiesOnly } from './json-body.js';
import { parseRequest } from './parse.js';
import { linkOrigin, requireLoginMode } from './users.js';

// Invites and password reset links. Admin routes list, create and revoke them.
// The public routes under `/auth/*` take the token from a JSON body: the link
// carries it in the fragment, so it is never in a request line or the access
// log. The token is never logged or audited, and every invalid link (used,
// expired, revoked, unknown, another type, local mode) gets the same `404`.

export interface InviteRoutesOptions extends IdSource {
  now?: Clock;
  /** Replaced in tests to count or slow down hashing. */
  hasher?: PasswordHasher;
  /**
   * `invite:ip` for lookups and attempts, and `totp:user` for the code on a
   * reset link. Shared with the auth routes (routes/dashboard.ts).
   */
  limiters?: AuthLimiters;
  /** Opens 2FA secrets for the code on a reset link. */
  secretBox?: SecretBox;
  /** `MAX_USERS`, or `null` for no limit. */
  maxUsers?: number | null;
  /** `PUBLIC_URL`'s origin, used in links. */
  publicUrl?: string | null;
}

export const INVALID_LINK = 'This invite link is no longer valid';
const INVITE_NOT_FOUND = 'Invite not found';

/** `404` for a link that can't be used, logged with the client's IP. */
function invalidLink(request: FastifyRequest): ApiError {
  logSecurityEvent(request, 'link_rejected', 'Invite or reset link rejected');
  return new ApiError(404, 'NOT_FOUND', INVALID_LINK);
}

const CODE_NEEDED = 'Enter a code from your authenticator app, or a recovery code';

function checkedPassword(password: string): string {
  try {
    return checkNewPassword(password);
  } catch (error) {
    if (error instanceof InvalidPasswordError) throw fieldError('body.password', error.message);
    throw error;
  }
}

export const inviteRoutes: FastifyPluginCallback<InviteRoutesOptions> = (app, options, done) => {
  const now = options.now ?? systemClock;
  const hasher = options.hasher ?? createPasswordHasher();
  const limiters = options.limiters ?? new AuthLimiters({ now });
  const box = options.secretBox ?? createSecretBox(memoryKeyStore());
  const maxUsers = options.maxUsers ?? null;
  const ids: IdSource = options.generateId ? { generateId: options.generateId } : {};

  jsonBodiesOnly(app);

  /** Per-IP limit for the public routes. Every attempt is counted until `finish`. */
  const begin = (request: FastifyRequest, reply: FastifyReply): AllowedAttempt =>
    allowed(limiters.invite(request.clientIp), request, reply, 'attempts');

  /**
   * Starts a session for `userId` in this browser, ending the one it had,
   * and remembers the browser as a known device.
   */
  const logIn = (request: FastifyRequest, reply: FastifyReply, userId: number, at: Date) => {
    const old = readSessionToken(request);
    if (old !== undefined) deleteSessionByToken(app.db, old);
    deleteExpiredSessions(app.db, at);
    const session = createSession(app.db, userId, {
      now: at,
      userAgent: request.headers['user-agent'],
    });
    app.db.update(users).set({ lastLoginAt: at.toISOString() }).where(eq(users.id, userId)).run();
    const device = rememberDevice(app.db, userId, readCookie(request, DEVICE_COOKIE), at);
    // A full login of the owner: forget failures counted against the name.
    const username = findUserById(app.db, userId)?.username;
    if (username !== undefined) limiters.loginSucceeded(usernameKey(username));
    setSessionCookie(reply, session.token);
    setDeviceCookie(reply, device);
  };

  // --- Admin --------------------------------------------------------------

  app.get('/invites', ADMIN_ROUTE, (): InvitesResponse => ({
    invites: listInvites(app.db, now()),
  }));

  app.post('/invites', ADMIN_ROUTE, (request, reply): CreatedInviteResponse => {
    const body = parseRequest(createInviteRequestSchema, request.body, 'body');
    requireLoginMode(request);
    let label: string | null;
    try {
      label = normalizeLabel(body.label);
    } catch (error) {
      if (error instanceof InvalidLabelError) throw fieldError('body.label', error.message);
      throw error;
    }
    const actor = requestUser(request);
    const at = now();
    let created;
    try {
      created = createInvite(app.db, {
        createdBy: actor.id,
        label,
        role: body.role,
        canCreateApiKeys: body.canCreateApiKeys,
        days: body.days ?? DEFAULT_INVITE_DURATION_DAYS,
        maxUsers,
        now: at,
        ...ids,
      });
    } catch (error) {
      if (error instanceof TooManyInvitesError || error instanceof UserLimitError) {
        throw new ApiError(409, 'CONFLICT', error.message);
      }
      throw error;
    }
    const { row, token } = created;
    audit(app.db, {
      actorUserId: actor.id,
      action: 'invite.create',
      target: inviteTarget(row.id),
      now: at,
    });
    request.log.info({ inviteId: row.id }, 'Invite created');
    const { origin, localOnly } = linkOrigin(request, options.publicUrl);
    void reply.code(201);
    return {
      invite: toApiInvite(row, usernamesById(app.db), at),
      url: inviteUrl(origin, 'invite', token),
      localOnly,
    };
  });

  app.delete('/invites/:id', ADMIN_ROUTE, (request, reply) => {
    const { id } = parseRequest(inviteParamsSchema, request.params, 'params');
    const actor = requestUser(request);
    const at = now();
    const result = revokeInvite(app.db, id, actor.id, at);
    if (result.status === 'not_found') throw new ApiError(404, 'NOT_FOUND', INVITE_NOT_FOUND);
    if (result.status === 'revoked') {
      const reset = result.row.type === 'password_reset';
      audit(app.db, {
        actorUserId: actor.id,
        action: reset ? 'password_reset.revoke' : 'invite.revoke',
        target:
          reset && result.row.targetUserId !== null
            ? userTarget(result.row.targetUserId)
            : inviteTarget(id),
        now: at,
      });
      request.log.info({ inviteId: id }, 'Invite revoked');
    }
    return reply.code(204).send();
  });

  // --- Public: the invite and reset pages ---------------------------------

  app.post('/auth/invite/lookup', PUBLIC_ROUTE, (request, reply): InviteLookupResponse => {
    const { token } = parseRequest(inviteLookupRequestSchema, request.body, 'body');
    const attempt = begin(request, reply);
    const row =
      request.authMode === 'login' ? findActiveInvite(app.db, token, undefined, now()) : undefined;
    attempt.finish(row !== undefined);
    if (!row) throw invalidLink(request);
    if (row.type === 'invite') return { type: 'invite' };
    const target = findUserById(app.db, row.targetUserId ?? 0);
    if (!target) throw invalidLink(request);
    // Only whoever holds the link learns whether a code is needed.
    return {
      type: 'password_reset',
      username: target.username,
      twoFactorRequired: twoFactorEnabled(target),
    };
  });

  app.post('/auth/invite/accept', PUBLIC_ROUTE, async (request, reply) => {
    const body = parseRequest(acceptInviteRequestSchema, request.body, 'body');
    const attempt = begin(request, reply);
    const valid =
      request.authMode === 'login' &&
      findActiveInvite(app.db, body.token, 'invite', now()) !== undefined;
    if (!valid) {
      attempt.finish(false);
      throw invalidLink(request);
    }

    // Typing mistakes are not failures: the link was right. A taken username
    // is: it tells whoever holds a link that the user exists, so trying names
    // over and over is limited like guessing links. The attempt stays open
    // until the end, so a name taken by a concurrent accept (found in the
    // transaction) counts too.
    let taken = false;
    try {
      let username: string;
      try {
        username = normalizeUsername(body.username);
      } catch (error) {
        if (error instanceof InvalidUsernameError) throw fieldError('body.username', error.message);
        throw error;
      }
      const password = checkedPassword(body.password);
      // Checked again in the transaction; this only saves a hash.
      if (findUserByUsername(app.db, username)) {
        taken = true;
        throw fieldError('body.username', new UsernameTakenError().message);
      }
      const passwordHash = await hasher.hash(password);

      // Marking the link used and creating the user happen together: of two
      // concurrent attempts only one gets the row from `consumeInvite`.
      const at = now();
      const user = app.db.transaction(
        (tx) => {
          const row = consumeInvite(tx, body.token, 'invite', at);
          if (!row) throw invalidLink(request);
          try {
            assertRoomForUser(tx, maxUsers);
          } catch (error) {
            if (error instanceof UserLimitError) {
              throw new ApiError(409, 'CONFLICT', `${error.message}. Ask the admin.`);
            }
            throw error;
          }
          let userId: number;
          try {
            userId = createUser(tx, username, {
              role: row.role ?? 'member',
              canCreateApiKeys: row.canCreateApiKeys ?? false,
              passwordHash,
              now: at,
            });
          } catch (error) {
            if (error instanceof UsernameTakenError) {
              taken = true;
              throw fieldError('body.username', error.message);
            }
            throw error;
          }
          tx.update(invites).set({ usedBy: userId }).where(eq(invites.id, row.id)).run();
          audit(tx, {
            actorUserId: userId,
            action: 'invite.use',
            target: inviteTarget(row.id),
            now: at,
          });
          audit(tx, {
            actorUserId: userId,
            action: 'user.create',
            target: userTarget(userId),
            now: at,
          });
          request.log.info({ inviteId: row.id, userId }, 'Invite used');
          const created = findUserById(tx, userId);
          if (!created) throw new Error('User missing after insert');
          return created;
        },
        { behavior: 'immediate' },
      );

      logIn(request, reply, user.id, at);
      void reply.code(201);
      const response: AcceptInviteResponse = {
        user: toAuthUser(user, 'login'),
      };
      return response;
    } finally {
      attempt.finish(!taken);
    }
  });

  // A reset link keeps 2FA: a user with 2FA must also give a code. A missing or
  // wrong code counts in `invite:ip` and `totp:user`, and the link stays
  // unused, so turning 2FA off takes a separate, audited `user.totp_reset` by
  // an admin.
  app.post('/auth/password-reset', PUBLIC_ROUTE, async (request, reply) => {
    const body = parseRequest(passwordResetRequestSchema, request.body, 'body');
    const attempt = begin(request, reply);
    const row =
      request.authMode === 'login'
        ? findActiveInvite(app.db, body.token, 'password_reset', now())
        : undefined;
    const found = row ? findUserById(app.db, row.targetUserId ?? 0) : undefined;
    if (!row || found?.disabledAt !== null) {
      attempt.finish(false);
      throw invalidLink(request);
    }
    let codeAttempt: AllowedAttempt | undefined;
    try {
      if (twoFactorEnabled(found))
        codeAttempt = allowed(limiters.totpCode(found.id), request, reply);
    } catch (error) {
      attempt.finish(true);
      throw error;
    }

    let codeFailed = false;
    let result: SecondFactorResult | undefined;
    let userId: number;
    try {
      const password = checkedPassword(body.password);
      const code = body.code?.trim() ?? '';
      if (codeAttempt && code === '') {
        codeFailed = true;
        throw fieldError('body.code', CODE_NEEDED);
      }
      const passwordHash = await hasher.hash(password);
      const at = now();
      userId = app.db.transaction(
        (tx) => {
          const used = consumeInvite(tx, body.token, 'password_reset', at);
          const target = used ? findUserById(tx, used.targetUserId ?? 0) : undefined;
          // The user may have been disabled while the password was hashed.
          if (!used || target?.disabledAt !== null) throw invalidLink(request);
          // Checked on the row as it is now; rolled back with the link if wrong.
          if (twoFactorEnabled(target)) {
            if (code === '') {
              codeFailed = true;
              throw fieldError('body.code', CODE_NEEDED);
            }
            result = useSecondFactor(tx, box, target, code, at);
            if (!result.ok) {
              codeFailed = true;
              throw fieldError('body.code', 'Wrong code');
            }
            if (result.method === 'recovery_code') {
              audit(tx, {
                actorUserId: target.id,
                action: 'auth.recovery_code_use',
                target: userTarget(target.id),
                now: at,
              });
            }
          }
          tx.update(invites).set({ usedBy: target.id }).where(eq(invites.id, used.id)).run();
          // Ends every session of the user and forgets their devices.
          setPasswordHash(tx, target.id, passwordHash);
          // Whoever holds the link acts as the user; the admin who made it
          // shows in `password_reset.create`. The default instance text
          // (settings/instance-text.ts) tells users so.
          audit(tx, {
            actorUserId: target.id,
            action: 'password_reset.use',
            target: userTarget(target.id),
            now: at,
          });
          request.log.info({ inviteId: used.id, userId: target.id }, 'Password reset link used');
          return target.id;
        },
        { behavior: 'immediate' },
      );
      logIn(request, reply, userId, at);
    } finally {
      if (result) logSecondFactor(request, found.id, result);
      if (result?.ok === false) {
        logSecurityEvent(request, 'code_failed', 'Wrong 2FA code on a reset link', {
          userId: found.id,
        });
      }
      attempt.finish(!codeFailed);
      codeAttempt?.finish(!codeFailed);
    }
    return reply.code(204).send();
  });

  done();
};
