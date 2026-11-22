import type { Event } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import {
  accountIds,
  accountNames,
  accounts,
  lootEvents,
  sessions,
  xpSnapshots,
} from '../db/schema.js';
import { rebuildProjections } from './framework.js';
import { accountsProjection } from './accounts.js';
import { PROJECTIONS } from './index.js';
import {
  eventFactory,
  expectOrderIndependent,
  failingFor,
  ownedBy,
  runIncremental,
  runRebuild,
  seededRandom,
  sessionIdOf,
  SECOND_USER_ID,
  snapshotDerived,
  TEST_ACCOUNT_HASH,
  TEST_NOW,
} from './testing.js';
import { FIRST_USER_ID } from '../users/users.js';

const OTHER_HASH = '-987654321';

function at(time: string): string {
  return `2026-11-08T${time}:00.000Z`;
}

/**
 * For the property test below. It takes 1–2 s here but 5 s or more on a slow
 * CI runner (GitHub's vary by 2×), where the default 5 s made it fail at random.
 */
const HEAVY = { timeout: 60_000 };

describe('accounts projection', () => {
  it('creates the account from any event type, before any session.start', () => {
    const f = eventFactory();
    const snapshot = expectOrderIndependent([f.heartbeat('19:00'), f.kc('19:05')]);
    expect(snapshot.accounts).toEqual({
      accounts: [
        {
          userId: FIRST_USER_ID,
          accountHash: TEST_ACCOUNT_HASH,
          accountType: null,
          displayName: null,
          firstSeenAt: at('19:00'),
          lastSeenAt: at('19:05'),
        },
      ],
      accountNames: [],
    });
  });

  it('fills in the name when the session.start arrives after other events', () => {
    const f = eventFactory();
    const heartbeat = f.heartbeat('19:01');
    const start = f.sessionStart('19:00');
    const run = runIncremental([heartbeat, start]);
    expect(run.database.db.select().from(accounts).all()).toEqual([
      {
        id: 1,
        userId: FIRST_USER_ID,
        accountHash: TEST_ACCOUNT_HASH,
        accountType: 'IRONMAN',
        displayName: 'Test Main',
        firstSeenAt: at('19:00'),
        lastSeenAt: at('19:01'),
      },
    ]);
  });

  it('takes seen times from min/max occurredAt over all events', () => {
    const f = eventFactory();
    const snapshot = expectOrderIndependent([
      f.sessionStart('18:00'),
      f.heartbeat('18:30'),
      f.sessionEnd('20:00'),
      f.kc('19:00'),
    ]);
    expect(snapshot.accounts).toMatchObject({
      accounts: [{ firstSeenAt: at('18:00'), lastSeenAt: at('20:00') }],
      accountNames: [
        { displayName: 'Test Main', firstSeenAt: at('18:00'), lastSeenAt: at('20:00') },
      ],
    });
  });

  it('gives a name change a new account_names row', () => {
    const f = eventFactory();
    const first = f.sessionStart('10:00', { displayName: 'Test Main' });
    const renamed = f.sessionStart('14:00', { displayName: 'Test Alt' });
    const snapshot = expectOrderIndependent([
      first,
      f.heartbeat('10:30'),
      f.sessionStart('12:00', { displayName: 'Test Main' }),
      f.heartbeat('12:30'),
      renamed,
      f.heartbeat('14:45'),
    ]);
    expect(snapshot.accounts).toEqual({
      accounts: [
        {
          userId: FIRST_USER_ID,
          accountHash: TEST_ACCOUNT_HASH,
          accountType: 'IRONMAN',
          displayName: 'Test Alt',
          firstSeenAt: at('10:00'),
          lastSeenAt: at('14:45'),
        },
      ],
      accountNames: [
        {
          userId: FIRST_USER_ID,
          accountHash: TEST_ACCOUNT_HASH,
          displayName: 'Test Main',
          firstSeenAt: at('10:00'),
          firstEventId: first.eventId,
          lastSeenAt: at('12:30'),
        },
        {
          userId: FIRST_USER_ID,
          accountHash: TEST_ACCOUNT_HASH,
          displayName: 'Test Alt',
          firstSeenAt: at('14:00'),
          firstEventId: renamed.eventId,
          lastSeenAt: at('14:45'),
        },
      ],
    });
  });

  it('gives a change back to an old name its own row (A → B → A)', () => {
    const f = eventFactory();
    const snapshot = expectOrderIndependent([
      f.sessionStart('10:00', { displayName: 'Alpha' }),
      f.sessionStart('11:00', { displayName: 'Beta' }),
      f.heartbeat('11:30'),
      f.sessionStart('12:00', { displayName: 'Alpha' }),
    ]);
    expect(snapshot.accounts).toMatchObject({
      accounts: [{ displayName: 'Alpha' }],
      accountNames: [
        { displayName: 'Alpha', firstSeenAt: at('10:00'), lastSeenAt: at('10:00') },
        { displayName: 'Beta', firstSeenAt: at('11:00'), lastSeenAt: at('11:30') },
        { displayName: 'Alpha', firstSeenAt: at('12:00'), lastSeenAt: at('12:00') },
      ],
    });
  });

  it('does not let a late event from before a name change overwrite the current name', () => {
    const f = eventFactory();
    const oldStart = f.sessionStart('10:00', { displayName: 'Old' });
    const oldHeartbeat = f.heartbeat('10:30');
    const newStart = f.sessionStart('12:00', { displayName: 'New' });

    // The old session arrives last, e.g. a queue retried after downtime.
    const run = runIncremental([newStart, oldHeartbeat, oldStart]);
    const db = run.database.db;
    expect(db.select().from(accounts).get()).toMatchObject({ displayName: 'New' });
    expect(
      db
        .select({
          displayName: accountNames.displayName,
          firstSeenAt: accountNames.firstSeenAt,
          lastSeenAt: accountNames.lastSeenAt,
        })
        .from(accountNames)
        .orderBy(accountNames.firstSeenAt)
        .all(),
    ).toEqual([
      { displayName: 'Old', firstSeenAt: at('10:00'), lastSeenAt: at('10:30') },
      { displayName: 'New', firstSeenAt: at('12:00'), lastSeenAt: at('12:00') },
    ]);
    expectOrderIndependent([oldStart, oldHeartbeat, newStart]);
  });

  it('splits a period when a late session.start with another name lands inside it', () => {
    const f = eventFactory();
    const snapshot = expectOrderIndependent([
      f.sessionStart('10:00', { displayName: 'Alpha' }),
      f.sessionStart('11:00', { displayName: 'Beta' }),
      f.sessionStart('12:00', { displayName: 'Alpha' }),
    ]);
    expect(snapshot.accounts).toMatchObject({
      accountNames: [{ displayName: 'Alpha' }, { displayName: 'Beta' }, { displayName: 'Alpha' }],
    });

    // Arrival: both Alphas first (one period), then the late Beta splits it.
    const g = eventFactory();
    const a1 = g.sessionStart('10:00', { displayName: 'Alpha' });
    const b = g.sessionStart('11:00', { displayName: 'Beta' });
    const a2 = g.sessionStart('12:00', { displayName: 'Alpha' });
    const run = runIncremental([a1, a2, b]);
    expect(run.database.db.select().from(accountNames).all()).toHaveLength(3);
  });

  it('takes the account type from the latest session.start (HCIM loses hardcore)', () => {
    const f = eventFactory();
    const snapshot = expectOrderIndependent([
      f.sessionStart('10:00', { accountType: 'HARDCORE_IRONMAN' }),
      f.sessionStart('12:00', { accountType: 'IRONMAN' }),
    ]);
    expect(snapshot.accounts).toMatchObject({
      accounts: [{ accountType: 'IRONMAN' }],
      // Same name throughout: one period.
      accountNames: [
        { displayName: 'Test Main', firstSeenAt: at('10:00'), lastSeenAt: at('12:00') },
      ],
    });
  });

  it('breaks ties on occurredAt by event ID', () => {
    const f = eventFactory();
    const snapshot = expectOrderIndependent([
      f.sessionStart('10:00', { displayName: 'First' }),
      f.sessionStart('10:00', { displayName: 'Second' }),
    ]);
    expect(snapshot.accounts).toMatchObject({
      accounts: [{ displayName: 'Second' }],
      accountNames: [
        { displayName: 'First', firstSeenAt: at('10:00'), lastSeenAt: at('10:00') },
        { displayName: 'Second', firstSeenAt: at('10:00'), lastSeenAt: at('10:00') },
      ],
    });
  });

  it('keeps accounts apart by hash, even with the same name', () => {
    const f = eventFactory();
    const snapshot = expectOrderIndependent([
      f.sessionStart('10:00', { displayName: 'Shared' }),
      f.sessionStart('10:05', { displayName: 'Shared', accountHash: OTHER_HASH }),
      f.heartbeat('10:10', { accountHash: OTHER_HASH }),
      f.sessionStart('11:00', { displayName: 'Main' }),
    ]);
    expect(snapshot.accounts).toMatchObject({
      accounts: [
        { accountHash: OTHER_HASH, displayName: 'Shared', lastSeenAt: at('10:10') },
        { accountHash: TEST_ACCOUNT_HASH, displayName: 'Main', lastSeenAt: at('11:00') },
      ],
      accountNames: [
        { accountHash: OTHER_HASH, displayName: 'Shared' },
        { accountHash: TEST_ACCOUNT_HASH, displayName: 'Shared' },
        { accountHash: TEST_ACCOUNT_HASH, displayName: 'Main' },
      ],
    });
  });

  it('handles a longer mixed history in any order', () => {
    const f = eventFactory();
    const events: Event[] = [];
    const names = ['Alpha', 'Alpha', 'Beta', 'Gamma', 'Gamma', 'Alpha', 'Beta'];
    names.forEach((displayName, day) => {
      const date = `2026-11-0${String(day + 1)}`;
      events.push(f.sessionStart(`${date}T18:00:00.000Z`, { displayName }));
      events.push(f.heartbeat(`${date}T18:01:00.000Z`));
      events.push(f.kc(`${date}T18:30:00.000Z`, { killCount: day + 1 }));
      events.push(
        f.sessionStart(`${date}T19:00:00.000Z`, { displayName, accountHash: OTHER_HASH }),
      );
    });
    const snapshot = expectOrderIndependent(events, { shuffles: 10, seed: 42 });
    expect(snapshot.accounts).toMatchObject({
      accounts: [{ displayName: 'Beta' }, { displayName: 'Beta' }],
    });
    const names1 = (
      snapshot.accounts as { accountNames: { accountHash: string; displayName: string }[] }
    ).accountNames
      .filter((row) => row.accountHash === TEST_ACCOUNT_HASH)
      .map((row) => row.displayName);
    expect(names1).toEqual(['Alpha', 'Beta', 'Gamma', 'Alpha', 'Beta']);
  });

  it('moves the start of the next period when a late session.start has its name', () => {
    const f = eventFactory();
    const lateBeta = f.sessionStart('11:00', { displayName: 'Beta' });
    const snapshot = expectOrderIndependent([
      f.sessionStart('10:00', { displayName: 'Alpha' }),
      f.heartbeat('10:30'),
      lateBeta,
      f.heartbeat('11:30'),
      f.sessionStart('12:00', { displayName: 'Beta' }),
    ]);
    expect(snapshot.accounts).toMatchObject({
      accountNames: [
        { displayName: 'Alpha', firstSeenAt: at('10:00'), lastSeenAt: at('10:30') },
        {
          displayName: 'Beta',
          firstSeenAt: at('11:00'),
          firstEventId: lateBeta.eventId,
          lastSeenAt: at('12:00'),
        },
      ],
    });
  });

  it('puts an event in the same millisecond as a rename by event ID order', () => {
    const f = eventFactory();
    // Created first, so its event ID sorts before the rename's.
    const heartbeat = f.heartbeat('12:00');
    const snapshot = expectOrderIndependent([
      f.sessionStart('10:00', { displayName: 'Old' }),
      heartbeat,
      f.sessionStart('12:00', { displayName: 'New' }),
    ]);
    expect(snapshot.accounts).toMatchObject({
      accountNames: [
        { displayName: 'Old', lastSeenAt: at('12:00') },
        { displayName: 'New', lastSeenAt: at('12:00') },
      ],
    });
  });

  it('puts the login xp.snapshot in the new name period when IDs are monotonic', () => {
    // The plugin sends monotonic UUIDv7 event IDs (see
    // docs/architecture.md#raw-events-and-projections), so the login session.start
    // sorts before the login xp.snapshot in the same millisecond. The factory's
    // counter gives the same order.
    const f = eventFactory();
    const login = { sessionId: sessionIdOf(2) };
    const renamed = f.sessionStart('12:00', { displayName: 'New', ...login });
    const loginSnapshot = f.xpSnapshot('12:00', {}, { reason: 'login', ...login });
    expect(renamed.eventId < loginSnapshot.eventId).toBe(true);

    const snapshot = expectOrderIndependent([
      f.sessionStart('10:00', { displayName: 'Old' }),
      f.heartbeat('10:30'),
      loginSnapshot,
      renamed,
    ]);
    expect(snapshot.accounts).toMatchObject({
      accounts: [{ displayName: 'New', lastSeenAt: at('12:00') }],
      accountNames: [
        { displayName: 'Old', firstSeenAt: at('10:00'), lastSeenAt: at('10:30') },
        { displayName: 'New', firstSeenAt: at('12:00'), lastSeenAt: at('12:00') },
      ],
    });
  });

  it('never counts a failed event, whatever order it arrives in', () => {
    const f = eventFactory();
    const start = f.sessionStart('10:00');
    const heartbeat = f.heartbeat('10:10');
    const failed = f.kc('10:15');
    const projections = [...PROJECTIONS, failingFor(new Set([failed.eventId]))];
    for (const order of [
      [start, heartbeat, failed],
      [failed, heartbeat, start],
      [heartbeat, failed, start],
    ]) {
      const run = runIncremental(order, { projections });
      expect(run.database.db.select().from(accounts).get()).toMatchObject({
        lastSeenAt: at('10:10'),
      });
      expect(run.database.db.select().from(accountNames).get()).toMatchObject({
        lastSeenAt: at('10:10'),
      });
    }
  });

  it('ignores a failed session.start for name, type and history', () => {
    const f = eventFactory();
    const rename = f.sessionStart('12:00', { displayName: 'Broken', accountType: 'NORMAL' });
    const events = [f.sessionStart('10:00'), rename, f.heartbeat('12:30')];
    const run = runIncremental([events[2], rename, events[0]] as Event[], {
      projections: [...PROJECTIONS, failingFor(new Set([rename.eventId]))],
    });
    expect(run.database.db.select().from(accounts).get()).toMatchObject({
      displayName: 'Test Main',
      accountType: 'IRONMAN',
    });
    expect(run.database.db.select().from(accountNames).all()).toMatchObject([
      { displayName: 'Test Main', lastSeenAt: at('12:30') },
    ]);
  });

  it('drops an account on rebuild when all its events fail', () => {
    const f = eventFactory();
    const other = f.heartbeat('10:00', { accountHash: OTHER_HASH });
    const events = [f.sessionStart('10:00'), other];
    const run = runRebuild(events, [...PROJECTIONS, failingFor(new Set([other.eventId]))]);
    expect(run.database.db.select().from(accounts).all()).toMatchObject([
      { accountHash: TEST_ACCOUNT_HASH },
    ]);
    expect(snapshotDerived(run)).toEqual(snapshotDerived(runRebuild([events[0]] as Event[])));
  });

  it('gives the same result for random histories in any order', HEAVY, () => {
    for (let seed = 1; seed <= 8; seed++) {
      const random = seededRandom(seed);
      const f = eventFactory();
      const events: Event[] = [];
      for (let i = 0; i < 30; i++) {
        // Coarse timestamps so some events share a millisecond.
        const time = new Date(Date.UTC(2026, 10, 8, 10, Math.floor(random() * 20))).toISOString();
        const accountHash = random() < 0.7 ? TEST_ACCOUNT_HASH : OTHER_HASH;
        if (random() < 0.4) {
          const displayName = ['Alpha', 'Beta', 'Gamma'][Math.floor(random() * 3)] ?? 'Alpha';
          const accountType = random() < 0.5 ? 'IRONMAN' : 'HARDCORE_IRONMAN';
          events.push(f.sessionStart(time, { displayName, accountType, accountHash }));
        } else {
          events.push(f.heartbeat(time, { accountHash }));
        }
      }
      // Accounts only: this runs 8 histories, and other projections have their own tests.
      expectOrderIndependent(events, { shuffles: 6, seed, projections: [accountsProjection] });
    }
  });
});

