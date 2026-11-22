import type { Invite } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import invitesFixture from '../../../shared/fixtures/api/invites-response/valid/all-statuses.json';
import keysFixture from '../../../shared/fixtures/api/keys-response/valid/mixed.json';
import { activeInvites, activeKeys, pastInvites, revokedKeys } from './history';

describe('history split', () => {
  it('splits keys into active and revoked, newest revoked first', () => {
    const keys = [
      ...keysFixture.keys,
      { ...keysFixture.keys[0], id: 99, revokedAt: '2026-11-19T10:00:00Z' },
    ];
    expect(activeKeys(keys).every((key) => key.revokedAt === null)).toBe(true);
    const revoked = revokedKeys(keys);
    expect(revoked.every((key) => key.revokedAt !== null)).toBe(true);
    expect(revoked[0]?.id).toBe(99);
    expect(activeKeys(keys).length + revoked.length).toBe(keys.length);
  });

  it('splits invites into active and past', () => {
    const invites = invitesFixture.invites as Invite[];
    expect(activeInvites(invites).map((invite) => invite.status)).toEqual(
      invites.filter((invite) => invite.status === 'active').map(() => 'active'),
    );
    expect(pastInvites(invites).some((invite) => invite.status === 'active')).toBe(false);
    expect(activeInvites(invites).length + pastInvites(invites).length).toBe(invites.length);
  });
});
