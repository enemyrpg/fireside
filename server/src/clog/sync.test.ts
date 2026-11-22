import { collectionLogResponseSchema } from '@fireside/shared';
import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { rebuildDerivedTables } from '../admin/rebuild.js';
import {
  accountClogSources,
  accountNames,
  accounts,
  clogObtained,
  clogReads,
  externalSnapshots,
  externalSources,
} from '../db/schema.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  TEST_ACCOUNT_HASH,
  type TestRun,
} from '../projections/testing.js';
import { collectionLog } from '../read/collection-log.js';
import { testConfig } from '../test-utils.js';
import { clogTablesSnapshot, rebuildClog } from './project.js';
import { contentHash } from './runeprofile.js';
import type { ClogProvider } from './provider.js';
import { clogSourceRow, createClogSyncer, MIN_SYNC_INTERVAL_MS, setClogSource } from './sync.js';
import { isSyncDue } from '../jobs/clog.js';
import {
  clogBody,
  feedBody,
  RUNEPROFILE_ON,
  summaryBody,
  testClock,
  testSyncer,
} from './testing.js';

// The sync of one account against a scripted RuneProfile: what is requested,
// what is stored unchanged, and what the derived tables and the read API show.

const START = '2026-11-09T12:00:00.000Z';
/** When the test account was first seen with its name (the `session.start` below). */
const NAME_SINCE = '2026-11-08T19:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const BASE = '/v1/accounts/Seed%20Main';

let run: TestRun | undefined;
afterEach(() => {
  run?.database.close();
  run = undefined;
});

interface SetupOptions {
  env?: Record<string, string>;
  displayName?: string;
  optIn?: boolean;
  waitsMoveClock?: boolean;
}

function setup({
  env = RUNEPROFILE_ON,
  displayName = 'Seed Main',
  optIn = true,
  waitsMoveClock = false,
}: SetupOptions = {}) {
  run = emptyRun();
  const f = eventFactory();
  ingestBatch(run, [f.sessionStart('19:00', { displayName }), f.sessionEnd('19:30')]);
  const db = run.database.db;
  const accountId =
    db.select().from(accounts).where(eq(accounts.accountHash, TEST_ACCOUNT_HASH)).get()?.id ?? 0;
  const clock = testClock(START);
  if (optIn) setClogSource(db, accountId, 'RUNEPROFILE', clock.now());
  const harness = testSyncer(db, testConfig(env), clock, { waitsMoveClock });
  // A profile uploaded after the account got its name, with one pet and three whips.
  harness.replies.summary = summaryBody('2026-11-09T08:00:00.000Z');
  harness.replies.collectionLog = clogBody({ 13262: 1, 4151: 3 });
  return {
    ...harness,
    db,
    accountId,
    clock,
    f,
    sync: () => harness.syncer.sync(accountId),
    row: () => clogSourceRow(db, accountId),
    raw: () => db.select().from(externalSnapshots).orderBy(asc(externalSnapshots.id)).all(),
    /** Times of the recorded reads. */
    reads: () =>
      db
        .select({ at: clogReads.readAt })
        .from(clogReads)
        .orderBy(asc(clogReads.readAt))
        .all()
        .map((row) => row.at),
    paths: () => harness.requests.map((request) => request.path),
    /** The read API's answer, checked against the contract. */
    read: () =>
      collectionLogResponseSchema.parse(
        collectionLog(db, accountId, {
          sourceActive: harness.syncer.sourceActive(),
          syncing: harness.syncer.isSyncing(accountId),
          nowMs: clock.now().getTime(),
        }),
      ),
    firstSeen: () =>
      Object.fromEntries(
        db
          .select()
          .from(clogObtained)
          .orderBy(asc(clogObtained.itemId))
          .all()
          .map((item) => [item.itemId, [item.firstSeenAt, item.approximate]]),
      ),
  };
}

const feedQuery = (extra = '') =>
  `${BASE}/activities?activityTypes=new_item_obtained&limit=50${extra}`;

