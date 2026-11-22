import { describe, expect, it } from 'vitest';
import { eventFactory, expectOrderIndependent } from './testing.js';

type Row = Record<string, unknown>;

interface Tables {
  snapshots: Row[];
  states: Row[];
  completions: Row[];
}

/** Quest tables, checked to be the same in any order, with failures and after a rebuild. */
function quests(...events: Parameters<typeof expectOrderIndependent>[0]): Tables {
  return expectOrderIndependent(events).quests as Tables;
}

function diaries(...events: Parameters<typeof expectOrderIndependent>[0]): Tables {
  return expectOrderIndependent(events).diaries as Tables;
}

const OTHER_ACCOUNT = '-42';
const at = (time: string) => `2026-11-08T${time}:00.000Z`;

describe('quests projection', () => {
  it('stores quests-snapshot.json with names, states and kinds', () => {
    const f = eventFactory();
    const event = f.fromFixture('quests-snapshot.json', '19:00');
    const { snapshots, states, completions } = quests(event);
    expect(snapshots).toEqual([
      expect.objectContaining({ eventId: event.eventId, takenAt: at('19:00'), questPoints: 4 }),
    ]);
    expect(states.map((row) => [row.quest, row.name, row.state, row.kind])).toEqual([
      ['ALFRED_GRIMHANDS_BARCRAWL', "Alfred Grimhand's Barcrawl", 'FINISHED', 'MINIQUEST'],
      ['BEAR_YOUR_SOUL', 'Bear Your Soul', 'NOT_STARTED', 'MINIQUEST'],
      ['COOKS_ASSISTANT', "Cook's Assistant", 'FINISHED', 'QUEST'],
      [
        'DESERT_TREASURE_II__THE_FALLEN_EMPIRE',
        'Desert Treasure II - The Fallen Empire',
        'NOT_STARTED',
        'QUEST',
      ],
      ['DRAGON_SLAYER_I', 'Dragon Slayer I', 'FINISHED', 'QUEST'],
      ['DRAGON_SLAYER_II', 'Dragon Slayer II', 'IN_PROGRESS', 'QUEST'],
    ]);
    expect(completions.map((row) => row.quest)).toEqual([
      'ALFRED_GRIMHANDS_BARCRAWL',
      'COOKS_ASSISTANT',
      'DRAGON_SLAYER_I',
    ]);
  });

  it('stores an entry without kind as null and an unknown quest as sent', () => {
    const f = eventFactory();
    const { states } = quests(
      f.fromFixture('quests-snapshot-without-kind.json', '18:00'),
      f.fromFixture('quests-snapshot-unknown-quest.json', '19:00'),
    );
    expect(states.map((row) => [row.quest, row.name, row.kind])).toEqual([
      ['COOKS_ASSISTANT', "Cook's Assistant", 'QUEST'],
      ['SOME_NEW_QUEST_2', 'Some New Quest 2', 'QUEST'],
    ]);
    const older = quests(f.fromFixture('quests-snapshot-without-kind.json', '18:00'));
    expect(older.states.map((row) => row.kind)).toEqual([null, null]);
  });

  it('keeps every snapshot but the states of the latest only', () => {
    const f = eventFactory();
    const { snapshots, states } = quests(
      f.questsSnapshot('18:00', { questPoints: 1, quests: { A: 'FINISHED', B: 'NOT_STARTED' } }),
      f.questsSnapshot('19:00', { questPoints: 3, quests: { B: 'IN_PROGRESS', C: 'FINISHED' } }),
    );
    expect(snapshots.map((row) => [row.takenAt, row.questPoints])).toEqual([
      [at('18:00'), 1],
      [at('19:00'), 3],
    ]);
    // A is gone from the game's list: only the latest snapshot's entries remain.
    expect(states.map((row) => [row.quest, row.state])).toEqual([
      ['B', 'IN_PROGRESS'],
      ['C', 'FINISHED'],
    ]);
  });

  it('uses the event ID to pick the latest of two snapshots at the same time', () => {
    const f = eventFactory();
    const first = f.questsSnapshot('19:00', { quests: { A: 'IN_PROGRESS' } });
    const second = f.questsSnapshot('19:00', { quests: { A: 'FINISHED' } });
    const { states, completions } = quests(first, second);
    expect(states.map((row) => row.state)).toEqual(['FINISHED']);
    expect(completions).toEqual([expect.objectContaining({ quest: 'A', eventId: second.eventId })]);
  });

  it('records the earliest snapshot that showed each quest as finished', () => {
    const f = eventFactory();
    const first = f.questsSnapshot('17:00', { quests: { A: 'FINISHED', B: 'NOT_STARTED' } });
    const second = f.questsSnapshot('18:00', { quests: { A: 'FINISHED', B: 'FINISHED' } });
    const third = f.questsSnapshot('19:00', { quests: { A: 'FINISHED', B: 'FINISHED' } });
    const { completions } = quests(first, second, third);
    expect(completions.map((row) => [row.quest, row.firstFinishedAt, row.eventId])).toEqual([
      ['A', at('17:00'), first.eventId],
      ['B', at('18:00'), second.eventId],
    ]);
  });

  it('keeps the completion when a quest is no longer finished or listed', () => {
    const f = eventFactory();
    const first = f.questsSnapshot('17:00', { quests: { A: 'FINISHED', B: 'FINISHED' } });
    const { states, completions } = quests(
      first,
      f.questsSnapshot('18:00', { quests: { A: 'IN_PROGRESS' } }),
    );
    expect(states.map((row) => [row.quest, row.state])).toEqual([['A', 'IN_PROGRESS']]);
    expect(completions.map((row) => [row.quest, row.eventId])).toEqual([
      ['A', first.eventId],
      ['B', first.eventId],
    ]);
  });

  it('keeps accounts apart', () => {
    const f = eventFactory();
    const { states, completions } = quests(
      f.questsSnapshot('18:00', { quests: { A: 'FINISHED' } }),
      f.questsSnapshot('19:00', { quests: { A: 'NOT_STARTED' }, accountHash: OTHER_ACCOUNT }),
    );
    expect(states.map((row) => [row.accountHash, row.state])).toEqual([
      [OTHER_ACCOUNT, 'NOT_STARTED'],
      [expect.any(String), 'FINISHED'],
    ]);
    expect(completions).toHaveLength(1);
  });

  it('stores an empty snapshot and a full-size one', () => {
    const f = eventFactory();
    const many = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`QUEST_${String(index)}`, 'FINISHED' as const]),
    );
    const { snapshots, states, completions } = quests(
      f.questsSnapshot('18:00', { quests: many }),
      f.fromFixture('quests-snapshot-empty.json', '19:00'),
    );
    expect(snapshots).toHaveLength(2);
    expect(states).toEqual([]);
    expect(completions).toHaveLength(500);
  });
});

