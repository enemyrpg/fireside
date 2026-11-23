import {
  calendarResponseSchema,
  screentimeResponseSchema,
  sessionDetailResponseSchema,
  sessionsResponseSchema,
  type Event,
} from '@fireside/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import { accounts } from '../db/schema.js';
import { PROJECTIONS } from '../projections/index.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  sessionIdOf,
  type TestRun,
} from '../projections/testing.js';
import { testConfig } from '../test-utils.js';

// The AFK estimate in all four views: session detail, Sessions, screen time
// and the calendar. While the session is still AFK they all count the idle
// heartbeats as AFK; once `session.afk` arrives they all count the stored
// period instead. One heartbeat = 60 s in screen time and the calendar.

const DAY = 'from=2026-11-10T00:00:00.000Z&to=2026-11-11T00:00:00.000Z';
const SESSION = sessionIdOf(1);
const MINUTE = 60_000;

function at(hh: number, mm: number, ss = 0): string {
  return new Date(Date.UTC(2026, 10, 10, hh, mm, ss)).toISOString();
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function get<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
  const response = await app!.inject({ method: 'GET', url }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by the test
  expect(response.statusCode, response.body).toBe(200);
  return schema.parse(response.json());
}

let clock = new Date(0);

/** AFK seconds as each view reports them, at `now`. */
async function views(run: TestRun, now: Date) {
  clock = now;
  app ??= buildApp({
    db: run.database,
    config: testConfig({ TZ: 'UTC' }),
    dashboard: { now: () => clock },
  });
  const account = run.database.db.select({ id: accounts.id }).from(accounts).get()?.id ?? 0;
  const detail = await get(`/api/v1/sessions/${SESSION}`, sessionDetailResponseSchema);
  const list = await get(`/api/v1/accounts/${String(account)}/sessions`, sessionsResponseSchema);
  const screen = await get(
    `/api/v1/accounts/${String(account)}/screentime?${DAY}`,
    screentimeResponseSchema,
  );
  const calendar = await get(
    `/api/v1/accounts/${String(account)}/calendar?${DAY}`,
    calendarResponseSchema,
  );
  return {
    detailPeriods: detail.afkPeriods,
    detailAfk: detail.session.afkSeconds,
    listAfk: list.items[0]?.afkSeconds,
    screenAfk: screen.totals.afkSeconds,
    calendarAfk: calendar.days.reduce((sum, day) => sum + day.afkSeconds, 0),
  };
}

describe('AFK estimate in every view', () => {
  it('counts ongoing AFK as AFK, then matches the stored period once session.afk arrives', async () => {
    const f = eventFactory();
    const beats: Event[] = [];
    // Active 11:01–11:10, idle 11:11–11:20 (the plugin went idle at 11:11).
    for (let mm = 1; mm <= 20; mm++) {
      beats.push(f.heartbeat(at(11, mm), { payload: { idle: mm >= 11 } }));
    }
    const run = emptyRun();
    const stillAfk = new Date(Date.parse(at(11, 20)) + 30_000);
    ingestBatch(run, [f.sessionStart(at(11, 0)), ...beats], PROJECTIONS, stillAfk);
    expect(run.failed).toEqual([]);

    // The estimate: 11:11 to 11:20, 9 minutes. Screen time and the calendar
    // count the idle heartbeats at 11:11–11:19 (the one at 11:20 is the end).
    expect(await views(run, stillAfk)).toEqual({
      detailPeriods: [{ startedAt: at(11, 11), endedAt: at(11, 20) }],
      detailAfk: 9 * 60,
      listAfk: 9 * 60,
      screenAfk: 9 * 60,
      calendarAfk: 9 * 60,
    });

    // Input at 11:21: the plugin sends the real period (AFK from 11:10:30,
    // when the threshold started counting) and an active heartbeat.
    const back = new Date(Date.parse(at(11, 21)) + 10_000);
    ingestBatch(
      run,
      [f.afk(at(11, 10, 30), at(11, 21)), f.heartbeat(at(11, 21))],
      PROJECTIONS,
      back,
    );
    expect(run.failed).toEqual([]);

    // The stored period, 10.5 minutes, everywhere. Screen time and the
    // calendar count the heartbeats inside it: 11:11–11:20, 10 minutes.
    const after = await views(run, back);
    expect(after).toEqual({
      detailPeriods: [{ startedAt: at(11, 10, 30), endedAt: at(11, 21) }],
      detailAfk: 10.5 * 60,
      listAfk: 10.5 * 60,
      screenAfk: 10 * 60,
      calendarAfk: 10 * 60,
    });
    const heartbeatsInPeriod = beats
      .map((beat) => Date.parse(beat.occurredAt))
      .filter((ms) => ms >= Date.parse(at(11, 10, 30)) && ms < Date.parse(at(11, 21))).length;
    expect(after.screenAfk).toBe(heartbeatsInPeriod * (MINUTE / 1000));
  });
});
