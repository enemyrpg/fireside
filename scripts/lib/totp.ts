// A TOTP code for the browser scripts (`check-csp.ts`, `ui-snapshots.ts`),
// which turn on two-factor for a test user. Never used by the server.

import { createHmac } from 'node:crypto';

/** The current TOTP code for a base32 secret (RFC 6238, SHA-1, 6 digits, 30 s). */
export function totpNow(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/\s/g, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac('sha1', bytes).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
