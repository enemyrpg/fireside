import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { intFromString } from '@fireside/shared';
import { z } from 'zod';
import { REPO_ROOT } from './paths.js';

// Server config from environment variables (and `.env`, loaded in index.ts).
// See .env.example for what each variable does.

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Values of `TRUSTED_PROXY`. */
export const TRUSTED_PROXIES = ['cloudflare'] as const;
export type TrustedProxy = (typeof TRUSTED_PROXIES)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Standard spelling of an IANA time zone name (`europe/oslo` → `Europe/Oslo`,
 * `US/Eastern` → `America/New_York`), or `undefined` if it isn't one. Offsets
 * like `+01:00` are rejected: Intl accepts them, but they are not valid in
 * `process.env.TZ`, so Date and Intl would disagree.
 */
export function canonicalTimeZone(value: string): string | undefined {
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  return /^[+-]/.test(resolved) ? undefined : resolved;
}

/**
 * Loads `.env` from the repo root into `process.env`, if it exists. Real
 * environment variables win, so Docker and systemd can set them directly.
 */
export function loadEnvFile(baseDir: string = REPO_ROOT): void {
  const envFile = join(baseDir, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Why `PUBLIC_URL` can't be used, or `undefined`. It must be an origin only
 * (no path, query, fragment or credentials) and https, except on a loopback
 * host: browsers keep the `Secure` session cookie on http://localhost, but
 * on any other http address login would never work.
 */
export function publicUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Must be a URL like https://app.example.com';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'Must start with https://';
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return 'Must be only the scheme and host (and port), like https://app.example.com';
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return (
      'Must use https:// (http:// only works for localhost): the login cookie is ' +
      'Secure, so a browser never sends it back over plain http'
    );
  }
  return undefined;
}

function envSchema(baseDir: string) {
  return z.object({
    // Never default to all interfaces: see
    // docs/decisions/0005-security-defaults.md.
    HOST: z.string().default('127.0.0.1'),
    PORT: intFromString(z.int().min(1).max(65535)).default(3100),
    TZ: z
      .string()
      .default('UTC')
      .transform((value, context) => {
        const timeZone = canonicalTimeZone(value);
        if (timeZone === undefined) {
          context.addIssue({
            code: 'custom',
            message: 'Must be an IANA time zone name, e.g. Europe/Oslo',
          });
          return z.NEVER;
        }
        return timeZone;
      }),
    DATA_DIR: z
      .string()
      .default('./data')
      .transform((path) => resolve(baseDir, path)),
    // Defaults to `<DATA_DIR>/backups` (set in loadConfig).
    BACKUP_DIR: z
      .string()
      .optional()
      .transform((path) => (path === undefined ? undefined : resolve(baseDir, path))),
    BACKUP_ENABLED: z
      .enum(['true', 'false'], { error: 'Must be true or false' })
      .default('true')
      .transform((value) => value === 'true'),
    BACKUP_TIME: z
      .string()
      .default('04:00')
      .transform((value, context) => {
        const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value);
        if (!match) {
          context.addIssue({ code: 'custom', message: 'Must be a time like 04:00 (HH:MM)' });
          return z.NEVER;
        }
        return { hour: Number(match[1]), minute: Number(match[2]) };
      }),
    BACKUP_KEEP_DAILY: intFromString(z.int().min(0).max(1000)).default(7),
    BACKUP_KEEP_WEEKLY: intFromString(z.int().min(0).max(1000)).default(4),
    BACKUP_KEEP_MONTHLY: intFromString(z.int().min(0).max(1000)).default(6),
    LOG_LEVEL: z
      .enum(LOG_LEVELS, { error: `Must be one of: ${LOG_LEVELS.join(', ')}` })
      .default('info'),
    // Optional external source: GE prices from the OSRS Wiki (prices/fetch.ts).
    PRICES_ENABLED: z
      .enum(['true', 'false'], { error: 'Must be true or false' })
      .default('false')
      .transform((value) => value === 'true'),
    // Optional external source: collection log from RuneProfile (clog/runeprofile.ts).
    RUNEPROFILE_ENABLED: z
      .enum(['true', 'false'], { error: 'Must be true or false' })
      .default('false')
      .transform((value) => value === 'true'),
    // Sent as `X-API-Key`. A secret: never logged, never returned by the API.
    RUNEPROFILE_API_KEY: z
      .string()
      .regex(/^[!-~]{1,200}$/, { error: 'Must be 1-200 printable characters without spaces' })
      .optional(),
    // Extra host the dashboard answers to in login mode. Must be https, or the
    // `Secure` session cookie is never sent back.
    PUBLIC_URL: z
      .string()
      .optional()
      .transform((value, context) => {
        if (value === undefined) return undefined;
        const problem = publicUrlProblem(value);
        if (problem !== undefined) {
          context.addIssue({ code: 'custom', message: problem });
          return z.NEVER;
        }
        return new URL(value).origin;
      }),
    // The reverse proxy in front of the server. Only with `cloudflare` is the
    // client IP read from `CF-Connecting-IP`, and only when the request comes
    // from loopback (cloudflared on this machine).
    TRUSTED_PROXY: z.enum(TRUSTED_PROXIES, { error: 'Must be cloudflare, or unset' }).optional(),
    // Most users this instance may have, checked when an invite is made and
    // when it is used. Unset: no limit.
    MAX_USERS: intFromString(z.int().min(1).max(100_000)).optional(),
    // Goes into the User-Agent of every external call (see user-agent.ts).
    USER_AGENT_CONTACT: z
      .string()
      // Printable ASCII without spaces and without ( ) \ ", which have a
      // meaning inside the `( … )` comment of a User-Agent header.
      .regex(/^[!#$%&'*+,\-./0-9:;<=>?@A-Z[\]^_`a-z{|}~]+$/, {
        error:
          'Must be an email address or URL, without spaces, quotes, parentheses or backslashes',
      })
      .optional(),
  });
}

