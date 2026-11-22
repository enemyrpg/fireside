import { describe, expect, it } from 'vitest';
import {
  createFormatter,
  formatAccountType,
  formatAxisDate,
  formatAxisHours,
  formatBytes,
  formatClock,
  formatCompact,
  formatDate,
  formatDateTime,
  formatDelta,
  formatDuration,
  formatMonthYear,
  formatRunTime,
  formatGp,
  formatGpExact,
  formatInt,
  formatIsoWeek,
  formatLocalDate,
  formatLocalDateLong,
  formatMonth,
  formatAxisDay,
  formatAxisWeekday,
  formatBankTab,
  formatCount,
  formatEquipmentSlot,
  formatItemCount,
  formatLocation,
  formatPbTime,
  formatPercent,
  formatSignedPercent,
  formatProgressPercent,
  formatRelative,
  formatSkill,
  formatWorldType,
  formatXpGain,
  isoWeekStart,
  localDateIn,
  parseLocalDate,
} from './format';

// One test per row in docs/design.md#number-and-time-formats. The web test project runs
// with TZ=America/Los_Angeles, so anything formatted in browser time instead
// of the server's zone (Europe/Oslo here) fails.
const timeZone = 'Europe/Oslo';
const now = '2026-11-10T15:00:00.000Z'; // Tue 10 Nov 2026, 16:00 in Oslo
const ctx = { timeZone, now };

describe('test environment', () => {
  it('runs in a browser time zone that differs from the server zone', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Los_Angeles');
  });
});

describe('integers', () => {
  it('uses thousands separators', () => {
    expect(formatInt(2851)).toBe('2,851');
    expect(formatInt(0)).toBe('0');
    expect(formatInt(1_234_567)).toBe('1,234,567');
  });
});

describe('compact numbers', () => {
  it.each([
    [8866, '8,866'],
    [9999, '9,999'],
    [10_000, '10K'],
    [26_700, '26.7K'],
    [99_960, '100K'],
    [175_000, '175K'],
    [999_999, '1M'],
    [1_120_000, '1.12M'],
    [12_080_000, '12.08M'],
    [99_999_999, '100M'],
    [333_146_503, '333.1M'],
    [2_130_000_000, '2.13B'],
    [2_000_000_000, '2B'],
    [-26_700, '-26.7K'],
  ])('%d -> %s', (value, expected) => {
    expect(formatCompact(value)).toBe(expected);
  });
});

describe('GP', () => {
  it('is compact with " gp", exact in the tooltip', () => {
    expect(formatGp(1_120_000)).toBe('1.12M gp');
    expect(formatGpExact(1_120_000)).toBe('1,120,000 gp');
  });
});

describe('XP in tables', () => {
  it('is a whole number with + for gains', () => {
    expect(formatXpGain(553_151)).toBe('+553,151');
    expect(formatXpGain(0)).toBe('0');
  });
});

describe('durations', () => {
  it.each([
    [4 * 3600 + 55 * 60, '4 h 55 min'],
    [3 * 3600, '3 h'],
    [40 * 60, '40 min'],
    [40 * 60 + 59, '40 min'],
    [59, '0 min'],
    [0, '0 min'],
    [1000 * 3600, '1,000 h'],
  ])('%d s -> %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe('bytes', () => {
  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1_000, '1.0 kB'],
    [1_550, '1.6 kB'],
    [812_345, '812 kB'],
    [18_874_368, '19 MB'],
    [2_500_000_000, '2.5 GB'],
  ])('%d -> %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe('run time', () => {
  it.each([
    [0, '0 s'],
    [812, '0.8 s'],
    [9_949, '9.9 s'],
    [12_400, '12 s'],
    [60_000, '1 min'],
    [75_300, '1 min 15 s'],
    [3_720_000, '1 h 2 min'],
  ])('%d ms -> %s', (ms, expected) => {
    expect(formatRunTime(ms)).toBe(expected);
  });
});

