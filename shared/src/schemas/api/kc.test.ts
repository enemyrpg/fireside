import { describe, expect, it } from 'vitest';
import { schemaAsserts } from '../../test-utils.js';
import { kcResponseSchema } from './kc.js';

describe('kc response', () => {
  const response = schemaAsserts(kcResponseSchema);
  const vorkath = {
    boss: 'Vorkath',
    killCount: 412,
    lastObservedAt: '2026-11-08T19:42:13.512Z',
    bestTimeSeconds: 74.4,
    gainedLast30Days: 12,
    byAccount: [
      { accountId: 1, killCount: 400 },
      { accountId: 2, killCount: 12 },
    ],
    category: 'boss',
    raid: null,
    bestTimesByTeamSize: [],
  };
  const toa = {
    ...vorkath,
    boss: 'Tombs of Amascut: Expert Mode',
    killCount: 140,
    byAccount: [{ accountId: 1, killCount: 140 }],
    bestTimeSeconds: 1300.2,
    category: 'raid',
    raid: 'Tombs of Amascut',
    bestTimesByTeamSize: [
      { teamSize: 1, seconds: 1750 },
      { teamSize: 3, seconds: 1300.2 },
    ],
  };

  it('accepts the latest KC per boss', () => {
    response.accepts({
      bosses: [
        vorkath,
        {
          ...vorkath,
          boss: 'Zulrah',
          killCount: 5,
          bestTimeSeconds: null,
          gainedLast30Days: 0,
          byAccount: [{ accountId: 3, killCount: 5 }],
        },
      ],
    });
    response.accepts({ bosses: [] });
  });

  it('accepts a raid mode with best times per team size', () => {
    response.accepts({ bosses: [toa] });
  });

  it.each([
    ['raid without category raid', { ...toa, category: 'boss' }],
    ['category raid without raid', { ...toa, raid: null }],
  ])('rejects %s', (_name, kc) => {
    expect(response.issuePaths({ bosses: [kc] })).toContain('bosses.0.raid');
  });

  it.each([
    ['category', 'minigame'],
    ['raid', ''],
    ['bestTimesByTeamSize', [{ teamSize: 0, seconds: 1 }]],
    ['bestTimesByTeamSize', [{ teamSize: 101, seconds: 1 }]],
    ['bestTimesByTeamSize', [{ teamSize: 2, seconds: 0 }]],
    ['bestTimesByTeamSize', [{ teamSize: 2, seconds: 1, extra: 1 }]],
  ])('rejects raid %s = %j', (field, value) => {
    expect(
      response
        .issuePaths({ bosses: [{ ...toa, [field]: value }] })
        .some((path) => path.startsWith(`bosses.0.${field}`)),
    ).toBe(true);
  });

  it.each([
    [
      'unsorted',
      [
        { teamSize: 3, seconds: 1300 },
        { teamSize: 1, seconds: 1750 },
      ],
    ],
    [
      'duplicate',
      [
        { teamSize: 3, seconds: 1300 },
        { teamSize: 3, seconds: 1400 },
      ],
    ],
  ])('rejects %s bestTimesByTeamSize', (_name, bestTimesByTeamSize) => {
    expect(response.issuePaths({ bosses: [{ ...toa, bestTimesByTeamSize }] })).toContain(
      'bosses.0.bestTimesByTeamSize.1.teamSize',
    );
  });

  it.each([
    ['boss', ''],
    ['killCount', 0],
    ['gainedLast30Days', -1],
    ['gainedLast30Days', 1.5],
    ['byAccount', []],
    ['bestTimeSeconds', 0],
    ['lastObservedAt', '2026-11-08'],
  ])('rejects %s = %j', (field, value) => {
    expect(response.issuePaths({ bosses: [{ ...vorkath, [field]: value }] })).toContain(
      `bosses.0.${field}`,
    );
  });

  it('requires killCount to be the sum of byAccount', () => {
    expect(response.issuePaths({ bosses: [{ ...vorkath, killCount: 411 }] })).toContain(
      'bosses.0.killCount',
    );
  });

  it.each([
    [
      'unsorted',
      [
        { accountId: 2, killCount: 12 },
        { accountId: 1, killCount: 400 },
      ],
    ],
    [
      'duplicate',
      [
        { accountId: 1, killCount: 400 },
        { accountId: 1, killCount: 12 },
      ],
    ],
  ])('rejects %s byAccount', (_name, byAccount) => {
    expect(response.issuePaths({ bosses: [{ ...vorkath, byAccount }] })).toContain(
      'bosses.0.byAccount.1.accountId',
    );
  });

  it('rejects a byAccount entry with zero KC or extra fields', () => {
    const bad = (entry: object) => ({
      bosses: [{ ...vorkath, byAccount: [entry, { accountId: 2, killCount: 12 }] }],
    });
    expect(response.issuePaths(bad({ accountId: 1, killCount: 0 }))).toContain(
      'bosses.0.byAccount.0.killCount',
    );
    response.rejects(bad({ accountId: 1, killCount: 400, displayName: 'x' }));
  });
});
