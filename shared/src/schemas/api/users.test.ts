import { describe, it } from 'vitest';
import { schemaAsserts, without } from '../../test-utils.js';
import { managedUserSchema, updateUserRequestSchema, userParamsSchema } from './users.js';

const user = {
  id: 2,
  username: 'ola',
  role: 'member',
  canCreateApiKeys: true,
  createdAt: '2026-11-18T10:00:00.000Z',
  lastLoginAt: null,
  disabledAt: null,
  isSelf: false,
  activeApiKeys: 2,
  twoFactorEnabled: false,
};

describe('user (Settings → Users row)', () => {
  const row = schemaAsserts(managedUserSchema);

  it('accepts active and disabled users', () => {
    row.accepts(user);
    row.accepts({ ...user, disabledAt: '2026-11-18T12:00:00.000Z', lastLoginAt: user.createdAt });
  });

  it('counts active keys as a whole number from 0', () => {
    row.accepts({ ...user, activeApiKeys: 0 });
    row.rejects({ ...user, activeApiKeys: -1 });
    row.rejects({ ...user, activeApiKeys: 1.5 });
  });

  it('never accepts secrets', () => {
    row.rejects({ ...user, passwordHash: '$argon2id$x' });
    row.rejects({ ...user, totpSecret: 'ABC' });
  });

  it.each([
    'role',
    'canCreateApiKeys',
    'disabledAt',
    'isSelf',
    'activeApiKeys',
    'twoFactorEnabled',
  ] as const)('requires %s', (field) => {
    row.rejects(without(user, field));
  });
});

describe('PATCH /users/:id', () => {
  const request = schemaAsserts(updateUserRequestSchema);

  it('accepts any subset of the fields', () => {
    request.accepts({ disabled: true });
    request.accepts({ role: 'admin', canCreateApiKeys: false, username: 'kari' });
    request.accepts({ canCreateApiKeys: false, revokeActiveKeys: true });
  });

  it('rejects unknown fields and wrong types', () => {
    request.rejects({ passwordHash: 'x' });
    request.rejects({ role: 'owner' });
    request.rejects({ disabled: 'yes' });
    request.rejects({ revokeActiveKeys: 'all' });
  });

  it('takes a positive whole number as the ID', () => {
    const params = schemaAsserts(userParamsSchema);
    params.accepts({ id: '2' });
    params.rejects({ id: '0' });
    params.rejects({ id: 'me' });
  });
});
