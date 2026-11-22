import { describe, expect, it } from 'vitest';
import {
  heatFacts,
  heatmapSummary,
  heatStep,
  hourSpanLabel,
  mostPlayedHour,
  mostPlayedWeekday,
  twoHourBlocks,
} from './heat';

describe('heatStep', () => {
  it('gives 0 for no time', () => {
    expect(heatStep(0, 3600)).toBe(0);
    expect(heatStep(0, 0)).toBe(0);
  });

  it('follows 1 + floor(sqrt(v / max) × 6)', () => {
    expect(heatStep(1, 3600)).toBe(1);
    expect(heatStep(900, 3600)).toBe(4); // sqrt × 6 = 3
    expect(heatStep(100, 3600)).toBe(2); // sqrt(1/36) × 6 = 1
    expect(heatStep(3599, 3600)).toBe(6);
  });

  it('caps the maximum at step 6', () => {
    expect(heatStep(3600, 3600)).toBe(6);
  });
});

describe('heatFacts', () => {
  // Mon 14:00 1 h, Mon 16:00 and 17:00 40 min each: the hour is 14:00, but the
  // 16:00–18:00 block (80 min) beats the 14:00–16:00 block (60 min).
  const cells = [
    { weekday: 1, hour: 14, seconds: 3600 },
    { weekday: 1, hour: 16, seconds: 2400 },
    { weekday: 1, hour: 17, seconds: 2400 },
  ];

  it('names the hour on PC', () => {
    expect(heatFacts(cells, 1)).toEqual({
      day: { value: 'Monday', what: 'day with most play time', duration: '2 h 20 min' },
      hour: { value: '14:00', what: 'hour with most play time', duration: '1 h' },
    });
  });

  it('names the two-hour block on mobile, as the grid shows it', () => {
    expect(heatFacts(cells, 2)?.hour).toEqual({
      value: '16:00–18:00',
      what: '2 hours with most play time',
      duration: '1 h 20 min',
    });
  });

  it('gives the earliest block on a tie', () => {
    const tied = [
      { weekday: 3, hour: 23, seconds: 600 },
      { weekday: 2, hour: 5, seconds: 600 },
    ];
    expect(heatFacts(tied, 2)?.hour.value).toBe('04:00–06:00');
    expect(heatFacts(tied, 2)?.day.value).toBe('Tuesday');
  });

  it('gives null without play time', () => {
    expect(heatFacts([], 2)).toBeNull();
  });
});

describe('hourSpanLabel', () => {
  it('labels an hour or a block, wrapping at midnight', () => {
    expect(hourSpanLabel(21, 1)).toBe('21:00');
    expect(hourSpanLabel(20, 2)).toBe('20:00–22:00');
    expect(hourSpanLabel(22, 2)).toBe('22:00–00:00');
  });
});

describe('heatmapSummary', () => {
  it('names the same day and hour or block as the numbers above the grid', () => {
    const cells = [
      { weekday: 6, hour: 19, seconds: 3600 },
      { weekday: 7, hour: 18, seconds: 3600 },
      { weekday: 7, hour: 19, seconds: 3600 },
    ];
    expect(heatmapSummary(cells, 1)).toBe(
      'Day with most play time: Sunday, 2 h. Hour with most play time: 19:00, 2 h.',
    );
    expect(heatmapSummary(cells, 2)).toBe(
      'Day with most play time: Sunday, 2 h. 2 hours with most play time: 18:00–20:00, 3 h.',
    );
    expect(heatmapSummary([], 1)).toBe('No play time.');
  });
});

describe('mostPlayedWeekday and mostPlayedHour', () => {
  const cells = [
    { weekday: 6, hour: 21, seconds: 3000 },
    { weekday: 6, hour: 22, seconds: 2000 },
    { weekday: 1, hour: 21, seconds: 4000 },
    { weekday: 7, hour: 9, seconds: 100 },
  ];

  it('sums the cells per weekday and per hour', () => {
    expect(mostPlayedWeekday(cells)).toEqual({ key: 6, seconds: 5000 });
    expect(mostPlayedHour(cells)).toEqual({ key: 21, seconds: 7000 });
  });

  it('gives the earliest on a tie, whatever the order of the cells', () => {
    const tied = [
      { weekday: 7, hour: 23, seconds: 600 },
      { weekday: 2, hour: 4, seconds: 600 },
    ];
    expect(mostPlayedWeekday(tied)).toEqual({ key: 2, seconds: 600 });
    expect(mostPlayedHour(tied)).toEqual({ key: 4, seconds: 600 });
    expect(mostPlayedWeekday([...tied].reverse())).toEqual({ key: 2, seconds: 600 });
  });

  it('gives null without play time', () => {
    expect(mostPlayedWeekday([])).toBeNull();
    expect(mostPlayedHour([{ weekday: 1, hour: 0, seconds: 0 }])).toBeNull();
  });

  it('handles a single cell', () => {
    expect(mostPlayedWeekday([{ weekday: 7, hour: 0, seconds: 1 }])).toEqual({
      key: 7,
      seconds: 1,
    });
    expect(mostPlayedHour([{ weekday: 7, hour: 0, seconds: 1 }])).toEqual({ key: 0, seconds: 1 });
  });
});

describe('twoHourBlocks', () => {
  it('sums hours 2k and 2k + 1 per weekday', () => {
    const blocks = twoHourBlocks([
      { weekday: 1, hour: 20, seconds: 100 },
      { weekday: 1, hour: 21, seconds: 50 },
      { weekday: 1, hour: 22, seconds: 7 },
      { weekday: 2, hour: 21, seconds: 3 },
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks).toContainEqual({ weekday: 1, hour: 20, seconds: 150 });
    expect(blocks).toContainEqual({ weekday: 1, hour: 22, seconds: 7 });
    expect(blocks).toContainEqual({ weekday: 2, hour: 20, seconds: 3 });
  });
});
