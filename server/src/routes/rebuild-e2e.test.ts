import { EVENT_TYPES, rebuildResponseSchema, type Event } from '@fireside/shared';
import { asc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createApiKey } from '../auth/api-keys.js';
import { EXIT_OK, runCli } from '../cli/run.js';
import type { Database } from '../db/index.js';
import { accounts, events as eventsTable } from '../db/schema.js';
import { failedEvents, PROJECTIONS, type Projection } from '../projections/index.js';
import { closeTimedOutSessions } from '../projections/sessions.js';
import {
  eventFactory,
  failingFor,
  seededRandom,
  sessionIdOf,
  shuffled,
  snapshotDerived,
  TEST_NOW,
  validFixtureFiles,
} from '../projections/testing.js';
import { testConfig, testDatabase, UNUSED_BACKUPS, TEST_OWNER } from '../test-utils.js';

// Rebuild from end to end: a realistic mixed set of events sent through
// `POST /api/v1/ingest` in random order (random batches, resent batches, the
// timeout job running in between), then rebuilt. The derived tables must be
// identical to continuous processing plus the timeout job at the same time.

const ACCOUNT_A = '1234567890123456789';
const ACCOUNT_B = '-987654321098765432';
/** When the rebuild runs, and the timeout job's last run before it. */
const FINAL_NOW = TEST_NOW; // 2026-11-09T12:00Z
const MINUTE = 60_000;

function at(day: 8 | 9, hh: number, mm: number): string {
  return new Date(Date.UTC(2026, 10, day, hh, mm)).toISOString();
}

/** Heartbeats every `step` minutes from `from` to `to` (inclusive), on 2026-11-`day`. */
function heartbeats(
  f: ReturnType<typeof eventFactory>,
  day: 8 | 9,
  [fromH, fromM]: [number, number],
  [toH, toM]: [number, number],
  step: number,
  options: { accountHash: string; sessionId: string; world?: number },
): Event[] {
  const out: Event[] = [];
  const { world = 420, ...rest } = options;
  for (let t = fromH * 60 + fromM; t <= toH * 60 + toM; t += step) {
    out.push(
      f.heartbeat(at(day, Math.floor(t / 60), t % 60), {
        ...rest,
        payload: { world, idle: t % 30 === 0 },
      }),
    );
  }
  return out;
}

/**
 * Two accounts, eight sessions: a long bossing session with XP, NPC and
 * player loot and KC (ends with `logout`), a world hop into a session that is
 * never ended (times out), a `client_closed` session with unknown boss, item
 * and skill, a session still open at `FINAL_NOW`, and every valid event
 * fixture spread over two more sessions.
 */
