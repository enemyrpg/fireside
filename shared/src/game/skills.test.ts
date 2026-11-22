import { describe, expect, it } from 'vitest';
import { compareSkills, isKnownSkill, SKILLS } from './skills.js';

describe('SKILLS', () => {
  it("matches RuneLite's Skill enum, in order", () => {
    expect(SKILLS).toEqual([
      'ATTACK',
      'DEFENCE',
      'STRENGTH',
      'HITPOINTS',
      'RANGED',
      'PRAYER',
      'MAGIC',
      'COOKING',
      'WOODCUTTING',
      'FLETCHING',
      'FISHING',
      'FIREMAKING',
      'CRAFTING',
      'SMITHING',
      'MINING',
      'HERBLORE',
      'AGILITY',
      'THIEVING',
      'SLAYER',
      'FARMING',
      'RUNECRAFT',
      'HUNTER',
      'CONSTRUCTION',
      'SAILING',
    ]);
  });

  it('has no duplicates', () => {
    expect(new Set(SKILLS).size).toBe(SKILLS.length);
  });

  it('uses UPPER_SNAKE_CASE names', () => {
    for (const skill of SKILLS) expect(skill).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});

describe('isKnownSkill', () => {
  it.each(['ATTACK', 'SAILING'])('knows %s', (name) => {
    expect(isKnownSkill(name)).toBe(true);
  });

  it.each(['OVERALL', 'attack', 'NEW_SKILL', ''])('does not know %j', (name) => {
    expect(isKnownSkill(name)).toBe(false);
  });
});

describe('compareSkills', () => {
  it('sorts known skills in SKILLS order, then unknown skills alphabetically', () => {
    expect(['ZETA', 'SLAYER', 'ALPHA', 'ATTACK', 'SAILING'].sort(compareSkills)).toEqual([
      'ATTACK',
      'SLAYER',
      'SAILING',
      'ALPHA',
      'ZETA',
    ]);
  });
});
