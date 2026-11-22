import { BRANDING } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import { externalUserAgent } from './user-agent.js';
import { SERVER_VERSION } from './version.js';

describe('externalUserAgent', () => {
  it('is name/version (+contact)', () => {
    expect(externalUserAgent('you@example.com', '1.2.3')).toBe(
      `${BRANDING.displayName}/1.2.3 (+you@example.com)`,
    );
  });

  it('uses the server version by default', () => {
    expect(externalUserAgent('https://example.com')).toBe(
      `${BRANDING.displayName}/${SERVER_VERSION} (+https://example.com)`,
    );
  });
});