function realisticEvents(): Event[] {
  const f = eventFactory();
  const a = (n: number) => ({ accountHash: ACCOUNT_A, sessionId: sessionIdOf(n) });
  const b = (n: number) => ({ accountHash: ACCOUNT_B, sessionId: sessionIdOf(n) });

  const s1 = a(1);
  const session1 = [
    f.sessionStart(at(8, 19, 0), { ...s1, displayName: 'Iron Tester' }),
    f.xpSnapshot(
      at(8, 19, 0),
      { SLAYER: 1_000_000, HITPOINTS: 2_000_000, RANGED: 3_000_000 },
      { ...s1, reason: 'login' },
    ),
    ...heartbeats(f, 8, [19, 1], [20, 0], 5, s1),
    f.afk(at(8, 19, 20), at(8, 19, 27), s1),
    f.xpSnapshot(at(8, 19, 30), { SLAYER: 1_010_000, HITPOINTS: 2_005_000, RANGED: 3_020_000 }, s1),
    f.kc(at(8, 19, 12), { ...s1, boss: 'Vorkath', killCount: 101 }),
    f.loot(at(8, 19, 12), { ...s1, geValue: 120_000, killCount: 101 }),
    f.kc(at(8, 19, 35), { ...s1, boss: 'vorkath', killCount: 102 }),
    f.loot(at(8, 19, 35), { ...s1, geValue: 95_000, killCount: 102 }),
    f.loot(at(8, 19, 40), { ...s1, geValue: 3_000, source: { type: 'PLAYER', name: null } }),
    f.kc(at(8, 19, 50), { ...s1, boss: 'Zulrah', killCount: 1 }),
    f.xpSnapshot(
      at(8, 20, 0),
      { SLAYER: 1_030_000, HITPOINTS: 2_012_000, RANGED: 3_055_000 },
      { ...s1, reason: 'logout' },
    ),
    f.sessionEnd(at(8, 20, 0), { ...s1, reason: 'logout' }),
  ];

  // Logs back in, hops, and the new session never ends (client crashed): timeout.
  const s2 = a(2);
  const s3 = a(3);
  const hop = [
    f.sessionStart(at(8, 21, 0), { ...s2, displayName: 'Iron Tester' }),
    ...heartbeats(f, 8, [21, 1], [21, 10], 3, s2),
    f.sessionEnd(at(8, 21, 11), { ...s2, reason: 'hop' }),
    f.sessionStart(at(8, 21, 11), { ...s3, displayName: 'Iron Tester' }),
    ...heartbeats(f, 8, [21, 12], [21, 40], 4, { ...s3, world: 302 }),
    f.xpSnapshot(at(8, 21, 30), { SLAYER: 1_031_000 }, s3),
    f.loot(at(8, 21, 33), { ...s3, geValue: 400, source: { type: 'NPC', name: 'Goblin' } }),
  ];

  // Second account, renamed since last time, unknown game data.
  const s4 = b(4);
  const unknown = [
    f.sessionStart(at(9, 9, 0), { ...s4, displayName: 'Main Tester', accountType: 'NORMAL' }),
    ...heartbeats(f, 9, [9, 2], [9, 40], 6, s4),
    f.xpSnapshot(at(9, 9, 1), { ATTACK: 500, NEW_SKILL: 10 }, { ...s4, reason: 'login' }),
    f.kc(at(9, 9, 20), { ...s4, boss: 'Brand New Boss', killCount: 3 }),
    f.fromFixture('loot-npc.json', at(9, 9, 21), {
      ...s4,
      payload: {
        items: [
          { itemId: 99_999_999, name: 'Unreleased item', quantity: 1, gePrice: 0, haPrice: 0 },
        ],
      },
    }),
    f.xpSnapshot(at(9, 9, 40), { ATTACK: 9_500, NEW_SKILL: 40 }, s4),
    f.sessionEnd(at(9, 9, 41), { ...s4, reason: 'client_closed' }),
  ];

  // Still playing at FINAL_NOW: last heartbeat less than 10 minutes ago.
  const s5 = b(5);
  const open = [
    f.sessionStart(at(9, 11, 30), { ...s5, displayName: 'Main Tester', accountType: 'NORMAL' }),
    ...heartbeats(f, 9, [11, 31], [11, 55], 3, s5),
    f.kc(at(9, 11, 45), { ...s5, boss: 'Brand New Boss', killCount: 4 }),
  ];

  // Every valid fixture, so each event shape goes through ingest and rebuild.
  const s6 = b(6);
  const s7 = b(7);
  const fixtures: Event[] = [f.fromFixture('session-start.json', at(9, 6, 0), s6)];
  let minute = 1;
  for (const type of EVENT_TYPES) {
    for (const file of validFixtureFiles(type)) {
      if (type === 'session.start' || type === 'session.end') continue;
      fixtures.push(f.fromFixture(file, at(9, 6, minute), s6));
      minute += 1;
    }
  }
  fixtures.push(f.fromFixture('session-end.json', at(9, 6, minute), s6));
  fixtures.push(
    f.fromFixture('session-start.json', at(9, 7, 0), s7),
    f.fromFixture('session-end-hop.json', at(9, 7, 5), s7),
  );

  return [...session1, ...hop, ...unknown, ...open, ...fixtures];
}

interface Harness {
  app: FastifyInstance;
  database: Database;
  key: string;
  /** The server clock for ingest and the timeout job. */
  clock: { now: Date };
}

let open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.map((app) => app.close()));
  open = [];
});

function setup(ingestProjections: readonly Projection[] = PROJECTIONS): Harness {
  const database = testDatabase();
  const { key } = createApiKey(database.db, TEST_OWNER, 'Gaming PC');
  const clock = { now: new Date(0) };
  const app = buildApp({
    db: database,
    config: testConfig(),
    ingest: {
      now: () => clock.now,
      projections: ingestProjections,
      rateLimit: { max: 100_000, timeWindowMs: 60_000 },
    },
    dashboard: { admin: { now: () => FINAL_NOW } },
  });
  open.push(app);
  return { app, database, key, clock };
}

/**
 * Sends `events` like a plugin that is sometimes offline: random order,
 * random batch sizes, some batches resent. Each batch arrives a few minutes
 * after the newest event sent so far, and the timeout job runs after each.
 * Ends with the timeout job at `FINAL_NOW`.
 */
