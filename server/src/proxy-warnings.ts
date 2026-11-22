import type { Config } from './config.js';
import type { Queryable } from './db/index.js';
import { anyPasswordSet } from './users/users.js';

// Warnings at startup for a half-configured tunnel. They don't stop the server:
// local mode keeps working on this machine, and the log says clearly why the
// tunnel doesn't.

/** What `proxyConfigWarnings` needs from the config. */
export type ProxyWarningConfig = Pick<Config, 'trustedProxy'>;

/** Lines to log as warnings at startup, empty when everything fits together. */
export function proxyConfigWarnings(config: ProxyWarningConfig, db: Queryable): string[] {
  const warnings: string[] = [];
  if (config.trustedProxy !== null && !anyPasswordSet(db)) {
    warnings.push(
      `TRUSTED_PROXY is set, but no user has a password, so the server is in local mode, ` +
        `where the dashboard refuses every request through the tunnel (403). Turn login on first: ` +
        `pnpm cli users set-password <name> (see docs/tunnel.md).`,
    );
  }
  return warnings;
}
