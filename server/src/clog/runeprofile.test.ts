import { describe, expect, it } from 'vitest';
import { ExternalDisabledError, ExternalRequestError } from '../external/client.js';
import {
  failureOf,
  lookupName,
  parseActivities,
  parseCollectionLog,
  parseRuneProfileTime,
  parseSummaryUpdatedAt,
  RuneProfileFormatError,
} from './runeprofile.js';
import { clogBody, feedBody, summaryBody } from './testing.js';

// The readers for RuneProfile's responses, on hand-written examples.

const json = (body: string) => JSON.parse(body) as unknown;

describe('parseCollectionLog', () => {
  it('reads tabs, pages and items in order, missing items included', () => {
    const tabs = parseCollectionLog(json(clogBody({ 13262: 1, 4151: 3 })));
    expect(tabs.map((tab) => tab.name)).toEqual(['Bosses', 'Other']);
    expect(tabs[0]?.pages[0]).toEqual({
      name: 'Abyssal Sire',
      items: [
        { itemId: 13262, name: 'Abyssal orphan', quantity: 1 },
        { itemId: 13277, name: 'Jar of miasma', quantity: 0 },
        { itemId: 4151, name: 'Abyssal whip', quantity: 3 },
      ],
    });
  });

  const body = () => json(clogBody({ 13262: 1 })) as { tabs: { pages: { items: object[] }[] }[] };
  const withItem = (item: object) => {
    const log = body();
    log.tabs[0]?.pages[0]?.items.push(item);
    return log;
  };

  it.each([
    ['an array', []],
    ['null', null],
    ['an error object', { error: 'Account not found', code: 'NOT_FOUND' }],
    ['a new top-level field', { ...body(), updatedAt: 'x' }],
    ['a new field on an item', withItem({ id: 5, name: 'Five', quantity: 1, obtainedAt: 'x' })],
    ['a quantity with decimals', withItem({ id: 5, name: 'Five', quantity: 1.5 })],
    ['a negative quantity', withItem({ id: 5, name: 'Five', quantity: -1 })],
    ['an item ID as text', withItem({ id: '5', name: 'Five', quantity: 1 })],
    ['an item without a name', withItem({ id: 5, quantity: 1 })],
  ])('rejects %s', (_name, value) => {
    expect(() => parseCollectionLog(value)).toThrow(RuneProfileFormatError);
  });

  it('never puts values from the response in the error', () => {
    const log = withItem({ id: 5, name: 'response-secret', quantity: 'response-secret' });
    expect(() => parseCollectionLog(log)).toThrow(
      "RuneProfile's collection log had an unexpected format at tabs.0.pages.0.items.3.quantity: invalid_type",
    );
  });
});

describe('what a format error says', () => {
  const SECRET = 'response-secret';
  const problemOf = (parse: () => unknown) => {
    try {
      parse();
    } catch (error) {
      if (error instanceof RuneProfileFormatError) return error;
    }
    throw new Error('Expected a RuneProfileFormatError');
  };

  it('lists every problem by path and code', () => {
    const log = json(clogBody({ 13262: 1 })) as {
      tabs: { name: unknown; pages: { items: Record<string, unknown>[] }[] }[];
    };
    log.tabs[0]!.name = 7; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- built above
    log.tabs[0]!.pages[1]!.items[0]!.id = SECRET; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- built above
    log.tabs[1]!.pages[0]!.items[1]![SECRET] = SECRET; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- built above
    const error = problemOf(() => parseCollectionLog(log));
    expect(error.problem).toEqual({
      endpoint: 'COLLECTION_LOG',
      issues: [
        'tabs.0.name: invalid_type',
        'tabs.0.pages.1.items.0.id: invalid_type',
        'tabs.1.pages.0.items.1: unrecognized_keys',
      ],
    });
    expect(error.message).toBe(
      "RuneProfile's collection log had an unexpected format at tabs.0.name: invalid_type",
    );
    expect(JSON.stringify([error.message, error.problem])).not.toContain(SECRET);
  });

  it('writes a key that came from the response as *', () => {
    const page = json(feedBody([[13262, '2026-03-01T10:15:30.000Z']])) as {
      activities: { enriched: Record<string, unknown> }[];
    };
    page.activities[0]!.enriched = { [SECRET]: 5 }; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- built above
    const error = problemOf(() => parseActivities(page));
    expect(error.problem).toEqual({
      endpoint: 'ACTIVITIES',
      issues: ['activities.0.enriched.*: invalid_type'],
    });
    expect(JSON.stringify([error.message, error.problem])).not.toContain(SECRET);
  });

  it('names the endpoint and the field for a time it cannot read', () => {
    const feed = problemOf(() => parseActivities(json(feedBody([[13262, SECRET]]))));
    expect(feed.problem).toEqual({
      endpoint: 'ACTIVITIES',
      issues: ['activities.0.createdAt: invalid_format'],
    });
    const summary = problemOf(() => parseSummaryUpdatedAt({ updatedAt: SECRET }));
    expect(summary.problem).toEqual({ endpoint: 'SUMMARY', issues: ['updatedAt: invalid_format'] });
    expect(JSON.stringify([feed.message, summary.message])).not.toContain(SECRET);
  });

  it('lists at most 20 problems, and says how many more there were', () => {
    const tabs = Array.from({ length: 25 }, () => ({ name: SECRET }));
    const { problem } = problemOf(() => parseCollectionLog({ obtained: 0, total: 0, tabs }));
    expect(problem.issues).toHaveLength(21);
    expect(problem.issues[20]).toMatch(/^and \d+ more$/);
  });

  it('says (root) when the whole response is something else', () => {
    expect(problemOf(() => parseCollectionLog([SECRET])).problem.issues).toEqual([
      '(root): invalid_type',
    ]);
  });
});

