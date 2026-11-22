import { createHash } from 'node:crypto';
import { BRANDING } from '@fireside/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import { apiKeys, auditLog } from '../db/schema.js';
import { testDatabase, TEST_OWNER } from '../test-utils.js';
import {
  acceptedKeyPrefixes,
  activeKeyCounts,
  countActiveKeys,
  createApiKey,
  displayPrefix,
  encodeBase62,
  findApiKey,
  generateApiKey,
  hashApiKey,
  InvalidKeyNameError,
  isWellFormedApiKey,
  keyCreatedByAdmin,
  KeyLimitError,
  keyRevokedBy,
  KEY_BODY_LENGTH,
  LAST_USED_THROTTLE_MS,
  listApiKeys,
  MAX_ACTIVE_KEYS_PER_USER,
  MAX_KEY_NAME_LENGTH,
  normalizeKeyName,
  ownKey,
  revokeActiveKeys,
  revokeApiKey,
  touchLastUsed,
} from './api-keys.js';
import { createUser, FIRST_USER_ID } from '../users/users.js';

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const KEY_FORMAT = new RegExp(`^${escape(BRANDING.apiKeyPrefix)}[0-9A-Za-z]{43}$`);

describe('encodeBase62', () => {
  it('encodes 32 bytes as exactly 43 base62 characters, padding small values', () => {
    expect(encodeBase62(new Uint8Array(32))).toBe('0'.repeat(43));
    expect(encodeBase62(new Uint8Array(32).fill(0xff))).toMatch(/^[0-9A-Za-z]{43}$/);
    const one = new Uint8Array(32);
    one[31] = 61;
    expect(encodeBase62(one)).toBe(`${'0'.repeat(42)}z`);
    one[31] = 62;
    expect(encodeBase62(one)).toBe(`${'0'.repeat(41)}10`);
  });

  it('is big-endian and lossless', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index * 7);
    const encoded = encodeBase62(bytes);
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let decoded = 0n;
    for (let index = 0; index < encoded.length; index++) {
      decoded = decoded * 62n + BigInt(alphabet.indexOf(encoded.charAt(index)));
    }
    expect(decoded).toBe(BigInt(`0x${Buffer.from(bytes).toString('hex')}`));
  });

  it('throws if the value does not fit', () => {
    expect(() => encodeBase62(new Uint8Array(33).fill(0xff))).toThrow(RangeError);
  });
});

describe('generateApiKey', () => {
  it('has the branding prefix and a 43-character base62 body', () => {
    const { key, hash, displayPrefix: shown } = generateApiKey();
    expect(KEY_BODY_LENGTH).toBe(43);
    expect(key).toMatch(KEY_FORMAT);
    expect(hash).toBe(createHash('sha256').update(key).digest('hex'));
    expect(shown).toBe(key.slice(0, BRANDING.apiKeyPrefix.length + 4));
  });

  it('never repeats', () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateApiKey().key));
    expect(keys.size).toBe(1000);
  });
});

describe('hashApiKey', () => {
  it('is lowercase SHA-256 hex of the full key, prefix included', () => {
    const key = `${BRANDING.apiKeyPrefix}${'a'.repeat(43)}`;
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).not.toBe(hashApiKey(`old_${'a'.repeat(43)}`));
  });
});

describe('isWellFormedApiKey', () => {
  const body = 'A1b2'.repeat(10) + 'xyz';
  const extra = [BRANDING.apiKeyPrefix, 'old_'];

  it('accepts the current prefix by default', () => {
    expect(acceptedKeyPrefixes()[0]).toBe(BRANDING.apiKeyPrefix);
    expect(isWellFormedApiKey(BRANDING.apiKeyPrefix + body)).toBe(true);
  });

  it('accepts only the current prefix by default', () => {
    expect(acceptedKeyPrefixes()).toEqual([BRANDING.apiKeyPrefix]);
  });

  it('accepts extra prefixes only when they are passed in', () => {
    expect(isWellFormedApiKey(`old_${body}`)).toBe(false);
    expect(isWellFormedApiKey(`old_${body}`, extra)).toBe(true);
    expect(displayPrefix(`old_${body}`, extra)).toBe('old_A1b2');
  });

  it.each([
    ['unknown prefix', `xyz_${body}`],
    ['no prefix', body],
    ['short body', BRANDING.apiKeyPrefix + body.slice(1)],
    ['long body', `${BRANDING.apiKeyPrefix + body}0`],
    ['non-base62 character', BRANDING.apiKeyPrefix + body.slice(1) + '-'],
    ['whitespace', `${BRANDING.apiKeyPrefix + body} `],
    ['empty', ''],
  ])('rejects %s', (_label, key) => {
    expect(isWellFormedApiKey(key, extra)).toBe(false);
  });
});

