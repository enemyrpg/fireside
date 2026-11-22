import { describe, expect, it } from 'vitest';
import { proxyConfigWarnings } from './proxy-warnings.js';
import { testConfig, testDatabase } from './test-utils.js';
import { FIRST_USER_ID, setPasswordHash } from './users/users.js';

// Startup warnings for a half-configured tunnel.

const TUNNEL = { PUBLIC_URL: 'https://app.example.com', TRUSTED_PROXY: 'cloudflare' };

describe('proxyConfigWarnings', () => {
  it('warns when TRUSTED_PROXY is set but no user has a password (local mode)', () => {
    const { db } = testDatabase();
    const warnings = proxyConfigWarnings(testConfig(TUNNEL), db);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/TRUSTED_PROXY is set, but no user has a password/);
    expect(warnings[0]).toMatch(/403/);
    expect(warnings[0]).toMatch(/set-password/);
  });

  it('says nothing in login mode', () => {
    const { db } = testDatabase();
    setPasswordHash(db, FIRST_USER_ID, '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA');
    expect(proxyConfigWarnings(testConfig(TUNNEL), db)).toEqual([]);
  });

  it('says nothing without TRUSTED_PROXY (the default)', () => {
    const { db } = testDatabase();
    expect(proxyConfigWarnings(testConfig(), db)).toEqual([]);
  });
});
