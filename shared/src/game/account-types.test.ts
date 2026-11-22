import { describe, expect, it } from 'vitest';
import { ACCOUNT_TYPES } from './account-types.js';

describe('ACCOUNT_TYPES', () => {
  it('lists the account types in IRONMAN varbit order (0-6)', () => {
    expect(ACCOUNT_TYPES).toEqual([
      'NORMAL',
      'IRONMAN',
      'ULTIMATE_IRONMAN',
      'HARDCORE_IRONMAN',
      'GROUP_IRONMAN',
      'HARDCORE_GROUP_IRONMAN',
      'UNRANKED_GROUP_IRONMAN',
    ]);
  });

  it('has no duplicates', () => {
    expect(new Set(ACCOUNT_TYPES).size).toBe(ACCOUNT_TYPES.length);
  });
});
