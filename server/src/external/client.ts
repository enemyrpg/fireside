import type { ExternalSourceId } from '@fireside/shared';
import { systemClock, type Clock } from '../auth/api-keys.js';
import type { Config } from '../config.js';
import type { JobLogger } from '../jobs/session-timeout.js';
import { externalUserAgent } from '../user-agent.js';
import { EXTERNAL_SOURCES, isSourceActive, type ExternalSource } from './sources.js';

// The only place in the server that calls the network
// (ESLint bans `fetch` and the network modules everywhere else; see
// docs/decisions/0014-external-calls-through-one-module.md). Every call:
// - is refused unless the source's `.env` flag is on and USER_AGENT_CONTACT is set;
// - goes to the source's own https origin, and never follows a redirect;
// - sends the User-Agent from `externalUserAgent`;
// - has a timeout, a size limit, retries with backoff and a per-source rate limit;
// - is logged without headers, query strings or bodies.

/** Attempts per call, the first one included. */
export const MAX_ATTEMPTS = 3;
/** Wait before the second and the third attempt (plus up to 25 % jitter). */
export const BACKOFF_MS = [2_000, 8_000] as const;
/** A `Retry-After` longer than this ends the call instead of waiting. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** The source is off (its flag, or no `USER_AGENT_CONTACT`). No request was made. */
export class ExternalDisabledError extends Error {
  override name = 'ExternalDisabledError';
}

/**
 * The call failed. The message is built from the status or an error code
 * only, so it is safe to store and show.
 */
export class ExternalRequestError extends Error {
  override name = 'ExternalRequestError';
  constructor(
    message: string,
    readonly status: number | null = null,
    /** The source answered, but the body could not be used (not JSON, or too large). */
    readonly invalidBody = false,
  ) {
    super(message);
  }
}

export interface ExternalClient {
  /**
   * `GET <source origin><path>` and parse the body as JSON. `path` starts
   * with `/` and may have a query string. Throws `ExternalDisabledError` or
   * `ExternalRequestError`.
   */
  getJson(source: ExternalSourceId, path: string): Promise<unknown>;
  /**
   * As `getJson`, and also the body exactly as it was received, for sources
   * whose responses are stored unchanged.
   */
  getText(source: ExternalSourceId, path: string): Promise<ExternalBody>;
}

export interface ExternalBody {
  /** The response body as received. */
  text: string;
  /** `text` parsed as JSON. */
  json: unknown;
}

export interface ExternalClientOptions {
  config: Config;
  log: JobLogger;
  /** Tests pass a mock. Nothing else may. */
  fetch?: typeof fetch;
  now?: Clock;
  sleep?: (ms: number) => Promise<void>;
  /** 0–1, for the jitter. */
  random?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    // Never keeps the process alive on its own.
    setTimeout(resolve, ms).unref();
  });

interface Failure {
  message: string;
  status: number | null;
  retry: boolean;
  /** From `Retry-After`. */
  retryAfterMs: number | null;
  invalidBody?: boolean;
}

const fail = (
  message: string,
  retry: boolean,
  status: number | null = null,
  retryAfterMs: number | null = null,
): Failure => ({ message, status, retry, retryAfterMs });

/** `Retry-After` as milliseconds from `nowMs`: seconds or an HTTP date. */
export function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/** A Node error code like `ECONNRESET`, from the error or its cause. Never free text. */
function errorCode(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
  }
  return null;
}

class TooLargeError extends Error {}

/** The body as text, or `TooLargeError` once it passes `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new TooLargeError();
  }
  if (!response.body) return '';
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new TooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The full URL, or an error if `path` would leave the source's origin. */
function urlFor(source: ExternalSource, path: string): URL {
  const origin = new URL(source.origin);
  if (origin.protocol !== 'https:' || !path.startsWith('/') || path.startsWith('//')) {
    throw new ExternalRequestError('Refused: the request is not inside the allowed origin');
  }
  const url = new URL(path, origin);
  if (url.origin !== origin.origin) {
    throw new ExternalRequestError('Refused: the request is not inside the allowed origin');
  }
  return url;
}

