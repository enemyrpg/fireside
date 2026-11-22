import {
  collectionLogResponseSchema,
  collectionLogStatusResponseSchema,
  collectionLogSyncResponseSchema,
  errorResponseSchema,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { clogBody, fakeRuneProfile, RUNEPROFILE_ON, summaryBody } from '../clog/testing.js';
import { accounts, externalSnapshots } from '../db/schema.js';
import { createExternalClient } from '../external/client.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  TEST_ACCOUNT_HASH,
  type TestRun,
} from '../projections/testing.js';
import { testConfig } from '../test-utils.js';

// The collection log endpoints, on the real syncer with a scripted RuneProfile.
// Whatever RuneProfile does, the dashboard gets a 200 with a status.

const START = '2026-11-09T12:00:00.000Z';

let app: FastifyInstance | undefined;
let run: TestRun | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function start(env: Record<string, string> = RUNEPROFILE_ON) {
  let nowMs = Date.parse(START);
  const now = () => new Date(nowMs);
  run = emptyRun();
  const f = eventFactory();
  ingestBatch(run, [f.sessionStart('19:00', { displayName: 'Seed Main' }), f.sessionEnd('19:30')]);
  const config = testConfig(env);
  const api = fakeRuneProfile(now);
  api.replies.summary = summaryBody(START);
  api.replies.collectionLog = clogBody({ 13262: 1, 4151: 3 });
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const built = buildApp({
    db: run.database,
    config,
    dashboard: { now },
    externalClient: createExternalClient({
      config,
      log: silent,
      fetch: api.fetch,
      now,
      sleep: () => Promise.resolve(),
    }),
  });
  app = built;
  const db = run.database.db;
  const id =
    db.select().from(accounts).where(eq(accounts.accountHash, TEST_ACCOUNT_HASH)).get()?.id ?? 0;
  const base = `/api/v1/accounts/${String(id)}/collection-log`;
  /** Lets a started sync finish: the scripted replies need no timers. */
  const settle = async () => {
    for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    ...api,
    db,
    id,
    base,
    settle,
    advance: (ms: number) => (nowMs += ms),
    async get() {
      const response = await built.inject({ method: 'GET', url: base });
      expect(response.statusCode, response.body).toBe(200);
      return collectionLogResponseSchema.parse(response.json());
    },
    async status() {
      const response = await built.inject({ method: 'GET', url: `${base}/status` });
      expect(response.statusCode, response.body).toBe(200);
      return collectionLogStatusResponseSchema.parse(response.json());
    },
    async setSource(source: string | null) {
      const response = await built.inject({
        method: 'PUT',
        url: `${base}/source`,
        payload: { source },
      });
      expect(response.statusCode, response.body).toBe(200);
      return collectionLogSyncResponseSchema.parse(response.json());
    },
    syncNow: () => built.inject({ method: 'POST', url: `${base}/sync` }),
    inject: built.inject.bind(built),
  };
}

const errorCode = (response: { json(): unknown }) =>
  errorResponseSchema.parse(response.json()).error.code;

