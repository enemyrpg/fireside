import { describe, expect, it } from 'vitest';
import { RAIDS } from '../../game/raids.js';
import { schemaAsserts } from '../../test-utils.js';
import { raidsQuerySchema, raidsResponseSchema } from './raids.js';

const SESSION_ID = '01933c40-1111-7aaa-bbbb-ccccdddd0001';

const emptyRaids = RAIDS.map((raid) => ({
  raid: raid.name,
  lootCount: 0,
  lootGeValue: 0,
  specialLootGeValue: 0,
}));

const fang = {
  occurredAt: '2026-11-08T19:42:13.512Z',
  accountId: 1,
  sessionId: SESSION_ID,
  raid: 'Tombs of Amascut: Expert Mode',
  raidGroup: 'Tombs of Amascut',
  itemId: 26219,
  name: "Osmumten's fang",
  quantity: 1,
  gePriceEach: 24_500_000,
  geValue: 24_500_000,
  recipient: 'SELF',
  teamSize: 3,
  killCount: 140,
};

describe('raids query', () => {
  const query = schemaAsserts(raidsQuerySchema);

  it('defaults limit to 50 and takes a cursor', () => {
    expect(query.accepts({})).toEqual({ limit: 50 });
    expect(query.accepts({ limit: '10', cursor: 'abc' })).toEqual({ limit: 10, cursor: 'abc' });
  });

  it('rejects unknown parameters and a range', () => {
    expect(query.issuePaths({ from: '2026-11-01T00:00:00.000Z' })).toEqual(['']);
    expect(query.issuePaths({ limit: '101' })).toContain('limit');
  });
});

describe('raids response', () => {
  const response = schemaAsserts(raidsResponseSchema);

  it('accepts one entry per raid and own and teammate purples', () => {
    response.accepts({
      raids: emptyRaids,
      specialLoot: {
        items: [fang, { ...fang, recipient: 'TEAMMATE', teamSize: null, killCount: null }],
        nextCursor: null,
      },
    });
  });

  it('rejects a recipient name and unknown recipients', () => {
    const page = (item: unknown) => ({
      raids: emptyRaids,
      specialLoot: { items: [item], nextCursor: null },
    });
    expect(response.issuePaths(page({ ...fang, recipientName: 'Test Main' }))).toContain(
      'specialLoot.items.0',
    );
    expect(response.issuePaths(page({ ...fang, recipient: 'Test Main' }))).toContain(
      'specialLoot.items.0.recipient',
    );
  });

  it('checks geValue = quantity × gePriceEach', () => {
    expect(
      response.issuePaths({
        raids: emptyRaids,
        specialLoot: { items: [{ ...fang, geValue: 1 }], nextCursor: null },
      }),
    ).toContain('specialLoot.items.0.geValue');
  });

  it('allows geValue capped at 2^53 − 1', () => {
    const huge = { ...fang, quantity: 2, gePriceEach: 2 ** 52, geValue: Number.MAX_SAFE_INTEGER };
    response.accepts({ raids: emptyRaids, specialLoot: { items: [huge], nextCursor: null } });
    expect(
      response.issuePaths({
        raids: emptyRaids,
        specialLoot: { items: [{ ...huge, geValue: 2 ** 52 }], nextCursor: null },
      }),
    ).toContain('specialLoot.items.0.geValue');
  });

  it('requires every raid in RAIDS, in order', () => {
    const empty = { items: [], nextCursor: null };
    expect(response.issuePaths({ raids: emptyRaids.slice(1), specialLoot: empty })).toContain(
      'raids',
    );
    expect(response.issuePaths({ raids: [...emptyRaids].reverse(), specialLoot: empty })).toContain(
      'raids',
    );
  });
});