describe('normalizeKeyName', () => {
  it('trims and keeps ordinary names, including non-ASCII ones', () => {
    expect(normalizeKeyName('  Gaming PC ')).toBe('Gaming PC');
    expect(normalizeKeyName('Café PC (Zoë) 🎮')).toBe('Café PC (Zoë) 🎮');
    expect(normalizeKeyName('-laptop')).toBe('-laptop');
    expect(normalizeKeyName('x'.repeat(MAX_KEY_NAME_LENGTH))).toHaveLength(MAX_KEY_NAME_LENGTH);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(() => normalizeKeyName('🎮'.repeat(MAX_KEY_NAME_LENGTH))).not.toThrow();
    expect(() => normalizeKeyName('🎮'.repeat(MAX_KEY_NAME_LENGTH + 1))).toThrow(
      InvalidKeyNameError,
    );
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['too long', 'x'.repeat(MAX_KEY_NAME_LENGTH + 1)],
    ['newline', 'PC\n2  evil'],
    ['carriage return', 'PC\rX'],
    ['tab', 'PC\tX'],
    ['ANSI escape', 'PC\u001b[2K'],
    ['DEL', 'PC\u007f'],
    ['C1 control', 'PC\u009b'],
    ['line separator', 'PC\u2028X'],
    ['bidi override', 'PC\u202eX'],
    ['bidi isolate', 'PC\u2066X'],
    ['left-to-right mark', 'PC\u200eX'],
    ['right-to-left mark', 'PC\u200fX'],
    ['Arabic letter mark', 'PC\u061cX'],
    ['zero-width space', 'PC\u200b1'],
    ['zero-width joiner', 'PC\u200dX'],
    ['byte order mark', 'P\ufeffC'],
    ['lone high surrogate', 'PC\ud800'],
    ['lone low surrogate', '\udc00PC'],
    ['private-use character', 'PC\ue000'],
  ])('rejects %s', (_label, name) => {
    expect(() => normalizeKeyName(name)).toThrow(InvalidKeyNameError);
  });
});

