import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANDING, type Event } from '@fireside/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiKey } from '../auth/api-keys.js';
import { acquireInstanceLock } from '../backup/lock.js';
import { databasePath, openDatabase } from '../db/index.js';
import { storeEvents } from '../ingest/store.js';
import { testConfig, TEST_OWNER } from '../test-utils.js';
import {
  DEFAULT_ACCOUNTS,
  DEFAULT_MONTHS,
  DEFAULT_SEED,
  DEFAULT_SEED_DATA_DIR,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  parseSeedArgs,
  runSeed,
  UsageError,
  type SeedContext,
} from './run.js';
import { FIRST_USER_ID } from '../users/users.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');

describe('parseSeedArgs', () => {
  it('has safe defaults', () => {
    expect(parseSeedArgs([], NOW)).toEqual({
      seed: DEFAULT_SEED,
      accounts: DEFAULT_ACCOUNTS,
      months: DEFAULT_MONTHS,
      until: NOW,
      dataDir: DEFAULT_SEED_DATA_DIR,
      reset: false,
    });
    expect(parseSeedArgs(['-h'], NOW)).toBe('help');
  });

  it('reads every option', () => {
    expect(
      parseSeedArgs(
        [
          '--seed',
          '42',
          '--accounts',
          '2',
          '--months',
          '3',
          '--until',
          '2026-10-01T00:00:00Z',
          '--reset',
          '--data-dir',
          'x',
        ],
        NOW,
      ),
    ).toEqual({
      seed: 42,
      accounts: 2,
      months: 3,
      until: new Date('2026-10-01T00:00:00.000Z'),
      dataDir: 'x',
      reset: true,
    });
    expect(parseSeedArgs(['--url', 'http://127.0.0.1:3100/', '--key', 'k'], NOW)).toMatchObject({
      remote: { url: 'http://127.0.0.1:3100', key: 'k' },
    });
  });

  it.each([
    [['--accounts', '4']],
    [['--accounts', '1']],
    [['--months', '0']],
    [['--seed', '-1']],
    [['--seed', '1.5']],
    [['--until', '2026-10-01']],
    [['--until', '2026-10-01T00:00:00+02:00']],
    [['--url', 'http://localhost:3100']],
    [['--key', 'k']],
    [['--url', 'ftp://x', '--key', 'k']],
    [['--url', 'http://x', '--key', 'k', '--reset']],
    [['--url', 'http://x', '--key', 'k', '--data-dir', 'd']],
    [['--unknown']],
    [['extra']],
  ])('rejects %j', (argv) => {
    expect(() => parseSeedArgs(argv, NOW)).toThrow(UsageError);
  });
});

