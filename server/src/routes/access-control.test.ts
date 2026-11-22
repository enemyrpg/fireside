import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANDING, type Event } from '@fireside/shared';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createApiKey, ownKey } from '../auth/api-keys.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { createSession } from '../auth/sessions.js';
import { setClogSource } from '../clog/sync.js';
import { openDatabase, type Database } from '../db/index.js';
import { createExternalClient } from '../external/client.js';
import { createManualDrop, setSplitDefault } from '../raids/choices.js';
import { ownedAccountIds } from '../read/accounts.js';
import { generateSeed, type SeedData } from '../seed/generator/generate.js';
import { seedInProcess } from '../seed/in-process.js';
import { testConfig } from '../test-utils.js';
import { hashPassword } from '../users/password.js';
import { createUser, FIRST_USER_ID, setPasswordHash } from '../users/users.js';

// Access control on every dashboard endpoint, generated from the app's own
// route list: a new route without a case here fails the first test.
//
// Two users with the same account hashes and data of every kind (seeded):
// A is a member, B the admin. For every route that takes an ID, each user
// gets `404` on the other's account, session, drop and key, exactly the same
// response (status, body, headers) as for an ID that doesn't exist, and a
// write changes nothing at all before the `404`. Admin routes are `403` for A.
// `all` and A's own IDs give A exactly what a database with only A's data
// gives, so B's data never shows up or changes a number.

const UNTIL = new Date('2026-11-01T00:00:00.000Z');
const NOW = UNTIL;
const TZ = 'Europe/Oslo';
const SEED = { accounts: 2, months: 1, until: UNTIL, timeZone: TZ };
const ENV = {
  TZ,
  // On, so a collection log sync started by mistake would really call out
  // (to the counting fetch below, never the network).
  RUNEPROFILE_ENABLED: 'true',
  USER_AGENT_CONTACT: 'test@example.invalid',
};
const HOST = 'localhost:3100';
const ORIGIN = `http://${HOST}`;

const UNKNOWN = {
  account: 999_999,
  session: '01900000-0000-7000-8000-000000000000',
  drop: '01900000-0000-7000-8000-000000000001',
  key: 999_999,
};
const TBOW_ID = 20997;
/** Cheap argon2 parameters: the passwords here are never guessed at. */
const CHEAP = { memory: 64, passes: 1, parallelism: 1 };

interface UserData {
  userId: number;
  token: string;
  accounts: number[];
  session: string;
  drop: string;
  key: number;
}

/** What a route does with an ID that belongs to someone. */
type Case =
  /** Takes an ID the caller must own (`:accountId`, `:sessionId`, `:dropId`, `:id`). */
  | { kind: 'owned'; body?: object; all?: boolean }
  /** Admin only: `403` for a member, also with a valid body and the admin's IDs. */
  | { kind: 'admin'; body?: object }
  /** Acts only on the caller; no ID to point elsewhere. Tested by name below. */
  | { kind: 'self'; why: string }
  /** The instance's shared data (icons): any logged-in user. */
  | { kind: 'shared' };

const ACCOUNT = '/api/v1/accounts/:accountId';

