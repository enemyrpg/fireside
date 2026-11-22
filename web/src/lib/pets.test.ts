import type { Pet, PetsResponse } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import petsAll from '../../../shared/fixtures/api/pets-response/valid/all.json';
import { parsePetSort, petDate, petDetail, petNoun, petsHref, sortPets } from './pets';

const ALL = (petsAll as PetsResponse).pets;

function pet(overrides: Partial<Pet>): Pet {
  return {
    accountId: 1,
    itemId: 1,
    name: 'Pet',
    obtainedAt: null,
    approximate: false,
    source: null,
    killCount: null,
    xp: null,
    confirmed: true,
    origin: 'CLOG',
    ...overrides,
  };
}

const names = (pets: readonly Pet[]) =>
  pets.map((entry) => `${entry.name}/${String(entry.accountId)}`);

describe('parsePetSort', () => {
  it('is newest first unless the URL says A–Z', () => {
    expect(parsePetSort(null)).toBe('new');
    expect(parsePetSort('new')).toBe('new');
    expect(parsePetSort('az')).toBe('az');
    expect(parsePetSort('AZ')).toBe('new');
    expect(parsePetSort('oldest')).toBe('new');
  });
});

describe('petsHref', () => {
  it('leaves the default order out of the URL', () => {
    expect(petsHref(1)).toBe('/1/collections/pets');
    expect(petsHref('all', 'new')).toBe('/all/collections/pets');
    expect(petsHref(2, 'az')).toBe('/2/collections/pets?sort=az');
  });
});

describe('sortPets', () => {
  it('keeps the order of the API for newest first: undated pets last, by name', () => {
    expect(names(sortPets(ALL, 'new'))).toEqual(names(ALL));
    expect(names(sortPets([...ALL].reverse(), 'new'))).toEqual(names(ALL));
    const undated = ALL.filter((entry) => entry.obtainedAt === null);
    expect(undated.length).toBeGreaterThan(0);
    expect(names(ALL.slice(-undated.length))).toEqual(names(undated));
  });

  it('sorts A–Z without regard to case, the same pet on two accounts as newest first', () => {
    const pets = [
      pet({ name: 'vorki', itemId: 3, obtainedAt: '2026-01-01T00:00:00.000Z' }),
      pet({ name: 'Beaver', itemId: 2, accountId: 2 }),
      pet({ name: 'Beaver', itemId: 2, accountId: 1, obtainedAt: '2026-05-01T00:00:00.000Z' }),
      pet({ name: 'abyssal orphan', itemId: 4 }),
      pet({ name: 'Zilyana Jr.', itemId: 5, obtainedAt: '2026-06-01T00:00:00.000Z' }),
    ];
    expect(names(sortPets(pets, 'az'))).toEqual([
      'abyssal orphan/1',
      'Beaver/1',
      'Beaver/2',
      'vorki/1',
      'Zilyana Jr./1',
    ]);
  });

  it('does not change the list it is given', () => {
    const pets = [pet({ name: 'B', itemId: 2 }), pet({ name: 'A', itemId: 1 })];
    sortPets(pets, 'az');
    expect(pets.map((entry) => entry.name)).toEqual(['B', 'A']);
  });
});

describe('petDetail', () => {
  it('has the source with the KC or XP at the time when known', () => {
    expect(
      petDetail({ source: { type: 'ACTIVITY', name: 'Vorkath' }, killCount: 1204, xp: null }),
    ).toBe('Vorkath · 1,204 KC');
    expect(
      petDetail({ source: { type: 'SKILL', name: 'WOODCUTTING' }, killCount: null, xp: 9840112 }),
    ).toBe('Woodcutting · 9.84M XP');
  });

  it('has only the source without a KC or XP, and nothing without a source', () => {
    expect(
      petDetail({ source: { type: 'ACTIVITY', name: 'Vorkath' }, killCount: null, xp: null }),
    ).toBe('Vorkath');
    expect(petDetail({ source: null, killCount: null, xp: null })).toBeNull();
  });

  it('shows a source it does not know by name', () => {
    expect(
      petDetail({ source: { type: 'ACTIVITY', name: 'Brand New Boss' }, killCount: 1, xp: null }),
    ).toBe('Brand New Boss · 1 KC');
  });
});

describe('petDate', () => {
  it('is the day in the server time zone, always with the year', () => {
    const at = { obtainedAt: '2026-11-02T23:30:00.000Z', approximate: false };
    expect(petDate(at, 'UTC')).toBe('Mon 2 Nov 2026');
    expect(petDate(at, 'Europe/Oslo')).toBe('Tue 3 Nov 2026');
  });

  it('marks the time of a sync with "~", and is null without a time', () => {
    expect(petDate({ obtainedAt: '2026-09-01T12:00:00.000Z', approximate: true }, 'UTC')).toBe(
      '~Tue 1 Sept 2026',
    );
    expect(petDate({ obtainedAt: null, approximate: false }, 'UTC')).toBeNull();
  });
});

describe('petNoun', () => {
  it('is singular for one pet only', () => {
    expect(petNoun(0)).toBe('pets');
    expect(petNoun(1)).toBe('pet');
    expect(petNoun(8)).toBe('pets');
  });
});
