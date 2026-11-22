import type { Invite } from '@fireside/shared';

// Active entries stay in the Settings lists; the rest move to their own
// screens behind a link row. The list endpoints already return everything, so
// the split is done here.

/** Keys that still work. */
export function activeKeys<T extends { revokedAt: string | null }>(keys: readonly T[]): T[] {
  return keys.filter((key) => key.revokedAt === null);
}

/** Revoked keys, the most recently revoked first. */
export function revokedKeys<T extends { revokedAt: string | null }>(keys: readonly T[]): T[] {
  return keys
    .filter((key) => key.revokedAt !== null)
    .sort((a, b) => (b.revokedAt ?? '').localeCompare(a.revokedAt ?? ''));
}

/** Invites and reset links that can still be used. */
export function activeInvites(invites: readonly Invite[]): Invite[] {
  return invites.filter((invite) => invite.status === 'active');
}

/** Used, expired and revoked invites and reset links, in the server's order (newest first). */
export function pastInvites(invites: readonly Invite[]): Invite[] {
  return invites.filter((invite) => invite.status !== 'active');
}
