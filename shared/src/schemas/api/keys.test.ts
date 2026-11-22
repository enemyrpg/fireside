import { describe, expect, it } from 'vitest';
import { BRANDING } from '../../branding.js';
import { schemaAsserts, without } from '../../test-utils.js';
import {
  adminApiKeySchema,
  adminKeysResponseSchema,
  apiKeySchema,
  createKeyRequestSchema,
  createKeyResponseSchema,
  createUserKeyResponseSchema,
  keyParamsSchema,
  keysResponseSchema,
} from './keys.js';

const active = {
  id: 1,
  name: 'Gaming PC',
  prefix: `${BRANDING.apiKeyPrefix}a1b2`,
  createdAt: '2026-11-01T18:00:00.000Z',
  lastUsedAt: '2026-11-10T19:30:00.000Z',
  revokedAt: null,
  revokedBy: null,
  createdByAdmin: false,
};
const revoked = { revokedAt: '2026-11-11T08:00:00.000Z', revokedBy: 'owner' } as const;
const fullKey = `${BRANDING.apiKeyPrefix}${'a1B2'.repeat(10)}xyz`;

describe('API key (list row)', () => {
  const key = schemaAsserts(apiKeySchema);

  it('accepts active, never used and revoked keys', () => {
    key.accepts(active);
    key.accepts({ ...active, lastUsedAt: null });
    key.accepts({ ...active, ...revoked });
    key.accepts({ ...active, ...revoked, revokedBy: 'admin', createdByAdmin: true });
  });

  it('only knows owner and admin as the revoker', () => {
    expect(key.issuePaths({ ...active, ...revoked, revokedBy: 'cli' })).toContain('revokedBy');
  });

  it('never accepts a hash or the full key', () => {
    key.rejects({ ...active, keyHash: 'ab'.repeat(32) });
    key.rejects({ ...active, key: fullKey });
  });

  it.each([
    'lastUsedAt',
    'revokedAt',
    'revokedBy',
    'createdByAdmin',
    'createdAt',
    'prefix',
    'name',
    'id',
  ] as const)('requires %s', (field) => {
    key.rejects(without(active, field));
  });

  it.each([
    ['id', 0],
    ['name', ''],
    ['createdAt', '2026-11-01'],
    ['lastUsedAt', '2026-11-10T19:30:00+01:00'],
  ])('rejects %s = %j', (field, value) => {
    expect(key.issuePaths({ ...active, [field]: value })).toContain(field);
  });
});

describe('GET /keys response', () => {
  const list = schemaAsserts(keysResponseSchema);

  it('accepts a list and an empty list', () => {
    list.accepts({ keys: [active] });
    list.accepts({ keys: [] });
  });

  it('rejects unknown fields', () => {
    list.rejects({ keys: [], total: 0 });
  });
});

describe('POST /keys request', () => {
  const request = schemaAsserts(createKeyRequestSchema);

  it('accepts any string name (the name rule is checked by the server)', () => {
    request.accepts({ name: 'Gaming PC' });
    request.accepts({ name: '' });
  });

  it('rejects a missing or non-string name and unknown fields', () => {
    request.rejects({});
    request.rejects({ name: 5 });
    request.rejects({ name: 'PC', prefix: 'x' });
  });
});

describe('POST /keys response', () => {
  const created = schemaAsserts(createKeyResponseSchema);
  const valid = { apiKey: { ...active, lastUsedAt: null }, key: fullKey };

  it('accepts a new key', () => {
    created.accepts(valid);
  });

  it('rejects an empty key', () => {
    expect(created.issuePaths({ ...valid, key: '' })).toContain('key');
  });

  it('requires both parts', () => {
    created.rejects(without(valid, 'key'));
    created.rejects(without(valid, 'apiKey'));
  });
});

const ola = { id: 2, username: 'ola' };
const admin = { id: 1, username: 'admin' };
const adminRow = { ...active, owner: ola, createdBy: admin, revokedByUser: null };

describe('admin key row (GET /admin/keys)', () => {
  const row = schemaAsserts(adminApiKeySchema);
  const list = schemaAsserts(adminKeysResponseSchema);

  it('accepts a key with owner, creator and revoker, deleted ones as null', () => {
    row.accepts(adminRow);
    row.accepts({ ...adminRow, ...revoked, revokedBy: 'admin', revokedByUser: admin });
    row.accepts({ ...adminRow, createdBy: null, revokedByUser: null });
    list.accepts({ keys: [adminRow] });
    list.accepts({ keys: [] });
  });

  it('always has an owner, and never a hash or the key', () => {
    row.rejects({ ...adminRow, owner: null });
    row.rejects(without(adminRow, 'owner'));
    row.rejects({ ...adminRow, keyHash: 'ab'.repeat(32) });
    row.rejects({ ...adminRow, key: fullKey });
  });
});

describe('POST /users/:id/keys response', () => {
  const created = schemaAsserts(createUserKeyResponseSchema);

  it('accepts a new key with its owner', () => {
    created.accepts({ apiKey: { ...adminRow, createdByAdmin: true }, key: fullKey });
  });

  it('requires the key', () => {
    created.rejects({ apiKey: adminRow });
    expect(created.issuePaths({ apiKey: adminRow, key: '' })).toContain('key');
  });
});

describe('DELETE /keys/:id params', () => {
  const params = schemaAsserts(keyParamsSchema);

  it('parses a positive whole number', () => {
    expect(params.accepts({ id: '12' })).toEqual({ id: 12 });
  });

  it.each(['0', '01', 'abc', '-1', '1.0', ''])('rejects %j', (id) => {
    expect(params.issuePaths({ id })).toContain('id');
  });
});
