import { describe, expect, it } from 'vitest';
import {
  accountColor,
  accountColors,
  accountName,
  accountNameById,
  isOnline,
  parseScope,
  readLastAccount,
  sessionScope,
  storeLastAccount,
  switchAccountPath,
} from './accounts';

describe('parseScope', () => {
  it('accepts all and positive whole numbers', () => {
    expect(parseScope('all')).toBe('all');
    expect(parseScope('42')).toBe(42);
    expect(parseScope('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    undefined,
    '',
    '0',
    '01',
    '-1',
    '1.5',
    'abc',
    'ALL',
    '1e3',
    '9999999999999999',
    '99999999999999999',
  ])('rejects %s', (value) => {
    expect(parseScope(value)).toBeNull();
  });
});

describe('accountColor', () => {
  const accounts = [{ id: 391 }, { id: 1 }, { id: 222 }, { id: 5 }, { id: 7 }, { id: 900 }];

  it('follows ascending account ID, not list order', () => {
    expect(accountColor(1, accounts)).toBe('var(--acc-1)');
    expect(accountColor(5, accounts)).toBe('var(--acc-2)');
    expect(accountColor(7, accounts)).toBe('var(--acc-3)');
    expect(accountColor(222, accounts)).toBe('var(--acc-4)');
    expect(accountColor(391, accounts)).toBe('var(--acc-5)');
  });

  it('groups the sixth account on as Other', () => {
    expect(accountColor(900, accounts)).toBe('var(--afk)');
    expect(accountColor(12345, accounts)).toBe('var(--afk)');
  });

  it('is the same wherever the account appears', () => {
    expect(accountColor(222, [...accounts].reverse())).toBe('var(--acc-4)');
  });

  it('gives the same colours for every account at once', () => {
    const colors = accountColors(accounts);
    for (const { id } of accounts) expect(colors.get(id)).toBe(accountColor(id, accounts));
    expect(colors.get(12345)).toBeUndefined();
  });
});

describe('accountNameById', () => {
  const accounts = [
    { id: 1, displayName: 'Test Main' },
    { id: 2, displayName: null },
  ];

  it('names known accounts and falls back for unknown IDs', () => {
    expect(accountNameById(1, accounts)).toBe('Test Main');
    expect(accountNameById(2, accounts)).toBe('Unknown account');
    expect(accountNameById(3, accounts)).toBe('Account 3');
  });
});

describe('account display', () => {
  it('shows Unknown account before the first session.start', () => {
    expect(accountName({ displayName: null })).toBe('Unknown account');
    expect(accountName({ displayName: 'Test Main' })).toBe('Test Main');
  });

  it('is online within 3 minutes of the last heartbeat', () => {
    const now = Date.parse('2026-11-10T12:00:00.000Z');
    expect(isOnline({ lastSeenAt: '2026-11-10T11:58:30.000Z' }, now)).toBe(true);
    expect(isOnline({ lastSeenAt: '2026-11-10T11:57:00.000Z' }, now)).toBe(false);
  });
});

describe('last account', () => {
  it('round-trips through localStorage and ignores junk', () => {
    expect(readLastAccount()).toBeNull();
    storeLastAccount(7);
    expect(readLastAccount()).toBe(7);
    storeLastAccount('all');
    expect(readLastAccount()).toBe('all');
    localStorage.setItem('lastAccount', 'junk');
    expect(readLastAccount()).toBeNull();
  });
});

describe('switchAccountPath', () => {
  it('keeps the page and query string', () => {
    expect(switchAccountPath('/1/activity/screentime', '?range=7d', 'all')).toBe(
      '/all/activity/screentime?range=7d',
    );
    expect(switchAccountPath('/all', '', 3)).toBe('/3');
    expect(switchAccountPath('/1/activity/weekly/2026-W45', '', 'all')).toBe(
      '/all/activity/weekly/2026-W45',
    );
    expect(switchAccountPath('/1/progress/loot', '', 2)).toBe('/2/progress/loot');
  });
});

describe('sessionScope', () => {
  it("uses the session's account unless all accounts was the last choice", () => {
    expect(sessionScope(3, 'all')).toBe('all');
    expect(sessionScope(3, 2)).toBe(3);
    expect(sessionScope(3, null)).toBe(3);
  });
});