/** Every non-public dashboard route. Keys are `METHOD url` as Fastify registers them. */
const CASES: Record<string, Case> = {
  'POST /api/v1/admin/rebuild': { kind: 'admin' },
  'GET /api/v1/admin/icons': { kind: 'admin' },
  'GET /api/v1/admin/backups': { kind: 'admin' },
  'GET /api/v1/admin/external-sources': { kind: 'admin' },
  'GET /api/v1/users': { kind: 'admin' },
  'PATCH /api/v1/users/:id': { kind: 'admin' },
  'DELETE /api/v1/users/:id': { kind: 'admin' },
  'POST /api/v1/users/:id/password-reset': { kind: 'admin' },
  'POST /api/v1/users/:id/totp-reset': { kind: 'admin' },
  'GET /api/v1/invites': { kind: 'admin' },
  'POST /api/v1/invites': { kind: 'admin' },
  'DELETE /api/v1/invites/:id': { kind: 'admin' },
  'GET /api/v1/admin/keys': { kind: 'admin' },
  'DELETE /api/v1/admin/keys/:id': { kind: 'admin' },
  'POST /api/v1/users/:id/keys': { kind: 'admin', body: { name: 'For me' } },
  'GET /api/v1/admin/settings': { kind: 'admin' },
  'PATCH /api/v1/admin/settings': {
    kind: 'admin',
    body: { defaultInviteCanCreateApiKeys: false },
  },

  'POST /api/v1/auth/logout-all': { kind: 'self', why: 'ends only the caller’s sessions' },
  'POST /api/v1/auth/password': { kind: 'self', why: 'changes only the caller’s password' },
  'POST /api/v1/auth/delete-account': { kind: 'self', why: 'deletes only the caller' },
  'GET /api/v1/auth/totp': { kind: 'self', why: 'shows only the caller’s 2FA' },
  'POST /api/v1/auth/totp/setup': { kind: 'self', why: 'sets up 2FA for the caller' },
  'POST /api/v1/auth/totp/enable': { kind: 'self', why: 'turns on the caller’s 2FA' },
  'POST /api/v1/auth/totp/disable': { kind: 'self', why: 'turns off the caller’s 2FA' },
  'POST /api/v1/auth/totp/recovery-codes': {
    kind: 'self',
    why: 'makes recovery codes for the caller',
  },

  'GET /api/v1/keys': { kind: 'self', why: 'lists only the caller’s keys' },
  'POST /api/v1/keys': { kind: 'self', why: 'creates a key for the caller' },
  'DELETE /api/v1/keys/:id': { kind: 'owned' },

  'GET /api/v1/accounts': { kind: 'self', why: 'lists only the caller’s accounts' },
  [`GET ${ACCOUNT}`]: { kind: 'owned' },
  [`GET ${ACCOUNT}/gains`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/xp`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/loot`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/loot/drops`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/kc`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/raids`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/raids/splits`]: { kind: 'owned', all: true },
  [`PUT ${ACCOUNT}/raids/split-default`]: { kind: 'owned', body: { mode: 'FFA' } },
  [`POST ${ACCOUNT}/raids/drops`]: {
    kind: 'owned',
    body: { raid: 'Chambers of Xeric', itemId: TBOW_ID, occurredAt: '2026-10-20T20:00:00.000Z' },
  },
  [`PATCH ${ACCOUNT}/raids/drops/:dropId`]: { kind: 'owned', body: { note: 'changed' } },
  [`DELETE ${ACCOUNT}/raids/drops/:dropId`]: { kind: 'owned' },
  [`GET ${ACCOUNT}/bank`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/bank/summary`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/bank/history`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/bank/price-movers`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/potion-storage`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/quests`]: { kind: 'owned' },
  [`GET ${ACCOUNT}/diaries`]: { kind: 'owned' },
  [`GET ${ACCOUNT}/pets`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/feed`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/collection-log`]: { kind: 'owned' },
  [`GET ${ACCOUNT}/collection-log/status`]: { kind: 'owned' },
  [`PUT ${ACCOUNT}/collection-log/source`]: { kind: 'owned', body: { source: 'RUNEPROFILE' } },
  [`POST ${ACCOUNT}/collection-log/sync`]: { kind: 'owned' },
  [`GET ${ACCOUNT}/sessions`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/calendar`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/screentime`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/screentime/worlds`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/screentime/heatmap`]: { kind: 'owned', all: true },
  [`GET ${ACCOUNT}/weekly`]: { kind: 'owned', all: true },
  'GET /api/v1/sessions/:sessionId': { kind: 'owned' },

  'GET /api/v1/items/:itemId/icon': { kind: 'shared' },
  'GET /api/v1/skills/:skill/icon': { kind: 'shared' },
  'GET /api/v1/bosses/:boss/icon': { kind: 'shared' },
};

const OWNED = Object.entries(CASES).flatMap(([key, value]) =>
  value.kind === 'owned' ? [[key, value] as const] : [],
);
const ADMIN = Object.keys(CASES).filter((key) => CASES[key]?.kind === 'admin');

/** Path of `url` with each ID parameter from `ids`. */
function fill(
  url: string,
  ids: { account: number | 'all'; session: string; drop: string; key: number },
): string {
  return url
    .replace(':accountId', String(ids.account))
    .replace(':sessionId', ids.session)
    .replace(':dropId', ids.drop)
    .replace(':id', String(ids.key))
    .replace(':itemId', '4151')
    .replace(':skill', 'ATTACK')
    .replace(':boss', 'Vorkath');
}

const idsOf = (user: UserData) => ({
  account: user.accounts[0] ?? 0,
  session: user.session,
  drop: user.drop,
  key: user.key,
});

/** Content of every table, hashed: equal before and after means nothing changed. */
function fingerprint(database: Database): Record<string, string> {
  const tables = database.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => {
      const rows = database.sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
      const hash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      return [name, hash];
    }),
  );
}

/** The response as compared: status, headers (without `date`) and body. */
function comparable(response: LightMyRequestResponse) {
  const headers: Record<string, unknown> = { ...response.headers };
  delete headers.date;
  return { status: response.statusCode, headers, body: response.body };
}

/** Sets every `accountHash` in `data` to the hash at the same index in `to`. */
function useAccountHashes(data: SeedData, to: readonly string[]): void {
  const map = new Map(data.accounts.map((account, i) => [account.accountHash, to[i] ?? '']));
  const swap = (hash: string) => map.get(hash) ?? hash;
  const events = new Set<Event>([...data.events, ...data.deliveries.flatMap((d) => d.events)]);
  for (const event of events) {
    (event as { accountHash: string }).accountHash = swap(event.accountHash);
  }
  for (const item of [...data.accounts, ...data.sessions, ...data.collectionLogs]) {
    item.accountHash = swap(item.accountHash);
  }
  if (data.backlog) data.backlog.accountHash = swap(data.backlog.accountHash);
}

/**
 * For the walk through A's whole feed below: every type and page, twice. About
 * 1 s here, over 7 s on a slow CI runner, where the default 5 s made it fail.
 */
const HEAVY_TEST_TIMEOUT_MS = 240_000;

describe('access control on every dashboard route', () => {
  let dir: string;
  /** A's data only. */
  let solo: Database;
  /** A's data, then B's. */
  let full: Database;
  let soloApp: FastifyInstance;
  let fullApp: FastifyInstance;
  let fetches: string[];
  const routes: { method: string; url: string; access: unknown }[] = [];
  let A: UserData;
  let B: UserData;

  /** Gives a user a session, a manual raid drop, a key and choices on their first account. */
  async function setUpUser(database: Database, userId: number, data: SeedData): Promise<UserData> {
    setPasswordHash(database.db, userId, await hashPassword('a long passphrase', CHEAP));
    const accounts = ownedAccountIds(database.db, userId);
    const first = accounts[0] ?? 0;
    const drop = createManualDrop(
      database.db,
      first,
      { raid: 'Chambers of Xeric', itemId: TBOW_ID, occurredAt: '2026-10-15T20:00:00.000Z' },
      NOW,
    );
    setSplitDefault(database.db, first, 'SPLIT', NOW);
    setClogSource(database.db, first, 'RUNEPROFILE', NOW);
    const key = createApiKey(database.db, ownKey(userId), 'Laptop', NOW).id;
    const { token } = createSession(database.db, userId, { now: NOW });
    const session = data.sessions[0]?.sessionId ?? '';
    return { userId, token, accounts, session, drop, key };
  }

  function appOn(database: Database): FastifyInstance {
    const config = testConfig(ENV);
    const app = buildApp({
      config,
      // Closed by the test, not the app.
      db: { ...database, close: () => undefined },
      dashboard: { now: () => NOW },
      externalClient: createExternalClient({
        config,
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        fetch: (input: string | URL | Request) => {
          fetches.push(input instanceof Request ? input.url : String(input));
          return Promise.resolve(new Response('{}', { status: 503 }));
        },
        now: () => NOW,
        sleep: () => Promise.resolve(),
      }),
    });
    return app;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), `${BRANDING.shortName}-access-`));
    fetches = [];
    const config = testConfig({ TZ });

    // A (member, user 2) alone first; the full database starts as a copy, so
    // A's IDs are the same in both.
    solo = openDatabase(join(dir, 'solo.db'));
    const memberId = createUser(solo.db, 'alice');
    const dataA = generateSeed({ seed: 1, ...SEED });
    const seededA = await seedInProcess(solo, config, dataA, { userId: memberId });
    expect(seededA.failed).toEqual([]);
    const soloA = await setUpUser(solo, memberId, dataA);
    // Only A has a password here, which is enough for login mode.
    solo.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    copyFileSync(join(dir, 'solo.db'), join(dir, 'full.db'));
    full = openDatabase(join(dir, 'full.db'));
    A = { ...soloA };

    // B (admin, user 1): another seed, with A's account hashes.
    const dataB = generateSeed({ seed: 2, ...SEED });
    useAccountHashes(
      dataB,
      dataA.accounts.map((account) => account.accountHash),
    );
    const seededB = await seedInProcess(full, config, dataB, { userId: FIRST_USER_ID });
    expect(seededB.failed).toEqual([]);
    expect(seededB.rejected).toEqual([]);
    B = await setUpUser(full, FIRST_USER_ID, dataB);
    expect(B.accounts).toHaveLength(2);
    expect(B.accounts.some((id) => A.accounts.includes(id))).toBe(false);

    soloApp = appOn(solo);
    fullApp = appOn(full);
    // Every route of the app, as registered (before `ready` loads the plugins).
    fullApp.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) {
        routes.push({
          method,
          url: route.url,
          access: (route.config as { access?: unknown } | undefined)?.access,
        });
      }
    });
    await Promise.all([soloApp.ready(), fullApp.ready()]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all([soloApp.close(), fullApp.close()]);
    solo.close();
    full.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function send(
    app: FastifyInstance,
    user: UserData,
    method: NonNullable<InjectOptions['method']>,
    url: string,
    body?: object,
  ): Promise<LightMyRequestResponse> {
    const options: InjectOptions = {
      method,
      url,
      headers: {
        host: HOST,
        cookie: `${SESSION_COOKIE}=${user.token}`,
        ...(method === 'GET' ? {} : { origin: ORIGIN }),
      },
      ...(body ? { payload: body } : {}),
    };
    return app.inject(options);
  }

  const methodOf = (key: string) => key.split(' ')[0] ?? 'GET';
  const urlOf = (key: string) => key.split(' ')[1] ?? '';

  it('has a case for every dashboard route, and every route declares its access', () => {
    const dashboard = routes.filter(
      (route) =>
        route.method !== 'HEAD' &&
        route.url.startsWith('/api/v1/') &&
        !route.url.startsWith('/api/v1/ingest') &&
        route.url !== '/api/v1/health',
    );
    expect(dashboard.filter((route) => route.access === undefined)).toEqual([]);
    const nonPublic = dashboard
      .filter((route) => route.access !== 'public')
      .map((route) => `${route.method} ${route.url}`)
      .sort();
    expect(nonPublic).toEqual(Object.keys(CASES).sort());
    // Admin cases are the admin routes and nothing else.
    expect(
      dashboard
        .filter((route) => route.access === 'admin')
        .map((route) => `${route.method} ${route.url}`)
        .sort(),
    ).toEqual([...ADMIN].sort());
  });

  describe.each([
    ['member A', 'admin B', () => ({ attacker: A, victim: B })],
    ['admin B', 'member A', () => ({ attacker: B, victim: A })],
  ])('%s on %s’s IDs', (_attacker, _victim, users) => {
    it.each(OWNED)('%s: 404 like an unknown ID, and no change', async (key, routeCase) => {
      const { attacker, victim } = users();
      const method = methodOf(key);
      const url = urlOf(key);
      const before = fingerprint(full);
      const foreign = await send(
        fullApp,
        attacker,
        method,
        fill(url, idsOf(victim)),
        routeCase.body,
      );
      const unknown = await send(fullApp, attacker, method, fill(url, UNKNOWN), routeCase.body);
      expect(foreign.statusCode, foreign.body).toBe(404);
      expect(comparable(foreign)).toEqual(comparable(unknown));
      // Give anything started by mistake (a collection log sync) time to run.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fingerprint(full)).toEqual(before);
      expect(fetches).toEqual([]);

      // A drop of the other user's, under the caller's own account.
      if (url.includes(':dropId')) {
        const own = { ...idsOf(attacker) };
        const theirDrop = await send(
          fullApp,
          attacker,
          method,
          fill(url, { ...own, drop: victim.drop }),
          routeCase.body,
        );
        const noDrop = await send(
          fullApp,
          attacker,
          method,
          fill(url, { ...own, drop: UNKNOWN.drop }),
          routeCase.body,
        );
        expect(theirDrop.statusCode, theirDrop.body).toBe(404);
        expect(comparable(theirDrop)).toEqual(comparable(noDrop));
        expect(fingerprint(full)).toEqual(before);
      }
    });
  });

  it.each(ADMIN)('%s: 403 for a member, with no change', async (key) => {
    const before = fingerprint(full);
    const routeCase = CASES[key];
    const body = routeCase?.kind === 'admin' ? routeCase.body : undefined;
    // B's key, and B's user ID where the route takes a user (B is the admin).
    const url = fill(urlOf(key).replace('/users/:id', `/users/${String(B.userId)}`), idsOf(B));
    const response = await send(fullApp, A, methodOf(key), url, body);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'Only an admin can do this', details: [] },
    });
    expect(fingerprint(full)).toEqual(before);
  });

  it.each(ADMIN.filter((key) => methodOf(key) === 'GET'))('%s: 200 for an admin', async (key) => {
    const response = await send(fullApp, B, 'GET', urlOf(key));
    expect(response.statusCode, response.body).toBe(200);
  });

  it.each(Object.keys(CASES).filter((key) => CASES[key]?.kind === 'shared'))(
    '%s: any logged-in user may read it',
    async (key) => {
      const response = await send(fullApp, A, 'GET', fill(urlOf(key), idsOf(A)));
      // No icons are stored: 404, but never 401 or 403.
      expect(response.statusCode).toBe(404);
    },
  );

  describe('A sees exactly what a database with only A’s data shows', () => {
    const reads = OWNED.filter(([key]) => methodOf(key) === 'GET');

    it.each(reads)('%s with A’s own IDs', async (key) => {
      const url = fill(urlOf(key), idsOf(A));
      const alone = await send(soloApp, A, 'GET', url);
      const shared = await send(fullApp, A, 'GET', url);
      expect(alone.statusCode, alone.body).toBe(200);
      expect(shared.body).toEqual(alone.body);
    });

    it.each(reads.filter(([, routeCase]) => routeCase.all === true))('%s with all', async (key) => {
      const url = fill(urlOf(key), { ...idsOf(A), account: 'all' });
      const alone = await send(soloApp, A, 'GET', url);
      const shared = await send(fullApp, A, 'GET', url);
      expect(alone.statusCode, alone.body).toBe(200);
      expect(shared.body).toEqual(alone.body);
    });

    it.each(['/api/v1/accounts', '/api/v1/keys'])('%s lists only A’s own', async (url) => {
      const alone = await send(soloApp, A, 'GET', url);
      const shared = await send(fullApp, A, 'GET', url);
      expect(shared.statusCode).toBe(200);
      expect(shared.body).toEqual(alone.body);
    });

    it('all for the admin is only the admin’s accounts', async () => {
      const response = await send(fullApp, B, 'GET', '/api/v1/accounts');
      const ids = response.json<{ accounts: { id: number }[] }>().accounts.map((a) => a.id);
      expect(ids).toEqual(B.accounts);
    });

    it('session neighbours stay within A’s own sessions', async () => {
      const ownSessions = new Set(
        full.sqlite
          .prepare('SELECT id FROM sessions WHERE account_id IN (?, ?)')
          .all(...A.accounts)
          .map((row) => (row as { id: string }).id),
      );
      const response = await send(fullApp, A, 'GET', `/api/v1/sessions/${A.session}`);
      const { neighbors } = response.json<{
        neighbors: { olderId: string | null; newerId: string | null };
      }>();
      for (const id of [neighbors.olderId, neighbors.newerId]) {
        if (id !== null) expect(ownSessions.has(id)).toBe(true);
      }
      expect(neighbors.olderId ?? neighbors.newerId).not.toBeNull();
    });

    it(
      'the whole feed of A, every type and page, is A’s own and the same as alone',
      { timeout: HEAVY_TEST_TIMEOUT_MS },
      async () => {
        const walk = async (app: FastifyInstance, account: string) => {
          const entries: { type: string; accountId: number }[] = [];
          let cursor: string | null = null;
          do {
            const base = 'types=session,level,clog,pet,drop&minValue=0&limit=100';
            const query: string = cursor === null ? base : `${base}&cursor=${cursor}`;
            const response = await send(app, A, 'GET', `/api/v1/accounts/${account}/feed?${query}`);
            expect(response.statusCode, response.body).toBe(200);
            const page = response.json<{
              items: { type: string; accountId: number }[];
              nextCursor: string | null;
            }>();
            entries.push(...page.items);
            cursor = page.nextCursor;
          } while (cursor !== null);
          return entries;
        };
        for (const account of ['all', ...A.accounts.map(String)]) {
          const alone = await walk(soloApp, account);
          const shared = await walk(fullApp, account);
          expect(shared).toEqual(alone);
          expect(shared.every((entry) => A.accounts.includes(entry.accountId))).toBe(true);
        }
        const all = await walk(fullApp, 'all');
        // The seed gives A entries of every type, so the test is not empty.
        expect(new Set(all.map((entry) => entry.type))).toEqual(
          new Set(['session', 'level', 'clog', 'pet', 'drop']),
        );
      },
    );
  });

  // From here on, tests change the database: keep them last.
  describe('routes that act only on the caller', () => {
    it('a user without accounts gets an empty all', async () => {
      const userId = createUser(full.db, 'carol');
      // A user without a password can't have a valid session.
      setPasswordHash(full.db, userId, await hashPassword('a long passphrase', CHEAP));
      const { token } = createSession(full.db, userId, { now: NOW });
      const carol = { ...A, userId, token, accounts: [] };
      expect((await send(fullApp, carol, 'GET', '/api/v1/accounts')).json()).toEqual({
        accounts: [],
      });
      const sessions = await send(fullApp, carol, 'GET', '/api/v1/accounts/all/sessions');
      expect(sessions.statusCode).toBe(200);
      expect(sessions.json<{ items: unknown[] }>().items).toEqual([]);
      const pets = await send(fullApp, carol, 'GET', '/api/v1/accounts/all/pets');
      expect(pets.json()).toEqual({ pets: [] });
    });

    it('POST /keys creates a key for the caller only', async () => {
      const before = await send(fullApp, B, 'GET', '/api/v1/keys');
      const created = await send(fullApp, A, 'POST', '/api/v1/keys', { name: 'Phone' });
      expect(created.statusCode).toBe(201);
      const keys = (await send(fullApp, A, 'GET', '/api/v1/keys')).json<{
        keys: { name: string }[];
      }>();
      // `seed` is the key the seed sent A's events with.
      expect(keys.keys.map((k) => k.name).sort()).toEqual(['Laptop', 'Phone', 'seed']);
      expect((await send(fullApp, B, 'GET', '/api/v1/keys')).body).toEqual(before.body);
    });

    it('logout-all ends only the caller’s sessions', async () => {
      const extra = createSession(full.db, A.userId, { now: NOW });
      const response = await send(
        fullApp,
        { ...A, token: extra.token },
        'POST',
        '/api/v1/auth/logout-all',
      );
      expect(response.statusCode).toBe(204);
      expect((await send(fullApp, A, 'GET', '/api/v1/keys')).statusCode).toBe(401);
      expect((await send(fullApp, B, 'GET', '/api/v1/keys')).statusCode).toBe(200);
      A = { ...A, token: createSession(full.db, A.userId, { now: NOW }).token };
    });

    it('a password change touches only the caller', async () => {
      const hashOf = (userId: number) =>
        (
          full.sqlite.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as {
            password_hash: string;
          }
        ).password_hash;
      const adminHash = hashOf(B.userId);
      const response = await send(fullApp, A, 'POST', '/api/v1/auth/password', {
        currentPassword: 'a long passphrase',
        newPassword: 'another long passphrase',
      });
      expect(response.statusCode, response.body).toBe(204);
      expect(hashOf(B.userId)).toBe(adminHash);
      expect((await send(fullApp, B, 'GET', '/api/v1/keys')).statusCode).toBe(200);
    });

    it('the sync test is real: a sync of the caller’s own account does call out', async () => {
      const response = await send(
        fullApp,
        B,
        'POST',
        `/api/v1/accounts/${String(B.accounts[0])}/collection-log/sync`,
      );
      expect(response.statusCode, response.body).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fetches.length).toBeGreaterThan(0);
    });
  });
});
