import { encodeBase64, makeSolidPng } from '@fireside/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { itemIcons, namedIcons } from '../db/schema.js';
import { storeIcons } from '../icons/store.js';
import { failedEvents, PROJECTIONS } from '../projections/index.js';
import {
  emptyRun,
  eventFactory,
  failingFor,
  ingestBatch,
  runIncremental,
  snapshotDerived,
  storeOnly,
  TEST_NOW,
  type TestRun,
} from '../projections/testing.js';
import { rebuildDerivedTables, retryFailedEvents } from './rebuild.js';

function sampleEvents() {
  const f = eventFactory();
  return [
    f.sessionStart('19:00'),
    f.xpSnapshot('19:00', { ATTACK: 100 }, { reason: 'login' }),
    f.heartbeat('19:01'),
    f.loot('19:02'),
    f.kc('19:02', { killCount: 5 }),
    f.xpSnapshot('19:03', { ATTACK: 250 }),
    f.sessionEnd('19:04'),
  ];
}

function recordingLog() {
  const info: { obj: object; msg: string }[] = [];
  return {
    info,
    log: {
      info: (obj: object, msg: string) => info.push({ obj, msg }),
      warn: () => undefined,
    },
  };
}

describe('admin rebuild', () => {
  const runs: TestRun[] = [];
  const track = (run: TestRun) => (runs.push(run), run);
  afterEach(() => {
    for (const run of runs.splice(0)) run.database.close();
  });

  it('rebuilds stored events, logs counts and time', () => {
    const events = sampleEvents();
    const run = track(emptyRun());
    storeOnly(run, events);
    const { info, log } = recordingLog();

    const result = rebuildDerivedTables(run.database.db, { now: () => TEST_NOW, log });

    expect(result.processed).toBe(events.length);
    expect(result.failed).toEqual([]);
    expect(Number.isInteger(result.durationMs) && result.durationMs >= 0).toBe(true);
    expect(info).toEqual([
      {
        msg: 'Rebuilt derived tables',
        obj: { processed: events.length, failed: 0, durationMs: result.durationMs },
      },
    ]);
    expect(snapshotDerived(run)).toEqual(snapshotDerived(track(runIncremental(events))));
  });

  it('leaves icons alone: they are assets, not events', () => {
    const run = track(emptyRun());
    storeOnly(run, sampleEvents());
    storeIcons(
      run.database.db,
      [
        { itemId: 4151, png: encodeBase64(makeSolidPng(32, 32, [200, 60, 40, 255])) },
        {
          kind: 'SKILL',
          key: 'ATTACK',
          png: encodeBase64(makeSolidPng(25, 25, [200, 60, 40, 255])),
        },
        {
          kind: 'BOSS',
          key: 'Zulrah',
          png: encodeBase64(makeSolidPng(25, 25, [40, 90, 200, 255])),
        },
      ],
      TEST_NOW,
    );
    const before = run.database.db.select().from(itemIcons).all();
    expect(before).toHaveLength(1);
    const namedBefore = run.database.db.select().from(namedIcons).all();
    expect(namedBefore).toHaveLength(2);

    rebuildDerivedTables(run.database.db, { now: () => TEST_NOW });
    retryFailedEvents(run.database.db, { now: () => TEST_NOW });

    expect(run.database.db.select().from(itemIcons).all()).toEqual(before);
    expect(run.database.db.select().from(namedIcons).all()).toEqual(namedBefore);
  });

  it('retries events that failed before', () => {
    const events = sampleEvents();
    const broken = new Set([events[3]?.eventId ?? '', events[5]?.eventId ?? '']);
    const run = track(emptyRun());
    ingestBatch(run, events, [...PROJECTIONS, failingFor(broken)]);
    expect(failedEvents(run.database.db)).toHaveLength(2);

    const result = rebuildDerivedTables(run.database.db, { now: () => TEST_NOW });

    expect(result).toMatchObject({ processed: events.length, failed: [] });
    expect(failedEvents(run.database.db)).toEqual([]);
    expect(snapshotDerived(run)).toEqual(snapshotDerived(track(runIncremental(events))));
  });

  it('reports events that still fail', () => {
    const events = sampleEvents();
    const broken = new Set([events[4]?.eventId ?? '']);
    const run = track(emptyRun());
    storeOnly(run, events);

    const result = rebuildDerivedTables(run.database.db, {
      projections: [...PROJECTIONS, failingFor(broken)],
      now: () => TEST_NOW,
    });

    expect(result.processed).toBe(events.length - 1);
    expect(result.failed).toEqual([
      { eventId: events[4]?.eventId, error: 'test-failure: simulated failure' },
    ]);
  });

  it('retryFailedEvents only touches failed events', () => {
    const events = sampleEvents();
    const broken = new Set([events[3]?.eventId ?? '']);
    const run = track(emptyRun());
    ingestBatch(run, events, [...PROJECTIONS, failingFor(broken)]);
    const { info, log } = recordingLog();

    const result = retryFailedEvents(run.database.db, { now: () => TEST_NOW, log });

    expect(result).toMatchObject({ processed: 1, failed: [] });
    expect(info[0]?.msg).toBe('Retried failed events');
    expect(snapshotDerived(run)).toEqual(snapshotDerived(track(runIncremental(events))));
  });
});
