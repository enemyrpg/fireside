import type { ScreentimeBucket } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import {
  locationRows,
  mostPlayedBucket,
  parseScreentimeRange,
  periodsPlayed,
  worldTypeRows,
  worldTypesLabel,
} from './rows';

describe('parseScreentimeRange', () => {
  it('accepts 7d, 30d and 90d, and gives 30d otherwise', () => {
    expect(parseScreentimeRange('7d')).toBe('7d');
    expect(parseScreentimeRange('90d')).toBe('90d');
    expect(parseScreentimeRange(null)).toBe('30d');
    expect(parseScreentimeRange('all')).toBe('30d');
  });
});

describe('periodsPlayed', () => {
  const bucket = (activeSeconds: number, afkSeconds: number): ScreentimeBucket => ({
    period: '2026-11-09',
    start: '2026-11-09T00:00:00.000Z',
    activeSeconds,
    afkSeconds,
  });

  it('counts periods with active or AFK time', () => {
    expect(periodsPlayed([bucket(0, 0), bucket(60, 0), bucket(0, 60)])).toBe(2);
    expect(periodsPlayed([])).toBe(0);
  });
});

describe('worldTypeRows', () => {
  it('adds free-to-play as total minus members and sorts by time', () => {
    const rows = worldTypeRows(
      [
        { type: 'MEMBERS', seconds: 600 },
        { type: 'SKILL_TOTAL', seconds: 120 },
      ],
      1000,
    );
    expect(rows.map((row) => [row.label, row.seconds])).toEqual([
      ['Members', 600],
      ['Free-to-play', 400],
      ['Skill total', 120],
    ]);
  });

  it('shows everything as free-to-play without types', () => {
    expect(worldTypeRows([], 3600)).toEqual([{ key: 'F2P', label: 'Free-to-play', seconds: 3600 }]);
  });

  it('leaves free-to-play out when all time is members', () => {
    expect(worldTypeRows([{ type: 'MEMBERS', seconds: 60 }], 60).map((row) => row.key)).toEqual([
      'MEMBERS',
    ]);
    expect(worldTypeRows([], 0)).toEqual([]);
  });

  it('shows unknown types by name and keeps every row (no "Other")', () => {
    const types = Array.from({ length: 10 }, (_, index) => ({
      type: `TYPE_${String(index)}`,
      seconds: 100 - index,
    }));
    const rows = worldTypeRows(types, 0);
    expect(rows).toHaveLength(10);
    expect(rows[0]?.label).toBe('Type 0');
    expect(rows.map((row) => row.key)).not.toContain('other');
  });
});

describe('locationRows', () => {
  it('uses display names and shows null as Unknown', () => {
    expect(
      locationRows([
        { location: 'GERMANY', seconds: 600 },
        { location: 'NEW_ZEALAND', seconds: 120 },
        { location: null, seconds: 60 },
      ]).map((row) => row.label),
    ).toEqual(['Germany', 'New Zealand', 'Unknown']);
  });

  it('keeps every location (no "Other")', () => {
    const locations = Array.from({ length: 9 }, (_, index) => ({
      location: `PLACE_${String(index)}`,
      seconds: 100 - index,
    }));
    expect(locationRows(locations)).toHaveLength(9);
  });
});

describe('worldTypesLabel', () => {
  it('joins types and shows free-to-play for none', () => {
    expect(worldTypesLabel(['MEMBERS', 'SKILL_TOTAL'])).toBe('Members, Skill total');
    expect(worldTypesLabel([])).toBe('Free-to-play');
    expect(worldTypesLabel(['SKILL_TOTAL'])).toBe('Free-to-play, Skill total');
  });
});

describe('mostPlayedBucket', () => {
  const bucket = (period: string, activeSeconds: number, afkSeconds = 0): ScreentimeBucket => ({
    period,
    start: `${period}T00:00:00Z`,
    activeSeconds,
    afkSeconds,
  });

  it('gives the bucket with the most active and AFK time together', () => {
    expect(
      mostPlayedBucket([
        bucket('2026-11-13', 100, 50),
        bucket('2026-11-14', 120),
        bucket('2026-11-15', 0),
      ])?.period,
    ).toBe('2026-11-13');
  });

  it('gives the earliest on a tie', () => {
    expect(mostPlayedBucket([bucket('2026-11-13', 60), bucket('2026-11-14', 30, 30)])?.period).toBe(
      '2026-11-13',
    );
  });

  it('gives nothing without play time', () => {
    expect(mostPlayedBucket([bucket('2026-11-13', 0)])).toBeUndefined();
    expect(mostPlayedBucket([])).toBeUndefined();
  });
});
