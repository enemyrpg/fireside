import { createSecretBox, memoryKeyStore } from '../auth/secret-box.js';
import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { createSession } from '../auth/sessions.js';
import type { Database } from '../db/index.js';
import { auditLog, recoveryCodes, trustedDevices, users, userSessions } from '../db/schema.js';
import { rememberDevice } from '../auth/devices.js';
import { replaceRecoveryCodes } from '../users/two-factor.js';
import { eq } from 'drizzle-orm';
import { testConfig, testDatabase, UNUSED_BACKUPS } from '../test-utils.js';
import { hashPassword, verifyPassword } from '../users/password.js';
import { anyPasswordSet, findUserByUsername, listUsers } from '../users/users.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCliAsync } from './run.js';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const PASSWORD = 'correct horse battery';
const CHEAP = { memory: 64, passes: 1, parallelism: 1 };

describe('pnpm cli users', () => {
  let database: Database;
  let out: string[];
  let err: string[];
  /** Answers to password prompts, in order. */
  let input: (string | undefined)[];
  let prompts: string[];
  let interactive: boolean;

  beforeEach(() => {
    database = testDatabase();
    input = [];
    prompts = [];
    interactive = true;
  });
  afterEach(() => {
    database.close();
  });

  function run(...argv: string[]) {
    out = [];
    err = [];
    return runCliAsync(argv, {
      openDb: () => database.db,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      now: () => NOW,
      backups: UNUSED_BACKUPS,
      interactive,
      readPassword: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(input.shift());
      },
      hashPassword: (password) => hashPassword(password, CHEAP),
    });
  }

  const audit = () =>
    database.db
      .select({ action: auditLog.action, target: auditLog.target, actor: auditLog.actorUserId })
      .from(auditLog)
      .orderBy(asc(auditLog.id))
      .all();

  async function turnLoginOn() {
    input = [PASSWORD, PASSWORD];
    expect(await run('users', 'set-password', 'admin')).toBe(EXIT_OK);
  }

  it('list shows users without any password data', async () => {
    await turnLoginOn();
    expect(await run('users', 'list')).toBe(EXIT_OK);
    expect(out[0]).toMatch(
      /^ID\s+USERNAME\s+ROLE\s+PASSWORD\s+2FA\s+CREATED\s+LAST LOGIN\s+STATUS$/,
    );
    expect(out[1]).toMatch(/^1\s+admin\s+admin\s+yes\s+off\s+/);
    expect(out.join('\n')).not.toContain('argon2');
  });

  describe('reset-2fa', () => {
    it('turns 2FA off, ends sessions, forgets devices and recovery codes, audited as the operator', async () => {
      await turnLoginOn();
      database.db
        .update(users)
        .set({ totpSecret: 'v1:a:b:c', totpEnabledAt: NOW.toISOString(), totpLastStep: 5 })
        .where(eq(users.id, 1))
        .run();
      replaceRecoveryCodes(database.db, createSecretBox(memoryKeyStore()), 1, NOW);
      rememberDevice(database.db, 1, undefined, NOW);
      createSession(database.db, 1, { now: NOW });

      expect(await run('users', 'reset-2fa', 'Admin')).toBe(EXIT_OK);
      expect(out.join('\n')).toContain('Two-factor authentication is off for "admin"');
      expect(findUserByUsername(database.db, 'admin')).toMatchObject({
        totpSecret: null,
        totpEnabledAt: null,
        totpLastStep: null,
      });
      expect(database.db.select().from(recoveryCodes).all()).toEqual([]);
      expect(database.db.select().from(trustedDevices).all()).toEqual([]);
      expect(database.db.select().from(userSessions).all()).toEqual([]);
      expect(audit().at(-1)).toEqual({ action: 'user.totp_reset', target: 'user:1', actor: null });
      // The password is kept.
      expect(anyPasswordSet(database.db)).toBe(true);
    });

    it('says so when 2FA is off, and fails for an unknown user', async () => {
      expect(await run('users', 'reset-2fa', 'admin')).toBe(EXIT_OK);
      expect(out.join('\n')).toContain('does not have two-factor authentication on');
      expect(await run('users', 'reset-2fa', 'nobody')).toBe(EXIT_FAILURE);
      expect(await run('users', 'reset-2fa')).toBe(EXIT_USAGE);
    });
  });

  describe('set-password', () => {
    it('asks twice, turns login on, ends sessions and hints at rename', async () => {
      createSession(database.db, 1, { now: NOW });
      input = [PASSWORD, PASSWORD];
      expect(await run('users', 'set-password', 'Admin')).toBe(EXIT_OK);
      expect(prompts).toEqual(['New password: ', 'Repeat it: ']);
      expect(anyPasswordSet(database.db)).toBe(true);
      expect(database.db.select().from(userSessions).all()).toEqual([]);
      expect(out.join('\n')).toContain('Login is now on');
      expect(out.join('\n')).toContain('pnpm cli users rename admin <name>');
      const hash = findUserByUsername(database.db, 'admin')?.passwordHash ?? '';
      expect(await verifyPassword(PASSWORD, hash)).toBe(true);
      expect(audit()).toEqual([{ action: 'user.set_password', target: 'user:1', actor: null }]);
    });

    it('reads one line without confirmation when not at a terminal', async () => {
      interactive = false;
      input = [PASSWORD];
      expect(await run('users', 'set-password', 'admin')).toBe(EXIT_OK);
      expect(prompts).toHaveLength(1);
    });

    it.each([
      [['too short', 'too short'], 'Use at least 12 characters'],
      [[PASSWORD, 'something else!!'], 'did not match'],
      [[undefined], 'No password given'],
    ])('refuses %j and changes nothing', async (answers, message) => {
      input = answers;
      expect(await run('users', 'set-password', 'admin')).toBe(EXIT_FAILURE);
      expect(err.join('\n')).toContain(message);
      expect(anyPasswordSet(database.db)).toBe(false);
      expect(audit()).toEqual([]);
    });

    it('reports an unknown user', async () => {
      expect(await run('users', 'set-password', 'nobody')).toBe(EXIT_FAILURE);
      expect(err[0]).toContain('No user named "nobody"');
    });
  });

  describe('create', () => {
    it('is refused in local mode, so local mode never has two users', async () => {
      input = [PASSWORD, PASSWORD];
      expect(await run('users', 'create', 'friend')).toBe(EXIT_FAILURE);
      expect(err[0]).toBe('Login is off. Set a password first: pnpm cli users set-password admin');
      expect(listUsers(database.db)).toHaveLength(1);
      expect(prompts).toEqual([]);
    });

    it('adds a member or an admin with a password', async () => {
      await turnLoginOn();
      input = ['friends password', 'friends password'];
      expect(await run('users', 'create', 'Friend')).toBe(EXIT_OK);
      input = ['another password', 'another password'];
      expect(await run('users', 'create', '--admin', 'second.admin')).toBe(EXIT_OK);
      expect(
        listUsers(database.db).map(({ id, username, role }) => ({ id, username, role })),
      ).toEqual([
        { id: 1, username: 'admin', role: 'admin' },
        { id: 2, username: 'friend', role: 'member' },
        { id: 3, username: 'second.admin', role: 'admin' },
      ]);
      expect(audit().slice(1)).toEqual([
        { action: 'user.create', target: 'user:2', actor: null },
        { action: 'user.create', target: 'user:3', actor: null },
      ]);
    });

    it.each([[['ab']], [['a b']], [['Ünicode']], [['x'.repeat(33)]], [[]], [['a1', 'b2']]])(
      'rejects the username %j',
      async (args) => {
        await turnLoginOn();
        expect(await run('users', 'create', ...args)).toBe(EXIT_USAGE);
        expect(listUsers(database.db)).toHaveLength(1);
      },
    );

    it('rejects a taken username before asking for a password', async () => {
      await turnLoginOn();
      prompts = [];
      expect(await run('users', 'create', 'ADMIN')).toBe(EXIT_FAILURE);
      expect(err[0]).toBe('That username is taken');
      expect(prompts).toEqual([]);
    });

    it('a user made with users create can log in and use the dashboard as a member', async () => {
      await turnLoginOn();
      input = ['friends password', 'friends password'];
      expect(await run('users', 'create', 'friend')).toBe(EXIT_OK);

      const app = buildApp({ db: database, config: testConfig() });
      try {
        const headers = { host: 'localhost:3100', origin: 'http://localhost:3100' };
        const login = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username: 'friend', password: 'friends password' },
          headers,
        });
        expect(login.statusCode).toBe(200);
        const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
        expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
        const keys = await app.inject({ url: '/api/v1/keys', headers: { ...headers, cookie } });
        expect(keys.statusCode).toBe(200);
        expect(keys.json()).toEqual({ keys: [] });
        const rebuild = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/rebuild',
          headers: { ...headers, cookie },
        });
        expect(rebuild.statusCode).toBe(403);
      } finally {
        // The app owns the database: it closes it.
        await app.close();
        database = testDatabase();
      }
    });
  });

  describe('rename', () => {
    it('renames with the same rules and logs it', async () => {
      expect(await run('users', 'rename', 'admin', ' Robin ')).toBe(EXIT_OK);
      expect(findUserByUsername(database.db, 'robin')?.id).toBe(1);
      expect(audit()).toEqual([{ action: 'user.rename', target: 'user:1', actor: null }]);
    });

    it('refuses a taken, invalid or missing name', async () => {
      await turnLoginOn();
      input = ['friends password', 'friends password'];
      await run('users', 'create', 'friend');
      expect(await run('users', 'rename', 'admin', 'friend')).toBe(EXIT_FAILURE);
      expect(err[0]).toBe('That username is taken');
      expect(await run('users', 'rename', 'admin', 'no spaces')).toBe(EXIT_USAGE);
      expect(await run('users', 'rename', 'admin')).toBe(EXIT_USAGE);
      expect(await run('users', 'rename', 'ghost', 'someone')).toBe(EXIT_FAILURE);
      expect(findUserByUsername(database.db, 'admin')).toBeDefined();
    });
  });

  describe('clear-password', () => {
    it('goes back to local mode with one user', async () => {
      await turnLoginOn();
      expect(await run('users', 'clear-password', 'admin')).toBe(EXIT_OK);
      expect(anyPasswordSet(database.db)).toBe(false);
      expect(audit().at(-1)).toEqual({
        action: 'user.clear_password',
        target: 'user:1',
        actor: null,
      });
    });

    it('is refused while there is more than one user', async () => {
      await turnLoginOn();
      input = ['friends password', 'friends password'];
      await run('users', 'create', 'friend');
      expect(await run('users', 'clear-password', 'admin')).toBe(EXIT_FAILURE);
      expect(err[0]).toBe("Login can't be turned off while there is more than one user.");
      expect(anyPasswordSet(database.db)).toBe(true);
    });
  });

  it('prints usage for unknown commands and help', async () => {
    expect(await run('users')).toBe(EXIT_USAGE);
    expect(await run('users', 'delete', 'x')).toBe(EXIT_USAGE);
    expect(err[0]).toBe('Unknown command: users delete');
    expect(await run('users', '--help')).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('pnpm cli users set-password <name>');
    expect(await run('users', 'list', 'extra')).toBe(EXIT_USAGE);
  });

  it('runs the other commands as before', async () => {
    expect(await run('keys', 'list')).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('No API keys yet');
  });
});
