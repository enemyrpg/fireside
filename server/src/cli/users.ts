import { audit, userTarget } from '../audit/audit.js';
import type { Db } from '../db/index.js';
import type { UserRow } from '../db/schema.js';
import { checkNewPassword, hashPassword, InvalidPasswordError } from '../users/password.js';
import { resetTwoFactor, twoFactorEnabled } from '../users/two-factor.js';
import { InvalidUsernameError, normalizeUsername } from '../users/username.js';
import {
  anyPasswordSet,
  countUsers,
  createUser,
  findUserByUsername,
  listUsers,
  localUserId,
  renameUser,
  setPasswordHash,
  UsernameTakenError,
} from '../users/users.js';
import type { Clock } from '../auth/api-keys.js';
import type { OpenDbOptions } from './run.js';

// `pnpm cli users …`. Passwords are read from the terminal without echo (or one
// line per password from stdin when it isn't a terminal), never from the
// command line, where they would end up in shell history and `ps`. The CLI runs
// on the server itself, so it acts as nobody (`actor_user_id` is `null` in the
// audit log).

export interface UsersContext {
  openDb: (options: OpenDbOptions) => Db;
  out: (line: string) => void;
  err: (line: string) => void;
  now: Clock;
  /** Reads one password. Resolves `undefined` if input ended. */
  readPassword: (prompt: string) => Promise<string | undefined>;
  /** True when a person types at a terminal: passwords are asked twice. */
  interactive: boolean;
  /** Overrides the argon2 parameters. Tests use cheap ones. */
  hash?: (password: string) => Promise<string>;
}

export const USERS_USAGE = `  pnpm cli users list                   List users (never shows passwords)
  pnpm cli users create <name> [--admin]
                                        Add a user (asks for a password). Login must be on
  pnpm cli users set-password <name>    Set a password (turns login on). Ends their sessions
  pnpm cli users rename <old> <new>     Change a username
  pnpm cli users clear-password <name>  Remove the password: back to local mode (one user only)
  pnpm cli users reset-2fa <name>       Turn off two-factor authentication (lost phone and
                                        recovery codes, or a lost key file). Ends their sessions`;

/** Exit codes, the same as `run.ts`. */
const OK = 0;
const FAILURE = 1;
const USAGE = 2;

interface Outcome {
  code: typeof OK | typeof FAILURE | typeof USAGE;
  message?: string;
}

const usageError = (message: string): Outcome => ({ code: USAGE, message });
const failure = (message: string): Outcome => ({ code: FAILURE, message });

function findOrFail(db: Db, name: string): UserRow | Outcome {
  const user = findUserByUsername(db, name);
  return user ?? failure(`No user named "${name.trim().toLowerCase()}". See: pnpm cli users list`);
}

const isOutcome = (value: unknown): value is Outcome =>
  typeof value === 'object' && value !== null && 'code' in value;

/** Asks for a new password (twice when interactive) and checks the rule. */
async function askNewPassword(ctx: UsersContext): Promise<string | Outcome> {
  const first = await ctx.readPassword('New password: ');
  if (first === undefined) return failure('No password given');
  let password: string;
  try {
    password = checkNewPassword(first);
  } catch (error) {
    if (error instanceof InvalidPasswordError) return failure(error.message);
    throw error;
  }
  if (ctx.interactive) {
    const again = await ctx.readPassword('Repeat it: ');
    if (again?.normalize('NFC') !== password) {
      return failure('The passwords did not match. Nothing was changed.');
    }
  }
  return password;
}

