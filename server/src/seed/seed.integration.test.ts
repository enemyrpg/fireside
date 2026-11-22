import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rebuildDerivedTables } from '../admin/rebuild.js';
import { accountNames, accounts, sessions } from '../db/schema.js';
import { snapshotDerived } from '../projections/testing.js';
import { testConfig, testDatabase } from '../test-utils.js';
import { generateSeed } from './generator/generate.js';
import { seedInProcess } from './in-process.js';

// A small seed through `POST /api/v1/ingest` in-process. Nothing is rejected or
// fails projection, the edge cases end up right in the derived tables, and a
// rebuild afterwards gives identical tables.

const OPTIONS = {
  seed: 7,
  accounts: 2,
  months: 0.5,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: 'Europe/Oslo',
};

describe('seed through ingest (integration)', () => {
  it(
    'stores everything cleanly, and a rebuild gives the same tables',
    { timeout: 60_000 },
    async () => {
      const data = generateSeed(OPTIONS);
      const database = testDatabase();
      try {
        const result = await seedInProcess(database, testConfig({ TZ: OPTIONS.timeZone }), data);
        expect(result.rejected).toEqual([]);
        expect(result.failed).toEqual([]);
        expect(result).toMatchObject({ accepted: data.events.length, duplicates: 0 });

        const db = database.db;
        const snapshot = () => ({
          derived: snapshotDerived({ database, apiKeyId: 0, failed: [] }),
          accountIds: db
            .select({ hash: accounts.accountHash, id: accounts.id })
            .from(accounts)
            .orderBy(asc(accounts.accountHash))
            .all(),
        });
        const continuous = snapshot();
        // Raids are part of what the rebuild must reproduce.
        expect(continuous.derived['raid-special-loot']).not.toEqual([]);

        // Every kind of end, incl. crashes closed by timeout and one open session.
        const rows = db.select().from(sessions).all();
        expect(rows).toHaveLength(data.sessions.length);
        expect(new Set(rows.map((s) => s.endReason))).toEqual(
          new Set(['logout', 'client_closed', 'hop', 'timeout', null]),
        );
        expect(rows.filter((s) => s.endReason === 'timeout')).toHaveLength(
          data.stats.sessionsByEnd.crash,
        );

        // The backlog session was timed out first; its late session.end won.
        const late = data.deliveries.find((d) => !d.live);
        const lateEnd = late?.events.find((e) => e.type === 'session.end');
        expect(lateEnd).toBeDefined();
        const lateRow = rows.find((s) => s.id === lateEnd?.sessionId);
        expect(lateRow).toMatchObject({ endReason: 'logout', endedAt: lateEnd?.occurredAt });

        // Name change and back gives three name periods for the iron.
        const iron = data.accounts.find((a) => a.profile === 'iron');
        const ironRow = db
          .select()
          .from(accounts)
          .where(eq(accounts.accountHash, iron?.accountHash ?? ''))
          .get();
        expect(ironRow).toMatchObject({ displayName: 'Seed Iron', accountType: 'IRONMAN' });
        const names = db
          .select({ name: accountNames.displayName })
          .from(accountNames)
          .where(eq(accountNames.accountId, ironRow?.id ?? -1))
          .orderBy(asc(accountNames.firstSeenAt))
          .all();
        expect(names.map((n) => n.name)).toEqual(['Seed Iron', 'Iron Seedling', 'Seed Iron']);

        const rebuilt = rebuildDerivedTables(db, { now: () => data.until });
        expect(rebuilt).toMatchObject({ processed: data.events.length, failed: [] });
        expect(snapshot()).toEqual(continuous);
      } finally {
        database.close();
      }
    },
  );
});
