import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { join } from 'node:path';
import {
  encodeBase64,
  errorResponseSchema,
  iconsStatusResponseSchema,
  iconsUploadResponseSchema,
  iconsWantedResponseSchema,
  makeSolidPng,
  makeTinyGif,
  makeTinyJpeg,
  MAX_ICONS_BODY_BYTES,
  type Rgba,
} from '@fireside/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type BuildAppOptions } from '../app.js';
import { ICON_CACHE } from '../security-headers.js';
import { createApiKey, ownKey } from '../auth/api-keys.js';
import type { Database } from '../db/index.js';
import { events, itemIcons, namedIcons } from '../db/schema.js';
import { REPO_ROOT } from '../paths.js';
import { testConfig, testDatabase, TEST_OWNER } from '../test-utils.js';
import { createUser } from '../users/users.js';

// Item icons: `POST /ingest/icons/wanted`, `POST /ingest/icons` and
// `GET /items/:itemId/icon`. Every PNG here is made by `makeSolidPng`.

const NOW = new Date('2026-11-15T12:00:00.000Z');
const RED: Rgba = [200, 60, 40, 255];
const BLUE: Rgba = [40, 90, 200, 255];
const FIXTURES = join(REPO_ROOT, 'shared', 'fixtures', 'api');

interface Harness {
  app: FastifyInstance;
  database: Database;
  key: string;
}

let open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.map((app) => app.close()));
  open = [];
});

function setup(
  options: Partial<Pick<BuildAppOptions, 'ingest' | 'logStream' | 'config'>> = {},
): Harness {
  const database = testDatabase();
  const { key } = createApiKey(database.db, TEST_OWNER, 'Gaming PC');
  const app = buildApp({
    db: database,
    config: options.config ?? testConfig(),
    ...(options.logStream ? { logStream: options.logStream } : {}),
    ingest: { now: () => NOW, ...options.ingest },
  });
  open.push(app);
  return { app, database, key };
}

/** The same server, with the ingest key of another user. */
function otherUser(h: Harness): Harness {
  const userId = createUser(h.database.db, 'friend');
  const { key } = createApiKey(h.database.db, ownKey(userId), 'Laptop');
  return { ...h, key };
}

