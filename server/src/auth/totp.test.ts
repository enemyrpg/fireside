import { BRANDING } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  matchTotpStep,
  otpauthUri,
  totpCode,
  totpStep,
} from './totp.js';

// RFC 6238, appendix B (SHA-1, 8 digits, the ASCII secret "12345678901234567890").
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP', () => {
  it.each(RFC_VECTORS)('matches the RFC 6238 test vector at T=%i', (seconds, code) => {
    expect(hotp(RFC_KEY, Math.floor(seconds / 30), 8)).toBe(code);
  });

  it('gives the last 6 digits by default, as apps show them', () => {
    expect(hotp(RFC_KEY, Math.floor(59 / 30))).toBe('287082');
  });

  it('round-trips base32 (RFC 4648) and ignores case and spaces', () => {
    expect(base32Encode(RFC_KEY)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(RFC_KEY);
    expect(base32Decode('ABC1')).toBeUndefined();
  });

  it('makes 20-byte secrets, different every time', () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it('accepts one step of drift either way, and nothing further', () => {
    const secret = base32Encode(RFC_KEY);
    const now = new Date(1_234_567_890_000);
    const step = totpStep(now);
    const at = (s: number) => new Date(s * 30_000);
    expect(matchTotpStep(secret, totpCode(secret, now), now)).toBe(step);
    expect(matchTotpStep(secret, totpCode(secret, at(step - 1)), now)).toBe(step - 1);
    expect(matchTotpStep(secret, totpCode(secret, at(step + 1)), now)).toBe(step + 1);
    expect(matchTotpStep(secret, totpCode(secret, at(step - 2)), now)).toBeUndefined();
    expect(matchTotpStep(secret, totpCode(secret, at(step + 2)), now)).toBeUndefined();
  });

  it('refuses anything but six digits', () => {
    const secret = base32Encode(RFC_KEY);
    const now = new Date(1_234_567_890_000);
    const code = totpCode(secret, now);
    expect(matchTotpStep(secret, `${code}0`, now)).toBeUndefined();
    expect(matchTotpStep(secret, code.slice(1), now)).toBeUndefined();
    expect(matchTotpStep(secret, 'abcdef', now)).toBeUndefined();
  });

  it('builds an otpauth URI that apps read', () => {
    const issuer = BRANDING.displayName;
    const text = otpauthUri('JBSWY3DPEHPK3PXP', issuer, 'ola');
    expect(text.startsWith(`otpauth://totp/${encodeURIComponent(issuer)}:ola?`)).toBe(true);
    const uri = new URL(text);
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer,
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});
