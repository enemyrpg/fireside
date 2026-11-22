import {
  updateUserRequestSchema,
  userParamsSchema,
  type CreatedInviteResponse,
  type ManagedUser,
  type UsersResponse,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { audit, userTarget, type AuditAction } from '../audit/audit.js';
import {
  activeKeyCounts,
  countActiveKeys,
  revokeActiveKeys,
  systemClock,
  type Clock,
} from '../auth/api-keys.js';
import { ADMIN_ROUTE } from '../auth/dashboard-auth.js';
import { deleteUserDevices } from '../auth/devices.js';
import { deleteUserSessions } from '../auth/sessions.js';
import { users, type UserRow } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { deleteUser, LastAdminError, UserNotFoundError } from '../users/delete-user.js';
import {
  createPasswordReset,
  inviteUrl,
  revokeResetLinks,
  toApiInvite,
  usernamesById,
  type IdSource,
} from '../users/invites.js';
import { resetTwoFactor, twoFactorEnabled } from '../users/two-factor.js';
import { InvalidUsernameError, normalizeUsername } from '../users/username.js';
import {
  countActiveAdmins,
  findUserById,
  listUsers,
  renameUser,
  UsernameTakenError,
} from '../users/users.js';
import { requestUser } from './account-scope.js';
import { jsonBodiesOnly } from './json-body.js';
import { parseRequest } from './parse.js';

// `/api/v1/users` (Settings → Users). Admin only (`403` for members). Changes
// need login mode: in local mode there is one user and nobody to manage, and an
// invite would add a user with no admin password.

export interface UserRoutesOptions extends IdSource {
  now?: Clock;
  /** `PUBLIC_URL`'s origin, used in links. `null`: the request's own origin. */
  publicUrl?: string | null;
}

export const LOGIN_REQUIRED = 'Turn on login first: set a password under Settings → Profile';
const USER_NOT_FOUND = 'User not found';

/** `409` in local mode. */
export function requireLoginMode(request: FastifyRequest): void {
  if (request.authMode === 'local') throw new ApiError(409, 'CONFLICT', LOGIN_REQUIRED);
}

/** Origin for a new link, and whether it only works on this computer. */
export function linkOrigin(
  request: FastifyRequest,
  publicUrl: string | null | undefined,
): { origin: string; localOnly: boolean } {
  if (publicUrl) return { origin: publicUrl, localOnly: false };
  // Changes in login mode need an `Origin` from this host (dashboard-auth.ts).
  const origin = request.headers.origin ?? `http://${request.headers.host ?? 'localhost'}`;
  return { origin, localOnly: true };
}

/** Picks the listed fields, so a new column never reaches the response by accident. */
export function toManagedUser(user: UserRow, selfId: number, activeApiKeys: number): ManagedUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    canCreateApiKeys: user.canCreateApiKeys,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    disabledAt: user.disabledAt,
    isSelf: user.id === selfId,
    activeApiKeys,
    twoFactorEnabled: twoFactorEnabled(user),
  };
}

function lastAdmin(): ApiError {
  return new ApiError(409, 'CONFLICT', new LastAdminError().message);
}

