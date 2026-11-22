import {
  createKeyRequestSchema,
  keyParamsSchema,
  userParamsSchema,
  type AdminApiKey,
  type AdminKeysResponse,
  type CreateUserKeyResponse,
} from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import { listApiKeys, revokeApiKey, systemClock, type Clock } from '../auth/api-keys.js';
import { ADMIN_ROUTE } from '../auth/dashboard-auth.js';
import { ApiError } from '../errors.js';
import { usernamesById } from '../users/invites.js';
import { findUserById } from '../users/users.js';
import { requestUser } from './account-scope.js';
import { jsonBodiesOnly } from './json-body.js';
import { createdRow, createKeyOrThrow, toApiKey } from './keys.js';
import { parseRequest } from './parse.js';
import { requireLoginMode } from './users.js';

// Every user's API keys, for the admin (Settings → Users). Admin only (`403`
// for members). Never the key or its hash: the full key is only in the response
// that creates it. Changes need login mode, like the rest of user management.

export interface AdminKeyRoutesOptions {
  now?: Clock;
}

type Row = Parameters<typeof toApiKey>[0];

/** The owner's view of the key plus who owns, made and revoked it. */
function toAdminApiKey(row: Row, names: ReadonlyMap<number, string>): AdminApiKey {
  const ref = (id: number | null) => {
    if (id === null) return null;
    const username = names.get(id);
    return username === undefined ? null : { id, username };
  };
  const owner = ref(row.userId);
  // A key's owner can't be deleted while the key exists (deleting a user deletes their keys).
  if (!owner) throw new Error(`API key ${String(row.id)} has no owner`);
  return {
    ...toApiKey(row),
    owner,
    createdBy: ref(row.createdByUserId),
    revokedByUser: row.revokedAt === null ? null : ref(row.revokedByUserId),
  };
}

export const adminKeyRoutes: FastifyPluginCallback<AdminKeyRoutesOptions> = (
  app,
  options,
  done,
) => {
  const now = options.now ?? systemClock;

  jsonBodiesOnly(app);

  app.get('/admin/keys', ADMIN_ROUTE, (): AdminKeysResponse => {
    const names = usernamesById(app.db);
    return { keys: listApiKeys(app.db).map((row) => toAdminApiKey(row, names)) };
  });

  app.post('/users/:id/keys', ADMIN_ROUTE, (request, reply): CreateUserKeyResponse => {
    const { id } = parseRequest(userParamsSchema, request.params, 'params');
    const { name } = parseRequest(createKeyRequestSchema, request.body, 'body');
    requireLoginMode(request);
    const actor = requestUser(request);
    const target = findUserById(app.db, id);
    if (!target) throw new ApiError(404, 'NOT_FOUND', 'User not found');
    if (target.disabledAt !== null) {
      throw new ApiError(409, 'CONFLICT', 'This user is deactivated. Activate them first.');
    }
    // Not gated by the target's `can_create_api_keys`: this is how an admin
    // gives a key to a user who can't make their own.
    const owner = { userId: id, createdByUserId: actor.id };
    const created = createKeyOrThrow(app.db, owner, name, now());
    request.log.info(
      { keyId: created.id, prefix: created.prefix, userId: id },
      'API key created for user',
    );
    void reply.code(201).header('cache-control', 'no-store');
    return {
      apiKey: toAdminApiKey(createdRow(created, owner), usernamesById(app.db)),
      key: created.key,
    };
  });

  app.delete('/admin/keys/:id', ADMIN_ROUTE, (request, reply) => {
    const { id } = parseRequest(keyParamsSchema, request.params, 'params');
    requireLoginMode(request);
    const actor = requestUser(request);
    const result = revokeApiKey(app.db, id, { byUserId: actor.id, now: now() });
    if (result === 'not-found') throw new ApiError(404, 'NOT_FOUND', 'API key not found');
    if (result === 'revoked') request.log.info({ keyId: id }, 'API key revoked by admin');
    return reply.code(204).send();
  });

  done();
};
