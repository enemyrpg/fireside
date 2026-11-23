import type { SessionDetailResponse } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import detailFixture from '../../../shared/fixtures/api/session-detail-response/valid/session.json';
import {
  isSessionLive,
  MIN_RATE_SECONDS,
  perHour,
  sessionNumbers,
  shouldPollSession,
} from './session-stats';

const DETAIL = detailFixture as SessionDetailResponse;

describe('perHour', () => {
  it('gives a rate per hour from 5 minutes on', () => {
    expect(perHour(1000, 1800)).toBe(2000);
    expect(perHour(1000, MIN_RATE_SECONDS)).toBe(12_000);
    expect(perHour(1000, MIN_RATE_SECONDS - 1)).toBeNull();
    expect(perHour(1000, 0)).toBeNull();
  });
});

describe('sessionNumbers', () => {
  const detail: SessionDetailResponse = {
    ...DETAIL,
    session: { ...DETAIL.session, durationSeconds: 7200, activeSeconds: 3600, afkSeconds: 3600 },
    xp: [
      { skill: 'SLAYER', xpGained: 100_000, startLevel: 89, endLevel: 90 },
      { skill: 'HITPOINTS', xpGained: 20_000, startLevel: 90, endLevel: 90 },
      { skill: 'NEWSKILL', xpGained: 5_000, startLevel: 1, endLevel: 5 },
    ],
    kc: [
      { boss: 'Vorkath', startKillCount: 394, endKillCount: 412, gained: 18 },
      { boss: 'Zulrah', startKillCount: 10, endKillCount: 10, gained: 0 },
    ],
  };

  it('counts known skills only, and uses active time for XP/h and the whole session for gp/h', () => {
    const loot = DETAIL.loot.reduce((total, drop) => total + drop.geValue, 0);
    expect(sessionNumbers(detail)).toEqual({
      xpTotal: 120_000,
      skillCount: 2,
      xpPerHour: 120_000,
      lootGeValue: loot,
      dropCount: DETAIL.loot.length,
      gpPerHour: loot / 2,
      kills: 18,
      bosses: ['Vorkath'],
      newCollectionLog: 0,
    });
  });

  it('counts the new collection log items', () => {
    const item = {
      itemId: 22111,
      name: 'Dragonbone necklace',
      tab: 'Bosses',
      page: 'Vorkath',
      pageObtained: 4,
      pageTotal: 7,
      at: '2026-11-08T19:42:13.512Z',
      approximate: false,
    };
    expect(
      sessionNumbers({
        ...detail,
        collectionLog: { obtained: 341, total: 1734, items: [item, { ...item, itemId: 1 }] },
      }).newCollectionLog,
    ).toBe(2);
  });

  it('has no rates for a very short session', () => {
    const short = {
      ...detail,
      session: { ...detail.session, durationSeconds: 60, activeSeconds: 60, afkSeconds: 0 },
    };
    expect(sessionNumbers(short)).toMatchObject({ xpPerHour: null, gpPerHour: null });
  });
});

describe('isSessionLive', () => {
  const ended = Date.parse('2026-11-08T20:00:00.000Z');
  const end = (endReason: 'logout' | 'hop' | 'timeout') => ({
    endedAt: '2026-11-08T20:00:00.000Z',
    endReason,
  });

  it('is live while open', () => {
    expect(isSessionLive({ endedAt: null, endReason: null }, ended)).toBe(true);
  });

  it('is not live after a logout or a timeout', () => {
    expect(isSessionLive(end('logout'), ended + 1000)).toBe(false);
    expect(isSessionLive(end('timeout'), ended + 1000)).toBe(false);
  });

  it('is live under 2 minutes after a hop', () => {
    expect(isSessionLive(end('hop'), ended + 60_000)).toBe(true);
    expect(isSessionLive(end('hop'), ended + 120_000)).toBe(false);
    expect(isSessionLive(end('hop'), ended + 180_000)).toBe(false);
  });
});

describe('shouldPollSession', () => {
  const ended = Date.parse('2026-11-08T20:00:00.000Z');
  const hop: SessionDetailResponse = {
    ...DETAIL,
    session: { ...DETAIL.session, endReason: 'hop' },
    neighbors: { olderId: null, newerId: null },
  };

  it('polls an open session', () => {
    const open = { ...DETAIL, session: { ...DETAIL.session, endedAt: null, endReason: null } };
    expect(shouldPollSession(open, ended)).toBe(true);
  });

  it('polls under 2 minutes after a hop until the next part shows up', () => {
    expect(shouldPollSession(hop, ended + 60_000)).toBe(true);
    expect(shouldPollSession(hop, ended + 120_000)).toBe(false);
    const found = { ...hop, neighbors: { olderId: null, newerId: DETAIL.session.id } };
    expect(shouldPollSession(found, ended + 60_000)).toBe(false);
  });

  it('does not poll a session that ended otherwise, or without data', () => {
    expect(shouldPollSession(DETAIL, ended + 1_000)).toBe(false);
    expect(shouldPollSession(undefined, ended)).toBe(false);
  });
});
