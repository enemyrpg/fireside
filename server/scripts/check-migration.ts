// Checks a pending migration on a copy of a real database:
//   pnpm --filter @fireside/server check-migration <db-file> [<work-dir>]
// The original is only opened read-only: it is copied with `VACUUM INTO`
// (safe while a server uses it, like a backup), and the copy is migrated,
// compared and rebuilt. The copy goes in <work-dir> (default: a new temp
// folder) and is left there for inspection. Exit code 0 when every check
// passes, 1 otherwise.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { checkMigration, formatMigrationReport } from '../src/db/migration-check.js';
import { countPendingMigrations } from '../src/db/index.js';

const [source, workDir] = process.argv.slice(2);
if (source === undefined) {
  console.error('Usage: check-migration <db-file> [<work-dir>]');
  process.exit(2);
}
const sourcePath = resolve(process.env.INIT_CWD ?? process.cwd(), source);
const dir = workDir
  ? resolve(process.env.INIT_CWD ?? process.cwd(), workDir)
  : mkdtempSync(join(tmpdir(), 'check-migration-'));
mkdirSync(dir, { recursive: true });
const copy = join(dir, `${basename(sourcePath, '.db')}-copy-${String(Date.now())}.db`);

// A read-only connection to a WAL database that nothing else has open
// leaves an empty `-wal` and `-shm` behind. Remove them if they weren't
// there before, so the original folder looks exactly as it did.
const sideFiles = ['-wal', '-shm'].map((suffix) => sourcePath + suffix);
const existedBefore = new Set(sideFiles.filter((file) => existsSync(file)));
const original = new BetterSqlite3(sourcePath, {
  readonly: true,
  fileMustExist: true,
  timeout: 5000,
});
let pending: number;
try {
  pending = countPendingMigrations(original);
  original.prepare('VACUUM INTO ?').run(copy);
} finally {
  original.close();
  const wal = `${sourcePath}-wal`;
  if (!existedBefore.has(wal) && existsSync(wal) && statSync(wal).size === 0) {
    for (const file of sideFiles) if (!existedBefore.has(file)) rmSync(file, { force: true });
  }
}

console.log(`Original: ${sourcePath} (opened read-only, not changed)`);
console.log(`Copy:     ${copy}`);
console.log(`Pending migrations: ${String(pending)}`);
console.log('');
const report = checkMigration(copy);
for (const line of formatMigrationReport(report)) console.log(line);
process.exitCode = report.ok ? 0 : 1;
