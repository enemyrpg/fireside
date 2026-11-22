import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ExternalDisabledError,
  ExternalRequestError,
  type ExternalBody,
  type ExternalClient,
} from '../external/client.js';
import type {
  ClogFailure,
  ClogEndpoint,
  ClogFeedEntry,
  ClogFormatProblem,
  ClogFetchResult,
  ClogProvider,
  ClogTabEntry,
  RawBody,
} from './provider.js';

// RuneProfile's public API (see docs/architecture.md#external-sources).
// Read-only, and only ever called with the current name of an account the owner
// has turned RuneProfile on for.
//
// The formats are from RuneProfile's source (apps/api/src/public/v1, read on
// 16 November 2026). They are not yet confirmed against the live API.

const API = '/v1/accounts';

/** Activity feed entries per request: the API's maximum. */
export const FEED_PAGE_SIZE = 50;
/** Most feed pages read in one sync (1,000 items). */
export const MAX_FEED_PAGES = 20;
/** RuneScape display names are at most 12 characters. */
const MAX_NAME_LENGTH = 12;

/** The sync was cancelled (the server is stopping). No further request is made. */
export class ClogCancelledError extends Error {
  override name = 'ClogCancelledError';
}

/**
 * The response did not look like RuneProfile's API. Nothing is stored. The
 * message and `problem` hold paths and codes only, so both are safe to log.
 */
export class RuneProfileFormatError extends Error {
  override name = 'RuneProfileFormatError';
  constructor(
    message: string,
    readonly problem: ClogFormatProblem,
  ) {
    super(message);
  }
}

const count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * `GET /accounts/{name}/collection-log`: every tab, page and item of the
 * game's collection log, with `quantity` 0 for items the account does not
 * have. Strict on purpose, like the price reader: if the API changes shape
 * the sync fails with `INVALID_RESPONSE` and the last good collection log
 * stays, rather than being read wrongly.
 */
export const runeProfileCollectionLogSchema = z.strictObject({
  obtained: count,
  total: count,
  tabs: z.array(
    z.strictObject({
      name: z.string().min(1),
      obtained: count,
      total: count,
      pages: z.array(
        z.strictObject({
          name: z.string().min(1),
          obtained: count,
          total: count,
          items: z.array(
            z.strictObject({
              id: z.int().positive().max(Number.MAX_SAFE_INTEGER),
              name: z.string().min(1),
              quantity: count,
            }),
          ),
        }),
      ),
    }),
  ),
});

/**
 * `GET /accounts/{name}/activities?activityTypes=new_item_obtained`. Entries
 * of another type are a format error: the request asks for one type only.
 */
