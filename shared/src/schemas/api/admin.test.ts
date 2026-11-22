import { BRANDING } from '../../branding.js';
import { describe, expect, it } from 'vitest';
import { schemaAsserts, without } from '../../test-utils.js';
import { backupStatusResponseSchema, rebuildResponseSchema } from './admin.js';

const N = BRANDING.shortName;

describe('POST /admin/rebuild response', () => {
  const rebuild = schemaAsserts(rebuildResponseSchema);
  const valid = { processed: 120, failed: 2, durationMs: 85 };

  it('accepts a valid response', () => {
    rebuild.accepts(valid);
    rebuild.accepts({ processed: 0, failed: 0, durationMs: 0 });
  });

  it.each([
    ['processed', -1],
    ['failed', 1.5],
    ['durationMs', '85'],
  ])('rejects %s = %j', (field, value) => {
    expect(rebuild.issuePaths({ ...valid, [field]: value })).toContain(field);
  });

  it.each(['processed', 'failed', 'durationMs'] as const)('requires %s', (field) => {
    rebuild.rejects(without(valid, field));
  });

  it('rejects unknown fields', () => {
    rebuild.rejects({ ...valid, failedEventIds: [] });
  });
});

describe('GET /admin/backups response', () => {
  const status = schemaAsserts(backupStatusResponseSchema);
  const latest = {
    fileName: `${N}-20261114-030000Z.db`,
    createdAt: '2026-11-14T03:00:00.000Z',
    sizeBytes: 1024,
  };
  const valid = {
    enabled: true,
    latest,
    count: 3,
    totalSizeBytes: 3072,
    nextRunAt: '2026-11-15T03:00:00.000Z',
    lastError: null,
  };

  it('accepts a valid response', () => {
    status.accepts(valid);
    status.accepts({ ...valid, latest: null, count: 0, totalSizeBytes: 0 });
    status.accepts({ ...valid, enabled: false, nextRunAt: null });
    status.accepts({
      ...valid,
      lastError: { at: '2026-11-14T03:00:00.412Z', message: 'disk full' },
    });
  });

  it.each([
    ['count', -1],
    ['totalSizeBytes', 1.5],
    ['nextRunAt', '2026-11-15'],
    ['enabled', 'yes'],
  ])('rejects %s = %j', (field, value) => {
    expect(status.issuePaths({ ...valid, [field]: value })).toContain(field);
  });

  it('rejects a bad latest backup or error', () => {
    status.rejects({ ...valid, latest: { ...latest, fileName: '' } });
    status.rejects({ ...valid, latest: { ...latest, createdAt: 'yesterday' } });
    status.rejects({ ...valid, lastError: { at: latest.createdAt, message: '' } });
  });

  it.each(['enabled', 'latest', 'count', 'totalSizeBytes', 'nextRunAt', 'lastError'] as const)(
    'requires %s',
    (field) => {
      status.rejects(without(valid, field));
    },
  );

  it('rejects unknown fields, such as the folder path', () => {
    status.rejects({ ...valid, directory: '/data/backups' });
    status.rejects({ ...valid, latest: { ...latest, path: '/data/backups/x.db' } });
  });
});
