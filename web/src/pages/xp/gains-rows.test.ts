import { SKILLS, type SkillGain } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import {
  anyXpGained,
  buildGainsRows,
  chartSkills,
  periodOfRange,
  skillsTrained,
  splitGainsRows,
} from './gains-rows';

function gain(skill: string, endXp: number, xpGained: number, endLevel = 50, levelsGained = 0) {
  return {
    skill,
    startXp: endXp - xpGained,
    endXp,
    xpGained,
    startLevel: endLevel - levelsGained,
    endLevel,
    levelsGained,
  } satisfies SkillGain;
}

describe('buildGainsRows', () => {
  it('is empty without data', () => {
    expect(buildGainsRows({ total: { xpGained: 0, levelsGained: 0 }, skills: [] })).toEqual([]);
  });

  it('puts Overall first, then skills by gain, ties in skill order, unknown skills last', () => {
    const rows = buildGainsRows({
      total: { xpGained: 600, levelsGained: 2 },
      skills: [
        gain('ATTACK', 1000, 0),
        gain('DEFENCE', 2000, 100),
        gain('STRENGTH', 3000, 500, 60, 2),
        gain('HITPOINTS', 4000, 0),
        gain('NEW_SKILL', 50, 0),
        gain('ANOTHER_SKILL', 70, 0),
      ],
    });
    expect(rows.map((row) => row.skill)).toEqual([
      null,
      'STRENGTH',
      'DEFENCE',
      'ATTACK',
      'HITPOINTS',
      'ANOTHER_SKILL',
      'NEW_SKILL',
    ]);
    expect(rows[1]).toEqual({
      skill: 'STRENGTH',
      level: 60,
      totalXp: 3000,
      xpGained: 500,
      levelsGained: 2,
    });
  });

  it('sums Overall level and XP over known skills only and takes gains from total', () => {
    const [overall] = buildGainsRows({
      total: { xpGained: 553151, levelsGained: 3 },
      skills: [
        gain('ATTACK', 1000, 553151, 40, 3),
        gain('DEFENCE', 2000, 0, 45),
        gain('NEW_SKILL', 999_999, 999, 99),
      ],
    });
    expect(overall).toEqual({
      skill: null,
      level: 85,
      totalXp: 3000,
      xpGained: 553151,
      levelsGained: 3,
    });
  });
});

describe('skillsTrained', () => {
  it('counts known skills with XP gained, like the total', () => {
    expect(
      skillsTrained({
        skills: [gain('ATTACK', 10, 5), gain('DEFENCE', 10, 0), gain('NEW_SKILL', 10, 1)],
      }),
    ).toBe(1);
  });
});

describe('anyXpGained', () => {
  it('is true when only an unknown skill gained XP, though the total is 0', () => {
    expect(anyXpGained({ skills: [gain('ATTACK', 10, 0), gain('NEW_SKILL', 10, 1)] })).toBe(true);
    expect(anyXpGained({ skills: [gain('ATTACK', 10, 0)] })).toBe(false);
    expect(anyXpGained({ skills: [] })).toBe(false);
  });
});

describe('chartSkills', () => {
  it('lists every known skill, then unknown skills from gains once, alphabetically', () => {
    expect(chartSkills(undefined)).toEqual([...SKILLS]);
    expect(
      chartSkills({
        skills: [gain('ZETA', 1, 0), gain('ATTACK', 1, 0), gain('ALPHA', 1, 0), gain('ZETA', 1, 0)],
      }),
    ).toEqual([...SKILLS, 'ALPHA', 'ZETA']);
  });
});

describe('periodOfRange', () => {
  const range = (from: string, to: string) => periodOfRange({ from, to });

  it('tells the period from the length, also across clock changes', () => {
    expect(range('2026-11-11T00:00:00.000Z', '2026-11-12T00:00:00.000Z')).toBe('day');
    // 25-hour local day in Oslo when the clocks go back.
    expect(range('2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z')).toBe('day');
    expect(range('2026-10-25T22:00:00.000Z', '2026-11-01T23:00:00.000Z')).toBe('week');
    expect(range('2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')).toBe('month');
    expect(range('2026-10-31T23:00:00.000Z', '2026-11-30T23:00:00.000Z')).toBe('month');
    expect(range('2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z')).toBe('year');
  });
});

describe('splitGainsRows', () => {
  it('keeps Overall and skills with XP in the table, the rest in skill order for the grid', () => {
    const rows = buildGainsRows({
      total: { xpGained: 300, levelsGained: 0 },
      skills: [
        gain('MAGIC', 1000, 0),
        gain('SLAYER', 5000, 200),
        gain('NEW_SKILL', 10, 0),
        gain('ATTACK', 2000, 0),
        gain('PRAYER', 3000, 100),
      ],
    });
    const { trained, untrained } = splitGainsRows(rows);
    expect(trained.map((row) => row.skill)).toEqual([null, 'SLAYER', 'PRAYER']);
    expect(untrained.map((row) => row.skill)).toEqual(['ATTACK', 'MAGIC', 'NEW_SKILL']);
  });

  it('puts an unknown skill with XP in the table', () => {
    const rows = buildGainsRows({
      total: { xpGained: 0, levelsGained: 0 },
      skills: [gain('ATTACK', 100, 0), gain('NEW_SKILL', 50, 50)],
    });
    const { trained, untrained } = splitGainsRows(rows);
    expect(trained.map((row) => row.skill)).toEqual([null, 'NEW_SKILL']);
    expect(untrained.map((row) => row.skill)).toEqual(['ATTACK']);
  });

  it('leaves only Overall in the table when nothing was trained', () => {
    const rows = buildGainsRows({
      total: { xpGained: 0, levelsGained: 0 },
      skills: [gain('ATTACK', 100, 0), gain('MAGIC', 100, 0)],
    });
    const { trained, untrained } = splitGainsRows(rows);
    expect(trained.map((row) => row.skill)).toEqual([null]);
    expect(untrained).toHaveLength(2);
  });

  it('is empty without data', () => {
    expect(splitGainsRows([])).toEqual({ trained: [], untrained: [] });
  });
});
