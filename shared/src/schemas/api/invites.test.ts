import { describe, expect, it } from 'vitest';
import { schemaAsserts, without } from '../../test-utils.js';
import {
  acceptInviteRequestSchema,
  createdInviteResponseSchema,
  createInviteRequestSchema,
  inviteLookupResponseSchema,
  inviteParamsSchema,
  inviteSchema,
} from './invites.js';

const invite = {
  id: 'K7Q2M4XP',
  type: 'invite',
  label: 'For a friend',
  role: 'member',
  canCreateApiKeys: true,
  createdBy: { id: 1, username: 'admin' },
  createdAt: '2026-11-18T10:00:00.000Z',
  expiresAt: '2026-11-25T10:00:00.000Z',
  status: 'active',
  usedAt: null,
  usedBy: null,
  revokedAt: null,
};
const reset = {
  id: 'AH5F2C3X',
  type: 'password_reset',
  targetUser: { id: 2, username: 'ola' },
  createdBy: { id: 1, username: 'admin' },
  createdAt: '2026-11-18T08:00:00.000Z',
  expiresAt: '2026-11-19T08:00:00.000Z',
  status: 'active',
  usedAt: null,
  revokedAt: null,
};
const token = 'Q2xhdWRlIG1hZGUgdGhpcyBmaXh0dXJlIHRva2VuIQ';

describe('invite (list row)', () => {
  const row = schemaAsserts(inviteSchema);

  it('accepts invites and reset links in every status', () => {
    for (const status of ['active', 'used', 'expired', 'revoked']) {
      row.accepts({ ...invite, status });
      row.accepts({ ...reset, status });
    }
    row.accepts({ ...invite, createdBy: null, label: null, usedBy: { id: 3, username: 'kari' } });
  });

  it('never accepts the token, its hash or the link', () => {
    row.rejects({ ...invite, token });
    row.rejects({ ...invite, tokenHash: 'ab'.repeat(32) });
    row.rejects({ ...invite, url: `https://app.example.com/invite#${token}` });
    row.rejects({ ...reset, token });
  });

  it('keeps invite-only and reset-only fields apart', () => {
    row.rejects({ ...reset, role: 'member' });
    row.rejects({ ...invite, targetUser: { id: 2, username: 'ola' } });
    row.rejects(without(reset, 'targetUser'));
    row.rejects(without(invite, 'role'));
  });

  it.each(['k7q2m4xp', 'K7Q2-M4XP', 'K7Q2M4X', 'K7Q2M4XPU', 'IIIIIIII'])('rejects ID %j', (id) => {
    row.rejects({ ...invite, id });
    expect(inviteParamsSchema.safeParse({ id }).success).toBe(false);
  });
});

describe('POST /invites request', () => {
  const request = schemaAsserts(createInviteRequestSchema);

  it('accepts 1, 7 and 30 days, or none (7)', () => {
    for (const days of [1, 7, 30])
      request.accepts({ role: 'member', canCreateApiKeys: true, days });
    request.accepts({ role: 'admin', canCreateApiKeys: false });
  });

  it('never accepts an invite without expiry or another duration', () => {
    for (const days of [null, 0, 2, 14, 365]) {
      request.rejects({ role: 'member', canCreateApiKeys: true, days });
    }
  });
});

describe('POST /invites response', () => {
  it('requires the link and whether it only works locally', () => {
    const response = schemaAsserts(createdInviteResponseSchema);
    const url = `https://app.example.com/invite#${token}`;
    response.accepts({ invite, url, localOnly: false });
    response.rejects({ invite, url });
    response.rejects({ invite, localOnly: true });
  });
});

describe('invite lookup and accept', () => {
  it('tells only the type, and the username for a reset link', () => {
    const lookup = schemaAsserts(inviteLookupResponseSchema);
    lookup.accepts({ type: 'invite' });
    lookup.accepts({ type: 'password_reset', username: 'ola', twoFactorRequired: false });
    lookup.accepts({ type: 'password_reset', username: 'ola', twoFactorRequired: true });
    lookup.rejects({ type: 'password_reset', username: 'ola' });
    lookup.rejects({ type: 'invite', role: 'admin' });
    lookup.rejects({ type: 'invite', expiresAt: '2026-11-25T10:00:00.000Z' });
  });

  it('never lets the accepting user pick a role or key permission', () => {
    const accept = schemaAsserts(acceptInviteRequestSchema);
    accept.accepts({ token, username: 'ola', password: 'correct horse battery' });
    accept.rejects({ token, username: 'ola', password: 'x', role: 'admin' });
    accept.rejects({ token, username: 'ola', password: 'x', canCreateApiKeys: true });
    accept.rejects({ token: 'x'.repeat(257), username: 'ola', password: 'x' });
  });
});