describe('diaries projection', () => {
  it('stores diaries-snapshot.json', () => {
    const f = eventFactory();
    const event = f.fromFixture('diaries-snapshot.json', '19:00');
    const { snapshots, states, completions } = diaries(event);
    expect(snapshots).toEqual([
      expect.objectContaining({ eventId: event.eventId, takenAt: at('19:00') }),
    ]);
    expect(states).toHaveLength(12);
    expect(states.filter((row) => row.completed).map((row) => [row.region, row.tier])).toEqual([
      ['ARDOUGNE', 'EASY'],
      ['ARDOUGNE', 'HARD'],
      ['ARDOUGNE', 'MEDIUM'],
      ['FALADOR', 'EASY'],
      ['FALADOR', 'ELITE'],
      ['FALADOR', 'HARD'],
      ['FALADOR', 'MEDIUM'],
    ]);
    expect(completions).toHaveLength(7);
  });

  it('keeps the states of the latest snapshot and the earliest completion of each tier', () => {
    const f = eventFactory();
    const first = f.diariesSnapshot('17:00', { diaries: { ARDOUGNE: ['EASY'], NEW_REGION: [] } });
    const second = f.diariesSnapshot('18:00', { diaries: { ARDOUGNE: ['EASY', 'MEDIUM'] } });
    const third = f.diariesSnapshot('19:00', {
      diaries: { ARDOUGNE: ['EASY', 'MEDIUM'], NEW_REGION: ['EASY'] },
    });
    const { snapshots, states, completions } = diaries(first, second, third);
    expect(snapshots).toHaveLength(3);
    expect(states).toHaveLength(8);
    expect(completions.map((row) => [row.region, row.tier, row.firstCompletedAt])).toEqual([
      ['ARDOUGNE', 'EASY', at('17:00')],
      ['ARDOUGNE', 'MEDIUM', at('18:00')],
      ['NEW_REGION', 'EASY', at('19:00')],
    ]);
    expect(completions[2]).toEqual(expect.objectContaining({ eventId: third.eventId }));
  });

  it('stores an empty snapshot', () => {
    const f = eventFactory();
    const { snapshots, states } = diaries(
      f.diariesSnapshot('18:00', { diaries: { ARDOUGNE: ['EASY'] } }),
      f.fromFixture('diaries-snapshot-empty.json', '19:00'),
    );
    expect(snapshots).toHaveLength(2);
    expect(states).toEqual([]);
  });
});
