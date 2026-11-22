import type { Event } from '@fireside/shared';
import { buildApp } from '../app.js';
import { createApiKey, ownKey } from '../auth/api-keys.js';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { failedEvents } from '../projections/index.js';
import { localUserId } from '../users/users.js';
import { closeTimedOutSessions } from '../projections/sessions.js';
import { storeSeedCollectionLogs } from './clog.js';
import type { SeedData } from './generator/generate.js';
import {
  parseRetryAfter,
  planRequests,
  sendRequests,
  type SendResult,
  type Transport,
} from './runner.js';

// Seeds a database through its own app instance (`app.inject`), so
// `pnpm seed` works without a running server. Events take the same path as
// from the plugin: auth, rate limit, validation, storage, projections.

/** Name of the API key the seed creates. */
export const SEED_KEY_NAME = 'seed';

/**
 * The real limit (120/min) would make a full seed take minutes. This app
 * instance is private to the seed, so the limit is raised; 429 handling is
 * still in place and tested.
 */
const IN_PROCESS_RATE_LIMIT = { max: 1_000_000, timeWindowMs: 60_000 };

export interface InProcessResult extends SendResult {
  /** Events whose projection failed (raw data is kept). */
  failed: { eventId: string; type: string; error: string }[];
  /** Collection log responses stored in `external_snapshots` (not sent through ingest). */
  externalSnapshots: number;
}

export interface InProcessOptions {
  onProgress?: (sent: number, total: number) => void;
  /**
   * The user whose new key sends the events. Default: the local user (user 1
   * in a fresh database). Tests seed a second user's accounts with it.
   */
  userId?: number;
}

/**
 * Sends `data` into `database`, which stays open (the caller owns it). The
 * server clock follows the deliveries: the timeout job runs before each
 * request, as it would on a server running all along, and once more at `until`.
 */
export async function seedInProcess(
  database: Database,
  config: Config,
  data: SeedData,
  { onProgress, userId = localUserId(database.db) }: InProcessOptions = {},
): Promise<InProcessResult> {
  const { key } = createApiKey(database.db, ownKey(userId), SEED_KEY_NAME);
  const clock = { now: data.from };
  const app = buildApp({
    config: { ...config, logLevel: 'warn' },
    // The app closes its database on close; this one belongs to the caller.
    db: { ...database, close: () => undefined },
    ingest: { now: () => clock.now, rateLimit: IN_PROCESS_RATE_LIMIT },
  });

  try {
    await app.ready();
    const transport: Transport = async (events: readonly Event[]) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/ingest',
        headers: { authorization: `Bearer ${key}` },
        payload: { events },
      });
      const retryAfterSeconds = parseRetryAfter(response.headers['retry-after']);
      return {
        status: response.statusCode,
        body: response.json(),
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    };

    const result = await sendRequests(planRequests(data.deliveries), {
      transport,
      beforeRequest: (request) => {
        closeTimedOutSessions(database.db, request.firstSendAt);
        clock.now = request.sendAt;
      },
      ...(onProgress ? { onProgress } : {}),
    });
    closeTimedOutSessions(database.db, data.until);
    // Not events: stored as raw external data, after the accounts exist.
    const externalSnapshots = storeSeedCollectionLogs(database.db, data, userId);
    return { ...result, failed: failedEvents(database.db), externalSnapshots };
  } finally {
    await app.close();
  }
}
