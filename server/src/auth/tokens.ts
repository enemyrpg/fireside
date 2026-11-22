import { createHash, randomBytes } from 'node:crypto';

// Random tokens for cookies and links (sessions, device cookies, the 2FA
// step, invite and reset links): 32 random bytes as base64url. Only the
// SHA-256 of a token is ever stored or used as a key.

const TOKEN_BYTES = 32;
/** base64url of 32 bytes, no padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A new random token. Goes in a cookie or a link only. */
export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** True if `token` has the shape of one of ours (checked before any lookup). */
export function isWellFormedToken(token: string | undefined): token is string {
  return token !== undefined && TOKEN_PATTERN.test(token);
}

/** SHA-256 (hex) of a token: what is stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