describe('who is looked up', () => {
  it('never looks up an account the owner has not turned the source on for', async () => {
    const t = setup({ optIn: false });
    expect(await t.sync()).toEqual({ started: false, reason: 'NO_SOURCE' });
    expect(t.requests).toEqual([]);
    expect(t.read()).toMatchObject({ source: null, sync: null, tabs: [] });
  });

  it.each([
    ['the flag is off', { USER_AGENT_CONTACT: 'you@example.com' }],
    ['there is no contact', { RUNEPROFILE_ENABLED: 'true' }],
  ])('makes no request when %s', async (_name, env) => {
    const t = setup({ env });
    expect(await t.sync()).toEqual({ started: false, reason: 'SOURCE_OFF' });
    expect(t.requests).toEqual([]);
    expect(t.read().sync).toMatchObject({ status: 'SOURCE_OFF', lastAttemptAt: null });
  });

  it('uses the current name from our own name history, URL-encoded', async () => {
    const t = setup();
    ingestBatch(run!, [t.f.sessionStart('21:00', { displayName: 'New\u00a0Name-1' })]); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by setup()
    await t.sync();
    expect(t.paths()).toEqual([
      '/v1/accounts/New%20Name-1',
      '/v1/accounts/New%20Name-1/collection-log',
      '/v1/accounts/New%20Name-1/activities?activityTypes=new_item_obtained&limit=50',
    ]);
  });

  it('makes no request for an account without a usable name', async () => {
    const t = setup({ displayName: 'Thirteen chars' });
    expect(await t.sync()).toEqual({ started: true });
    expect(t.requests).toEqual([]);
    expect(t.read().sync?.status).toBe('NO_NAME');
  });

  it('sends the User-Agent with the contact, and X-API-Key only when a key is set', async () => {
    const without = setup();
    await without.sync();
    expect(Object.keys(without.requests[0]?.headers ?? {}).sort()).toEqual([
      'Accept',
      'User-Agent',
    ]);
    expect(without.requests[0]?.headers['User-Agent']).toContain('(+you@example.com)');
    run?.database.close();

    const withKey = setup({ env: { ...RUNEPROFILE_ON, RUNEPROFILE_API_KEY: 'rp_secret-key' } });
    await withKey.sync();
    expect(withKey.requests).toHaveLength(3);
    for (const request of withKey.requests) {
      expect(request.headers['X-API-Key']).toBe('rp_secret-key');
    }
    // The key never reaches the logs.
    expect(JSON.stringify(withKey.logs)).not.toContain('rp_secret-key');
  });
});

describe('the first sync', () => {
  it('stores the response unchanged and gives items that were already there no date', async () => {
    const t = setup();
    expect(await t.sync()).toEqual({ started: true });
    // Guard, collection log, then the feed's history (no `from`).
    expect(t.paths()).toEqual([BASE, `${BASE}/collection-log`, feedQuery()]);

    const body = clogBody({ 13262: 1, 4151: 3 });
    expect(t.raw()).toEqual([
      {
        id: 1,
        source: 'RUNEPROFILE',
        kind: 'COLLECTION_LOG',
        accountId: t.accountId,
        fetchedAt: START,
        contentHash: contentHash(body),
        body,
      },
    ]);
    // The name that was looked up is not in the raw data.
    expect(JSON.stringify(t.raw())).not.toContain('Seed Main');

    const log = t.read();
    expect(log).toMatchObject({
      source: 'RUNEPROFILE',
      updatedAt: START,
      // Unique items: the pet is on two pages and counts once.
      obtained: 2,
      total: 5,
      sync: { status: 'OK', lastAttemptAt: START, lastSuccessAt: START, lastChangedAt: START },
    });
    expect(log.tabs.map((tab) => [tab.name, tab.pages.map((page) => page.name)])).toEqual([
      ['Bosses', ['Abyssal Sire', 'Vorkath']],
      ['Other', ['All Pets']],
    ]);
    expect(log.tabs[0]?.pages[0]).toEqual({
      name: 'Abyssal Sire',
      obtained: 2,
      total: 3,
      items: [
        {
          itemId: 13262,
          name: 'Abyssal orphan',
          quantity: 1,
          obtained: true,
          firstSeenAt: null,
          approximate: false,
        },
        {
          itemId: 13277,
          name: 'Jar of miasma',
          quantity: 0,
          obtained: false,
          firstSeenAt: null,
          approximate: false,
        },
        {
          itemId: 4151,
          name: 'Abyssal whip',
          quantity: 3,
          obtained: true,
          firstSeenAt: null,
          approximate: false,
        },
      ],
    });
    // The page counts count the pet again.
    expect(log.tabs[1]?.pages[0]).toMatchObject({ obtained: 1, total: 2 });
  });

  it('dates first-sync items the activity feed knows about', async () => {
    const t = setup();
    t.replies.activities = feedBody([[13262, '2026-03-01 10:15:30.123456+00']]);
    await t.sync();
    expect(t.firstSeen()).toEqual({
      4151: [null, false],
      13262: ['2026-03-01T10:15:30.123Z', false],
    });
    expect(t.raw().map((row) => row.kind)).toEqual(['COLLECTION_LOG', 'ACTIVITIES']);
    expect(t.raw()[1]?.body).toBe(feedBody([[13262, '2026-03-01 10:15:30.123456+00']]));
  });

  it('reads at most 20 feed pages', async () => {
    const t = setup({ waitsMoveClock: true });
    let page = 0;
    t.replies.activities = () => {
      page++;
      return feedBody(
        [[13262, `2026-03-01T10:00:${String(60 - page).padStart(2, '0')}.000Z`]],
        `c${String(page)}`,
      );
    };
    await t.sync();
    const feedRequests = t.paths().filter((path) => path.includes('/activities'));
    expect(feedRequests).toHaveLength(20);
    expect(feedRequests[1]).toBe(feedQuery('&cursor=c1'));
    expect(t.raw().filter((row) => row.kind === 'ACTIVITIES')).toHaveLength(20);
    // The earliest time in the feed wins.
    expect(t.firstSeen()[13262]).toEqual(['2026-03-01T10:00:40.000Z', false]);
    // 22 requests, never closer than 3 s: well inside 30 a minute.
    const times = t.requests.map((request) => Date.parse(request.at));
    expect(Math.min(...times.slice(1).map((time, index) => time - (times[index] ?? 0)))).toBe(3000);
  });
});

