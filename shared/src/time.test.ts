import { describe, expect, it } from 'vitest';
import {
  fromLocal,
  isoWeekRange,
  localHourAt,
  offsetAt,
  offsetChanges,
  periodAt,
  periodKey,
  periodsBetween,
  toLocal,
  type PeriodUnit,
} from './time.js';

const OSLO = 'Europe/Oslo';
const HOUR = 3_600_000;

describe('time zone helpers', () => {
  it('converts local time to UTC in summer and winter', () => {
    expect(new Date(fromLocal({ year: 2026, month: 7, day: 1 }, 20, 0, OSLO)).toISOString()).toBe(
      '2026-07-01T18:00:00.000Z',
    );
    expect(new Date(fromLocal({ year: 2026, month: 12, day: 1 }, 20, 0, OSLO)).toISOString()).toBe(
      '2026-12-01T19:00:00.000Z',
    );
  });

  it('gives the first of two times in the autumn overlap', () => {
    // 2026-10-25: 03:00 CEST becomes 02:00 CET, so 02:30 happens twice.
    expect(new Date(fromLocal({ year: 2026, month: 10, day: 25 }, 2, 30, OSLO)).toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('moves a time in the spring gap forward', () => {
    // 2026-03-29: 02:00 CET becomes 03:00 CEST; 02:30 does not exist.
    const ms = fromLocal({ year: 2026, month: 3, day: 29 }, 2, 30, OSLO);
    expect(toLocal(ms, OSLO)).toMatchObject({ hour: 3, minute: 30 });
  });

  it('round-trips local times', () => {
    const ms = Date.parse('2026-10-25T05:17:00.000Z');
    const local = toLocal(ms, OSLO);
    expect(local).toEqual({ year: 2026, month: 10, day: 25, hour: 6, minute: 17, weekday: 7 });
    expect(fromLocal(local, local.hour, local.minute, OSLO)).toBe(ms);
  });

  it('finds DST changes to the millisecond', () => {
    const changes = offsetChanges(
      Date.parse('2026-01-01T00:00:00Z'),
      Date.parse('2027-01-01T00:00:00Z'),
      OSLO,
    );
    expect(changes.map((ms) => new Date(ms).toISOString())).toEqual([
      '2026-03-29T01:00:00.000Z',
      '2026-10-25T01:00:00.000Z',
    ]);
    expect(offsetAt(Date.parse('2026-10-25T00:59:59.999Z'), OSLO)).toBe(2 * HOUR);
    expect(offsetAt(Date.parse('2026-10-25T01:00:00.000Z'), OSLO)).toBe(HOUR);
    expect(offsetChanges(0, 365 * 24 * HOUR, 'UTC')).toEqual([]);
  });
});

describe('local periods', () => {
  const at = (iso: string) => Date.parse(iso);
  const period = (iso: string, unit: PeriodUnit) => {
    const { start, end } = periodAt(at(iso), unit, OSLO);
    return [new Date(start).toISOString(), new Date(end).toISOString()];
  };

  it('has 25-hour and 23-hour days at the DST changes', () => {
    expect(period('2026-10-25T12:00:00.000Z', 'day')).toEqual([
      '2026-10-24T22:00:00.000Z',
      '2026-10-25T23:00:00.000Z',
    ]);
    expect(period('2026-03-29T12:00:00.000Z', 'day')).toEqual([
      '2026-03-28T23:00:00.000Z',
      '2026-03-29T22:00:00.000Z',
    ]);
  });

  it('starts weeks on local Monday, also across a DST change', () => {
    // 2026-W13 is 23 March to 29 March; summer time starts on the Sunday.
    expect(period('2026-03-29T12:00:00.000Z', 'week')).toEqual([
      '2026-03-22T23:00:00.000Z',
      '2026-03-29T22:00:00.000Z',
    ]);
    expect(periodKey(at('2026-03-29T12:00:00.000Z'), 'week', OSLO)).toBe('2026-W13');
  });

  it('gives months and years in local time', () => {
    expect(period('2026-10-31T23:30:00.000Z', 'month')).toEqual([
      '2026-10-31T23:00:00.000Z',
      '2026-11-30T23:00:00.000Z',
    ]);
    expect(period('2026-10-15T00:00:00.000Z', 'month')).toEqual([
      '2026-09-30T22:00:00.000Z',
      '2026-10-31T23:00:00.000Z',
    ]);
    expect(period('2026-12-31T23:30:00.000Z', 'year')).toEqual([
      '2026-12-31T23:00:00.000Z',
      '2027-12-31T23:00:00.000Z',
    ]);
  });

  it('keys an instant by its local date', () => {
    // 23:30 UTC on Saturday 24 October is 01:30 local on Sunday 25 October.
    const ms = at('2026-10-24T23:30:00.000Z');
    expect(periodKey(ms, 'day', OSLO)).toBe('2026-10-25');
    expect(periodKey(ms, 'day', 'UTC')).toBe('2026-10-24');
    expect(periodKey(ms, 'week', OSLO)).toBe('2026-W43');
    expect(periodKey(at('2026-10-31T23:30:00.000Z'), 'month', OSLO)).toBe('2026-11');
    expect(periodKey(at('2026-12-31T23:30:00.000Z'), 'year', OSLO)).toBe('2027');
  });

  it('uses ISO weeks at the turn of the year (2026 has week 53)', () => {
    expect(periodKey(at('2025-12-29T12:00:00.000Z'), 'week', OSLO)).toBe('2026-W01');
    expect(periodKey(at('2026-12-28T12:00:00.000Z'), 'week', OSLO)).toBe('2026-W53');
    expect(periodKey(at('2027-01-01T12:00:00.000Z'), 'week', OSLO)).toBe('2026-W53');
    expect(periodKey(at('2027-01-03T22:59:59.999Z'), 'week', OSLO)).toBe('2026-W53');
    expect(periodKey(at('2027-01-03T23:00:00.000Z'), 'week', OSLO)).toBe('2027-W01');
    expect(period('2027-01-01T12:00:00.000Z', 'week')).toEqual([
      '2026-12-27T23:00:00.000Z',
      '2027-01-03T23:00:00.000Z',
    ]);
  });

  it('lists the periods overlapping a range', () => {
    const days = periodsBetween(
      at('2026-10-24T12:00:00.000Z'),
      at('2026-10-26T12:00:00.000Z'),
      'day',
      OSLO,
    );
    expect(days.map((d) => periodKey(d.start, 'day', OSLO))).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]);
    // Half-open: a range ending exactly at local midnight has no extra day.
    expect(
      periodsBetween(at('2026-10-24T12:00:00.000Z'), at('2026-10-25T23:00:00.000Z'), 'day', OSLO),
    ).toHaveLength(2);
    expect(
      periodsBetween(at('2026-10-24T12:00:00.000Z'), at('2026-10-24T12:00:00.000Z'), 'day', OSLO),
    ).toEqual([]);
  });
});

describe('isoWeekRange', () => {
  const OSLO = 'Europe/Oslo';
  const iso = (ms: number) => new Date(ms).toISOString();

  it.each([
    // Week 1 can start in December, week 53 can end in January.
    ['2026-W01', '2025-12-28T23:00:00.000Z', '2026-01-04T23:00:00.000Z'],
    ['2026-W45', '2026-11-01T23:00:00.000Z', '2026-11-08T23:00:00.000Z'],
    ['2026-W53', '2026-12-27T23:00:00.000Z', '2027-01-03T23:00:00.000Z'],
    ['2027-W01', '2027-01-03T23:00:00.000Z', '2027-01-10T23:00:00.000Z'],
    ['2020-W53', '2020-12-27T23:00:00.000Z', '2021-01-03T23:00:00.000Z'],
    ['2021-W01', '2021-01-03T23:00:00.000Z', '2021-01-10T23:00:00.000Z'],
    // DST changes: 167 hours in March, 169 in October.
    ['2026-W13', '2026-03-22T23:00:00.000Z', '2026-03-29T22:00:00.000Z'],
    ['2026-W43', '2026-10-18T22:00:00.000Z', '2026-10-25T23:00:00.000Z'],
  ])('%s is [%s, %s)', (key, start, end) => {
    const range = isoWeekRange(key, OSLO);
    expect([iso(range.start), iso(range.end)]).toEqual([start, end]);
  });

  it('is the inverse of periodKey for every week of 2020–2027', () => {
    let ms = Date.parse('2019-12-30T00:00:00Z');
    while (ms < Date.parse('2028-01-01T00:00:00Z')) {
      const key = periodKey(ms, 'week', OSLO);
      const range = isoWeekRange(key, OSLO);
      expect(range).toEqual(periodAt(ms, 'week', OSLO));
      ms = range.end + 3 * 24 * 3600_000;
    }
  });
});

describe('localHourAt', () => {
  const at = (iso: string, timeZone = OSLO) => {
    const { weekday, hour, end } = localHourAt(Date.parse(iso), timeZone);
    return { weekday, hour, end: new Date(end).toISOString() };
  };

  it('gives the local weekday, hour and end of the hour', () => {
    // Monday 9 Nov 2026, 20:15 CET.
    expect(at('2026-11-09T19:15:00.000Z')).toEqual({
      weekday: 1,
      hour: 20,
      end: '2026-11-09T20:00:00.000Z',
    });
    // Sunday 23:59:59.999 local is still Sunday.
    expect(at('2026-11-08T22:59:59.999Z')).toMatchObject({ weekday: 7, hour: 23 });
  });

  it('skips the missing hour in spring', () => {
    // 29 Mar 2026: 02:00 CET jumps to 03:00 CEST at 01:00Z.
    expect(at('2026-03-29T00:30:00.000Z')).toEqual({
      weekday: 7,
      hour: 1,
      end: '2026-03-29T01:00:00.000Z',
    });
    expect(at('2026-03-29T01:00:00.000Z')).toEqual({
      weekday: 7,
      hour: 3,
      end: '2026-03-29T02:00:00.000Z',
    });
  });

  it('gives hour 2 twice in autumn', () => {
    // 25 Oct 2026: 03:00 CEST falls back to 02:00 CET at 01:00Z.
    expect(at('2026-10-25T00:30:00.000Z')).toEqual({
      weekday: 7,
      hour: 2,
      end: '2026-10-25T01:00:00.000Z',
    });
    expect(at('2026-10-25T01:30:00.000Z')).toEqual({
      weekday: 7,
      hour: 2,
      end: '2026-10-25T02:00:00.000Z',
    });
  });

  it('handles half-hour offsets and changes inside a local hour', () => {
    // India is UTC+5:30: local hours start at :30 UTC.
    expect(at('2026-11-09T14:45:00.000Z', 'Asia/Kolkata')).toEqual({
      weekday: 1,
      hour: 20,
      end: '2026-11-09T15:30:00.000Z',
    });
    // Lord Howe Island falls back 30 minutes on 5 Apr 2026 (02:00 +11 → 01:30 +10:30
    // at 15:00Z), so local hour 1 is 90 minutes long and seen twice.
    expect(at('2026-04-04T14:45:00.000Z', 'Australia/Lord_Howe')).toEqual({
      weekday: 7,
      hour: 1,
      end: '2026-04-04T15:00:00.000Z',
    });
    expect(at('2026-04-04T15:10:00.000Z', 'Australia/Lord_Howe')).toEqual({
      weekday: 7,
      hour: 1,
      end: '2026-04-04T15:30:00.000Z',
    });
  });
});
