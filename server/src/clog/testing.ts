import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { createExternalClient } from '../external/client.js';
import { createRuneProfileProvider } from './runeprofile.js';
import { createClogSyncer } from './sync.js';

// Test helpers: hand-written responses in the shape of RuneProfile's public
// API, and a scripted fetch. No real network, no real account names, no images.

/** The environment that turns RuneProfile on. */
export const RUNEPROFILE_ON = {
  RUNEPROFILE_ENABLED: 'true',
  USER_AGENT_CONTACT: 'you@example.com',
};

const NAMES: Record<number, string> = {
  13262: 'Abyssal orphan',
  13277: 'Jar of miasma',
  4151: 'Abyssal whip',
  21992: 'Vorki',
  22006: 'Skeletal visage',
};

/** A small collection log: two boss pages and "All Pets", which repeats both pets. */
const LAYOUT = [
  {
    name: 'Bosses',
    pages: [
      { name: 'Abyssal Sire', items: [13262, 13277, 4151] },
      { name: 'Vorkath', items: [21992, 22006] },
    ],
  },
  { name: 'Other', pages: [{ name: 'All Pets', items: [13262, 21992] }] },
];

export interface ClogBodyOptions {
  /** Extra items appended to the Vorkath page, e.g. one the server has never heard of. */
  extraItems?: { id: number; name: string; quantity: number }[];
}

/**
 * `GET /accounts/{name}/collection-log` as RuneProfile builds it: every item,
 * `quantity` 0 for missing ones, unique counts at the top and page sums per tab.
 */
export function clogBody(
  quantities: Record<number, number>,
  { extraItems = [] }: ClogBodyOptions = {},
): string {
  const unique = new Map<number, number>();
  const tabs = LAYOUT.map((tab) => {
    const pages = tab.pages.map((page) => {
      const items = [
        ...page.items.map((id) => ({
          id,
          name: NAMES[id] ?? 'Unknown',
          quantity: quantities[id] ?? 0,
        })),
        ...(page.name === 'Vorkath' ? extraItems : []),
      ];
      for (const item of items) unique.set(item.id, item.quantity);
      return {
        name: page.name,
        obtained: items.filter((item) => item.quantity > 0).length,
        total: items.length,
        items,
      };
    });
    return {
      name: tab.name,
      obtained: pages.reduce((sum, page) => sum + page.obtained, 0),
      total: pages.reduce((sum, page) => sum + page.total, 0),
      pages,
    };
  });
  return JSON.stringify({
    obtained: [...unique.values()].filter((quantity) => quantity > 0).length,
    total: unique.size,
    tabs,
  });
}

/** One page of `GET /accounts/{name}/activities`, newest first. */
export function feedBody(
  entries: readonly (readonly [itemId: number, createdAt: string])[],
  nextCursor: string | null = null,
): string {
  return JSON.stringify({
    activities: entries.map(([itemId, createdAt]) => ({
      type: 'new_item_obtained',
      data: { itemId },
      enriched: { itemName: NAMES[itemId] ?? 'Unknown' },
      createdAt,
    })),
    nextCursor,
    prevCursor: null,
    hasMore: nextCursor !== null,
    hasPrev: false,
  });
}

/** `GET /accounts/{name}`, with the fields the API has. Only `updatedAt` is read. */
export function summaryBody(updatedAt: string): string {
  return JSON.stringify({
    username: 'Seed Main',
    accountType: { id: 0, key: 'NORMAL', name: 'Normal' },
    clan: null,
    groupName: null,
    skills: { totalLevel: 1500, totalXp: 50_000_000 },
    collectionLog: { obtained: 2, total: 5 },
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt,
  });
}

export type Reply = string | number | Error | (() => string | number | Error | Promise<Response>);

export interface FakeRequest {
  /** Path and query, e.g. `/v1/accounts/Seed%20Main/collection-log`. */
  path: string;
  headers: Record<string, string>;
  at: string;
}

/**
 * A scripted RuneProfile: a reply per endpoint, as a body (200), a status
 * code, an error, or a function giving one of them. A function may also
 * return a promise of a `Response`, to hold a request open.
 */
export function fakeRuneProfile(now: () => Date) {
  const requests: FakeRequest[] = [];
  const replies: { summary: Reply; collectionLog: Reply; activities: Reply } = {
    summary: 404,
    collectionLog: 404,
    activities: feedBody([]),
  };
  const fetchMock = ((url: string, init: RequestInit) => {
    const { pathname, search, origin } = new URL(url);
    if (origin !== 'https://api.runeprofile.com') {
      return Promise.reject(new Error(`Unexpected origin ${origin}`));
    }
    requests.push({
      path: pathname + search,
      headers: init.headers as Record<string, string>,
      at: now().toISOString(),
    });
    const scripted = pathname.endsWith('/collection-log')
      ? replies.collectionLog
      : pathname.endsWith('/activities')
        ? replies.activities
        : replies.summary;
    const reply = typeof scripted === 'function' ? scripted() : scripted;
    if (reply instanceof Promise) return reply;
    if (reply instanceof Error) return Promise.reject(reply);
    if (typeof reply === 'number') {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'x', code: 'X' }), { status: reply }),
      );
    }
    return Promise.resolve(new Response(reply, { status: 200 }));
  }) as unknown as typeof fetch;
  return { requests, replies, fetch: fetchMock };
}

export interface TestClock {
  now: () => Date;
  advance(ms: number): void;
  set(iso: string): void;
}

export function testClock(start: string): TestClock {
  let nowMs = Date.parse(start);
  return {
    now: () => new Date(nowMs),
    advance: (ms) => {
      nowMs += ms;
    },
    set: (iso) => {
      nowMs = Date.parse(iso);
    },
  };
}

export const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface TestSyncerOptions {
  maxFeedPages?: number;
  /** The client's waits (rate limit, backoff) move the clock. Off by default, so times stay round. */
  waitsMoveClock?: boolean;
}

/** The real client, provider and syncer on a scripted RuneProfile. */
export function testSyncer(
  db: Db,
  config: Config,
  clock: TestClock,
  { maxFeedPages, waitsMoveClock = false }: TestSyncerOptions = {},
) {
  const api = fakeRuneProfile(clock.now);
  const logs: { level: string; obj: object; msg: string }[] = [];
  const log = (level: string) => (obj: object, msg: string) => {
    logs.push({ level, obj, msg });
  };
  const client = createExternalClient({
    config,
    log: { info: log('info'), warn: log('warn'), error: log('error') },
    fetch: api.fetch,
    now: clock.now,
    sleep: (ms) => {
      if (waitsMoveClock) clock.advance(ms);
      return Promise.resolve();
    },
    random: () => 0,
  });
  const syncer = createClogSyncer({
    db,
    config,
    provider: createRuneProfileProvider({
      client,
      ...(maxFeedPages === undefined ? {} : { maxFeedPages }),
    }),
    // The same captured log as the client's.
    log: { info: log('info'), warn: log('warn'), error: log('error') },
    now: clock.now,
  });
  return { ...api, client, syncer, logs };
}
