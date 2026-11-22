import { describe, expect, it } from 'vitest';
import { MFA_TTL_MS } from './cookie.js';
import { MAX_CODES_PER_CHALLENGE, MfaChallenges } from './mfa-challenges.js';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const HASH = '$argon2id$v=19$x';
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe('2FA login challenges', () => {
  it('remembers the user and the password hash, and allows at most 5 tries', () => {
    const challenges = new MfaChallenges();
    const token = challenges.create(7, HASH, NOW);
    expect(challenges.peek(token, NOW)).toMatchObject({ userId: 7, passwordHash: HASH });
    for (let i = 0; i < MAX_CODES_PER_CHALLENGE; i++)
      expect(challenges.takeTry(token, NOW)).toBe(true);
    expect(challenges.peek(token, NOW)).toBeUndefined();
    expect(challenges.takeTry(token, NOW)).toBe(false);
    expect(challenges.size).toBe(0);
  });

  it('uses no try on peek', () => {
    const challenges = new MfaChallenges();
    const token = challenges.create(7, HASH, NOW);
    for (let i = 0; i < 20; i++) challenges.peek(token, NOW);
    expect(challenges.peek(token, NOW)?.codesLeft).toBe(MAX_CODES_PER_CHALLENGE);
  });

  it('expires after 5 minutes', () => {
    const challenges = new MfaChallenges();
    const token = challenges.create(7, HASH, NOW);
    expect(challenges.takeTry(token, later(MFA_TTL_MS - 1))).toBe(true);
    expect(challenges.peek(token, later(MFA_TTL_MS))).toBeUndefined();
  });

  it('ignores unknown and malformed tokens, and forgets a deleted one', () => {
    const challenges = new MfaChallenges();
    const token = challenges.create(7, HASH, NOW);
    expect(challenges.peek(undefined, NOW)).toBeUndefined();
    expect(challenges.peek('x', NOW)).toBeUndefined();
    expect(challenges.peek('A'.repeat(43), NOW)).toBeUndefined();
    challenges.delete(token);
    expect(challenges.peek(token, NOW)).toBeUndefined();
  });

  it('keeps at most maxEntries, dropping the oldest', () => {
    const challenges = new MfaChallenges(3);
    const first = challenges.create(1, HASH, NOW);
    for (let i = 2; i <= 4; i++) challenges.create(i, HASH, NOW);
    expect(challenges.size).toBe(3);
    expect(challenges.peek(first, NOW)).toBeUndefined();
  });

  it('keeps at most 10 000 by default', () => {
    const challenges = new MfaChallenges();
    for (let i = 0; i < 10_001; i++) challenges.create(1, HASH, NOW);
    expect(challenges.size).toBe(10_000);
  });
});