export function createExternalClient({
  config,
  log,
  // eslint-disable-next-line no-restricted-globals -- the one place the server may reach the network
  fetch: doFetch = fetch,
  now = systemClock,
  sleep = defaultSleep,
  random = Math.random,
}: ExternalClientOptions): ExternalClient {
  /** Calls per source run one at a time, in order. */
  const queues = new Map<ExternalSourceId, Promise<unknown>>();
  const lastRequestAt = new Map<ExternalSourceId, number>();

  async function attempt(
    source: ExternalSource,
    url: URL,
    userAgent: string,
    number: number,
  ): Promise<ExternalBody | Failure> {
    // The rate limit: wait out the rest of the gap since the last request.
    const last = lastRequestAt.get(source.id);
    if (last !== undefined) {
      const wait = last + source.minIntervalMs - now().getTime();
      if (wait > 0) await sleep(wait);
    }
    const startedAt = now().getTime();
    lastRequestAt.set(source.id, startedAt);
    // Never the query string, headers, body or personal data in the path.
    const path = source.logPath ? source.logPath(url.pathname) : url.pathname;
    const logged = { source: source.id, method: 'GET', url: url.origin + path };
    const duration = () => now().getTime() - startedAt;

    let failure: Failure;
    try {
      const response = await doFetch(url.href, {
        method: 'GET',
        // The source's own headers (an API key) first, so they can never
        // replace the User-Agent.
        headers: {
          ...source.headers?.(config),
          'User-Agent': userAgent,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(source.timeoutMs),
      });
      if (response.ok) {
        const text = await readCapped(response, source.maxBytes);
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          failure = {
            ...fail('The response was not valid JSON', false, response.status),
            invalidBody: true,
          };
          log.warn(
            { ...logged, status: response.status, attempt: number, durationMs: duration() },
            'External request failed',
          );
          return failure;
        }
        log.info(
          {
            ...logged,
            status: response.status,
            attempt: number,
            durationMs: duration(),
            bytes: Buffer.byteLength(text),
          },
          'External request done',
        );
        return { text, json };
      }
      await response.body?.cancel();
      const { status } = response;
      const retry = status === 429 || status >= 500;
      const after =
        status === 429 || status === 503
          ? retryAfterMs(response.headers.get('retry-after'), now().getTime())
          : null;
      failure = fail(`HTTP ${String(status)}`, retry, status, after);
    } catch (error) {
      if (error instanceof TooLargeError) {
        failure = {
          ...fail(`The response was larger than ${String(source.maxBytes)} bytes`, false),
          invalidBody: true,
        };
      } else if (error instanceof Error && /^(TimeoutError|AbortError)$/.test(error.name)) {
        failure = fail(`No response within ${String(source.timeoutMs / 1000)} s`, true);
      } else {
        const code = errorCode(error);
        failure = fail(code === null ? 'Network error' : `Network error (${code})`, true);
      }
    }
    log.warn(
      {
        ...logged,
        status: failure.status,
        attempt: number,
        durationMs: duration(),
        reason: failure.message,
      },
      'External request failed',
    );
    return failure;
  }

  async function run(source: ExternalSource, url: URL, userAgent: string): Promise<ExternalBody> {
    for (let number = 1; ; number++) {
      const result = await attempt(source, url, userAgent, number);
      if ('json' in result) return result;
      const backoff = BACKOFF_MS[number - 1];
      const tooLong = result.retryAfterMs !== null && result.retryAfterMs > MAX_RETRY_AFTER_MS;
      if (!result.retry || number >= MAX_ATTEMPTS || backoff === undefined || tooLong) {
        throw new ExternalRequestError(result.message, result.status, result.invalidBody ?? false);
      }
      await sleep(Math.max(Math.round(backoff * (1 + random() * 0.25)), result.retryAfterMs ?? 0));
    }
  }

  const getText: ExternalClient['getText'] = (id, path) => {
    const source = EXTERNAL_SOURCES[id];
    const contact = config.userAgentContact;
    if (!isSourceActive(config, id) || contact === null) {
      return Promise.reject(
        new ExternalDisabledError(
          `${source.name} is off: set ${source.envName}=true and USER_AGENT_CONTACT`,
        ),
      );
    }
    let url: URL;
    try {
      url = urlFor(source, path);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Invalid request'));
    }
    const userAgent = externalUserAgent(contact);
    const previous = queues.get(id) ?? Promise.resolve();
    const result = previous.then(() => run(source, url, userAgent));
    // The queue goes on after a failure.
    queues.set(
      id,
      result.catch(() => undefined),
    );
    return result;
  };

  return {
    getJson: (id, path) => getText(id, path).then((body) => body.json),
    getText,
  };
}