/** Every variable the server reads. `.env.example` documents each one (config.test.ts). */
export const ENV_NAMES = Object.keys(envSchema(REPO_ROOT).shape) as (keyof ReturnType<
  typeof envSchema
>['shape'])[];

export interface Config {
  host: string;
  /** 1–65535. Tests that need a random port pass 0 to `listen` directly. */
  port: number;
  /** IANA time zone used for day and week grouping, in its standard spelling. */
  timeZone: string;
  /** Absolute path to the directory for the SQLite database. */
  dataDir: string;
  logLevel: LogLevel;
  backup: BackupConfig;
  /**
   * Email address or URL where API owners can reach whoever runs this
   * instance. `null` when unset; optional external features stay off then.
   */
  userAgentContact: string | null;
  prices: PricesConfig;
  runeprofile: RuneProfileConfig;
  /**
   * `PUBLIC_URL` as an origin (`https://app.example.com`), or `null`. Its
   * host is the only one besides localhost that the dashboard answers to,
   * and only in login mode.
   */
  publicUrl: string | null;
  /**
   * `TRUSTED_PROXY`, or `null`. With `cloudflare`, requests from loopback
   * that carry `CF-Connecting-IP` came through Cloudflare Tunnel (auth/client-ip.ts).
   */
  trustedProxy: TrustedProxy | null;
  /** `MAX_USERS`: most users (disabled ones count), or `null` for no limit. */
  maxUsers: number | null;
}

export interface RuneProfileConfig {
  /**
   * `RUNEPROFILE_ENABLED`. Collection logs are only fetched when this is on,
   * `userAgentContact` is set, and the owner has turned the source on for the
   * account in the dashboard.
   */
  enabled: boolean;
  /** `RUNEPROFILE_API_KEY`. Optional: a higher rate limit. A secret. */
  apiKey: string | null;
}

/** Flags of the optional external sources, by the name of their `.env` variable. */
export interface PricesConfig {
  /**
   * `PRICES_ENABLED`. Prices are only fetched (and used) when this is on and
   * `userAgentContact` is set: see external/client.ts.
   */
  enabled: boolean;
}

/** How many backups to keep per level (see backup/retention.ts). 0 turns a level off. */
export interface RetentionConfig {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface BackupConfig {
  /** Absolute path to the backup folder. Default: `<dataDir>/backups`. */
  dir: string;
  /** Automatic daily backups while the server runs. `pnpm cli backup` always works. */
  enabled: boolean;
  /** Local time (in `TZ`) of the daily backup. */
  time: { hour: number; minute: number };
  keep: RetentionConfig;
}

/** Thrown by `loadConfig`. The message lists every invalid variable. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Reads and validates the config. Empty or whitespace-only values count as
 * unset, so `HOST=` falls back to 127.0.0.1. A relative `DATA_DIR` is
 * resolved from `baseDir` (the repo root, where `.env` lives), so the
 * database is in the same place however the server is started. Values are
 * never echoed in errors, in case a future variable holds a secret.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  baseDir: string = REPO_ROOT,
): Config {
  const raw = Object.fromEntries(
    ENV_NAMES.map((name) => {
      const value = env[name]?.trim();
      return [name, value === '' ? undefined : value];
    }),
  );

  const result = envSchema(baseDir).safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }

  const parsed = result.data;
  // A proxied request has the public host, so the network check needs it,
  // and HSTS and the Secure cookie need https.
  if (parsed.TRUSTED_PROXY !== undefined && !parsed.PUBLIC_URL?.startsWith('https://')) {
    throw new ConfigError(
      'Invalid configuration:\n  TRUSTED_PROXY: Needs PUBLIC_URL set to an https URL, e.g. https://app.example.com',
    );
  }
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    timeZone: parsed.TZ,
    dataDir: parsed.DATA_DIR,
    logLevel: parsed.LOG_LEVEL,
    backup: {
      dir: parsed.BACKUP_DIR ?? join(parsed.DATA_DIR, 'backups'),
      enabled: parsed.BACKUP_ENABLED,
      time: parsed.BACKUP_TIME,
      keep: {
        daily: parsed.BACKUP_KEEP_DAILY,
        weekly: parsed.BACKUP_KEEP_WEEKLY,
        monthly: parsed.BACKUP_KEEP_MONTHLY,
      },
    },
    userAgentContact: parsed.USER_AGENT_CONTACT ?? null,
    publicUrl: parsed.PUBLIC_URL ?? null,
    trustedProxy: parsed.TRUSTED_PROXY ?? null,
    maxUsers: parsed.MAX_USERS ?? null,
    prices: { enabled: parsed.PRICES_ENABLED },
    runeprofile: {
      enabled: parsed.RUNEPROFILE_ENABLED,
      apiKey: parsed.RUNEPROFILE_API_KEY ?? null,
    },
  };
}
