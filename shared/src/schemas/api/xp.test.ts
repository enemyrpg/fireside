import { describe, expect, it } from 'vitest';
import { schemaAsserts } from '../../test-utils.js';
import { gainsQuerySchema, gainsResponseSchema, xpQuerySchema, xpResponseSchema } from './xp.js';

const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-08T00:00:00.000Z';

describe('xp query', () => {
  const query = schemaAsserts(xpQuerySchema);

  it('defaults bucket to day', () => {
    expect(query.accepts({})).toEqual({ bucket: 'day' });
  });

  it('accepts all parameters', () => {
    expect(query.accepts({ skill: 'SLAYER', from: FROM, to: TO, bucket: 'month' })).toEqual({
      skill: 'SLAYER',
      from: FROM,
      to: TO,
      bucket: 'month',
    });
  });

  it.each([
    ['bucket', 'year'],
    ['skill', 'slayer'],
    ['from', '2026-11-01'],
    ['to', '2026-11-08T00:00:00Z'],
  ])('rejects %s = %j', (field, value) => {
    expect(query.issuePaths({ [field]: value })).toContain(field);
  });

  it('rejects to before or equal to from', () => {
    expect(query.issuePaths({ from: TO, to: FROM })).toContain('to');
    expect(query.issuePaths({ from: FROM, to: FROM })).toContain('to');
  });

  it('rejects unknown parameters', () => {
    query.rejects({ skil: 'SLAYER' });
  });
});

describe('xp response', () => {
  const response = schemaAsserts(xpResponseSchema);
  const point = {
    period: '2026-11-01',
    start: '2026-10-31T23:00:00.000Z',
    xp: 5346332,
    level: 90,
    gained: 120000,
  };

  it('accepts a skill series and an overall series', () => {
    response.accepts({ skill: 'SLAYER', bucket: 'day', points: [point] });
    response.accepts({ skill: null, bucket: 'day', points: [{ ...point, level: 1850 }] });
  });

  it.each([
    ['week', '2026-W45'],
    ['month', '2026-11'],
  ])('accepts %s period keys', (bucket, period) => {
    response.accepts({ skill: null, bucket, points: [{ ...point, period }] });
  });

  it('rejects a period key that does not match the bucket', () => {
    expect(response.issuePaths({ skill: null, bucket: 'week', points: [point] })).toContain(
      'points.0.period',
    );
  });

  it.each([
    ['xp', -1],
    ['gained', -5],
    ['level', 0],
    ['start', '2026-11-01'],
  ])('rejects point %s = %j', (field, value) => {
    expect(
      response.issuePaths({
        skill: 'SLAYER',
        bucket: 'day',
        points: [{ ...point, [field]: value }],
      }),
    ).toContain(`points.0.${field}`);
  });
});

describe('gains query', () => {
  const query = schemaAsserts(gainsQuerySchema);

  it('defaults period to week', () => {
    expect(query.accepts({})).toEqual({ period: 'week' });
  });

  it.each(['day', 'week', 'month', 'year'])('accepts period %s', (period) => {
    query.accepts({ period });
  });

  it('rejects an unknown period and a bad range', () => {
    expect(query.issuePaths({ period: 'decade' })).toContain('period');
    expect(query.issuePaths({ from: TO, to: FROM })).toContain('to');
  });
});

describe('gains response', () => {
  const response = schemaAsserts(gainsResponseSchema);
  const slayer = {
    skill: 'SLAYER',
    startXp: 5000000,
    endXp: 5346332,
    xpGained: 346332,
    startLevel: 89,
    endLevel: 90,
    levelsGained: 1,
  };
  const valid = {
    from: FROM,
    to: TO,
    total: { xpGained: 346332, levelsGained: 1 },
    skills: [slayer],
  };

  it('accepts valid gains', () => {
    response.accepts(valid);
  });

  it('rejects xpGained that does not match start and end', () => {
    expect(response.issuePaths({ ...valid, skills: [{ ...slayer, xpGained: 1 }] })).toContain(
      'skills.0.xpGained',
    );
  });

  it('rejects levelsGained that does not match start and end', () => {
    expect(response.issuePaths({ ...valid, skills: [{ ...slayer, levelsGained: 2 }] })).toContain(
      'skills.0.levelsGained',
    );
  });

  it('rejects to before from', () => {
    expect(response.issuePaths({ ...valid, from: TO, to: FROM })).toContain('to');
  });

  it('rejects negative gains', () => {
    response.rejects({ ...valid, skills: [{ ...slayer, startXp: 6000000, xpGained: -653668 }] });
    response.rejects({ ...valid, total: { xpGained: -1, levelsGained: 0 } });
  });
});
