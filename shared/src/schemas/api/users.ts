import { z } from 'zod';
import { positiveInt, utcTimestamp } from '../common.js';
import { MAX_PASSWORD_FIELD_LENGTH, MAX_USERNAME_FIELD_LENGTH, userRoleSchema } from './auth.js';
import { intFromString } from './common.js';

// User management. `GET`/`PATCH`/`DELETE /api/v1/users…` are admin only (`403`
// for members). `POST /api/v1/auth/delete-account` is for any logged-in user.
// Rules that need the database (last admin, username taken, username rule) are
// checked by the server; errors come back as `409` or on `body.<field>`.

/** A user as shown next to something else (an invite's creator, a reset link's target). */
export const userRefSchema = z.strictObject({
  id: positiveInt,
  username: z.string().min(1),
});

/** One user in Settings → Users. */
export const managedUserSchema = z.strictObject({
  id: positiveInt,
  username: z.string().min(1),
  role: userRoleSchema,
  canCreateApiKeys: z.boolean(),
  createdAt: utcTimestamp,
  /** `null` until the user first logs in. */
  lastLoginAt: utcTimestamp.nullable(),
  /** `null` while the user is active. */
  disabledAt: utcTimestamp.nullable(),
  /** `true` for the admin who asked. */
  isSelf: z.boolean(),
  /** The user's keys that aren't revoked (contract 1.33.0). At most 10. */
  activeApiKeys: z.int().nonnegative(),
  /** Is two-factor authentication on (contract 1.35.0)? */
  twoFactorEnabled: z.boolean(),
});

/** `GET /api/v1/users`, oldest first. */
export const usersResponseSchema = z.strictObject({
  users: z.array(managedUserSchema),
});

/**
 * `PATCH /api/v1/users/:id` body. `disabled: true` deactivates (ends the
 * user's sessions; their keys give `401` on ingest). Responds `200` with the
 * user (`managedUserSchema`). The server answers `400` on `body` when no
 * field is given (a rule JSON Schema can't express, so it isn't here).
 */
export const updateUserRequestSchema = z.strictObject({
  username: z.string().max(MAX_USERNAME_FIELD_LENGTH).optional(),
  role: userRoleSchema.optional(),
  canCreateApiKeys: z.boolean().optional(),
  disabled: z.boolean().optional(),
  /**
   * With `canCreateApiKeys: false`: also revoke the user's active keys, in the
   * same change. `400` on `body.revokeActiveKeys` otherwise.
   */
  revokeActiveKeys: z.boolean().optional(),
});

/** `:id` in `/api/v1/users/:id`. */
export const userParamsSchema = z.strictObject({ id: intFromString(z.int().positive()) });

/**
 * `POST /api/v1/auth/delete-account` body: the user deletes themselves and all
 * their data after confirming their password. `204`, and the cookie is cleared.
 */
export const deleteAccountRequestSchema = z.strictObject({
  password: z.string().max(MAX_PASSWORD_FIELD_LENGTH),
});

export type UserRef = z.infer<typeof userRefSchema>;
export type ManagedUser = z.infer<typeof managedUserSchema>;
export type UsersResponse = z.infer<typeof usersResponseSchema>;
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;
