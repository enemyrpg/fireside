import { BRANDING } from '@fireside/shared';
import {
  createApiKey,
  InvalidKeyNameError,
  KeyLimitError,
  listApiKeys,
  normalizeKeyName,
  revokeApiKey,
  type Clock,
} from '../auth/api-keys.js';
import { usernamesById } from '../users/invites.js';
import { findUserByUsername, listUsers } from '../users/users.js';
import { rebuildDerivedTables, retryFailedEvents, type AdminRunResult } from '../admin/rebuild.js';
import { InvalidDatabaseFileError, type BackupResult } from '../backup/backup.js';
import { InstanceLockedError } from '../backup/lock.js';
import { RestoreError, type RestoreResult } from '../backup/restore.js';
import type { Db } from '../db/index.js';
import { failedEvents, type Projection } from '../projections/index.js';
import { runUsersCommand, USERS_USAGE } from './users.js';

// `pnpm cli …` commands. Kept free of process globals so tests can run them
// against an in-memory database.

export interface OpenDbOptions {
  /** May a missing database file be created? Only `keys create` allows it. */
  create: boolean;
}

export interface CliContext {
  /** Opens the database on first use. Throws `CliError` if it can't. */
  openDb: (options: OpenDbOptions) => Db;
  out: (line: string) => void;
  err: (line: string) => void;
  now: Clock;
  /** `backup` and `restore`. Kept behind functions so tests can use temp folders. */
  backups: {
    /** Takes a backup now. Throws `CliError` if there is no database. */
    create: () => BackupResult;
    /** Restores `file` (as typed by the user). */
    restore: (file: string) => RestoreResult;
  };
  /** Overrides `PROJECTIONS` for `rebuild` and `reprocess`. Used by tests. */
  projections?: readonly Projection[];
  /** Reads a password for `users` commands. Resolves `undefined` if input ended. */
  readPassword?: (prompt: string) => Promise<string | undefined>;
  /** True at a terminal: `users` commands ask for a new password twice. */
  interactive?: boolean;
  /** Overrides password hashing (argon2 parameters). Used by tests. */
  hashPassword?: (password: string) => Promise<string>;
}

