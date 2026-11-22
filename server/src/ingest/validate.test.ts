import { describe, expect, it } from 'vitest';
import { formatIssues, MAX_LISTED_ISSUES, rawEventId, validateBatch } from './validate.js';

describe('formatIssues', () => {
  it('joins paths with dots and issues with semicolons', () => {
    expect(
      formatIssues([
        { path: ['payload', 'items', 0, 'quantity'], message: 'Too small' },
        { path: ['eventId'], message: 'Invalid UUID' },
      ]),
    ).toBe('payload.items.0.quantity: Too small; eventId: Invalid UUID');
  });

  it('names the event itself when the path is empty', () => {
    expect(formatIssues([{ path: [], message: 'Expected object' }])).toBe('event: Expected object');
  });

  it(`lists at most ${String(MAX_LISTED_ISSUES)} issues`, () => {
    const issues = Array.from({ length: MAX_LISTED_ISSUES + 3 }, (_, i) => ({
      path: [`f${String(i)}`],
      message: 'Bad',
    }));
    const text = formatIssues(issues);
    expect(text.split('; ')).toHaveLength(MAX_LISTED_ISSUES + 1);
    expect(text).toContain('f4: Bad');
    expect(text).not.toContain('f5');
    expect(text.endsWith('(+3 more)')).toBe(true);
  });
});

describe('rawEventId', () => {
  it.each([
    [{ eventId: 'not-a-uuid' }, 'not-a-uuid'],
    [{ eventId: '' }, null],
    [{ eventId: 42 }, null],
    [{}, null],
    [null, null],
    ['string', null],
    [[{ eventId: 'x' }], null],
  ])('%j → %j', (raw, expected) => {
    expect(rawEventId(raw)).toBe(expected);
  });
});

describe('validateBatch', () => {
  it('rejects non-objects with a readable error and keeps indexes', () => {
    const { valid, rejected } = validateBatch([1, null]);
    expect(valid).toEqual([]);
    expect(rejected.map((r) => r.index)).toEqual([0, 1]);
    for (const rejection of rejected) {
      expect(rejection.eventId).toBeNull();
      expect(rejection.error).toMatch(/^event: /);
    }
  });
});