function list(ctx: UsersContext): Outcome {
  const users = listUsers(ctx.openDb({ create: false }));
  const header = ['ID', 'USERNAME', 'ROLE', 'PASSWORD', '2FA', 'CREATED', 'LAST LOGIN', 'STATUS'];
  const rows = users.map((user) => [
    String(user.id),
    user.username,
    user.role,
    user.passwordHash === null ? 'no' : 'yes',
    twoFactorEnabled(user) ? 'on' : 'off',
    user.createdAt,
    user.lastLoginAt ?? 'never',
    user.disabledAt === null ? 'active' : `disabled ${user.disabledAt}`,
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
  return { code: OK };
}

async function create(args: string[], ctx: UsersContext): Promise<Outcome> {
  const admin = args.includes('--admin');
  const names = args.filter((arg) => arg !== '--admin');
  if (names.length !== 1 || names[0] === undefined) return usageError('Give exactly one username');
  let username: string;
  try {
    username = normalizeUsername(names[0]);
  } catch (error) {
    if (error instanceof InvalidUsernameError) return usageError(error.message);
    throw error;
  }
  const db = ctx.openDb({ create: false });
  // A second user only in login mode, so local mode never has more than one.
  if (!anyPasswordSet(db)) {
    const owner = listUsers(db).find((user) => user.id === localUserId(db));
    return failure(
      `Login is off. Set a password first: pnpm cli users set-password ${owner?.username ?? 'admin'}`,
    );
  }
  if (findUserByUsername(db, username)) return failure('That username is taken');

  const password = await askNewPassword(ctx);
  if (isOutcome(password)) return password;
  const hash = await (ctx.hash ?? hashPassword)(password);
  let id: number;
  try {
    id = createUser(db, username, {
      role: admin ? 'admin' : 'member',
      passwordHash: hash,
      now: ctx.now(),
    });
  } catch (error) {
    if (error instanceof UsernameTakenError) return failure(error.message);
    throw error;
  }
  audit(db, { actorUserId: null, action: 'user.create', target: userTarget(id), now: ctx.now() });
  ctx.out(`Created user ${String(id)} "${username}" (${admin ? 'admin' : 'member'}).`);
  return { code: OK };
}

async function setPassword(args: string[], ctx: UsersContext): Promise<Outcome> {
  if (args.length !== 1 || args[0] === undefined) return usageError('Give exactly one username');
  const db = ctx.openDb({ create: false });
  const user = findOrFail(db, args[0]);
  if (isOutcome(user)) return user;
  const wasLocal = !anyPasswordSet(db);

  const password = await askNewPassword(ctx);
  if (isOutcome(password)) return password;
  const hash = await (ctx.hash ?? hashPassword)(password);
  setPasswordHash(db, user.id, hash);
  audit(db, {
    actorUserId: null,
    action: 'user.set_password',
    target: userTarget(user.id),
    now: ctx.now(),
  });
  ctx.out(`Password set for "${user.username}". Their sessions have ended.`);
  if (wasLocal) {
    ctx.out('Login is now on: the dashboard asks for a username and password, also here.');
  }
  if (user.username === 'admin') {
    ctx.out('Tip: pick your own username with: pnpm cli users rename admin <name>');
  }
  return { code: OK };
}

function rename(args: string[], ctx: UsersContext): Outcome {
  if (args.length !== 2 || args[0] === undefined || args[1] === undefined) {
    return usageError('Give the current and the new username');
  }
  let newName: string;
  try {
    newName = normalizeUsername(args[1]);
  } catch (error) {
    if (error instanceof InvalidUsernameError) return usageError(error.message);
    throw error;
  }
  const db = ctx.openDb({ create: false });
  const user = findOrFail(db, args[0]);
  if (isOutcome(user)) return user;
  if (user.username === newName) {
    ctx.out(`"${newName}" already has that name.`);
    return { code: OK };
  }
  try {
    renameUser(db, user.id, newName);
  } catch (error) {
    if (error instanceof UsernameTakenError) return failure(error.message);
    throw error;
  }
  audit(db, {
    actorUserId: null,
    action: 'user.rename',
    target: userTarget(user.id),
    now: ctx.now(),
  });
  ctx.out(`Renamed "${user.username}" to "${newName}". Log in with the new name from now on.`);
  return { code: OK };
}

function clearPassword(args: string[], ctx: UsersContext): Outcome {
  if (args.length !== 1 || args[0] === undefined) return usageError('Give exactly one username');
  const db = ctx.openDb({ create: false });
  const user = findOrFail(db, args[0]);
  if (isOutcome(user)) return user;
  if (countUsers(db) > 1) {
    return failure("Login can't be turned off while there is more than one user.");
  }
  if (user.passwordHash === null) {
    ctx.out(`"${user.username}" has no password. Login is already off.`);
    return { code: OK };
  }
  setPasswordHash(db, user.id, null);
  audit(db, {
    actorUserId: null,
    action: 'user.clear_password',
    target: userTarget(user.id),
    now: ctx.now(),
  });
  ctx.out(
    'Password removed. Login is off: the dashboard works without login, on this machine only.',
  );
  return { code: OK };
}

/**
 * Turns off a user's 2FA, for a lost phone and lost recovery codes, or a lost
 * key file. Also ends their sessions and forgets their devices. The operator
 * acts as nobody in the audit log.
 */
function resetTwoFactorCommand(args: string[], ctx: UsersContext): Outcome {
  if (args.length !== 1 || args[0] === undefined) return usageError('Give exactly one username');
  const db = ctx.openDb({ create: false });
  const user = findOrFail(db, args[0]);
  if (isOutcome(user)) return user;
  if (!twoFactorEnabled(user) && user.totpPendingSecret === null) {
    ctx.out(`"${user.username}" does not have two-factor authentication on.`);
    return { code: OK };
  }
  db.transaction(
    (tx) => {
      resetTwoFactor(tx, user.id);
      audit(tx, {
        actorUserId: null,
        action: 'user.totp_reset',
        target: userTarget(user.id),
        now: ctx.now(),
      });
    },
    { behavior: 'immediate' },
  );
  ctx.out(
    `Two-factor authentication is off for "${user.username}", and their sessions ended. ` +
      'They log in with their password and can turn it on again under Settings → Profile.',
  );
  return { code: OK };
}

/**
 * Runs `users <command> …`. Returns the exit code; a usage error prints the
 * message and the usage text, a failure only the message.
 */
export async function runUsersCommand(
  command: string | undefined,
  args: string[],
  ctx: UsersContext,
  printUsage: (problem?: string) => number,
): Promise<number> {
  let outcome: Outcome;
  switch (command) {
    case 'list':
      outcome = args.length === 0 ? list(ctx) : usageError('users list takes no arguments');
      break;
    case 'create':
      outcome = await create(args, ctx);
      break;
    case 'set-password':
      outcome = await setPassword(args, ctx);
      break;
    case 'rename':
      outcome = rename(args, ctx);
      break;
    case 'clear-password':
      outcome = clearPassword(args, ctx);
      break;
    case 'reset-2fa':
      outcome = resetTwoFactorCommand(args, ctx);
      break;
    default:
      return printUsage(command ? `Unknown command: users ${command}` : undefined);
  }
  if (outcome.code === USAGE) return printUsage(outcome.message);
  if (outcome.message !== undefined) ctx.err(outcome.message);
  return outcome.code;
}
