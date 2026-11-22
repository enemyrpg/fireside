import { describe, expect, it } from 'vitest';
import { eventFactory, expectOrderIndependent, sessionIdOf, TEST_ACCOUNT_HASH } from './testing.js';
import { FIRST_USER_ID } from '../users/users.js';

type Row = Record<string, unknown>;

/** The `pb_records` rows, checked to be the same in any order and after a rebuild. */
function pbRecords(...events: Parameters<typeof expectOrderIndependent>[0]): Row[] {
  return expectOrderIndependent(events)['pb-records'] as Row[];
}

describe('pb records projection', () => {
  it('stores pb-records.json, one row per record, boss normalized', () => {
    const f = eventFactory();
    const event = f.fromFixture('pb-records.json', '19:00');
    const common = {
      userId: FIRST_USER_ID,
      accountHash: TEST_ACCOUNT_HASH,
      eventId: event.eventId,
      sessionId: sessionIdOf(1),
      observedAt: '2026-11-08T19:00:00.000Z',
      boss: 'The Fractured Archive',
    };
    expect(pbRecords(event)).toEqual([
      { ...common, scope: 'Archive Guardian', teamSize: 3, seconds: 105 },
      { ...common, scope: 'Ocellus', teamSize: 3, seconds: 174.6 },
      { ...common, scope: 'overall', teamSize: 1, seconds: 1905.2 },
      { ...common, scope: 'overall', teamSize: 3, seconds: 1088.4 },
    ]);
  });

  it('keeps every event’s records (the read side takes the lowest)', () => {
    const f = eventFactory();
    const rows = pbRecords(
      f.pbRecords('19:00', { records: [{ scope: 'overall', teamSize: 3, seconds: 1100 }] }),
      f.pbRecords('20:00', { records: [{ scope: 'overall', teamSize: 3, seconds: 1088.4 }] }),
    );
    expect(rows.map((row) => row.seconds)).toEqual([1100, 1088.4]);
  });

  it('gives no KC observation', () => {
    const f = eventFactory();
    expect(expectOrderIndependent([f.pbRecords('19:00')]).kc).toEqual([]);
  });
});
