import {
  createKeyRequestSchema,
  keyParamsSchema,
  type ApiKey,
  type CreateKeyResponse,
  type KeysResponse,
} from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import {
  createApiKey,
  InvalidKeyNameError,
  keyCreatedByAdmin,
  KeyLimitError,
  keyRevokedBy,
  listApiKeys,
  ownKey,
  revokeApiKey,
  systemClock,
  type ApiKeyInfo,
  type Clock,
  type CreatedApiKey,
  type KeyOwner,
} from '../auth/api-keys.js';
import { USER_ROUTE } from '../auth/dashboard-auth.js';
import { ApiError } from '../errors.js';
import { requestUser } from './account-scope.js';
import { jsonBodiesOnly } from './json-body.js';
import { parseRequest } from './parse.js';

export interface KeyRoutesOptions {
  now?: Clock;
}

/** `403` for `POST /keys` without `can_create_api_keys`. */
export const KEYS_NOT_ALLOWED =
  'You can’t create API keys on this server. Ask the server’s admin for a key.';

type ListedKey = Pick<
  ApiKeyInfo,
  | 'id'
  | 'userId'
  | 'name'
  | 'prefix'
  | 'createdAt'
  | 'lastUsedAt'
  | 'revokedAt'
  | 'createdByUserId'
  | 'revokedByUserId'
>;

/** Picks the listed fields, so a new column never reaches the response by accident. */
export function toApiKey(row: ListedKey): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    revokedBy: keyRevokedBy(row),
    createdByAdmin: keyCreatedByAdmin(row),
  };
}

/** The row of a key that was just created, for `toApiKey`. */
export function createdRow(created: CreatedApiKey, owner: KeyOwner): ListedKey {
  return {
    ...created,
    userId: owner.userId,
    createdByUserId: owner.createdByUserId,
    lastUsedAt: null,
    revokedAt: null,
    revokedByUserId: null,
  };
}

/**
 * `createApiKey` with its errors as API errors: a bad name is `400` on
 * `body.name`, the limit `409`. Shared by `POST /keys` and `POST /users/:id/keys`.
 */
export function createKeyOrThrow(
  db: Parameters<typeof createApiKey>[0],
  owner: KeyOwner,
  name: string,
  now: Date,
): CreatedApiKey {
  try {
    return createApiKey(db, owner, name, now);
  } catch (error) {
    if (error instanceof InvalidKeyNameError) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
        { path: 'body.name', message: error.message },
      ]);
    }
    if (error instanceof KeyLimitError) throw new ApiError(409, 'CONFLICT', error.message);
    throw error;
  }
}

/**
 * `/api/v1/keys` for the Settings page. Registered inside the dashboard scope.
 * Same logic as `pnpm cli keys`. Each user only lists, creates and revokes
 * their own keys: another user's key ID is `404`, the same as an unknown one.
 * In login mode, creating needs `can_create_api_keys` (`403`); listing and
 * revoking don't, and existing keys keep working when the permission is
 * removed. The full key is only in the `POST` response; the hash is never
 * returned.
 */
export const keyRoutes: FastifyPluginCallback<KeyRoutesOptions> = (app, options, done) => {
  const now = options.now ?? systemClock;

  jsonBodiesOnly(app);

  app.get('/keys', USER_ROUTE, (request): KeysResponse => ({
    keys: listApiKeys(app.db, requestUser(request).id).map(toApiKey),
  }));

  app.post('/keys', USER_ROUTE, (request, reply): CreateKeyResponse => {
    const { name } = parseRequest(createKeyRequestSchema, request.body, 'body');
    const user = requestUser(request);
    if (request.authMode === 'login' && !user.canCreateApiKeys) {
      throw new ApiError(403, 'FORBIDDEN', KEYS_NOT_ALLOWED);
    }
    const owner = ownKey(user.id);
    const created = createKeyOrThrow(app.db, owner, name, now());
    request.log.info({ keyId: created.id, prefix: created.prefix }, 'API key created');
    void reply.code(201).header('cache-control', 'no-store');
    return { apiKey: toApiKey(createdRow(created, owner)), key: created.key };
  });

  app.delete('/keys/:id', USER_ROUTE, (request, reply) => {
    const { id } = parseRequest(keyParamsSchema, request.params, 'params');
    const userId = requestUser(request).id;
    const result = revokeApiKey(app.db, id, { byUserId: userId, ownerId: userId, now: now() });
    if (result === 'not-found') throw new ApiError(404, 'NOT_FOUND', 'API key not found');
    if (result === 'revoked') request.log.info({ keyId: id }, 'API key revoked');
    return reply.code(204).send();
  });

  done();
};
