import { createSecretBox, memoryKeyStore } from '../auth/secret-box.js';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANDING, eventSchema, type Event } from '@fireside/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildDerivedTables } from '../admin/rebuild.js';
import { audit, inviteTarget, userTarget } from '../audit/audit.js';
import { createApiKey, ownKey } from '../auth/api-keys.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { rememberDevice } from '../auth/devices.js';
import { createSession } from '../auth/sessions.js';
import { buildApp } from '../app.js';
import { storeExternalSnapshot } from '../clog/project.js';
import { setClogSource } from '../clog/sync.js';
import { openDatabase, type Database } from '../db/index.js';
import { apiKeys, externalSnapshots, invites, raidDropChoices } from '../db/schema.js';
import { storeEvents } from '../ingest/store.js';
import { PROJECTIONS, projectEvents } from '../projections/index.js';
import { createManualDrop, setSplitDefault } from '../raids/choices.js';
import { ownedAccountIds } from '../read/accounts.js';
import { generateSeed, type SeedData } from '../seed/generator/generate.js';
import { seedInProcess } from '../seed/in-process.js';
import { testConfig } from '../test-utils.js';
import { deleteUser, LastAdminError } from './delete-user.js';
import { createInvite, createPasswordReset } from './invites.js';
import { hashPassword } from './password.js';
import { replaceRecoveryCodes } from './two-factor.js';
import { createUser, FIRST_USER_ID, setPasswordHash } from './users.js';

// Deleting a user with all their data. Two users with the same account hashes
// and data of every kind: B (the admin, kept) is seeded first, then copied to a
// database that only ever had B; then A (deleted) is seeded on top. After
// deleting A, no row anywhere may still belong to or point at A, and B's
// derived data must equal that of the database without A, before and after a
// rebuild.

const UNTIL = new Date('2026-11-01T00:00:00.000Z');
const NOW = UNTIL;
const TZ = 'Europe/Oslo';
const SEED = { accounts: 2, months: 1, until: UNTIL, timeZone: TZ };
const CHEAP = { memory: 64, passes: 1, parallelism: 1 };
const TBOW_ID = 20997;

/** Tables that hold no user's data: shared game data and instance settings. */
const SHARED_TABLES = [
  'item_icons',
  'named_icons',
  'item_prices',
  'item_price_history',
  'external_sources',
  'server_settings',
  // The rules version of each projection: one row per projection, for the instance.
  'projection_versions',
];
/**
 * Tables with references to a user that are kept on deletion (the foreign
 * key sets them to `null`): checked separately, not required to hold rows
 * the user owns.
 */
const REFERENCE_TABLES = ['audit_log'];
const INTERNAL = /^(sqlite_|__drizzle)/;

