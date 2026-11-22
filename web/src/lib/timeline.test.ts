import { describe, expect, it } from 'vitest';
import { formatClock } from '@/format';
import {
  activeSegments,
  positionPercent,
  sessionEndMs,
  TICK_EDGE_CLEARANCE_PX,
  tickStepMs,
  timelineTicks,
} from './timeline';

const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);
/** A wide timeline, so only ticks right at the ends are left out. */
const WIDE = 10_000;
const clocks = (start: string, end: string, timeZone: string, width: number | null = WIDE) =>
  timelineTicks(at(start), at(end), timeZone, width).map((tick) =>
    formatClock(tick.ms, { timeZone }),
  );

describe('sessionEndMs', () => {
  it('uses endedAt, or start plus duration for an open session', () => {
    const startedAt = '2026-11-09T18:00:00.000Z';
    expect(
      sessionEndMs({ startedAt, endedAt: '2026-11-09T19:00:00.000Z', durationSeconds: 1 }),
    ).toBe(at('2026-11-09T19:00:00.000Z'));
    expect(sessionEndMs({ startedAt, endedAt: null, durationSeconds: 300 })).toBe(
      at('2026-11-09T18:05:00.000Z'),
    );
  });
});

describe('positionPercent', () => {
  it('places and clamps, also for an empty span', () => {
    expect(positionPercent(50, 0, 200)).toBe(25);
    expect(positionPercent(-5, 0, 200)).toBe(0);
    expect(positionPercent(300, 0, 200)).toBe(100);
    expect(positionPercent(0, 0, 0)).toBe(0);
  });
});

describe('timelineTicks', () => {
  it('picks the step from the span', () => {
    expect(tickStepMs(HOUR)).toBe(HOUR / 4);
    expect(tickStepMs(2 * HOUR)).toBe(HOUR / 2);
    expect(tickStepMs(5 * HOUR)).toBe(HOUR);
    expect(tickStepMs(9 * HOUR)).toBe(2 * HOUR);
  });

  it('puts ticks on whole local steps, without ticks at the very ends', () => {
    // 17:52–20:05 in Oslo (UTC+1): 2 h 13 min, so every 30 min.
    expect(clocks('2026-11-09T16:52:00Z', '2026-11-09T19:05:00Z', 'Europe/Oslo')).toEqual([
      '18:00',
      '18:30',
      '19:00',
      '19:30',
      '20:00',
    ]);
    // 18:00 exactly is at the start, so it is left out.
    expect(clocks('2026-11-09T17:00:00Z', '2026-11-09T18:00:00Z', 'Europe/Oslo')).toEqual([
      '18:15',
      '18:30',
      '18:45',
    ]);
  });

  it('leaves out tick labels that would touch the start or end label, in px', () => {
    // The issue's session, 20:19–22:37 in Oslo, on a phone (about 360 px):
    // 20:30 is 29 px from the start and 22:30 18 px from the end.
    const start = '2026-11-09T19:19:00Z';
    const end = '2026-11-09T21:37:00Z';
    expect(clocks(start, end, 'Europe/Oslo', 360)).toEqual(['21:00', '21:30', '22:00']);
    // Wide enough, they come back.
    expect(clocks(start, end, 'Europe/Oslo', 1200)).toEqual([
      '20:30',
      '21:00',
      '21:30',
      '22:00',
      '22:30',
    ]);
  });

  it('keeps every tick at least the clearance from both ends', () => {
    expect(TICK_EDGE_CLEARANCE_PX).toBe(56);
    const start = at('2026-11-09T18:07:00Z');
    const end = at('2026-11-09T19:58:00Z');
    for (const width of [200, 300, 360, 560, 900]) {
      for (const tick of timelineTicks(start, end, 'UTC', width)) {
        const px = (tick.percent / 100) * width;
        expect(px).toBeGreaterThanOrEqual(TICK_EDGE_CLEARANCE_PX);
        expect(width - px).toBeGreaterThanOrEqual(TICK_EDGE_CLEARANCE_PX);
      }
    }
  });

  it('has no ticks before the width is known', () => {
    expect(clocks('2026-11-09T16:52:00Z', '2026-11-09T19:05:00Z', 'Europe/Oslo', null)).toEqual([]);
  });

  it('follows a half-hour offset', () => {
    // Kolkata is UTC+5:30: 12:30 UTC is 18:00 local.
    expect(clocks('2026-11-09T12:20:00Z', '2026-11-09T16:40:00Z', 'Asia/Kolkata')).toEqual([
      '18:00',
      '19:00',
      '20:00',
      '21:00',
      '22:00',
    ]);
  });

  it('follows the wall clock over the DST change', () => {
    // 25 Oct 2026, Oslo: 03:00 summer time becomes 02:00 winter time (01:00 UTC).
    // The hour 02:00–03:00 happens twice but gets one tick; the gap to 03:00 is two hours.
    const ticks = timelineTicks(
      at('2026-10-24T23:30:00Z'),
      at('2026-10-25T03:30:00Z'),
      'Europe/Oslo',
      WIDE,
    );
    expect(ticks.map((tick) => formatClock(tick.ms, { timeZone: 'Europe/Oslo' }))).toEqual([
      '02:00',
      '03:00',
      '04:00',
    ]);
    expect(ticks.map((tick) => new Date(tick.ms).toISOString())).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T02:00:00.000Z',
      '2026-10-25T03:00:00.000Z',
    ]);
  });
});

describe('activeSegments', () => {
  const start = at('2026-11-09T18:00:00.000Z');
  const end = at('2026-11-09T20:00:00.000Z');
  const afk = (from: string, to: string) => ({
    startedAt: `2026-11-09T${from}:00.000Z`,
    endedAt: `2026-11-09T${to}:00.000Z`,
  });
  const clock = (segments: { fromMs: number; toMs: number }[]) =>
    segments.map((s) => [
      new Date(s.fromMs).toISOString().slice(11, 16),
      new Date(s.toMs).toISOString().slice(11, 16),
    ]);

  it('is the whole session without AFK', () => {
    expect(clock(activeSegments(start, end, []))).toEqual([['18:00', '20:00']]);
  });

  it('fills the gaps between AFK periods, sorted, merged and clipped', () => {
    expect(
      clock(
        activeSegments(start, end, [
          afk('19:30', '19:45'),
          afk('17:50', '18:10'), // starts before the session
          afk('19:40', '19:50'), // overlaps the one before
          afk('19:55', '20:10'), // ends after the session
        ]),
      ),
    ).toEqual([
      ['18:10', '19:30'],
      ['19:50', '19:55'],
    ]);
  });

  it('is empty when the whole session is AFK', () => {
    expect(activeSegments(start, end, [afk('18:00', '20:00')])).toEqual([]);
  });
});
