import { describe, expect, it } from 'vitest';
import { schemaAsserts } from '../../test-utils.js';
import { accountDetailResponseSchema, accountsResponseSchema } from './accounts.js';

const summary = {
  id: 1,
  displayName: 'Test Main',
  accountType: 'IRONMAN',
  firstSeenAt: '2026-11-01T18:00:00.000Z',
  lastSeenAt: '2026-11-08T21:00:00.000Z',
  totalLevel: 1850,
  totalXp: 123456789,
};

describe('GET /accounts', () => {
  const list = schemaAsserts(accountsResponseSchema);

  it('accepts a list of accounts', () => {
    list.accepts({ accounts: [summary] });
    list.accepts({ accounts: [] });
  });

  it('accepts an account without XP data yet', () => {
    list.accepts({ accounts: [{ ...summary, totalLevel: null, totalXp: null }] });
  });

  it('accepts an account without a session.start yet (no name or type)', () => {
    list.accepts({ accounts: [{ ...summary, displayName: null, accountType: null }] });
  });

  it.each([
    ['id', 0],
    ['displayName', ''],
    ['accountType', 'ironman'],
    ['accountType', 'DEADMAN'],
    ['lastSeenAt', '2026-11-08'],
    ['totalXp', -1],
  ])('rejects %s = %j', (field, value) => {
    expect(list.issuePaths({ accounts: [{ ...summary, [field]: value }] })).toContain(
      `accounts.0.${field}`,
    );
  });

  it('does not expose the account hash', () => {
    list.rejects({ accounts: [{ ...summary, accountHash: '1234567890123456789' }] });
  });
});

describe('GET /accounts/:accountId', () => {
  const detail = schemaAsserts(accountDetailResponseSchema);
  const names = [
    {
      displayName: 'OldName',
      firstSeenAt: '2026-11-01T18:00:00.000Z',
      lastSeenAt: '2026-11-03T18:00:00.000Z',
    },
    {
      displayName: 'Test Main',
      firstSeenAt: '2026-11-04T18:00:00.000Z',
      lastSeenAt: '2026-11-08T21:00:00.000Z',
    },
  ];

  it('accepts an account with name history', () => {
    detail.accepts({ ...summary, names });
  });

  it('requires names and rejects extra keys', () => {
    detail.rejects(summary);
    detail.rejects({ ...summary, names, extra: 1 });
    detail.rejects({ ...summary, names: [{ ...names[0], displayName: '' }] });
  });
});
