import { describe, expect, it } from 'vitest';
import { schemaAsserts } from '../../test-utils.js';
import {
  calendarQuerySchema,
  calendarResponseSchema,
  sessionDetailResponseSchema,
  sessionParamsSchema,
  sessionsQuerySchema,
  sessionsResponseSchema,
} from './sessions.js';

const SESSION_ID = '01933c40-1111-7aaa-bbbb-ccccdddd0001';
const UUID_V4 = '9b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d';

const session = {
  id: SESSION_ID,
  accountId: 1,
  startedAt: '2026-11-08T18:00:00.000Z',
  endedAt: '2026-11-08T20:00:00.000Z',
  endReason: 'logout',
  world: 420,
  durationSeconds: 7200,
  activeSeconds: 6300,
  afkSeconds: 900,
  summary: {
    xpGainedTotal: 120000,
    xpGainedBySkill: { SLAYER: 100000, HITPOINTS: 20000 },
    lootGeValue: 2854200,
    lootCount: 18,
    kcGainedByBoss: { Vorkath: 18 },
  },
  newCollectionLogCount: 0,
};

describe('sessions query', () => {
  const query = schemaAsserts(sessionsQuerySchema);

  it('applies pagination defaults', () => {
    expect(query.accepts({})).toEqual({ limit: 50 });
    expect(query.accepts({ limit: '10', cursor: 'abc' })).toEqual({ limit: 10, cursor: 'abc' });
  });

  it('rejects a bad range', () => {
    expect(
      query.issuePaths({ from: '2026-11-08T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' }),
    ).toContain('to');
  });
});

describe('sessions response', () => {
  const response = schemaAsserts(sessionsResponseSchema);
  const page = (item: unknown) => ({ items: [item], nextCursor: null });

  it('accepts a closed session', () => {
    response.accepts(page(session));
  });

  it('accepts an ongoing session without summary', () => {
    response.accepts(page({ ...session, endedAt: null, endReason: null, summary: null }));
  });

  it('accepts a session without a known world', () => {
    response.accepts(page({ ...session, world: null }));
  });

  it('accepts the server-only timeout reason', () => {
    response.accepts(page({ ...session, endReason: 'timeout' }));
  });

  it('rejects endedAt without endReason and the other way around', () => {
    response.rejects(page({ ...session, endReason: null }));
    response.rejects(page({ ...session, endedAt: null }));
  });

  it('rejects endedAt before startedAt', () => {
    expect(
      response.issuePaths(page({ ...session, endedAt: '2026-11-08T17:00:00.000Z' })),
    ).toContain('items.0.endedAt');
  });

  it('rejects active + AFK that does not add up to the duration', () => {
    expect(response.issuePaths(page({ ...session, afkSeconds: 1000 }))).toContain(
      'items.0.durationSeconds',
    );
  });

  it.each([
    ['id', UUID_V4],
    ['endReason', 'crash'],
    ['world', 0],
  ])('rejects %s = %j', (field, value) => {
    expect(response.issuePaths(page({ ...session, [field]: value }))).toContain(`items.0.${field}`);
  });

  it('rejects lowercase skill keys and negative gains in the summary', () => {
    response.rejects(
      page({ ...session, summary: { ...session.summary, xpGainedBySkill: { slayer: 1 } } }),
    );
    response.rejects(
      page({ ...session, summary: { ...session.summary, kcGainedByBoss: { Vorkath: -1 } } }),
    );
  });
});

describe('session params', () => {
  it('requires a UUIDv7 session id', () => {
    const params = schemaAsserts(sessionParamsSchema);
    params.accepts({ sessionId: SESSION_ID });
    params.rejects({ sessionId: UUID_V4 });
  });
});

