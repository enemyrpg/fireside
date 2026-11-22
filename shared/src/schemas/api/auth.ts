import { z } from 'zod';
import { positiveInt, utcTimestamp } from '../common.js';

// Login. The session itself is an HttpOnly cookie, never part of a body.
// Password and username rules (length, characters) are checked by the server,
// so the CLI and the dashboard share them; errors come back on `body.<field>`.

/** Upper bound for any password field, in UTF-16 units. The server's own limit is lower. */
export const MAX_PASSWORD_FIELD_LENGTH = 1024;
/** Upper bound for the username field. The server's own limit is lower. */
export const MAX_USERNAME_FIELD_LENGTH = 64;

/** `local`: one user, no login, localhost only. `login`: a session is required. */
export const authModeSchema = z.enum(['local', 'login']);

export const userRoleSchema = z.enum(['admin', 'member']);

/** The user a session (or local mode) acts as. */
export const authUserSchema = z.strictObject({
  id: positiveInt,
  username: z.string().min(1),
  role: userRoleSchema,
  /**
   * May the user create their own API keys (contract 1.33.0)? Always `true` in
   * local mode, where the flag isn't enforced.
   */
  canCreateApiKeys: z.boolean(),
  /** Is two-factor authentication on (contract 1.35.0)? */
  twoFactorEnabled: z.boolean(),
});

/**
 * `GET /api/v1/auth/me`. Always `200`. In local mode `user` is the local
 * user; in login mode it is `null` without a valid session.
 */
export const authMeResponseSchema = z.strictObject({
  mode: authModeSchema,
  user: authUserSchema.nullable(),
});

/** `POST /api/v1/auth/login` body. */
export const loginRequestSchema = z.strictObject({
  username: z.string().max(MAX_USERNAME_FIELD_LENGTH),
  password: z.string().max(MAX_PASSWORD_FIELD_LENGTH),
});

/**
 * `POST /api/v1/auth/login` → `200`. Without 2FA: `{ user }`, with the
 * session cookie set. With 2FA (contract 1.35.0), only after a correct
 * password: `{ twoFactorRequired: true }` and a 5-minute challenge cookie; no
 * session until `POST /api/v1/auth/login/totp`.
 */
export const loginResponseSchema = z.union([
  z.strictObject({ user: authUserSchema }),
  z.strictObject({ twoFactorRequired: z.literal(true) }),
]);

/** Upper bound for a 2FA or recovery code field. */
export const MAX_CODE_FIELD_LENGTH = 64;

/** A 2FA code (six digits) or a recovery code (`xxxxx-xxxxx`). Spaces are ignored. */
export const secondFactorCodeSchema = z.string().max(MAX_CODE_FIELD_LENGTH);

/**
 * `POST /api/v1/auth/login/totp` body. `200 { user }` with the session cookie
 * (`loginResponseSchema`'s first form); `401` for a wrong code or a timed-out
 * login; `429`.
 */
export const loginTotpRequestSchema = z.strictObject({ code: secondFactorCodeSchema });

/** `GET /api/v1/auth/totp` → `200`. */
export const twoFactorStatusResponseSchema = z.strictObject({
  enabled: z.boolean(),
  enabledAt: utcTimestamp.nullable(),
  /** Unused recovery codes. `0` while 2FA is off. */
  recoveryCodesLeft: z.int().nonnegative(),
});

/** `POST /api/v1/auth/totp/setup` body: the password, so a stolen session can't turn 2FA on. */
export const totpSetupRequestSchema = z.strictObject({
  password: z.string().max(MAX_PASSWORD_FIELD_LENGTH),
});

/**
 * `POST /api/v1/auth/totp/setup` → `200`: a new secret, pending for 10
 * minutes until `enable`. `409` if 2FA is already on.
 */
export const totpSetupResponseSchema = z.strictObject({
  /** base32, for typing into an authenticator app. */
  secret: z.string().regex(/^[A-Z2-7]+$/),
  /** `otpauth://totp/…`, shown as a QR code. */
  otpauthUri: z.string().startsWith('otpauth://totp/'),
});

/** `POST /api/v1/auth/totp/enable` body: the first code from the app. */
export const totpEnableRequestSchema = z.strictObject({ code: secondFactorCodeSchema });

/**
 * `POST /api/v1/auth/totp/enable` and `POST /api/v1/auth/totp/recovery-codes`
 * → `200`: ten recovery codes, shown once.
 */
export const recoveryCodesResponseSchema = z.strictObject({
  recoveryCodes: z.array(z.string().regex(/^[a-z2-7]{5}-[a-z2-7]{5}$/)).length(10),
});

/**
 * `POST /api/v1/auth/totp/disable` (`204`) and
 * `POST /api/v1/auth/totp/recovery-codes` body: password and a current code.
 */
export const totpConfirmRequestSchema = z.strictObject({
  password: z.string().max(MAX_PASSWORD_FIELD_LENGTH),
  code: secondFactorCodeSchema,
});

/**
 * `POST /api/v1/auth/password` body. In local mode it sets the first
 * password (turning login on) and `currentPassword` must be left out. In
 * login mode `currentPassword` is required. `204`, with a new session cookie.
 */
export const changePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().max(MAX_PASSWORD_FIELD_LENGTH).optional(),
  newPassword: z.string().max(MAX_PASSWORD_FIELD_LENGTH),
});

export type AuthMode = z.infer<typeof authModeSchema>;
export type UserRole = z.infer<typeof userRoleSchema>;
export type AuthUser = z.infer<typeof authUserSchema>;
export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type LoginTotpRequest = z.infer<typeof loginTotpRequestSchema>;
export type TwoFactorStatusResponse = z.infer<typeof twoFactorStatusResponseSchema>;
export type TotpSetupRequest = z.infer<typeof totpSetupRequestSchema>;
export type TotpSetupResponse = z.infer<typeof totpSetupResponseSchema>;
export type TotpEnableRequest = z.infer<typeof totpEnableRequestSchema>;
export type RecoveryCodesResponse = z.infer<typeof recoveryCodesResponseSchema>;
export type TotpConfirmRequest = z.infer<typeof totpConfirmRequestSchema>;
