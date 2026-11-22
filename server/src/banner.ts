import { BRANDING } from '@fireside/shared';
import { SERVER_VERSION } from './version.js';

/** One-line startup message for the server log. */
export function startupBanner(): string {
  return `${BRANDING.displayName} server ${SERVER_VERSION}`;
}
