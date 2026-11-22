import {
  ingestResponseSchema,
  MAX_INGEST_BYTES,
  MAX_INGEST_EVENTS,
  type Event,
  type IngestResponse,
} from '@fireside/shared';
import type { Delivery } from './generator/generate.js';

// Sends seed deliveries through `POST /api/v1/ingest`, like the plugin:
// batches within the limits, retries 429 (Retry-After) and 5xx with backoff.

/** One `POST /api/v1/ingest`. */
export interface SeedRequest {
  /** When the first delivery in the request was due: the timeout job runs at this time first. */
  firstSendAt: Date;
  /** When the request is sent: the server clock for ingest. */
  sendAt: Date;
  events: Event[];
}

export interface IngestReply {
  status: number;
  /** Parsed JSON body, if any. */
  body: unknown;
  /** `Retry-After` in seconds, if the server sent one. */
  retryAfterSeconds?: number;
}

/** Sends one batch. Throws on network errors (retried like a 5xx). */
export type Transport = (events: readonly Event[]) => Promise<IngestReply>;

export interface SendOptions {
  transport: Transport;
  /** Called before each request, e.g. to move the simulated clock and run the timeout job. */
  beforeRequest?: (request: SeedRequest) => void;
  /** Smallest time between requests (rate limit pacing). 0 = no pacing. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Tries per request before giving up. */
  maxAttempts?: number;
  onProgress?: (sent: number, total: number) => void;
}

export interface RejectedEvent {
  eventId: string | null;
  type: string;
  error: string;
}

export interface SendResult {
  requests: number;
  retries: number;
  accepted: number;
  duplicates: number;
  rejected: RejectedEvent[];
}

/** Thrown when sending can't continue. The message is safe to show. */
export class SeedSendError extends Error {
  override name = 'SeedSendError';
}

/** Room for `{"events":[` … `]}` around the events. */
const ENVELOPE_BYTES = 16;
const DEFAULT_MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 30_000;

const sleepFor = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Groups deliveries into requests of at most `MAX_INGEST_EVENTS` events and
 * under `MAX_INGEST_BYTES`. Consecutive live deliveries are merged; the
 * offline backlog is never merged with live events, so it arrives on its own.
 */
export function planRequests(
  deliveries: readonly Delivery[],
  limits = { maxEvents: MAX_INGEST_EVENTS, maxBytes: MAX_INGEST_BYTES },
): SeedRequest[] {
  const requests: SeedRequest[] = [];
  let current: (SeedRequest & { bytes: number; live: boolean }) | undefined;

  for (const delivery of deliveries) {
    for (const event of delivery.events) {
      const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (bytes + ENVELOPE_BYTES > limits.maxBytes) {
        throw new SeedSendError(`Event ${event.eventId} alone is over the batch size limit`);
      }
      // Live events merge freely; the backlog only with the same backlog.
      const joins =
        current?.live === delivery.live &&
        (delivery.live || current.sendAt.getTime() === delivery.sendAt.getTime()) &&
        current.events.length < limits.maxEvents &&
        current.bytes + bytes + ENVELOPE_BYTES <= limits.maxBytes;
      if (current && joins) {
        current.events.push(event);
        current.bytes += bytes;
        current.sendAt = delivery.sendAt;
      } else {
        current = {
          firstSendAt: delivery.sendAt,
          sendAt: delivery.sendAt,
          events: [event],
          bytes,
          live: delivery.live,
        };
        requests.push(current);
      }
    }
  }
  return requests.map(({ firstSendAt, sendAt, events }) => ({ firstSendAt, sendAt, events }));
}

/** Sends all requests in order. Stops with `SeedSendError` on an unrecoverable reply. */
export async function sendRequests(
  requests: readonly SeedRequest[],
  {
    transport,
    beforeRequest,
    minIntervalMs = 0,
    sleep = sleepFor,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    onProgress,
  }: SendOptions,
): Promise<SendResult> {
  const result: SendResult = { requests: 0, retries: 0, accepted: 0, duplicates: 0, rejected: [] };
  const total = requests.reduce((sum, request) => sum + request.events.length, 0);
  let sent = 0;
  let lastRequestAt = -Infinity;

  const pace = async () => {
    const wait = lastRequestAt + minIntervalMs - performance.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = performance.now();
  };

  for (const [index, request] of requests.entries()) {
    beforeRequest?.(request);
    const response = await sendWithRetry(request.events, {
      transport,
      pace,
      sleep,
      maxAttempts,
      onRetry: () => {
        result.retries += 1;
      },
    });
    result.requests += 1;

    // Same IDs as an earlier run: the target already has this seed.
    if (index === 0 && response.duplicates.length > 0) {
      throw new SeedSendError(
        `The server already has ${String(response.duplicates.length)} of the first ` +
          `${String(request.events.length)} events. Seed into an empty database.`,
      );
    }
    result.accepted += response.accepted.length;
    result.duplicates += response.duplicates.length;
    for (const rejected of response.rejected) {
      result.rejected.push({
        eventId: rejected.eventId,
        type: request.events[rejected.index]?.type ?? 'unknown',
        error: rejected.error,
      });
    }
    sent += request.events.length;
    onProgress?.(sent, total);
  }
  return result;
}

interface RetryOptions {
  transport: Transport;
  pace: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  maxAttempts: number;
  onRetry: () => void;
}

async function sendWithRetry(
  events: readonly Event[],
  { transport, pace, sleep, maxAttempts, onRetry }: RetryOptions,
): Promise<IngestResponse> {
  let problem = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) onRetry();
    await pace();
    let reply: IngestReply;
    try {
      reply = await transport(events);
    } catch (error) {
      problem = `network error: ${error instanceof Error ? error.message : String(error)}`;
      await sleep(backoffMs(attempt));
      continue;
    }

    if (reply.status === 200) {
      const parsed = ingestResponseSchema.safeParse(reply.body);
      if (!parsed.success) throw new SeedSendError('The server sent an unexpected ingest response');
      return parsed.data;
    }
    if (reply.status === 429) {
      problem = 'rate limited (429)';
      await sleep(
        reply.retryAfterSeconds === undefined ? backoffMs(attempt) : reply.retryAfterSeconds * 1000,
      );
      continue;
    }
    if (reply.status >= 500) {
      problem = `server error (${String(reply.status)})`;
      await sleep(backoffMs(attempt));
      continue;
    }
    throw new SeedSendError(
      `Ingest failed with ${String(reply.status)}: ${errorMessage(reply.body)}`,
    );
  }
  throw new SeedSendError(`Ingest failed after ${String(maxAttempts)} attempts: ${problem}`);
}

function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
}

function errorMessage(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = body.error;
    if (typeof error === 'object' && error !== null && 'message' in error) {
      return String(error.message);
    }
  }
  return 'no error message';
}

/** `Retry-After` as seconds, or undefined if missing or not a number of seconds. */
export function parseRetryAfter(value: string | string[] | number | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
