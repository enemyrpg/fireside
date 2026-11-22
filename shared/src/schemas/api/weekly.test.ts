import { describe, expect, it } from 'vitest';
import { schemaAsserts } from '../../test-utils.js';
import { weeklyQuerySchema, weeklyResponseSchema } from './weekly.js';

const drop = {
  lootEventId: 17,
  accountId: 1,
  sessionId: '01933c40-1111-7aaa-bbbb-ccccdddd0001',
  occurredAt: '2026-11-08T19:42:13.512Z',
  source: { type: 'NPC', name: 'Vorkath' },
  itemId: 11286,
  name: 'Draconic visage',
  quantity: 1,
  gePriceEach: 2850000,
  haPriceEach: 60000,
  geValue: 2850000,
  haValue: 60000,
};

const valid = {
  week: '2026-W45',
  start: '2026-11-01T23:00:00.000Z',
  end: '2026-11-08T23:00:00.000Z',
  complete: true,
  computedAt: '2026-11-09T00:05:00.000Z',
  playtime: {
    playedSeconds: 36000,
    activeSeconds: 30000,
    afkSeconds: 6000,
    previousWeekPlayedSeconds: 28000,
    mostPlayedWorld: 420,
  },
  xp: {
    xpGained: 1500000,
    levelsGained: 4,
    topSkills: [
      { skill: 'SLAYER', xpGained: 800000 },
      { skill: 'HITPOINTS', xpGained: 300000 },
      { skill: 'RANGED', xpGained: 250000 },
    ],
  },
  loot: { geValue: 12000000, topDrops: [drop] },
  kc: { bosses: [{ boss: 'Vorkath', gained: 18 }] },
  pets: null,
  bank: null,
  collectionLog: null,
  quests: null,
};

const pet = {
  accountId: 1,
  itemId: 21992,
  name: 'Vorki',
  obtainedAt: '2026-11-05T19:42:13.512Z',
  approximate: false,
  source: { type: 'ACTIVITY', name: 'Vorkath' },
  killCount: 1204,
  xp: null,
  confirmed: true,
  origin: 'CHAT',
};

const bank = {
  startGeValue: 2_410_000_000,
  endGeValue: 2_418_630_000,
  days: [
    { date: '2026-11-02', geValue: 2_410_000_000 },
    { date: '2026-11-03', geValue: 2_418_630_000 },
  ],
};

const clogItem = {
  accountId: 1,
  itemId: 11286,
  name: 'Draconic visage',
  page: 'Vorkath',
  firstSeenAt: '2026-11-08T19:42:13.512Z',
  approximate: false,
};

const collectionLog = { newItems: 3, obtained: 712, total: 1568, recentItems: [clogItem] };

const quests = {
  questPointsGained: 2,
  quests: [
    {
      accountId: 1,
      quest: 'DRAGON_SLAYER_II',
      name: 'Dragon Slayer II',
      kind: 'QUEST',
      finishedAt: '2026-11-06T18:00:00.000Z',
    },
  ],
  diaries: [
    {
      accountId: 1,
      region: 'KANDARIN',
      name: 'Kandarin',
      tier: 'HARD',
      completedAt: '2026-11-04T18:00:00.000Z',
    },
  ],
};

const full = { ...valid, pets: { pets: [pet] }, bank, collectionLog, quests };

describe('weekly query', () => {
  const query = schemaAsserts(weeklyQuerySchema);

  it('accepts a week or nothing (current week)', () => {
    expect(query.accepts({ week: '2026-W45' })).toEqual({ week: '2026-W45' });
    expect(query.accepts({})).toEqual({});
  });

  it.each(['2026-45', '2026-W54', 'last'])('rejects week %j', (week) => {
    expect(query.issuePaths({ week })).toContain('week');
  });
});

