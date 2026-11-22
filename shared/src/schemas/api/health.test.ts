import { describe, expect, it } from 'vitest';
import { schemaAsserts, without } from '../../test-utils.js';
import { healthResponseSchema } from './health.js';

describe('GET /health response', () => {
  const health = schemaAsserts(healthResponseSchema);
  const valid = {
    status: 'ok',
    serverVersion: '0.1.0',
    contractVersion: '1.12.0',
    timeZone: 'Europe/Oslo',
  };

  it('accepts a valid response', () => {
    health.accepts(valid);
  });

  it.each([
    ['status', 'down'],
    ['serverVersion', '0.1'],
    ['contractVersion', 'v1.3.0'],
    ['timeZone', ''],
  ])('rejects %s = %j', (field, value) => {
    expect(health.issuePaths({ ...valid, [field]: value })).toContain(field);
  });

  it.each(['status', 'serverVersion', 'contractVersion', 'timeZone'] as const)(
    'requires %s',
    (field) => {
      health.rejects(without(valid, field));
    },
  );

  it('rejects unknown fields', () => {
    health.rejects({ ...valid, uptime: 12 });
  });
});
