import { BRANDING } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import { startupBanner } from './banner.js';
import { SERVER_VERSION } from './version.js';

describe('startupBanner', () => {
  it('shows the display name from the branding constant and the version', () => {
    expect(startupBanner()).toBe(`${BRANDING.displayName} server ${SERVER_VERSION}`);
  });
});
