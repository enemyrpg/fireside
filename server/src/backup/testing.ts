import { BRANDING } from '@fireside/shared';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import BetterSqlite3 from 'better-sqlite3';
import { MIGRATIONS_DIR } from '../db/index.js';

const N = BRANDING.shortName;

// Helpers for the backup and restore tests.

/** A new empty folder under the OS temp folder, and a function that removes it. */
export function tempDir(): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${N}-backup-test-`));
  return {
    dir,
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Decompresses a gzipped backup into a new folder of its own (never next to
 * the backups, so folder listings in tests stay as they are). Returns the
 * plain database file and a function that removes it.
 */
export function unzipBackup(path: string): { file: string; remove: () => void } {
  const { dir, remove } = tempDir();
  const file = join(dir, 'unzipped.db');
  writeFileSync(file, gunzipSync(readFileSync(path)));
  return { file, remove };
}

/** Runs `use` on a gzipped backup opened read-only, and cleans up after. */
export function withBackup<T>(path: string, use: (sqlite: BetterSqlite3.Database) => T): T {
  const { file, remove } = unzipBackup(path);
  const sqlite = new BetterSqlite3(file, { readonly: true });
  try {
    return use(sqlite);
  } finally {
    sqlite.close();
    remove();
  }
}

/**
 * Every table with every row, in rowid order, plus the schema. Two databases
 * with equal dumps have the same content.
 */
export function dumpTables(sqlite: BetterSqlite3.Database): Record<string, unknown> {
  const schema = sqlite
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as { type: string; name: string; sql: string | null }[];
  const tables: Record<string, unknown[]> = {};
  for (const { type, name } of schema) {
    if (type !== 'table') continue;
    tables[name] = sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return { schema, tables };
}

/** A copy of the real migrations plus one more (a new table), as a newer version would have. */
export function migrationsWithExtra(dir: string): string {
  const folder = join(dir, 'migrations-newer');
  cpSync(MIGRATIONS_DIR, folder, { recursive: true });
  const journalFile = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const last = journal.entries.at(-1);
  if (!last) throw new Error('No migrations');
  const tag = `${String(last.idx + 1).padStart(4, '0')}_future_feature`;
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag });
  writeFileSync(journalFile, JSON.stringify(journal));
  writeFileSync(
    join(folder, `${tag}.sql`),
    'CREATE TABLE `future_feature` (`id` integer PRIMARY KEY NOT NULL, `value` text);',
  );
  return folder;
}

/**
 * A copy of the real migrations up to (not including) `tag`, in `dir`, to
 * build a database as an older version left it.
 */
export function migrationsBefore(dir: string, tag: string): string {
  const folder = join(dir, `migrations-before-${tag}`);
  cpSync(MIGRATIONS_DIR, folder, { recursive: true });
  const journalFile = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as {
    entries: { tag: string }[];
  };
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  if (index <= 0) throw new Error(`No migration ${tag} after the first`);
  journal.entries = journal.entries.slice(0, index);
  writeFileSync(journalFile, JSON.stringify(journal));
  return folder;
}