async function ingestContinuously(h: Harness, events: readonly Event[], seed: number) {
  const random = seededRandom(seed);
  const order = shuffled(events, random);
  const sent: Event[][] = [];
  let newest = 0;

  const send = async (batch: Event[]) => {
    for (const event of batch) newest = Math.max(newest, Date.parse(event.occurredAt));
    const arrival = Math.max(h.clock.now.getTime(), newest + Math.floor(random() * 15) * MINUTE);
    h.clock.now = new Date(Math.min(arrival, FINAL_NOW.getTime()));
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: { authorization: `Bearer ${h.key}` },
      payload: { events: batch },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ rejected: [] });
    closeTimedOutSessions(h.app.db, h.clock.now);
  };

  for (let start = 0; start < order.length;) {
    const batch = order.slice(start, start + 1 + Math.floor(random() * 8));
    await send(batch);
    sent.push(batch);
    start += batch.length;
    if (random() < 0.25) await send(sent[Math.floor(random() * sent.length)] ?? []);
  }
  h.clock.now = FINAL_NOW;
  closeTimedOutSessions(h.app.db, FINAL_NOW);
}

/** Every derived table (without surrogate IDs), plus account IDs. */
function snapshot(h: Harness) {
  const db = h.database.db;
  return {
    derived: snapshotDerived({ database: h.database, apiKeyId: 0, failed: [] }),
    accountIds: db
      .select({ hash: accounts.accountHash, id: accounts.id })
      .from(accounts)
      .orderBy(asc(accounts.accountHash))
      .all(),
  };
}

function eventState(h: Harness) {
  return h.database.db
    .select({
      eventId: eventsTable.eventId,
      processed: eventsTable.processedAt,
      error: eventsTable.projectionError,
    })
    .from(eventsTable)
    .orderBy(asc(eventsTable.eventId))
    .all();
}

async function rebuildViaApi(h: Harness) {
  const response = await h.app.inject({ method: 'POST', url: '/api/v1/admin/rebuild' });
  expect(response.statusCode).toBe(200);
  return rebuildResponseSchema.parse(response.json());
}

async function rebuildViaCli(h: Harness) {
  const out: string[] = [];
  const code = await runCli(['rebuild'], {
    openDb: () => h.database.db,
    out: (line) => out.push(line),
    err: (line) => out.push(line),
    now: () => FINAL_NOW,
    backups: UNUSED_BACKUPS,
  });
  expect(code, out.join('\n')).toBe(EXIT_OK);
}

describe('rebuild after ingest (acceptance)', () => {
  const events = realisticEvents();

  it('uses a realistic mix', () => {
    expect(new Set(events.map((event) => event.type))).toEqual(new Set(EVENT_TYPES));
    expect(new Set(events.map((event) => event.accountHash)).size).toBe(2);
    expect(events.length).toBeGreaterThan(80);
  });

  it.each([1, 2, 3])('gives the same tables as continuous processing (seed %i)', async (seed) => {
    const h = setup();
    await ingestContinuously(h, events, seed);
    const continuous = snapshot(h);
    expect(failedEvents(h.database.db)).toEqual([]);

    // Sanity: the scenario covers every kind of session end.
    const sessions = (
      continuous.derived as { sessions: { sessions: { endReason: string | null }[] } }
    ).sessions.sessions;
    expect(new Set(sessions.map((s) => s.endReason))).toEqual(
      new Set(['logout', 'hop', 'timeout', 'client_closed', null]),
    );

    const result = await rebuildViaApi(h);
    expect(result).toMatchObject({ processed: events.length, failed: 0 });
    expect(snapshot(h)).toEqual(continuous);
    expect(eventState(h).every((row) => row.processed !== null && row.error === null)).toBe(true);

    await rebuildViaCli(h);
    expect(snapshot(h)).toEqual(continuous);
  });

  it('processes events that failed during ingest', async () => {
    const reference = setup();
    await ingestContinuously(reference, events, 7);

    const random = seededRandom(99);
    const broken = new Set(events.filter(() => random() < 0.2).map((event) => event.eventId));
    const h = setup([...PROJECTIONS, failingFor(broken)]);
    await ingestContinuously(h, events, 7);
    expect(failedEvents(h.database.db).length).toBe(broken.size);
    expect(snapshot(h)).not.toEqual(snapshot(reference));

    const result = await rebuildViaApi(h);
    expect(result).toMatchObject({ processed: events.length, failed: 0 });
    expect(failedEvents(h.database.db)).toEqual([]);
    expect(snapshot(h).derived).toEqual(snapshot(reference).derived);
  });
});