describe('month and year', () => {
  it('uses the time zone', () => {
    const context = { timeZone: 'Europe/Oslo' };
    expect(formatMonthYear('2026-11-01T18:00:00.000Z', context)).toBe('Nov 2026');
    // 23:30 UTC on 31 Oct is already November in Oslo.
    expect(formatMonthYear('2026-10-31T23:30:00.000Z', context)).toBe('Nov 2026');
  });
});

describe('time axes', () => {
  it('shows hours', () => {
    expect([0, 4, 12].map(formatAxisHours)).toEqual(['0h', '4h', '12h']);
  });
});

describe('percent', () => {
  it('has no space', () => {
    expect(formatPercent(0.2)).toBe('20%');
    expect(formatPercent(0.0449)).toBe('4%');
    // A change (price movers): signed, one decimal, a real minus sign.
    expect(formatSignedPercent(0.042)).toBe('+4.2%');
    expect(formatSignedPercent(-0.0261)).toBe('−2.6%');
    expect(formatSignedPercent(0.03)).toBe('+3%');
    expect(formatSignedPercent(0)).toBe('0%');
    // Never "0%" for a change that is not zero.
    expect(formatSignedPercent(0.0004)).toBe('+<0.1%');
    expect(formatSignedPercent(-0.00001)).toBe('−<0.1%');
    expect(formatSignedPercent(0.0005)).toBe('+0.1%');
  });

  it('formats progress with one decimal, rounded down so it never reaches 100% early', () => {
    expect(formatProgressPercent(1999, 2000)).toBe('99.9%');
    expect(formatProgressPercent(19995, 20000)).toBe('99.9%');
    expect(formatProgressPercent(2000, 2000)).toBe('100.0%');
    expect(formatProgressPercent(105, 244)).toBe('43.0%');
    expect(formatProgressPercent(29, 100)).toBe('29.0%');
    expect(formatProgressPercent(0, 0)).toBe('0.0%');
  });
});

describe('change', () => {
  it('matches the example', () => {
    expect(
      formatDelta({
        current: 600_000,
        previous: 614_460,
        format: formatDuration,
        comparedTo: 'previous 30 days',
      }),
    ).toBe('▼ 4 h 1 min (−2%) vs previous 30 days');
  });

  it('shows an increase and leaves out the percent from zero', () => {
    expect(
      formatDelta({ current: 3600, previous: 0, format: formatDuration, comparedTo: 'last week' }),
    ).toBe('▲ 1 h vs last week');
    expect(
      formatDelta({
        current: 7200,
        previous: 3600,
        format: formatDuration,
        comparedTo: 'last week',
      }),
    ).toBe('▲ 1 h (+100%) vs last week');
  });

  it('says when nothing changed', () => {
    expect(
      formatDelta({ current: 5, previous: 5, format: formatInt, comparedTo: 'last week' }),
    ).toBe('No change vs last week');
  });
});

describe('PB times', () => {
  it.each([
    [1088.4, '18:08.4'],
    [65, '1:05.0'],
    [5.04, '0:05.0'],
    [59.96, '1:00.0'],
    [3725.5, '1:02:05.5'],
  ])('%d s -> %s', (seconds, expected) => {
    expect(formatPbTime(seconds)).toBe(expected);
  });
});

describe('clock', () => {
  it('is 24-hour in the server zone', () => {
    expect(formatClock('2026-11-10T15:32:00.000Z', ctx)).toBe('16:32');
    expect(formatClock('2026-11-10T23:05:00.000Z', ctx)).toBe('00:05');
  });
});