describe('parseActivities', () => {
  it('reads the item and the time, and the cursor only when there is more', () => {
    expect(parseActivities(json(feedBody([[13262, '2026-03-01T10:15:30.000Z']], 'next')))).toEqual({
      entries: [{ itemId: 13262, obtainedAt: '2026-03-01T10:15:30.000Z' }],
      nextCursor: 'next',
    });
    expect(parseActivities(json(feedBody([]))).nextCursor).toBeNull();
  });

  it.each([
    ['another activity type', { type: 'level_up', data: { name: 'Slayer', level: 99 } }],
    [
      'a time that is not one',
      { type: 'new_item_obtained', data: { itemId: 5 }, createdAt: 'soon' },
    ],
    ['no item', { type: 'new_item_obtained', data: {}, createdAt: '2026-03-01T10:15:30.000Z' }],
  ])('rejects %s', (_name, activity) => {
    const page = { ...(json(feedBody([])) as object), activities: [activity] };
    expect(() => parseActivities(page)).toThrow(RuneProfileFormatError);
  });
});

describe('parseSummaryUpdatedAt', () => {
  it('reads updatedAt and ignores the rest', () => {
    expect(parseSummaryUpdatedAt(json(summaryBody('2026-11-09 08:00:00+00')))).toBe(
      '2026-11-09T08:00:00.000Z',
    );
  });

  it.each([[{}], [{ updatedAt: 5 }], [{ updatedAt: 'yesterday' }], [null]])(
    'rejects %j',
    (value) => {
      expect(() => parseSummaryUpdatedAt(value)).toThrow(RuneProfileFormatError);
    },
  );
});

describe('parseRuneProfileTime', () => {
  it.each([
    ['2026-11-16T04:12:20.123Z', '2026-11-16T04:12:20.123Z'],
    ['2026-11-16T04:12:20Z', '2026-11-16T04:12:20.000Z'],
    ['2026-11-16T04:12:20.123456Z', '2026-11-16T04:12:20.123Z'],
    ['2026-11-16 04:12:20.123456+00', '2026-11-16T04:12:20.123Z'],
    ['2026-11-16 06:12:20+02:00', '2026-11-16T04:12:20.000Z'],
    ['2026-11-16 02:12:20-0200', '2026-11-16T04:12:20.000Z'],
    // No zone: UTC.
    ['2026-11-16 04:12:20', '2026-11-16T04:12:20.000Z'],
  ])('reads %s', (value, expected) => {
    expect(parseRuneProfileTime(value)).toBe(expected);
  });

  it.each(['', 'now', '2026-11-16', '1794830400', '2026-13-40T99:00:00Z'])(
    'rejects %j',
    (value) => {
      expect(parseRuneProfileTime(value)).toBeNull();
    },
  );
});

describe('lookupName', () => {
  it.each([
    ['Seed Main', 'Seed Main'],
    ['Seed\u00a0Main', 'Seed Main'],
    ['a-b_c 1', 'a-b_c 1'],
    ['TwelveChars1', 'TwelveChars1'],
  ])('accepts %j', (name, expected) => {
    expect(lookupName(name)).toBe(expected);
  });

  it.each([[null], [''], ['   '], ['Thirteen char'], ['a/b'], ['a?b=c'], ['../admin'], ['naïve']])(
    'refuses %j',
    (name) => {
      expect(lookupName(name)).toBeNull();
    },
  );
});

describe('failureOf', () => {
  it.each<[Error, string]>([
    [new ExternalDisabledError('off'), 'SOURCE_OFF'],
    [
      new RuneProfileFormatError('format', { endpoint: 'COLLECTION_LOG', issues: [] }),
      'INVALID_RESPONSE',
    ],
    [new ExternalRequestError('HTTP 404', 404), 'PROFILE_NOT_FOUND'],
    [new ExternalRequestError('HTTP 401', 401), 'INVALID_API_KEY'],
    [new ExternalRequestError('HTTP 403', 403), 'INVALID_API_KEY'],
    [new ExternalRequestError('HTTP 429', 429), 'RATE_LIMITED'],
    [new ExternalRequestError('HTTP 502', 502), 'UNAVAILABLE'],
    [new ExternalRequestError('Network error'), 'UNAVAILABLE'],
    [new ExternalRequestError('HTTP 400', 400), 'INVALID_RESPONSE'],
    [new ExternalRequestError('Not JSON', 200, true), 'INVALID_RESPONSE'],
  ])('%s → %s', (error, status) => {
    expect(failureOf(error)).toBe(status);
  });

  it('does not hide a bug', () => {
    expect(() => failureOf(new TypeError('bug'))).toThrow('bug');
  });
});
