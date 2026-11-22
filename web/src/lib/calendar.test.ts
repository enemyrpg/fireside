import type { CalendarDay } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import {
  CALENDAR_DAYS,
  CALENDAR_WEEKS,
  calendarGrid,
  calendarRange,
  daysPlayedLabel,
} from './calendar';

const day = (date: string, playedSeconds = 3600): CalendarDay => ({
  date,
  playedSeconds,
  activeSeconds: playedSeconds,
  afkSeconds: 0,
  sessionCount: 1,
});

const inRange = (today: string) =>
  calendarGrid(today, [])
    .weeks.flat()
    .filter((cell) => cell.inRange);

describe('calendarRange', () => {
  it('covers today and the 364 days before it, from local midnight to local midnight', () => {
    // Oslo: UTC+1 in November.
    expect(calendarRange('2026-11-11', 'Europe/Oslo')).toEqual({
      from: '2025-11-11T23:00:00.000Z',
      to: '2026-11-11T23:00:00.000Z',
    });
  });

  it('stays within the API limit of 366 days of 24 hours across DST', () => {
    for (const today of ['2026-03-29', '2026-10-25', '2026-11-11', '2028-02-29']) {
      const { from, to } = calendarRange(today, 'Europe/Oslo');
      expect(Date.parse(to) - Date.parse(from)).toBeLessThanOrEqual(366 * 86_400_000);
    }
  });
});

describe('calendarGrid', () => {
  it.each([
    '2026-11-09', // Monday
    '2026-11-11', // Wednesday
    '2026-11-15', // Sunday
  ])('has 53 Monday-first weeks with exactly 365 days in range (today %s)', (today) => {
    const grid = calendarGrid(today, []);
    expect(grid.weeks).toHaveLength(CALENDAR_WEEKS);
    expect(grid.weeks.every((week) => week.length === 7)).toBe(true);
    const cells = inRange(today);
    expect(cells).toHaveLength(CALENDAR_DAYS);
    expect(cells.at(-1)?.date).toBe(today);
    // The last column holds today; the first column starts on a Monday.
    expect(grid.weeks.at(-1)?.some((cell) => cell.date === today)).toBe(true);
    expect(new Date(`${grid.weeks[0]?.[0]?.date ?? ''}T12:00:00Z`).getUTCDay()).toBe(1);
  });

  it('blanks days after today and before the year', () => {
    const grid = calendarGrid('2026-11-11', []);
    const last = grid.weeks.at(-1) ?? [];
    expect(last.map((cell) => cell.inRange)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    const first = grid.weeks[0] ?? [];
    // 2025-11-12 is a Wednesday: Monday and Tuesday are before the year.
    expect(first.map((cell) => [cell.date, cell.inRange])).toEqual([
      ['2025-11-10', false],
      ['2025-11-11', false],
      ['2025-11-12', true],
      ['2025-11-13', true],
      ['2025-11-14', true],
      ['2025-11-15', true],
      ['2025-11-16', true],
    ]);
  });

  it('fills days with play time and ignores days outside the year', () => {
    const grid = calendarGrid('2026-11-11', [
      day('2025-11-11'), // a day too old (outside the range)
      day('2026-02-28', 600),
      day('2026-11-11', 7200),
    ]);
    const cells = grid.weeks.flat();
    expect(cells.find((cell) => cell.date === '2025-11-11')?.day).toBeNull();
    expect(cells.find((cell) => cell.date === '2026-02-28')?.day?.playedSeconds).toBe(600);
    expect(cells.find((cell) => cell.date === '2026-11-11')?.day?.playedSeconds).toBe(7200);
  });

  it('crosses a leap day', () => {
    const dates = inRange('2028-03-01').map((cell) => cell.date);
    expect(dates).toContain('2028-02-29');
    expect(dates[0]).toBe('2027-03-03');
  });

  it('labels each month once, on the first column whose Monday is in it', () => {
    const { monthLabels, weeks } = calendarGrid('2026-11-11', []);
    const labelled = monthLabels.filter((label) => label !== '');
    // The first column (November 2025) has no label; December … November follow.
    expect(monthLabels[0]).toBe('');
    expect(labelled).toEqual([
      'Dec',
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
    ]);
    const december = monthLabels.indexOf('Dec');
    expect(weeks[december]?.[0]?.date).toBe('2025-12-01');
  });
});

describe('daysPlayedLabel', () => {
  it('counts days', () => {
    expect(daysPlayedLabel(0)).toBe('0 days played in the last year');
    expect(daysPlayedLabel(1)).toBe('1 day played in the last year');
    expect(daysPlayedLabel(214)).toBe('214 days played in the last year');
  });
});
