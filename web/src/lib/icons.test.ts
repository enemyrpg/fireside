import { SKILLS } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import {
  bossIconUrl,
  bossInitials,
  isImportingIcons,
  itemInitials,
  SKILL_ABBREVIATIONS,
  skillAbbreviation,
  skillIconUrl,
} from './icons';

describe('placeholder icons', () => {
  it('uses the first two letters of item names', () => {
    expect(itemInitials('Abyssal whip')).toBe('Ab');
    expect(itemInitials("Osmumten's fang")).toBe('Os');
    expect(itemInitials('3rd age amulet')).toBe('3r');
    expect(itemInitials('!!')).toBe('?');
  });

  it('uses the initials of capitalised words for boss names', () => {
    expect(bossInitials('Vorkath')).toBe('Vo');
    expect(bossInitials("Calvar'ion")).toBe('Ca');
    expect(bossInitials('Chambers of Xeric')).toBe('COX');
    expect(bossInitials('Theatre of Blood: Hard Mode')).toBe('TOB');
    expect(bossInitials('Tombs of Amascut: Expert Mode')).toBe('TOA');
    expect(bossInitials('King Black Dragon')).toBe('KBD');
    expect(bossInitials('Thermonuclear smoke devil')).toBe('TSD');
    expect(bossInitials('The Fractured Archive')).toBe('TFA');
    expect(bossInitials('Barrows Chests')).toBe('BC');
    expect(bossInitials('TzKal-Zuk')).toBe('Tz');
    expect(bossInitials('!!')).toBe('?');
  });

  it('has a fixed, unique abbreviation for every known skill', () => {
    const abbreviations = SKILLS.map((skill) => SKILL_ABBREVIATIONS[skill]);
    expect(abbreviations.every((value) => value !== undefined)).toBe(true);
    expect(new Set(abbreviations).size).toBe(SKILLS.length);
    expect(skillAbbreviation('RANGED')).toBe('Ra');
    expect(skillAbbreviation('HITPOINTS')).toBe('HP');
    expect(skillAbbreviation('RUNECRAFT')).toBe('RC');
    expect(skillAbbreviation('CONSTRUCTION')).toBe('Con');
  });

  it('never fails on unknown skills', () => {
    expect(skillAbbreviation('NEW_SKILL')).toBe('Ne');
  });
});

describe('real icons for skills and bosses', () => {
  it('uses the skill name from the data, and OVERALL for the total level', () => {
    expect(skillIconUrl('ATTACK')).toBe('/api/v1/skills/ATTACK/icon');
    expect(skillIconUrl('OVERALL')).toBe('/api/v1/skills/OVERALL/icon');
  });

  it('sends the boss name as it is, URL-encoded', () => {
    expect(bossIconUrl('Vorkath')).toBe('/api/v1/bosses/Vorkath/icon');
    expect(bossIconUrl('Theatre of Blood: Entry Mode')).toBe(
      '/api/v1/bosses/Theatre%20of%20Blood%3A%20Entry%20Mode/icon',
    );
    expect(bossIconUrl('a/b?c')).toBe('/api/v1/bosses/a%2Fb%3Fc/icon');
  });

  it('counts an import as running until the newest icon is two minutes old', () => {
    const now = Date.parse('2026-11-17T18:06:00.000Z');
    expect(isImportingIcons(null, now)).toBe(false);
    expect(isImportingIcons('2026-11-17T18:05:59.000Z', now)).toBe(true);
    expect(isImportingIcons('2026-11-17T18:04:00.001Z', now)).toBe(true);
    expect(isImportingIcons('2026-11-17T18:04:00.000Z', now)).toBe(false);
    expect(isImportingIcons('2026-11-16T18:04:00.000Z', now)).toBe(false);
  });
});
