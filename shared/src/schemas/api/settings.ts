import { z } from 'zod';
import { MAX_INSTANCE_TEXT_LENGTH } from '../../instance-text.js';

// Settings for the whole server, changed by the admin under Settings → Server.
// `GET`/`PATCH /api/v1/admin/settings`, admin only.

/** Plain text with paragraphs, shown on `/about` (since 1.36.0). */
export const instanceTextSchema = z
  .string()
  .min(1)
  .max(MAX_INSTANCE_TEXT_LENGTH * 2);

/** `GET /api/v1/admin/settings`, and the `PATCH` response. */
export const serverSettingsSchema = z.strictObject({
  /** Pre-selects "Can create API keys" in the invite form. Default `true`. */
  defaultInviteCanCreateApiKeys: z.boolean(),
  /**
   * The admin's own instance text, or `null` for the default (since 1.36.0).
   * The default has placeholders for who runs the instance and how to reach them.
   */
  instanceText: instanceTextSchema.nullable(),
  /** The default instance text, built from the server's config (since 1.36.0). */
  defaultInstanceText: instanceTextSchema,
});

/**
 * `PATCH /api/v1/admin/settings` body. The server answers `400` on `body`
 * when no field is given (a rule JSON Schema can't express).
 */
export const updateServerSettingsRequestSchema = z.strictObject({
  defaultInviteCanCreateApiKeys: z.boolean().optional(),
  /** New instance text, or `null` to go back to the default (since 1.36.0). */
  instanceText: instanceTextSchema.nullable().optional(),
});

export type ServerSettings = z.infer<typeof serverSettingsSchema>;
export type UpdateServerSettingsRequest = z.infer<typeof updateServerSettingsRequestSchema>;
