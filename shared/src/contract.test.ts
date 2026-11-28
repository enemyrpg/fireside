import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, EVENT_SCHEMA_VERSION } from './contract.js';

describe('contract version', () => {
  it('is semver', () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is 1.42.1 (current key prefix in every fixture) with event schema version 1', () => {
    expect(CONTRACT_VERSION).toBe('1.42.1');
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });
});
