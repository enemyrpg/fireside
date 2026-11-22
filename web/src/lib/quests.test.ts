import type { DiariesResponse, QuestResponse } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import { groupQuests, questsHref, recentCompletions, searchQuests } from './quests';

function quest(
  name: string,
  state: QuestResponse['state'],
  extra: Partial<QuestResponse> = {},
): QuestResponse {
  return {
    quest: name.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_'),
    name,
    kind: 'QUEST',
    state,
    finishedAt: null,
    ...extra,
  };
}

const QUESTS = [
  quest("Alfred Grimhand's Barcrawl", 'FINISHED', { kind: 'MINIQUEST' }),
  quest('Bear Your Soul', 'NOT_STARTED', { kind: 'MINIQUEST' }),
  quest("Cook's Assistant", 'FINISHED'),
  quest('Desert Treasure II', 'NOT_STARTED'),
  quest('Dragon Slayer I', 'FINISHED', { finishedAt: '2026-10-20T18:05:00.000Z' }),
  quest('Dragon Slayer II', 'IN_PROGRESS'),
];

const names = (quests: readonly QuestResponse[]) => quests.map((entry) => entry.name);

describe('questsHref', () => {
  it('links to the page of an account or all', () => {
    expect(questsHref(3)).toBe('/3/collections/quests');
    expect(questsHref('all')).toBe('/all/collections/quests');
  });
});

describe('groupQuests', () => {
  it('groups quests by state and keeps miniquests in their own group, in the given order', () => {
    const groups = groupQuests(QUESTS);
    expect(names(groups.inProgress)).toEqual(['Dragon Slayer II']);
    expect(names(groups.notStarted)).toEqual(['Desert Treasure II']);
    expect(names(groups.completed)).toEqual(["Cook's Assistant", 'Dragon Slayer I']);
    expect(names(groups.miniquests)).toEqual(["Alfred Grimhand's Barcrawl", 'Bear Your Soul']);
  });

  it('has every group for an empty list', () => {
    expect(groupQuests([])).toEqual({
      inProgress: [],
      notStarted: [],
      completed: [],
      miniquests: [],
    });
  });
});

describe('searchQuests', () => {
  it('matches part of the name, ignoring case and spaces around the query', () => {
    expect(names(searchQuests(QUESTS, '  dragon '))).toEqual([
      'Dragon Slayer I',
      'Dragon Slayer II',
    ]);
    expect(names(searchQuests(QUESTS, 'SOUL'))).toEqual(['Bear Your Soul']);
    expect(searchQuests(QUESTS, 'zzz')).toEqual([]);
  });

  it('matches everything for an empty query', () => {
    expect(searchQuests(QUESTS, '  ')).toEqual(QUESTS);
  });
});

describe('recentCompletions', () => {
  const regions: DiariesResponse['regions'] = [
    {
      region: 'ARDOUGNE',
      name: 'Ardougne',
      completed: 3,
      tiers: [
        { tier: 'EASY', completed: true, completedAt: null },
        { tier: 'MEDIUM', completed: true, completedAt: '2026-10-01T10:00:00.000Z' },
        { tier: 'HARD', completed: true, completedAt: '2026-11-06T10:00:00.000Z' },
        { tier: 'ELITE', completed: false, completedAt: null },
      ],
    },
  ];

  it('mixes quests and diary tiers, newest first, without the dateless ones', () => {
    expect(recentCompletions(QUESTS, regions)).toEqual([
      {
        kind: 'diary',
        key: 'diary:ARDOUGNE:HARD',
        name: 'Ardougne',
        tier: 'HARD',
        at: '2026-11-06T10:00:00.000Z',
      },
      {
        kind: 'quest',
        key: 'quest:DRAGON_SLAYER_I',
        name: 'Dragon Slayer I',
        at: '2026-10-20T18:05:00.000Z',
      },
      {
        kind: 'diary',
        key: 'diary:ARDOUGNE:MEDIUM',
        name: 'Ardougne',
        tier: 'MEDIUM',
        at: '2026-10-01T10:00:00.000Z',
      },
    ]);
  });

  it('keeps the newest five, miniquests included', () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      quest(`Quest ${String(index)}`, 'FINISHED', {
        kind: index === 6 ? 'MINIQUEST' : 'QUEST',
        finishedAt: `2026-11-0${String(index + 1)}T12:00:00.000Z`,
      }),
    );
    expect(recentCompletions(many, []).map((entry) => entry.name)).toEqual([
      'Quest 6',
      'Quest 5',
      'Quest 4',
      'Quest 3',
      'Quest 2',
    ]);
  });

  it('is empty when nothing has a date', () => {
    expect(recentCompletions([quest('Old', 'FINISHED')], [])).toEqual([]);
  });
});
