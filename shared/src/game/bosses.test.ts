import { describe, expect, it } from 'vitest';
import { BOSS_ALIASES, normalizeBossName } from './bosses.js';

/** Lookup key used by the table: lower case, single spaces. */
const key = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

describe('BOSS_ALIASES', () => {
  it('has unique canonical names', () => {
    const names = BOSS_ALIASES.map((boss) => boss.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('never uses the same name or alias for two bosses', () => {
    const seen = new Map<string, string>();
    for (const boss of BOSS_ALIASES) {
      for (const name of [boss.name, ...boss.aliases]) {
        const owner = seen.get(key(name));
        expect(
          owner === undefined || owner === boss.name,
          `${name} is also in ${owner ?? '?'}`,
        ).toBe(true);
        seen.set(key(name), boss.name);
      }
    }
  });

  it('has canonical names without extra whitespace', () => {
    for (const { name } of BOSS_ALIASES) expect(name).toBe(name.trim().replace(/\s+/g, ' '));
  });
});

describe('normalizeBossName', () => {
  const entries = BOSS_ALIASES.flatMap((boss) =>
    [boss.name, ...boss.aliases].map((name) => [name, boss.name] as const),
  );

  it.each(entries)('maps %j to %j', (name, canonical) => {
    expect(normalizeBossName(name)).toBe(canonical);
  });

  it.each(entries)('is idempotent for %j', (name) => {
    expect(normalizeBossName(normalizeBossName(name))).toBe(normalizeBossName(name));
  });

  it.each([
    ['Vorkath', 'Vorkath'],
    ['vorkath', 'Vorkath'],
    ['  VORKATH ', 'Vorkath'],
    ['Gauntlet', 'The Gauntlet'],
    ['Corrupted Gauntlet', 'The Corrupted Gauntlet'],
    ['Nightmare', 'The Nightmare'],
    ['Barrows chest', 'Barrows Chests'],
    ['Lunar Chest', 'Lunar Chests'],
    ['Theatre of Blood: Story Mode', 'Theatre of Blood: Entry Mode'],
    ['Theatre of Blood Hard Mode', 'Theatre of Blood: Hard Mode'],
    ['Chambers of Xeric Challenge Mode', 'Chambers of Xeric: Challenge Mode'],
    ['Tombs of Amascut Expert Mode', 'Tombs of Amascut: Expert Mode'],
    ['Jad', 'TzTok-Jad'],
    ['Zuk', 'TzKal-Zuk'],
    ['Dusk', 'Grotesque Guardians'],
    ['Calvarion', "Calvar'ion"],
    ["kree'arra", "Kree'arra"],
    ['Kree\u2019arra', "Kree'arra"],
    ['K\u2019ril Tsutsaroth', "K'ril Tsutsaroth"],
    ['Theatre  of   Blood', 'Theatre of Blood'],
    ['The Mad Angel', 'Mad Angel'],
    ['mad angel', 'Mad Angel'],
    ['Bryophyta chests opened', 'Bryophyta'],
    ['Obor chests opened', 'Obor'],
    ['Doom of Mokhaiotl: Deep delves', 'Doom of Mokhaiotl'],
  ])('maps %j to %j', (input, expected) => {
    expect(normalizeBossName(input)).toBe(expected);
  });

  it('keeps an unknown boss name, cleaned of extra whitespace', () => {
    expect(normalizeBossName('  Some   New Boss ')).toBe('Some New Boss');
  });

  it('does not throw on an empty string', () => {
    expect(normalizeBossName('   ')).toBe('');
  });
});
