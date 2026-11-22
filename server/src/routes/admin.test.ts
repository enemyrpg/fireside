import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  backupStatusResponseSchema,
  externalSourcesResponseSchema,
  errorResponseSchema,
  rebuildResponseSchema,
  BRANDING,
} from '@fireside/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createApiKey } from '../auth/api-keys.js';
import { isLoopbackAddress } from '../auth/local-only.js';
import type { Database } from '../db/index.js';
import { failedEvents, PROJECTIONS } from '../projections/index.js';
import { eventFactory, failingFor, storeOnly, TEST_NOW } from '../projections/testing.js';
import { tempDir } from '../backup/testing.js';
import { recordAttempt, recordFailure, recordSuccess } from '../external/state.js';
import { testConfig, testDatabase, TEST_OWNER } from '../test-utils.js';

const N = BRANDING.shortName;

const REBUILD = { method: 'POST', url: '/api/v1/admin/rebuild' } as const;

describe('POST /api/v1/admin/rebuild', () => {
  let app: FastifyInstance;
  let database: Database;
  const broken = new Set<string>();

  beforeEach(() => {
    broken.clear();
    database = testDatabase();
    app = buildApp({
      db: database,
      config: testConfig(),
      dashboard: {
        admin: { now: () => TEST_NOW, projections: [...PROJECTIONS, failingFor(broken)] },
      },
    });
  });
  afterEach(() => app.close());

  function storeSession() {
    const f = eventFactory();
    const events = [f.sessionStart('19:00'), f.loot('19:05'), f.sessionEnd('19:10')];
    const { id } = createApiKey(database.db, TEST_OWNER, 'Test');
    storeOnly({ database, apiKeyId: id, failed: [] }, events);
    return events;
  }

  async function expectForbidden(options: InjectOptions) {
    const response = await app.inject({ ...REBUILD, ...options });
    expect(response.statusCode).toBe(403);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('FORBIDDEN');
    // Nothing was rebuilt.
    expect(failedEvents(database.db)).toEqual([]);
  }

  it('rebuilds and reports counts', async () => {
    storeSession();
    const response = await app.inject(REBUILD);
    expect(response.statusCode).toBe(200);
    const body = rebuildResponseSchema.parse(response.json());
    expect(body).toMatchObject({ processed: 3, failed: 0 });
  });

  it('counts failed events', async () => {
    const events = storeSession();
    broken.add(events[1]?.eventId ?? '');
    const response = await app.inject(REBUILD);
    expect(response.json()).toMatchObject({ processed: 2, failed: 1 });
  });

  it.each([
    ['localhost', 'localhost:4000'],
    ['127.0.0.1', '127.0.0.1:4000'],
    ['[::1]', '[::1]:4000'],
  ])('accepts Host %s with a matching Origin', async (_name, host) => {
    const response = await app.inject({
      ...REBUILD,
      headers: { host, origin: `http://${host}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('accepts a request without Origin (curl)', async () => {
    expect((await app.inject({ ...REBUILD, headers: { host: 'localhost:4000' } })).statusCode).toBe(
      200,
    );
  });

  it.each(['192.168.1.20', '100.101.102.103', '::ffff:10.0.0.2', 'fe80::1'])(
    'refuses remote address %s',
    async (remoteAddress) => {
      storeSession();
      await expectForbidden({ remoteAddress });
    },
  );

  it.each(['evil.example', 'localhost.evil.example', '192.168.1.20:4000'])(
    'refuses Host %j (DNS rebinding)',
    async (host) => {
      await expectForbidden({ headers: { host } });
    },
  );

  it.each([
    ['x-forwarded-for', '1.2.3.4'],
    ['x-forwarded-proto', 'https'],
    ['forwarded', 'for=1.2.3.4'],
    ['via', '1.1 proxy'],
    ['tailscale-user-login', 'owner@example.com'],
  ])('refuses proxied requests (%s)', async (name, value) => {
    await expectForbidden({ headers: { [name]: value } });
  });

  it.each(['https://evil.example', 'http://localhost:5555', 'null', 'not a url'])(
    'refuses a POST from Origin %s (CSRF)',
    async (origin) => {
      await expectForbidden({ headers: { host: 'localhost:4000', origin } });
    },
  );

  it('ignores API keys: a valid ingest key does not get past the check', async () => {
    const { key } = createApiKey(database.db, TEST_OWNER, 'Plugin');
    await expectForbidden({
      remoteAddress: '192.168.1.20',
      headers: { authorization: `Bearer ${key}` },
    });
  });
});

describe('GET /api/v1/admin/backups', () => {
  const cleanups: (() => unknown)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function appWithBackupDir(env: Record<string, string> = {}) {
    const { dir, remove } = tempDir();
    cleanups.push(remove);
    const app = buildApp({
      db: testDatabase(),
      config: testConfig({ BACKUP_DIR: dir, TZ: 'Europe/Oslo', ...env }),
      dashboard: { admin: { now: () => TEST_NOW } },
    });
    cleanups.push(() => app.close());
    return { app, dir };
  }

  it('reports the newest backup, the count and the next run, never the folder', async () => {
    const { app, dir } = appWithBackupDir();
    writeFileSync(join(dir, `${N}-20261108-030000Z.db`), 'x'.repeat(100));
    writeFileSync(join(dir, `${N}-20261109-030000Z.db`), 'x'.repeat(250));
    // Not counted: a pre-restore copy and a temp file.
    writeFileSync(join(dir, `${N}-pre-restore-20261109-110000Z.db`), 'x');
    writeFileSync(join(dir, `.${N}-backup-abc.tmp`), 'x');

    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/backups' });
    expect(response.statusCode).toBe(200);
    expect(backupStatusResponseSchema.parse(response.json())).toEqual({
      enabled: true,
      latest: {
        fileName: `${N}-20261109-030000Z.db`,
        createdAt: '2026-11-09T03:00:00.000Z',
        sizeBytes: 250,
      },
      count: 2,
      totalSizeBytes: 350,
      // TEST_NOW is 12:00 UTC on the 9th; next 04:00 in Oslo is 03:00 UTC on the 10th.
      nextRunAt: '2026-11-10T03:00:00.000Z',
      lastError: null,
    });
    expect(response.body).not.toContain(dir);
  });

  it('reports no backups yet, and no next run when automatic backups are off', async () => {
    const { app } = appWithBackupDir({ BACKUP_ENABLED: 'false' });
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/backups' });
    expect(response.json()).toEqual({
      enabled: false,
      latest: null,
      count: 0,
      totalSizeBytes: 0,
      nextRunAt: null,
      lastError: null,
    });
  });

  it('is local only', async () => {
    const { app } = appWithBackupDir();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/backups',
      remoteAddress: '192.168.1.20',
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])('%s is loopback', (ip) => {
    expect(isLoopbackAddress(ip)).toBe(true);
  });

  it.each(['0.0.0.0', '10.0.0.1', '::', '::2', '::ffff:10.0.0.1', '1127.0.0.1', ''])(
    '%s is not loopback',
    (ip) => {
      expect(isLoopbackAddress(ip)).toBe(false);
    },
  );
});

describe('GET /api/v1/admin/external-sources', () => {
  const URL = '/api/v1/admin/external-sources';
  const NOW = new Date('2026-11-16T12:30:00.000Z');
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function start(env: Record<string, string>) {
    const database = testDatabase();
    app = buildApp({
      db: database,
      config: testConfig(env),
      dashboard: { admin: { now: () => NOW } },
    });
    return database.db;
  }

  async function status() {
    const response = await app!.inject({ method: 'GET', url: URL }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by start()
    expect(response.statusCode, response.body).toBe(200);
    return { body: externalSourcesResponseSchema.parse(response.json()), raw: response.body };
  }

  it('lists every source as off by default', async () => {
    start({});
    expect((await status()).body).toEqual({
      contactSet: false,
      sources: [
        {
          id: 'WIKI_PRICES',
          name: 'OSRS Wiki Prices',
          envName: 'PRICES_ENABLED',
          enabled: false,
          active: false,
          lastFetchAt: null,
          nextFetchAt: null,
          lastError: null,
        },
        {
          id: 'RUNEPROFILE',
          name: 'RuneProfile',
          envName: 'RUNEPROFILE_ENABLED',
          enabled: false,
          active: false,
          lastFetchAt: null,
          nextFetchAt: null,
          lastError: null,
        },
      ],
    });
  });

  it('is enabled but not active without a contact', async () => {
    start({ PRICES_ENABLED: 'true' });
    const { body } = await status();
    expect(body.contactSet).toBe(false);
    expect(body.sources[0]).toMatchObject({ enabled: true, active: false, nextFetchAt: null });
  });

  it('shows the last fetch, the next one and the last error, never the contact', async () => {
    const db = start({ PRICES_ENABLED: 'true', USER_AGENT_CONTACT: 'you@example.com' });
    expect((await status()).body.sources[0]).toMatchObject({
      active: true,
      lastFetchAt: null,
      nextFetchAt: NOW.toISOString(),
    });

    recordAttempt(db, 'WIKI_PRICES', new Date('2026-11-16T11:00:00.000Z'));
    recordSuccess(db, 'WIKI_PRICES', new Date('2026-11-16T11:00:02.000Z'));
    recordAttempt(db, 'WIKI_PRICES', new Date('2026-11-16T12:00:00.000Z'));
    recordFailure(db, 'WIKI_PRICES', new Date('2026-11-16T12:00:31.000Z'), 'HTTP 503');
    const { body, raw } = await status();
    expect(body.contactSet).toBe(true);
    expect(body.sources[0]).toMatchObject({
      enabled: true,
      active: true,
      lastFetchAt: '2026-11-16T11:00:02.000Z',
      nextFetchAt: '2026-11-16T13:00:00.000Z',
      lastError: { at: '2026-11-16T12:00:31.000Z', message: 'HTTP 503' },
    });
    expect(raw).not.toContain('you@example.com');
  });

  it('is local only', async () => {
    start({});
    const response = await app!.inject({ method: 'GET', url: URL, remoteAddress: '192.168.1.20' }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by start()
    expect(response.statusCode).toBe(403);
  });
});
