import { z } from 'zod';
import { instanceTextSchema } from './settings.js';

//  Public: readable without a session in login mode. Holds no user or account
// data.

/** `GET /api/v1/about` */
export const aboutResponseSchema = z.strictObject({
  /**
   * The instance text: who runs the server, what it stores and for how long.
   * Plain text. Paragraphs are separated by a blank line; never HTML or Markdown.
   */
  text: instanceTextSchema,
  /** `true` while the admin hasn't written their own text (the default is shown). */
  isDefault: z.boolean(),
});

export type AboutResponse = z.infer<typeof aboutResponseSchema>;