/** An expected failure. `runCli` prints the message and exits with 1. */
export class CliError extends Error {
  override name = 'CliError';
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const N = BRANDING.shortName;

const USAGE = `Usage:
  pnpm cli keys create <name> [--user <username>]
                                        Create an API key for a RuneLite install. With
                                        several users, --user says whose it is
  pnpm cli keys list                    List every user's API keys (never the keys themselves)
  pnpm cli keys revoke <id>             Revoke an API key
${USERS_USAGE}
  pnpm cli rebuild                      Rebuild all derived tables from the raw events
  pnpm cli reprocess                    Retry only the events whose processing failed
  pnpm cli backup                       Back up the database now (into BACKUP_DIR)
  pnpm cli restore <file>               Replace the database with a backup (server stopped)

Passwords are at least 12 characters. They are asked for at the terminal
(or read one per line from stdin), never given on the command line.

rebuild, reprocess and backup are safe while the server runs: new data waits
until they finish. restore refuses while the server runs. It keeps a copy of
the current database in BACKUP_DIR first. <file> can be a path, or the name of
a file in BACKUP_DIR.`;

function usage(ctx: CliContext, problem?: string): number {
  if (problem) ctx.err(problem);
  ctx.err(USAGE);
  return EXIT_USAGE;
}

const HELP_FLAGS = new Set(['-h', '--help']);

const KEY_COMMANDS = new Set(['create', 'list', 'revoke']);

/** Commands without arguments. */
const PLAIN_COMMANDS = new Set(['rebuild', 'reprocess', 'backup']);

const isHelp = (arg: string | undefined) => arg !== undefined && HELP_FLAGS.has(arg);

/**
 * Runs a CLI command. `argv` is the arguments after `pnpm cli`. Returns the
 * exit code. Arguments are not parsed as options, because a key name is free
 * text (`keys create Laptop -h` names the key "Laptop -h"). `-h`/`--help`
 * means help only as the first argument, right after `keys`, or as the only
 * argument to a known `keys` command, `rebuild`, `reprocess`, `backup` or
 * `restore`. After an unknown command it is ignored,
 * so typos still report "Unknown command".
 */
export function runCli(argv: string[], ctx: CliContext): number {
  const [group, command, ...rest] = argv;
  const wantsHelp =
    isHelp(group) ||
    (group !== undefined &&
      (PLAIN_COMMANDS.has(group) || group === 'restore') &&
      argv.length === 2 &&
      isHelp(command)) ||
    (group === 'keys' && isHelp(command)) ||
    (group === 'keys' &&
      command !== undefined &&
      KEY_COMMANDS.has(command) &&
      rest.length === 1 &&
      isHelp(rest[0]));
  if (wantsHelp) {
    ctx.out(USAGE);
    return EXIT_OK;
  }

  if (group !== undefined && PLAIN_COMMANDS.has(group)) {
    if (command !== undefined) return usage(ctx, `${group} takes no arguments`);
  } else if (group === 'restore') {
    if (command === undefined || rest.length > 0) {
      return usage(ctx, 'Give exactly one backup file (quote a path with spaces)');
    }
  } else if (group !== 'keys') {
    return usage(ctx, group ? `Unknown command: ${group}` : undefined);
  }

  try {
    if (group === 'rebuild') return rebuild(ctx);
    if (group === 'reprocess') return reprocess(ctx);
    if (group === 'backup') return backup(ctx);
    if (group === 'restore') return restore(command ?? '', ctx);
    return runKeysCommand(command, rest, ctx);
  } catch (error) {
    if (
      !(error instanceof CliError) &&
      !(error instanceof RestoreError) &&
      !(error instanceof InvalidDatabaseFileError)
    ) {
      throw error;
    }
    ctx.err(error.message);
    return EXIT_FAILURE;
  }
}

function runKeysCommand(command: string | undefined, rest: string[], ctx: CliContext): number {
  switch (command) {
    case 'create':
      return keysCreate(rest, ctx);
    case 'list':
      return rest.length === 0 ? keysList(ctx) : usage(ctx, 'keys list takes no arguments');
    case 'revoke':
      return keysRevoke(rest, ctx);
    default:
      return usage(ctx, command ? `Unknown command: keys ${command}` : undefined);
  }
}

/**
 * Splits `--user <username>` (or `--user=<username>`) off the start or the end
 * of `keys create`'s arguments. Anywhere else it is part of the name, which
 * is free text.
 */
export function splitUserOption(args: string[]): { nameParts: string[]; username?: string } {
  const first = args[0];
  const last = args.at(-1);
  if (first === '--user' && args.length >= 2) {
    return { nameParts: args.slice(2), username: args[1] ?? '' };
  }
  if (first?.startsWith('--user=')) {
    return { nameParts: args.slice(1), username: first.slice('--user='.length) };
  }
  if (args.length >= 2 && args.at(-2) === '--user') {
    return { nameParts: args.slice(0, -2), username: last ?? '' };
  }
  if (last?.startsWith('--user=')) {
    return { nameParts: args.slice(0, -1), username: last.slice('--user='.length) };
  }
  return { nameParts: args };
}

/** The user `keys create` makes a key for: `--user`, or the only user there is. */
function keyOwnerFor(db: Db, username: string | undefined): { id: number; username: string } {
  if (username !== undefined) {
    const user = findUserByUsername(db, username);
    if (!user) {
      throw new CliError(
        `No user named "${username.trim().toLowerCase()}". See: pnpm cli users list`,
      );
    }
    if (user.disabledAt !== null) {
      throw new CliError(`User "${user.username}" is deactivated. Activate them first.`);
    }
    return user;
  }
  const all = listUsers(db);
  const only = all.length === 1 ? all[0] : undefined;
  if (!only) {
    throw new CliError(
      'This server has several users. Say whose key it is: pnpm cli keys create <name> --user <username>',
    );
  }
  return only;
}

function keysCreate(args: string[], ctx: CliContext): number {
  // Allow unquoted names with spaces: `pnpm cli keys create Gaming PC`.
  const { nameParts, username } = splitUserOption(args);
  if (username === '') return usage(ctx, 'Give a username after --user');
  let created;
  let owner;
  try {
    const name = normalizeKeyName(nameParts.join(' '));
    const db = ctx.openDb({ create: true });
    owner = keyOwnerFor(db, username);
    // The CLI is the server's operator, not a user: `created_by_user_id` is
    // null and the owner's permission doesn't apply. The limit does.
    created = createApiKey(db, { userId: owner.id, createdByUserId: null }, name, ctx.now());
  } catch (error) {
    if (error instanceof InvalidKeyNameError) return usage(ctx, error.message);
    if (error instanceof KeyLimitError) {
      ctx.err(
        `User "${owner?.username ?? ''}" already has the maximum of active API keys. ` +
          'Revoke one first: pnpm cli keys list, then pnpm cli keys revoke <id>',
      );
      return EXIT_FAILURE;
    }
    throw error;
  }
  ctx.out(
    `Created API key ${String(created.id)} "${created.name}" (${created.prefix}…) for user "${owner.username}"`,
  );
  ctx.out('');
  ctx.out(`  ${created.key}`);
  ctx.out('');
  ctx.out('Copy it into the plugin settings now. It is stored only as a hash and');
  ctx.out('cannot be shown again. If you lose it, revoke it and create a new one.');
  return EXIT_OK;
}

function keysList(ctx: CliContext): number {
  const db = ctx.openDb({ create: false });
  const keys = listApiKeys(db);
  const names = usernamesById(db);
  /** A user's name; `null` (the CLI, or a deleted user) is shown as `-`. */
  const nameOf = (id: number | null) => (id === null ? '-' : (names.get(id) ?? `#${String(id)}`));
  if (keys.length === 0) {
    ctx.out('No API keys yet. Create one with: pnpm cli keys create <name>');
    return EXIT_OK;
  }

  const header = ['ID', 'OWNER', 'NAME', 'PREFIX', 'CREATED', 'BY', 'LAST USED', 'STATUS'];
  const rows = keys.map((key) => [
    String(key.id),
    nameOf(key.userId),
    key.name,
    `${key.prefix}…`,
    key.createdAt,
    nameOf(key.createdByUserId),
    key.lastUsedAt ?? 'never',
    key.revokedAt === null
      ? 'active'
      : `revoked ${key.revokedAt} by ${nameOf(key.revokedByUserId)}`,
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  for (const row of [header, ...rows]) {
    ctx.out(
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    );
  }
  return EXIT_OK;
}

function keysRevoke(args: string[], ctx: CliContext): number {
  const [rawId, ...extra] = args;
  if (rawId === undefined || extra.length > 0) return usage(ctx, 'Give exactly one key ID');
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) {
    return usage(ctx, `Not a key ID: ${rawId}`);
  }
  const id = Number(rawId);

  const db = ctx.openDb({ create: false });
  // The CLI is the server's operator: `revoked_by_user_id` is null, and the
  // owner sees "Revoked by admin".
  switch (revokeApiKey(db, id, { byUserId: null, now: ctx.now() })) {
    case 'revoked':
      ctx.out(`Revoked API key ${String(id)}. The plugin using it can no longer send data.`);
      return EXIT_OK;
    case 'already-revoked':
      ctx.out(`API key ${String(id)} was already revoked.`);
      return EXIT_OK;
    case 'not-found':
      ctx.err(`No API key with ID ${String(id)}. See: pnpm cli keys list`);
      return EXIT_FAILURE;
  }
}

const USER_COMMANDS = new Set([
  'list',
  'create',
  'set-password',
  'rename',
  'clear-password',
  'reset-2fa',
]);

/**
 * Runs any CLI command, including `users`, which needs to wait for password
 * input and hashing. The entry point uses this; `runCli` covers the rest.
 */
export async function runCliAsync(argv: string[], ctx: CliContext): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group !== 'users') return runCli(argv, ctx);
  if (
    isHelp(command) ||
    (command !== undefined && USER_COMMANDS.has(command) && rest.length === 1 && isHelp(rest[0]))
  ) {
    ctx.out(USAGE);
    return EXIT_OK;
  }
  const readPassword = ctx.readPassword;
  try {
    return await runUsersCommand(
      command,
      rest,
      {
        openDb: ctx.openDb,
        out: ctx.out,
        err: ctx.err,
        now: ctx.now,
        interactive: ctx.interactive ?? false,
        readPassword: (prompt) => {
          if (!readPassword) throw new CliError('Password input is not available');
          return readPassword(prompt);
        },
        ...(ctx.hashPassword ? { hash: ctx.hashPassword } : {}),
      },
      (problem) => usage(ctx, problem),
    );
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    ctx.err(error.message);
    return EXIT_FAILURE;
  }
}

