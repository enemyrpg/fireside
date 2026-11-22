import { createHmac, randomBytes } from 'node:crypto';
import { BRANDING } from '@fireside/shared';
import { and, count, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { deleteUserDevices } from '../auth/devices.js';
import {
  createSecretBox,
  SecretBoxError,
  type KeyStore,
  type SecretBox,
} from '../auth/secret-box.js';
import { deleteUserSessions } from '../auth/sessions.js';
import {
  base32Encode,
  generateTotpSecret,
  looksLikeTotpCode,
  matchTotpStep,
  otpauthUri,
} from '../auth/totp.js';
import type { Queryable } from '../db/index.js';
import { recoveryCodes, users, type UserRow } from '../db/schema.js';

// Two-factor authentication. Optional for everyone, strongly recommended for
// admins. The secret is stored encrypted (auth/secret-box.ts). A code is
// accepted once: the last accepted time step is stored, and only a later one is
// accepted, with a conditional update so two parallel requests can't both use
// one code. Recovery codes: 10 per user, 50 bits each, each works once. Stored
// as HMAC-SHA-256 under a key derived from the key file (auth/secret-box.ts)
// and bound to the user, so a copy of the database alone can't be searched for
// them. Losing the key file invalidates them too (`reset-2fa` covers it). Codes
// are never logged.

/** How long a secret being set up waits for its first code. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_CHARS = 10;

export class TwoFactorAlreadyOnError extends Error {
  override name = 'TwoFactorAlreadyOnError';
  constructor() {
    super('Two-factor authentication is already on');
  }
}

export class TwoFactorOffError extends Error {
  override name = 'TwoFactorOffError';
  constructor() {
    super('Two-factor authentication is off');
  }
}

export class NoPendingSetupError extends Error {
  override name = 'NoPendingSetupError';
  constructor() {
    super('The setup timed out. Start again.');
  }
}

export function twoFactorEnabled(user: Pick<UserRow, 'totpEnabledAt'>): boolean {
  return user.totpEnabledAt !== null;
}

/** Lower case, no spaces or dashes. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toLowerCase();
}

function hashRecoveryCode(key: Buffer, userId: number, code: string): string {
  return createHmac('sha256', key)
    .update(`${String(userId)}:${normalizeRecoveryCode(code)}`, 'utf8')
    .digest('hex');
}

/** One code: `xxxxx-xxxxx`, 10 base32 characters (50 bits). */
function newRecoveryCode(): string {
  const chars = base32Encode(randomBytes(7)).slice(0, RECOVERY_CODE_CHARS).toLowerCase();
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** Replaces every recovery code of `userId` with new ones; returns them (shown once). */
export function replaceRecoveryCodes(
  db: Queryable,
  box: SecretBox,
  userId: number,
  now: Date,
): string[] {
  const key = box.recoveryCodeKey(true);
  db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  db.insert(recoveryCodes)
    .values(
      codes.map((code) => ({
        userId,
        codeHash: hashRecoveryCode(key, userId, code),
        createdAt: now.toISOString(),
      })),
    )
    .run();
  return codes;
}

export function recoveryCodesLeft(db: Queryable, userId: number): number {
  return (
    db
      .select({ n: count() })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
      .get()?.n ?? 0
  );
}

export interface PendingSetup {
  /** base32. Shown once, with the QR code. */
  secret: string;
  otpauthUri: string;
}

/** Starts setting up 2FA: a new secret, pending for 10 minutes. */
export function startSetup(db: Queryable, box: SecretBox, user: UserRow, now: Date): PendingSetup {
  if (twoFactorEnabled(user)) throw new TwoFactorAlreadyOnError();
  const secret = generateTotpSecret();
  db.update(users)
    .set({
      totpPendingSecret: box.seal(user.id, secret),
      totpPendingExpiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
    })
    .where(eq(users.id, user.id))
    .run();
  return { secret, otpauthUri: otpauthUri(secret, BRANDING.displayName, user.username) };
}

/**
 * Turns 2FA on with the first code from the pending secret. Returns the
 * recovery codes, or `undefined` for a wrong code. Throws
 * `TwoFactorAlreadyOnError` or `NoPendingSetupError`.
 */
export function enableTwoFactor(
  db: Queryable,
  box: SecretBox,
  user: UserRow,
  code: string,
  now: Date,
): string[] | undefined {
  if (twoFactorEnabled(user)) throw new TwoFactorAlreadyOnError();
  if (
    user.totpPendingSecret === null ||
    user.totpPendingExpiresAt === null ||
    user.totpPendingExpiresAt <= now.toISOString()
  ) {
    throw new NoPendingSetupError();
  }
  const sealed = user.totpPendingSecret;
  const secret = box.open(user.id, sealed);
  const step = matchTotpStep(secret, code.replace(/\s/g, ''), now);
  if (step === undefined) return undefined;
  // Conditional: two parallel enables can't both win.
  const changed = db
    .update(users)
    .set({
      totpSecret: sealed,
      totpEnabledAt: now.toISOString(),
      totpLastStep: step,
      totpPendingSecret: null,
      totpPendingExpiresAt: null,
    })
    .where(
      and(eq(users.id, user.id), isNull(users.totpEnabledAt), eq(users.totpPendingSecret, sealed)),
    )
    .run().changes;
  if (changed !== 1) throw new TwoFactorAlreadyOnError();
  return replaceRecoveryCodes(db, box, user.id, now);
}

export type SecondFactorResult =
  { ok: true; method: 'totp' | 'recovery_code' } | { ok: false; reason: 'wrong' | 'undecryptable' };

/**
 * Checks a 2FA code (six digits) or a recovery code for `user`, and uses it
 * up. Run it in the transaction of whatever the code allows, if any.
 */
export function useSecondFactor(
  db: Queryable,
  box: SecretBox,
  user: UserRow,
  code: string,
  now: Date,
): SecondFactorResult {
  const compact = code.replace(/\s/g, '');
  if (looksLikeTotpCode(compact)) {
    if (user.totpSecret === null) return { ok: false, reason: 'wrong' };
    let secret: string;
    try {
      secret = box.open(user.id, user.totpSecret);
    } catch (error) {
      if (error instanceof SecretBoxError) return { ok: false, reason: 'undecryptable' };
      throw error;
    }
    const step = matchTotpStep(secret, compact, now);
    if (step === undefined) return { ok: false, reason: 'wrong' };
    const changed = db
      .update(users)
      .set({ totpLastStep: step })
      .where(
        and(
          eq(users.id, user.id),
          isNotNull(users.totpEnabledAt),
          or(isNull(users.totpLastStep), lt(users.totpLastStep, step)),
        ),
      )
      .run().changes;
    return changed === 1 ? { ok: true, method: 'totp' } : { ok: false, reason: 'wrong' };
  }
  if (normalizeRecoveryCode(compact).length !== RECOVERY_CODE_CHARS) {
    return { ok: false, reason: 'wrong' };
  }
  let key: Buffer;
  try {
    key = box.recoveryCodeKey(false);
  } catch (error) {
    if (error instanceof SecretBoxError) return { ok: false, reason: 'undecryptable' };
    throw error;
  }
  const used = db
    .update(recoveryCodes)
    .set({ usedAt: now.toISOString() })
    .where(
      and(
        eq(recoveryCodes.userId, user.id),
        eq(recoveryCodes.codeHash, hashRecoveryCode(key, user.id, compact)),
        isNull(recoveryCodes.usedAt),
      ),
    )
    .run().changes;
  return used === 1 ? { ok: true, method: 'recovery_code' } : { ok: false, reason: 'wrong' };
}

/** Turns 2FA off and deletes the recovery codes (the user's own choice). */
export function disableTwoFactor(db: Queryable, userId: number): void {
  db.update(users)
    .set({
      totpSecret: null,
      totpEnabledAt: null,
      totpLastStep: null,
      totpPendingSecret: null,
      totpPendingExpiresAt: null,
    })
    .where(eq(users.id, userId))
    .run();
  db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
}

/**
 * An admin or the operator turns off a user's 2FA (lost phone and codes):
 * also ends their sessions and forgets their devices.
 */
export function resetTwoFactor(db: Queryable, userId: number): void {
  disableTwoFactor(db, userId);
  deleteUserSessions(db, userId);
  deleteUserDevices(db, userId);
}

/**
 * Users with 2FA whose secret can't be decrypted (key file missing, wrong or
 * unreadable). Checked at startup.
 */
export function usersWithUnusableSecrets(
  db: Queryable,
  box: SecretBox,
): { username: string; problem: string }[] {
  const withTwoFactor = db.select().from(users).where(isNotNull(users.totpEnabledAt)).all();
  const result: { username: string; problem: string }[] = [];
  for (const user of withTwoFactor) {
    try {
      box.open(user.id, user.totpSecret ?? '');
    } catch (error) {
      if (!(error instanceof SecretBoxError)) throw error;
      result.push({ username: user.username, problem: error.message });
    }
  }
  return result;
}

/**
 * Startup warnings: one per user with 2FA whose secret can't be decrypted with
 * the key in `keyStore`, naming the command that lets them log in again. Empty
 * when all is well.
 */
export function twoFactorKeyWarnings(db: Queryable, keyStore: KeyStore): string[] {
  return usersWithUnusableSecrets(db, createSecretBox(keyStore)).map(
    ({ username, problem }) =>
      `${username} has two-factor authentication on, but ${problem.charAt(0).toLowerCase()}${problem.slice(1)}. ` +
      `They can't log in until the key file is put back from where you kept it, ` +
      `or 2FA is turned off for them with: pnpm cli users reset-2fa ${username}`,
  );
}
