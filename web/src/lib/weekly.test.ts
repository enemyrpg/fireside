import { describe, expect, it } from 'vitest';
import { bankChangeText, clogSummary, questsSummary } from './weekly';

describe('bankChangeText', () => {
  it('shows the change with one decimal in the percentage', () => {
    expect(bankChangeText({ startGeValue: 2_410_000_000, endGeValue: 2_418_630_000 })).toBe(
      '▲ 8.63M gp (+0.4%)',
    );
    expect(bankChangeText({ startGeValue: 1_000_000, endGeValue: 750_000 })).toBe(
      '▼ 750,000 gp (−25.0%)'.replace('750,000', '250K'),
    );
  });

  it('says when nothing changed, and has no percentage from nothing', () => {
    expect(bankChangeText({ startGeValue: 5000, endGeValue: 5000 })).toBe('No change');
    expect(bankChangeText({ startGeValue: 0, endGeValue: 5000 })).toBe('▲ 5,000 gp');
  });

  it('is null without a start value', () => {
    expect(bankChangeText({ startGeValue: null, endGeValue: 5000 })).toBeNull();
  });
});

describe('clogSummary', () => {
  it('has the new items and the counts', () => {
    expect(clogSummary({ newItems: 3, obtained: 712, total: 1568 })).toBe(
      '3 new items · 712 of 1,568',
    );
    expect(clogSummary({ newItems: 1, obtained: 1, total: 5 })).toBe('1 new item · 1 of 5');
  });

  it('leaves the counts out when there are none', () => {
    expect(clogSummary({ newItems: 2, obtained: null, total: null })).toBe('2 new items');
  });
});

describe('questsSummary', () => {
  const quest = (kind: 'QUEST' | 'MINIQUEST', quest: string) => ({
    accountId: 1,
    quest,
    name: quest,
    kind,
    finishedAt: '2026-11-06T18:00:00.000Z',
  });
  const tier = {
    accountId: 1,
    region: 'KANDARIN',
    name: 'Kandarin',
    tier: 'HARD' as const,
    completedAt: '2026-11-04T18:00:00.000Z',
  };

  it('counts quests, miniquests, diary tiers and quest points', () => {
    expect(
      questsSummary({
        questPointsGained: 2,
        quests: [quest('QUEST', 'A'), quest('MINIQUEST', 'B')],
        diaries: [tier],
      }),
    ).toBe('1 quest · 1 miniquest · 1 diary tier · +2 quest points');
  });

  it('has only the parts with content', () => {
    expect(questsSummary({ questPointsGained: 1, quests: [], diaries: [] })).toBe('+1 quest point');
    expect(
      questsSummary({
        questPointsGained: 0,
        quests: [quest('QUEST', 'A'), quest('QUEST', 'B')],
        diaries: [],
      }),
    ).toBe('2 quests');
    expect(questsSummary({ questPointsGained: 0, quests: [], diaries: [tier, tier] })).toBe(
      '2 diary tiers',
    );
  });
});
