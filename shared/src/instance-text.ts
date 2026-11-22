// Limits of the instance text. Its own module without Zod, so the dashboard can
// import it without bundling Zod (web/vite.config.ts).

/**
 * Most characters (code points) in the instance text. The server counts code
 * points and answers `400` on `body.instanceText`; the schema only caps the
 * UTF-16 length, which is at most twice the code point count.
 */
export const MAX_INSTANCE_TEXT_LENGTH = 4000;

/**
 * Placeholders in the default instance text that the admin must replace
 * (server/src/settings/instance-text.ts). The dashboard reminds the admin
 * while one is left.
 */
export const INSTANCE_TEXT_PLACEHOLDERS = ['[your name]', '[how to reach you]'] as const;

/**
 * The layout the server stores: line endings as `\n`, spaces at the end of
 * lines removed, at most one blank line between paragraphs, trimmed. The
 * length limit applies to the result, so the dashboard counts it too.
 */
export function normalizeInstanceTextLayout(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
