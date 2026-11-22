import { describe, expect, it } from 'vitest';
import { schemaAsserts } from '../../test-utils.js';
import {
  raidDropCreateRequestSchema,
  raidDropIdSchema,
  raidDropShare,
  raidDropUpdateRequestSchema,
  raidSplitsQuerySchema,
} from './raid-splits.js';

describe('raidDropShare', () => {
  const own = { recipient: 'SELF', mode: 'SPLIT', value: 900_000_000, partySize: 3 } as const;
  const teammate = { ...own, recipient: 'TEAMMATE' } as const;

  it('splits own and teammates’ drops by the party size', () => {
    expect(raidDropShare(own)).toBe(300_000_000);
    expect(raidDropShare(teammate)).toBe(300_000_000);
    expect(raidDropShare({ ...own, partySize: 1 })).toBe(900_000_000);
  });

  it('rounds a split down to whole gp', () => {
    expect(raidDropShare({ ...own, value: 1_000_000_000 })).toBe(333_333_333);
    expect(raidDropShare({ ...teammate, value: 2, partySize: 3 })).toBe(0);
  });

  it('gives the whole value of an own drop under FFA, whatever the party size', () => {
    expect(raidDropShare({ ...own, mode: 'FFA' })).toBe(900_000_000);
    expect(raidDropShare({ ...own, mode: 'FFA', partySize: null })).toBe(900_000_000);
  });

  it('counts a teammate’s drop 0 under FFA, also without a value', () => {
    expect(raidDropShare({ ...teammate, mode: 'FFA' })).toBe(0);
    expect(raidDropShare({ ...teammate, mode: 'FFA', value: null, partySize: null })).toBe(0);
  });

  it('can’t split without a party size', () => {
    expect(raidDropShare({ ...own, partySize: null })).toBeNull();
    expect(raidDropShare({ ...teammate, partySize: null })).toBeNull();
  });

  it('has no share without a value', () => {
    expect(raidDropShare({ ...teammate, value: null })).toBeNull();
    expect(raidDropShare({ ...own, mode: 'FFA', value: null })).toBeNull();
  });

  it('takes 0 gp as a value', () => {
    expect(raidDropShare({ ...own, value: 0 })).toBe(0);
  });
});

describe('raid split schemas', () => {
  it('accepts event, chest and manual drop IDs only', () => {
    const id = schemaAsserts(raidDropIdSchema);
    id.accepts('01933c4e-8a2b-7c3d-9e4f-000000000003');
    id.accepts('01933c4e-8a2b-7c3d-9e4f-000000000003.0');
    id.accepts('01933c4e-8a2b-7c3d-9e4f-000000000003.12');
    for (const bad of [
      '',
      '7',
      '01933C4E-8A2B-7C3D-9E4F-000000000003',
      '01933c4e-8a2b-4c3d-9e4f-000000000003',
      '01933c4e-8a2b-7c3d-9e4f-000000000003.',
      '01933c4e-8a2b-7c3d-9e4f-000000000003.01',
      '01933c4e-8a2b-7c3d-9e4f-000000000003.-1',
    ]) {
      expect(id.issuePaths(bad), bad).toEqual(['']);
    }
  });

  it('pages like the special loot list', () => {
    const query = schemaAsserts(raidSplitsQuerySchema);
    expect(query.accepts({})).toEqual({ limit: 50 });
    expect(query.issuePaths({ from: '2026-11-01T00:00:00.000Z' })).toEqual(['']);
  });

  it('tells an absent field from a cleared one', () => {
    const update = schemaAsserts(raidDropUpdateRequestSchema);
    expect(update.accepts({})).toEqual({});
    expect(update.accepts({ ownValue: null })).toEqual({ ownValue: null });
    expect(update.issuePaths({ ownValue: 1.5 })).toEqual(['ownValue']);
    expect(update.issuePaths({ partySize: 101 })).toEqual(['partySize']);
  });

  it('takes a manual drop for yourself or a teammate, a teammate when left out', () => {
    const create = schemaAsserts(raidDropCreateRequestSchema);
    const body = {
      raid: 'Theatre of Blood',
      itemId: 22486,
      occurredAt: '2019-03-01T20:00:00.000Z',
    };
    // No default in the schema: the server reads a missing recipient as TEAMMATE.
    expect(create.accepts(body)).toEqual(body);
    expect(create.accepts({ ...body, recipient: 'SELF' })).toEqual({ ...body, recipient: 'SELF' });
    expect(create.accepts({ ...body, recipient: 'TEAMMATE' })).toMatchObject({
      recipient: 'TEAMMATE',
    });
    expect(create.issuePaths({ ...body, recipient: 'PLAYER' })).toEqual(['recipient']);
    expect(create.issuePaths({ ...body, recipient: 'Invented Name' })).toEqual(['recipient']);
  });
});
