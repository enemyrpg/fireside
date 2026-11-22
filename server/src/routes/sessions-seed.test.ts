import {
  accountsResponseSchema,
  calendarResponseSchema,
  sessionDetailResponseSchema,
  sessionsResponseSchema,
  type Session,
} from '@fireside/shared';
import { and, count, eq, gte, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import type { Database } from '../db/index.js';
import { sessionHeartbeats, sessions } from '../db/schema.js';
import { loadSeedFixture, SEED_FIXTURE_HOOK_TIMEOUT_MS } from '../seed/testing.js';

// Against a small seed run: every response matches the shared
// schemas, paging finds every session once, session details agree with
// their summaries, and the calendar counts every heartbeat once.

const OPTIONS = {
  seed: 7,
  accounts: 2,
  months: 0.5,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: 'Europe/Oslo',
} as const;

describe('sessions and calendar on seed data', () => {
  let app: FastifyInstance;
  let database: Database;
  let accountIds: number[] = [];

  beforeAll(async () => {
    const fixture = await loadSeedFixture(OPTIONS, { TZ: OPTIONS.timeZone });
    const { config, result } = fixture;
    database = fixture.database;
    expect(result.failed).toEqual([]);
    app = buildApp({ db: database, config, dashboard: { now: () => OPTIONS.until } });
    const response = await app.inject({ method: 'GET', url: '/api/v1/accounts' });
    accountIds = accountsResponseSchema.parse(response.json()).accounts.map((a) => a.id);
  }, SEED_FIXTURE_HOOK_TIMEOUT_MS);
  afterAll(() => app.close());

  async function get<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return schema.parse(response.json());
  }

  async function allSessions(id: number | 'all'): Promise<Session[]> {
    const found: Session[] = [];
    let cursor: string | null = null;
    do {
      const page: z.infer<typeof sessionsResponseSchema> = await get(
        `/api/v1/accounts/${String(id)}/sessions?limit=7${cursor ? `&cursor=${cursor}` : ''}`,
        sessionsResponseSchema,
      );
      found.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return found;
  }

  it('pages every session exactly once, newest first', async () => {
    const all = await allSessions('all');
    const total = database.db.select({ n: count() }).from(sessions).get()?.n;
    expect(all.length).toBe(total);
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
    const keys = all.map((s) => `${s.startedAt} ${s.id}`);
    expect(keys).toEqual([...keys].sort().reverse());

    const perAccount = await Promise.all(accountIds.map((id) => allSessions(id)));
    expect(perAccount.flat().length).toBe(all.length);
    perAccount.forEach((list, index) => {
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((s) => s.accountId === accountIds[index])).toBe(true);
    });
  });

  it('gives details that agree with the session summaries', async () => {
    const all = await allSessions('all');
    for (const session of all) {
      const detail = await get(`/api/v1/sessions/${session.id}`, sessionDetailResponseSchema);
      expect(detail.session).toEqual(session);
      const afkMs = detail.afkPeriods.reduce(
        (sum, p) => sum + Date.parse(p.endedAt) - Date.parse(p.startedAt),
        0,
      );
      expect(Math.floor(afkMs / 1000)).toBe(session.afkSeconds);

      const summary = session.summary;
      if (!summary) continue;
      expect(detail.loot.length).toBe(summary.lootCount);
      expect(detail.loot.reduce((sum, loot) => sum + loot.geValue, 0)).toBe(summary.lootGeValue);
      expect(Object.fromEntries(detail.kc.map((kc) => [kc.boss, kc.gained]))).toEqual(
        summary.kcGainedByBoss,
      );
      // The seed only uses known skills.
      expect(Object.fromEntries(detail.xp.map((xp) => [xp.skill, xp.xpGained]))).toEqual(
        summary.xpGainedBySkill,
      );
    }
  }, 30_000);

  it('counts every heartbeat once in the calendar, and all = sum of accounts', async () => {
    const heartbeats = database.db.select({ n: count() }).from(sessionHeartbeats).get()?.n ?? 0;
    expect(heartbeats).toBeGreaterThan(0);

    const all = await get('/api/v1/accounts/all/calendar?year=2026', calendarResponseSchema);
    const played = all.days.reduce((sum, day) => sum + day.playedSeconds, 0);
    expect(played).toBe(heartbeats * 60);
    expect(all.days.some((day) => day.afkSeconds > 0)).toBe(true);

    let perAccount = 0;
    for (const id of accountIds) {
      const calendar = await get(`/api/v1/accounts/${String(id)}/calendar`, calendarResponseSchema);
      expect(calendar.year).toBe(2026);
      const accountHeartbeats =
        database.db
          .select({ n: count() })
          .from(sessionHeartbeats)
          .innerJoin(sessions, eq(sessions.id, sessionHeartbeats.sessionId))
          .where(eq(sessions.accountId, id))
          .get()?.n ?? 0;
      const seconds = calendar.days.reduce((sum, day) => sum + day.playedSeconds, 0);
      expect(seconds).toBe(accountHeartbeats * 60);
      perAccount += seconds;
    }
    expect(perAccount).toBe(played);
  });

  it('counts the heartbeats in [from, to) for a calendar range', async () => {
    const from = '2026-10-25T00:00:00.000Z';
    const to = '2026-11-01T12:00:00.000Z';
    const inRange =
      database.db
        .select({ n: count() })
        .from(sessionHeartbeats)
        .where(and(gte(sessionHeartbeats.at, from), lt(sessionHeartbeats.at, to)))
        .get()?.n ?? 0;
    expect(inRange).toBeGreaterThan(0);
    const calendar = await get(
      `/api/v1/accounts/all/calendar?from=${from}&to=${to}`,
      calendarResponseSchema,
    );
    expect(calendar.year).toBeNull();
    expect(calendar.days.reduce((sum, day) => sum + day.playedSeconds, 0)).toBe(inRange * 60);
  });
});