export const runeProfileActivitiesSchema = z.strictObject({
  activities: z.array(
    z.strictObject({
      type: z.literal('new_item_obtained'),
      data: z.strictObject({ itemId: z.int().positive().max(Number.MAX_SAFE_INTEGER) }),
      enriched: z.record(z.string(), z.string()).optional(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().min(1).nullable(),
  prevCursor: z.string().min(1).nullable(),
  hasMore: z.boolean(),
  hasPrev: z.boolean(),
});

/**
 * `GET /accounts/{name}`: only `updatedAt` is read (for the name guard), and
 * nothing of this response is ever stored, so other fields are not checked.
 */
const runeProfileSummarySchema = z.object({ updatedAt: z.string() });

/** Most problems listed for one response. */
const MAX_LOGGED_ISSUES = 20;

/** Every field name in the three responses. Anything else in a path came from the response. */
const KNOWN_FIELDS = new Set([
  'obtained',
  'total',
  'tabs',
  'name',
  'pages',
  'items',
  'id',
  'quantity',
  'activities',
  'type',
  'data',
  'itemId',
  'enriched',
  'createdAt',
  'nextCursor',
  'prevCursor',
  'hasMore',
  'hasPrev',
  'updatedAt',
]);

/**
 * `tabs.0.pages.3.items.12.id`. Indexes and our own field names only: a key
 * that came from the response (a record key) is written as `*`.
 */
function safePath(path: readonly PropertyKey[]): string {
  return path
    .map((part) =>
      typeof part === 'number'
        ? String(part)
        : typeof part === 'string' && KNOWN_FIELDS.has(part)
          ? part
          : '*',
    )
    .join('.');
}

const ENDPOINT_NAMES: Record<ClogEndpoint, string> = {
  COLLECTION_LOG: 'collection log',
  ACTIVITIES: 'activity feed',
  SUMMARY: 'account summary',
};

/** Built from paths and codes we wrote ourselves. Never values from the response. */
function formatProblem(
  endpoint: ClogEndpoint,
  issues: readonly { path: readonly PropertyKey[]; code: string }[],
): RuneProfileFormatError {
  const listed = issues.slice(0, MAX_LOGGED_ISSUES).map((issue) => {
    const where = safePath(issue.path);
    return `${where === '' ? '(root)' : where}: ${issue.code}`;
  });
  if (issues.length > MAX_LOGGED_ISSUES) {
    listed.push(`and ${String(issues.length - MAX_LOGGED_ISSUES)} more`);
  }
  const [first = '(root): invalid'] = listed;
  return new RuneProfileFormatError(
    `RuneProfile's ${ENDPOINT_NAMES[endpoint]} had an unexpected format at ${first}`,
    { endpoint, issues: listed },
  );
}

/** A Zod error's issues with Zod's own codes (`invalid_type`, `unrecognized_keys`, …). */
const zodProblem = (endpoint: ClogEndpoint, error: z.ZodError) =>
  formatProblem(
    endpoint,
    error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
  );

/**
 * A timestamp from RuneProfile as UTC ISO 8601 with milliseconds. Accepts ISO
 * 8601 and PostgreSQL's text form (`2026-11-16 04:12:20.123456+00`); a time
 * without a zone is UTC. `null` if it is neither.
 */
export function parseRuneProfileTime(value: string): string | null {
  const match =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      value.trim(),
    );
  if (!match) return null;
  const [, date = '', time = '', fraction = '', zone = 'Z'] = match;
  const offset =
    zone === 'Z'
      ? 'Z'
      : zone.length === 3
        ? `${zone}:00`
        : zone.replace(/^(.\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(`${date}T${time}.${fraction.padEnd(3, '0').slice(0, 3)}${offset}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The collection log in the provider's shape. Throws `RuneProfileFormatError`. */
export function parseCollectionLog(json: unknown): ClogTabEntry[] {
  const result = runeProfileCollectionLogSchema.safeParse(json);
  if (!result.success) throw zodProblem('COLLECTION_LOG', result.error);
  return result.data.tabs.map((tab) => ({
    name: tab.name,
    pages: tab.pages.map((page) => ({
      name: page.name,
      items: page.items.map((item) => ({
        itemId: item.id,
        name: item.name,
        quantity: item.quantity,
      })),
    })),
  }));
}

export interface ParsedActivities {
  entries: ClogFeedEntry[];
  /** For the next (older) page. `null` on the last one. */
  nextCursor: string | null;
}

/** One activity feed page. Throws `RuneProfileFormatError`. */
export function parseActivities(json: unknown): ParsedActivities {
  const result = runeProfileActivitiesSchema.safeParse(json);
  if (!result.success) throw zodProblem('ACTIVITIES', result.error);
  const entries = result.data.activities.map((activity, index) => {
    const obtainedAt = parseRuneProfileTime(activity.createdAt);
    if (obtainedAt === null) {
      throw formatProblem('ACTIVITIES', [
        { path: ['activities', index, 'createdAt'], code: 'invalid_format' },
      ]);
    }
    return { itemId: activity.data.itemId, obtainedAt };
  });
  return { entries, nextCursor: result.data.hasMore ? result.data.nextCursor : null };
}

/** `updatedAt` of the account summary as UTC ISO. Throws `RuneProfileFormatError`. */
export function parseSummaryUpdatedAt(json: unknown): string {
  const result = runeProfileSummarySchema.safeParse(json);
  if (!result.success) throw zodProblem('SUMMARY', result.error);
  const updatedAt = parseRuneProfileTime(result.data.updatedAt);
  if (updatedAt === null) {
    throw formatProblem('SUMMARY', [{ path: ['updatedAt'], code: 'invalid_format' }]);
  }
  return updatedAt;
}

/** `sha256:` and 64 hex characters, of the body's bytes. */
export function contentHash(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

/**
 * The name as RuneProfile looks it up, or `null` if it cannot be a RuneScape
 * name. RuneLite gives names with non-breaking spaces.
 */
export function lookupName(displayName: string | null): string | null {
  if (displayName === null) return null;
  const name = displayName.replaceAll('\u00a0', ' ').trim();
  return /^[A-Za-z0-9 _-]{1,12}$/.test(name) && name.length <= MAX_NAME_LENGTH ? name : null;
}

/** The status for a failed request. Built from the status code only. */
export function failureOf(error: unknown): ClogFailure {
  if (error instanceof ExternalDisabledError) return 'SOURCE_OFF';
  if (error instanceof RuneProfileFormatError) return 'INVALID_RESPONSE';
  if (error instanceof ExternalRequestError) {
    if (error.invalidBody) return 'INVALID_RESPONSE';
    if (error.status === 404) return 'PROFILE_NOT_FOUND';
    if (error.status === 401 || error.status === 403) return 'INVALID_API_KEY';
    if (error.status === 429) return 'RATE_LIMITED';
    if (error.status === null || error.status >= 500) return 'UNAVAILABLE';
    return 'INVALID_RESPONSE';
  }
  throw error;
}

const raw = ({ text }: ExternalBody): RawBody => ({ body: text, contentHash: contentHash(text) });

export interface RuneProfileProviderOptions {
  client: ExternalClient;
  maxFeedPages?: number;
}

/**
 * Collection log from RuneProfile. Per sync: one request for the collection
 * log; one for the account summary when the name guard runs; and, only when
 * the collection log changed (or the feed is due), the activity feed's "new
 * item" entries, 50 per request and at most `maxFeedPages` requests.
 */
export function createRuneProfileProvider({
  client,
  maxFeedPages = MAX_FEED_PAGES,
}: RuneProfileProviderOptions): ClogProvider {
  async function readFeed(
    base: string,
    from: string | null,
    check: () => void,
  ): Promise<RawBody[]> {
    const pages: RawBody[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxFeedPages; page++) {
      const query = new URLSearchParams({
        activityTypes: 'new_item_obtained',
        limit: String(FEED_PAGE_SIZE),
      });
      if (from !== null) query.set('from', from);
      if (cursor !== null) query.set('cursor', cursor);
      check();
      const body = await client.getText('RUNEPROFILE', `${base}/activities?${query.toString()}`);
      const parsed = parseActivities(body.json);
      if (parsed.entries.length > 0) pages.push(raw(body));
      cursor = parsed.nextCursor;
      if (cursor === null) break;
    }
    return pages;
  }

  /** The failure's status, and where the format was wrong if that was it. */
  const failed = (error: unknown) => {
    // Not a failure of the source: the caller stops.
    if (error instanceof ClogCancelledError) throw error;
    return {
      status: failureOf(error),
      ...(error instanceof RuneProfileFormatError ? { formatProblem: error.problem } : {}),
    };
  };

  return {
    source: 'RUNEPROFILE',
    async fetch({
      name,
      guardSince,
      knownHash,
      feedDue,
      feedFrom,
      cancelled,
    }): Promise<ClogFetchResult> {
      const base = `${API}/${encodeURIComponent(name)}`;
      const check = () => {
        if (cancelled?.()) throw new ClogCancelledError('The sync was cancelled');
      };
      let guardPassed = false;
      let collectionLog: RawBody;
      try {
        if (guardSince !== null) {
          check();
          const summary = await client.getJson('RUNEPROFILE', base);
          if (parseSummaryUpdatedAt(summary) < guardSince) {
            return { ok: false, status: 'PROFILE_FROM_BEFORE_NAME', guardPassed };
          }
          guardPassed = true;
        }
        check();
        const body = await client.getText('RUNEPROFILE', `${base}/collection-log`);
        parseCollectionLog(body.json);
        collectionLog = raw(body);
      } catch (error) {
        return { ok: false, ...failed(error), guardPassed };
      }

      const changed = collectionLog.contentHash !== knownHash;
      if (!changed && !feedDue) {
        return { ok: true, collectionLog: null, feedPages: [], feedRead: true, feedFailure: null };
      }
      const stored = changed ? collectionLog : null;
      try {
        const feedPages = await readFeed(base, feedFrom, check);
        return { ok: true, collectionLog: stored, feedPages, feedRead: true, feedFailure: null };
      } catch (error) {
        // The collection log is good: keep it, and read the feed at the next sync.
        const { status, formatProblem: problem } = failed(error);
        return {
          ok: true,
          collectionLog: stored,
          feedPages: [],
          feedRead: false,
          feedFailure: status,
          ...(problem ? { formatProblem: problem } : {}),
        };
      }
    },
  };
}
