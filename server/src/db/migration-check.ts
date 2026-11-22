import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import BetterSqlite3 from 'better-sqlite3';
import { rebuildDerivedTables } from '../admin/rebuild.js';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { PROJECTIONS } from '../projections/index.js';
import { closeTimedOutSessions } from '../projections/sessions.js';
import { MIGRATIONS_TABLE, openDatabase, type Database } from './index.js';

// Checks that migrating a database changes nothing but what the migration
// adds: same tables, same rows, same content, and a rebuild after it gives the same
// derived tables (and uses up no account IDs). Works on databases from before users
// (0020) and after. Used by a test (db/db.test.ts) and by
// `server/scripts/check-migration.ts`, which runs it on a copy of a real database. Never
// run it on a live file: it migrates and rebuilds `file`.

/** Columns the users migration (0020) added. Left out when comparing before and after. */
export const COLUMNS_ADDED_BY_USERS_MIGRATION: Readonly<Record<string, readonly string[]>> = {
  api_keys: ['user_id', 'created_by_user_id', 'revoked_by_user_id'],
  events: ['user_id'],
  account_ids: ['user_id'],
  accounts: ['user_id'],
};

/** Tables the users migration added. */
export const TABLES_ADDED_BY_USERS_MIGRATION: readonly string[] = ['users'];

/** Tables the login migration (0021) added. They start empty. */
export const TABLES_ADDED_BY_LOGIN_MIGRATION: readonly string[] = ['user_sessions', 'audit_log'];

/** Tables the invites migration (0022) added. They start empty. */
export const TABLES_ADDED_BY_INVITES_MIGRATION: readonly string[] = ['invites'];

/** Tables the server settings migration (0023) added. They start empty. */
export const TABLES_ADDED_BY_SETTINGS_MIGRATION: readonly string[] = ['server_settings'];

/** Tables the two-factor migration (0024) added. They start empty. */
export const TABLES_ADDED_BY_TWO_FACTOR_MIGRATION: readonly string[] = [
  'recovery_codes',
  'trusted_devices',
];

/** Columns the two-factor migration (0024) added to `users`. Null on every existing row. */
export const COLUMNS_ADDED_BY_TWO_FACTOR_MIGRATION: Readonly<Record<string, readonly string[]>> = {
  users: ['totp_enabled_at', 'totp_last_step', 'totp_pending_secret', 'totp_pending_expires_at'],
};

/** Tables the session collection log migration (0025) added. They start empty. */
export const TABLES_ADDED_BY_SESSION_CLOG_MIGRATION: readonly string[] = ['clog_reads'];

/** Tables the price history migration (0026) added. They start empty. */
export const TABLES_ADDED_BY_PRICE_HISTORY_MIGRATION: readonly string[] = ['item_price_history'];

/** Tables a migration adds empty. */
const EMPTY_NEW_TABLES = [
  ...TABLES_ADDED_BY_LOGIN_MIGRATION,
  ...TABLES_ADDED_BY_INVITES_MIGRATION,
  ...TABLES_ADDED_BY_SETTINGS_MIGRATION,
  ...TABLES_ADDED_BY_TWO_FACTOR_MIGRATION,
  ...TABLES_ADDED_BY_SESSION_CLOG_MIGRATION,
  ...TABLES_ADDED_BY_PRICE_HISTORY_MIGRATION,
];

/**
 * Derived tables that are a cache filled when read, not by the projections:
 * a rebuild empties them, and they fill again on the next read.
 */
const READ_CACHE_PROJECTIONS = new Set(['weekly-summaries']);

/** Tables the collection log rebuild writes (from `external_snapshots`, not events). */
const CLOG_TABLES = ['clog_snapshots', 'clog_items', 'clog_obtained', 'clog_feed_times'];

export interface TableState {
  rows: number;
  /** SHA-256 over every row (compared columns only), in a fixed order. */
  hash: string;
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function userTables(sqlite: BetterSqlite3.Database): string[] {
  return sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
        'AND name <> ? ORDER BY name',
    )
    .pluck()
    .all(MIGRATIONS_TABLE) as string[];
}

/** Row count and content hash of one table, without the `ignore`d columns. */
export function tableState(
  sqlite: BetterSqlite3.Database,
  table: string,
  ignore: readonly string[] = [],
): TableState {
  const columns = (sqlite.pragma(`table_info(${quote(table)})`) as { name: string }[])
    .map((column) => column.name)
    .filter((name) => !ignore.includes(name))
    .sort();
  const list = columns.map(quote).join(', ');
  const hash = createHash('sha256');
  let rows = 0;
  const statement = sqlite
    .prepare(`SELECT ${list} FROM ${quote(table)} ORDER BY ${list}`)
    .raw(true);
  for (const row of statement.iterate() as Iterable<unknown[]>) {
    rows += 1;
    hash.update(
      JSON.stringify(row.map((value) => (Buffer.isBuffer(value) ? value.toString('hex') : value))),
    );
    hash.update('\n');
  }
  return { rows, hash: hash.digest('hex') };
}

