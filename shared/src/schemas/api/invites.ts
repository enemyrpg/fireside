import { z } from 'zod';
import { utcTimestamp } from '../common.js';
import {
  authUserSchema,
  MAX_PASSWORD_FIELD_LENGTH,
  MAX_USERNAME_FIELD_LENGTH,
  secondFactorCodeSchema,
  userRoleSchema,
} from './auth.js';
import { userRefSchema } from './users.js';

// Invite links and password reset links.
//
// - Admin only: `GET`/`POST /api/v1/invites`, `DELETE /api/v1/invites/:id`
//   and `POST /api/v1/users/:id/password-reset`.
// - Public: `POST /api/v1/auth/invite/lookup`, `…/auth/invite/accept` and
//   `…/auth/password-reset`. The token travels in the link's fragment
//   (`/invite#<token>`), so it never reaches a request line or an access log;
//   the page posts it in the body. A used, expired, revoked or unknown link
//   gives one answer: `404` "This invite link is no longer valid".
//
// The token, its hash and the link are part of no response except the one
// that creates the link (`createdInviteResponseSchema`).

/** Visible, non-secret ID: 8 characters of Crockford base32. */
export const inviteIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/, 'Invalid invite ID');

export const inviteTypeSchema = z.enum(['invite', 'password_reset']);

/** Worked out from the row: revoked, then used, then expired, else active. */
export const inviteStatusSchema = z.enum(['active', 'used', 'expired', 'revoked']);

/** How long a new invite works. Never without expiry. */
export const INVITE_DURATIONS_DAYS = [1, 7, 30] as const;
export const DEFAULT_INVITE_DURATION_DAYS = 7;
export const inviteDurationSchema = z.union([z.literal(1), z.literal(7), z.literal(30)]);

const inviteCommon = {
  id: inviteIdSchema,
  /** `null` when the admin who made it has been deleted. */
  createdBy: userRefSchema.nullable(),
  createdAt: utcTimestamp,
  expiresAt: utcTimestamp,
  status: inviteStatusSchema,
  usedAt: utcTimestamp.nullable(),
  revokedAt: utcTimestamp.nullable(),
};

/** One row in the list. Never the token, its hash or the link. */
export const inviteSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...inviteCommon,
    type: z.literal('invite'),
    label: z.string().min(1).nullable(),
    role: userRoleSchema,
    canCreateApiKeys: z.boolean(),
    /** The user the invite became. `null` while unused, or when that user was deleted. */
    usedBy: userRefSchema.nullable(),
  }),
  z.strictObject({
    ...inviteCommon,
    type: z.literal('password_reset'),
    /** The user whose password the link sets. */
    targetUser: userRefSchema,
  }),
]);

/** `GET /api/v1/invites`: invites and reset links, newest first. */
export const invitesResponseSchema = z.strictObject({
  invites: z.array(inviteSchema),
});

/**
 * `POST /api/v1/invites` body. `days` defaults to 7. The label rule (trimmed,
 * at most 100 characters, no control characters) is checked by the server;
 * an empty label means none. Errors come back on `body.label`.
 */
export const createInviteRequestSchema = z.strictObject({
  label: z.string().max(1000).optional(),
  role: userRoleSchema,
  canCreateApiKeys: z.boolean(),
  days: inviteDurationSchema.optional(),
});

/**
 * `POST /api/v1/invites` and `POST /api/v1/users/:id/password-reset` → `201`.
 * The only time the link is available.
 */
export const createdInviteResponseSchema = z.strictObject({
  invite: inviteSchema,
  /** The full link, with the token in the fragment. */
  url: z.url(),
  /** `true` when `PUBLIC_URL` isn't set: the link only works on the server's own computer. */
  localOnly: z.boolean(),
});

/** `:id` in `/api/v1/invites/:id`. */
export const inviteParamsSchema = z.strictObject({ id: inviteIdSchema });

/** Upper bound for a token field. A real token is 43 characters. */
export const MAX_TOKEN_FIELD_LENGTH = 256;

const tokenField = z.string().max(MAX_TOKEN_FIELD_LENGTH);

/** `POST /api/v1/auth/invite/lookup` body: what the link is for, before the form is shown. */
export const inviteLookupRequestSchema = z.strictObject({ token: tokenField });

/** `POST /api/v1/auth/invite/lookup` → `200`. */
export const inviteLookupResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('invite') }),
  z.strictObject({
    type: z.literal('password_reset'),
    username: z.string().min(1),
    /**
     * The user has 2FA on: the reset needs a code too (contract 1.35.0). Only
     * whoever holds the link learns this.
     */
    twoFactorRequired: z.boolean(),
  }),
]);

/** `POST /api/v1/auth/invite/accept` body. Rules as for `users create` and `auth/password`. */
export const acceptInviteRequestSchema = z.strictObject({
  token: tokenField,
  username: z.string().max(MAX_USERNAME_FIELD_LENGTH),
  password: z.string().max(MAX_PASSWORD_FIELD_LENGTH),
});

/** `POST /api/v1/auth/invite/accept` → `201`, logged in as the new user (session cookie set). */
export const acceptInviteResponseSchema = z.strictObject({ user: authUserSchema });

/**
 * `POST /api/v1/auth/password-reset` body. `204`: every session of the user
 * ends, and a new one starts for this browser. When the user has 2FA on,
 * `code` (a 2FA or recovery code) is required: a missing or wrong one gives
 * `400` on `body.code`, and the link stays unused.
 */
export const passwordResetRequestSchema = z.strictObject({
  token: tokenField,
  password: z.string().max(MAX_PASSWORD_FIELD_LENGTH),
  code: secondFactorCodeSchema.optional(),
});

export type InviteType = z.infer<typeof inviteTypeSchema>;
export type InviteStatus = z.infer<typeof inviteStatusSchema>;
export type InviteDuration = z.infer<typeof inviteDurationSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type InvitesResponse = z.infer<typeof invitesResponseSchema>;
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;
export type CreatedInviteResponse = z.infer<typeof createdInviteResponseSchema>;
export type InviteLookupRequest = z.infer<typeof inviteLookupRequestSchema>;
export type InviteLookupResponse = z.infer<typeof inviteLookupResponseSchema>;
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;