describe('later syncs', () => {
  it('stores nothing and reads no feed when the content is unchanged', async () => {
    const t = setup();
    await t.sync();
    t.requests.length = 0;
    t.clock.advance(HOUR);
    expect(await t.sync()).toEqual({ started: true });
    // One request: no guard (same name period), no feed.
    expect(t.paths()).toEqual([`${BASE}/collection-log`]);
    expect(t.raw()).toHaveLength(1);
    expect(t.read()).toMatchObject({
      updatedAt: START,
      sync: {
        status: 'OK',
        lastSuccessAt: '2026-11-09T13:00:00.000Z',
        lastChangedAt: START,
      },
    });
  });

  it('records every successful read, also an unchanged one', async () => {
    const t = setup();
    await t.sync();
    t.clock.advance(HOUR);
    await t.sync();
    // Both reads, the second not stored as a snapshot.
    expect(t.raw()).toHaveLength(1);
    expect(t.reads()).toEqual([START, '2026-11-09T13:00:00.000Z']);
    expect(
      t.db
        .select()
        .from(clogReads)
        .all()
        .every((row) => row.accountId === t.accountId),
    ).toBe(true);
  });

  it('keeps a new snapshot when the content changed, and dates the new items', async () => {
    const t = setup();
    await t.sync();
    t.requests.length = 0;
    t.clock.advance(HOUR);
    // Two new items. The feed has only one of them.
    t.replies.collectionLog = clogBody({ 13262: 1, 4151: 4, 21992: 1, 22006: 1 });
    t.replies.activities = feedBody([[21992, '2026-11-09T12:40:00.000Z']]);
    await t.sync();

    // The feed is read from ten minutes before the previous read.
    expect(t.paths()).toEqual([
      `${BASE}/collection-log`,
      feedQuery(`&from=${encodeURIComponent('2026-11-09T11:50:00.000Z')}`),
    ]);
    expect(t.raw().map((row) => [row.kind, row.fetchedAt])).toEqual([
      ['COLLECTION_LOG', START],
      ['COLLECTION_LOG', '2026-11-09T13:00:00.000Z'],
      ['ACTIVITIES', '2026-11-09T13:00:00.000Z'],
    ]);
    expect(t.firstSeen()).toEqual({
      4151: [null, false],
      13262: [null, false],
      // From the feed: exact.
      21992: ['2026-11-09T12:40:00.000Z', false],
      // Not in the feed: the sync's time, approximate.
      22006: ['2026-11-09T13:00:00.000Z', true],
    });
    const log = t.read();
    expect(log).toMatchObject({ obtained: 4, total: 5, updatedAt: '2026-11-09T13:00:00.000Z' });
    expect(log.sync?.lastChangedAt).toBe('2026-11-09T13:00:00.000Z');
    // The pet has the same time on both of its pages.
    expect(log.tabs[1]?.pages[0]?.items[1]).toMatchObject({
      itemId: 21992,
      firstSeenAt: '2026-11-09T12:40:00.000Z',
      approximate: false,
    });
    expect(log.tabs[0]?.pages[0]?.items[2]?.quantity).toBe(4);
  });

  it('replaces an approximate time when the feed has the item later', async () => {
    const t = setup();
    await t.sync();
    t.clock.advance(HOUR);
    t.replies.collectionLog = clogBody({ 13262: 1, 4151: 3, 22006: 1 });
    await t.sync();
    expect(t.firstSeen()[22006]).toEqual(['2026-11-09T13:00:00.000Z', true]);

    t.clock.advance(HOUR);
    t.replies.collectionLog = clogBody({ 13262: 1, 4151: 5, 22006: 1 });
    t.replies.activities = feedBody([[22006, '2026-11-09T12:55:00.000Z']]);
    await t.sync();
    expect(t.firstSeen()[22006]).toEqual(['2026-11-09T12:55:00.000Z', false]);
  });

  it('keeps the first-seen time of an item whose quantity goes back to 0', async () => {
    const t = setup();
    await t.sync();
    t.clock.advance(HOUR);
    t.replies.collectionLog = clogBody({ 13262: 1, 4151: 3, 22006: 1 });
    await t.sync();
    t.clock.advance(HOUR);
    t.replies.collectionLog = clogBody({ 13262: 1, 4151: 3 });
    await t.sync();
    expect(t.firstSeen()[22006]).toEqual(['2026-11-09T13:00:00.000Z', true]);
    const visage = t.read().tabs[0]?.pages[1]?.items[1];
    expect(visage).toMatchObject({ itemId: 22006, obtained: false, firstSeenAt: null });
  });

  it('stores an item it has never heard of and shows it by name', async () => {
    const t = setup();
    t.replies.collectionLog = clogBody(
      { 13262: 1 },
      { extraItems: [{ id: 99_999, name: 'Unknown', quantity: 2 }] },
    );
    await t.sync();
    expect(t.read().tabs[0]?.pages[1]?.items[2]).toMatchObject({
      itemId: 99_999,
      name: 'Unknown',
      quantity: 2,
      obtained: true,
    });
  });

  it('keeps the collection log when the feed fails, and reads the feed at the next sync', async () => {
    const t = setup();
    t.replies.activities = 500;
    await t.sync();
    expect(t.raw().map((row) => row.kind)).toEqual(['COLLECTION_LOG']);
    expect(t.read()).toMatchObject({ obtained: 2, sync: { status: 'OK' } });
    expect(t.db.select().from(externalSources).get()?.lastError).toMatch(/HTTP 5xx/);

    t.requests.length = 0;
    t.clock.advance(HOUR);
    t.replies.activities = feedBody([[4151, '2026-02-02T02:02:02.000Z']]);
    await t.sync();
    // Unchanged content, but the feed's history is still owed.
    expect(t.paths()).toEqual([`${BASE}/collection-log`, feedQuery()]);
    expect(t.firstSeen()[4151]).toEqual(['2026-02-02T02:02:02.000Z', false]);
    expect(t.db.select().from(externalSources).get()?.lastError).toBeNull();
  });
});

