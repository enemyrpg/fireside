import { ingestResponseSchema, type Event } from '@fireside/shared';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createApiKey } from '../auth/api-keys.js';
import { accountIds, accounts, events } from '../db/schema.js';
import { testConfig, testDatabase, TEST_OWNER } from '../test-utils.js';
import { accountsProjection } from './accounts.js';
import {
  failedEvents,
  projectEvents,
  projectPending,
  rebuildProjections,
  reprocessFailed,
  type Projection,
  type ProjectionLogger,
} from './framework.js';
import { PROJECTIONS } from './index.js';
import {
  emptyRun,
  eventFactory,
  expectOrderIndependent,
  ingestBatch,
  storeOnly,
  type TestRun,
} from './testing.js';
import { FIRST_USER_ID } from '../users/users.js';

const NOW = new Date('2026-11-09T12:00:00.000Z');
const now = () => NOW;

/** Throws for `kc` events while `broken` is true. */
function flakyProjection() {
  const state = { broken: true };
  const projection: Projection = {
    name: 'flaky',
    apply(_tx, event) {
      if (state.broken && event.type === 'kc') throw new Error('boom');
    },
    reset: () => undefined,
    snapshot: () => null,
  };
  return { state, projection };
}

/** Counts how often each event is applied. */
function countingProjection() {
  const applied: string[] = [];
  const projection: Projection = {
    name: 'counting',
    apply(_tx, event) {
      applied.push(event.eventId);
    },
    reset: () => undefined,
    snapshot: () => null,
  };
  return { applied, projection };
}

function statusRows(run: TestRun) {
  return run.database.db
    .select({
      eventId: events.eventId,
      processedAt: events.processedAt,
      projectionError: events.projectionError,
    })
    .from(events)
    .orderBy(events.occurredAt)
    .all();
}

function accountRows(run: TestRun) {
  return run.database.db.select().from(accounts).all();
}

describe('projectEvents', () => {
  it('marks projected events as processed', () => {
    const f = eventFactory();
    const run = emptyRun();
    ingestBatch(run, [f.sessionStart('10:00'), f.heartbeat('10:01')]);
    expect(statusRows(run).map((row) => row.processedAt)).toEqual([
      NOW.toISOString(),
      NOW.toISOString(),
    ]);
    expect(run.failed).toEqual([]);
  });

  it('keeps a failing event, records the error and projects the rest', () => {
    const f = eventFactory();
    const { projection } = flakyProjection();
    const run = emptyRun();
    const start = f.sessionStart('10:00');
    const kc = f.kc('10:05');
    const heartbeat = f.heartbeat('10:10');
    ingestBatch(run, [start, kc, heartbeat], [accountsProjection, projection]);

    expect(run.failed).toEqual([{ eventId: kc.eventId, error: 'flaky: boom' }]);
    expect(statusRows(run)).toEqual([
      { eventId: start.eventId, processedAt: NOW.toISOString(), projectionError: null },
      { eventId: kc.eventId, processedAt: null, projectionError: 'flaky: boom' },
      { eventId: heartbeat.eventId, processedAt: NOW.toISOString(), projectionError: null },
    ]);
    expect(failedEvents(run.database.db)).toEqual([
      { eventId: kc.eventId, type: 'kc', error: 'flaky: boom' },
    ]);
  });

  it("rolls back the failing event's derived changes from earlier projections", () => {
    const f = eventFactory();
    const { projection } = flakyProjection();
    const run = emptyRun();
    // Accounts runs first and would create the account; the savepoint undoes it.
    ingestBatch(run, [f.kc('10:05')], [accountsProjection, projection]);
    expect(accountRows(run)).toEqual([]);
  });

  it('never applies an event twice when it is resent', () => {
    const f = eventFactory();
    const { applied, projection } = countingProjection();
    const run = emptyRun();
    const batch = [f.sessionStart('10:00'), f.heartbeat('10:01')];
    ingestBatch(run, batch, [projection]);
    ingestBatch(run, batch, [projection]);
    // Projecting the same IDs again directly is a no-op too.
    projectEvents(
      run.database.db,
      batch.map((event) => event.eventId),
      { projections: [projection], now },
    );
    expect(applied).toEqual(batch.map((event) => event.eventId));
  });

  it('applies a batch in occurredAt order, then by event ID', () => {
    const f = eventFactory();
    const { applied, projection } = countingProjection();
    const run = emptyRun();
    const late = f.heartbeat('11:00');
    const tieA = f.heartbeat('10:00');
    const tieB = f.heartbeat('10:00');
    ingestBatch(run, [late, tieB, tieA], [projection]);
    expect(applied).toEqual([tieA.eventId, tieB.eventId, late.eventId]);
  });

  it('fails an event whose stored payload no longer validates', () => {
    const f = eventFactory();
    const run = emptyRun();
    const [id] = storeOnly(run, [f.sessionStart('10:00')]);
    run.database.db.update(events).set({ payload: '{"displayName":""}' }).run();
    const result = projectEvents(run.database.db, [id ?? ''], { projections: PROJECTIONS, now });
    expect(result.failed).toEqual([
      { eventId: id, error: expect.stringMatching(/^parse: payload\./) as unknown },
    ]);
    expect(accountRows(run)).toEqual([]);
  });

  it('logs failures without payloads', () => {
    const f = eventFactory();
    const { projection } = flakyProjection();
    const run = emptyRun();
    const ids = storeOnly(run, [f.kc('10:00'), f.sessionStart('10:01', { displayName: 'Secret' })]);
    const logged: unknown[] = [];
    const log: ProjectionLogger = { warn: (obj, msg) => logged.push({ obj, msg }) };
    projectEvents(run.database.db, ids, { projections: [projection], now, log });
    expect(logged).toEqual([
      {
        obj: { eventId: ids[0], type: 'kc', error: 'flaky: boom' },
        msg: 'Projection failed, raw event kept',
      },
    ]);
    expect(JSON.stringify(logged)).not.toContain('Secret');
  });
});

