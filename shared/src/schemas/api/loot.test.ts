import { describe, expect, it } from 'vitest';
import { schemaAsserts } from '../../test-utils.js';
import {
  dropsQuerySchema,
  dropsResponseSchema,
  lootQuerySchema,
  lootResponseSchema,
} from './loot.js';

const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-08T00:00:00.000Z';
const SESSION_ID = '01933c40-1111-7aaa-bbbb-ccccdddd0001';

describe('loot query', () => {
  const query = schemaAsserts(lootQuerySchema);

  it('defaults groupBy to source', () => {
    expect(query.accepts({})).toEqual({ groupBy: 'source' });
  });

  it('rejects an unknown groupBy and a bad range', () => {
    expect(query.issuePaths({ groupBy: 'item' })).toContain('groupBy');
    expect(query.issuePaths({ from: TO, to: FROM })).toContain('to');
  });
});

describe('loot response', () => {
  const response = schemaAsserts(lootResponseSchema);
  const totals = { lootCount: 3, geValue: 2854200, haValue: 60000 };
  const vorkath = {
    source: { type: 'NPC', name: 'Vorkath' },
    lootCount: 2,
    geValue: 2854200,
    haValue: 60000,
    items: [
      { itemId: 11286, name: 'Draconic visage', quantity: 1, geValue: 2850000, haValue: 60000 },
      { itemId: 536, name: 'Dragon bones', quantity: 2, geValue: 4200, haValue: 0 },
    ],
  };
  const pker = {
    source: { type: 'PLAYER', name: null },
    lootCount: 1,
    geValue: 0,
    haValue: 0,
    items: [],
  };

  it('accepts loot grouped by source, including PLAYER without a name', () => {
    response.accepts({ groupBy: 'source', from: FROM, to: TO, totals, groups: [vorkath, pker] });
  });

  it('rejects to before from', () => {
    expect(
      response.issuePaths({ groupBy: 'source', from: TO, to: FROM, totals, groups: [] }),
    ).toContain('to');
  });

  it('accepts an all-time range', () => {
    response.accepts({ groupBy: 'source', from: null, to: null, totals, groups: [] });
  });

  it('rejects PLAYER loot with a name', () => {
    const named = { ...pker, source: { type: 'PLAYER', name: 'Test Main' } };
    response.rejects({ groupBy: 'source', from: FROM, to: TO, totals, groups: [named] });
  });

  it('accepts loot grouped by day', () => {
    response.accepts({
      groupBy: 'day',
      from: FROM,
      to: TO,
      totals,
      groups: [{ date: '2026-11-03', lootCount: 3, geValue: 2854200, haValue: 60000 }],
    });
  });

  it('rejects groups that do not match groupBy', () => {
    response.rejects({ groupBy: 'day', from: FROM, to: TO, totals, groups: [vorkath] });
    response.rejects({
      groupBy: 'source',
      from: FROM,
      to: TO,
      totals,
      groups: [{ date: '2026-11-03', lootCount: 1, geValue: 1, haValue: 1 }],
    });
  });

  it.each([
    ['quantity', 0],
    ['geValue', -1],
    ['name', ''],
  ])('rejects item %s = %j', (field, value) => {
    const items = [{ ...vorkath.items[0], [field]: value }];
    expect(
      response.issuePaths({
        groupBy: 'source',
        from: FROM,
        to: TO,
        totals,
        groups: [{ ...vorkath, items }],
      }),
    ).toContain(`groups.0.items.0.${field}`);
  });
});

describe('drops query', () => {
  const query = schemaAsserts(dropsQuerySchema);

  it('coerces minValue and applies pagination defaults', () => {
    expect(query.accepts({ minValue: '1000000' })).toEqual({ minValue: 1000000, limit: 50 });
  });

  it.each(['-1', '1.5', 'lots', '', ' ', '1e6'])('rejects minValue %j', (minValue) => {
    expect(query.issuePaths({ minValue })).toContain('minValue');
  });

  it('rejects limit over 100', () => {
    expect(query.issuePaths({ limit: '101' })).toContain('limit');
  });
});

describe('drops response', () => {
  const response = schemaAsserts(dropsResponseSchema);
  const drop = {
    lootEventId: 17,
    accountId: 1,
    sessionId: SESSION_ID,
    occurredAt: '2026-11-08T19:42:13.512Z',
    source: { type: 'NPC', name: 'Vorkath' },
    itemId: 11286,
    name: 'Draconic visage',
    quantity: 1,
    gePriceEach: 2850000,
    haPriceEach: 60000,
    geValue: 2850000,
    haValue: 60000,
  };

  it('accepts a page of drops', () => {
    response.accepts({ items: [drop], nextCursor: 'abc' });
  });

  it('rejects a drop from a named player', () => {
    response.rejects({
      items: [{ ...drop, source: { type: 'PLAYER', name: 'Test Main' } }],
      nextCursor: null,
    });
  });

  it('rejects a drop with an NPC without a name', () => {
    response.rejects({
      items: [{ ...drop, source: { type: 'NPC', name: null } }],
      nextCursor: null,
    });
  });

  it.each([
    ['geValue', 2849999],
    ['haValue', 0],
  ])('rejects %s that is not quantity * price', (field, value) => {
    expect(
      response.issuePaths({ items: [{ ...drop, [field]: value }], nextCursor: null }),
    ).toContain(`items.0.${field}`);
  });

  it('checks values against quantity', () => {
    const two = { ...drop, quantity: 2, geValue: 5700000, haValue: 120000 };
    response.accepts({ items: [two], nextCursor: null });
    response.rejects({ items: [{ ...two, geValue: 2850000 }], nextCursor: null });
  });

  it('rejects a non-UUIDv7 session id', () => {
    expect(
      response.issuePaths({ items: [{ ...drop, sessionId: 'x' }], nextCursor: null }),
    ).toContain('items.0.sessionId');
  });
});
