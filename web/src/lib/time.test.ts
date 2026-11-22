import { describe, expect, it } from 'vitest';
import {
  chartFrom,
  calendarDate,
  isIsoWeekKey,
  lastDaysFrom,
  lastDaysRange,
  localDateOfCalendar,
  localDateTimeOf,
  localDateTimeToIso,
  parseClock,
  shiftWeek,
  weekDates,
  weekOfDate,
  weeksBetween,
} from './time';

// The web test project runs with TZ=America/Los_Angeles, so anything that
// used browser time instead of the given zone would fail here. The time zone
// rules themselves are tested in shared/src/time.test.ts.

describe('chartFrom', () => {
  // Wednesday 11 November 2026.
  const today = '2026-11-11';

  it('shows the last 7 days for Day, since there is no hourly data', () => {
    expect(chartFrom('day', today, 'UTC')).toBe('2026-11-05T00:00:00.000Z');
  });

  it('starts week, month and year like the calendar periods of gains', () => {
    expect(chartFrom('week', today, 'UTC')).toBe('2026-11-09T00:00:00.000Z');
    expect(chartFrom('month', today, 'UTC')).toBe('2026-11-01T00:00:00.000Z');
    expect(chartFrom('year', today, 'UTC')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('starts the week on Monday also on Monday and Sunday', () => {
    expect(chartFrom('week', '2026-11-09', 'UTC')).toBe('2026-11-09T00:00:00.000Z');
    expect(chartFrom('week', '2026-11-15', 'UTC')).toBe('2026-11-09T00:00:00.000Z');
    // A week that starts in the previous month and year.
    expect(chartFrom('week', '2027-01-01', 'UTC')).toBe('2026-12-28T00:00:00.000Z');
  });

  it('handles the days the clocks change in Europe/Oslo', () => {
    // Clocks go back on Sunday 25 October 2026; the week started in summer time.
    expect(chartFrom('week', '2026-10-25', 'Europe/Oslo')).toBe('2026-10-18T22:00:00.000Z');
    expect(chartFrom('day', '2026-10-26', 'Europe/Oslo')).toBe('2026-10-19T22:00:00.000Z');
  });

  it('uses local midnight in the time zone', () => {
    expect(chartFrom('week', today, 'Europe/Oslo')).toBe('2026-11-08T23:00:00.000Z');
    expect(chartFrom('month', '2026-07-15', 'Europe/Oslo')).toBe('2026-06-30T22:00:00.000Z');
    expect(chartFrom('year', today, 'Europe/Oslo')).toBe('2025-12-31T23:00:00.000Z');
  });
});

describe('lastDaysFrom', () => {
  it('starts at local midnight days - 1 days ago, today included', () => {
    expect(lastDaysFrom(7, '2026-11-11', 'UTC')).toBe('2026-11-05T00:00:00.000Z');
    expect(lastDaysFrom(30, '2026-11-11', 'UTC')).toBe('2026-10-13T00:00:00.000Z');
    expect(lastDaysFrom(1, '2026-11-11', 'UTC')).toBe('2026-11-11T00:00:00.000Z');
  });

  it('uses the offset of the first day when the clocks change in between', () => {
    // 13 October is in summer time (UTC+2); 11 November is winter time (UTC+1).
    expect(lastDaysFrom(30, '2026-11-11', 'Europe/Oslo')).toBe('2026-10-12T22:00:00.000Z');
    expect(lastDaysFrom(7, '2026-11-11', 'Europe/Oslo')).toBe('2026-11-04T23:00:00.000Z');
  });
});

describe('lastDaysRange', () => {
  it('covers today and the days before it, to the next local midnight', () => {
    expect(lastDaysRange(7, '2026-11-11', 'UTC')).toEqual({
      from: '2026-11-05T00:00:00.000Z',
      to: '2026-11-12T00:00:00.000Z',
    });
    expect(lastDaysRange(30, '2026-11-11', 'UTC').from).toBe('2026-10-13T00:00:00.000Z');
    expect(lastDaysRange(90, '2026-11-11', 'UTC').from).toBe('2026-08-14T00:00:00.000Z');
  });

  it('uses local midnights across a change of the clocks in Europe/Oslo', () => {
    // Clocks go back on Sunday 25 October 2026.
    expect(lastDaysRange(7, '2026-10-27', 'Europe/Oslo')).toEqual({
      from: '2026-10-20T22:00:00.000Z',
      to: '2026-10-27T23:00:00.000Z',
    });
  });
});

describe('ISO weeks', () => {
  it('gives the week of a local date, with the year of its Thursday', () => {
    expect(weekOfDate('2026-11-11')).toBe('2026-W46');
    expect(weekOfDate('2026-11-09')).toBe('2026-W46');
    expect(weekOfDate('2026-11-15')).toBe('2026-W46');
    // 2026 has a week 53 (28 Dec 2026 – 3 Jan 2027).
    expect(weekOfDate('2027-01-03')).toBe('2026-W53');
    expect(weekOfDate('2027-01-04')).toBe('2027-W01');
    // 1 January 2026 is a Thursday, so it is in week 1.
    expect(weekOfDate('2026-01-01')).toBe('2026-W01');
    expect(weekOfDate('2025-12-29')).toBe('2026-W01');
  });

  it('recognises ISO week keys', () => {
    expect(isIsoWeekKey('2026-W45')).toBe(true);
    expect(isIsoWeekKey('2026-W01')).toBe(true);
    expect(isIsoWeekKey('2025-W53')).toBe(true);
    for (const value of [
      'foo',
      '2026-46',
      '2026-W00',
      '2026-W54',
      '2026-W5',
      '2026-w45',
      '2026-W45x',
    ]) {
      expect(isIsoWeekKey(value), value).toBe(false);
    }
  });

  it('moves between weeks across years and week 53', () => {
    expect(shiftWeek('2026-W45', 1)).toBe('2026-W46');
    expect(shiftWeek('2026-W45', -1)).toBe('2026-W44');
    expect(shiftWeek('2026-W52', 1)).toBe('2026-W53');
    expect(shiftWeek('2026-W53', 1)).toBe('2027-W01');
    expect(shiftWeek('2027-W01', -1)).toBe('2026-W53');
    // 2025 has no week 53.
    expect(shiftWeek('2026-W01', -1)).toBe('2025-W52');
  });

  it('gives Monday and Sunday, also for the week the clocks change', () => {
    expect(weekDates('2026-W45')).toEqual({ monday: '2026-11-02', sunday: '2026-11-08' });
    // Clocks go back on Sunday 25 October 2026: still seven calendar days.
    expect(weekDates('2026-W43')).toEqual({ monday: '2026-10-19', sunday: '2026-10-25' });
    expect(weekDates('2026-W53')).toEqual({ monday: '2026-12-28', sunday: '2027-01-03' });
  });

  it('lists weeks newest first, both ends included', () => {
    expect(weeksBetween('2026-W52', '2027-W02')).toEqual([
      '2027-W02',
      '2027-W01',
      '2026-W53',
      '2026-W52',
    ]);
    expect(weeksBetween('2026-W45', '2026-W45')).toEqual(['2026-W45']);
    expect(weeksBetween('2026-W46', '2026-W45')).toEqual([]);
  });
});

describe('a typed date and time', () => {
  const OSLO = 'Europe/Oslo';

  it('reads a 24-hour time', () => {
    expect(parseClock('21:40')).toEqual({ hour: 21, minute: 40 });
    expect(parseClock('9:05')).toEqual({ hour: 9, minute: 5 });
    expect(parseClock(' 00:00 ')).toEqual({ hour: 0, minute: 0 });
    expect(parseClock('23:59')).toEqual({ hour: 23, minute: 59 });
    for (const text of ['', '24:00', '12:60', '9pm', '9:5', '0940', '09.40', '9:05 PM', '-1:00']) {
      expect(parseClock(text)).toBeNull();
    }
  });

  it('gives the date and time of an instant in the given zone, not the browser’s', () => {
    // 23:30 UTC on the 15th is 00:30 on the 16th in Oslo (and the 15th in Los Angeles).
    const ms = Date.parse('2026-11-15T23:30:45.000Z');
    expect(localDateTimeOf(ms, OSLO)).toEqual({ date: '2026-11-16', time: '00:30' });
    expect(localDateTimeOf(ms, 'UTC')).toEqual({ date: '2026-11-15', time: '23:30' });
  });

  it('turns a local date and time into an instant in the given zone', () => {
    expect(localDateTimeToIso('2026-11-16', '00:30', OSLO)).toBe('2026-11-15T23:30:00.000Z');
    // Summer time.
    expect(localDateTimeToIso('2026-07-01', '12:00', OSLO)).toBe('2026-07-01T10:00:00.000Z');
    expect(localDateTimeToIso('2026-11-16', '9:05', 'UTC')).toBe('2026-11-16T09:05:00.000Z');
    expect(localDateTimeToIso('2026-11-16', '25:00', OSLO)).toBeNull();
    // There and back.
    const { date, time } = localDateTimeOf(Date.parse('2026-03-29T00:59:00.000Z'), OSLO);
    expect(localDateTimeToIso(date, time, OSLO)).toBe('2026-03-29T00:59:00.000Z');
  });

  it('carries a local date through a calendar widget without the browser zone moving it', () => {
    for (const date of ['2026-11-16', '2026-01-01', '2026-12-31', '2013-02-22', '2024-02-29']) {
      expect(localDateOfCalendar(calendarDate(date))).toBe(date);
    }
    const carried = calendarDate('2026-11-16');
    expect([carried.getFullYear(), carried.getMonth(), carried.getDate()]).toEqual([2026, 10, 16]);
  });
});
