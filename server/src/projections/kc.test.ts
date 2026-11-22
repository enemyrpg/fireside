import { describe, expect, it } from 'vitest';
import { eventFactory, expectOrderIndependent, TEST_ACCOUNT_HASH } from './testing.js';
import { FIRST_USER_ID } from '../users/users.js';

const SESSION = '01933c40-8a2b-7c3d-9e4f-000000000001';

function at(time: string): string {
  return `2026-11-08T${time}:00.000Z`;
}

describe('kc projection', () => {
  it('stores kc.json', () => {
    const f = eventFactory();
    const event = f.fromFixture('kc.json', '19:00');
    expect(expectOrderIndependent([event]).kc).toEqual([
      {
        userId: FIRST_USER_ID,
        accountHash: TEST_ACCOUNT_HASH,
        eventId: event.eventId,
        sessionId: SESSION,
        observedAt: at('19:00'),
        boss: 'Vorkath',
        killCount: 412,
        timeSeconds: 74.4,
        personalBest: false,
        personalBestSeconds: 63,
        teamSize: null,
      },
    ]);
  });

  it('stores an unknown boss by name, without optional fields (kc-minimal.json)', () => {
    const f = eventFactory();
    expect(expectOrderIndependent([f.fromFixture('kc-minimal.json', '19:00')]).kc).toEqual([
      expect.objectContaining({
        boss: 'Some New Boss',
        killCount: 1,
        timeSeconds: null,
        personalBest: false,
        personalBestSeconds: null,
      }),
    ]);
  });

  it('stores teamSize for a raid mode (kc-raid.json)', () => {
    const f = eventFactory();
    expect(expectOrderIndependent([f.fromFixture('kc-raid.json', '19:00')]).kc).toEqual([
      expect.objectContaining({
        boss: 'Tombs of Amascut: Expert Mode',
        killCount: 140,
        timeSeconds: 1520.4,
        teamSize: 3,
      }),
    ]);
  });

  it('stores personalBestSeconds for a raid mode (kc-raid-personal-best.json)', () => {
    const f = eventFactory();
    const event = f.fromFixture('kc-raid-personal-best.json', '19:00');
    expect(expectOrderIndependent([event]).kc).toEqual([
      expect.objectContaining({ timeSeconds: 1520.4, personalBestSeconds: 1388.4, teamSize: 3 }),
    ]);
  });

  it('normalizes boss aliases, case and whitespace', () => {
    const f = eventFactory();
    const kc = expectOrderIndependent([
      f.fromFixture('kc.json', '19:00', { payload: { boss: '  kril   tsutsaroth ' } }),
      f.fromFixture('kc.json', '19:01', { payload: { boss: 'Barrows' } }),
      f.fromFixture('kc.json', '19:02', { payload: { boss: 'Jad', personalBest: true } }),
    ]).kc as { boss: string; personalBest: boolean }[];
    expect(kc.map((row) => row.boss)).toEqual(["K'ril Tsutsaroth", 'Barrows Chests', 'TzTok-Jad']);
    expect(kc[2]?.personalBest).toBe(true);
  });
});