/** Most failed events listed after `rebuild` or `reprocess`. */
const MAX_LISTED_FAILURES = 20;

function rebuild(ctx: CliContext): number {
  const db = ctx.openDb({ create: false });
  const result = rebuildDerivedTables(db, adminOptions(ctx));
  const total = result.processed + result.failed.length;
  ctx.out(
    `Rebuilt derived tables from ${String(total)} ${plural(total, 'event')} ` +
      `in ${String(result.durationMs)} ms.`,
  );
  return reportFailures(db, result, ctx);
}

function reprocess(ctx: CliContext): number {
  const db = ctx.openDb({ create: false });
  const result = retryFailedEvents(db, adminOptions(ctx));
  const total = result.processed + result.failed.length;
  if (total === 0) {
    ctx.out('No failed events to retry.');
    return EXIT_OK;
  }
  ctx.out(
    `Retried ${String(total)} failed ${plural(total, 'event')} in ` +
      `${String(result.durationMs)} ms: ${String(result.processed)} succeeded.`,
  );
  return reportFailures(db, result, ctx);
}

function adminOptions(ctx: CliContext) {
  return { now: ctx.now, ...(ctx.projections ? { projections: ctx.projections } : {}) };
}

/** Lists failed events (ID, type, error; never payloads). Exit 1 if there are any. */
function reportFailures(db: Db, result: AdminRunResult, ctx: CliContext): number {
  if (result.failed.length === 0) return EXIT_OK;
  const failed = failedEvents(db);
  ctx.err(
    `${String(failed.length)} ${plural(failed.length, 'event')} failed. Their raw data is kept:`,
  );
  for (const event of failed.slice(0, MAX_LISTED_FAILURES)) {
    ctx.err(`  ${event.eventId}  ${event.type}  ${event.error}`);
  }
  if (failed.length > MAX_LISTED_FAILURES) {
    ctx.err(`  … and ${String(failed.length - MAX_LISTED_FAILURES)} more`);
  }
  ctx.err('After fixing the cause, retry them with: pnpm cli reprocess');
  return EXIT_FAILURE;
}