describe('session detail response', () => {
  const response = schemaAsserts(sessionDetailResponseSchema);
  const loot = {
    id: 17,
    occurredAt: '2026-11-08T19:42:13.512Z',
    source: { type: 'NPC', name: 'Vorkath' },
    killCount: 412,
    geValue: 2850000,
    haValue: 60000,
    items: [
      {
        itemId: 11286,
        name: 'Draconic visage',
        quantity: 1,
        gePriceEach: 2850000,
        haPriceEach: 60000,
      },
    ],
  };
  const valid = {
    session,
    neighbors: { olderId: '01933c3f-2222-7aaa-bbbb-ccccdddd0000', newerId: null },
    xp: [{ skill: 'SLAYER', xpGained: 100000, startLevel: 89, endLevel: 90 }],
    loot: [loot, { ...loot, id: 18, source: { type: 'PLAYER', name: null }, killCount: null }],
    kc: [
      { boss: 'Vorkath', startKillCount: 394, endKillCount: 412, gained: 18 },
      { boss: 'Zulrah', startKillCount: 1, endKillCount: 10, gained: 9 },
    ],
    afkPeriods: [{ startedAt: '2026-11-08T19:10:00.000Z', endedAt: '2026-11-08T19:25:00.000Z' }],
    collectionLog: { obtained: 340, total: 1734, items: [] as unknown[] },
  };
  const clogItem = {
    itemId: 22111,
    name: 'Dragonbone necklace',
    tab: 'Bosses',
    page: 'Vorkath',
    pageObtained: 4,
    pageTotal: 7,
    at: '2026-11-08T19:42:13.512Z',
    approximate: false,
  };
  const withClog = (items: unknown[], count = items.length) => ({
    ...valid,
    session: { ...session, newCollectionLogCount: count },
    collectionLog: { obtained: 341, total: 1734, items },
  });

  it('accepts a session in detail', () => {
    response.accepts(valid);
  });

  it('accepts a session without neighbors at either end', () => {
    response.accepts({ ...valid, neighbors: { olderId: null, newerId: null } });
  });

  it('requires neighbors with session IDs', () => {
    const withoutNeighbors: Partial<typeof valid> = { ...valid };
    delete withoutNeighbors.neighbors;
    expect(response.issuePaths(withoutNeighbors)).toContain('neighbors');
    expect(
      response.issuePaths({ ...valid, neighbors: { olderId: 'nope', newerId: null } }),
    ).toContain('neighbors.olderId');
  });

  it('rejects PLAYER loot with a name', () => {
    response.rejects({
      ...valid,
      loot: [{ ...loot, source: { type: 'PLAYER', name: 'Test Main' } }],
    });
  });

  it('rejects loot without items', () => {
    expect(response.issuePaths({ ...valid, loot: [{ ...loot, items: [] }] })).toContain(
      'loot.0.items',
    );
  });

  it('rejects an AFK period that ends before it starts', () => {
    const afkPeriods = [
      { startedAt: '2026-11-08T19:25:00.000Z', endedAt: '2026-11-08T19:10:00.000Z' },
    ];
    expect(response.issuePaths({ ...valid, afkPeriods })).toContain('afkPeriods.0.endedAt');
  });

  it('accepts new collection log items, exact and approximate (1.39.0)', () => {
    response.accepts(
      withClog([
        clogItem,
        { ...clogItem, itemId: 21907, at: '2026-11-08T20:02:31.004Z', approximate: true },
      ]),
    );
  });

  it('requires as many collection log items as the session count', () => {
    expect(response.issuePaths(withClog([clogItem], 2))).toContain('collectionLog.items');
  });

  it('requires collection log items oldest first and each once', () => {
    const older = { ...clogItem, itemId: 21907, at: '2026-11-08T19:00:00.000Z' };
    expect(response.issuePaths(withClog([clogItem, older]))).toContain('collectionLog.items.1.at');
    expect(response.issuePaths(withClog([clogItem, clogItem]))).toContain('collectionLog.items.1');
  });

  it('rejects collection log items without a stored collection log', () => {
    const detail = withClog([clogItem]);
    expect(
      response.issuePaths({
        ...detail,
        collectionLog: { ...detail.collectionLog, obtained: null, total: null },
      }),
    ).toContain('collectionLog.items');
  });

  it('requires the collection log section', () => {
    const without: Partial<typeof valid> = { ...valid };
    delete without.collectionLog;
    expect(response.issuePaths(without)).toContain('collectionLog');
  });

  it('rejects endLevel below startLevel', () => {
    const xp = [{ skill: 'SLAYER', xpGained: 0, startLevel: 90, endLevel: 89 }];
    expect(response.issuePaths({ ...valid, xp })).toContain('xp.0.endLevel');
  });

  it('rejects KC gain that does not match start and end', () => {
    const kc = [{ boss: 'Vorkath', startKillCount: 394, endKillCount: 412, gained: 3 }];
    expect(response.issuePaths({ ...valid, kc })).toContain('kc.0.gained');
  });

  it('counts kills after the first observation of a new boss', () => {
    // Zulrah first seen at KC 1 in this session, ends at 10: 9 kills.
    const kc = [{ boss: 'Zulrah', startKillCount: 1, endKillCount: 10, gained: 9 }];
    response.accepts({ ...valid, kc });
  });

  it('requires a start KC', () => {
    const kc = [{ boss: 'Zulrah', startKillCount: null, endKillCount: 5, gained: 0 }];
    expect(response.issuePaths({ ...valid, kc })).toContain('kc.0.startKillCount');
  });

  it('rejects an end KC below the start KC', () => {
    const kc = [{ boss: 'Zulrah', startKillCount: 10, endKillCount: 5, gained: 0 }];
    expect(response.issuePaths({ ...valid, kc })).toContain('kc.0.gained');
  });
});

