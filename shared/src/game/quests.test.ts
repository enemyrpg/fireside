import { describe, expect, it } from 'vitest';
import { compareByName, DIARY_REGIONS, DIARY_TIERS, diaryRegionName } from './quests.js';

describe('diaryRegionName', () => {
  it('gives the name in the game for known regions', () => {
    expect(diaryRegionName('ARDOUGNE')).toBe('Ardougne');
    expect(diaryRegionName('KOUREND')).toBe('Kourend & Kebos');
    expect(diaryRegionName('LUMBRIDGE')).toBe('Lumbridge & Draynor');
    expect(diaryRegionName('WESTERN')).toBe('Western Provinces');
  });

  it('shows an unknown region by its key', () => {
    expect(diaryRegionName('VARLAMORE')).toBe('Varlamore');
    expect(diaryRegionName('NEW_REGION_2')).toBe('New Region 2');
  });

  it('never reads inherited object keys as regions', () => {
    expect(diaryRegionName('CONSTRUCTOR')).toBe('Constructor');
  });

  it('has the 12 regions and 4 tiers of the game', () => {
    expect(Object.keys(DIARY_REGIONS)).toHaveLength(12);
    expect(DIARY_TIERS).toEqual(['EASY', 'MEDIUM', 'HARD', 'ELITE']);
  });
});

describe('compareByName', () => {
  const sorted = (rows: { name: string; key: string }[]) =>
    [...rows].sort(compareByName).map((row) => row.key);

  it('sorts by name without regard to case', () => {
    expect(
      sorted([
        { name: 'cold War', key: 'B' },
        { name: 'Animal Magnetism', key: 'C' },
        { name: 'Biohazard', key: 'A' },
      ]),
    ).toEqual(['C', 'A', 'B']);
  });

  it('breaks ties on the key', () => {
    expect(
      sorted([
        { name: 'Same', key: 'B' },
        { name: 'same', key: 'A' },
      ]),
    ).toEqual(['A', 'B']);
  });
});