describe('two users with the same account hash', () => {
  // Accounts are (user, account hash): two users who send data for the same
  // hash each get their own account, and nothing of one shows up in the other.
  function events() {
    const f = eventFactory();
    const mine = [
      f.sessionStart('19:00', { displayName: 'Test Main' }),
      f.xpSnapshot('19:05', { ATTACK: 100 }),
      f.loot('19:10', { geValue: 1000 }),
      f.sessionEnd('19:30', { reason: 'logout' }),
    ];
    const other = { sessionId: sessionIdOf(2) };
    const theirs = ownedBy(SECOND_USER_ID, [
      f.sessionStart('18:00', { displayName: 'Test Alt', ...other }),
      f.xpSnapshot('18:05', { ATTACK: 999 }, other),
      f.loot('18:10', { geValue: 5, ...other }),
      f.sessionStart('20:00', { displayName: 'Renamed', sessionId: sessionIdOf(3) }),
      f.sessionEnd('20:40', { reason: 'logout', sessionId: sessionIdOf(3) }),
    ]);
    return [...mine, ...theirs];
  }

  it('get one account each, with separate names, in any arrival order and after rebuild', () => {
    const snapshot = expectOrderIndependent(events(), { shuffles: 10 });
    expect(snapshot.accounts).toEqual({
      accounts: [
        {
          userId: FIRST_USER_ID,
          accountHash: TEST_ACCOUNT_HASH,
          accountType: 'IRONMAN',
          displayName: 'Test Main',
          firstSeenAt: at('19:00'),
          lastSeenAt: at('19:30'),
        },
        {
          userId: SECOND_USER_ID,
          accountHash: TEST_ACCOUNT_HASH,
          accountType: 'IRONMAN',
          displayName: 'Renamed',
          firstSeenAt: at('18:00'),
          lastSeenAt: at('20:40'),
        },
      ],
      accountNames: [
        {
          userId: FIRST_USER_ID,
          accountHash: TEST_ACCOUNT_HASH,
          displayName: 'Test Main',
          firstSeenAt: at('19:00'),
          firstEventId: expect.any(String) as string,
          lastSeenAt: at('19:30'),
        },
        {
          userId: SECOND_USER_ID,
          accountHash: TEST_ACCOUNT_HASH,
          displayName: 'Test Alt',
          firstSeenAt: at('18:00'),
          firstEventId: expect.any(String) as string,
          lastSeenAt: at('18:10'),
        },
        {
          userId: SECOND_USER_ID,
          accountHash: TEST_ACCOUNT_HASH,
          displayName: 'Renamed',
          firstSeenAt: at('20:00'),
          firstEventId: expect.any(String) as string,
          lastSeenAt: at('20:40'),
        },
      ],
    });
  });

  it('keep sessions, XP and loot under their own account', () => {
    const run = runIncremental(events());
    expect(run.failed).toEqual([]);
    const db = run.database.db;
    const owner = (accountId: number) =>
      db.select({ userId: accounts.userId }).from(accounts).where(eq(accounts.id, accountId)).get()
        ?.userId;
    const ids = db.select({ id: accounts.id, userId: accounts.userId }).from(accounts).all();
    expect(ids).toHaveLength(2);

    const bySession = db
      .select({ id: sessions.id, accountId: sessions.accountId })
      .from(sessions)
      .orderBy(asc(sessions.id))
      .all()
      .map((row) => [row.id, owner(row.accountId)]);
    expect(bySession).toEqual([
      [sessionIdOf(1), FIRST_USER_ID],
      [sessionIdOf(2), SECOND_USER_ID],
      [sessionIdOf(3), SECOND_USER_ID],
    ]);
    const xp = db
      .select({ accountId: xpSnapshots.accountId, totalXp: xpSnapshots.totalXp })
      .from(xpSnapshots)
      .all()
      .map((row) => [owner(row.accountId), row.totalXp])
      .sort();
    expect(xp).toEqual([
      [FIRST_USER_ID, 100],
      [SECOND_USER_ID, 999],
    ]);
    const loot = db
      .select({ accountId: lootEvents.accountId, value: lootEvents.totalGeValue })
      .from(lootEvents)
      .all()
      .map((row) => [owner(row.accountId), row.value])
      .sort();
    expect(loot).toEqual([
      [FIRST_USER_ID, 1000],
      [SECOND_USER_ID, 5],
    ]);
  });

  it('keep their account IDs through a rebuild', () => {
    const run = runIncremental(events());
    const ids = () =>
      run.database.db
        .select({ id: accountIds.id, userId: accountIds.userId, hash: accountIds.accountHash })
        .from(accountIds)
        .orderBy(asc(accountIds.id))
        .all();
    const before = ids();
    expect(before.map((row) => row.userId).sort()).toEqual([FIRST_USER_ID, SECOND_USER_ID]);
    rebuildProjections(run.database.db, { projections: PROJECTIONS, now: () => TEST_NOW });
    expect(ids()).toEqual(before);
  });
});

