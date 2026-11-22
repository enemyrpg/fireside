import { z } from 'zod';
import { semver } from '../common.js';

//  No authentication.

/** `GET /api/v1/health` */
export const healthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  /** Version of the server package. */
  serverVersion: semver,
  /** `CONTRACT_VERSION` the server implements. */
  contractVersion: semver,
  /**
   * IANA time zone (`TZ` from .env) that days, weeks and the calendar use. The
   * dashboard shows all times in it (since 1.7.0).
   */
  timeZone: z.string().min(1),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
