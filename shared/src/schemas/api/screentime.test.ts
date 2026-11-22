import { describe, expect, it } from 'vitest';
import { schemaAsserts } from '../../test-utils.js';
import {
  screentimeHeatmapResponseSchema,
  screentimeQuerySchema,
  screentimeRangeQuerySchema,
  screentimeResponseSchema,
  screentimeWorldsResponseSchema,
} from './screentime.js';

const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-08T00:00:00.000Z';

describe('screentime queries', () => {
  it('defaults bucket to day', () => {
    expect(schemaAsserts(screentimeQuerySchema).accepts({ from: FROM, to: TO })).toEqual({
      from: FROM,
      to: TO,
      bucket: 'day',
    });
    expect(schemaAsserts(screentimeQuerySchema).accepts({})).toEqual({ bucket: 'day' });
  });

  it('rejects a bad bucket and a bad range', () => {
    const query = schemaAsserts(screentimeQuerySchema);
    expect(query.issuePaths({ bucket: 'hour' })).toContain('bucket');
    expect(query.issuePaths({ from: TO, to: FROM })).toContain('to');
  });

  it.each([screentimeQuerySchema, screentimeRangeQuerySchema])(
    'requires from and to together, at most 366 days',
    (schema) => {
      const query = schemaAsserts(schema);
      expect(query.issuePaths({ from: FROM })).toEqual(['to']);
      expect(query.issuePaths({ to: TO })).toEqual(['from']);
      query.accepts({ from: '2025-11-07T00:00:00.000Z', to: TO });
      expect(query.issuePaths({ from: '2025-11-06T23:59:59.999Z', to: TO })).toEqual(['to']);
    },
  );

  it('range query has no bucket', () => {
    const query = schemaAsserts(screentimeRangeQuerySchema);
    query.accepts({ from: FROM, to: TO });
    query.accepts({});
    query.rejects({ bucket: 'day' });
  });
});

describe('screentime response', () => {
  const response = schemaAsserts(screentimeResponseSchema);
  const totals = { playedSeconds: 7200, activeSeconds: 6300, afkSeconds: 900 };
  const stats = {
    sessionCount: 3,
    averagePerDaySeconds: 1028,
    averageSessionSeconds: 2400,
    longestSessionSeconds: 3600,
    afkShare: 0.125,
  };
  const valid = {
    from: FROM,
    to: TO,
    bucket: 'day',
    buckets: [
      {
        period: '2026-11-03',
        start: '2026-11-02T23:00:00.000Z',
        activeSeconds: 6300,
        afkSeconds: 900,
      },
    ],
    totals,
    previous: { playedSeconds: 3600, activeSeconds: 3600, afkSeconds: 0 },
    stats,
  };

  it('accepts a valid response', () => {
    response.accepts(valid);
    response.accepts({ ...valid, previous: null });
  });

  it('rejects a period key that does not match the bucket', () => {
    expect(response.issuePaths({ ...valid, bucket: 'month' })).toContain('buckets.0.period');
  });

  it('rejects totals that do not add up', () => {
    expect(response.issuePaths({ ...valid, totals: { ...totals, afkSeconds: 0 } })).toContain(
      'totals.playedSeconds',
    );
  });

  it.each([-0.1, 1.1])('rejects afkShare %d', (afkShare) => {
    expect(response.issuePaths({ ...valid, stats: { ...stats, afkShare } })).toContain(
      'stats.afkShare',
    );
  });

  it('rejects to before from and a range over 366 days', () => {
    expect(response.issuePaths({ ...valid, from: TO, to: FROM })).toContain('to');
    expect(response.issuePaths({ ...valid, from: '2025-01-01T00:00:00.000Z' })).toContain('to');
  });

  it('rejects buckets that do not add up to totals', () => {
    expect(
      response.issuePaths({ ...valid, buckets: [{ ...valid.buckets[0], afkSeconds: 840 }] }),
    ).toEqual(['totals.afkSeconds']);
  });

  it('requires from and to', () => {
    response.rejects({ ...valid, from: null });
  });
});

describe('screentime worlds response', () => {
  const response = schemaAsserts(screentimeWorldsResponseSchema);
  const world = {
    world: 420,
    seconds: 7200,
    activeSeconds: 6300,
    afkSeconds: 900,
    worldTypes: ['MEMBERS'],
    location: 'GERMANY',
    activity: 'Trade - Members',
  };
  const valid = {
    from: FROM,
    to: TO,
    worlds: [world, { ...world, world: 301, worldTypes: [], location: null, activity: null }],
    worldTypes: [{ type: 'MEMBERS', seconds: 7200 }],
    locations: [
      { location: 'GERMANY', seconds: 7200 },
      { location: null, seconds: 60 },
    ],
  };

  it('accepts a valid response, including unknown world info', () => {
    response.accepts(valid);
  });

  it('rejects to before from', () => {
    expect(response.issuePaths({ ...valid, from: TO, to: FROM })).toContain('to');
  });

  it('rejects lowercase world types and locations', () => {
    response.rejects({ ...valid, worldTypes: [{ type: 'members', seconds: 1 }] });
    response.rejects({ ...valid, locations: [{ location: 'Germany', seconds: 1 }] });
  });

  it('rejects active + AFK that does not add up', () => {
    expect(response.issuePaths({ ...valid, worlds: [{ ...world, afkSeconds: 0 }] })).toContain(
      'worlds.0.seconds',
    );
  });
});

describe('screentime heatmap response', () => {
  const response = schemaAsserts(screentimeHeatmapResponseSchema);
  const cell = { weekday: 1, hour: 20, seconds: 3600 };

  it('accepts cells', () => {
    response.accepts({ from: FROM, to: TO, cells: [cell, { weekday: 7, hour: 0, seconds: 60 }] });
  });

  it.each([
    ['weekday', 0],
    ['weekday', 8],
    ['hour', 24],
    ['hour', -1],
    ['seconds', -60],
  ])('rejects %s = %j', (field, value) => {
    expect(
      response.issuePaths({ from: FROM, to: TO, cells: [{ ...cell, [field]: value }] }),
    ).toContain(`cells.0.${field}`);
  });

  it('rejects to before from', () => {
    expect(response.issuePaths({ from: TO, to: FROM, cells: [cell] })).toContain('to');
  });

  it('rejects the same cell twice', () => {
    expect(response.issuePaths({ from: FROM, to: TO, cells: [cell, cell] })).toContain('cells.1');
  });
});
