import { describe, expect, it } from 'vitest';
import { schemaAsserts } from '../../test-utils.js';
import {
  compareFeedEntries,
  FEED_DEFAULT_LIMIT,
  FEED_DEFAULT_MIN_VALUE,
  FEED_TYPES,
  feedQuerySchema,
  feedResponseSchema,
} from './feed.js';

const SESSION_ID = '01933c40-1111-7aaa-bbbb-ccccdddd0001';

describe('feed query', () => {
  const query = schemaAsserts(feedQuerySchema);

  it('defaults to every type, 1M drops and 20 entries', () => {
    expect(query.accepts({})).toEqual({
      types: [...FEED_TYPES],
      minValue: FEED_DEFAULT_MIN_VALUE,
      limit: FEED_DEFAULT_LIMIT,
    });
    expect(FEED_DEFAULT_MIN_VALUE).toBe(1_000_000);
  });

  it('takes a comma list of types, in rank order and each once', () => {
    expect(query.accepts({ types: 'drop,session,drop' })).toMatchObject({
      types: ['session', 'drop'],
    });
    for (const type of FEED_TYPES)
      expect(query.accepts({ types: type })).toMatchObject({ types: [type] });
  });

  it('rejects unknown and empty types', () => {
    expect(query.issuePaths({ types: 'session,quest' })).toContain('types');
    expect(query.issuePaths({ types: '' })).toContain('types');
    expect(query.issuePaths({ types: 'session,' })).toContain('types');
  });

  it('takes minValue and limit from strings', () => {
    expect(query.accepts({ minValue: '100000', limit: '5' })).toMatchObject({
      minValue: 100_000,
      limit: 5,
    });
    expect(query.issuePaths({ limit: '101' })).toContain('limit');
    expect(query.issuePaths({ minValue: '-1' })).toContain('minValue');
  });
});

describe('feed order', () => {
  const entry = (at: string, type: (typeof FEED_TYPES)[number], id: string) => ({ at, type, id });

  it('is newest first, then type rank, then id descending', () => {
    const at = '2026-11-08T20:00:00.000Z';
    const sorted = [
      entry('2026-11-08T21:00:00.000Z', 'drop', 'drop:a'),
      entry(at, 'session', 'session:a'),
      entry(at, 'level', 'level:b'),
      entry(at, 'level', 'level:a'),
      entry(at, 'clog', 'clog:1.1'),
      entry(at, 'pet', 'pet:1.1'),
      entry(at, 'drop', 'drop:b'),
    ];
    expect([...sorted].reverse().sort(compareFeedEntries)).toEqual(sorted);
  });
});

describe('feed response', () => {
  const response = schemaAsserts(feedResponseSchema);
  const level = {
    type: 'level',
    id: `level:${SESSION_ID}.SLAYER`,
    at: '2026-11-08T20:00:00.000Z',
    accountId: 1,
    sessionId: SESSION_ID,
    skill: 'SLAYER',
    fromLevel: 89,
    toLevel: 90,
  };

  it('accepts level entries in order', () => {
    response.accepts({
      items: [level, { ...level, id: `level:${SESSION_ID}.ATTACK`, skill: 'ATTACK' }],
      nextCursor: null,
    });
  });

  it('rejects entries out of order or twice', () => {
    const attack = { ...level, id: `level:${SESSION_ID}.ATTACK`, skill: 'ATTACK' };
    expect(response.issuePaths({ items: [attack, level], nextCursor: null })).toContain('items.1');
    expect(response.issuePaths({ items: [level, level], nextCursor: null })).toContain(
      'items.1.id',
    );
  });

  it('rejects a level entry without a gain', () => {
    expect(response.issuePaths({ items: [{ ...level, toLevel: 89 }], nextCursor: null })).toContain(
      'items.0.toLevel',
    );
  });
});