describe('the name guard', () => {
  it('refuses a profile last updated before this server saw the name, and stores nothing', async () => {
    const t = setup();
    // The profile under this name was last uploaded before the account was
    // seen with it: the owner's own old upload, or the name's previous owner.
    t.replies.summary = summaryBody('2026-11-08T18:59:59.999Z');
    await t.sync();
    expect(t.paths()).toEqual([BASE]);
    expect(t.raw()).toEqual([]);
    expect(t.read()).toMatchObject({
      updatedAt: null,
      tabs: [],
      sync: { status: 'PROFILE_FROM_BEFORE_NAME', lastAttemptAt: START, lastSuccessAt: null },
    });

    // The owner logs in with the RuneProfile plugin on, it uploads, and "Sync now" works.
    t.requests.length = 0;
    t.clock.advance(5 * 60_000);
    t.replies.summary = summaryBody(NAME_SINCE);
    await t.sync();
    expect(t.paths()).toEqual([BASE, `${BASE}/collection-log`, feedQuery()]);
    expect(t.read()).toMatchObject({ obtained: 2, sync: { status: 'OK' } });
  });

  it('runs again after a name change, with the new name only', async () => {
    const t = setup();
    await t.sync();
    t.requests.length = 0;
    t.clock.advance(HOUR);
    ingestBatch(run!, [t.f.sessionStart('2026-11-09T12:30:00.000Z', { displayName: 'Renamed' })]); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by setup()
    // RuneProfile still has the profile under the old name only.
    t.replies.summary = 404;
    await t.sync();
    expect(t.paths()).toEqual(['/v1/accounts/Renamed']);
    expect(t.read()).toMatchObject({
      // The collection log from before the rename stays.
      obtained: 2,
      sync: { status: 'PROFILE_NOT_FOUND', lastSuccessAt: START },
    });

    // Someone else's old profile under the new name is refused.
    t.clock.advance(HOUR);
    t.replies.summary = summaryBody('2026-06-01T00:00:00.000Z');
    t.replies.collectionLog = clogBody({ 22006: 9 });
    await t.sync();
    expect(t.read()).toMatchObject({ obtained: 2, sync: { status: 'PROFILE_FROM_BEFORE_NAME' } });
    expect(t.raw()).toHaveLength(1);
  });
});

