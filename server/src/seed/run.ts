import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { EVENT_TYPES, type Event } from '@fireside/shared';
import { count } from 'drizzle-orm';
import { acquireInstanceLock, InstanceLockedError, type InstanceLock } from '../backup/lock.js';
import type { Config } from '../config.js';
import { databasePath, openDatabase, type Database } from '../db/index.js';
import { events as eventsTable } from '../db/schema.js';
import { REPO_ROOT } from '../paths.js';
import { generateSeed, MAX_ACCOUNTS, MIN_ACCOUNTS, type SeedData } from './generator/generate.js';
import { seedInProcess } from './in-process.js';
import {
  parseRetryAfter,
  planRequests,
  SeedSendError,
  sendRequests,
  type SendResult,
  type Transport,
} from './runner.js';

// `pnpm seed`: fills a separate database with simulated data. Kept free of
// process globals so tests can run it.

export const DEFAULT_SEED = 1;
export const DEFAULT_ACCOUNTS = 3;
export const DEFAULT_MONTHS = 6;
/** Seed data never goes into the normal database by default. */
export const DEFAULT_SEED_DATA_DIR = 'data-seed';
/** Pacing against a running server: under the ingest limit of 120 requests per minute. */
const REMOTE_MIN_INTERVAL_MS = 550;

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export const USAGE = `Usage: pnpm seed [options]

Fills a separate database with simulated data for 2–3 accounts, sent through
POST /api/v1/ingest like the plugin does. The collection log of two accounts
is stored as raw external data (not with --url).

Options:
  --seed <n>        Random seed (default ${String(DEFAULT_SEED)}). Same seed and --until give the same events
  --accounts <n>    ${String(MIN_ACCOUNTS)} or ${String(MAX_ACCOUNTS)} accounts (default ${String(DEFAULT_ACCOUNTS)})
  --months <n>      Months of history before --until (default ${String(DEFAULT_MONTHS)})
  --until <ISO>     End of the data, e.g. 2026-11-10T12:00:00.000Z (default: now)
  --data-dir <dir>  Seed database folder (default ${DEFAULT_SEED_DATA_DIR}). Never the normal DATA_DIR
  --reset           Delete and recreate the seed database first
  --url <url>       Send to a running server instead, e.g. http://127.0.0.1:3100
  --key <key>       API key for --url
  -h, --help        Show this help

Run the server on the seed data with: env DATA_DIR=${DEFAULT_SEED_DATA_DIR} pnpm dev`;

export interface SeedArgs {
  seed: number;
  accounts: number;
  months: number;
  until: Date;
  dataDir: string;
  reset: boolean;
  remote?: { url: string; key: string };
}

/** Thrown for bad arguments. The message is shown with the usage. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** Thrown when the seed must not run. The message is shown as is. */
export class SeedRefusedError extends Error {
  override name = 'SeedRefusedError';
}

function integer(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`--${name} must be a whole number, got "${value}"`);
  }
  return Number(value);
}

