import { describe, expect, it } from 'vitest';
import { schemaAsserts, without } from '../../test-utils.js';
import {
  ingestRequestSchema,
  ingestResponseSchema,
  ingestVerifyResponseSchema,
  MAX_INGEST_BYTES,
  MAX_INGEST_EVENTS,
} from './ingest.js';

const EVENT_ID = '01933c4e-8a2b-7c3d-9e4f-0a1b2c3d4e5f';
const UUID_V4 = '9b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d';

describe('limits', () => {
  it('matches the documented limits (500 events / 1 MB)', () => {
    expect(MAX_INGEST_EVENTS).toBe(500);
    expect(MAX_INGEST_BYTES).toBe(1024 * 1024);
  });
});

describe('GET /ingest/verify response', () => {
  const verify = schemaAsserts(ingestVerifyResponseSchema);
  const valid = {
    ok: true,
    keyName: 'Gaming PC',
    serverVersion: '0.1.0',
    contractVersion: '1.1.0',
    serverTime: '2026-11-09T12:00:00.000Z',
  };

  it('accepts a valid response', () => {
    verify.accepts(valid);
  });

  it.each([
    ['ok', false],
    ['keyName', ''],
    ['serverVersion', '0.1'],
    ['contractVersion', 'v1.1.0'],
    ['serverTime', '2026-11-09T12:00:00Z'],
    ['serverTime', '2026-11-09T13:00:00.000+01:00'],
    ['serverTime', 1_762_689_600_000],
  ])('rejects %s = %j', (field, value) => {
    expect(verify.issuePaths({ ...valid, [field]: value })).toContain(field);
  });

  it('requires contractVersion', () => {
    verify.rejects({
      ok: true,
      keyName: 'Gaming PC',
      serverVersion: '0.1.0',
      serverTime: valid.serverTime,
    });
  });

  it('requires serverTime', () => {
    verify.rejects(without(valid, 'serverTime'));
  });
});

describe('POST /ingest request', () => {
  const request = schemaAsserts(ingestRequestSchema);
  const batch = (size: number) => ({ events: Array.from({ length: size }, () => ({})) });

  it('accepts 1 and 500 events', () => {
    request.accepts(batch(1));
    request.accepts(batch(MAX_INGEST_EVENTS));
  });

  it('rejects an empty batch and more than 500 events', () => {
    request.rejects(batch(0));
    request.rejects(batch(MAX_INGEST_EVENTS + 1));
  });

  it('does not validate single events (the server does that per event)', () => {
    request.accepts({ events: [{ not: 'an event' }, 42, null] });
  });

  it('rejects a body without events or with extra keys', () => {
    request.rejects({});
    request.rejects({ events: {} });
    request.rejects({ ...batch(1), sentAt: '2026-11-08T19:42:14.000Z' });
  });
});

describe('POST /ingest response', () => {
  const response = schemaAsserts(ingestResponseSchema);
  const valid = {
    accepted: [EVENT_ID],
    duplicates: [],
    rejected: [{ index: 2, eventId: '01933c4f-0000-7000-8000-000000000003', error: 'bad' }],
  };

  it('accepts a valid response', () => {
    response.accepts(valid);
    response.accepts({ accepted: [], duplicates: [], rejected: [] });
  });

  it('accepts a rejection without a usable eventId', () => {
    response.accepts({
      ...valid,
      rejected: [{ index: 0, eventId: null, error: 'eventId: required' }],
    });
    response.accepts({
      ...valid,
      rejected: [{ index: 0, eventId: 'garbage', error: 'eventId: invalid' }],
    });
  });

  it('requires UUIDv7 in accepted and duplicates', () => {
    expect(response.issuePaths({ ...valid, accepted: [UUID_V4] })).toContain('accepted.0');
    expect(response.issuePaths({ ...valid, duplicates: ['x'] })).toContain('duplicates.0');
  });

  it.each([
    ['index', -1],
    ['index', 1.5],
    ['error', ''],
  ])('rejects rejection %s = %j', (field, value) => {
    const rejected = [{ ...valid.rejected[0], [field]: value }];
    expect(response.issuePaths({ ...valid, rejected })).toContain(`rejected.0.${field}`);
  });

  it('rejects extra keys', () => {
    response.rejects({ ...valid, ok: true });
  });
});