describe('failures', () => {
  it.each([
    ['no profile with that name', 404, 'PROFILE_NOT_FOUND', 1, false],
    ['a refused API key', 401, 'INVALID_API_KEY', 1, true],
    ['too many requests', 429, 'RATE_LIMITED', 3, true],
    ['a server error', 503, 'UNAVAILABLE', 3, true],
    ['a network error', new TypeError('fetch failed'), 'UNAVAILABLE', 3, true],
    [
      'a timeout',
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      'UNAVAILABLE',
      3,
      true,
    ],
    ['a body that is not JSON', '<html>maintenance</html>', 'INVALID_RESPONSE', 1, true],
    ['another JSON shape', JSON.stringify({ tabs: [] }), 'INVALID_RESPONSE', 1, true],
    [
      'a new field on an item',
      clogBody(
        {},
        { extraItems: [{ id: 5, name: 'Five', quantity: 1, obtainedAt: 'x' } as never] },
      ),
      'INVALID_RESPONSE',
      1,
      true,
    ],
    ['a body over the size limit', 'x'.repeat(5 * 1024 * 1024 + 1), 'INVALID_RESPONSE', 1, true],
  ])(
    '%s gives a status, never an exception',
    async (_name, reply, status, attempts, sourceError) => {
      const t = setup();
      t.replies.collectionLog = reply;
      expect(await t.sync()).toEqual({ started: true });
      expect(t.paths().filter((path) => path.endsWith('/collection-log'))).toHaveLength(attempts);
      expect(t.raw()).toEqual([]);
      // A failed read is not a read: it ties nothing.
      expect(t.reads()).toEqual([]);
      expect(t.read()).toMatchObject({ tabs: [], sync: { status, lastAttemptAt: START } });
      // Settings → Server shows failures of the source itself, with a fixed text.
      const source = t.db.select().from(externalSources).get();
      expect(source?.lastError !== null).toBe(sourceError);
      expect(JSON.stringify(source)).not.toContain('maintenance');
    },
  );

  it('keeps the last good collection log after a failure', async () => {
    const t = setup();
    await t.sync();
    t.clock.advance(HOUR);
    t.replies.collectionLog = 503;
    await t.sync();
    expect(t.read()).toMatchObject({
      obtained: 2,
      updatedAt: START,
      sync: { status: 'UNAVAILABLE', lastSuccessAt: START },
    });
  });
});

describe('what is logged for a response in another format', () => {
  const SECRET = 'response-secret';

  it('logs the source, the endpoint and each problem by path and code, never a value', async () => {
    const t = setup();
    const log = JSON.parse(clogBody({ 13262: 1 })) as {
      tabs: { pages: { name: unknown; items: Record<string, unknown>[] }[] }[];
    };
    const page = log.tabs[0]?.pages[1];
    if (!page?.items[0]) throw new Error('Expected the Vorkath page');
    page.name = { nested: SECRET };
    page.items[0].id = SECRET;
    page.items[0].name = SECRET;
    page.items[0][SECRET] = SECRET;
    t.replies.collectionLog = JSON.stringify(log);
    await t.sync();

    expect(t.read().sync?.status).toBe('INVALID_RESPONSE');
    expect(t.logs.filter((entry) => entry.msg.includes('unexpected format'))).toEqual([
      {
        level: 'warn',
        msg: 'A collection log response had an unexpected format',
        obj: {
          accountId: t.accountId,
          source: 'RUNEPROFILE',
          endpoint: 'COLLECTION_LOG',
          issues: [
            'tabs.0.pages.1.name: invalid_type',
            'tabs.0.pages.1.items.0.id: invalid_type',
            'tabs.0.pages.1.items.0: unrecognized_keys',
          ],
        },
      },
    ]);
    // Nothing from the response is in any log line, the body included.
    const output = JSON.stringify(t.logs);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('Abyssal');
    expect(output).not.toContain('Seed Main');
  });

  it('logs the feed and the summary by their own endpoint', async () => {
    const t = setup();
    t.replies.activities = JSON.stringify({ activities: [{ type: SECRET }], [SECRET]: 1 });
    await t.sync();
    // The collection log is good, so the sync is: only the feed is logged.
    expect(t.read().sync?.status).toBe('OK');
    const feed = t.logs.find((entry) => entry.msg.includes('unexpected format'));
    expect(feed?.obj).toMatchObject({ source: 'RUNEPROFILE', endpoint: 'ACTIVITIES' });
    expect((feed?.obj as { issues: string[] }).issues).toContain(
      'activities.0.type: invalid_value',
    );
    run?.database.close();

    const other = setup();
    other.replies.summary = JSON.stringify({ updatedAt: SECRET, username: SECRET });
    await other.sync();
    expect(other.read().sync?.status).toBe('INVALID_RESPONSE');
    expect(other.logs.find((entry) => entry.msg.includes('unexpected format'))?.obj).toMatchObject({
      endpoint: 'SUMMARY',
      issues: ['updatedAt: invalid_format'],
    });
    expect(JSON.stringify([t.logs, other.logs])).not.toContain(SECRET);
  });

  it('does not log format problems for a failure that is not about the format', async () => {
    const t = setup();
    t.replies.collectionLog = 404;
    await t.sync();
    expect(t.logs.some((entry) => entry.msg.includes('unexpected format'))).toBe(false);
  });
});