describe('weekly response', () => {
  const response = schemaAsserts(weeklyResponseSchema);

  it('accepts a full summary', () => {
    response.accepts(valid);
  });

  it('accepts empty sections as null', () => {
    response.accepts({ ...valid, complete: false, playtime: null, xp: null, loot: null, kc: null });
  });

  it('rejects more than 3 top skills', () => {
    const topSkills = [...valid.xp.topSkills, { skill: 'MAGIC', xpGained: 1 }];
    expect(response.issuePaths({ ...valid, xp: { ...valid.xp, topSkills } })).toContain(
      'xp.topSkills',
    );
  });

  it('rejects more than 5 top drops', () => {
    const topDrops = Array.from({ length: 6 }, () => drop);
    expect(response.issuePaths({ ...valid, loot: { ...valid.loot, topDrops } })).toContain(
      'loot.topDrops',
    );
  });

  it('rejects a top drop from a named player', () => {
    const topDrops = [{ ...drop, source: { type: 'PLAYER', name: 'Test Main' } }];
    response.rejects({ ...valid, loot: { ...valid.loot, topDrops } });
  });

  it('rejects a KC section without bosses and zero gains', () => {
    response.rejects({ ...valid, kc: { bosses: [] } });
    response.rejects({ ...valid, kc: { bosses: [{ boss: 'Vorkath', gained: 0 }] } });
  });

  it('rejects playtime that does not add up', () => {
    expect(
      response.issuePaths({ ...valid, playtime: { ...valid.playtime, afkSeconds: 0 } }),
    ).toContain('playtime.playedSeconds');
  });

  it('rejects unknown sections (later phases add them in a new contract version)', () => {
    response.rejects({ ...valid, goals: null });
  });

  it('requires the sections of 1.28.0, as null or with content', () => {
    response.accepts(full);
    for (const section of ['pets', 'bank', 'collectionLog', 'quests'] as const) {
      const rest = Object.fromEntries(Object.entries(full).filter(([key]) => key !== section));
      response.rejects(rest);
    }
  });

  it('rejects a pets section without pets, without a time or oldest first', () => {
    response.rejects({ ...full, pets: { pets: [] } });
    const undated = { ...pet, itemId: 13262, obtainedAt: null, origin: 'CLOG', source: null };
    expect(
      response.issuePaths({ ...full, pets: { pets: [{ ...undated, killCount: null }] } }),
    ).toContain('pets.pets.0.obtainedAt');
    const later = { ...pet, itemId: 13262, obtainedAt: '2026-11-06T10:00:00.000Z' };
    expect(response.issuePaths({ ...full, pets: { pets: [pet, later] } })).toContain('pets.pets.1');
  });

  it('accepts a bank section without a start value', () => {
    response.accepts({ ...full, bank: { ...bank, startGeValue: null } });
  });

  it('rejects bank days out of order, more than 7 and an end that is not the last day', () => {
    const [first, second] = bank.days;
    expect(response.issuePaths({ ...full, bank: { ...bank, days: [second, first] } })).toContain(
      'bank.days.1.date',
    );
    expect(response.issuePaths({ ...full, bank: { ...bank, endGeValue: 1 } })).toContain(
      'bank.endGeValue',
    );
    response.rejects({ ...full, bank: { ...bank, days: [] } });
    const days = Array.from({ length: 8 }, (_, index) => ({
      date: `2026-11-0${String(index + 1)}`,
      geValue: bank.endGeValue,
    }));
    response.rejects({ ...full, bank: { ...bank, days } });
  });

  it('accepts a collection log section without counts', () => {
    response.accepts({ ...full, collectionLog: { ...collectionLog, obtained: null, total: null } });
  });

  it('rejects a collection log section that does not add up', () => {
    const paths = (section: object) =>
      response.issuePaths({ ...full, collectionLog: { ...collectionLog, ...section } });
    expect(paths({ total: null })).toContain('collectionLog.total');
    expect(paths({ obtained: 1569 })).toContain('collectionLog.obtained');
    expect(paths({ newItems: 0 })).toContain('collectionLog.newItems');
    expect(paths({ newItems: 1, recentItems: [clogItem, { ...clogItem, itemId: 1 }] })).toContain(
      'collectionLog.newItems',
    );
    expect(paths({ recentItems: Array.from({ length: 6 }, () => clogItem) })).toContain(
      'collectionLog.recentItems',
    );
    const newer = { ...clogItem, itemId: 1, firstSeenAt: '2026-11-08T20:00:00.000Z' };
    expect(paths({ recentItems: [clogItem, newer] })).toContain('collectionLog.recentItems.1');
  });

  it('accepts quest points alone and rejects an empty quests section', () => {
    response.accepts({ ...full, quests: { questPointsGained: 1, quests: [], diaries: [] } });
    expect(
      response.issuePaths({ ...full, quests: { questPointsGained: 0, quests: [], diaries: [] } }),
    ).toContain('quests');
  });

  it('rejects quests and diary tiers that are oldest first', () => {
    const [quest] = quests.quests;
    const [tier] = quests.diaries;
    const laterQuest = {
      ...quest,
      quest: 'COOKS_ASSISTANT',
      finishedAt: '2026-11-07T18:00:00.000Z',
    };
    const laterTier = { ...tier, tier: 'ELITE', completedAt: '2026-11-07T18:00:00.000Z' };
    expect(
      response.issuePaths({ ...full, quests: { ...quests, quests: [quest, laterQuest] } }),
    ).toContain('quests.quests.1');
    expect(
      response.issuePaths({ ...full, quests: { ...quests, diaries: [tier, laterTier] } }),
    ).toContain('quests.diaries.1');
  });

  it('rejects end before or equal to start', () => {
    expect(response.issuePaths({ ...valid, end: valid.start })).toContain('end');
  });

  it('rejects a bad week key', () => {
    expect(response.issuePaths({ ...valid, week: '2026-45' })).toContain('week');
  });
});