interface ForeignKey {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

function tablesOf(database: Database): string[] {
  return (
    database.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all() as string[]
  ).filter((name) => !INTERNAL.test(name));
}

function rowsOf(database: Database, table: string): Record<string, unknown>[] {
  return database.sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
}

function foreignKeys(database: Database, table: string): ForeignKey[] {
  return database.sqlite.pragma(`foreign_key_list("${table}")`) as ForeignKey[];
}

/**
 * Every value (by `table.column`) that belongs to `userId`: starting from the
 * user's row, a row belongs to the user when a foreign key that owns it
 * (`NO ACTION` or `CASCADE`, not `SET NULL`) points at a row of theirs, or
 * when it is in the user's play session (`session_id`, not a foreign key
 * everywhere). Repeated until nothing changes.
 */
function ownedRows(database: Database, userId: number): Map<string, Record<string, unknown>[]> {
  const tables = tablesOf(database);
  const owned = new Map<string, Record<string, unknown>[]>();
  const values = new Map<string, Set<unknown>>();
  const valuesOf = (table: string, column: string) => {
    const key = `${table}.${column}`;
    let set = values.get(key);
    if (!set) {
      set = new Set((owned.get(table) ?? []).map((row) => row[column]));
      values.set(key, set);
    }
    return set;
  };
  owned.set(
    'users',
    rowsOf(database, 'users').filter((row) => row.id === userId),
  );
  const sessionIds = new Set(
    database.sqlite
      .prepare('SELECT DISTINCT session_id FROM events WHERE user_id = ?')
      .pluck()
      .all(userId),
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (const table of tables) {
      const keys = foreignKeys(database, table).filter((fk) => fk.on_delete !== 'SET NULL');
      const mine = rowsOf(database, table).filter(
        (row) =>
          (table === 'users' && row.id === userId) ||
          keys.some((fk) => row[fk.from] !== null && valuesOf(fk.table, fk.to).has(row[fk.from])) ||
          ('session_id' in row && sessionIds.has(row.session_id)),
      );
      if (mine.length !== (owned.get(table)?.length ?? 0)) {
        owned.set(table, mine);
        for (const key of values.keys()) if (key.startsWith(`${table}.`)) values.delete(key);
        changed = true;
      }
    }
  }
  return owned;
}

/** Projection snapshots (keyed by user and account hash, not row IDs). */
function derived(database: Database): Map<string, unknown> {
  return new Map(PROJECTIONS.map((p) => [p.name, p.snapshot(database.db)] as const));
}

function sameHashesAs(data: SeedData, to: readonly string[]): void {
  const map = new Map(data.accounts.map((account, i) => [account.accountHash, to[i] ?? '']));
  const swap = (hash: string) => map.get(hash) ?? hash;
  const events = new Set<Event>([...data.events, ...data.deliveries.flatMap((d) => d.events)]);
  for (const event of events)
    (event as { accountHash: string }).accountHash = swap(event.accountHash);
  for (const item of [...data.accounts, ...data.sessions, ...data.collectionLogs]) {
    item.accountHash = swap(item.accountHash);
  }
  if (data.backlog) data.backlog.accountHash = swap(data.backlog.accountHash);
}

/** Reads every account's weekly summary, which fills `weekly_summaries` (a read cache). */
async function readWeeks(database: Database, userId: number): Promise<void> {
  const app = buildApp({
    config: testConfig({ TZ }),
    db: { ...database, close: () => undefined },
    dashboard: { now: () => NOW },
  });
  const { token } = createSession(database.db, userId, { now: NOW });
  try {
    for (const account of ownedAccountIds(database.db, userId)) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/accounts/${String(account)}/weekly?week=2026-W43`,
        headers: { host: 'localhost:3100', cookie: `${SESSION_COOKIE}=${token}` },
      });
      expect(response.statusCode, response.body).toBe(200);
    }
  } finally {
    await app.close();
  }
}

/**
 * A session still AFK when it ends: idle heartbeats and no `session.afk`, so
 * it has an AFK estimate (`session_afk_estimates`). Event and session IDs are
 * per user, since they are global.
 */
function storeAfkEstimate(database: Database, userId: number, apiKeyId: number): void {
  const accountHash = database.sqlite
    .prepare('SELECT account_hash FROM accounts WHERE user_id = ? ORDER BY id LIMIT 1')
    .pluck()
    .get(userId) as string;
  const id = (n: number) =>
    `0193a000-0000-7000-8000-${(userId * 100 + n).toString(16).padStart(12, '0')}`;
  const sessionId = id(0);
  const base = { schemaVersion: 1, accountHash, sessionId } as const;
  const heartbeat = (n: number) => ({
    ...base,
    eventId: id(n),
    type: 'session.heartbeat',
    occurredAt: `2026-10-20T18:0${String(n)}:00.000Z`,
    payload: {
      regionId: 12342,
      world: 420,
      worldTypes: ['MEMBERS'],
      worldLocation: 'GERMANY',
      worldActivity: '',
      idle: n > 1,
    },
  });
  const events = [1, 2, 3, 4].map((n) => eventSchema.parse(heartbeat(n)));
  const { storedIds } = storeEvents(
    database.db,
    events.map((event, index) => ({ index, event, raw: { ...event } })),
    { userId, apiKeyId, receivedAt: NOW.toISOString() },
  );
  expect(
    projectEvents(database.db, storedIds, { projections: PROJECTIONS, now: () => NOW }).failed,
  ).toEqual([]);
}

/** Gives a user everything the dashboard can store besides events. */
async function setUpUser(database: Database, userId: number): Promise<void> {
  setPasswordHash(database.db, userId, await hashPassword('a long passphrase', CHEAP));
  const [first] = ownedAccountIds(database.db, userId);
  if (first === undefined) throw new Error('No account');
  createManualDrop(
    database.db,
    first,
    { raid: 'Chambers of Xeric', itemId: TBOW_ID, occurredAt: '2026-10-15T20:00:00.000Z' },
    NOW,
  );
  setSplitDefault(database.db, first, 'FFA', NOW);
  setClogSource(database.db, first, 'RUNEPROFILE', NOW);
  // A choice on one of the user's own events.
  const event = database.sqlite
    .prepare("SELECT event_id FROM events WHERE user_id = ? AND type = 'loot' LIMIT 1")
    .pluck()
    .get(userId) as string;
  database.db
    .insert(raidDropChoices)
    .values({ eventId: event, itemIndex: 0, note: 'a note', updatedAt: NOW.toISOString() })
    .run();
  const laptop = createApiKey(database.db, ownKey(userId), 'Laptop', NOW).id;
  storeAfkEstimate(database, userId, laptop);
  createSession(database.db, userId, { now: NOW });
  // 2FA recovery codes and a known device.
  replaceRecoveryCodes(database.db, createSecretBox(memoryKeyStore()), userId, NOW);
  rememberDevice(database.db, userId, undefined, NOW);
  audit(database.db, {
    actorUserId: userId,
    action: 'auth.login',
    target: userTarget(userId),
    now: NOW,
  });
  await readWeeks(database, userId);
}

describe('deleting a user with all their data', () => {
  let dir: string;
  /** B only. */
  let solo: Database;
  /** B, then A. */
  let full: Database;
  let a: number;
  let ownedBefore: Map<string, Record<string, unknown>[]>;
  let accountsOfA: number[];
  let inviteFromA: string;
  let inviteToA: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), `${BRANDING.shortName}-delete-user-`));
    const config = testConfig({ TZ });

    full = openDatabase(join(dir, 'full.db'));
    const dataB = generateSeed({ seed: 2, ...SEED });
    expect((await seedInProcess(full, config, dataB, { userId: FIRST_USER_ID })).failed).toEqual(
      [],
    );
    await setUpUser(full, FIRST_USER_ID);
    full.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    copyFileSync(join(dir, 'full.db'), join(dir, 'solo.db'));
    solo = openDatabase(join(dir, 'solo.db'));

    a = createUser(full.db, 'ola', { role: 'admin', now: NOW });
    const dataA = generateSeed({ seed: 1, ...SEED });
    sameHashesAs(
      dataA,
      dataB.accounts.map((account) => account.accountHash),
    );
    const seededA = await seedInProcess(full, config, dataA, { userId: a });
    expect(seededA.failed).toEqual([]);
    expect(seededA.rejected).toEqual([]);
    expect(seededA.externalSnapshots).toBeGreaterThan(0);
    await setUpUser(full, a);
    accountsOfA = ownedAccountIds(full.db, a);
    // A's `session.*` events cleared every account's cached weeks (by design,
    // projections/weekly-summaries.ts); read B's again so deleting A is seen
    // to leave them alone.
    await readWeeks(full, FIRST_USER_ID);

    // A as an admin: made an invite (still active), a reset link for B, and a key for B.
    inviteFromA = createInvite(full.db, {
      createdBy: a,
      label: 'from A',
      role: 'member',
      canCreateApiKeys: true,
      days: 30,
      maxUsers: null,
      now: NOW,
    }).row.id;
    createPasswordReset(full.db, { createdBy: a, targetUserId: FIRST_USER_ID, now: NOW });
    full.sqlite
      .prepare('UPDATE api_keys SET created_by_user_id = ? WHERE user_id = ?')
      .run(a, FIRST_USER_ID);
    // The invite A came from, and a reset link for A.
    const toA = createInvite(full.db, {
      createdBy: FIRST_USER_ID,
      label: 'for A',
      role: 'admin',
      canCreateApiKeys: true,
      days: 7,
      maxUsers: null,
      now: NOW,
    }).row.id;
    full.sqlite
      .prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?')
      .run(NOW.toISOString(), a, toA);
    inviteToA = toA;
    createPasswordReset(full.db, { createdBy: FIRST_USER_ID, targetUserId: a, now: NOW });
    audit(full.db, {
      actorUserId: FIRST_USER_ID,
      action: 'user.promote',
      target: userTarget(a),
      now: NOW,
    });
    audit(full.db, {
      actorUserId: a,
      action: 'invite.create',
      target: inviteTarget(inviteFromA),
      now: NOW,
    });

    ownedBefore = ownedRows(full, a);
  }, 300_000);

  afterAll(() => {
    // Set only if `beforeAll` got that far.
    (solo as Database | undefined)?.close();
    (full as Database | undefined)?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('had rows for A in every table that can hold a user’s data', () => {
    const empty = tablesOf(full).filter(
      (table) =>
        !SHARED_TABLES.includes(table) &&
        !REFERENCE_TABLES.includes(table) &&
        (ownedBefore.get(table)?.length ?? 0) === 0,
    );
    // A new table without a row for A here: add one to the fixture, or list it as shared.
    expect(empty).toEqual([]);
    expect(accountsOfA).toHaveLength(2);
  });

  it('deletes every row of A, and nothing of B', () => {
    const soloStateBefore = derived(solo);
    const result = deleteUser(full.db, a, { actorUserId: FIRST_USER_ID, now: NOW });
    expect(result).toMatchObject({ username: 'ola', accounts: 2 });
    expect(result.events).toBeGreaterThan(0);

    // No row is left that A owned.
    for (const [table, rows] of ownedBefore) {
      const gone = new Set(rows.map((row) => JSON.stringify(row)));
      const left = rowsOf(full, table).filter((row) => gone.has(JSON.stringify(row)));
      expect(left, table).toEqual([]);
    }
    expect(ownedRows(full, a).get('users')).toEqual([]);
    // Nothing points at A any more: no broken references either.
    expect(full.sqlite.pragma('foreign_key_check')).toEqual([]);
    for (const table of tablesOf(full)) {
      for (const fk of foreignKeys(full, table).filter((key) => key.table === 'users')) {
        const n = full.sqlite
          .prepare(`SELECT count(*) FROM "${table}" WHERE "${fk.from}" = ?`)
          .pluck()
          .get(a);
        expect(n, `${table}.${fk.from}`).toBe(0);
      }
      for (const column of ['account_id', 'account_hash'] as const) {
        const has = (full.sqlite.pragma(`table_info("${table}")`) as { name: string }[]).some(
          (info) => info.name === column,
        );
        if (column === 'account_id' && has) {
          const n = full.sqlite
            .prepare(
              `SELECT count(*) FROM "${table}" WHERE account_id IN (${accountsOfA.map(() => '?').join(',')})`,
            )
            .pluck()
            .get(...accountsOfA);
          expect(n, `${table}.account_id`).toBe(0);
        }
      }
    }

    // B's derived data is what a database without A has.
    const after = derived(full);
    for (const name of after.keys())
      expect(after.get(name), name).toEqual(soloStateBefore.get(name));
  });

  it('keeps audit rows about A (actor or ID only), and drops A’s own activity', () => {
    const rows = full.sqlite
      .prepare(
        'SELECT actor_user_id AS actor, action, target FROM audit_log WHERE target = ? OR actor_user_id IS NULL',
      )
      .all(userTarget(a)) as { actor: number | null; action: string; target: string }[];
    expect(rows).toEqual(
      expect.arrayContaining([
        { actor: FIRST_USER_ID, action: 'user.promote', target: userTarget(a) },
        { actor: FIRST_USER_ID, action: 'user.delete', target: userTarget(a) },
        // A's admin action on something else: kept, without the actor.
        { actor: null, action: 'invite.create', target: inviteTarget(inviteFromA) },
      ]),
    );
    expect(
      rows.find((row) => row.action === 'auth.login' && row.target === userTarget(a)),
    ).toBeUndefined();
    const text = JSON.stringify(full.sqlite.prepare('SELECT * FROM audit_log').all());
    expect(text).not.toContain('ola');
  });

  it('keeps invites A made (revoked) and the one A came from, without A', () => {
    const fromA = full.db
      .select()
      .from(invites)
      .all()
      .find((row) => row.id === inviteFromA);
    expect(fromA).toMatchObject({
      createdBy: null,
      revokedBy: FIRST_USER_ID,
      revokedAt: NOW.toISOString(),
    });
    const toA = full.db
      .select()
      .from(invites)
      .all()
      .find((row) => row.id === inviteToA);
    // The admin's label for it may name A.
    expect(toA).toMatchObject({ createdBy: FIRST_USER_ID, usedBy: null, label: null });
    expect(
      full.db
        .select()
        .from(invites)
        .all()
        .filter((row) => row.targetUserId === a),
    ).toEqual([]);
    // B's key that A made stays, without its creator.
    const keysOfB = full.db.select().from(apiKeys).all();
    expect(keysOfB.length).toBeGreaterThan(0);
    for (const key of keysOfB) expect(key.createdByUserId).toBeNull();
  });

  it(
    'a rebuild gives B the same derived data as a database that never had A',
    { timeout: 240_000 },
    () => {
      rebuildDerivedTables(full.db, { now: () => NOW });
      rebuildDerivedTables(solo.db, { now: () => NOW });
      const after = derived(full);
      const expected = derived(solo);
      for (const name of after.keys()) expect(after.get(name), name).toEqual(expected.get(name));
    },
  );

  it('a new user with the same name sees nothing old', async () => {
    const again = createUser(full.db, 'ola', { now: NOW });
    expect(again).not.toBe(a);
    const { token } = createSession(full.db, again, { now: NOW });
    setPasswordHash(full.db, again, await hashPassword('a long passphrase', CHEAP));
    const session = createSession(full.db, again, { now: NOW }).token;
    expect(token).not.toBe(session);
    const app = buildApp({
      config: testConfig({ TZ }),
      db: { ...full, close: () => undefined },
      dashboard: { now: () => NOW },
    });
    try {
      const get = (url: string) =>
        app.inject({
          method: 'GET',
          url,
          headers: { host: 'localhost:3100', cookie: `${SESSION_COOKIE}=${session}` },
        });
      expect((await get('/api/v1/accounts')).json()).toEqual({ accounts: [] });
      expect((await get('/api/v1/keys')).json()).toEqual({ keys: [] });
      for (const account of accountsOfA) {
        expect((await get(`/api/v1/accounts/${String(account)}`)).statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it('a collection log sync that finishes after the deletion stores nothing', () => {
    const before = full.db.select().from(externalSnapshots).all().length;
    expect(() => {
      full.db.transaction((tx) => {
        storeExternalSnapshot(tx, {
          source: 'RUNEPROFILE',
          kind: 'profile',
          accountId: accountsOfA[0] ?? 0,
          fetchedAt: NOW.toISOString(),
          body: '{}',
          contentHash: 'x',
        });
      });
    }).toThrow(/FOREIGN KEY/);
    expect(full.db.select().from(externalSnapshots).all()).toHaveLength(before);
  });

  it('never deletes the last active admin', () => {
    // B is the only admin left.
    expect(() =>
      deleteUser(full.db, FIRST_USER_ID, { actorUserId: FIRST_USER_ID, now: NOW }),
    ).toThrow(LastAdminError);
  });
});