describe('stored keys', () => {
  let database: Database;
  beforeEach(() => {
    database = testDatabase();
  });
  afterEach(() => {
    database.close();
  });

  const at = new Date('2026-11-09T12:00:00.000Z');

  it('stores only the hash and display prefix, never the key', () => {
    const created = createApiKey(database.db, TEST_OWNER, 'Gaming PC', at);
    expect(created.createdAt).toBe(at.toISOString());
    const body = created.key.slice(BRANDING.apiKeyPrefix.length);

    const row = database.db.select().from(apiKeys).get();
    expect(row).toEqual({
      id: created.id,
      userId: FIRST_USER_ID,
      createdByUserId: FIRST_USER_ID,
      revokedByUserId: null,
      name: 'Gaming PC',
      keyHash: hashApiKey(created.key),
      prefix: created.key.slice(0, BRANDING.apiKeyPrefix.length + 4),
      createdAt: at.toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    });

    // Search the whole database image, not just the columns we know about.
    const image = database.sqlite.serialize().toString('latin1');
    expect(image).not.toContain(created.key);
    expect(image).not.toContain(body);
    expect(image).not.toContain(body.slice(4, 20));
  });

  it('validates the name before storing anything', () => {
    expect(() => createApiKey(database.db, TEST_OWNER, 'PC\nfake row', at)).toThrow(
      InvalidKeyNameError,
    );
    expect(listApiKeys(database.db)).toEqual([]);
    expect(createApiKey(database.db, TEST_OWNER, '  PC  ', at).name).toBe('PC');
  });

  it('lists keys without their hashes', () => {
    createApiKey(database.db, TEST_OWNER, 'A', at);
    createApiKey(database.db, TEST_OWNER, 'B', at);
    const listed = listApiKeys(database.db);
    expect(listed.map((key) => key.name)).toEqual(['A', 'B']);
    for (const key of listed) expect(key).not.toHaveProperty('keyHash');
  });

  it('finds active keys and reports revoked, unknown and malformed ones', () => {
    const created = createApiKey(database.db, TEST_OWNER, 'PC', at);
    expect(findApiKey(database.db, created.key)).toMatchObject({
      status: 'active',
      row: { id: created.id },
    });
    expect(findApiKey(database.db, generateApiKey().key)).toEqual({ status: 'unknown' });
    expect(findApiKey(database.db, 'nope')).toEqual({ status: 'malformed' });

    expect(revokeApiKey(database.db, created.id, { byUserId: FIRST_USER_ID, now: at })).toBe(
      'revoked',
    );
    expect(findApiKey(database.db, created.key)).toMatchObject({ status: 'revoked' });
  });

  it('revokes once and keeps the first revocation time', () => {
    const { id } = createApiKey(database.db, TEST_OWNER, 'PC', at);
    expect(revokeApiKey(database.db, id, { byUserId: FIRST_USER_ID, now: at })).toBe('revoked');
    expect(
      revokeApiKey(database.db, id, {
        byUserId: FIRST_USER_ID,
        now: new Date('2027-01-01T00:00:00Z'),
      }),
    ).toBe('already-revoked');
    expect(revokeApiKey(database.db, id + 1, { byUserId: FIRST_USER_ID, now: at })).toBe(
      'not-found',
    );
    expect(listApiKeys(database.db)[0]?.revokedAt).toBe(at.toISOString());
  });

  describe('ownership', () => {
    it('gives every key an owner and a creator, and finds the owner with the key', () => {
      const friend = createUser(database.db, 'friend');
      const mine = createApiKey(database.db, ownKey(FIRST_USER_ID), 'Mine', at);
      // Made by the admin for the friend.
      const theirs = createApiKey(
        database.db,
        { userId: friend, createdByUserId: FIRST_USER_ID },
        'Theirs',
        at,
      );
      expect(findApiKey(database.db, mine.key)).toMatchObject({
        status: 'active',
        row: { userId: FIRST_USER_ID, createdByUserId: FIRST_USER_ID },
      });
      expect(findApiKey(database.db, theirs.key)).toMatchObject({
        status: 'active',
        row: { userId: friend, createdByUserId: FIRST_USER_ID },
      });
    });

    it('lists one user’s keys, or everyone’s', () => {
      const friend = createUser(database.db, 'friend');
      createApiKey(database.db, ownKey(FIRST_USER_ID), 'Mine', at);
      createApiKey(database.db, ownKey(friend), 'Theirs', at);
      expect(listApiKeys(database.db, FIRST_USER_ID).map((key) => key.name)).toEqual(['Mine']);
      expect(listApiKeys(database.db, friend).map((key) => key.name)).toEqual(['Theirs']);
      expect(listApiKeys(database.db).map((key) => key.name)).toEqual(['Mine', 'Theirs']);
    });

    it('records who revoked a key', () => {
      const friend = createUser(database.db, 'friend');
      const { id } = createApiKey(database.db, ownKey(friend), 'Theirs', at);
      expect(listApiKeys(database.db)[0]?.revokedByUserId).toBeNull();
      revokeApiKey(database.db, id, { byUserId: FIRST_USER_ID, now: at });
      expect(listApiKeys(database.db)[0]).toMatchObject({
        revokedAt: at.toISOString(),
        revokedByUserId: FIRST_USER_ID,
      });
    });

    it('with ownerId, treats another user’s key as not found and leaves it active', () => {
      const friend = createUser(database.db, 'friend');
      const { id, key } = createApiKey(database.db, ownKey(friend), 'Theirs', at);
      expect(
        revokeApiKey(database.db, id, { byUserId: FIRST_USER_ID, ownerId: FIRST_USER_ID, now: at }),
      ).toBe('not-found');
      expect(findApiKey(database.db, key).status).toBe('active');
      expect(revokeApiKey(database.db, id, { byUserId: friend, ownerId: friend, now: at })).toBe(
        'revoked',
      );
    });
  });

  it('throttles last_used_at updates', () => {
    const created = createApiKey(database.db, TEST_OWNER, 'PC', at);
    const lastUsed = () => listApiKeys(database.db)[0]?.lastUsedAt;
    const touch = (now: Date) => {
      const found = findApiKey(database.db, created.key);
      if (found.status !== 'active') throw new Error('expected an active key');
      touchLastUsed(database.db, found.row, now);
    };

    touch(at);
    expect(lastUsed()).toBe(at.toISOString());

    touch(new Date(at.getTime() + LAST_USED_THROTTLE_MS - 1));
    expect(lastUsed()).toBe(at.toISOString());

    const later = new Date(at.getTime() + LAST_USED_THROTTLE_MS + 1);
    touch(later);
    expect(lastUsed()).toBe(later.toISOString());

    // The clock moved back: a future value is replaced at once.
    const earlier = new Date(at.getTime() - 60 * 60 * 1000);
    touch(earlier);
    expect(lastUsed()).toBe(earlier.toISOString());
  });
});

