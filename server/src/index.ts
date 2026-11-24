import { buildApp } from './app.js';
import {
  EXIT_CONFIG,
  EXIT_INSTANCE_LOCKED,
  InstanceLockedError,
  OTHER_SERVER_HINT,
} from './backup/lock.js';
import { PreMigrateBackupError } from './backup/pre-migrate.js';
import { startupBanner } from './banner.js';
import { ConfigError, loadConfig, loadEnvFile, type Config } from './config.js';
import { openDataDir, type OpenedDataDir } from './open-data-dir.js';
import { databasePath } from './db/index.js';
import { WEB_DIST_DIR } from './paths.js';
import { assertLoginPossible, NoPasswordWithUsersError } from './users/users.js';
import { fileKeyStore } from './auth/secret-box.js';
import { twoFactorKeyWarnings } from './users/two-factor.js';
import { closeOnSignals } from './shutdown.js';
import { proxyConfigWarnings } from './proxy-warnings.js';
import { usePrivateUmask } from './fs-modes.js';
import { describeTightenResult, tightenWarnings } from './tighten-data-dir.js';

// Before anything creates a file: the database, its `-wal`, the backups and
// the 2FA key are for this user only.
usePrivateUmask();
loadEnvFile();

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(EXIT_CONFIG);
}

// Node reads TZ for local time; keep it in line with the validated value.
process.env.TZ = config.timeZone;

// Lock → private → backup before migrating → migrate → private (see open-data-dir.ts).
// The lock is one server per DATA_DIR, taken before anything touches the
// database (a second server on another branch must not migrate it). `pnpm cli
// restore` uses the same lock to see that the server runs. Held until the
// process exits (kept in a variable, so the connection is never garbage-collected).
let opened: OpenedDataDir;
try {
  opened = openDataDir({ dataDir: config.dataDir, backupDir: config.backup.dir });
} catch (error) {
  if (error instanceof InstanceLockedError) {
    console.error(
      `${error.message}\n${OTHER_SERVER_HINT}\n` +
        'Stop the other server first, or give this one another DATA_DIR.',
    );
    process.exit(EXIT_INSTANCE_LOCKED);
  }
  if (error instanceof PreMigrateBackupError) {
    console.error(`${error.message}\nNothing was migrated. Check BACKUP_DIR and try again.`);
    process.exit(1);
  }
  console.error(`Could not open the database at ${databasePath(config.dataDir)}:`, error);
  process.exit(1);
}
const {
  lock: instanceLock,
  database: db,
  dbFile,
  preMigrateBackup,
  permissions,
  removedRestoreFiles,
} = opened;

// Several users and no password: local mode would let anyone on this machine
// act as user 1. Fail closed.
try {
  assertLoginPossible(db.db);
} catch (error) {
  if (!(error instanceof NoPasswordWithUsersError)) throw error;
  console.error(error.message);
  db.close();
  instanceLock.release();
  process.exit(EXIT_CONFIG);
}

// Pending projections and the session timeout job start once the server listens.
const app = buildApp({ config, db, dbFile, jobs: true, webDir: WEB_DIST_DIR });
// Released only after the database is closed (and its WAL checkpointed).
app.addHook('onClose', () => {
  instanceLock.release();
});
closeOnSignals(app);

if (removedRestoreFiles.length > 0) {
  app.log.warn({ removed: removedRestoreFiles }, 'Removed files left by an interrupted restore');
}

if (preMigrateBackup !== undefined) {
  app.log.info({ file: preMigrateBackup }, 'Backup before migrating');
}

// Before listening, so ingest waits for it (the plugin retries).
if (db.upgrade) {
  app.log.info(
    {
      projections: db.upgrade.projections,
      ...db.upgrade.counts,
      durationMs: db.upgrade.durationMs,
    },
    'Recomputed projections after a rule change',
  );
}

// One line at every start, with a count and no paths: after an upgrade it shows
// that the existing files were made private.
app.log.info({ tightened: permissions.tightened }, describeTightenResult(permissions));
for (const warning of tightenWarnings(permissions)) app.log.warn(warning);

// Users with 2FA need the key file in DATA_DIR. Without it they can't log in;
// say so clearly, but start, so everyone else can.
for (const warning of twoFactorKeyWarnings(db.db, fileKeyStore(config.dataDir))) {
  app.log.warn(warning);
}

// A half-configured tunnel: TRUSTED_PROXY without login mode refuses everything
// that comes through it. Say so, but start.
for (const warning of proxyConfigWarnings(config, db.db)) app.log.warn(warning);

try {
  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { address, database: dbFile, backups: config.backup.dir, timeZone: config.timeZone },
    startupBanner(),
  );
} catch (error) {
  app.log.fatal({ err: error }, 'Could not start server');
  // Closes the database too, so the WAL is checkpointed before exiting.
  try {
    await app.close();
  } catch (closeError) {
    app.log.error({ err: closeError }, 'Could not close the server cleanly');
  }
  process.exit(1);
}
