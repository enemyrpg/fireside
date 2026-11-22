import { describe, expect, it } from 'vitest';
import { BOSS_ALIASES, normalizeBossName } from './bosses.js';
import { isRaidPurple, raidOf, RAIDS } from './raids.js';

describe('RAIDS', () => {
  it('has the four raids', () => {
    expect(RAIDS.map((raid) => raid.name)).toEqual([
      'Chambers of Xeric',
      'Theatre of Blood',
      'Tombs of Amascut',
      'The Fractured Archive',
    ]);
  });

  it.each(RAIDS.map((raid) => [raid.name, raid] as const))(
    '%s: first mode is the raid itself',
    (name, raid) => {
      expect(raid.modes[0]?.name).toBe(name);
    },
  );

  it('has every mode in BOSS_ALIASES, so it normalizes to itself', () => {
    const names = new Set(BOSS_ALIASES.map((boss) => boss.name));
    for (const mode of RAIDS.flatMap((raid) => raid.modes)) {
      expect(names.has(mode.name), mode.name).toBe(true);
      expect(normalizeBossName(mode.name)).toBe(mode.name);
      for (const alias of mode.aliases) expect(normalizeBossName(alias)).toBe(mode.name);
    }
  });

  it('never uses an item ID twice', () => {
    const ids = RAIDS.flatMap((raid) => raid.purples.map((purple) => purple.itemId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks The Fractured Archive as not verified in game', () => {
    const archive = RAIDS.find((raid) => raid.name === 'The Fractured Archive');
    expect(archive?.verified).toBe(false);
    expect(archive?.modes.map((mode) => mode.name)).toEqual(['The Fractured Archive']);
  });
});

describe('raidOf', () => {
  it.each([
    ['Chambers of Xeric', 'Chambers of Xeric'],
    ['Chambers of Xeric: Challenge Mode', 'Chambers of Xeric'],
    ['Theatre of Blood: Entry Mode', 'Theatre of Blood'],
    ['Theatre of Blood: Hard Mode', 'Theatre of Blood'],
    ['Tombs of Amascut: Expert Mode', 'Tombs of Amascut'],
    ['The Fractured Archive', 'The Fractured Archive'],
  ])('maps %j to %j', (name, raid) => {
    expect(raidOf(name)?.name).toBe(raid);
  });

  it('maps aliases after normalizing', () => {
    expect(raidOf(normalizeBossName('Fractured Archive'))?.name).toBe('The Fractured Archive');
    expect(raidOf(normalizeBossName('Theatre of Blood Story Mode'))?.name).toBe('Theatre of Blood');
  });

  it.each(['Vorkath', 'Some New Boss', ''])('returns undefined for %j', (name) => {
    expect(raidOf(name)).toBeUndefined();
  });
});

describe('isRaidPurple', () => {
  const raid = (name: string) => {
    const found = RAIDS.find((r) => r.name === name);
    if (!found) throw new Error(`No raid ${name}`);
    return found;
  };
  const cox = raid('Chambers of Xeric');
  const toa = raid('Tombs of Amascut');

  it('matches by item ID within the raid', () => {
    expect(isRaidPurple(toa, 26219)).toBe(true);
    expect(isRaidPurple(cox, 20997)).toBe(true);
  });

  it('rejects other raids’ purples and normal loot', () => {
    expect(isRaidPurple(cox, 26219)).toBe(false);
    expect(isRaidPurple(toa, 995)).toBe(false);
  });
});