describe('dates', () => {
  it('shows weekday, day and month in the current year', () => {
    expect(formatDate('2026-11-10T12:00:00.000Z', ctx)).toBe('Tue 10 Nov');
  });

  it('adds the year when it is not the current year', () => {
    expect(formatDate('2025-12-06T12:00:00.000Z', ctx)).toBe('Sat 6 Dec 2025');
  });

  it('formats local dates from the API without time zone conversion', () => {
    expect(formatLocalDate('2026-11-09', ctx)).toBe('Mon 9 Nov');
    expect(formatLocalDate('2025-12-06', ctx)).toBe('Sat 6 Dec 2025');
    // Always with the year, for a date the owner picks.
    expect(formatLocalDateLong('2026-11-16')).toBe('Mon 16 Nov 2026');
    expect(formatMonth('2026-11')).toBe('Nov');
    expect(formatMonth('2026-01', '2-digit')).toBe('Jan 26');
    expect(formatMonth('2025-12', 'numeric')).toBe('Dec 2025');
    // In browser time (UTC-8) this date would be the day before if parsed with new Date().
    expect(formatLocalDate('2026-01-01', ctx)).toBe('Thu 1 Jan');
  });

  it('formats local dates as short axis labels', () => {
    expect(formatAxisDate('2026-11-09')).toBe('9 Nov');
    // In browser time (UTC-8) this would be 31 Dec if parsed with new Date().
    expect(formatAxisDate('2026-01-01')).toBe('1 Jan');
  });

  it('rejects anything that is not a local date', () => {
    expect(() => parseLocalDate('2026-11-09T00:00:00Z')).toThrow();
  });

  it('uses the current year in the server zone', () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Oslo.
    const newYear = { timeZone, now: '2025-12-31T23:30:00.000Z' };
    expect(formatDate('2025-12-31T23:30:00.000Z', newYear)).toBe('Thu 1 Jan');
    expect(formatDate('2025-12-31T12:00:00.000Z', newYear)).toBe('Wed 31 Dec 2025');
  });
});

describe('relative times', () => {
  it.each([
    ['2026-11-10T15:00:00.000Z', 'just now'],
    ['2026-11-10T14:59:30.000Z', 'just now'],
    ['2026-11-10T15:00:30.000Z', 'just now'],
    ['2026-11-10T14:48:00.000Z', '12 min ago'],
    ['2026-11-10T12:00:00.000Z', '3 h ago'],
    ['2026-11-09T15:00:01.000Z', '23 h ago'],
  ])('%s -> %s', (value, expected) => {
    expect(formatRelative(value, ctx)).toBe(expected);
  });

  it('shows date and time from 24 hours', () => {
    expect(formatRelative('2026-11-01T15:26:00.000Z', ctx)).toBe('1 Nov, 16:26');
    expect(formatDateTime('2025-11-01T15:26:00.000Z', ctx)).toBe('1 Nov 2025, 16:26');
  });
});

describe('ISO weeks', () => {
  it('formats with and without the year', () => {
    expect(formatIsoWeek('2026-W46')).toBe('Week 46');
    expect(formatIsoWeek('2026-W46', { withYear: true })).toBe('2026 · week 46');
    expect(formatIsoWeek('2026-W05')).toBe('Week 5');
  });

  it('finds the Monday with calendar arithmetic, also across years', () => {
    expect(isoWeekStart('2026-W46')).toBe('2026-11-09');
    expect(isoWeekStart('2026-W01')).toBe('2025-12-29');
    expect(isoWeekStart('2026-W53')).toBe('2026-12-28');
    expect(isoWeekStart('2027-W01')).toBe('2027-01-04');
  });
});

