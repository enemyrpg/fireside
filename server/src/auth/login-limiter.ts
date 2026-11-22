// Login throttling. Never a permanent lockout: anyone can type any username, so
// a lockout would let a stranger shut the real user out for good. Every rule is
// a hard limit with a growing wait: after `free` failed attempts, each attempt
// must wait 2^k seconds (capped at 15 min) after the last failure; earlier ones
// get `429` with `Retry-After`. Attempts are counted when they start, so a
// burst of parallel requests is limited too; a success takes its count back. A
// refused attempt records nothing, so waiting never makes the wait longer. The
// first refusal of each wait is marked (`firstRefusal`), so the caller logs a
// block once, not once per refused attempt.
//
// Buckets (`AuthLimiters`):
// - `login:ip` – per client IP (`request.clientIp`, auth/client-ip.ts): every
//   password and 2FA code check.
// - `login:user` – per typed username, across all IPs. Skipped by a valid
//   device cookie for that user (auth/devices.ts), so the owner on a known
//   browser is never held up by someone guessing their password. Unknown
//   usernames are treated the same.
// - `totp:user` – per user ID: 2FA and recovery codes.
// - `reauth:user` – per user ID: password checks with a session (password
//   change, deleting the account, 2FA settings). Never `login:user`, so a
//   stranger flooding the username can't block the owner's own changes.
// - `invite:ip` – per client IP: invite and password reset links.
//
// Counters are forgotten an hour after the last failure, and on restart.
// IPv6 addresses count per /64 (`ipLimitKey`), since one host usually has a
// whole /64 to rotate through.
//
// Each map is bounded (`MAX_ENTRIES`), and a key that must wait is never
// dropped to make room: otherwise a flood of other keys would push a blocked
// username out and hand the attacker fresh guesses. A full map drops a key
// still within its free attempts, then a key whose wait is over; in both cases
// the one with the fewest failures, the oldest of those. So new keys with one
// failure each push out each other, never a key with more failures. If every
// key is waiting, a new key is not stored:
// - per-user buckets (`login:user`, `totp:user`, `reauth:user`) fail closed:
//   the new key is refused until the first wait ends. For `login:user` only
//   devices without a device cookie are held up; the owner on a known browser
//   never touches that bucket.
// - per-IP buckets (`login:ip`, `invite:ip`, ingest) fail open: the new IP is
//   let through uncounted. Failing closed there would refuse every new IP,
//   also a known device on a new network and a logged-in user confirming a
//   password. What guards a password is the per-user bucket, which holds.
// Either way no stored wait is ever shortened or forgotten early.
//
// `IpFailureLimiter` is the same hard per-IP rule for ingest requests without
// a valid API key: only failures count, so a valid key is never limited by its
// IP.

export interface LimitRule {
  /** Failures allowed before any wait. */
  free: number;
  /** Longest wait in ms. */
  maxDelayMs: number;
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;
export const IP_RULE: LimitRule = { free: 20, maxDelayMs: FIFTEEN_MINUTES };
/** `login:user`: per typed username from devices without a valid device cookie. */
export const LOGIN_USER_RULE: LimitRule = { free: 10, maxDelayMs: FIFTEEN_MINUTES };
/** `totp:user`: 2FA and recovery codes, per user. */
export const TOTP_RULE: LimitRule = { free: 5, maxDelayMs: FIFTEEN_MINUTES };
/** `reauth:user`: password checks with a session, per user. */
export const REAUTH_RULE: LimitRule = { free: 10, maxDelayMs: FIFTEEN_MINUTES };
export const FORGET_AFTER_MS = 60 * 60 * 1000;
/**
 * Most keys per bucket. A full bucket measured about 22 MB of heap for
 * usernames and 16 MB for IPv6 /64 keys (roughly 200 bytes a key), so all
 * six buckets full is about 110 MB, and filling one takes 100 000 failed
 * attempts within the hour.
 */
export const MAX_ENTRIES = 100_000;

interface Entry {
  failures: number;
  lastFailureAt: number;
  /** A refusal during the wait after `lastFailureAt` was reported (`markReported`). */
  reported?: boolean;
}

/** What a bucket does with a new key when every stored key is waiting. */
export type WhenFull = 'refuse' | 'allow';

/** Expands an IPv6 address (without zone) into its 8 groups, or `undefined`. */
function ipv6Groups(ip: string): string[] | undefined {
  const toGroups = (part: string): string[] => {
    if (part === '') return [];
    return part.split(':').flatMap((group) => {
      // An embedded IPv4 address is two groups.
      if (group.includes('.')) {
        const bytes = group.split('.').map(Number);
        return [
          ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0),
          ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0),
        ].map((n) => n.toString(16));
      }
      return [group];
    });
  };
  const halves = ip.split('::');
  if (halves.length > 2) return undefined;
  const left = toGroups(halves[0] ?? '');
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const right = toGroups(halves[1] ?? '');
  const zeros = 8 - left.length - right.length;
  if (zeros < 0) return undefined;
  return [...left, ...Array<string>(zeros).fill('0'), ...right];
}