describe('turning the source off and on', () => {
  it('keeps the minute limit, the feed and the name guard', async () => {
    const t = setup();
    await t.sync();
    t.requests.length = 0;

    // Off and on again within the minute: no way around the limit.
    t.clock.advance(10_000);
    setClogSource(t.db, t.accountId, null, t.clock.now());
    expect(t.row()).toBeNull();
    t.clock.advance(10_000);
    setClogSource(t.db, t.accountId, 'RUNEPROFILE', t.clock.now());
    expect(await t.sync()).toMatchObject({ started: false, reason: 'TOO_SOON' });
    expect(t.requests).toEqual([]);
    expect(t.row()).toMatchObject({
      enabledAt: '2026-11-09T12:00:20.000Z',
      lastAttemptAt: START,
      lastSuccessAt: START,
      status: 'OK',
    });

    // After the minute: one request. No guard again, no feed history again.
    t.clock.advance(HOUR);
    await t.sync();
    expect(t.paths()).toEqual([`${BASE}/collection-log`]);
    expect(t.raw()).toHaveLength(1);
  });

  it('changes nothing when it is turned on while it already is', async () => {
    const t = setup();
    await t.sync();
    const before = t.row();
    t.clock.advance(HOUR);
    setClogSource(t.db, t.accountId, 'RUNEPROFILE', t.clock.now());
    expect(t.row()).toEqual(before);
  });

  it('never looks up an account whose source is off', async () => {
    const t = setup();
    await t.sync();
    t.requests.length = 0;
    setClogSource(t.db, t.accountId, null, t.clock.now());
    t.clock.advance(7 * HOUR);
    expect(await t.sync()).toEqual({ started: false, reason: 'NO_SOURCE' });
    expect(t.requests).toEqual([]);
  });

  it('discards a sync that was started before the source was turned off and on again', async () => {
    const t = setup();
    await t.sync();
    t.clock.advance(HOUR);
    const settings = t.row();

    let release: (response: Response) => void = () => undefined;
    t.replies.collectionLog = () => new Promise<Response>((resolve) => (release = resolve));
    expect(t.syncer.start(t.accountId)).toEqual({ started: true });
    await Promise.resolve();
    // Off and on while the request is out: a new opt-in.
    setClogSource(t.db, t.accountId, null, t.clock.now());
    t.clock.advance(1000);
    setClogSource(t.db, t.accountId, 'RUNEPROFILE', t.clock.now());
    expect(t.syncer.start(t.accountId)).toEqual({ started: false, reason: 'RUNNING' });

    release(new Response(clogBody({ 13262: 1, 4151: 3, 22006: 1 })));
    await t.syncer.idle();
    // The old sync stored nothing and left the state as it was, apart from its attempt.
    expect(t.raw()).toHaveLength(1);
    expect(t.read()).toMatchObject({ obtained: 2, sync: { status: 'OK', lastSuccessAt: START } });
    expect(t.row()).toEqual({
      ...settings,
      enabledAt: '2026-11-09T13:00:01.000Z',
      lastAttemptAt: '2026-11-09T13:00:00.000Z',
    });

    // The job sees that nothing has been tried since the source was turned on.
    const row = t.row();
    expect(row && isSyncDue(t.db, row, t.clock.now().getTime())).toBe(true);
    t.clock.advance(MIN_SYNC_INTERVAL_MS);
    t.replies.collectionLog = clogBody({ 13262: 1, 4151: 3, 22006: 1 });
    await t.sync();
    expect(t.read()).toMatchObject({ obtained: 3, sync: { status: 'OK' } });
    const after = t.row();
    expect(after && isSyncDue(t.db, after, t.clock.now().getTime())).toBe(false);
  });
});

