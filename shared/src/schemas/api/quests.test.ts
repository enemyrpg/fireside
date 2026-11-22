import { describe, expect, it } from 'vitest';
import { diariesResponseSchema, questsResponseSchema, questTotalsOf } from './quests.js';

const AT = '2026-11-08T19:42:13.512Z';

function paths(schema: typeof questsResponseSchema | typeof diariesResponseSchema, data: unknown) {
  const result = schema.safeParse(data);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('quests response', () => {
  const quest = (quest: string, name: string, state: string, kind = 'QUEST') => ({
    quest,
    name,
    kind,
    state,
    finishedAt: null,
  });
  const quests = [
    quest('BEAR_YOUR_SOUL', 'Bear Your Soul', 'FINISHED', 'MINIQUEST'),
    quest('COOKS_ASSISTANT', "Cook's Assistant", 'FINISHED'),
    quest('DRAGON_SLAYER_I', 'Dragon Slayer I', 'IN_PROGRESS'),
  ];
  const response = {
    accountId: 1,
    updatedAt: AT,
    questPoints: 1,
    totals: { total: 2, finished: 1, inProgress: 1, notStarted: 0 },
    miniquestTotals: { total: 1, finished: 1, inProgress: 0, notStarted: 0 },
    quests,
  };

  it('accepts quests and miniquests counted apart', () => {
    expect(paths(questsResponseSchema, response)).toEqual([]);
  });

  it('counts each kind on its own', () => {
    expect(questTotalsOf(quests, 'QUEST')).toEqual(response.totals);
    expect(questTotalsOf(quests, 'MINIQUEST')).toEqual(response.miniquestTotals);
  });

  it('rejects totals that include miniquests', () => {
    expect(
      paths(questsResponseSchema, {
        ...response,
        totals: { total: 3, finished: 2, inProgress: 1, notStarted: 0 },
      }),
    ).toEqual(['totals.total', 'totals.finished']);
  });

  it('accepts a date on a finished quest only', () => {
    const dated = (index: number) =>
      quests.map((entry, i) => (i === index ? { ...entry, finishedAt: AT } : entry));
    expect(paths(questsResponseSchema, { ...response, quests: dated(1) })).toEqual([]);
    expect(paths(questsResponseSchema, { ...response, quests: dated(2) })).toEqual([
      'quests.2.finishedAt',
    ]);
  });

  it('rejects unsorted and duplicate quests', () => {
    expect(
      paths(questsResponseSchema, { ...response, quests: [quests[1], quests[0], quests[2]] }),
    ).toContain('quests.1');
    expect(
      paths(questsResponseSchema, { ...response, quests: [quests[0], quests[1], quests[1]] }),
    ).toContain('quests.2.quest');
  });

  it('has no quests or points before the first snapshot', () => {
    expect(paths(questsResponseSchema, { ...response, updatedAt: null })).toEqual(['updatedAt']);
  });
});

describe('diaries response', () => {
  const tiers = (completed: number) =>
    (['EASY', 'MEDIUM', 'HARD', 'ELITE'] as const).map((tier, index) => ({
      tier,
      completed: index < completed,
      completedAt: null,
    }));
  const response = {
    accountId: 1,
    updatedAt: AT,
    totals: { tiers: 8, completed: 6, regionsCompleted: 1 },
    regions: [
      { region: 'ARDOUGNE', name: 'Ardougne', completed: 2, tiers: tiers(2) },
      { region: 'FALADOR', name: 'Falador', completed: 4, tiers: tiers(4) },
    ],
  };

  it('accepts regions with tiers easiest first', () => {
    expect(paths(diariesResponseSchema, response)).toEqual([]);
  });

  it('does not count a region with fewer than four tiers as completed', () => {
    const partial = {
      region: 'NEW_REGION',
      name: 'New Region',
      completed: 2,
      tiers: tiers(2).slice(0, 2),
    };
    const regions = [response.regions[0], response.regions[1], partial];
    expect(
      paths(diariesResponseSchema, {
        ...response,
        totals: { tiers: 10, completed: 8, regionsCompleted: 1 },
        regions,
      }),
    ).toEqual([]);
    expect(
      paths(diariesResponseSchema, {
        ...response,
        totals: { tiers: 10, completed: 8, regionsCompleted: 2 },
        regions,
      }),
    ).toEqual(['totals.regionsCompleted']);
  });

  it('rejects a wrong count, a wrong tier order and a date on an incomplete tier', () => {
    const [ardougne, falador] = response.regions;
    expect(
      paths(diariesResponseSchema, {
        ...response,
        regions: [{ ...ardougne, completed: 3 }, falador],
      }),
    ).toContain('regions.0.completed');
    expect(
      paths(diariesResponseSchema, {
        ...response,
        regions: [{ ...ardougne, tiers: [...tiers(2)].reverse() }, falador],
      }),
    ).toContain('regions.0.tiers.1.tier');
    const dated = tiers(2).map((tier) => ({ ...tier, completedAt: AT }));
    expect(
      paths(diariesResponseSchema, {
        ...response,
        regions: [{ ...ardougne, tiers: dated }, falador],
      }),
    ).toEqual(['regions.0.tiers.2.completedAt', 'regions.0.tiers.3.completedAt']);
  });

  it('has no regions before the first snapshot', () => {
    expect(paths(diariesResponseSchema, { ...response, updatedAt: null })).toEqual(['updatedAt']);
  });
});