function backup(ctx: CliContext): number {
  const result = ctx.backups.create();
  ctx.out(
    `Backup saved: ${result.path} (${formatBytes(result.sizeBytes)}, ` +
      `${String(result.durationMs)} ms).`,
  );
  ctx.out(
    `${String(result.count)} ${plural(result.count, 'backup')} kept ` +
      `(${formatBytes(result.totalSizeBytes)}).` +
      (result.deleted.length > 0
        ? ` Deleted ${String(result.deleted.length)} old ${plural(result.deleted.length, 'backup')}.`
        : ''),
  );
  ctx.out('Backups on the same disk do not survive a disk failure: copy them elsewhere too.');
  return EXIT_OK;
}

function restore(file: string, ctx: CliContext): number {
  let result: RestoreResult;
  try {
    result = ctx.backups.restore(file);
  } catch (error) {
    if (!(error instanceof InstanceLockedError)) throw error;
    ctx.err(error.message);
    ctx.err('Stop the server first, then run restore again:');
    ctx.err('  pnpm dev / pnpm start: Ctrl-C in its terminal');
    ctx.err(`  systemd: systemctl --user stop ${N}`);
    ctx.err('  Docker: docker compose stop, then');
    ctx.err(`          docker compose run --rm ${N} ${N} restore <file>`);
    return EXIT_FAILURE;
  }
  const taken = result.backupCreatedAt ? ` (taken ${result.backupCreatedAt.toISOString()})` : '';
  ctx.out(`Restored ${file}${taken} to ${result.dbFile}.`);
  if (result.migrationsApplied > 0) {
    ctx.out(
      `The backup was from an older version: applied ${String(result.migrationsApplied)} ` +
        `${plural(result.migrationsApplied, 'migration')}.`,
    );
  }
  if (result.previousSavedTo !== null) {
    ctx.out(
      `The previous database was saved as ${result.previousSavedTo}` +
        (result.previousRawCopy ? ' (copied as is: it could not be read normally).' : '.'),
    );
  }
  ctx.out('Start the server again.');
  return EXIT_OK;
}

/** `1.5 MB`, `812 kB`, `120 B` (powers of 1000, like most file managers). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'TB'}`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