describe('runSeed', () => {
  let dir: string;
  let lines: string[];
  let errors: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `${BRANDING.shortName}-seed-test-`));
    lines = [];
    errors = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function context(overrides: Partial<SeedContext> = {}): SeedContext {
    return {
      config: testConfig({ DATA_DIR: join(dir, 'normal'), TZ: 'Europe/Oslo' }),
      now: () => NOW,
      baseDir: dir,
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
      sleep: () => Promise.resolve(),
      ...overrides,
    };
  }

  /** Puts one event in the database at `file`, like an earlier seed would. */
  function storeOneEvent(file: string, event: Event) {
    const database = openDatabase(file);
    const { id } = createApiKey(database.db, TEST_OWNER, 'earlier');
    storeEvents(database.db, [{ index: 0, event, raw: { ...event } }], {
      userId: FIRST_USER_ID,
      apiKeyId: id,
      receivedAt: NOW.toISOString(),
    });
    database.close();
  }

  const anEvent: Event = {
    eventId: '01933c4e-8a2b-7c3d-9e4f-0a1b2c3d4e5f',
    schemaVersion: 1,
    type: 'session.end',
    accountHash: '1',
    occurredAt: '2026-11-01T00:00:00.000Z',
    sessionId: '01933c40-1111-7aaa-bbbb-ccccdddd0001',
    payload: { reason: 'logout' },
  };

  it('prints help and usage errors', async () => {
    expect(await runSeed(['--help'], context())).toBe(EXIT_OK);
    expect(lines.join('\n')).toContain('Usage: pnpm seed');
    expect(await runSeed(['--accounts', '9'], context())).toBe(EXIT_USAGE);
    expect(errors[0]).toBe('--accounts must be 2 or 3');
  });

  it('refuses the normal database', async () => {
    const code = await runSeed(['--data-dir', 'normal', '--months', '1'], context());
    expect(code).toBe(EXIT_FAILURE);
    expect(errors.join('\n')).toMatch(/it is the normal database \(DATA_DIR\)/);
    expect(existsSync(databasePath(join(dir, 'normal')))).toBe(false);
  });

  it('refuses while a server runs on the seed data, and --reset deletes nothing', async () => {
    const seedDir = join(dir, DEFAULT_SEED_DATA_DIR);
    const seedFile = databasePath(seedDir);
    storeOneEvent(seedFile, anEvent);
    const server = acquireInstanceLock(seedDir);
    try {
      const code = await runSeed(['--reset', '--months', '1', '--accounts', '2'], context());
      expect(code).toBe(EXIT_FAILURE);
      expect(errors.join('\n')).toMatch(/A server is running on .*data-seed.*Stop it first/);
    } finally {
      server.release();
    }
    const database = openDatabase(seedFile);
    expect(database.sqlite.prepare('SELECT event_id FROM events').all()).toEqual([
      { event_id: anEvent.eventId },
    ]);
    database.close();
  });

  it('releases the lock when it is done', async () => {
    const seedDir = join(dir, DEFAULT_SEED_DATA_DIR);
    storeOneEvent(databasePath(seedDir), anEvent);
    expect(await runSeed(['--months', '1', '--accounts', '2'], context())).toBe(EXIT_FAILURE);
    acquireInstanceLock(seedDir).release();
  });

  it('refuses a seed database that already has events', async () => {
    const seedFile = databasePath(join(dir, DEFAULT_SEED_DATA_DIR));
    storeOneEvent(seedFile, anEvent);

    expect(await runSeed(['--months', '1', '--accounts', '2'], context())).toBe(EXIT_FAILURE);
    expect(errors.join('\n')).toMatch(/already has 1 events\. Run with --reset/);
    expect(lines).toContain(`Database: ${seedFile}`);

    // Nothing was deleted or added.
    const database = openDatabase(seedFile);
    const stored = database.sqlite.prepare('SELECT event_id FROM events').all();
    database.close();
    expect(stored).toEqual([{ event_id: anEvent.eventId }]);
  });

  it(
    'seeds an empty database with --reset and reports a clean summary',
    { timeout: 240_000 },
    async () => {
      const seedFile = databasePath(join(dir, DEFAULT_SEED_DATA_DIR));
      const normalFile = databasePath(join(dir, 'normal'));
      storeOneEvent(seedFile, anEvent);
      storeOneEvent(normalFile, anEvent);
      const normalBefore = readFileSync(normalFile);

      const code = await runSeed(
        ['--reset', '--accounts', '2', '--months', '1', '--until', '2026-11-03T20:00:00.000Z'],
        context(),
      );
      expect(errors).toEqual([]);
      expect(code).toBe(EXIT_OK);
      const output = lines.join('\n');
      expect(output).toContain(`Database: ${seedFile}`);
      expect(output).toMatch(
        /Sent: \d+ requests, [\d,]+ accepted, 0 duplicates, 0 rejected, 0 failed projections/,
      );
      expect(output).toMatch(
        /Sessions: \d+ \(logout \d+, client_closed \d+, hop \d+, crashed \d+, still open 1\)/,
      );

      const database = openDatabase(seedFile);
      const stored = database.sqlite.prepare('SELECT count(*) AS n FROM events').get() as {
        n: number;
      };
      const keys = database.sqlite.prepare('SELECT name FROM api_keys').all();
      database.close();
      expect(stored.n).toBeGreaterThan(1000);
      expect(keys).toEqual([{ name: 'seed' }]);
      expect(readFileSync(normalFile)).toEqual(normalBefore);
    },
  );

  describe('--url', () => {
    const argv = [
      '--url',
      'http://127.0.0.1:3100',
      '--key',
      'secret',
      '--accounts',
      '2',
      '--months',
      '1',
    ];

    function fakeServer(reply: (events: Event[], call: number) => object) {
      const calls: { url: string; auth: string | null }[] = [];
      // The seed always calls fetch with a string URL and a string body.
      const fakeFetch = (
        url: string,
        init?: { headers?: Record<string, string>; body?: string },
      ) => {
        const headers = new Headers(init?.headers);
        calls.push({ url, auth: headers.get('authorization') });
        if (url.endsWith('/verify')) return Promise.resolve(Response.json({ ok: true }));
        const body = JSON.parse(init?.body ?? '{}') as { events: Event[] };
        return Promise.resolve(Response.json(reply(body.events, calls.length)));
      };
      return { calls, fetch: fakeFetch as unknown as typeof fetch };
    }

    it('sends every event to the server with the key', async () => {
      const server = fakeServer((events) => ({
        accepted: events.map((e) => e.eventId),
        duplicates: [],
        rejected: [],
      }));
      expect(await runSeed(argv, context({ fetch: server.fetch }))).toBe(EXIT_OK);
      expect(server.calls[0]?.url).toBe('http://127.0.0.1:3100/api/v1/ingest/verify');
      expect(server.calls.every((c) => c.auth === 'Bearer secret')).toBe(true);
      expect(lines.join('\n')).toContain('projection failures not visible with --url');
      expect(existsSync(databasePath(join(dir, DEFAULT_SEED_DATA_DIR)))).toBe(false);
    });

    it('stops if the server already has the seed', async () => {
      const server = fakeServer((events) => ({
        accepted: [],
        duplicates: events.map((e) => e.eventId),
        rejected: [],
      }));
      expect(await runSeed(argv, context({ fetch: server.fetch }))).toBe(EXIT_FAILURE);
      expect(errors.join('\n')).toMatch(/Seed into an empty database/);
      expect(server.calls).toHaveLength(2);
    });

    it('stops if the key is not accepted', async () => {
      const fetch401 = (() => Promise.resolve(new Response(null, { status: 401 }))) as typeof fetch;
      expect(await runSeed(argv, context({ fetch: fetch401 }))).toBe(EXIT_FAILURE);
      expect(errors.join('\n')).toMatch(/did not accept the key/);
    });

    it('exits with 1 if events are rejected', async () => {
      const server = fakeServer((events, call) => ({
        accepted: events.slice(call === 2 ? 1 : 0).map((e) => e.eventId),
        duplicates: [],
        rejected:
          call === 2 ? [{ index: 0, eventId: events[0]?.eventId ?? null, error: 'x: bad' }] : [],
      }));
      expect(await runSeed(argv, context({ fetch: server.fetch }))).toBe(EXIT_FAILURE);
      expect(errors.join('\n')).toMatch(/rejected .* x: bad/);
    });
  });
});