describe('projectPending and reprocessFailed', () => {
  it('projects events that were stored but never projected', () => {
    const f = eventFactory();
    const run = emptyRun();
    storeOnly(run, [f.sessionStart('10:00'), f.heartbeat('10:01')]);
    expect(accountRows(run)).toEqual([]);

    expect(projectPending(run.database.db, { projections: PROJECTIONS, now })).toEqual({
      processed: 2,
      failed: [],
    });
    expect(accountRows(run)).toHaveLength(1);
    expect(projectPending(run.database.db, { projections: PROJECTIONS, now }).processed).toBe(0);
  });

  it('leaves failed events to reprocessFailed, which clears them once fixed', () => {
    const f = eventFactory();
    const { state, projection } = flakyProjection();
    const projections = [accountsProjection, projection];
    const run = emptyRun();
    const kc = f.kc('10:05');
    ingestBatch(run, [f.sessionStart('10:00'), kc], projections);
    expect(failedEvents(run.database.db)).toHaveLength(1);

    // Pending excludes failed events.
    expect(projectPending(run.database.db, { projections, now }).processed).toBe(0);
    // Still broken: fails again and keeps its error.
    expect(reprocessFailed(run.database.db, { projections, now }).failed).toHaveLength(1);

    state.broken = false;
    expect(reprocessFailed(run.database.db, { projections, now })).toEqual({
      processed: 1,
      failed: [],
    });
    expect(failedEvents(run.database.db)).toEqual([]);
    expect(statusRows(run).find((row) => row.eventId === kc.eventId)).toEqual({
      eventId: kc.eventId,
      processedAt: NOW.toISOString(),
      projectionError: null,
    });
  });
});

describe('rebuildProjections', () => {
  it('resets derived tables and replays every event', () => {
    const f = eventFactory();
    const run = emptyRun();
    ingestBatch(run, [f.sessionStart('10:00', { displayName: 'Real' }), f.heartbeat('10:01')]);
    const db = run.database.db;
    const [before] = accountRows(run);

    // Damage the derived state, and add an account without any events.
    db.update(accounts).set({ displayName: 'Wrong' }).run();
    const { id: strayId } = db
      .insert(accountIds)
      .values({ userId: FIRST_USER_ID, accountHash: '42' })
      .returning({ id: accountIds.id })
      .get();
    db.insert(accounts)
      .values({
        id: strayId,
        userId: FIRST_USER_ID,
        accountHash: '42',
        firstSeenAt: NOW.toISOString(),
        lastSeenAt: NOW.toISOString(),
      })
      .run();
    db.update(events).set({ processedAt: null, projectionError: 'old' }).run();

    expect(rebuildProjections(db, { projections: PROJECTIONS, now })).toEqual({
      processed: 2,
      failed: [],
    });
    expect(accountRows(run)).toEqual([before]);
    expect(failedEvents(db)).toEqual([]);
    expect(statusRows(run).every((row) => row.processedAt === NOW.toISOString())).toBe(true);
  });

  it('calls reset in reverse registry order before replaying', () => {
    const calls: string[] = [];
    const tracking = (name: string): Projection => ({
      name,
      apply: () => calls.push(`apply ${name}`),
      reset: () => calls.push(`reset ${name}`),
      snapshot: () => null,
    });
    const run = emptyRun();
    storeOnly(run, [eventFactory().heartbeat('10:00')]);
    rebuildProjections(run.database.db, { projections: [tracking('a'), tracking('b')], now });
    expect(calls).toEqual(['reset b', 'reset a', 'apply a', 'apply b']);
  });

  it('replays across chunk boundaries in occurredAt order', () => {
    const f = eventFactory();
    const { applied, projection } = countingProjection();
    const many: Event[] = [];
    for (let i = 0; i < 1203; i++) {
      many.push(f.heartbeat(new Date(Date.UTC(2026, 10, 8, 0, 0, i % 600)).toISOString()));
    }
    const run = emptyRun();
    storeOnly(run, many);
    const result = rebuildProjections(run.database.db, { projections: [projection], now });
    expect(result.processed).toBe(1203);
    expect(new Set(applied).size).toBe(1203);
    const sorted = [...many]
      .sort((a, b) =>
        a.occurredAt === b.occurredAt
          ? a.eventId.localeCompare(b.eventId)
          : a.occurredAt.localeCompare(b.occurredAt),
      )
      .map((event) => event.eventId);
    expect(applied).toEqual(sorted);
  });

  it('reads the clock once, so every chunk sees the same now', () => {
    const f = eventFactory();
    const seen = new Set<number>();
    const projection: Projection = {
      name: 'clock',
      apply(_tx, _event, context) {
        seen.add(context.now.getTime());
      },
      reset: () => undefined,
      snapshot: () => null,
    };
    const many: Event[] = [];
    for (let i = 0; i < 1203; i++) {
      many.push(f.heartbeat(new Date(Date.UTC(2026, 10, 8, 0, 0, i % 600)).toISOString()));
    }
    let ticks = 0;
    const movingClock = () => new Date(NOW.getTime() + 1000 * ticks++);

    const run = emptyRun();
    storeOnly(run, many);
    rebuildProjections(run.database.db, { projections: [projection], now: movingClock });
    expect(seen.size).toBe(1);
    const processedAt = run.database.db
      .selectDistinct({ processedAt: events.processedAt })
      .from(events)
      .all();
    expect(processedAt).toHaveLength(1);

    seen.clear();
    run.database.db.update(events).set({ processedAt: null }).run();
    projectPending(run.database.db, { projections: [projection], now: movingClock });
    expect(seen.size).toBe(1);
  });
});