describe('GET /accounts/:accountId/collection-log', () => {
  it('is empty with no source, and makes no request', async () => {
    const t = start();
    expect(await t.get()).toEqual({
      accountId: t.id,
      source: null,
      sourceAvailable: true,
      sync: null,
      updatedAt: null,
      obtained: null,
      total: null,
      tabs: [],
    });
    expect(t.requests).toEqual([]);
  });

  it('gives the collection log after the source is turned on', async () => {
    const t = start();
    // Turning the source on starts the first sync.
    expect(await t.setSource('RUNEPROFILE')).toMatchObject({
      accountId: t.id,
      source: 'RUNEPROFILE',
      sync: { status: 'SYNCING', lastSuccessAt: null },
    });
    await t.settle();
    const log = await t.get();
    expect(log).toMatchObject({
      source: 'RUNEPROFILE',
      updatedAt: START,
      obtained: 2,
      total: 5,
      sync: { status: 'OK', lastSuccessAt: START, nextSyncAllowedAt: '2026-11-09T12:01:00.000Z' },
    });
    expect(log.tabs.flatMap((tab) => tab.pages.map((page) => page.name))).toEqual([
      'Abyssal Sire',
      'Vorkath',
      'All Pets',
    ]);
  });

  it.each([
    ['a missing profile', { collectionLog: 404 }, 'PROFILE_NOT_FOUND'],
    [
      'a profile older than our record of the name',
      { summary: summaryBody('2026-11-01T00:00:00.000Z') },
      'PROFILE_FROM_BEFORE_NAME',
    ],
    ['RuneProfile being down', { collectionLog: 503 }, 'UNAVAILABLE'],
    ['a refused key', { collectionLog: 401 }, 'INVALID_API_KEY'],
    ['an unexpected format', { collectionLog: '[]' }, 'INVALID_RESPONSE'],
  ])('answers 200 with a status for %s', async (_name, replies, status) => {
    const t = start();
    Object.assign(t.replies, replies);
    await t.setSource('RUNEPROFILE');
    await t.settle();
    expect(await t.get()).toMatchObject({ source: 'RUNEPROFILE', tabs: [], sync: { status } });
  });

  it('shows SOURCE_OFF when the source is off in .env, and keeps the choice', async () => {
    const t = start({});
    expect((await t.setSource('RUNEPROFILE')).sync?.status).toBe('SOURCE_OFF');
    await t.settle();
    expect(t.requests).toEqual([]);
    expect(await t.get()).toMatchObject({
      source: 'RUNEPROFILE',
      sourceAvailable: false,
      sync: { status: 'SOURCE_OFF' },
    });
    // Every user sees that, without the admin-only external sources route.
    expect(await t.status()).toMatchObject({ sourceAvailable: false });
  });

  it('is per account: 404 for an unknown account, 400 for all', async () => {
    const t = start();
    const unknown = await t.inject({ method: 'GET', url: '/api/v1/accounts/999/collection-log' });
    expect([unknown.statusCode, errorCode(unknown)]).toEqual([404, 'NOT_FOUND']);
    const all = await t.inject({ method: 'GET', url: '/api/v1/accounts/all/collection-log' });
    expect([all.statusCode, errorCode(all)]).toEqual([400, 'VALIDATION_ERROR']);
    const query = await t.inject({ method: 'GET', url: `${t.base}?tab=Bosses` });
    expect([query.statusCode, errorCode(query)]).toEqual([400, 'VALIDATION_ERROR']);
  });
});

describe('GET /accounts/:accountId/collection-log/status', () => {
  it('is empty with no source, and makes no request', async () => {
    const t = start();
    expect(await t.status()).toEqual({
      accountId: t.id,
      source: null,
      sourceAvailable: true,
      sync: null,
      updatedAt: null,
      obtained: null,
      total: null,
    });
    expect(t.requests).toEqual([]);
  });

  it('is the collection log without its tabs, in every state', async () => {
    const t = start();
    const same = async () => {
      const rest: Partial<Awaited<ReturnType<typeof t.get>>> = await t.get();
      delete rest.tabs;
      expect(await t.status()).toEqual(rest);
      return rest;
    };
    await t.setSource('RUNEPROFILE');
    await t.settle();
    expect(await same()).toMatchObject({ sync: { status: 'OK' }, obtained: 2, total: 5 });
    // A failed sync keeps the counts.
    t.replies.collectionLog = 503;
    t.advance(61_000);
    await t.syncNow();
    await t.settle();
    expect(await same()).toMatchObject({ sync: { status: 'UNAVAILABLE' }, obtained: 2, total: 5 });
    // Turned off: the stored collection log stays.
    await t.setSource(null);
    expect(await same()).toMatchObject({ source: null, sync: null, obtained: 2, total: 5 });
  });

  it('is per account: 404 for an unknown account, 400 for all and for a query', async () => {
    const t = start();
    const unknown = await t.inject({
      method: 'GET',
      url: '/api/v1/accounts/999/collection-log/status',
    });
    expect(unknown.statusCode).toBe(404);
    const all = await t.inject({
      method: 'GET',
      url: '/api/v1/accounts/all/collection-log/status',
    });
    expect(all.statusCode).toBe(400);
    expect((await t.inject({ method: 'GET', url: `${t.base}/status?x=1` })).statusCode).toBe(400);
  });
});

