import { describe, expect, it } from 'vitest';
import type { InviteRow } from '../db/schema.js';
import {
  generateInviteId,
  inviteStatus,
  inviteUrl,
  isWellFormedInviteToken,
  normalizeLabel,
} from './invites.js';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const row: InviteRow = {
  id: 'K7Q2M4XP',
  type: 'invite',
  tokenHash: 'ab'.repeat(32),
  label: null,
  createdBy: 1,
  createdAt: '2026-11-18T10:00:00.000Z',
  expiresAt: '2026-11-25T10:00:00.000Z',
  role: 'member',
  canCreateApiKeys: true,
  targetUserId: null,
  usedAt: null,
  usedBy: null,
  revokedAt: null,
  revokedBy: null,
};

describe('invite helpers', () => {
  it('makes 8-character Crockford IDs', () => {
    for (let i = 0; i < 200; i += 1) expect(generateInviteId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it('works out the status: revoked, then used, then expired, else active', () => {
    expect(inviteStatus(row, NOW)).toBe('active');
    expect(inviteStatus({ ...row, expiresAt: NOW.toISOString() }, NOW)).toBe('expired');
    expect(
      inviteStatus(
        { ...row, usedAt: NOW.toISOString(), expiresAt: '2026-01-01T00:00:00.000Z' },
        NOW,
      ),
    ).toBe('used');
    expect(
      inviteStatus({ ...row, usedAt: NOW.toISOString(), revokedAt: NOW.toISOString() }, NOW),
    ).toBe('revoked');
  });

  it('puts the token in the fragment, on the page for its type', () => {
    expect(inviteUrl('https://app.example.com', 'invite', 'T')).toBe(
      'https://app.example.com/invite#T',
    );
    expect(inviteUrl('http://localhost:3100', 'password_reset', 'T')).toBe(
      'http://localhost:3100/reset-password#T',
    );
  });

  it('accepts only real tokens', () => {
    expect(isWellFormedInviteToken('A'.repeat(43))).toBe(true);
    for (const token of [
      '',
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)}/`,
    ]) {
      expect(isWellFormedInviteToken(token)).toBe(false);
    }
  });

  it('trims labels, treats empty as none, and refuses long or invisible ones', () => {
    expect(normalizeLabel(undefined)).toBeNull();
    expect(normalizeLabel('   ')).toBeNull();
    expect(normalizeLabel('  for Ola ')).toBe('for Ola');
    expect(() => normalizeLabel('x'.repeat(101))).toThrow(/at most 100/);
    expect(() => normalizeLabel('a​b')).toThrow(/invisible/);
    expect(() => normalizeLabel('a\nb')).toThrow(/control/);
  });
});
