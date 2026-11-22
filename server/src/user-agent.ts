import { BRANDING } from '@fireside/shared';
import { SERVER_VERSION } from './version.js';

// User-Agent for every external call (see
// docs/architecture.md#external-sources): the product, its version and a
// contact for whoever runs this instance, e.g.
// `Fireside/0.1.0 (+you@example.com)`. The contact comes from
// USER_AGENT_CONTACT in `.env`. No external call may be made without one.

export function externalUserAgent(contact: string, version: string = SERVER_VERSION): string {
  return `${BRANDING.displayName}/${version} (+${contact})`;
}