/** Parses `pnpm seed` arguments. `now` is the default for `--until`. */
export function parseSeedArgs(argv: readonly string[], now: Date): SeedArgs | 'help' {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        seed: { type: 'string' },
        accounts: { type: 'string' },
        months: { type: 'string' },
        until: { type: 'string' },
        'data-dir': { type: 'string' },
        reset: { type: 'boolean' },
        url: { type: 'string' },
        key: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (values.help) return 'help';

  const accounts = integer('accounts', values.accounts, DEFAULT_ACCOUNTS);
  if (accounts < MIN_ACCOUNTS || accounts > MAX_ACCOUNTS) {
    throw new UsageError(`--accounts must be ${String(MIN_ACCOUNTS)} or ${String(MAX_ACCOUNTS)}`);
  }
  const months = integer('months', values.months, DEFAULT_MONTHS);
  if (months < 1 || months > 24) throw new UsageError('--months must be 1–24');

  let until = now;
  if (values.until !== undefined) {
    // Same format as event timestamps, so the meaning is never ambiguous.
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(values.until)) {
      throw new UsageError('--until must be UTC ISO 8601, e.g. 2026-11-10T12:00:00.000Z');
    }
    until = new Date(values.until);
    if (Number.isNaN(until.getTime())) throw new UsageError(`--until is not a valid time`);
  }

  const args: SeedArgs = {
    seed: integer('seed', values.seed, DEFAULT_SEED),
    accounts,
    months,
    until,
    dataDir: values['data-dir'] ?? DEFAULT_SEED_DATA_DIR,
    reset: values.reset ?? false,
  };

  if (values.url !== undefined || values.key !== undefined) {
    if (values.url === undefined || values.key === undefined) {
      throw new UsageError('--url and --key must be given together');
    }
    if (values.reset || values['data-dir'] !== undefined) {
      throw new UsageError(
        '--reset and --data-dir only apply to the local seed database, not --url',
      );
    }
    let url: URL;
    try {
      url = new URL(values.url);
    } catch {
      throw new UsageError(`--url is not a valid URL: ${values.url}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new UsageError('--url must start with http:// or https://');
    }
    args.remote = { url: url.href.replace(/\/+$/, ''), key: values.key };
  }
  return args;
}

export interface SeedContext {
  out: (line: string) => void;
  err: (line: string) => void;
  config: Config;
  now: () => Date;
  /** Base folder for a relative `--data-dir`. */
  baseDir?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Runs `pnpm seed`. Returns the exit code. */
export async function runSeed(argv: readonly string[], ctx: SeedContext): Promise<number> {
  let args: SeedArgs | 'help';
  try {
    args = parseSeedArgs(argv, ctx.now());
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    ctx.err(error.message);
    ctx.err(USAGE);
    return EXIT_USAGE;
  }
  if (args === 'help') {
    ctx.out(USAGE);
    return EXIT_OK;
  }

  const started = performance.now();
  try {
    const data = generateSeed({
      seed: args.seed,
      accounts: args.accounts,
      months: args.months,
      until: args.until,
      timeZone: ctx.config.timeZone,
    });
    ctx.out(
      `Seed ${String(args.seed)}: ${String(args.accounts)} accounts, ${String(args.months)} months, ` +
        `${data.from.toISOString()} → ${data.until.toISOString()} (${ctx.config.timeZone})`,
    );

    let result: SeedResult;
    if (args.remote) {
      result = await seedRemote(args.remote, data, ctx);
    } else {
      const database = openSeedDatabase(args, ctx);
      try {
        ctx.out(`Sending ${String(data.events.length)} events through POST /api/v1/ingest…`);
        result = await seedInProcess(database, ctx.config, data);
      } finally {
        database.close();
      }
    }

    printSummary(data, result, performance.now() - started, ctx);
    return result.rejected.length === 0 && (result.failed?.length ?? 0) === 0
      ? EXIT_OK
      : EXIT_FAILURE;
  } catch (error) {
    if (error instanceof SeedRefusedError || error instanceof SeedSendError) {
      ctx.err(error.message);
      return EXIT_FAILURE;
    }
    throw error;
  }
}

/**
 * Opens the seed database. Refuses the normal database and a seed database
 * that already has events (unless `--reset`, which deletes only the seed
 * database files and starts over).
 */
export function openSeedDatabase(args: SeedArgs, ctx: SeedContext): Database {
  const dataDir = resolve(ctx.baseDir ?? REPO_ROOT, args.dataDir);
  const file = databasePath(dataDir);
  const normal = databasePath(ctx.config.dataDir);
  if (resolve(file) === resolve(normal)) {
    throw new SeedRefusedError(
      `Refusing to seed ${file}: it is the normal database (DATA_DIR). ` +
        `Use a separate --data-dir, e.g. ${DEFAULT_SEED_DATA_DIR}.`,
    );
  }
  ctx.out(`Database: ${file}`);

  // Before --reset deletes files: a server may run on the seed data
  // (`env DATA_DIR=data-seed pnpm dev`). Held until the database is closed.
  let lock: InstanceLock;
  try {
    lock = acquireInstanceLock(dataDir);
  } catch (error) {
    if (!(error instanceof InstanceLockedError)) throw error;
    throw new SeedRefusedError(
      `A server is running on ${dataDir} (env DATA_DIR=${args.dataDir} pnpm dev?). ` +
        'Stop it first, or seed it through the API with --url and --key.',
    );
  }
  try {
    return withLock(openSeedDatabaseLocked(args, file), lock);
  } catch (error) {
    lock.release();
    throw error;
  }
}

function withLock(database: Database, lock: InstanceLock): Database {
  return {
    ...database,
    close: () => {
      database.close();
      lock.release();
    },
  };
}

function openSeedDatabaseLocked(args: SeedArgs, file: string): Database {
  if (args.reset) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  }

  const database = openDatabase(file);
  const stored = database.db.select({ n: count() }).from(eventsTable).get()?.n ?? 0;
  if (stored > 0) {
    database.close();
    throw new SeedRefusedError(
      `The seed database already has ${String(stored)} events. ` +
        'Run with --reset to delete it and seed again.',
    );
  }
  return database;
}

/** Sends to a running server with `--url`/`--key`, paced under its rate limit. */
async function seedRemote(
  remote: { url: string; key: string },
  data: SeedData,
  ctx: SeedContext,
): Promise<SendResult> {
  // eslint-disable-next-line no-restricted-globals -- `pnpm seed --url`: the user's own server, not an external service
  const doFetch = ctx.fetch ?? fetch;
  const headers = { authorization: `Bearer ${remote.key}` };
  ctx.out(`Server: ${remote.url}`);
  ctx.out('The target database should be empty: the dashboard API cannot check it yet.');

  const verify = await doFetch(`${remote.url}/api/v1/ingest/verify`, { headers });
  if (verify.status !== 200) {
    throw new SeedRefusedError(
      `The server did not accept the key (GET /api/v1/ingest/verify gave ${String(verify.status)}).`,
    );
  }

  const transport: Transport = async (events: readonly Event[]) => {
    const response = await doFetch(`${remote.url}/api/v1/ingest`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after') ?? undefined);
    return {
      status: response.status,
      body,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  };

  const requests = planRequests(data.deliveries);
  ctx.out(
    `Sending ${String(data.events.length)} events in ${String(requests.length)} requests ` +
      `(about ${String(Math.ceil((requests.length * REMOTE_MIN_INTERVAL_MS) / 1000))} s)…`,
  );
  return sendRequests(requests, {
    transport,
    minIntervalMs: REMOTE_MIN_INTERVAL_MS,
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
  });
}

/** What a seed run did. `failed` and `externalSnapshots` are only known for the local database. */
type SeedResult = SendResult & {
  failed?: { eventId: string; type: string; error: string }[];
  externalSnapshots?: number;
};

const number = (value: number) => value.toLocaleString('en-US');

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${number(hours)} h ${String(minutes)} min`;
}

function printSummary(
  data: SeedData,
  result: SeedResult,
  elapsedMs: number,
  ctx: SeedContext,
): void {
  const { stats } = data;
  const out = ctx.out;
  out('');
  out('Accounts:');
  for (const account of data.accounts) {
    out(
      `  ${account.displayName.padEnd(14)} ${account.accountType.padEnd(18)} ${account.accountHash}`,
    );
  }
  const ends = stats.sessionsByEnd;
  out(
    `Sessions: ${number(stats.sessions)} (logout ${String(ends.logout)}, client_closed ` +
      `${String(ends.client_closed)}, hop ${String(ends.hop)}, crashed ${String(ends.crash)}, ` +
      `still open ${String(ends.open)})`,
  );
  out(`Events: ${number(data.events.length)}`);
  for (const type of EVENT_TYPES) {
    out(`  ${type.padEnd(18)} ${number(stats.eventsByType[type]).padStart(8)}`);
  }
  out(
    `Play time: ${duration(stats.playSeconds)} (active ${duration(stats.playSeconds - stats.afkSeconds)}, ` +
      `AFK ${duration(stats.afkSeconds)})`,
  );
  out(`XP gained: ${number(stats.xpGained)}`);
  out(`Loot value: ${number(stats.lootGeValue)} GP`);
  out(`Raid completions: ${number(stats.raids.completions)}`);
  for (const [mode, count] of Object.entries(stats.raids.byMode)) {
    out(`  ${mode.padEnd(36)} ${number(count).padStart(6)}`);
  }
  out(
    `Raid special loot: ${number(stats.raids.specialLoot.SELF)} yours (also in the chest loot), ` +
      `${number(stats.raids.specialLoot.TEAMMATE)} teammates'`,
  );
  if (data.collectionLogs.length > 0) {
    const names = new Map(data.accounts.map((a) => [a.accountHash, a.displayName]));
    out(
      result.externalSnapshots === undefined
        ? 'Collection log: skipped with --url (it is not an event, so it cannot go through ingest)'
        : `Collection log: ${number(result.externalSnapshots)} responses stored as raw external data ` +
            '(not through ingest, source left off)',
    );
    if (result.externalSnapshots !== undefined) {
      for (const log of data.collectionLogs) {
        out(
          `  ${(names.get(log.accountHash) ?? log.accountHash).padEnd(14)} ` +
            `${number(log.obtained)} of ${number(log.total)} slots`,
        );
      }
    }
  }
  if (data.backlog) out(`Offline backlog: ${data.backlog.from} → ${data.backlog.to} (sent late)`);
  out(
    `Sent: ${number(result.requests)} requests, ${number(result.accepted)} accepted, ` +
      `${number(result.duplicates)} duplicates, ${number(result.rejected.length)} rejected` +
      (result.failed === undefined
        ? ' (projection failures not visible with --url)'
        : `, ${number(result.failed.length)} failed projections`) +
      (result.retries > 0 ? `, ${String(result.retries)} retries` : ''),
  );
  out(`Done in ${(elapsedMs / 1000).toFixed(1)} s`);

  for (const rejected of result.rejected.slice(0, 10)) {
    ctx.err(`  rejected ${rejected.eventId ?? '(no id)'} ${rejected.type}: ${rejected.error}`);
  }
  for (const failed of result.failed?.slice(0, 10) ?? []) {
    ctx.err(`  failed ${failed.eventId} ${failed.type}: ${failed.error}`);
  }
  if (result.rejected.length > 0 || (result.failed?.length ?? 0) > 0) {
    ctx.err('Seeding was not clean: this is a bug in the seed generator or the server.');
  }
}