/** `tableState` of every table, by name. */
export function tableStates(
  sqlite: BetterSqlite3.Database,
  ignoreColumns: Readonly<Record<string, readonly string[]>> = {},
): Map<string, TableState> {
  return new Map(
    userTables(sqlite).map((table) => [table, tableState(sqlite, table, ignoreColumns[table])]),
  );
}

export interface TableComparison {
  table: string;
  before: TableState | undefined;
  after: TableState | undefined;
  ok: boolean;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface MigrationCheckReport {
  /** Every table, before and after migrating. */
  tables: TableComparison[];
  /**
   * Checks of ownership. From before users (0020): every old row belongs to
   * user 1. With users already there: owners are consistent.
   */
  ownership: CheckResult[];
  /** Each projection's snapshot after migrating vs. after `rebuild`. */
  rebuild: CheckResult[];
  ok: boolean;
}

function count(database: Database, sql: string): number {
  return database.sqlite.prepare(sql).pluck().get() as number;
}

function zeroCheck(database: Database, name: string, sql: string): CheckResult {
  const found = count(database, sql);
  return { name, ok: found === 0, ...(found === 0 ? {} : { detail: `${String(found)} rows` }) };
}

/** Checks that hold for any database with users. */
function consistencyChecks(database: Database): CheckResult[] {
  const zero = (name: string, sql: string) => zeroCheck(database, name, sql);
  return [
    zero(
      'accounts: same owner as in account_ids',
      'SELECT count(*) FROM accounts JOIN account_ids USING (id) ' +
        'WHERE accounts.user_id <> account_ids.user_id',
    ),
    zero(
      'events: owner exists',
      'SELECT count(*) FROM events WHERE user_id NOT IN (SELECT id FROM users)',
    ),
    zero(
      'api_keys: active keys revoked by nobody',
      'SELECT count(*) FROM api_keys WHERE revoked_at IS NULL AND revoked_by_user_id IS NOT NULL',
    ),
    zero('foreign keys intact', 'SELECT count(*) FROM pragma_foreign_key_check'),
  ];
}

/** Checks for a database migrated from before users (0020): everything is user 1's. */
function ownershipChecks(database: Database): CheckResult[] {
  const zero = (name: string, sql: string) => zeroCheck(database, name, sql);
  const users = count(database, 'SELECT count(*) FROM users');
  return [
    {
      name: 'users: only user 1, the admin',
      ok:
        users === 1 &&
        count(database, "SELECT count(*) FROM users WHERE id = 1 AND role = 'admin'") === 1,
      detail: `${String(users)} users`,
    },
    zero('events: every row belongs to user 1', 'SELECT count(*) FROM events WHERE user_id <> 1'),
    zero(
      'account_ids: every row belongs to user 1',
      'SELECT count(*) FROM account_ids WHERE user_id <> 1',
    ),
    zero(
      'accounts: every row belongs to user 1',
      'SELECT count(*) FROM accounts WHERE user_id <> 1',
    ),
    zero(
      'api_keys: owned and created by user 1',
      'SELECT count(*) FROM api_keys WHERE user_id <> 1 OR created_by_user_id <> 1',
    ),
    zero(
      'api_keys: revoked keys revoked by user 1, active keys by nobody',
      'SELECT count(*) FROM api_keys WHERE (revoked_at IS NULL) <> (revoked_by_user_id IS NULL) ' +
        'OR revoked_by_user_id <> 1',
    ),
  ];
}

/** After 0024: no user has 2FA, a pending setup or a used step yet. */
function twoFactorOffCheck(database: Database): CheckResult {
  const columns = COLUMNS_ADDED_BY_TWO_FACTOR_MIGRATION.users ?? [];
  return zeroCheck(
    database,
    'users: 2FA columns empty after 0024',
    `SELECT count(*) FROM users WHERE ${columns.map((c) => `${c} IS NOT NULL`).join(' OR ')}`,
  );
}

/** Everything a rebuild must leave as it was, by name. */
function derivedState(database: Database): Map<string, unknown> {
  const state = new Map<string, unknown>();
  for (const projection of PROJECTIONS) {
    if (READ_CACHE_PROJECTIONS.has(projection.name)) continue;
    state.set(`projection ${projection.name}`, projection.snapshot(database.db));
  }
  // Kept by rebuild, so account IDs (in dashboard URLs) don't change.
  state.set('account_ids', tableState(database.sqlite, 'account_ids'));
  // A rebuild must not use up account IDs either (`accountIdFor`).
  state.set(
    'account_ids counter',
    database.sqlite
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'account_ids'")
      .pluck()
      .get() ?? null,
  );
  for (const table of CLOG_TABLES) state.set(table, tableState(database.sqlite, table));
  // Raw, like `external_snapshots`: a rebuild never touches it.
  state.set('clog_reads', tableState(database.sqlite, 'clog_reads'));
  // Fetched prices, not derived from events: a rebuild never touches them.
  state.set('item_prices', tableState(database.sqlite, 'item_prices'));
  state.set('item_price_history', tableState(database.sqlite, 'item_price_history'));
  state.set(
    'failed events',
    count(database, 'SELECT count(*) FROM events WHERE projection_error IS NOT NULL'),
  );
  return state;
}

export interface CheckMigrationOptions {
  /** Only tests change this. */
  migrationsFolder?: string;
  /** The clock for the rebuild (session timeouts). */
  now?: Clock;
}

/**
 * Migrates `file` and rebuilds its derived tables, and reports what changed.
 * `file` must be a copy: it is changed.
 */
export function checkMigration(
  file: string,
  { migrationsFolder, now = systemClock }: CheckMigrationOptions = {},
): MigrationCheckReport {
  const raw = new BetterSqlite3(file, { fileMustExist: true });
  let before: Map<string, TableState>;
  let hadUsers: boolean;
  let hadTwoFactor: boolean;
  // Columns a pending migration adds are left out: from before users (0020)
  // the ones it added, from before 0024 the 2FA columns on `users`. Every
  // other column is compared.
  let ignore: Readonly<Record<string, readonly string[]>>;
  try {
    hadUsers = userTables(raw).includes('users');
    hadTwoFactor =
      hadUsers &&
      (raw.pragma('table_info(users)') as { name: string }[]).some(
        (column) => column.name === 'totp_enabled_at',
      );
    ignore = {
      ...(hadUsers ? {} : COLUMNS_ADDED_BY_USERS_MIGRATION),
      ...(hadTwoFactor ? {} : COLUMNS_ADDED_BY_TWO_FACTOR_MIGRATION),
    };
    before = tableStates(raw, ignore);
  } finally {
    raw.close();
  }

  const database = openDatabase(file, migrationsFolder === undefined ? {} : { migrationsFolder });
  try {
    const after = tableStates(database.sqlite, ignore);
    const names = [...new Set([...before.keys(), ...after.keys()])].sort();
    const tables = names.map((table): TableComparison => {
      const old = before.get(table);
      const current = after.get(table);
      const ok =
        old === undefined
          ? (!hadUsers && TABLES_ADDED_BY_USERS_MIGRATION.includes(table)) ||
            (EMPTY_NEW_TABLES.includes(table) && current?.rows === 0)
          : isDeepStrictEqual(old, current);
      return { table, before: old, after: current, ok };
    });

    const ownership = [
      ...(hadUsers ? [] : ownershipChecks(database)),
      ...(hadTwoFactor ? [] : [twoFactorOffCheck(database)]),
      ...consistencyChecks(database),
    ];

    // One clock for both sides: the running server would have closed these
    // sessions by now too, so the timeout is not a difference.
    const at = now();
    closeTimedOutSessions(database.db, at);
    const derivedBefore = derivedState(database);
    rebuildDerivedTables(database.db, { now: () => at });
    const derivedAfter = derivedState(database);
    const rebuild = [...derivedBefore.keys()].map((name): CheckResult => ({
      name,
      ok: isDeepStrictEqual(derivedBefore.get(name), derivedAfter.get(name)),
    }));

    const ok = [...tables, ...ownership, ...rebuild].every((check) => check.ok);
    return { tables, ownership, rebuild, ok };
  } finally {
    database.close();
  }
}

/** The report as text lines, for the script. */
export function formatMigrationReport(report: MigrationCheckReport): string[] {
  const mark = (ok: boolean) => (ok ? 'OK  ' : 'FAIL');
  const rows = (state: TableState | undefined) => (state ? String(state.rows) : '-');
  const width = Math.max(...report.tables.map((row) => row.table.length));
  const lines = [
    'Tables (row count before → after; content compared without the new columns):',
    ...report.tables.map(
      (row) =>
        `  ${mark(row.ok)} ${row.table.padEnd(width)}  ${rows(row.before).padStart(8)} → ${rows(row.after).padStart(8)}` +
        (row.before === undefined ? '  (new table)' : ''),
    ),
    '',
    'Ownership after migrating:',
    ...report.ownership.map(
      (check) => `  ${mark(check.ok)} ${check.name}${check.detail ? ` (${check.detail})` : ''}`,
    ),
    '',
    'Derived tables after migrating vs. after rebuild:',
    ...report.rebuild.map((check) => `  ${mark(check.ok)} ${check.name}`),
    `  (weekly summaries are a read cache: rebuild empties them and the next read fills them)`,
    '',
    report.ok ? 'Result: OK' : 'Result: FAIL',
  ];
  return lines;
}
