import { describe, expect, it } from 'vitest';
import { trustedDevices } from '../db/schema.js';
import { testDatabase } from '../test-utils.js';
import { createUser } from '../users/users.js';
import {
  DEVICE_TTL_MS,
  deleteUserDevices,
  isKnownDevice,
  lookupDevice,
  MAX_DEVICES_PER_USER,
  rememberDevice,
} from './devices.js';

const NOW = new Date('2026-11-19T12:00:00.000Z');

describe('device cookies', () => {
  it('stores only a hash of the token, and knows it for its own user only', () => {
    const { db } = testDatabase();
    const ola = createUser(db, 'ola', { now: NOW });
    const token = rememberDevice(db, 1, undefined, NOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = db.select().from(trustedDevices).all();
    expect(row?.tokenHash).not.toContain(token);
    expect(isKnownDevice(db, token, 1, NOW)).toBe(true);
    expect(isKnownDevice(db, token, ola, NOW)).toBe(false);
    expect(isKnownDevice(db, token, undefined, NOW)).toBe(false);
  });

  it('ignores malformed, unknown and expired tokens', () => {
    const { db } = testDatabase();
    const token = rememberDevice(db, 1, undefined, NOW);
    expect(lookupDevice(db, undefined, NOW)).toBeUndefined();
    expect(lookupDevice(db, 'nope', NOW)).toBeUndefined();
    expect(lookupDevice(db, 'A'.repeat(43), NOW)).toBeUndefined();
    expect(lookupDevice(db, token, new Date(NOW.getTime() + DEVICE_TTL_MS))).toBeUndefined();
  });

  it('touches a known device of the same user instead of making a new one', () => {
    const { db } = testDatabase();
    const token = rememberDevice(db, 1, undefined, NOW);
    const later = new Date(NOW.getTime() + 1000);
    expect(rememberDevice(db, 1, token, later)).toBe(token);
    expect(db.select().from(trustedDevices).all()).toEqual([
      expect.objectContaining({
        lastUsedAt: later.toISOString(),
        expiresAt: new Date(later.getTime() + DEVICE_TTL_MS).toISOString(),
      }),
    ]);
  });

  it('replaces another user’s cookie in a shared browser', () => {
    const { db } = testDatabase();
    const ola = createUser(db, 'ola', { now: NOW });
    const admins = rememberDevice(db, 1, undefined, NOW);
    const olas = rememberDevice(db, ola, admins, NOW);
    expect(olas).not.toBe(admins);
    expect(isKnownDevice(db, olas, ola, NOW)).toBe(true);
    // The admin's row stays until it expires or is revoked.
    expect(isKnownDevice(db, admins, 1, NOW)).toBe(true);
  });

  it('keeps at most 20 devices per user, least recently used out first', () => {
    const { db } = testDatabase();
    const tokens = Array.from({ length: MAX_DEVICES_PER_USER + 2 }, (_, i) =>
      rememberDevice(db, 1, undefined, new Date(NOW.getTime() + i * 1000)),
    );
    expect(db.select().from(trustedDevices).all()).toHaveLength(MAX_DEVICES_PER_USER);
    const at = new Date(NOW.getTime() + 60_000);
    expect(isKnownDevice(db, tokens[0], 1, at)).toBe(false);
    expect(isKnownDevice(db, tokens[1], 1, at)).toBe(false);
    expect(isKnownDevice(db, tokens.at(-1), 1, at)).toBe(true);
  });

  it('forgets every device of one user', () => {
    const { db } = testDatabase();
    const ola = createUser(db, 'ola', { now: NOW });
    const mine = rememberDevice(db, 1, undefined, NOW);
    const theirs = rememberDevice(db, ola, undefined, NOW);
    deleteUserDevices(db, 1);
    expect(isKnownDevice(db, mine, 1, NOW)).toBe(false);
    expect(isKnownDevice(db, theirs, ola, NOW)).toBe(true);
  });
});