export const userRoutes: FastifyPluginCallback<UserRoutesOptions> = (app, options, done) => {
  const now = options.now ?? systemClock;
  const ids: IdSource = options.generateId ? { generateId: options.generateId } : {};

  jsonBodiesOnly(app);

  app.get('/users', ADMIN_ROUTE, (request): UsersResponse => {
    const selfId = requestUser(request).id;
    const keyCounts = activeKeyCounts(app.db);
    return {
      users: listUsers(app.db).map((user) =>
        toManagedUser(user, selfId, keyCounts.get(user.id) ?? 0),
      ),
    };
  });

  app.patch('/users/:id', ADMIN_ROUTE, (request): ManagedUser => {
    const { id } = parseRequest(userParamsSchema, request.params, 'params');
    const body = parseRequest(updateUserRequestSchema, request.body, 'body');
    requireLoginMode(request);
    const actor = requestUser(request);
    if (Object.values(body).every((value) => value === undefined)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
        { path: 'body', message: 'Change at least one field' },
      ]);
    }
    let username: string | undefined;
    if (body.username !== undefined) {
      try {
        username = normalizeUsername(body.username);
      } catch (error) {
        if (!(error instanceof InvalidUsernameError)) throw error;
        throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
          { path: 'body.username', message: error.message },
        ]);
      }
    }
    if (body.revokeActiveKeys === true && body.canCreateApiKeys !== false) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
        {
          path: 'body.revokeActiveKeys',
          message: 'Only together with canCreateApiKeys: false',
        },
      ]);
    }
    if (body.disabled === true && id === actor.id) {
      throw new ApiError(409, 'CONFLICT', 'You can’t deactivate yourself');
    }

    const at = now();
    const updated = app.db.transaction(
      (tx) => {
        const user = findUserById(tx, id);
        if (!user) throw new ApiError(404, 'NOT_FOUND', USER_NOT_FOUND);
        const actions: AuditAction[] = [];
        const activeAdmin = user.role === 'admin' && user.disabledAt === null;
        const demote = body.role === 'member' && user.role === 'admin';
        const disable = body.disabled === true && user.disabledAt === null;
        if (activeAdmin && (demote || disable) && countActiveAdmins(tx) <= 1) throw lastAdmin();

        if (username !== undefined && username !== user.username) {
          try {
            renameUser(tx, id, username);
          } catch (error) {
            if (!(error instanceof UsernameTakenError)) throw error;
            throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
              { path: 'body.username', message: error.message },
            ]);
          }
          actions.push('user.rename');
        }
        if (body.role !== undefined && body.role !== user.role) {
          tx.update(users).set({ role: body.role }).where(eq(users.id, id)).run();
          actions.push(body.role === 'admin' ? 'user.promote' : 'user.demote');
        }
        if (
          body.canCreateApiKeys !== undefined &&
          body.canCreateApiKeys !== user.canCreateApiKeys
        ) {
          tx.update(users)
            .set({ canCreateApiKeys: body.canCreateApiKeys })
            .where(eq(users.id, id))
            .run();
          actions.push(body.canCreateApiKeys ? 'user.keys_allow' : 'user.keys_deny');
        }
        // Same path and `key.revoke` audit rows as `DELETE /admin/keys/:id`.
        // Also when the permission was already off: "block" then means "and revoke".
        const revokedKeys =
          body.revokeActiveKeys === true
            ? revokeActiveKeys(tx, id, { byUserId: actor.id, now: at })
            : 0;
        if (disable) {
          // Sessions end now; keys give `401` on ingest (auth/api-keys.ts).
          tx.update(users).set({ disabledAt: at.toISOString() }).where(eq(users.id, id)).run();
          deleteUserSessions(tx, id);
          deleteUserDevices(tx, id);
          revokeResetLinks(tx, id, actor.id, at);
          actions.push('user.disable');
        } else if (body.disabled === false && user.disabledAt !== null) {
          tx.update(users).set({ disabledAt: null }).where(eq(users.id, id)).run();
          actions.push('user.enable');
        }
        for (const action of actions) {
          audit(tx, { actorUserId: actor.id, action, target: userTarget(id), now: at });
        }
        if (actions.length > 0 || revokedKeys > 0) {
          request.log.info({ userId: id, actions, revokedKeys }, 'User changed');
        }
        return findUserById(tx, id);
      },
      { behavior: 'immediate' },
    );
    if (!updated) throw new ApiError(404, 'NOT_FOUND', USER_NOT_FOUND);
    return toManagedUser(updated, actor.id, countActiveKeys(app.db, id));
  });

  app.delete('/users/:id', ADMIN_ROUTE, (request, reply) => {
    const { id } = parseRequest(userParamsSchema, request.params, 'params');
    requireLoginMode(request);
    const actor = requestUser(request);
    if (id === actor.id) {
      throw new ApiError(
        409,
        'CONFLICT',
        'Delete your own account under Settings → Profile, with your password',
      );
    }
    try {
      const result = deleteUser(app.db, id, { actorUserId: actor.id, now: now() });
      request.log.info(
        { userId: id, accounts: result.accounts, events: result.events },
        'User deleted',
      );
    } catch (error) {
      if (error instanceof UserNotFoundError) throw new ApiError(404, 'NOT_FOUND', USER_NOT_FOUND);
      if (error instanceof LastAdminError) throw lastAdmin();
      throw error;
    }
    return reply.code(204).send();
  });

  // An admin turns off a user's 2FA: for a user who lost both phone and
  // recovery codes. Also ends their sessions and forgets their devices. Your
  // own 2FA is turned off with password and code instead.
  app.post('/users/:id/totp-reset', ADMIN_ROUTE, (request, reply) => {
    const { id } = parseRequest(userParamsSchema, request.params, 'params');
    requireLoginMode(request);
    const actor = requestUser(request);
    const target = findUserById(app.db, id);
    if (!target) throw new ApiError(404, 'NOT_FOUND', USER_NOT_FOUND);
    if (id === actor.id) {
      throw new ApiError(
        409,
        'CONFLICT',
        'Turn off your own two-factor authentication under Settings → Profile',
      );
    }
    // Nothing to turn off: don't log the user out or write a reset that never happened.
    if (!twoFactorEnabled(target) && target.totpPendingSecret === null) {
      throw new ApiError(409, 'CONFLICT', 'This user does not have two-factor authentication on');
    }
    const at = now();
    app.db.transaction(
      (tx) => {
        resetTwoFactor(tx, id);
        audit(tx, {
          actorUserId: actor.id,
          action: 'user.totp_reset',
          target: userTarget(id),
          now: at,
        });
      },
      { behavior: 'immediate' },
    );
    request.log.info({ userId: id }, 'Two-factor authentication turned off by an admin');
    return reply.code(204).send();
  });

  app.post('/users/:id/password-reset', ADMIN_ROUTE, (request, reply): CreatedInviteResponse => {
    const { id } = parseRequest(userParamsSchema, request.params, 'params');
    requireLoginMode(request);
    const actor = requestUser(request);
    const target = findUserById(app.db, id);
    if (!target) throw new ApiError(404, 'NOT_FOUND', USER_NOT_FOUND);
    if (target.disabledAt !== null) {
      throw new ApiError(409, 'CONFLICT', 'Activate the user before making a reset link');
    }
    const at = now();
    const { row, token, revoked } = createPasswordReset(app.db, {
      createdBy: actor.id,
      targetUserId: id,
      now: at,
      ...ids,
    });
    // At most one: a user has one active reset link at a time.
    if (revoked.length > 0) {
      audit(app.db, {
        actorUserId: actor.id,
        action: 'password_reset.revoke',
        target: userTarget(id),
        now: at,
      });
    }
    audit(app.db, {
      actorUserId: actor.id,
      action: 'password_reset.create',
      target: userTarget(id),
      now: at,
    });
    request.log.info({ inviteId: row.id, userId: id }, 'Password reset link created');
    const { origin, localOnly } = linkOrigin(request, options.publicUrl);
    void reply.code(201).header('cache-control', 'no-store');
    return {
      invite: toApiInvite(row, usernamesById(app.db), at),
      url: inviteUrl(origin, 'password_reset', token),
      localOnly,
    };
  });

  done();
};
