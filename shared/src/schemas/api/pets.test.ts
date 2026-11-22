import { describe, expect, it } from 'vitest';
import { comparePets } from '../../game/pets.js';
import { petsResponseSchema, type Pet } from './pets.js';

function paths(data: unknown): string[] {
  const result = petsResponseSchema.safeParse(data);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

const chat: Pet = {
  accountId: 1,
  itemId: 21992,
  name: 'Vorki',
  obtainedAt: '2026-11-02T19:04:11.000Z',
  approximate: false,
  source: { type: 'ACTIVITY', name: 'Vorkath' },
  killCount: 1204,
  xp: null,
  confirmed: true,
  origin: 'CHAT',
};
const clog: Pet = {
  accountId: 1,
  itemId: 12646,
  name: 'Baby mole',
  obtainedAt: null,
  approximate: false,
  source: null,
  killCount: null,
  xp: null,
  confirmed: true,
  origin: 'CLOG',
};

describe('pets response', () => {
  it('accepts chat and collection log pets, and no pets', () => {
    expect(paths({ pets: [chat, clog] })).toEqual([]);
    expect(paths({ pets: [] })).toEqual([]);
  });

  it('accepts an unconfirmed chat pet with a skill source and XP', () => {
    const pet = {
      ...chat,
      source: { type: 'SKILL', name: 'WOODCUTTING' },
      killCount: null,
      xp: 9_840_112,
      confirmed: false,
    };
    expect(paths({ pets: [pet] })).toEqual([]);
  });

  it('accepts an approximate time on a collection log pet', () => {
    const pet = { ...clog, obtainedAt: '2026-09-01T12:00:00.000Z', approximate: true };
    expect(paths({ pets: [chat, pet] })).toEqual([]);
  });

  it('rejects the same pet twice for one account, but not for two accounts', () => {
    expect(paths({ pets: [chat, { ...clog, itemId: chat.itemId }] })).toEqual(['pets.1.itemId']);
    expect(paths({ pets: [chat, { ...chat, accountId: 2 }] })).toEqual([]);
  });

  it('requires newest first and pets without a time last, by name', () => {
    const older = { ...chat, itemId: 1, obtainedAt: '2026-01-01T00:00:00.000Z' };
    expect(paths({ pets: [older, chat] })).toEqual(['pets.1']);
    expect(paths({ pets: [clog, chat] })).toEqual(['pets.1']);
    const zebra = { ...clog, itemId: 2, name: 'Zebra' };
    expect(paths({ pets: [zebra, clog] })).toEqual(['pets.1']);
    expect(paths({ pets: [clog, zebra] })).toEqual([]);
  });

  it.each([
    ['an unconfirmed collection log pet', { ...clog, confirmed: false }, 'confirmed'],
    ['a chat pet without a time', { ...chat, obtainedAt: null }, 'obtainedAt'],
    ['a chat pet with an approximate time', { ...chat, approximate: true }, 'obtainedAt'],
    ['approximate without a time', { ...clog, approximate: true }, 'approximate'],
    ['a kill count without a source', { ...chat, source: null }, 'killCount'],
    [
      'a kill count for a skill',
      { ...chat, source: { type: 'SKILL', name: 'MINING' } },
      'killCount',
    ],
    ['XP for an activity', { ...chat, killCount: null, xp: 5 }, 'xp'],
  ])('rejects %s', (_name, pet, field) => {
    expect(paths({ pets: [pet] })).toEqual([`pets.0.${field}`]);
  });

  it('rejects unknown fields and origins', () => {
    expect(paths({ pets: [{ ...chat, note: 'x' }] })).not.toEqual([]);
    expect(paths({ pets: [{ ...chat, origin: 'MANUAL' }] })).not.toEqual([]);
    expect(paths({ pets: [], total: 0 })).not.toEqual([]);
  });
});

describe('comparePets', () => {
  it('sorts by time, then name without regard to case, then account', () => {
    const a = { obtainedAt: null, name: 'beaver', accountId: 2, itemId: 5 };
    const b = { obtainedAt: null, name: 'Beaver', accountId: 1, itemId: 5 };
    const c = { obtainedAt: null, name: 'Abyssal orphan', accountId: 1, itemId: 6 };
    const d = { obtainedAt: '2026-01-01T00:00:00.000Z', name: 'Zebra', accountId: 1, itemId: 7 };
    const e = { obtainedAt: '2026-02-01T00:00:00.000Z', name: 'Zebra', accountId: 1, itemId: 8 };
    expect([a, b, c, d, e].sort(comparePets)).toEqual([e, d, c, b, a]);
  });
});
