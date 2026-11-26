import { Writable } from 'node:stream';
import {
  errorResponseSchema,
  raidDropResponseSchema,
  raidSplitsResponseSchema,
} from '@fireside/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { rebuildDerivedTables, retryFailedEvents } from '../admin/rebuild.js';
import { buildApp } from '../app.js';
import { raidDropChoices } from '../db/schema.js';
import { PROJECTIONS } from '../projections/index.js';
import { emptyRun, eventFactory, failingFor, ingestBatch } from '../projections/testing.js';
import { projectionUpgrade, recordCurrentVersions } from '../projections/versions.js';
import { testConfig } from '../test-utils.js';

// A nickname or note must never reach the logs, also when the write itself
// fails (500). The failures are forced with triggers that abort every write to
// the split tracker's tables.
//
// The 500 log line carries the thrown error. With the synchronous SQLite
// driver that is SQLite's own error (a message and a stack, never the query's
// parameters). If a driver or ORM upgrade starts putting parameters in the
// error, this test fails, and these routes must then log only the error's
// name and code.

const NICKNAME = 'Nickname Zq7';
const NOTE = 'Note Zq7 with a detail';
const BASE = '/api/v1/accounts/1/raids';
const NOW_ISO = '2026-11-10T12:00:00.000Z';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('raid split write failures', () => {
  it('never logs a nickname or note when a write fails', async () => {
    const run = emptyRun();
    const f = eventFactory();
    ingestBatch(run, [
      f.sessionStart('18:00'),
      f.raidSpecialLoot('19:00', { recipient: 'TEAMMATE', teamSize: 3 }),
    ]);
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    app = buildApp({
      db: run.database,
      config: testConfig({ LOG_LEVEL: 'trace' }),
      logStream: stream,
    });

    const overview = await app.inject({ method: 'GET', url: `${BASE}/splits` });
    const dropId = raidSplitsResponseSchema.parse(overview.json()).drops.items[0]?.dropId ?? '';
    // A manual drop to update, added before the writes start failing.
    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/drops`,
      payload: { raid: 'Tombs of Amascut', itemId: 26219, occurredAt: '2026-11-08T20:00:00.000Z' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const manualId = raidDropResponseSchema.parse(created.json()).drop.dropId;

    for (const [table, event] of [
      ['raid_drop_choices', 'INSERT'],
      ['raid_manual_drops', 'INSERT'],
      ['raid_manual_drops', 'UPDATE'],
    ] as const) {
      run.database.sqlite.exec(
        `CREATE TRIGGER fail_${table}_${event} BEFORE ${event} ON ${table}
         BEGIN SELECT RAISE(ABORT, 'forced write failure'); END`,
      );
    }

    const payload = { nickname: NICKNAME, note: NOTE };
    const failing = [
      { method: 'PATCH', url: `${BASE}/drops/${dropId}`, payload },
      { method: 'PATCH', url: `${BASE}/drops/${manualId}`, payload },
      {
        method: 'POST',
        url: `${BASE}/drops`,
        payload: {
          raid: 'Tombs of Amascut',
          itemId: 26219,
          occurredAt: '2026-11-08T21:00:00.000Z',
          ...payload,
        },
      },
    ] as const;
    for (const request of failing) {
      const response = await app.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}: ${response.body}`).toBe(500);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('INTERNAL_ERROR');
      expect(response.body).not.toContain(NICKNAME);
      expect(response.body).not.toContain(NOTE);
    }

    const output = lines.join('');
    const failures = lines
      .map((line) => JSON.parse(line) as { level?: number; msg?: string })
      .filter((entry) => entry.level === 50);
    expect(failures).toHaveLength(failing.length);
    expect(output).not.toContain(NICKNAME);
    expect(output).not.toContain(NOTE);
    expect(output).not.toContain('Zq7');
  });

  it('never logs a nickname or note when choices move or are removed', async () => {
    const run = emptyRun();
    const f = eventFactory();
    const chest = f.loot('19:00', {
      source: { type: 'EVENT', name: 'Tombs of Amascut' },
      items: [
        { itemId: 995, name: 'Coins', quantity: 50_000, gePrice: 1, haPrice: 1 },
        { itemId: 26219, name: "Osmumten's fang", quantity: 1, gePrice: 24_000_000, haPrice: 0 },
      ],
    });
    const own = f.raidSpecialLoot('19:00', { teamSize: 3 });
    const teammate = f.raidSpecialLoot('19:30', { recipient: 'TEAMMATE', teamSize: 3 });
    ingestBatch(
      run,
      [f.sessionStart('18:00'), chest, own, teammate],
      [...PROJECTIONS, failingFor(new Set([own.eventId]))],
    );
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    app = buildApp({
      db: run.database,
      config: testConfig({ LOG_LEVEL: 'trace' }),
      logStream: stream,
    });
    const patch = async (dropId: string, payload: object) => {
      const response = await app?.inject({
        method: 'PATCH',
        url: `${BASE}/drops/${dropId}`,
        payload,
      });
      expect(response?.statusCode, response?.body).toBe(200);
    };
    // A choice on the chest fallback (moved on retry), a nickname, and one on
    // a chest position that is no purple (removed on rebuild).
    await patch(`${chest.eventId}.1`, { note: NOTE });
    await patch(teammate.eventId, { nickname: NICKNAME, note: NOTE });
    run.database.db
      .insert(raidDropChoices)
      .values({ eventId: chest.eventId, itemIndex: 0, note: NOTE, updatedAt: NOW_ISO })
      .run();

    expect(retryFailedEvents(run.database.db, { log: app.log }).failed).toEqual([]);
    const rebuilt = await app.inject({ method: 'POST', url: '/api/v1/admin/rebuild' });
    expect(rebuilt.statusCode, rebuilt.body).toBe(200);
    rebuildDerivedTables(run.database.db, {
      projections: [...PROJECTIONS, failingFor(new Set([teammate.eventId]))],
      log: app.log,
    });
    recordCurrentVersions(run.database.db);
    run.database.sqlite.exec(
      "UPDATE projection_versions SET version = 1 WHERE name = 'raid-special-loot'",
    );
    projectionUpgrade({ log: app.log }).run(run.database.db, run.database.sqlite);
    expect(run.database.db.select().from(raidDropChoices).all()).toHaveLength(2);

    const output = lines.join('');
    expect(output).toContain('Removed split choices of drops that no longer exist');
    expect(output).not.toContain(NICKNAME);
    expect(output).not.toContain(NOTE);
    expect(output).not.toContain('Zq7');
  });
});
