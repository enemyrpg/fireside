import { BRANDING } from '@fireside/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createApiKey,
  findApiKey,
  keyRevokedBy,
  listApiKeys,
  MAX_ACTIVE_KEYS_PER_USER,
  ownKey,
} from '../auth/api-keys.js';
import { auditLog, users } from '../db/schema.js';
import { createUser, FIRST_USER_ID } from '../users/users.js';
import { InvalidDatabaseFileError } from '../backup/backup.js';
import { InstanceLockedError } from '../backup/lock.js';
import { RestoreError } from '../backup/restore.js';
import type { Database } from '../db/index.js';
import { failedEvents, PROJECTIONS, type Projection } from '../projections/index.js';
import { eventFactory, failingFor, ingestBatch, storeOnly } from '../projections/testing.js';
import { testDatabase, UNUSED_BACKUPS, TEST_OWNER } from '../test-utils.js';
import {
  CliError,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  formatBytes,
  runCli,
  type CliContext,
  type OpenDbOptions,
} from './run.js';

const N = BRANDING.shortName;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const KEY_IN_TEXT = new RegExp(`${escape(BRANDING.apiKeyPrefix)}[0-9A-Za-z]{43}`, 'g');

describe('pnpm cli', () => {
  let database: Database;
  let out: string[];
  let err: string[];
  let opened: OpenDbOptions[];
  let failOpen: string | undefined;
  let projections: readonly Projection[] | undefined;
  let backups: CliContext['backups'];
  const now = new Date('2026-11-09T12:00:00.000Z');

  beforeEach(() => {
    database = testDatabase();
    out = [];
    err = [];
    opened = [];
    failOpen = undefined;
    projections = undefined;
    backups = UNUSED_BACKUPS;
  });
  afterEach(() => {
    database.close();
  });

  function run(...argv: string[]) {
    out = [];
    err = [];
    opened = [];
    return runCli(argv, {
      openDb: (options) => {
        opened.push(options);
        if (failOpen !== undefined) throw new CliError(failOpen);
        return database.db;
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      now: () => now,
      backups,
      ...(projections ? { projections } : {}),
    });
  }

  /** Stores three events of one closed session (not projected), returns them. */
  function storeSession() {
    const f = eventFactory();
    const events = [f.sessionStart('19:00'), f.loot('19:05'), f.sessionEnd('19:10')];
    const { id } = createApiKey(database.db, TEST_OWNER, 'Test');
    storeOnly({ database, apiKeyId: id, failed: [] }, events);
    return events;
  }

  function createKey(name: string): string {
    expect(run('keys', 'create', name)).toBe(EXIT_OK);
    const keys = out.join('\n').match(KEY_IN_TEXT) ?? [];
    expect(keys).toHaveLength(1);
    return keys[0] ?? '';
  }

  it('keys create prints the full key exactly once', () => {
    const key = createKey('Gaming PC');
    expect(out.join('\n')).toContain('cannot be shown again');
    expect(err).toEqual([]);
    expect(findApiKey(database.db, key)).toMatchObject({
      status: 'active',
      row: { name: 'Gaming PC' },
    });
  });

  it('keys create joins unquoted words and trims the name', () => {
    expect(run('keys', 'create', ' Gaming', 'PC ')).toBe(EXIT_OK);
    expect(out[0]).toContain('"Gaming PC"');
  });

  it.each([[[]], [['   ']], [['x'.repeat(101)]], [['PC\n2  evil']], [['PC\u001b[2K']]])(
    'keys create rejects the name %j',
    (args) => {
      expect(run('keys', 'create', ...args)).toBe(EXIT_USAGE);
      expect(out).toEqual([]);
      expect(run('keys', 'list')).toBe(EXIT_OK);
      expect(out.join('\n')).toContain('No API keys yet');
    },
  );

  it.each([
    [['Laptop', '-h'], 'Laptop -h'],
    [['-laptop'], '-laptop'],
    [['--help', 'PC'], '--help PC'],
  ])('keys create treats %j as a name, not options', (args, name) => {
    expect(run('keys', 'create', ...args)).toBe(EXIT_OK);
    expect(out[0]).toContain(`"${name}"`);
  });

  it('keys list shows metadata but never the key', () => {
    const key = createKey('Gaming PC');
    createKey('Laptop');
    expect(run('keys', 'list')).toBe(EXIT_OK);
    const text = out.join('\n');
    expect(text).toContain('Gaming PC');
    expect(text).toContain('Laptop');
    expect(text).toContain(`${key.slice(0, BRANDING.apiKeyPrefix.length + 4)}…`);
    expect(text).toContain('never');
    expect(text).not.toContain(key);
    expect(text.match(KEY_IN_TEXT)).toBeNull();
  });

  describe('with several users', () => {
    let ola: number;
    beforeEach(() => {
      ola = createUser(database.db, 'ola', { now });
    });
    const ownerOf = (key: string) => {
      const found = findApiKey(database.db, key);
      return found.status === 'active' ? found.row : undefined;
    };
    const keyIn = (text: string) => text.match(KEY_IN_TEXT)?.[0] ?? '';

    it.each([
      [['--user', 'ola', 'Gaming', 'PC']],
      [['Gaming', 'PC', '--user', 'Ola']],
      [['--user=ola', 'Gaming', 'PC']],
      [['Gaming', 'PC', '--user=ola']],
    ])('keys create %j makes a key for that user, made by the server', (args) => {
      expect(run('keys', 'create', ...args)).toBe(EXIT_OK);
      expect(out[0]).toContain('"Gaming PC"');
      expect(out[0]).toContain('for user "ola"');
      expect(ownerOf(keyIn(out.join('\n')))).toMatchObject({
        userId: ola,
        createdByUserId: null,
      });
      expect(
        database.db
          .select()
          .from(auditLog)
          .all()
          .map((row) => [row.action, row.actorUserId]),
      ).toEqual([['key.create', null]]);
    });

    it('keys create needs --user when there are several users', () => {
      expect(run('keys', 'create', 'PC')).toBe(EXIT_FAILURE);
      expect(err.join('\n')).toContain('--user <username>');
      expect(listApiKeys(database.db)).toEqual([]);
    });

    it('keys create refuses an unknown or deactivated user, and a missing name after --user', () => {
      expect(run('keys', 'create', 'PC', '--user', 'kari')).toBe(EXIT_FAILURE);
      expect(err.join('\n')).toContain('No user named "kari"');
      database.db
        .update(users)
        .set({ disabledAt: now.toISOString() })
        .where(eq(users.id, ola))
        .run();
      expect(run('keys', 'create', 'PC', '--user', 'ola')).toBe(EXIT_FAILURE);
      expect(err.join('\n')).toContain('deactivated');
      expect(run('keys', 'create', '--user=')).toBe(EXIT_USAGE);
      expect(listApiKeys(database.db)).toEqual([]);
    });

    it('keys create stops at the limit, which counts every active key of the user', () => {
      for (let i = 0; i < MAX_ACTIVE_KEYS_PER_USER; i += 1) {
        createApiKey(database.db, ownKey(ola), `PC ${String(i)}`);
      }
      expect(run('keys', 'create', 'One more', '--user', 'ola')).toBe(EXIT_FAILURE);
      expect(err.join('\n')).toContain('maximum of active API keys');
      expect(listApiKeys(database.db, ola)).toHaveLength(MAX_ACTIVE_KEYS_PER_USER);
    });

    it('keys list shows owner, creator and who revoked', () => {
      createApiKey(database.db, ownKey(FIRST_USER_ID), 'Admin PC');
      const theirs = createApiKey(
        database.db,
        { userId: ola, createdByUserId: FIRST_USER_ID },
        'Ola PC',
      );
      expect(run('keys', 'revoke', String(theirs.id))).toBe(EXIT_OK);
      expect(run('keys', 'list')).toBe(EXIT_OK);
      const [header, mine, olas] = out;
      expect(header).toMatch(/^ID\s+OWNER\s+NAME\s+PREFIX\s+CREATED\s+BY\s+LAST USED\s+STATUS$/);
      expect(mine).toMatch(/^1\s+admin\s+Admin PC\s.*\sadmin\s+never\s+active$/);
      expect(olas).toMatch(/^2\s+ola\s+Ola PC\s.*\sadmin\s+never\s+revoked \S+ by -$/);
    });

    it('keys revoke is made by the server: the owner sees “admin”', () => {
      const { id } = createApiKey(database.db, ownKey(ola), 'Ola PC');
      expect(run('keys', 'revoke', String(id))).toBe(EXIT_OK);
      const [row] = listApiKeys(database.db, ola);
      expect(row && keyRevokedBy(row)).toBe('admin');
      expect(
        database.db
          .select()
          .from(auditLog)
          .all()
          .map((r) => [r.action, r.actorUserId, r.target]),
      ).toEqual([
        ['key.create', ola, `key:${String(id)}`],
        ['key.revoke', null, `key:${String(id)}`],
      ]);
    });
  });

  it('keys list says so when there are no keys', () => {
    expect(run('keys', 'list')).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('No API keys yet');
  });

  it('keys revoke revokes the key', () => {
    const key = createKey('PC');
    const found = findApiKey(database.db, key);
    if (found.status !== 'active') throw new Error('expected an active key');

    expect(run('keys', 'revoke', String(found.row.id))).toBe(EXIT_OK);
    expect(findApiKey(database.db, key)).toMatchObject({ status: 'revoked' });

    expect(run('keys', 'revoke', String(found.row.id))).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('already revoked');

    expect(run('keys', 'list')).toBe(EXIT_OK);
    expect(out.join('\n')).toContain(`revoked ${now.toISOString()}`);
  });

  it('keys revoke fails for an unknown id', () => {
    expect(run('keys', 'revoke', '42')).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain('No API key with ID 42');
  });

  it.each([
    [[]],
    [['nope']],
    [['keys']],
    [['keys', 'nope']],
    [['keys', 'list', 'extra']],
    [['keys', 'revoke']],
    [['keys', 'revoke', 'abc']],
    [['keys', 'revoke', '0']],
    [['keys', 'revoke', '1', '2']],
    [['kyes', '--help']],
    [['keys', 'nope', '--help']],
    [['rebuild', 'now']],
    [['reprocess', 'all']],
    [['rebuild', '--help', 'x']],
    [['backup', 'now']],
    [['restore']],
    [['restore', 'a.db', 'b.db']],
  ])('prints usage for %j', (argv) => {
    expect(run(...argv)).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('Usage:');
  });

  it.each([
    [['--help']],
    [['-h']],
    [['keys', '--help']],
    [['keys', 'create', '-h']],
    [['keys', 'list', '--help']],
    [['keys', 'revoke', '--help']],
    [['rebuild', '--help']],
    [['reprocess', '-h']],
    [['backup', '--help']],
    [['restore', '-h']],
  ])('%j prints usage without creating a key', (argv) => {
    expect(run(...argv)).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('pnpm cli keys create <name>');
    expect(run('keys', 'list')).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('No API keys yet');
  });

  describe('database access', () => {
    it('only keys create may create a missing database', () => {
      createKey('PC');
      expect(opened).toEqual([{ create: true }]);
      run('keys', 'list');
      expect(opened).toEqual([{ create: false }]);
      run('keys', 'revoke', '1');
      expect(opened).toEqual([{ create: false }]);
      run('rebuild');
      expect(opened).toEqual([{ create: false }]);
      run('reprocess');
      expect(opened).toEqual([{ create: false }]);
    });

    it.each([
      [['--help']],
      [['nope']],
      [['keys', 'list', 'extra']],
      [['keys', 'revoke', 'abc']],
      [['keys', 'create']],
      [['keys', 'create', 'PC\u001b[2K']],
      [['rebuild', 'x']],
      [['rebuild', '--help']],
      [['backup', '--help']],
      [['restore']],
    ])('%j never opens the database', (argv) => {
      run(...argv);
      expect(opened).toEqual([]);
    });

    it('reports a database that cannot be opened and exits 1', () => {
      failOpen = 'No database at /wrong/path.db';
      expect(run('keys', 'list')).toBe(EXIT_FAILURE);
      expect(err).toEqual(['No database at /wrong/path.db']);
      expect(out).toEqual([]);
    });
  });

  describe('rebuild and reprocess', () => {
    it('rebuild projects every event and reports count and time', () => {
      storeSession();
      expect(run('rebuild')).toBe(EXIT_OK);
      expect(out).toEqual([
        expect.stringMatching(/^Rebuilt derived tables from 3 events in \d+ ms\.$/),
      ]);
      expect(err).toEqual([]);
      expect(failedEvents(database.db)).toEqual([]);
    });

    it('rebuild works on an empty database', () => {
      expect(run('rebuild')).toBe(EXIT_OK);
      expect(out[0]).toMatch(/^Rebuilt derived tables from 0 events in \d+ ms\.$/);
    });

    it('rebuild lists failed events without payloads and exits 1', () => {
      const events = storeSession();
      const loot = events[1];
      projections = [...PROJECTIONS, failingFor(new Set([loot?.eventId ?? '']))];

      expect(run('rebuild')).toBe(EXIT_FAILURE);
      expect(out[0]).toMatch(/from 3 events/);
      expect(err).toEqual([
        '1 event failed. Their raw data is kept:',
        `  ${loot?.eventId ?? ''}  loot  test-failure: simulated failure`,
        'After fixing the cause, retry them with: pnpm cli reprocess',
      ]);
      expect(err.join('\n')).not.toContain('Vorkath');
    });

    it('reprocess retries failed events only', () => {
      const f = eventFactory();
      const events = [f.sessionStart('19:00'), f.loot('19:05'), f.sessionEnd('19:10')];
      const { id } = createApiKey(database.db, TEST_OWNER, 'Test');
      const testRun = { database, apiKeyId: id, failed: [] };
      ingestBatch(testRun, events, [
        ...PROJECTIONS,
        failingFor(new Set([events[1]?.eventId ?? ''])),
      ]);
      expect(failedEvents(database.db)).toHaveLength(1);

      expect(run('reprocess')).toBe(EXIT_OK);
      expect(out).toEqual([
        expect.stringMatching(/^Retried 1 failed event in \d+ ms: 1 succeeded\.$/),
      ]);
      expect(failedEvents(database.db)).toEqual([]);

      expect(run('reprocess')).toBe(EXIT_OK);
      expect(out).toEqual(['No failed events to retry.']);
    });
  });

  describe('backup and restore', () => {
    const backupResult = {
      fileName: `${N}-20261109-120000Z.db`,
      path: `/data/backups/${N}-20261109-120000Z.db`,
      createdAt: now,
      sizeBytes: 1_500_000,
      durationMs: 42,
      count: 3,
      totalSizeBytes: 4_200_000,
      deleted: [`${N}-20261101-040000Z.db`],
    };
    const restoreResult = {
      backupCreatedAt: new Date('2026-11-08T04:00:00.000Z'),
      migrationsApplied: 0,
      previousSavedTo: `/data/backups/${N}-pre-restore-20261109-120000Z.db`,
      previousRawCopy: false,
      dbFile: `/data/${N}.db`,
    };

    it('backup reports the file, size and what is kept', () => {
      backups = { ...UNUSED_BACKUPS, create: () => backupResult };
      expect(run('backup')).toBe(EXIT_OK);
      expect(out).toEqual([
        `Backup saved: /data/backups/${N}-20261109-120000Z.db (1.5 MB, 42 ms).`,
        '3 backups kept (4.2 MB). Deleted 1 old backup.',
        'Backups on the same disk do not survive a disk failure: copy them elsewhere too.',
      ]);
    });

    it('backup reports a missing database and exits 1', () => {
      backups = {
        ...UNUSED_BACKUPS,
        create: () => {
          throw new CliError(`No database at /wrong/${N}.db.`);
        },
      };
      expect(run('backup')).toBe(EXIT_FAILURE);
      expect(err).toEqual([`No database at /wrong/${N}.db.`]);
    });

    it('restore passes the file on and says what happened', () => {
      const files: string[] = [];
      backups = {
        ...UNUSED_BACKUPS,
        restore: (file) => (files.push(file), { ...restoreResult, migrationsApplied: 2 }),
      };
      expect(run('restore', `${N}-20261108-040000Z.db`)).toBe(EXIT_OK);
      expect(files).toEqual([`${N}-20261108-040000Z.db`]);
      expect(out).toEqual([
        `Restored ${N}-20261108-040000Z.db (taken 2026-11-08T04:00:00.000Z) to /data/${N}.db.`,
        'The backup was from an older version: applied 2 migrations.',
        `The previous database was saved as /data/backups/${N}-pre-restore-20261109-120000Z.db.`,
        'Start the server again.',
      ]);
    });

    it('restore explains how to stop a running server', () => {
      backups = {
        ...UNUSED_BACKUPS,
        restore: () => {
          throw new InstanceLockedError(`${BRANDING.displayName} is already running on /data.`);
        },
      };
      expect(run('restore', 'x.db')).toBe(EXIT_FAILURE);
      expect(err[0]).toBe(`${BRANDING.displayName} is already running on /data.`);
      expect(err.join('\n')).toContain('docker compose stop');
      expect(out).toEqual([]);
    });

    it.each([
      new RestoreError('Nothing was changed. x.db failed the integrity check'),
      new InvalidDatabaseFileError('x.db is not an SQLite database'),
    ])('restore reports %s and exits 1', (error) => {
      backups = {
        ...UNUSED_BACKUPS,
        restore: () => {
          throw error;
        },
      };
      expect(run('restore', 'x.db')).toBe(EXIT_FAILURE);
      expect(err).toEqual([error.message]);
    });
  });

  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1000, '1.0 kB'],
    [812_345, '812 kB'],
    [18_874_368, '19 MB'],
    [2_500_000_000, '2.5 GB'],
  ])('formatBytes(%d) is %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});
