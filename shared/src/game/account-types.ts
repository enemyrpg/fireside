/**
 * Account types, in the order of the `IRONMAN` varbit values (0-6).
 * RuneLite's own `AccountType` enum is deprecated and lacks
 * `UNRANKED_GROUP_IRONMAN`, so the plugin maps the varbit to these names.
 */
export const ACCOUNT_TYPES = [
  'NORMAL',
  'IRONMAN',
  'ULTIMATE_IRONMAN',
  'HARDCORE_IRONMAN',
  'GROUP_IRONMAN',
  'HARDCORE_GROUP_IRONMAN',
  'UNRANKED_GROUP_IRONMAN',
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];