describe('calendar', () => {
  const query = schemaAsserts(calendarQuerySchema);
  const response = schemaAsserts(calendarResponseSchema);
  const day = {
    date: '2026-11-08',
    playedSeconds: 7200,
    activeSeconds: 6300,
    afkSeconds: 900,
    sessionCount: 2,
  };
  const year2026 = { year: 2026, from: '2025-12-31T23:00:00.000Z', to: '2026-12-31T23:00:00.000Z' };
  const from = '2025-11-10T23:00:00.000Z';

  it('coerces the year and allows it to be omitted', () => {
    expect(query.accepts({ year: '2026' })).toEqual({ year: 2026 });
    expect(query.accepts({})).toEqual({});
  });

  it.each(['1999', '26', 'this', '', '02026', '2026.0'])('rejects year %j', (year) => {
    expect(query.issuePaths({ year })).toContain('year');
  });

  it('accepts from/to up to 366 days', () => {
    const to = '2026-11-11T23:00:00.000Z'; // exactly 366 × 24 h
    expect(query.accepts({ from, to })).toEqual({ from, to });
    query.accepts({ from, to: '2025-11-10T23:00:00.001Z' });
  });

  it('rejects a range over 366 days', () => {
    expect(query.issuePaths({ from, to: '2026-11-11T23:00:00.001Z' })).toEqual(['to']);
  });

  it.each([
    ['to equal to from', from],
    ['to before from', '2025-11-10T22:59:59.999Z'],
  ])('rejects %s', (_name, to) => {
    expect(query.issuePaths({ from, to })).toEqual(['to']);
  });

  it('requires from and to together', () => {
    expect(query.issuePaths({ from })).toEqual(['to']);
    expect(query.issuePaths({ to: from })).toEqual(['from']);
  });

  it('rejects year combined with from/to', () => {
    const to = '2026-01-01T00:00:00.000Z';
    expect(query.issuePaths({ year: '2026', from, to })).toEqual(['year']);
    expect(query.issuePaths({ year: '2026', from })).toEqual(['year']);
  });

  it.each(['2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000+01:00'])(
    'rejects from %j that is not UTC with milliseconds',
    (value) => {
      expect(query.issuePaths({ from: value, to: '2026-02-01T00:00:00.000Z' })).toContain('from');
    },
  );

  it('accepts days with play time', () => {
    response.accepts({ ...year2026, days: [day] });
  });

  it('accepts a from/to range across years without a year', () => {
    const lastYear = { ...day, date: '2025-12-31' };
    response.accepts({ year: null, from, to: year2026.to, days: [lastYear, day] });
  });

  it('rejects a day outside the year', () => {
    expect(response.issuePaths({ ...year2026, year: 2025, days: [day] })).toContain('days.0.date');
  });

  it('rejects to that is not after from', () => {
    expect(response.issuePaths({ year: null, from, to: from, days: [] })).toContain('to');
  });

  it('requires from and to', () => {
    response.rejects({ year: 2026, days: [day] });
  });

  it('rejects active + AFK that does not add up', () => {
    expect(response.issuePaths({ ...year2026, days: [{ ...day, afkSeconds: 0 }] })).toContain(
      'days.0.playedSeconds',
    );
  });
});