describe('names', () => {
  it('uses sentence case for skills', () => {
    expect(formatSkill('RUNECRAFT')).toBe('Runecraft');
    expect(formatSkill('HITPOINTS')).toBe('Hitpoints');
  });

  it('has display names for locations and world types, sentence case otherwise', () => {
    expect(formatLocation('UNITED_STATES_OF_AMERICA')).toBe('United States');
    expect(formatLocation('NEW_ZEALAND')).toBe('New Zealand');
    expect(formatLocation('SOUTH__AFRICA_')).toBe('South Africa');
    expect(formatLocation(null)).toBe('Unknown');
    expect(formatWorldType('SKILL_TOTAL')).toBe('Skill total');
    expect(formatWorldType('PVP')).toBe('PvP');
    expect(formatWorldType('SOME_NEW_TYPE')).toBe('Some new type');
  });

  it('shows account types as text', () => {
    expect(formatAccountType('HARDCORE_GROUP_IRONMAN')).toBe('HC group ironman');
    expect(formatAccountType('ULTIMATE_IRONMAN')).toBe('Ultimate ironman');
    expect(formatAccountType('FUTURE_MODE')).toBe('Future mode');
  });
});

describe('server time zone', () => {
  it('puts a session at 00:30 local time on the right day', () => {
    // 00:30 in Oslo on Tue 10 Nov is 23:30 UTC on Mon 9 Nov (and 15:30 in browser time).
    const start = '2026-11-09T23:30:00.000Z';
    expect(formatClock(start, ctx)).toBe('00:30');
    expect(formatDate(start, ctx)).toBe('Tue 10 Nov');
    expect(localDateIn(start, timeZone)).toBe('2026-11-10');
  });

  it('handles the change to summer time (29 Mar 2026, 02:00 -> 03:00)', () => {
    const before = '2026-03-29T00:30:00.000Z';
    const after = '2026-03-29T01:30:00.000Z';
    expect(formatClock(before, ctx)).toBe('01:30');
    expect(formatClock(after, ctx)).toBe('03:30');
    // The clock jumps two hours, but the session lasted one.
    expect(formatDuration((Date.parse(after) - Date.parse(before)) / 1000)).toBe('1 h');
    expect(formatDate(after, ctx)).toBe('Sun 29 Mar');
  });

  it('handles the change back to winter time (25 Oct 2026, 03:00 -> 02:00)', () => {
    const first = '2026-10-25T00:30:00.000Z';
    const second = '2026-10-25T01:30:00.000Z';
    expect(formatClock(first, ctx)).toBe('02:30');
    expect(formatClock(second, ctx)).toBe('02:30');
    expect(formatDuration((Date.parse(second) - Date.parse(first)) / 1000)).toBe('1 h');
  });

  it('binds the zone and clock in createFormatter', () => {
    const format = createFormatter(timeZone, () => new Date(now));
    expect(format.clock('2026-11-09T23:30:00.000Z')).toBe('00:30');
    expect(format.relative('2026-11-10T14:48:00.000Z')).toBe('12 min ago');
    expect(format.localDate('2026-11-09')).toBe('Mon 9 Nov');
    expect(format.localDateOf('2026-11-09T23:30:00.000Z')).toBe('2026-11-10');
  });
});

describe('chart axis dates', () => {
  it('shows a local date as a weekday or day of month', () => {
    expect(formatAxisWeekday('2026-11-09')).toBe('Mon');
    expect(formatAxisWeekday('2026-11-15')).toBe('Sun');
    expect(formatAxisDay('2026-11-09')).toBe('9');
  });
});

describe('bank', () => {
  it('formats counts with their noun', () => {
    expect(formatCount(1, 'item')).toBe('1 item');
    expect(formatCount(0, 'item')).toBe('0 items');
    expect(formatCount(1204, 'slot')).toBe('1,204 slots');
  });

  it('formats items and placeholders', () => {
    expect(formatItemCount(94, 1)).toBe('94 items · 1 placeholder');
    expect(formatItemCount(1, 12)).toBe('1 item · 12 placeholders');
  });

  it('names bank tabs', () => {
    expect(formatBankTab(0)).toBe('Main tab');
    expect(formatBankTab(2)).toBe('Tab 2');
  });

  it('names equipment slots', () => {
    expect(formatEquipmentSlot('HEAD')).toBe('Head');
    expect(formatEquipmentSlot('QUIVER_AMMO')).toBe('Quiver ammo');
  });
});
