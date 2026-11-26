import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRANDING } from '@fireside/shared';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock, InstanceLockedError } from '../backup/lock.js';
import { migrationsWithExtra, tempDir } from '../backup/testing.js';
import { databasePath, openDatabase } from '../db/index.js';
import { projectionUpgrade } from '../projections/versions.js';
import { CliDataDir } from './database.js';
import { CliError } from './run.js';

const tableExists = (file: string, name: string) => {
  const sqlite = new BetterSqlite3(file, { readonly: true });
  try {
    return sqlite.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined;
  } finally {
    sqlite.close();
  }
};

describe('CLI and the instance lock', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  function setup({ withDatabase = true } = {}) {
    const { dir, remove } = tempDir();
    cleanups.push(remove);
    const dataDir = join(dir, 'data');
    // As a server leaves it: migrated, with the current projection versions.
    if (withDatabase) {
      openDatabase(databasePath(dataDir), { upgrade: projectionUpgrade() }).close();
    }
    const log: string[] = [];
    const cli = (migrationsFolder?: string) => {
      const claim = new CliDataDir(
        dataDir,
        (line) => log.push(line),
        migrationsFolder ? { migrationsFolder } : {},
      );
      cleanups.push(() => {
        claim.release();
      });
      return claim;
    };
    return { dir, dataDir, file: databasePath(dataDir), log, cli };
  }

  function serverHoldsLock(dataDir: string) {
    const lock = acquireInstanceLock(dataDir);
    cleanups.push(() => {
      lock.release();
    });
  }

  describe('without a running server', () => {
    it('takes the lock and holds it until released, so a server can not start meanwhile', () => {
      const { dataDir, cli } = setup();
      const claim = cli();
      const database = claim.open({ create: false });
      expect(() => acquireInstanceLock(dataDir)).toThrow(InstanceLockedError);
      database.close();
      claim.release();
      acquireInstanceLock(dataDir).release();
    });

    it('applies pending migrations', () => {
      const { dir, file, cli } = setup();
      cli(migrationsWithExtra(dir)).open({ create: false }).close();
      expect(tableExists(file, 'future_feature')).toBe(true);
    });

    it('copies the database before migrating it, in BACKUP_DIR', () => {
      const { dir, file, log } = setup();
      const backupDir = join(dir, 'my-backups');
      const claim = new CliDataDir(join(dir, 'data'), (line) => log.push(line), {
        migrationsFolder: migrationsWithExtra(dir),
        backupDir,
      });
      cleanups.push(() => {
        claim.release();
      });
      claim.open({ create: false }).close();

      const [copy, ...others] = readdirSync(backupDir);
      expect(others).toEqual([]);
      expect(copy).toMatch(new RegExp(`^${BRANDING.shortName}-pre-migrate-\\d{8}-\\d{6}Z\\.db$`));
      expect(log).toContain(`Backup before migrating: ${join(backupDir, copy ?? '')}`);
      expect(tableExists(join(backupDir, copy ?? ''), 'future_feature')).toBe(false);
      expect(tableExists(file, 'future_feature')).toBe(true);
    });

    it('does not migrate when the copy fails', () => {
      const { dir, file, cli } = setup();
      const backupDir = join(dir, 'data', 'backups');
      writeFileSync(backupDir, 'not a folder');
      const claim = cli(migrationsWithExtra(dir));
      expect(() => claim.open({ create: false })).toThrow(/Nothing was migrated/);
      expect(tableExists(file, 'future_feature')).toBe(false);
    });

    it('removes what an interrupted restore left in DATA_DIR, and says so', () => {
      const { dataDir, log, cli } = setup();
      const leftover = join(dataDir, `.${BRANDING.shortName}.db.restore-gunzip-tmp`);
      writeFileSync(leftover, 'half a database');
      cli().open({ create: false }).close();
      expect(existsSync(leftover)).toBe(false);
      expect(log).toContain(
        `Removed files left by an interrupted restore: .${BRANDING.shortName}.db.restore-gunzip-tmp`,
      );
    });

    it('creates the database only when allowed', () => {
      const { file, cli } = setup({ withDatabase: false });
      const first = cli();
      expect(() => first.open({ create: false })).toThrow(/No database at/);
      expect(existsSync(file)).toBe(false);
      first.release();
      cli().open({ create: true }).close();
      expect(existsSync(file)).toBe(true);
    });
  });

  describe('while a server holds the lock', () => {
    it('opens an up-to-date database without the lock', () => {
      const { dataDir, file, log, cli } = setup();
      serverHoldsLock(dataDir);
      const claim = cli();
      expect(claim.claim()).toBe(true);
      claim.open({ create: false }).close();
      expect(log).toEqual([`Database: ${file} (in use by a running server)`]);
    });

    it('leaves restore temp files alone: without the lock a restore may be running', () => {
      const { dataDir, cli } = setup();
      const temp = join(dataDir, `.${BRANDING.shortName}.db.restore-gunzip-tmp`);
      writeFileSync(temp, 'x');
      serverHoldsLock(dataDir);
      cli().open({ create: false }).close();
      expect(existsSync(temp)).toBe(true);
    });

    it('refuses to migrate the database under the server', () => {
      const { dir, dataDir, file, cli } = setup();
      serverHoldsLock(dataDir);
      const claim = cli(migrationsWithExtra(dir));
      expect(() => claim.open({ create: false })).toThrow(CliError);
      expect(() => claim.open({ create: false })).toThrow(/Stop the server/);
      expect(tableExists(file, 'future_feature')).toBe(false);
    });

    it('refuses a database built with older projection rules', () => {
      const { dataDir, file, cli } = setup();
      // As the previous version left it: no projection versions stored.
      const old = openDatabase(file);
      old.sqlite.exec('DELETE FROM projection_versions');
      old.close();
      serverHoldsLock(dataDir);
      const claim = cli();
      expect(() => claim.open({ create: false })).toThrow(/older projection rules/);
      expect(() => claim.open({ create: false })).toThrow(/Stop the server/);
    });
  });

  it('recomputes a database built with older projection rules when it holds the lock', () => {
    const { file, log, cli } = setup();
    const old = openDatabase(file);
    old.sqlite.exec('DELETE FROM projection_versions');
    old.close();
    cli().open({ create: false }).close();
    expect(log).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Backup before migrating: /),
        expect.stringMatching(
          /^Recomputed sessions, kc, raid-special-loot after a rule change in \d+ ms\.$/,
        ),
      ]),
    );
  });
});
