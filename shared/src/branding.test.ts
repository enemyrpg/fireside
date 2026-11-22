import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRANDING } from './branding.js';

// Exact text, as in docs/legal.md.
const FAN_CONTENT_POLICY_DISCLAIMER =
  "Created using intellectual property belonging to Jagex Limited under the terms of Jagex's " +
  'Fan Content Policy. This content is not endorsed by or affiliated with Jagex.';

describe('BRANDING', () => {
  it('has a non-empty display name', () => {
    expect(BRANDING.displayName.trim()).not.toBe('');
  });

  it('has a kebab-case short name', () => {
    expect(BRANDING.shortName).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('has an API key prefix of lowercase letters ending in an underscore', () => {
    expect(BRANDING.apiKeyPrefix).toMatch(/^[a-z]+_$/);
  });

  it('uses https repository URLs', () => {
    expect(BRANDING.repositoryUrl).toMatch(/^https:\/\//);
    expect(BRANDING.pluginRepositoryUrl).toMatch(/^https:\/\//);
  });

  it('has the Jagex Fan Content Policy disclaimer', () => {
    expect(BRANDING.jagexDisclaimer).toBe(FAN_CONTENT_POLICY_DISCLAIMER);
  });

  it('matches the disclaimer in the README', () => {
    const readme = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8');
    expect(readme.replace(/\s+/g, ' ')).toContain(BRANDING.jagexDisclaimer);
  });
});