describe('limit, owners and revokers', () => {
  let database: Database;
  let other: number;
  beforeEach(() => {
    database = testDatabase();
    other = createUser(database.db, 'ola');
  });
  afterEach(() => {
    database.close();
  });

  const fill = (userId: number, n: number) =>
    Array.from({ length: n }, (_, i) =>
      createApiKey(database.db, ownKey(userId), `PC ${String(i)}`),
    );
  const audits = () =>
    database.db
      .select({ action: auditLog.action, actor: auditLog.actorUserId, target: auditLog.target })
      .from(auditLog)
      .all();

  it(`allows ${String(MAX_ACTIVE_KEYS_PER_USER)} active keys per user, and not one more`, () => {
    fill(FIRST_USER_ID, MAX_ACTIVE_KEYS_PER_USER);
    expect(() => createApiKey(database.db, TEST_OWNER, 'One more')).toThrow(KeyLimitError);
    expect(countActiveKeys(database.db, FIRST_USER_ID)).toBe(MAX_ACTIVE_KEYS_PER_USER);
    // Another user has their own limit; nothing was audited for the refused key.
    expect(() => fill(other, 1)).not.toThrow();
    expect(audits().filter((row) => row.action === 'key.create')).toHaveLength(
      MAX_ACTIVE_KEYS_PER_USER + 1,
    );
  });

  it('does not count revoked keys', () => {
    const [first] = fill(FIRST_USER_ID, MAX_ACTIVE_KEYS_PER_USER);
    revokeApiKey(database.db, first?.id ?? 0, { byUserId: FIRST_USER_ID });
    expect(() => createApiKey(database.db, TEST_OWNER, 'Replacement')).not.toThrow();
    expect(activeKeyCounts(database.db)).toEqual(
      new Map([[FIRST_USER_ID, MAX_ACTIVE_KEYS_PER_USER]]),
    );
  });

  it('says whose words the limit message is in', () => {
    expect(new KeyLimitError(true).message).toMatch(/^You already have/);
    expect(new KeyLimitError(false).message).toMatch(/^This user already has/);
  });

  it('tells the owner who made and who revoked a key', () => {
    const own = { userId: other, createdByUserId: other };
    expect(keyCreatedByAdmin(own)).toBe(false);
    expect(keyCreatedByAdmin({ userId: other, createdByUserId: FIRST_USER_ID })).toBe(true);
    expect(keyCreatedByAdmin({ userId: other, createdByUserId: null })).toBe(true);

    const at = '2026-11-18T12:00:00.000Z';
    expect(keyRevokedBy({ userId: other, revokedAt: null, revokedByUserId: null })).toBeNull();
    expect(keyRevokedBy({ userId: other, revokedAt: at, revokedByUserId: other })).toBe('owner');
    expect(keyRevokedBy({ userId: other, revokedAt: at, revokedByUserId: FIRST_USER_ID })).toBe(
      'admin',
    );
    // The CLI, or an admin who has since been deleted.
    expect(keyRevokedBy({ userId: other, revokedAt: at, revokedByUserId: null })).toBe('admin');
  });

  it('revokes every active key of one user, with an audit row each', () => {
    const theirs = fill(other, 2);
    const mine = fill(FIRST_USER_ID, 1);
    expect(revokeActiveKeys(database.db, other, { byUserId: FIRST_USER_ID, now: new Date() })).toBe(
      2,
    );
    expect(revokeActiveKeys(database.db, other, { byUserId: FIRST_USER_ID, now: new Date() })).toBe(
      0,
    );
    expect(countActiveKeys(database.db, other)).toBe(0);
    expect(countActiveKeys(database.db, FIRST_USER_ID)).toBe(mine.length);
    expect(audits().filter((row) => row.action === 'key.revoke')).toEqual(
      theirs.map(({ id }) => ({
        action: 'key.revoke',
        actor: FIRST_USER_ID,
        target: `key:${String(id)}`,
      })),
    );
  });

  it('never puts the key, its hash or its name in audit_log', () => {
    const created = createApiKey(database.db, TEST_OWNER, 'My secret PC');
    revokeApiKey(database.db, created.id, { byUserId: FIRST_USER_ID });
    const text = JSON.stringify(database.db.select().from(auditLog).all());
    expect(text).not.toContain(created.key);
    expect(text).not.toContain(hashApiKey(created.key));
    expect(text).not.toContain('My secret PC');
  });
});