/**
 * The key an IP is counted under: IPv4 as is (also when IPv4-mapped or
 * behind NAT64 in the well-known prefix `64:ff9b::/96`, so each IPv4 client
 * behind one gateway has its own counter), IPv6 by its /64, so one host
 * can't get fresh counters (or flush the map) by rotating addresses inside
 * its own network.
 */
export function ipLimitKey(ip: string): string {
  const address = ip.toLowerCase().replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (!address.includes(':')) return address;
  const groups = ipv6Groups(address);
  if (!groups) return address;
  const nat64 = groups.slice(0, 6).map((group) => parseInt(group, 16));
  if (nat64.join(':') === '100:65435:0:0:0:0') {
    const high = parseInt(groups[6] ?? '0', 16);
    const low = parseInt(groups[7] ?? '0', 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * Failure counters by key, forgotten after `FORGET_AFTER_MS`, at most
 * `maxEntries`. A key that must wait is never dropped to make room.
 */
class CounterMap {
  /** In order of last failure (oldest first). */
  private readonly entries = new Map<string, Entry>();
  /**
   * Keys still within their free attempts (they can't be waiting), by number
   * of failures: `tiers[n]` holds the keys with `n` failures, oldest first.
   * The first to go when the map is full, fewest failures first, so a flood
   * of new keys with one failure each drops its own keys and never one that
   * has more (a username a few guesses short of its limit).
   */
  private readonly tiers: Set<string>[];
  /** Keys in `tiers`. */
  private freeKeys = 0;
  /**
   * Every stored key was waiting at the last look, and the first wait ends
   * at this time: until then (or until a key is removed) there is no room,
   * without scanning again. 0 when unknown.
   */
  private fullUntil = 0;

  constructor(
    private readonly rule: LimitRule,
    private readonly maxEntries: number,
  ) {
    this.tiers = Array.from({ length: Math.max(rule.free, 1) }, () => new Set<string>());
  }

  get(key: string, at: number): Entry | undefined {
    this.sweep(at);
    const entry = this.entries.get(key);
    if (entry && at - entry.lastFailureAt >= FORGET_AFTER_MS) {
      this.remove(key);
      return undefined;
    }
    return entry;
  }

  /**
   * How long a key that is not stored must wait for room, in ms: 0 when
   * there is room or a key can be dropped. Changes nothing.
   */
  roomWaitMs(at: number): number {
    if (this.entries.size < this.maxEntries || this.freeKeys > 0) return 0;
    if (at < this.fullUntil) return this.fullUntil - at;
    let first = Infinity;
    for (const entry of this.entries.values()) {
      const wait = waitMs(this.rule, entry, at);
      if (wait === 0) return 0;
      first = Math.min(first, at + wait);
    }
    // An empty map with `maxEntries` 0 never has room.
    this.fullUntil = Number.isFinite(first) ? first : at + 1000;
    return this.fullUntil - at;
  }

  /**
   * Stores `entry`. Returns `false`, storing nothing, when `key` is new and
   * every stored key is waiting.
   */
  set(key: string, entry: Entry): boolean {
    this.sweep(entry.lastFailureAt);
    const old = this.entries.get(key);
    if (!old && !this.makeRoom(entry.lastFailureAt)) return false;
    // Re-inserting keeps the map (and the key's tier) in order of last failure.
    if (old) this.untrack(key, old);
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.track(key, entry);
    return true;
  }

  delete(key: string): void {
    this.remove(key);
  }

  /** Changes the count of an entry without a new failure: keeps its place in the order. */
  replaceCount(key: string, failures: number): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const changed = { ...entry, failures };
    this.untrack(key, entry);
    this.entries.set(key, changed);
    this.track(key, changed);
    this.fullUntil = 0;
  }

  /** Marks the wait `key` is in as reported. Returns `false` if it already was. */
  markReported(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || entry.reported) return false;
    entry.reported = true;
    return true;
  }

  /**
   * Drops one key that isn't waiting, if the map is full: the one with the
   * fewest failures, the oldest of those. `false` if none can go.
   */
  private makeRoom(at: number): boolean {
    if (this.entries.size < this.maxEntries) return true;
    for (const tier of this.tiers) {
      const oldest = tier.keys().next().value;
      if (oldest !== undefined) {
        this.remove(oldest);
        return true;
      }
    }
    // No key within its free attempts: one whose wait is over. A full pass,
    // but the key stored next lands in a tier, so the next call is cheap.
    if (this.roomWaitMs(at) > 0) return false;
    let drop: string | undefined;
    let fewest = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.failures < fewest && waitMs(this.rule, entry, at) === 0) {
        drop = key;
        fewest = entry.failures;
      }
    }
    if (drop === undefined) return false;
    this.remove(drop);
    return true;
  }

  private track(key: string, entry: Entry): void {
    const tier = entry.failures < this.rule.free ? this.tiers[entry.failures] : undefined;
    if (tier && !tier.has(key)) {
      tier.add(key);
      this.freeKeys += 1;
    }
  }

  private untrack(key: string, entry: Entry): void {
    if (this.tiers[entry.failures]?.delete(key)) this.freeKeys -= 1;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.untrack(key, entry);
    this.entries.delete(key);
    this.fullUntil = 0;
  }

  /**
   * Drops every forgotten entry, so no IP or typed username stays in memory
   * past the hour once the limiter is used again. The map is in order of last
   * failure, so only the front needs checking.
   */
  private sweep(at: number): void {
    for (const [key, entry] of this.entries) {
      if (at - entry.lastFailureAt < FORGET_AFTER_MS) break;
      this.remove(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

function waitMs(rule: LimitRule, entry: Entry | undefined, at: number): number {
  if (!entry) return 0;
  return Math.max(0, entry.lastFailureAt + delayFor(rule, entry.failures) - at);
}

/**
 * Wait before the next attempt after `failures` failures: none for the first
 * `free` attempts, then 2 s, 4 s, 8 s … up to the cap.
 */
export function delayFor(rule: LimitRule, failures: number): number {
  if (failures < rule.free) return 0;
  const exponent = Math.min(failures - rule.free + 1, 30);
  return Math.min(2 ** exponent * 1000, rule.maxDelayMs);
}

export type Clock = () => Date;

export interface LimiterOptions {
  now?: Clock;
  maxEntries?: number;
}

/** What `begin` decided. `blocked` → answer `429` with `Retry-After`. */
export type Attempt =
  | {
      status: 'blocked';
      retryAfterSeconds: number;
      /**
       * The first refusal of this wait for the key that must wait: log it.
       * Later refusals of the same wait are `false`.
       */
      firstRefusal: boolean;
    }
  | {
      status: 'allowed';
      /** Call with the result of the check. Later calls do nothing. */
      finish: (succeeded: boolean) => void;
    };

export type AllowedAttempt = Extract<Attempt, { status: 'allowed' }>;

/** One bucket: a hard limit per key, counted when an attempt starts. */
export class HardLimiter {
  private readonly entries: CounterMap;
  readonly now: Clock;

  /** A full bucket was reported as full until this time (see `markReported`). */
  private fullReportedUntil = 0;

  constructor(
    private readonly rule: LimitRule,
    { now, maxEntries }: LimiterOptions = {},
    /** A new key when every stored key is waiting: see the top of this file. */
    private readonly whenFull: WhenFull = 'refuse',
  ) {
    this.now = now ?? (() => new Date());
    this.entries = new CounterMap(rule, maxEntries ?? MAX_ENTRIES);
  }

  /**
   * Ms `key` must still wait at `at`: its own wait, or for a new key in a
   * `refuse` bucket where every key is waiting, until the first of those
   * waits ends. Records nothing.
   */
  waitMs(key: string, at: number): number {
    const entry = this.entries.get(key, at);
    if (!entry && this.whenFull === 'refuse') return this.entries.roomWaitMs(at);
    return waitMs(this.rule, entry, at);
  }

  /**
   * Counts an attempt for `key` as started (a failure until `finish`). In a
   * bucket where every key is waiting, a new key is not counted (`allow`).
   */
  start(key: string, at: number): void {
    const entry = this.entries.get(key, at);
    this.entries.set(key, { failures: (entry?.failures ?? 0) + 1, lastFailureAt: at });
  }

  /**
   * Call for a key that `waitMs` refused: `true` the first time during this
   * wait (of the key, or of the full bucket for a new key), `false` after.
   */
  markReported(key: string, at: number): boolean {
    if (this.entries.get(key, at)) return this.entries.markReported(key);
    if (at < this.fullReportedUntil) return false;
    this.fullReportedUntil = at + this.entries.roomWaitMs(at);
    return true;
  }

  /** Ends an attempt `start` counted: a success takes the count back. */
  end(key: string, succeeded: boolean): void {
    const at = this.now().getTime();
    const entry = this.entries.get(key, at);
    if (!entry) return;
    if (succeeded) {
      if (entry.failures <= 1) this.entries.delete(key);
      else this.entries.replaceCount(key, entry.failures - 1);
    } else {
      // A new failure starts a new wait, to be reported again.
      this.entries.set(key, { failures: entry.failures, lastFailureAt: at });
    }
  }

  /** Forgets every failure of `key`. */
  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Starts an attempt in this bucket alone. */
  begin(key: string): Attempt {
    return beginAll([{ limiter: this, key }]);
  }

  /** For tests. */
  get size(): number {
    return this.entries.size;
  }
}

export interface LimitPart {
  limiter: HardLimiter;
  key: string;
}

/**
 * Starts one attempt counted in every bucket of `parts`. If any of them must
 * wait, nothing is recorded and the longest wait is returned.
 */
export function beginAll(parts: readonly LimitPart[]): Attempt {
  const first = parts[0];
  if (!first) throw new Error('beginAll needs at least one bucket');
  const at = first.limiter.now().getTime();
  const waits = parts.map(({ limiter, key }) => limiter.waitMs(key, at));
  const wait = Math.max(...waits);
  if (wait > 0) {
    // Every bucket that refuses is marked, so each wait is reported once.
    let firstRefusal = false;
    parts.forEach(({ limiter, key }, index) => {
      if ((waits[index] ?? 0) > 0 && limiter.markReported(key, at)) firstRefusal = true;
    });
    return { status: 'blocked', retryAfterSeconds: Math.ceil(wait / 1000), firstRefusal };
  }
  // Counted now, so parallel attempts can't all slip through.
  for (const { limiter, key } of parts) limiter.start(key, at);
  let finished = false;
  return {
    status: 'allowed',
    finish: (succeeded) => {
      if (finished) return;
      finished = true;
      for (const { limiter, key } of parts) limiter.end(key, succeeded);
    },
  };
}

/** Keys for the per-user buckets. */
const userKey = (userId: number) => `id:${String(userId)}`;

/**
 * Every bucket of the dashboard's auth routes, shared by the login, 2FA and
 * invite routes (made once in routes/dashboard.ts). Tests pass their own.
 */
export class AuthLimiters {
  readonly loginIp: HardLimiter;
  readonly loginUser: HardLimiter;
  readonly totp: HardLimiter;
  readonly reauth: HardLimiter;
  readonly inviteIp: HardLimiter;

  constructor(options: LimiterOptions = {}) {
    // Per IP: a full bucket lets a new IP through uncounted. Per user: it
    // refuses a new key (see the top of this file).
    this.loginIp = new HardLimiter(IP_RULE, options, 'allow');
    this.loginUser = new HardLimiter(LOGIN_USER_RULE, options, 'refuse');
    this.totp = new HardLimiter(TOTP_RULE, options, 'refuse');
    this.reauth = new HardLimiter(REAUTH_RULE, options, 'refuse');
    this.inviteIp = new HardLimiter(IP_RULE, options, 'allow');
  }

  /**
   * A password login for `username` (lower-cased by the caller). A known
   * device (valid device cookie for this very user) skips `login:user`.
   */
  login(ip: string, username: string, { knownDevice }: { knownDevice: boolean }): Attempt {
    const parts: LimitPart[] = [{ limiter: this.loginIp, key: ipLimitKey(ip) }];
    if (!knownDevice) parts.push({ limiter: this.loginUser, key: `user:${username}` });
    return beginAll(parts);
  }

  /**
   * A full login of `username` succeeded (the owner is in): forget every
   * failure counted against that username, also when the login came from a
   * known device, so the owner logging in clears what an attacker built up.
   */
  loginSucceeded(username: string): void {
    this.loginUser.reset(`user:${username}`);
  }

  /** A 2FA or recovery code at login (`login:ip` + `totp:user`). */
  totpLogin(ip: string, userId: number): Attempt {
    return beginAll([
      { limiter: this.loginIp, key: ipLimitKey(ip) },
      { limiter: this.totp, key: userKey(userId) },
    ]);
  }

  /** A 2FA code with a session, or on a reset link (`totp:user` only). */
  totpCode(userId: number): Attempt {
    return this.totp.begin(userKey(userId));
  }

  /** A password check with a session (`login:ip` + `reauth:user`). */
  reauthenticate(ip: string, userId: number): Attempt {
    return beginAll([
      { limiter: this.loginIp, key: ipLimitKey(ip) },
      { limiter: this.reauth, key: userKey(userId) },
    ]);
  }

  /** An invite or password reset link (`invite:ip`). */
  invite(ip: string): Attempt {
    return this.inviteIp.begin(ipLimitKey(ip));
  }
}

/**
 * The per-IP rule for requests where only failures count (ingest without a
 * valid API key). The caller checks the key first, so this never limits a valid
 * key, and the check is synchronous, so parallel requests can't slip past it.
 * When every stored IP is waiting, a new IP's failure is not counted (fail open,
 * see the top of this file): a blocked IP stays blocked.
 */
export class IpFailureLimiter {
  private readonly entries: CounterMap;
  private readonly now: Clock;

  constructor({ now, maxEntries }: LimiterOptions = {}) {
    this.now = now ?? (() => new Date());
    this.entries = new CounterMap(IP_RULE, maxEntries ?? MAX_ENTRIES);
  }

  /** The seconds `ip` must wait (for `Retry-After`), or `undefined`. Records nothing. */
  blocked(ip: string): { retryAfterSeconds: number } | undefined {
    const at = this.now().getTime();
    const wait = waitMs(IP_RULE, this.entries.get(ipLimitKey(ip), at), at);
    return wait > 0 ? { retryAfterSeconds: Math.ceil(wait / 1000) } : undefined;
  }

  /**
   * Records a failure from `ip`, unless it must wait: then returns the
   * seconds for `Retry-After` and records nothing.
   */
  fail(ip: string): { retryAfterSeconds: number } | undefined {
    const key = ipLimitKey(ip);
    const at = this.now().getTime();
    const entry = this.entries.get(key, at);
    const wait = waitMs(IP_RULE, entry, at);
    if (wait > 0) return { retryAfterSeconds: Math.ceil(wait / 1000) };
    this.entries.set(key, { failures: (entry?.failures ?? 0) + 1, lastFailureAt: at });
    return undefined;
  }

  /** For tests. */
  get size(): number {
    return this.entries.size;
  }
}
