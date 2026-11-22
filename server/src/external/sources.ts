import type { ExternalSourceId } from '@fireside/shared';
import type { Config } from '../config.js';

// Every external service the server may call (see
// docs/architecture.md#external-sources). All of them are optional and off by
// default. A new source is added here, with its own `.env` flag, and called
// through external/client.ts.

export interface ExternalSource {
  id: ExternalSourceId;
  /** Shown under Settings → Server. */
  name: string;
  /** The `.env` variable that turns the source on. */
  envName: string;
  /** Whether that variable is on. */
  enabled(config: Config): boolean;
  /** The only origin requests may go to. Always https. */
  origin: string;
  /** Time limit for one attempt. */
  timeoutMs: number;
  /** Shortest time between two requests to this source, retries included. */
  minIntervalMs: number;
  /** Largest response body that is read. */
  maxBytes: number;
  /**
   * Extra request headers, e.g. an API key. Sent on every request to the
   * source and never logged.
   */
  headers?(config: Config): Record<string, string>;
  /**
   * The request path as it may be logged, when the real one holds personal
   * data. Default: the path as is.
   */
  logPath?(pathname: string): string;
}

export const EXTERNAL_SOURCES: Record<ExternalSourceId, ExternalSource> = {
  WIKI_PRICES: {
    id: 'WIKI_PRICES',
    name: 'OSRS Wiki Prices',
    envName: 'PRICES_ENABLED',
    enabled: (config) => config.prices.enabled,
    origin: 'https://prices.runescape.wiki',
    timeoutMs: 15_000,
    minIntervalMs: 10_000,
    maxBytes: 5 * 1024 * 1024,
  },
  RUNEPROFILE: {
    id: 'RUNEPROFILE',
    name: 'RuneProfile',
    envName: 'RUNEPROFILE_ENABLED',
    enabled: (config) => config.runeprofile.enabled,
    origin: 'https://api.runeprofile.com',
    timeoutMs: 15_000,
    // At most 20 requests a minute: under RuneProfile's limit without a key
    // (30 a minute), also when a key is set.
    minIntervalMs: 3_000,
    maxBytes: 5 * 1024 * 1024,
    headers: (config) =>
      config.runeprofile.apiKey === null ? {} : { 'X-API-Key': config.runeprofile.apiKey },
    // The path holds the OSRS display name (`/v1/accounts/<name>/…`), which never goes to the logs.
    logPath: (pathname) => pathname.replace(/^\/v1\/accounts\/[^/]+/, '/v1/accounts/<name>'),
  },
};

/**
 * A source is used only when its own flag is on **and** `USER_AGENT_CONTACT`
 * is set: without a contact no external call is ever made.
 */
export function isSourceActive(config: Config, id: ExternalSourceId): boolean {
  return EXTERNAL_SOURCES[id].enabled(config) && config.userAgentContact !== null;
}
