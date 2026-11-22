import { Writable } from 'node:stream';
import {
  errorResponseSchema,
  raidDropResponseSchema,
  raidSplitsResponseSchema,
} from '@fireside/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { emptyRun, eventFactory, ingestBatch } from '../projections/testing.js';
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
});