describe('account ID counter', () => {
  // `account_ids` is looked up before inserting, so an event for an account
  // that exists never uses up a number of the AUTOINCREMENT counter.
  const counter = (run: ReturnType<typeof runIncremental>) =>
    run.database.sqlite
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'account_ids'")
      .pluck()
      .get();

  it('counts accounts, not events, and a rebuild keeps it and every ID', () => {
    const f = eventFactory();
    const events = [
      f.sessionStart('19:00'),
      f.heartbeat('19:01'),
      f.xpSnapshot('19:05', { ATTACK: 100 }),
      f.loot('19:10', { geValue: 1000 }),
      f.sessionStart('19:20', { accountHash: OTHER_HASH, sessionId: sessionIdOf(2) }),
      f.sessionEnd('19:30', { reason: 'logout' }),
    ];
    const run = runIncremental(events);
    expect(counter(run)).toBe(2);
    const ids = run.database.db.select().from(accountIds).orderBy(asc(accountIds.id)).all();

    rebuildProjections(run.database.db, { projections: PROJECTIONS, now: () => TEST_NOW });
    rebuildProjections(run.database.db, { projections: PROJECTIONS, now: () => TEST_NOW });
    expect(counter(run)).toBe(2);
    expect(run.database.db.select().from(accountIds).orderBy(asc(accountIds.id)).all()).toEqual(
      ids,
    );

    // The next new account gets the next number.
    const third = f.heartbeat('19:40', { accountHash: '-555', sessionId: sessionIdOf(3) });
    const next = runIncremental([...events, third]);
    expect(counter(next)).toBe(3);
  });
});
