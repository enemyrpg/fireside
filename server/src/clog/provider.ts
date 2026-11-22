import type { ClogSource, ClogSyncStatus } from '@fireside/shared';

// The collection log layer (see docs/architecture.md#external-sources). A
// provider fetches an account's collection log from one source. The only one so
// far is RuneProfile (clog/runeprofile.ts). A `PluginClogProvider` (our own
// plugin reading the collection log) fits the same normalised shape: tabs,
// pages and items with a quantity.

export interface ClogItemEntry {
  itemId: number;
  name: string;
  /** 0 for an item the account has not obtained. */
  quantity: number;
}

export interface ClogPageEntry {
  name: string;
  items: ClogItemEntry[];
}

export interface ClogTabEntry {
  name: string;
  pages: ClogPageEntry[];
}

/** One "new collection log item" entry of a source's activity feed. */
export interface ClogFeedEntry {
  itemId: number;
  /** UTC ISO 8601 with milliseconds. */
  obtainedAt: string;
}

/** What is stored unchanged in `external_snapshots`. */
export const SNAPSHOT_KINDS = ['COLLECTION_LOG', 'ACTIVITIES'] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

/** A response body as received, with its `sha256:` hash. */
export interface RawBody {
  body: string;
  contentHash: string;
}

/** Why a sync did not work. Always from a status code or our own checks, never response text. */
export type ClogFailure = Exclude<ClogSyncStatus, 'OK' | 'NEVER_SYNCED' | 'SYNCING'>;

/** The endpoints of a source, as named in logs. */
export type ClogEndpoint = SnapshotKind | 'SUMMARY';

/**
 * Where a response did not match the expected format: the endpoint and, per
 * problem, its path and code (`tabs.0.pages.3.items.12.id: invalid_type`).
 * Safe to log: never a value, a name or any other text from the response.
 */
export interface ClogFormatProblem {
  endpoint: ClogEndpoint;
  issues: string[];
}

export interface ClogFetchRequest {
  /** The account's current display name, from our own name history. */
  name: string;
  /**
   * Set when the name guard must run: the start (UTC ISO) of the account's
   * current name period. A profile last updated before it is refused.
   */
  guardSince: string | null;
  /** Hash of the account's latest stored collection log, to see whether it changed. */
  knownHash: string | null;
  /** Read the activity feed even if the collection log is unchanged. */
  feedDue: boolean;
  /** Read the feed from this time (UTC ISO). `null` reads its history. */
  feedFrom: string | null;
  /** Checked before every request: once `true`, no further request is made. */
  cancelled?: () => boolean;
}

export type ClogFetchResult =
  | {
      ok: true;
      /** The collection log, or `null` when it is the same as `knownHash`. */
      collectionLog: RawBody | null;
      /** Activity feed pages, newest first. Empty when the feed was not read. */
      feedPages: RawBody[];
      /** The feed was read without errors (or did not need reading). */
      feedRead: boolean;
      /** Set when the feed could not be read. The collection log is still good. */
      feedFailure: ClogFailure | null;
      /** Set with `feedFailure: INVALID_RESPONSE`. */
      formatProblem?: ClogFormatProblem;
    }
  | {
      ok: false;
      status: ClogFailure;
      /** The name guard ran and passed before the failure. */
      guardPassed: boolean;
      /** Set with `INVALID_RESPONSE` when the body was JSON of another shape. */
      formatProblem?: ClogFormatProblem;
    };

export interface ClogProvider {
  readonly source: ClogSource;
  /** Never throws for a failed request: the failure is the result. */
  fetch(request: ClogFetchRequest): Promise<ClogFetchResult>;
}