describe('when something else goes wrong', () => {
  it('refuses to look up an account with no record of when its name was first seen', async () => {
    const t = setup();
    // The guard has nothing to compare with: it must refuse, not be skipped.
    t.db.delete(accountNames).run();
    expect(await t.sync()).toEqual({ started: true });
    expect(t.requests).toEqual([]);
    expect(t.raw()).toEqual([]);
    expect(t.read().sync).toMatchObject({ status: 'NO_NAME', lastAttemptAt: START });
  });

  it('shows an unexpected error on the account and on the source', async () => {
    const t = setup();
    const errors: string[] = [];
    const provider: ClogProvider = {
      source: 'RUNEPROFILE',
      fetch: () => Promise.reject(new TypeError('a bug with response-secret in it')),
    };
    const syncer = createClogSyncer({
      db: t.db,
      config: testConfig(RUNEPROFILE_ON),
      provider,
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: (_obj, msg) => void errors.push(msg),
      },
      now: t.clock.now,
    });
    expect(await syncer.sync(t.accountId)).toEqual({ started: true });
    expect(errors).toEqual(['Collection log sync failed unexpectedly']);
    expect(clogSourceRow(t.db, t.accountId)).toMatchObject({
      status: 'UNAVAILABLE',
      lastAttemptAt: START,
    });
    // Settings → Server does not show the source as fine, and shows a fixed text.
    expect(t.db.select().from(externalSources).get()).toMatchObject({
      source: 'RUNEPROFILE',
      lastError: 'Unexpected error, see the server log',
      lastErrorAt: START,
      lastSuccessAt: null,
    });
  });
});

describe('shutdown', () => {
  it('does not wait for a slow source, makes no further request and stores nothing', async () => {
    const t = setup();
    let release: (response: Response) => void = () => undefined;
    t.replies.summary = () => new Promise<Response>((resolve) => (release = resolve));
    expect(t.syncer.start(t.accountId)).toEqual({ started: true });
    await Promise.resolve();

    // The request is still out: shutdown gives up waiting after its limit.
    const before = Date.now();
    await t.syncer.shutdown(20);
    expect(Date.now() - before).toBeLessThan(2000);
    expect(t.syncer.isSyncing(t.accountId)).toBe(true);
    const settings = t.row();

    // The answer arrives after the server has stopped.
    release(new Response(summaryBody('2026-11-09T08:00:00.000Z')));
    await t.syncer.idle();
    expect(t.paths()).toEqual([BASE]);
    expect(t.raw()).toEqual([]);
    expect(t.row()).toEqual(settings);
    expect(t.logs.filter((entry) => entry.level === 'error')).toEqual([]);

    // And nothing new starts.
    t.clock.advance(HOUR);
    expect(t.syncer.start(t.accountId).started).toBe(false);
    expect(t.paths()).toEqual([BASE]);
  });

  it('returns at once when nothing is running', async () => {
    const t = setup();
    const before = Date.now();
    await t.syncer.shutdown();
    expect(Date.now() - before).toBeLessThan(500);
  });

  it('stops between two requests of a long feed read', async () => {
    const t = setup();
    let pages = 0;
    t.replies.activities = () => {
      pages++;
      if (pages === 2) void t.syncer.shutdown(0);
      return feedBody(
        [[13262, `2026-03-01T10:00:${String(60 - pages)}.000Z`]],
        `c${String(pages)}`,
      );
    };
    await t.sync();
    expect(pages).toBe(2);
    expect(t.raw()).toEqual([]);
  });
});

