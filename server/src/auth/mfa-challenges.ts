import { MFA_TTL_MS } from './cookie.js';
import { hashToken, isWellFormedToken, newToken } from './tokens.js';

// The step between a correct password and the 2FA code. Kept in memory only: a
// restart means entering the password again. The cookie holds a random token;
// the map is keyed by its SHA-256. Bounded (oldest out), expires after 5
// minutes, and allows at most 5 codes, so the password must be entered again
// (and counted again) to keep guessing.
//
// A challenge remembers the password hash it was made with. If the password
// changes in between (a change, a reset link, `pnpm cli users set-password`),
// the caller refuses it, so passing the old password never leads to a login.

export const MAX_CHALLENGES = 10_000;
export const MAX_CODES_PER_CHALLENGE = 5;

export interface Challenge {
  userId: number;
  /** `users.password_hash` when the password was checked. */
  passwordHash: string;
  expiresAt: number;
  codesLeft: number;
}

export class MfaChallenges {
  private readonly entries = new Map<string, Challenge>();

  constructor(private readonly maxEntries = MAX_CHALLENGES) {}

  /** A new challenge for `userId`; returns the token for the cookie. */
  create(userId: number, passwordHash: string, now: Date): string {
    const token = newToken();
    this.entries.set(hashToken(token), {
      userId,
      passwordHash,
      expiresAt: now.getTime() + MFA_TTL_MS,
      codesLeft: MAX_CODES_PER_CHALLENGE,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return token;
  }

  /**
   * The live challenge behind `token`, without using a try: `undefined` when
   * it is missing, expired or out of tries (then forgotten).
   */
  peek(token: string | undefined, now: Date): Readonly<Challenge> | undefined {
    if (!isWellFormedToken(token)) return undefined;
    const key = hashToken(token);
    const challenge = this.entries.get(key);
    if (!challenge) return undefined;
    if (challenge.expiresAt <= now.getTime() || challenge.codesLeft <= 0) {
      this.entries.delete(key);
      return undefined;
    }
    return challenge;
  }

  /**
   * Uses one code try of the challenge behind `token`. Call only once the
   * limits allowed the attempt, so a refused (`429`) attempt costs no try.
   * Returns `false` if the challenge is gone by now.
   */
  takeTry(token: string | undefined, now: Date): boolean {
    const challenge = this.peek(token, now);
    if (!challenge) return false;
    (challenge as Challenge).codesLeft -= 1;
    return true;
  }

  /** Ends the challenge (after a correct code, or when it can't be used). */
  delete(token: string | undefined): void {
    if (isWellFormedToken(token)) this.entries.delete(hashToken(token));
  }

  /** For tests. */
  get size(): number {
    return this.entries.size;
  }
}