describe('expectOrderIndependent', () => {
  it('catches a projection that depends on arrival order', () => {
    // "Last session.start to arrive wins": wrong on purpose.
    const lastArrived: Projection = {
      ...accountsProjection,
      name: 'last-arrived',
      apply(tx, event, context) {
        accountsProjection.apply(tx, event, context);
        if (event.type === 'session.start') {
          tx.update(accounts)
            .set({ displayName: event.payload.displayName })
            .where(eq(accounts.accountHash, event.accountHash))
            .run();
        }
      },
    };
    const f = eventFactory();
    const startEvents = [
      f.sessionStart('10:00', { displayName: 'Old' }),
      f.sessionStart('12:00', { displayName: 'New' }),
    ];
    expect(() => expectOrderIndependent(startEvents, { projections: [lastArrived] })).toThrow();
  });
});

describe('POST /api/v1/ingest with projections', () => {
  const apps: { close: () => Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function setup(projections?: readonly Projection[]) {
    const database = testDatabase();
    const { key } = createApiKey(database.db, TEST_OWNER, 'Gaming PC');
    const app = buildApp({
      db: database,
      config: testConfig(),
      ingest: { now, ...(projections ? { projections } : {}) },
    });
    apps.push(app);
    const post = (batch: Event[]) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/ingest',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ events: batch }),
      });
    return { database, post };
  }

  it('projects accepted events before answering', async () => {
    const f = eventFactory();
    const { database, post } = setup();
    // Upper-case IDs are stored (and projected) in lower case.
    const start = f.sessionStart('10:00');
    const response = await post([{ ...start, eventId: start.eventId.toUpperCase() }]);
    expect(response.statusCode).toBe(200);
    expect(database.db.select().from(accounts).all()).toMatchObject([{ displayName: 'Test Main' }]);
    expect(database.db.select().from(events).get()).toMatchObject({
      processedAt: NOW.toISOString(),
    });
  });

  it('still accepts events when their projection fails', async () => {
    const f = eventFactory();
    const { projection } = flakyProjection();
    const { database, post } = setup([projection]);
    const kc = f.kc('10:00');
    const response = await post([kc]);
    expect(response.statusCode).toBe(200);
    expect(ingestResponseSchema.parse(response.json()).accepted).toEqual([kc.eventId]);
    expect(failedEvents(database.db)).toHaveLength(1);
  });

  it('still accepts events when the whole projection step fails, and leaves them pending', async () => {
    const f = eventFactory();
    const { projection } = flakyProjection();
    const { database, post } = setup([projection]);
    // Recording the error fails too, so the projection transaction rolls back.
    database.db.run(
      sql.raw(
        'CREATE TRIGGER fail_status BEFORE UPDATE OF projection_error ON events ' +
          "WHEN NEW.projection_error IS NOT NULL BEGIN SELECT RAISE(ABORT, 'disk full'); END",
      ),
    );
    const kc = f.kc('10:00');
    const response = await post([kc]);
    expect(response.statusCode).toBe(200);
    expect(ingestResponseSchema.parse(response.json()).accepted).toEqual([kc.eventId]);
    expect(database.db.select().from(events).get()).toMatchObject({
      processedAt: null,
      projectionError: null,
    });

    database.db.run(sql.raw('DROP TRIGGER fail_status'));
    expect(projectPending(database.db, { projections: PROJECTIONS, now })).toEqual({
      processed: 1,
      failed: [],
    });
    expect(database.db.select().from(accounts).all()).toHaveLength(1);
  });
});