describe('limits', () => {
  it('syncs an account at most once a minute', async () => {
    const t = setup();
    await t.sync();
    t.requests.length = 0;
    const first = Date.parse(START);
    t.clock.set(new Date(first + MIN_SYNC_INTERVAL_MS - 1).toISOString());
    expect(await t.sync()).toEqual({
      started: false,
      reason: 'TOO_SOON',
      retryAt: new Date(first + MIN_SYNC_INTERVAL_MS),
    });
    expect(t.requests).toEqual([]);
    expect(t.read().sync?.nextSyncAllowedAt).toBe('2026-11-09T12:01:00.000Z');

    t.clock.advance(1);
    expect(await t.sync()).toEqual({ started: true });
    expect(t.requests).toHaveLength(1);
  });

  it('runs one sync per account at a time and shows it as SYNCING', async () => {
    const t = setup();
    let release: (response: Response) => void = () => undefined;
    t.replies.summary = () => new Promise<Response>((resolve) => (release = resolve));
    expect(t.syncer.start(t.accountId)).toEqual({ started: true });
    expect(t.syncer.start(t.accountId)).toEqual({ started: false, reason: 'RUNNING' });
    await Promise.resolve();
    expect(t.read().sync?.status).toBe('SYNCING');
    release(new Response(summaryBody('2026-11-09T08:00:00.000Z')));
    await t.syncer.idle();
    expect(t.read().sync?.status).toBe('OK');
    expect(t.paths().filter((path) => path === BASE)).toHaveLength(1);
  });

  it('stores nothing when the source is turned off while a request is out', async () => {
    const t = setup();
    t.replies.collectionLog = () => {
      setClogSource(t.db, t.accountId, null, t.clock.now());
      return clogBody({ 13262: 1 });
    };
    await t.sync();
    expect(t.raw()).toEqual([]);
    expect(t.reads()).toEqual([]);
    expect(t.row()).toBeNull();
    expect(t.read()).toMatchObject({ source: null, sync: null, tabs: [] });
  });

  it('keeps the collection log when the source is turned off, and goes on from it when turned on again', async () => {
    const t = setup();
    await t.sync();
    setClogSource(t.db, t.accountId, null, t.clock.now());
    expect(t.read()).toMatchObject({ source: null, sync: null, obtained: 2 });
    t.clock.advance(HOUR);
    setClogSource(t.db, t.accountId, 'RUNEPROFILE', t.clock.now());
    t.replies.collectionLog = clogBody({ 13262: 1, 4151: 3, 22006: 1 });
    await t.sync();
    expect(t.raw().filter((row) => row.kind === 'COLLECTION_LOG')).toHaveLength(2);
    // Not a first sync: the new item is dated.
    expect(t.firstSeen()[22006]).toEqual(['2026-11-09T13:00:00.000Z', true]);
  });
});

describe('rebuild', () => {
  async function history() {
    const t = setup();
    t.replies.activities = feedBody([[13262, '2026-03-01T10:15:30.000Z']]);
    await t.sync();
    t.clock.advance(HOUR);
    t.replies.collectionLog = clogBody({ 13262: 1, 4151: 4, 21992: 1, 22006: 1 });
    t.replies.activities = feedBody([[21992, '2026-11-09T12:40:00.000Z']]);
    await t.sync();
    t.clock.advance(HOUR);
    t.replies.collectionLog = clogBody({ 13262: 1, 4151: 4, 21992: 2, 22006: 1 });
    t.replies.activities = feedBody([[22006, '2026-11-09T12:41:00.000Z']]);
    await t.sync();
    return t;
  }

  it('gives the same tables from the stored snapshots as the syncs did', async () => {
    const t = await history();
    const before = clogTablesSnapshot(t.db);
    expect(before.snapshots).toHaveLength(3);
    expect(before.obtained).toHaveLength(4);
    const raw = t.raw();
    const settings = t.row();

    expect(t.db.transaction((tx) => rebuildClog(tx))).toEqual({
      applied: raw.length,
      skipped: 0,
    });
    expect(clogTablesSnapshot(t.db)).toEqual(before);
    // Raw data and the owner's settings are not touched.
    expect(t.raw()).toEqual(raw);
    expect(t.row()).toEqual(settings);
  });

  it('is part of the full rebuild, which keeps raw snapshots and settings', async () => {
    const t = await history();
    const before = clogTablesSnapshot(t.db);
    const raw = t.raw();
    const settings = t.row();
    const response = t.read();

    const result = rebuildDerivedTables(t.db);
    expect(result.failed).toEqual([]);
    expect(clogTablesSnapshot(t.db)).toEqual(before);
    expect(t.raw()).toEqual(raw);
    expect(t.row()).toEqual(settings);
    expect(t.read()).toEqual(response);
  });

  it('skips a stored body it cannot read and keeps the raw row', async () => {
    const t = await history();
    t.db
      .update(externalSnapshots)
      .set({ body: '{"tabs":"?"}' })
      .where(eq(externalSnapshots.id, 1))
      .run();
    const warnings: object[] = [];
    // A row that cannot be read is not counted as applied.
    expect(
      t.db.transaction((tx) => rebuildClog(tx, { warn: (obj) => void warnings.push(obj) })),
    ).toEqual({ applied: 5, skipped: 1 });
    expect(warnings).toEqual([
      {
        snapshotId: 1,
        source: 'RUNEPROFILE',
        kind: 'COLLECTION_LOG',
        reason: 'RuneProfileFormatError',
      },
    ]);
    expect(t.raw()).toHaveLength(6);
    expect(clogTablesSnapshot(t.db).snapshots).toHaveLength(2);
    expect(t.db.select().from(accountClogSources).all()).toHaveLength(1);
  });
});
