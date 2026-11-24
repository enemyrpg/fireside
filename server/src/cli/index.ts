import { systemClock } from '../auth/api-keys.js';
import { createBackup } from '../backup/backup.js';
import { restoreBackup } from '../backup/restore.js';
import { ConfigError, loadConfig, loadEnvFile, type Config } from '../config.js';
import { databasePath, type Database } from '../db/index.js';
import { usePrivateUmask } from '../fs-modes.js';
import { resolveBackupFile } from './backup-file.js';
import { CliDataDir } from './database.js';
import { readPassword, stdinIsTerminal } from './password-input.js';
import { runCliAsync, type OpenDbOptions } from './run.js';

// Entry point for `pnpm cli`. Uses the same `.env` and database as the server.

// What the CLI creates (a database, backups, the copy before a restore) is
// for this user only, like the server's files.
usePrivateUmask();
loadEnvFile();

let config: Config;
let dataDir: string;
let dbFile: string;
try {
  config = loadConfig();
  dataDir = config.dataDir;
  dbFile = databasePath(dataDir);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

// Takes the instance lock when a command first needs the database (see database.ts).
// `restore` takes it itself.
const dir = new CliDataDir(
  dataDir,
  (line) => {
    console.error(line);
  },
  { backupDir: config.backup.dir },
);
let database: Database | undefined;

function openDb(options: OpenDbOptions) {
  database ??= dir.open(options);
  return database.db;
}

try {
  process.exitCode = await runCliAsync(process.argv.slice(2), {
    openDb,
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
    now: systemClock,
    readPassword,
    interactive: stdinIsTerminal(),
    backups: {
      create: () => {
        dir.prepare({ create: false });
        return createBackup({
          dbFile,
          dir: config.backup.dir,
          keep: config.backup.keep,
          timeZone: config.timeZone,
        });
      },
      restore: (file) => {
        const path = resolveBackupFile(
          file,
          process.env.INIT_CWD ?? process.cwd(),
          config.backup.dir,
        );
        console.error(`Backup: ${path}`);
        console.error(`Database: ${dbFile}`);
        return restoreBackup({ file: path, dataDir, backupDir: config.backup.dir });
      },
    },
  });
} finally {
  // The database first, so its WAL is checkpointed before a server can start.
  database?.close();
  dir.release();
}
