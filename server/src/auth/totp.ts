import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// TOTP (RFC 6238) on Node's own crypto, no dependency: HMAC-SHA-1, 6 digits, 30
// s steps, one step of clock drift either way, a 20-byte secret shown as base32
// (RFC 4648, no padding). What authenticator apps expect by default. Reuse is
// stopped by the caller, which stores the last accepted step
// (users.totp_last_step) and accepts only a later one.

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_SECRET_BYTES = 20;
/** Steps of drift accepted either way. */
export const TOTP_WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

/** Decodes base32 (case and spaces ignored). `undefined` for any other character. */
export function base32Decode(text: string): Buffer | undefined {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) return undefined;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret, base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** HOTP (RFC 4226) for `counter`, as a zero-padded string. */
export function hotp(
  key: Buffer,
  counter: number,
  digits = TOTP_DIGITS,
  algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1',
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The time step at `now`. */
export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for `secret` (base32) at `now`. For tests and the CSP check. */
export function totpCode(secret: string, now: Date): string {
  const key = base32Decode(secret);
  if (!key) throw new Error('Invalid base32 secret');
  return hotp(key, totpStep(now));
}

/** True for exactly six digits (spaces removed by the caller). */
export function looksLikeTotpCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/**
 * The step `code` is valid for at `now` (within the window), or `undefined`.
 * Later steps are tried first, so the newest match wins.
 */
export function matchTotpStep(secret: string, code: string, now: Date): number | undefined {
  const key = base32Decode(secret);
  if (!key || !looksLikeTotpCode(code)) return undefined;
  const given = Buffer.from(code, 'utf8');
  const current = totpStep(now);
  let found: number | undefined;
  // Every candidate is computed and compared, so timing doesn't tell which matched.
  for (let step = current + TOTP_WINDOW; step >= current - TOTP_WINDOW; step--) {
    const expected = Buffer.from(hotp(key, step), 'utf8');
    if (timingSafeEqual(expected, given) && found === undefined) found = step;
  }
  return found;
}

/** The `otpauth://` URI authenticator apps read from the QR code. */
export function otpauthUri(secret: string, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
