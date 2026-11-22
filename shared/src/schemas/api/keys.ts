import { z } from 'zod';
import { positiveInt, utcTimestamp } from '../common.js';
import { intFromString } from './common.js';
import { userRefSchema } from './users.js';

// API keys for the dashboard's Settings page. `/keys` is the logged-in user's own
// keys; `/admin/keys` and `POST /users/:id/keys` are admin only. The hash is never
// part of any response, and the full key only of a create response.

/**
 * Who revoked a key: its `owner`, or `admin` for anyone else (an admin, the
 * CLI on the server, or an admin who has since been deleted). `null` while active.
 */
export const keyRevokedBySchema = z.enum(['owner', 'admin']);

/** One key as listed. A key is revoked when `revokedAt` is set. */
export const apiKeySchema = z.strictObject({
  id: positiveInt,
  name: z.string().min(1),
  /** Display prefix, e.g. `fs_a1b2`. */
  prefix: z.string().min(1),
  createdAt: utcTimestamp,
  /** `null` until the key is first used. */
  lastUsedAt: utcTimestamp.nullable(),
  /** `null` while the key is active. */
  revokedAt: utcTimestamp.nullable(),
  /** `null` while the key is active (contract 1.33.0). */
  revokedBy: keyRevokedBySchema.nullable(),
  /** `true` when someone other than the owner made it: an admin or the CLI (1.33.0). */
  createdByAdmin: z.boolean(),
});

/** `GET /api/v1/keys`, oldest first. */
export const keysResponseSchema = z.strictObject({
  keys: z.array(apiKeySchema),
});

/**
 * `POST /api/v1/keys` body. The name rule (trimmed, 1–100 characters, no
 * control or invisible characters) is checked by the server, so the CLI and
 * the dashboard share it. Errors come back on `body.name`.
 */
export const createKeyRequestSchema = z.strictObject({
  name: z.string(),
});

/** `POST /api/v1/keys` → `201`. The only time the full key is available. */
export const createKeyResponseSchema = z.strictObject({
  apiKey: apiKeySchema,
  /**
   * The full key. Only checked as non-empty: the prefix and length belong to
   * the server, so a prefix rename doesn't change the contract.
   */
  key: z.string().min(1),
});

/**
 * One key in the admin's list (`GET /api/v1/admin/keys`): the owner's view plus
 * who owns, made and revoked it. Users are `null` once deleted (`createdBy` and
 * `revokedByUser` also for the CLI).
 */
export const adminApiKeySchema = z.strictObject({
  ...apiKeySchema.shape,
  owner: userRefSchema,
  createdBy: userRefSchema.nullable(),
  revokedByUser: userRefSchema.nullable(),
});

/** `GET /api/v1/admin/keys`: every user's keys, oldest first. */
export const adminKeysResponseSchema = z.strictObject({
  keys: z.array(adminApiKeySchema),
});

/**
 * `POST /api/v1/users/:id/keys` (body as `POST /keys`) → `201`: the admin made
 * a key for user `:id`. The only time the full key is available.
 */
export const createUserKeyResponseSchema = z.strictObject({
  apiKey: adminApiKeySchema,
  key: z.string().min(1),
});

/**
 * `DELETE /api/v1/keys/:id` and `DELETE /api/v1/admin/keys/:id` → `204`,
 * also if the key was already revoked.
 */
export const keyParamsSchema = z.strictObject({ id: intFromString(z.int().positive()) });

export type ApiKey = z.infer<typeof apiKeySchema>;
export type KeyRevokedBy = z.infer<typeof keyRevokedBySchema>;
export type AdminApiKey = z.infer<typeof adminApiKeySchema>;
export type AdminKeysResponse = z.infer<typeof adminKeysResponseSchema>;
export type CreateUserKeyResponse = z.infer<typeof createUserKeyResponseSchema>;
export type KeysResponse = z.infer<typeof keysResponseSchema>;
export type CreateKeyRequest = z.infer<typeof createKeyRequestSchema>;
export type CreateKeyResponse = z.infer<typeof createKeyResponseSchema>;