function post(h: Harness, url: string, body: unknown, extra: Partial<InjectOptions> = {}) {
  return h.app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${h.key}`, 'content-type': 'application/json' },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
    ...extra,
  });
}

const upload = (h: Harness, icons: unknown[]) => post(h, '/api/v1/ingest/icons', { icons });
const wanted = (h: Harness, itemIds: unknown[]) =>
  post(h, '/api/v1/ingest/icons/wanted', { itemIds });

function getIcon(h: Harness, itemId: string, headers: Record<string, string> = {}) {
  return h.app.inject({ method: 'GET', url: `/api/v1/items/${itemId}/icon`, headers });
}

const png = (w = 32, h = 32, rgba = RED) => encodeBase64(makeSolidPng(w, h, rgba));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function errorCode(response: { json: () => unknown }) {
  return errorResponseSchema.parse(response.json()).error.code;
}

describe('POST /api/v1/ingest/icons', () => {
  it('stores new icons with hash and size, and never writes events', async () => {
    const h = setup();
    const response = await upload(h, [
      { itemId: 4151, png: png() },
      { itemId: 4152, png: png(36, 32, BLUE) },
    ]);
    expect(response.statusCode).toBe(200);
    expect(iconsUploadResponseSchema.parse(response.json())).toEqual({
      stored: [4151, 4152],
      unchanged: [],
      rejected: [],
    });
    const rows = h.database.db.select().from(itemIcons).all();
    expect(
      rows.map(({ itemId, width, height, sha256: hash, updatedAt }) => ({
        itemId,
        width,
        height,
        hash,
        updatedAt,
      })),
    ).toEqual([
      {
        itemId: 4151,
        width: 32,
        height: 32,
        hash: sha256(makeSolidPng(32, 32, RED)),
        updatedAt: NOW.toISOString(),
      },
      {
        itemId: 4152,
        width: 36,
        height: 32,
        hash: sha256(makeSolidPng(36, 32, BLUE)),
        updatedAt: NOW.toISOString(),
      },
    ]);
    expect(Buffer.from(rows[0]?.png ?? [])).toEqual(Buffer.from(makeSolidPng(32, 32, RED)));
    expect(h.database.db.select().from(events).all()).toEqual([]);
  });

  it('keeps the first icon: same or different bytes later are unchanged', async () => {
    let now = NOW;
    const h = setup({ ingest: { now: () => now } });
    await upload(h, [{ itemId: 4151, png: png() }]);
    const first = await getIcon(h, '4151');

    now = new Date('2026-11-16T12:00:00.000Z');
    expect((await upload(h, [{ itemId: 4151, png: png() }])).json()).toEqual({
      stored: [],
      unchanged: [4151],
      rejected: [],
    });

    // Another user's key sends another valid PNG for the same item, and a new one.
    const other = otherUser(h);
    expect(
      (
        await upload(other, [
          { itemId: 4151, png: png(32, 32, BLUE) },
          { itemId: 4152, png: png(32, 32, BLUE) },
        ])
      ).json(),
    ).toEqual({ stored: [4152], unchanged: [4151], rejected: [] });

    const row = h.database.db.select().from(itemIcons).where(eq(itemIcons.itemId, 4151)).get();
    expect(row?.sha256).toBe(sha256(makeSolidPng(32, 32, RED)));
    expect(row?.updatedAt).toBe(NOW.toISOString());
    const after = await getIcon(h, '4151');
    expect(after.rawPayload).toEqual(first.rawPayload);
    expect(after.headers.etag).toBe(first.headers.etag);
  });

  it('does not move lastStoredAt when an icon is kept', async () => {
    let now = NOW;
    const h = setup({ ingest: { now: () => now } });
    await upload(h, [{ itemId: 4151, png: png() }]);
    now = new Date('2026-11-16T12:00:00.000Z');
    await upload(h, [{ itemId: 4151, png: png(32, 32, BLUE) }]);
    const status = iconsStatusResponseSchema.parse(
      (await h.app.inject({ url: '/api/v1/admin/icons' })).json(),
    );
    expect(status).toMatchObject({ items: 1, lastStoredAt: NOW.toISOString() });
  });

  it('logs how many icons were kept, without IDs', async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const h = setup({ logStream, config: testConfig({ LOG_LEVEL: 'info' }) });
    await upload(h, [
      { itemId: 4151, png: png() },
      { itemId: 4152, png: png() },
    ]);
    await upload(h, [
      { itemId: 4151, png: png(32, 32, BLUE) },
      { itemId: 4152, png: png() },
      { itemId: 7, png: png() },
      { itemId: 7, png: png() },
    ]);
    const processed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'Icon upload processed');
    expect(processed.at(-1)).toMatchObject({ stored: 1, unchanged: 1, kept: 1, rejected: 1 });
    expect(JSON.stringify(processed)).not.toContain('4151');
  });

  it('rejects bad icons one by one with a reason and stores the rest', async () => {
    const h = setup();
    const response = await upload(h, [
      { itemId: 1, png: png() },
      { itemId: 2, png: encodeBase64(makeTinyGif([1, 2, 3])) },
      { itemId: 3, png: encodeBase64(makeTinyJpeg()) },
      { itemId: 4, png: png(65, 1) },
      { itemId: 5, png: encodeBase64(makeSolidPng(64, 64, RED, { format: 'rgba' })) },
      { itemId: 1, png: png(8, 8) },
      { itemId: -1, png: png() },
      'not an object',
    ]);
    expect(response.statusCode).toBe(200);
    const body = iconsUploadResponseSchema.parse(response.json());
    expect(body.stored).toEqual([1]);
    expect(body.unchanged).toEqual([]);
    expect(body.rejected).toEqual([
      { index: 1, itemId: 2, error: 'png: Must be a base64-encoded PNG' },
      { index: 2, itemId: 3, error: 'png: Must be a base64-encoded PNG' },
      { index: 3, itemId: 4, error: 'png: Image is 65×1, at most 64×64 allowed' },
      { index: 4, itemId: 5, error: 'png: Must be at most 16384 bytes' },
      { index: 5, itemId: 1, error: 'itemId: Duplicate itemId in request' },
      { index: 6, itemId: null, error: expect.stringMatching(/^itemId: /) as unknown as string },
      { index: 7, itemId: null, error: expect.stringMatching(/^icon: /) as unknown as string },
    ]);
  });

  it('answers the shared icon fixtures as their folder says', async () => {
    const h = setup();
    const dir = join(FIXTURES, 'ingest-icon');
    for (const kind of ['valid', 'invalid', 'invalid-semantic']) {
      for (const file of readdirSync(join(dir, kind))) {
        const icon = JSON.parse(readFileSync(join(dir, kind, file), 'utf8')) as unknown;
        const body = iconsUploadResponseSchema.parse((await upload(h, [icon])).json());
        expect({ file, rejected: body.rejected.length }).toEqual({
          file,
          rejected: kind === 'valid' ? 0 : 1,
        });
      }
    }
  });

  it('gives 400 for a bad envelope and 413 above 1 MB', async () => {
    const h = setup();
    expect((await upload(h, [])).statusCode).toBe(400);
    expect(errorCode(await upload(h, new Array(101).fill({ itemId: 1, png: png() })))).toBe(
      'VALIDATION_ERROR',
    );
    expect((await post(h, '/api/v1/ingest/icons', '{"icons":')).statusCode).toBe(400);
    const big = JSON.stringify({ icons: [{ itemId: 1, png: 'A'.repeat(MAX_ICONS_BODY_BYTES) }] });
    const response = await post(h, '/api/v1/ingest/icons', big);
    expect(response.statusCode).toBe(413);
    expect(errorCode(response)).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('POST /api/v1/ingest/icons/wanted', () => {
  it('returns the IDs without an icon, deduplicated, in request order', async () => {
    const h = setup();
    await upload(h, [{ itemId: 4151, png: png() }]);
    const response = await wanted(h, [11840, 4151, 995, 11840, 0]);
    expect(response.statusCode).toBe(200);
    expect(iconsWantedResponseSchema.parse(response.json())).toEqual({ missing: [11840, 995, 0] });
  });

  it('never maps IDs: a noted item has its own icon', async () => {
    const h = setup();
    await upload(h, [{ itemId: 4151, png: png() }]);
    expect((await wanted(h, [4152])).json()).toEqual({ missing: [4152] });
  });

  it('gives 400 VALIDATION_ERROR for 0 or more than 500 IDs or a non-integer', async () => {
    const h = setup();
    for (const ids of [[], Array.from({ length: 501 }, (_, i) => i), [1.5], ['1']]) {
      const response = await wanted(h, ids);
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('VALIDATION_ERROR');
    }
  });
});

describe('icon ingest auth and rate limit', () => {
  it.each(['/api/v1/ingest/icons', '/api/v1/ingest/icons/wanted'])(
    '%s needs a valid key',
    async (url) => {
      const h = setup();
      const response = await post(h, url, {}, { headers: { 'content-type': 'application/json' } });
      expect(response.statusCode).toBe(401);
    },
  );

  it('shares the per-key limit with POST /ingest and verify', async () => {
    const h = setup({ ingest: { rateLimit: { max: 3, timeWindowMs: 60_000 } } });
    const auth = { authorization: `Bearer ${h.key}` };
    await h.app.inject({ method: 'GET', url: '/api/v1/ingest/verify', headers: auth });
    await wanted(h, [1]);
    await upload(h, [{ itemId: 1, png: png() }]);
    const limited = await wanted(h, [1]);
    expect(limited.statusCode).toBe(429);
    expect(errorCode(limited)).toBe('RATE_LIMITED');
    expect((await post(h, '/api/v1/ingest', { events: [{}] })).statusCode).toBe(429);
  });
});

describe('GET /api/v1/items/:itemId/icon', () => {
  it('serves the stored PNG with ETag, private caching and security headers', async () => {
    const h = setup();
    await upload(h, [{ itemId: 4151, png: png() }]);
    const response = await getIcon(h, '4151');
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      'content-type': 'image/png',
      etag: `"${sha256(makeSolidPng(32, 32, RED))}"`,
      'cache-control': ICON_CACHE,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    });
    expect(response.rawPayload).toEqual(Buffer.from(makeSolidPng(32, 32, RED)));
  });

  it('answers 304 for a matching If-None-Match, weak or in a list', async () => {
    const h = setup();
    await upload(h, [{ itemId: 4151, png: png() }]);
    const etag = String((await getIcon(h, '4151')).headers.etag);
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const response = await getIcon(h, '4151', { 'if-none-match': header });
      expect(response.statusCode).toBe(304);
      expect(response.headers.etag).toBe(etag);
      expect(response.headers['cache-control']).toBe(ICON_CACHE);
      expect(response.rawPayload.length).toBe(0);
    }
    expect((await getIcon(h, '4151', { 'if-none-match': '"other"' })).statusCode).toBe(200);
  });

  it('gives 404 with no-store and the same security headers when missing', async () => {
    const h = setup();
    const response = await getIcon(h, '4151');
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('NOT_FOUND');
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    });
  });

  it('serves the exact ID asked for, never a mapped one', async () => {
    const h = setup();
    await upload(h, [{ itemId: 4151, png: png() }]);
    expect((await getIcon(h, '4152')).statusCode).toBe(404);
  });

  it.each(['abc', '-1', '01', '1.5'])('gives 400 for item ID %s', async (itemId) => {
    const h = setup();
    const response = await getIcon(h, itemId);
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('VALIDATION_ERROR');
  });

  it('is local only and never accepts an API key', async () => {
    const h = setup();
    await upload(h, [{ itemId: 4151, png: png() }]);
    const remote = await h.app.inject({
      method: 'GET',
      url: '/api/v1/items/4151/icon',
      remoteAddress: '192.168.1.20',
      headers: { authorization: `Bearer ${h.key}` },
    });
    expect(remote.statusCode).toBe(403);
    const proxied = await getIcon(h, '4151', { 'x-forwarded-for': '10.0.0.1' });
    expect(proxied.statusCode).toBe(403);
  });
});

// Skill and boss/raid icons (contract 1.29.0).

const skillIcon = (key: string, rgba = RED) => ({ kind: 'SKILL', key, png: png(25, 25, rgba) });
const bossIcon = (key: string, rgba = RED) => ({ kind: 'BOSS', key, png: png(25, 25, rgba) });
const get = (h: Harness, url: string, headers: Record<string, string> = {}) =>
  h.app.inject({ method: 'GET', url, headers });
const bossUrl = (name: string) => `/api/v1/bosses/${encodeURIComponent(name)}/icon`;

describe('POST /api/v1/ingest/icons with skill and boss icons', () => {
  it('stores them by kind and key, next to item icons, and never writes events', async () => {
    const h = setup();
    const response = await upload(h, [
      { itemId: 4151, png: png() },
      skillIcon('ATTACK'),
      bossIcon('Zulrah', BLUE),
    ]);
    expect(response.statusCode).toBe(200);
    expect(iconsUploadResponseSchema.parse(response.json())).toEqual({
      stored: [4151],
      unchanged: [],
      rejected: [],
      storedNamed: [
        { kind: 'SKILL', key: 'ATTACK' },
        { kind: 'BOSS', key: 'Zulrah' },
      ],
      unchangedNamed: [],
    });
    expect(
      h.database.db
        .select({
          kind: namedIcons.kind,
          key: namedIcons.key,
          sha256: namedIcons.sha256,
          width: namedIcons.width,
          height: namedIcons.height,
          updatedAt: namedIcons.updatedAt,
        })
        .from(namedIcons)
        .orderBy(namedIcons.kind)
        .all(),
    ).toEqual([
      {
        kind: 'BOSS',
        key: 'Zulrah',
        sha256: sha256(makeSolidPng(25, 25, BLUE)),
        width: 25,
        height: 25,
        updatedAt: NOW.toISOString(),
      },
      {
        kind: 'SKILL',
        key: 'ATTACK',
        sha256: sha256(makeSolidPng(25, 25, RED)),
        width: 25,
        height: 25,
        updatedAt: NOW.toISOString(),
      },
    ]);
    expect(h.database.db.select().from(itemIcons).all()).toHaveLength(1);
    expect(h.database.db.select().from(events).all()).toEqual([]);
  });

  it('answers an item-only upload exactly as before 1.29.0', async () => {
    const h = setup();
    expect((await upload(h, [{ itemId: 4151, png: png() }])).json()).toEqual({
      stored: [4151],
      unchanged: [],
      rejected: [],
    });
  });

  it('stores a boss under its normalized name and echoes the key as sent', async () => {
    const h = setup();
    const response = await upload(h, [
      bossIcon("Kree'Arra"),
      bossIcon('Nightmare'),
      bossIcon('Obor chests opened'),
      bossIcon('Doom of Mokhaiotl: Deep delves'),
      bossIcon('Some New Boss'),
    ]);
    expect(iconsUploadResponseSchema.parse(response.json()).storedNamed).toEqual([
      { kind: 'BOSS', key: "Kree'Arra" },
      { kind: 'BOSS', key: 'Nightmare' },
      { kind: 'BOSS', key: 'Obor chests opened' },
      { kind: 'BOSS', key: 'Doom of Mokhaiotl: Deep delves' },
      { kind: 'BOSS', key: 'Some New Boss' },
    ]);
    expect(
      h.database.db
        .select({ key: namedIcons.key })
        .from(namedIcons)
        .all()
        .map((row) => row.key)
        .sort(),
    ).toEqual(['Doom of Mokhaiotl', "Kree'arra", 'Obor', 'Some New Boss', 'The Nightmare']);
  });

  it('keeps the first skill and boss icon, also under an alias', async () => {
    const h = setup();
    await upload(h, [skillIcon('ATTACK'), bossIcon('The Nightmare')]);
    const firstSkill = await h.app.inject({ url: '/api/v1/skills/ATTACK/icon' });
    const firstBoss = await h.app.inject({ url: bossUrl('The Nightmare') });

    const other = otherUser(h);
    expect(
      (
        await upload(other, [
          skillIcon('ATTACK'),
          skillIcon('ATTACK_2', BLUE),
          bossIcon('Nightmare', BLUE),
        ])
      ).json(),
    ).toEqual({
      stored: [],
      unchanged: [],
      rejected: [],
      storedNamed: [{ kind: 'SKILL', key: 'ATTACK_2' }],
      unchangedNamed: [
        { kind: 'SKILL', key: 'ATTACK' },
        { kind: 'BOSS', key: 'Nightmare' },
      ],
    });
    expect(
      (await upload(other, [skillIcon('ATTACK', BLUE)])).json<{ unchangedNamed: unknown }>()
        .unchangedNamed,
    ).toEqual([{ kind: 'SKILL', key: 'ATTACK' }]);

    expect(h.database.db.select().from(namedIcons).all()).toHaveLength(3);
    const skill = await h.app.inject({ url: '/api/v1/skills/ATTACK/icon' });
    const boss = await h.app.inject({ url: bossUrl('Nightmare') });
    expect(skill.rawPayload).toEqual(firstSkill.rawPayload);
    expect(boss.rawPayload).toEqual(firstBoss.rawPayload);
    expect(boss.headers.etag).toBe(firstBoss.headers.etag);
  });

  it('keeps a skill and a boss with the same key apart', async () => {
    const h = setup();
    const body = (await upload(h, [skillIcon('NEX'), bossIcon('NEX', BLUE)])).json<{
      storedNamed: unknown[];
    }>();
    expect(body.storedNamed).toHaveLength(2);
  });

  it('rejects bad named icons one by one, with kind and key as sent', async () => {
    const h = setup();
    const response = await upload(h, [
      bossIcon('Zulrah'),
      bossIcon('zulrah', BLUE),
      skillIcon('Attack'),
      { kind: 'NPC', key: 'Zulrah', png: png() },
      { kind: 'BOSS', key: 'Vorkath', png: encodeBase64(makeTinyGif([1, 2, 3])) },
      { kind: 'BOSS', key: 'Vorkath', itemId: 1, png: png() },
      { kind: 'SKILL', png: png() },
    ]);
    const body = iconsUploadResponseSchema.parse(response.json());
    expect(body.storedNamed).toEqual([{ kind: 'BOSS', key: 'Zulrah' }]);
    expect(body.stored).toEqual([]);
    expect(body.rejected).toEqual([
      {
        index: 1,
        itemId: null,
        kind: 'BOSS',
        key: 'zulrah',
        error: 'key: Duplicate key in request',
      },
      {
        index: 2,
        itemId: null,
        kind: 'SKILL',
        key: 'Attack',
        error: 'key: Must be an UPPER_SNAKE_CASE skill name',
      },
      {
        index: 3,
        itemId: null,
        kind: null,
        key: 'Zulrah',
        error: expect.stringMatching(/^kind: /) as unknown as string,
      },
      {
        index: 4,
        itemId: null,
        kind: 'BOSS',
        key: 'Vorkath',
        error: 'png: Must be a base64-encoded PNG',
      },
      {
        index: 5,
        itemId: null,
        kind: 'BOSS',
        key: 'Vorkath',
        error: expect.stringMatching(/itemId/) as unknown as string,
      },
      {
        index: 6,
        itemId: null,
        kind: 'SKILL',
        key: null,
        error: expect.stringMatching(/^key: /) as unknown as string,
      },
    ]);
  });
});

describe('POST /api/v1/ingest/icons/wanted with skills and bosses', () => {
  const ask = (h: Harness, body: unknown) => post(h, '/api/v1/ingest/icons/wanted', body);

  it('returns the missing skills and bosses as sent, deduplicated, in request order', async () => {
    const h = setup();
    await upload(h, [skillIcon('ATTACK'), bossIcon('Nightmare'), { itemId: 4151, png: png() }]);
    const response = await ask(h, {
      itemIds: [995, 4151],
      skills: ['SAILING', 'ATTACK', 'SAILING', 'OVERALL'],
      bosses: ['Zulrah', 'The Nightmare', 'nightmare', 'Zulrah', "Kree'Arra"],
    });
    expect(response.statusCode).toBe(200);
    expect(iconsWantedResponseSchema.parse(response.json())).toEqual({
      missing: [995],
      missingSkills: ['SAILING', 'OVERALL'],
      missingBosses: ['Zulrah', "Kree'Arra"],
    });
  });

  it('only answers for the lists that were asked for', async () => {
    const h = setup();
    expect((await ask(h, { itemIds: [1] })).json()).toEqual({ missing: [1] });
    expect((await ask(h, { skills: ['ATTACK'] })).json()).toEqual({
      missing: [],
      missingSkills: ['ATTACK'],
    });
    expect((await ask(h, { bosses: ['Zulrah'] })).json()).toEqual({
      missing: [],
      missingBosses: ['Zulrah'],
    });
  });

  it('gives 400 VALIDATION_ERROR for no lists, a bad key or more than 500 keys in total', async () => {
    const h = setup();
    for (const body of [
      {},
      { skills: [] },
      { skills: ['attack'] },
      { bosses: [' Zulrah'] },
      { itemIds: Array.from({ length: 500 }, (_, i) => i), skills: ['ATTACK'] },
    ]) {
      const response = await ask(h, body);
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('VALIDATION_ERROR');
    }
  });
});

describe('icon caching (the one exception to no-store under /api)', () => {
  // The exact value, not the constant: the header itself is what browsers and
  // Cloudflare see (docs/decisions/0018-icons-cached-privately-for-a-day.md).
  const CACHED = 'private, max-age=86400, stale-while-revalidate=604800';

  it('caches a found icon privately for a day, on 200 and 304, never public', async () => {
    const h = setup();
    await upload(h, [{ itemId: 4151, png: png() }, skillIcon('ATTACK'), bossIcon('Zulrah', BLUE)]);
    for (const url of [
      '/api/v1/items/4151/icon',
      '/api/v1/skills/ATTACK/icon',
      bossUrl('Zulrah'),
    ]) {
      const first = await get(h, url);
      expect(first.statusCode).toBe(200);
      const etag = String(first.headers.etag);
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
      const again = await get(h, url, { 'if-none-match': etag });
      expect(again.statusCode).toBe(304);
      for (const response of [first, again]) {
        expect({ url, value: response.headers['cache-control'] }).toEqual({ url, value: CACHED });
        expect(response.headers.etag).toBe(etag);
      }
    }
  });

  it('never lets a browser or proxy store a missing icon', async () => {
    const h = setup();
    for (const url of ['/api/v1/items/1/icon', '/api/v1/skills/MAGIC/icon', bossUrl('Vorkath')]) {
      const response = await get(h, url);
      expect(response.statusCode).toBe(404);
      expect({ url, value: response.headers['cache-control'] }).toEqual({ url, value: 'no-store' });
    }
  });

  it('serves an icon uploaded after a 404 on the next request', async () => {
    const h = setup();
    expect((await getIcon(h, '4151')).statusCode).toBe(404);
    await upload(h, [{ itemId: 4151, png: png() }]);
    const response = await getIcon(h, '4151');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe(CACHED);
  });
});

describe('GET /api/v1/skills/:skill/icon and /bosses/:boss/icon', () => {
  it('serves the stored PNG with the same headers as an item icon', async () => {
    const h = setup();
    await upload(h, [skillIcon('ATTACK'), bossIcon('Zulrah', BLUE)]);
    for (const [url, rgba] of [
      ['/api/v1/skills/ATTACK/icon', RED],
      [bossUrl('Zulrah'), BLUE],
    ] as const) {
      const response = await get(h, url);
      expect(response.statusCode).toBe(200);
      expect(response.headers).toMatchObject({
        'content-type': 'image/png',
        etag: `"${sha256(makeSolidPng(25, 25, rgba))}"`,
        'cache-control': ICON_CACHE,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'",
      });
      expect(response.rawPayload).toEqual(Buffer.from(makeSolidPng(25, 25, rgba)));
      const etag = String(response.headers.etag);
      expect((await get(h, url, { 'if-none-match': `W/${etag}` })).statusCode).toBe(304);
    }
  });

  it('finds a boss by any alias, in any case', async () => {
    const h = setup();
    await upload(h, [bossIcon('Nightmare'), bossIcon("Kree'Arra")]);
    for (const name of ['The Nightmare', 'Nightmare', 'the nightmare of ashihama', "Kree'arra"]) {
      expect({ name, status: (await get(h, bossUrl(name))).statusCode }).toEqual({
        name,
        status: 200,
      });
    }
  });

  it('gives a raid mode its own icon, or the raid’s when it has none', async () => {
    const h = setup();
    await upload(h, [
      bossIcon('Theatre of Blood'),
      bossIcon('Theatre of Blood: Hard Mode', BLUE),
      bossIcon('The Fractured Archive'),
    ]);
    const etagOf = async (name: string) => (await get(h, bossUrl(name))).headers.etag;
    const base = `"${sha256(makeSolidPng(25, 25, RED))}"`;
    expect(await etagOf('Theatre of Blood: Entry Mode')).toBe(base);
    expect(await etagOf('Theatre of Blood Story Mode')).toBe(base);
    expect(await etagOf('Theatre of Blood: Hard Mode')).toBe(
      `"${sha256(makeSolidPng(25, 25, BLUE))}"`,
    );
    expect(await etagOf('Fractured Archive')).toBe(base);
    expect((await get(h, bossUrl('Tombs of Amascut: Entry Mode'))).statusCode).toBe(404);
  });

  it('gives 404 with no-store and the security headers when missing', async () => {
    const h = setup();
    await upload(h, [skillIcon('NEX')]);
    for (const url of ['/api/v1/skills/ATTACK/icon', bossUrl('Zulrah'), bossUrl('NEX')]) {
      const response = await get(h, url);
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('NOT_FOUND');
      expect(response.headers).toMatchObject({
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'",
      });
    }
  });

  it.each(['/api/v1/skills/attack/icon', '/api/v1/skills/A%20B/icon', bossUrl(' ')])(
    'gives 400 for %s',
    async (url) => {
      const h = setup();
      const response = await get(h, url);
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('VALIDATION_ERROR');
    },
  );

  it('is local only and never accepts an API key', async () => {
    const h = setup();
    await upload(h, [skillIcon('ATTACK'), bossIcon('Zulrah')]);
    for (const url of ['/api/v1/skills/ATTACK/icon', bossUrl('Zulrah'), '/api/v1/admin/icons']) {
      const remote = await h.app.inject({
        method: 'GET',
        url,
        remoteAddress: '192.168.1.20',
        headers: { authorization: `Bearer ${h.key}` },
      });
      expect(remote.statusCode).toBe(403);
    }
  });
});

describe('GET /api/v1/admin/icons', () => {
  const status = async (h: Harness) =>
    iconsStatusResponseSchema.parse((await get(h, '/api/v1/admin/icons')).json());

  it('is all zero on a new server', async () => {
    expect(await status(setup())).toEqual({ items: 0, skills: 0, bosses: 0, lastStoredAt: null });
  });

  it('counts stored icons per kind and gives the last time one was stored', async () => {
    let now = NOW;
    const h = setup({ ingest: { now: () => now } });
    await upload(h, [{ itemId: 1, png: png() }, { itemId: 2, png: png() }, skillIcon('ATTACK')]);
    expect(await status(h)).toEqual({
      items: 2,
      skills: 1,
      bosses: 0,
      lastStoredAt: NOW.toISOString(),
    });

    now = new Date('2026-11-16T12:00:00.000Z');
    await upload(h, [bossIcon('Zulrah'), bossIcon('Vorkath'), skillIcon('ATTACK')]);
    expect(await status(h)).toEqual({
      items: 2,
      skills: 1,
      bosses: 2,
      lastStoredAt: '2026-11-16T12:00:00.000Z',
    });

    // An unchanged upload stores nothing, so the time stays.
    now = new Date('2026-11-17T12:00:00.000Z');
    await upload(h, [{ itemId: 1, png: png() }]);
    expect((await status(h)).lastStoredAt).toBe('2026-11-16T12:00:00.000Z');
  });
});
