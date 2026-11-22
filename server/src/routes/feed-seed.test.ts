import {
  feedResponseSchema,
  sessionDetailResponseSchema,
  sessionsResponseSchema,
  type FeedEntry,
  type FeedResponse,
  type Session,
  type SessionsResponse,
} from '@fireside/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { rebuildDerivedTables } from '../admin/rebuild.js';
import { buildApp } from '../app.js';
import type { Database } from '../db/index.js';
import { loadSeedFixture, SEED_FIXTURE_HOOK_TIMEOUT_MS } from '../seed/testing.js';

// Against a seed run: sessions get their new collection log items
// (the seed reads the collection log after sessions end, a few reads failing),
// and the sessions list, session detail and the whole feed give the same
// answers after a rebuild. `lootEventId` is the row ID of `loot_events`, which
// a rebuild renumbers (as in `loot/drops` and session detail), so it is left out.

const OPTIONS = {
  seed: 3,
  accounts: 3,
  months: 2,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: 'Europe/Oslo',
} as const;

/** Without the row IDs of `loot_events` (`lootEventId`, and a session loot's numeric `id`). */
const stable = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value).replace(/"(lootEventId|id)":\d+/g, '"$1":0')) as unknown;

describe('collection log per session and the feed on seed data', () => {
  let app: FastifyInstance;
  let database: Database;

  beforeAll(async () => {
    const fixture = await loadSeedFixture(OPTIONS, { TZ: OPTIONS.timeZone });
    ({ database } = fixture);
    expect(fixture.result.failed).toEqual([]);
    app = buildApp({
      db: database,
      config: fixture.config,
      dashboard: { now: () => OPTIONS.until },
    });
  }, SEED_FIXTURE_HOOK_TIMEOUT_MS);
  afterAll(() => app.close());

  async function get<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return schema.parse(response.json());
  }

  async function allSessions(): Promise<Session[]> {
    const out: Session[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? 'limit=100' : `limit=100&cursor=${cursor}`;
      const page: SessionsResponse = await get(
        `/api/v1/accounts/all/sessions?${query}`,
        sessionsResponseSchema,
      );
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return out;
  }

  async function allFeed(): Promise<FeedEntry[]> {
    const out: FeedEntry[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? 'limit=100' : `limit=100&cursor=${cursor}`;
      const page: FeedResponse = await get(
        `/api/v1/accounts/all/feed?${query}`,
        feedResponseSchema,
      );
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return out;
  }

  async function answers() {
    const sessions = await allSessions();
    const details = [];
    for (const session of sessions.filter((s) => s.newCollectionLogCount > 0)) {
      details.push(await get(`/api/v1/sessions/${session.id}`, sessionDetailResponseSchema));
    }
    return { sessions, details, feed: await allFeed() };
  }

  it('ties some new items to sessions and leaves others untied', async () => {
    const { sessions, feed } = await answers();
    const tied = sessions.reduce((sum, session) => sum + session.newCollectionLogCount, 0);
    expect(tied).toBeGreaterThan(0);
    const clog = feed.filter((entry) => entry.type === 'clog');
    expect(clog.some((entry) => entry.sessionId === null)).toBe(true);
    expect(clog.some((entry) => entry.sessionId !== null && entry.approximate)).toBe(true);
    expect(clog.some((entry) => entry.sessionId !== null && !entry.approximate)).toBe(true);
    expect(new Set(feed.map((entry) => entry.type))).toEqual(
      new Set(['session', 'level', 'clog', 'pet', 'drop']),
    );
  });

  it('gives the same sessions, details and feed after a rebuild', async () => {
    const before = await answers();
    rebuildDerivedTables(database.db, { now: () => OPTIONS.until });
    const after = await answers();
    expect(stable(after)).toEqual(stable(before));
  }, 240_000);
});
