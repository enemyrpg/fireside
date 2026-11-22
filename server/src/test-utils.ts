import { ownKey, type KeyOwner } from './auth/api-keys.js';
import type { CliContext } from './cli/run.js';
import { loadConfig, type Config } from './config.js';
import { openDatabase, type Database } from './db/index.js';
import { FIRST_USER_ID } from './users/users.js';

/** Default config with logging off, plus `env` overrides (as raw env strings). */
export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ LOG_LEVEL: 'silent', ...env });
}

/** A fresh, migrated in-memory database. Tests never touch the real file in `DATA_DIR`. */
export function testDatabase(): Database {
  return openDatabase(':memory:');
}

/** `backups` for CLI tests that don't run `backup` or `restore`. */
export const UNUSED_BACKUPS: CliContext['backups'] = {
  create: () => {
    throw new Error('backup is not used in this test');
  },
  restore: () => {
    throw new Error('restore is not used in this test');
  },
};

/** Owner of keys in tests: user 1, the admin every database has. */
export const TEST_OWNER: KeyOwner = ownKey(FIRST_USER_ID);