describe('PUT /accounts/:accountId/collection-log/source', () => {
  it('turns the source off without removing the collection log', async () => {
    const t = start();
    await t.setSource('RUNEPROFILE');
    await t.settle();
    expect(await t.setSource(null)).toEqual({ accountId: t.id, source: null, sync: null });
    expect(await t.get()).toMatchObject({ source: null, sync: null, obtained: 2 });
    expect(t.db.select().from(externalSnapshots).all()).toHaveLength(1);
  });

  it('keeps the sync state when turned on twice', async () => {
    const t = start();
    await t.setSource('RUNEPROFILE');
    await t.settle();
    const requests = t.requests.length;
    expect((await t.setSource('RUNEPROFILE')).sync).toMatchObject({
      status: 'OK',
      lastSuccessAt: START,
    });
    await t.settle();
    // Inside the minute: no second sync.
    expect(t.requests).toHaveLength(requests);
  });

  it.each([
    ['an unknown source', { source: 'WIKISYNC' }, 'body.source'],
    ['no source', {}, 'body.source'],
    ['an extra field', { source: null, username: 'Someone Else' }, 'body'],
  ])('rejects %s', async (_name, payload, path) => {
    const t = start();
    const response = await t.inject({ method: 'PUT', url: `${t.base}/source`, payload });
    expect(response.statusCode).toBe(400);
    const { error } = errorResponseSchema.parse(response.json());
    expect(error.details.map((detail) => detail.path)).toEqual([path]);
    expect(t.requests).toEqual([]);
  });

  it('is 404 for an unknown account', async () => {
    const t = start();
    const response = await t.inject({
      method: 'PUT',
      url: '/api/v1/accounts/999/collection-log/source',
      payload: { source: 'RUNEPROFILE' },
    });
    expect([response.statusCode, errorCode(response)]).toEqual([404, 'NOT_FOUND']);
  });
});

describe('POST /accounts/:accountId/collection-log/sync', () => {
  it('starts a sync and answers 202 at once', async () => {
    const t = start();
    await t.setSource('RUNEPROFILE');
    await t.settle();
    t.advance(60_000);
    t.replies.collectionLog = clogBody({ 13262: 1, 4151: 3, 22006: 1 });
    const response = await t.syncNow();
    expect(response.statusCode, response.body).toBe(202);
    expect(collectionLogSyncResponseSchema.parse(response.json())).toMatchObject({
      source: 'RUNEPROFILE',
      sync: { status: 'SYNCING' },
    });
    await t.settle();
    expect(await t.get()).toMatchObject({
      obtained: 3,
      sync: { status: 'OK', lastChangedAt: '2026-11-09T12:01:00.000Z' },
    });
  });

  it('is limited to once a minute per account, with Retry-After', async () => {
    const t = start();
    await t.setSource('RUNEPROFILE');
    await t.settle();
    const requests = t.requests.length;
    t.advance(59_000);
    const response = await t.syncNow();
    expect([response.statusCode, errorCode(response)]).toEqual([429, 'RATE_LIMITED']);
    expect(response.headers['retry-after']).toBe('1');
    await t.settle();
    expect(t.requests).toHaveLength(requests);
  });

  it('is 409 without a source, and when the source is off in .env', async () => {
    const t = start();
    const none = await t.syncNow();
    expect([none.statusCode, errorCode(none)]).toEqual([409, 'CONFLICT']);
    await app?.close();

    const off = start({});
    await off.setSource('RUNEPROFILE');
    const response = await off.syncNow();
    expect([response.statusCode, errorCode(response)]).toEqual([409, 'CONFLICT']);
    expect(off.requests).toEqual([]);
  });

  it('is 404 for an unknown account', async () => {
    const t = start();
    const response = await t.inject({
      method: 'POST',
      url: '/api/v1/accounts/999/collection-log/sync',
    });
    expect([response.statusCode, errorCode(response)]).toEqual([404, 'NOT_FOUND']);
  });
});
