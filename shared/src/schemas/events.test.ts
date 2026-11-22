import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ACCOUNT_TYPES } from '../game/account-types.js';
import { SKILLS } from '../game/skills.js';
import {
  eventSchema,
  EVENT_TYPES,
  isEventType,
  xpSnapshotSkillsSchema,
  type Event,
} from './events.js';

const EVENT_ID = '01933c4e-8a2b-7c3d-9e4f-0a1b2c3d4e5f';
const SESSION_ID = '01933c40-1111-7aaa-bbbb-ccccdddd0001';
const UUID_V4 = '9b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d';

function event(type: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    eventId: EVENT_ID,
    schemaVersion: 1,
    type,
    accountHash: '1234567890123456789',
    occurredAt: '2026-11-08T19:42:13.512Z',
    sessionId: SESSION_ID,
    payload,
    ...overrides,
  };
}

/** Returns the issue paths of a failed parse, joined with dots. */
function issuePaths(input: unknown): string[] {
  const result = eventSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

function accepts(input: unknown): void {
  const result = eventSchema.safeParse(input);
  expect(result.error?.issues).toBeUndefined();
}

function rejects(input: unknown): void {
  expect(eventSchema.safeParse(input).success).toBe(false);
}

/** Copy of `object` without `key`. */
function without(object: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([k]) => k !== key));
}

const coins = [{ itemId: 995, name: 'Coins', quantity: 1500, gePrice: 1, haPrice: 0 }];
const endLogout = { reason: 'logout' };

describe('isEventType', () => {
  it.each(EVENT_TYPES)('accepts %s', (type) => {
    expect(isEventType(type)).toBe(true);
  });

  it.each([['session'], ['LOOT'], [''], [null], [undefined], [1]])('rejects %j', (value) => {
    expect(isEventType(value)).toBe(false);
  });
});

describe('envelope', () => {
  it('lists all event types', () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        'bank.snapshot',
        'diaries.snapshot',
        'kc',
        'loot',
        'pb.records',
        'pet.drop',
        'potion_storage.snapshot',
        'quests.snapshot',
        'raid.special_loot',
        'session.afk',
        'session.end',
        'session.heartbeat',
        'session.start',
        'xp.snapshot',
      ].sort(),
    );
  });

  it('accepts a valid envelope', () => {
    accepts(event('session.end', endLogout));
  });

  it.each([
    ['eventId', UUID_V4],
    ['eventId', 'not-a-uuid'],
    ['sessionId', UUID_V4],
  ])('rejects a non-UUIDv7 %s', (field, value) => {
    expect(issuePaths(event('session.end', endLogout, { [field]: value }))).toContain(field);
  });

  it.each([
    '2026-11-08T19:42:13Z',
    '2026-11-08T19:42:13.5Z',
    '2026-11-08T19:42:13.512345Z',
    '2026-11-08T20:42:13.512+01:00',
    '2026-11-08T19:42:13.512',
    '2026-11-08',
  ])('rejects occurredAt %s (must be UTC with milliseconds)', (occurredAt) => {
    expect(issuePaths(event('session.end', endLogout, { occurredAt }))).toContain('occurredAt');
  });

  it.each([0, 2, '1'])('rejects schemaVersion %j', (schemaVersion) => {
    rejects(event('session.end', endLogout, { schemaVersion }));
  });

  it('rejects an unknown event type', () => {
    rejects(event('bank.sync', {}));
  });

  it('rejects unknown envelope keys', () => {
    rejects(event('session.end', endLogout, { sentAt: '2026-11-08T19:42:14.000Z' }));
  });

  it.each(['-1', '', 'abc', '12.5', ' 123'])('rejects accountHash %j', (accountHash) => {
    expect(issuePaths(event('session.end', endLogout, { accountHash }))).toContain('accountHash');
  });

  it('accepts a negative account hash other than -1', () => {
    accepts(event('session.end', endLogout, { accountHash: '-4611686018427387904' }));
  });

  it('rejects a payload that belongs to another event type', () => {
    rejects(event('session.end', { boss: 'Vorkath', killCount: 1 }));
  });

  it('narrows the payload type on `type`', () => {
    const parsed: Event = eventSchema.parse(event('kc', { boss: 'Vorkath', killCount: 412 }));
    if (parsed.type !== 'kc') throw new Error('expected kc');
    expect(parsed.payload.killCount).toBe(412);
  });
});

describe('session.start', () => {
  const valid = {
    displayName: 'Test Main',
    accountType: 'IRONMAN',
    world: 420,
    pluginVersion: '0.1.0',
  };

  it('accepts the documented example', () => {
    accepts(event('session.start', valid));
  });

  it.each(ACCOUNT_TYPES)('accepts account type %s', (accountType) => {
    accepts(event('session.start', { ...valid, accountType }));
  });

  it.each([
    ['displayName', ''],
    ['accountType', 'ironman'],
    ['accountType', 'DEADMAN'],
    ['world', 0],
    ['world', 420.5],
    ['pluginVersion', '1.0'],
    ['pluginVersion', 'latest'],
  ])('rejects %s = %j', (field, value) => {
    expect(issuePaths(event('session.start', { ...valid, [field]: value }))).toContain(
      `payload.${field}`,
    );
  });

  it('rejects a missing field', () => {
    rejects(event('session.start', without(valid, 'world')));
  });
});

describe('session.heartbeat', () => {
  const valid = {
    regionId: 12342,
    world: 420,
    worldTypes: ['MEMBERS'],
    worldLocation: 'GERMANY',
    worldActivity: 'Trade - Members',
    idle: false,
  };

  it('accepts the documented example', () => {
    accepts(event('session.heartbeat', valid));
  });

  it('accepts unknown world info (empty types, null location and activity)', () => {
    accepts(
      event('session.heartbeat', {
        ...valid,
        worldTypes: [],
        worldLocation: null,
        worldActivity: null,
      }),
    );
  });

  it('accepts an empty activity and unknown world types', () => {
    accepts(event('session.heartbeat', { ...valid, worldActivity: '', worldTypes: ['NEW_TYPE'] }));
  });

  it.each([
    ['regionId', -1],
    ['world', 0],
    ['worldTypes', 'MEMBERS'],
    ['worldTypes', ['members']],
    ['worldLocation', 'germany'],
    ['idle', 'no'],
  ])('rejects %s = %j', (field, value) => {
    rejects(event('session.heartbeat', { ...valid, [field]: value }));
  });

  it.each(['worldTypes', 'worldLocation', 'worldActivity', 'idle'])(
    'rejects a missing %s',
    (field) => {
      rejects(event('session.heartbeat', without(valid, field)));
    },
  );
});

describe('session.afk', () => {
  it('accepts the documented example', () => {
    accepts(
      event('session.afk', {
        startedAt: '2026-11-08T19:10:00.000Z',
        endedAt: '2026-11-08T19:24:30.000Z',
      }),
    );
  });

  it('accepts a zero-length period', () => {
    const at = '2026-11-08T19:10:00.000Z';
    accepts(event('session.afk', { startedAt: at, endedAt: at }));
  });

  it('rejects a period that ends before it starts', () => {
    expect(
      issuePaths(
        event('session.afk', {
          startedAt: '2026-11-08T19:24:30.000Z',
          endedAt: '2026-11-08T19:10:00.000Z',
        }),
      ),
    ).toContain('payload.endedAt');
  });

  it('rejects timestamps without milliseconds', () => {
    rejects(
      event('session.afk', { startedAt: '2026-11-08T19:10:00Z', endedAt: '2026-11-08T19:24:30Z' }),
    );
  });
});

describe('session.end', () => {
  it.each(['logout', 'client_closed', 'hop'])('accepts reason %s', (reason) => {
    accepts(event('session.end', { reason }));
  });

  it.each(['timeout', 'LOGOUT', ''])('rejects reason %j', (reason) => {
    rejects(event('session.end', { reason }));
  });
});

describe('xp.snapshot', () => {
  /** Every known skill at level 1, with `overrides` on top. */
  function allSkills(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...Object.fromEntries(SKILLS.map((s) => [s, { xp: 0, level: 1 }])), ...overrides };
  }

  const skills = allSkills({
    ATTACK: { xp: 13034431, level: 99 },
    SLAYER: { xp: 5346332, level: 90 },
  });

  it.each(['login', 'logout', 'interval'])('accepts reason %s', (reason) => {
    accepts(event('xp.snapshot', { reason, skills }));
  });

  it('accepts an unknown extra skill in uppercase', () => {
    accepts(
      event('xp.snapshot', {
        reason: 'login',
        skills: allSkills({ NEW_SKILL: { xp: 0, level: 1 } }),
      }),
    );
  });

  it('accepts the XP cap', () => {
    accepts(
      event('xp.snapshot', {
        reason: 'login',
        skills: allSkills({ ATTACK: { xp: 200_000_000, level: 99 } }),
      }),
    );
  });

  it('rejects an unknown reason', () => {
    rejects(event('xp.snapshot', { reason: 'manual', skills }));
  });

  it('rejects an empty skills object', () => {
    rejects(event('xp.snapshot', { reason: 'login', skills: {} }));
  });

  it.each(SKILLS)('rejects a snapshot without %s', (skill) => {
    const partial = Object.fromEntries(Object.entries(skills).filter(([k]) => k !== skill));
    expect(issuePaths(event('xp.snapshot', { reason: 'login', skills: partial }))).toEqual([
      `payload.skills.${skill}`,
    ]);
  });

  it('reports every missing skill', () => {
    const paths = issuePaths(
      event('xp.snapshot', { reason: 'login', skills: { ATTACK: { xp: 0, level: 1 } } }),
    );
    expect(paths).toHaveLength(SKILLS.length - 1);
  });

  it.each([['attack'], ['Attack'], [''], ['1ATTACK']])('rejects skill name %j', (name) => {
    rejects(
      event('xp.snapshot', { reason: 'login', skills: allSkills({ [name]: { xp: 0, level: 1 } }) }),
    );
  });

  it('requires all skills and checks extra skill names in the JSON Schema export', () => {
    const json = z.toJSONSchema(xpSnapshotSkillsSchema) as Record<string, unknown>;
    expect(json.required).toEqual([...SKILLS]);
    expect(json.propertyNames).toEqual({ type: 'string', pattern: '^[A-Z][A-Z0-9_]*$' });
    expect(json.additionalProperties).toMatchObject({ required: ['xp', 'level'] });
  });

  it.each([
    { xp: -1, level: 1 },
    { xp: 200_000_001, level: 99 },
    { xp: 1.5, level: 1 },
    { xp: 0, level: 0 },
    { xp: 0, level: 100 },
    { xp: 0 },
    { xp: 0, level: 1, boosted: 2 },
  ])('rejects skill value %j', (value) => {
    rejects(event('xp.snapshot', { reason: 'login', skills: allSkills({ ATTACK: value }) }));
  });
});

describe('loot', () => {
  const vorkath = {
    source: { type: 'NPC', name: 'Vorkath', npcId: 8061, combatLevel: 732 },
    items: [
      { itemId: 11286, name: 'Draconic visage', quantity: 1, gePrice: 2850000, haPrice: 60000 },
      { itemId: 536, name: 'Dragon bones', quantity: 2, gePrice: 2100, haPrice: 0 },
    ],
    killCount: 412,
  };

  it('accepts the documented example', () => {
    accepts(event('loot', vorkath));
  });

  it('accepts NPC loot without npcId, combatLevel and killCount', () => {
    accepts(event('loot', { source: { type: 'NPC', name: 'Goblin' }, items: coins }));
  });

  it.each(['EVENT', 'CLUE', 'OTHER'])('accepts %s loot with a name', (type) => {
    accepts(event('loot', { source: { type, name: 'Chambers of Xeric' }, items: coins }));
  });

  it.each(['EVENT', 'CLUE', 'OTHER'])('rejects %s loot with an npcId', (type) => {
    rejects(event('loot', { source: { type, name: 'Barrows', npcId: 1 }, items: coins }));
  });

  it('rejects an unknown source type', () => {
    rejects(event('loot', { source: { type: 'PET', name: 'Olmlet' }, items: coins }));
  });

  it.each([null, ''])('rejects NPC loot with name %j', (name) => {
    rejects(event('loot', { source: { type: 'NPC', name }, items: coins }));
  });

  describe('PLAYER source (no data about other players)', () => {
    it('accepts PLAYER loot with name: null', () => {
      accepts(event('loot', { source: { type: 'PLAYER', name: null }, items: coins }));
    });

    it('rejects PLAYER loot with a name', () => {
      expect(
        issuePaths(event('loot', { source: { type: 'PLAYER', name: 'Test Main' }, items: coins })),
      ).toContain('payload.source.name');
    });

    it('rejects PLAYER loot with an empty-string name', () => {
      rejects(event('loot', { source: { type: 'PLAYER', name: '' }, items: coins }));
    });

    it('rejects PLAYER loot without the name field', () => {
      rejects(event('loot', { source: { type: 'PLAYER' }, items: coins }));
    });

    it.each([{ npcId: 1 }, { combatLevel: 126 }, { npcId: 1, combatLevel: 126 }])(
      'rejects PLAYER loot with %j',
      (extra) => {
        rejects(event('loot', { source: { type: 'PLAYER', name: null, ...extra }, items: coins }));
      },
    );
  });

  it('rejects an empty items list', () => {
    rejects(event('loot', { ...vorkath, items: [] }));
  });

  it.each([
    ['itemId', -1],
    ['itemId', 1.5],
    ['name', ''],
    ['quantity', 0],
    ['gePrice', -1],
    ['haPrice', 0.5],
  ])('rejects item %s = %j', (field, value) => {
    rejects(event('loot', { ...vorkath, items: [{ ...coins[0], [field]: value }] }));
  });

  it.each([0, -1, 1.5])('rejects killCount %j', (killCount) => {
    rejects(event('loot', { ...vorkath, killCount }));
  });
});

describe('kc', () => {
  it('accepts the documented example', () => {
    accepts(
      event('kc', { boss: 'Vorkath', killCount: 412, timeSeconds: 74.4, personalBest: false }),
    );
  });

  it('accepts an unknown boss without optional fields', () => {
    accepts(event('kc', { boss: 'Some New Boss', killCount: 1 }));
  });

  it.each([
    ['boss', ''],
    ['killCount', 0],
    ['killCount', 1.5],
    ['timeSeconds', 0],
    ['timeSeconds', -3],
    ['timeSeconds', null],
    ['personalBest', 'yes'],
    ['personalBestSeconds', 0],
    ['personalBestSeconds', -63],
    ['personalBestSeconds', '1:03'],
    ['personalBestSeconds', null],
    ['teamSize', 0],
    ['teamSize', 101],
    ['teamSize', 2.5],
    ['teamSize', null],
  ])('rejects %s = %j', (field, value) => {
    rejects(event('kc', { boss: 'Vorkath', killCount: 412, [field]: value }));
  });

  it('accepts personalBestSeconds, also without timeSeconds', () => {
    accepts(
      event('kc', {
        boss: 'Zulrah',
        killCount: 88,
        timeSeconds: 117,
        personalBest: false,
        personalBestSeconds: 63,
      }),
    );
    accepts(event('kc', { boss: 'Zulrah', killCount: 88, personalBestSeconds: 63 }));
  });

  // The game may round the kill time and the PB differently, and a rejected
  // event is never retried, so these are not checked against each other.
  it.each([
    ['a new PB that differs from the time', { timeSeconds: 63.6, personalBest: true }],
    ['a PB slower than this kill', { timeSeconds: 62.4, personalBest: false }],
  ])('accepts %s', (_, fields) => {
    accepts(event('kc', { boss: 'Zulrah', killCount: 88, personalBestSeconds: 63, ...fields }));
  });

  it.each([1, 3, 100])('accepts teamSize %j', (teamSize) => {
    accepts(event('kc', { boss: 'Tombs of Amascut: Expert Mode', killCount: 140, teamSize }));
  });
});

describe('raid.special_loot', () => {
  const fang = { itemId: 26219, name: "Osmumten's fang", quantity: 1, gePrice: 24500000 };
  const special = {
    raid: 'Tombs of Amascut: Expert Mode',
    item: fang,
    recipient: 'SELF',
    teamSize: 3,
    killCount: 140,
  };

  it('accepts the documented example', () => {
    accepts(event('raid.special_loot', special));
  });

  it('accepts a teammate drop without optional fields', () => {
    accepts(
      event('raid.special_loot', { raid: 'Some New Raid', item: fang, recipient: 'TEAMMATE' }),
    );
  });

  describe('no data about other players', () => {
    it.each(['playerName', 'name', 'recipientName', 'teammate'])(
      'rejects a payload with %s',
      (key) => {
        expect(issuePaths(event('raid.special_loot', { ...special, [key]: 'Test Main' }))).toEqual([
          'payload',
        ]);
      },
    );

    it.each(['Test Main', 'self', 'PLAYER', null])('rejects recipient %j', (recipient) => {
      rejects(event('raid.special_loot', { ...special, recipient }));
    });

    it('rejects a name on the item’s recipient', () => {
      rejects(
        event('raid.special_loot', { ...special, item: { ...fang, recipient: 'Test Main' } }),
      );
    });
  });

  it.each([
    ['raid', ''],
    ['teamSize', 0],
    ['teamSize', 101],
    ['killCount', 0],
    ['item', { ...fang, quantity: 0 }],
    ['item', { ...fang, gePrice: -1 }],
    ['item', { ...fang, haPrice: 0 }],
    ['item', without(fang, 'gePrice')],
  ])('rejects %s = %j', (field, value) => {
    rejects(event('raid.special_loot', { ...special, [field]: value }));
  });

  it.each(['raid', 'item', 'recipient'])('requires %s', (field) => {
    rejects(event('raid.special_loot', without(special, field)));
  });
});

describe('pb.records', () => {
  const records = {
    boss: 'Fractured Archive',
    records: [
      { scope: 'overall', teamSize: 3, seconds: 1088.4 },
      { scope: 'overall', teamSize: 4, seconds: 1150.8 },
      { scope: 'Ocellus', teamSize: 3, seconds: 105 },
    ],
  };
  const record = { scope: 'overall', teamSize: 3, seconds: 1088.4 };

  it('accepts the documented example', () => {
    accepts(event('pb.records', records));
  });

  it('accepts an unknown boss and room by name', () => {
    accepts(
      event('pb.records', {
        boss: 'Some New Raid',
        records: [{ scope: 'Some New Room', teamSize: 1, seconds: 0.6 }],
      }),
    );
  });

  it('rejects the same scope and team size twice', () => {
    expect(
      issuePaths(event('pb.records', { ...records, records: [record, { ...record, seconds: 1 }] })),
    ).toEqual(['payload.records.1']);
  });

  it('accepts the same team size in another scope, and another team size in the same scope', () => {
    accepts(
      event('pb.records', {
        ...records,
        records: [record, { ...record, scope: 'Moia' }, { ...record, teamSize: 4 }],
      }),
    );
  });

  it.each([
    ['boss', ''],
    ['records', []],
  ])('rejects %s = %j', (field, value) => {
    rejects(event('pb.records', { ...records, [field]: value }));
  });

  it.each([
    ['scope', ''],
    ['teamSize', 0],
    ['teamSize', 101],
    ['teamSize', 2.5],
    ['seconds', 0],
    ['seconds', -1],
  ])('rejects a record with %s = %j', (field, value) => {
    rejects(event('pb.records', { ...records, records: [{ ...record, [field]: value }] }));
  });

  it.each(['scope', 'teamSize', 'seconds'])('requires %s in a record', (field) => {
    rejects(event('pb.records', { ...records, records: [without(record, field)] }));
  });

  it.each(['boss', 'records'])('requires %s', (field) => {
    rejects(event('pb.records', without(records, field)));
  });

  describe('no data about other players', () => {
    it.each(['playerName', 'name', 'players'])('rejects a record with %s', (key) => {
      expect(
        issuePaths(
          event('pb.records', { ...records, records: [{ ...record, [key]: 'Test Main' }] }),
        ),
      ).toEqual(['payload.records.0']);
    });

    it('rejects extra payload keys', () => {
      expect(issuePaths(event('pb.records', { ...records, players: ['Test Main'] }))).toEqual([
        'payload',
      ]);
    });
  });
});

describe('quests.snapshot', () => {
  const entry = { quest: 'DRAGON_SLAYER_II', name: 'Dragon Slayer II', state: 'FINISHED' };
  const quests = { questPoints: 284, quests: [entry] };

  it('accepts a snapshot, with and without kind', () => {
    accepts(event('quests.snapshot', quests));
    accepts(
      event('quests.snapshot', {
        questPoints: 0,
        quests: [
          { ...entry, kind: 'QUEST' },
          {
            quest: 'BEAR_YOUR_SOUL',
            name: 'Bear Your Soul',
            state: 'IN_PROGRESS',
            kind: 'MINIQUEST',
          },
        ],
      }),
    );
  });

  it('accepts an empty list and an unknown quest', () => {
    accepts(event('quests.snapshot', { questPoints: 0, quests: [] }));
    accepts(
      event('quests.snapshot', {
        ...quests,
        quests: [{ quest: 'SOME_NEW_QUEST_2', name: 'Some New Quest 2', state: 'NOT_STARTED' }],
      }),
    );
  });

  it('rejects the same quest twice', () => {
    expect(
      issuePaths(
        event('quests.snapshot', {
          ...quests,
          quests: [entry, { ...entry, state: 'NOT_STARTED' }],
        }),
      ),
    ).toEqual(['payload.quests.1.quest']);
  });

  it.each([
    ['quest', 'dragon_slayer_ii'],
    ['quest', ''],
    ['name', ''],
    ['name', 'x'.repeat(101)],
    ['state', 'COMPLETED'],
    ['state', 'finished'],
    ['kind', 'SUBQUEST'],
    ['kind', null],
    ['questPoints', 1],
  ])('rejects an entry with %s = %j', (field, value) => {
    rejects(event('quests.snapshot', { ...quests, quests: [{ ...entry, [field]: value }] }));
  });

  it.each(['quest', 'name', 'state'])('requires %s in an entry', (field) => {
    rejects(event('quests.snapshot', { ...quests, quests: [without(entry, field)] }));
  });

  it.each([-1, 1.5, 10_001, '284'])('rejects questPoints = %j', (questPoints) => {
    rejects(event('quests.snapshot', { ...quests, questPoints }));
  });

  it.each(['questPoints', 'quests'])('requires %s', (field) => {
    rejects(event('quests.snapshot', without(quests, field)));
  });

  it('rejects more than 500 entries', () => {
    const many = Array.from({ length: 501 }, (_, index) => ({
      ...entry,
      quest: `QUEST_${String(index)}`,
    }));
    rejects(event('quests.snapshot', { ...quests, quests: many }));
  });
});

describe('diaries.snapshot', () => {
  const entry = { region: 'ARDOUGNE', tier: 'HARD', completed: true };

  it('accepts a snapshot, an empty list and an unknown region', () => {
    accepts(event('diaries.snapshot', { diaries: [entry, { ...entry, tier: 'ELITE' }] }));
    accepts(event('diaries.snapshot', { diaries: [] }));
    accepts(event('diaries.snapshot', { diaries: [{ ...entry, region: 'NEW_REGION' }] }));
  });

  it('rejects the same region and tier twice', () => {
    expect(
      issuePaths(event('diaries.snapshot', { diaries: [entry, { ...entry, completed: false }] })),
    ).toEqual(['payload.diaries.1.tier']);
  });

  it.each([
    ['region', 'Ardougne'],
    ['tier', 'MASTER'],
    ['tier', 'hard'],
    ['completed', 1],
    ['completed', 'true'],
    ['name', 'Ardougne'],
  ])('rejects an entry with %s = %j', (field, value) => {
    rejects(event('diaries.snapshot', { diaries: [{ ...entry, [field]: value }] }));
  });

  it.each(['region', 'tier', 'completed'])('requires %s in an entry', (field) => {
    rejects(event('diaries.snapshot', { diaries: [without(entry, field)] }));
  });

  it('requires diaries and rejects extra keys', () => {
    rejects(event('diaries.snapshot', {}));
    rejects(event('diaries.snapshot', { diaries: [], contentHash: 'x' }));
  });
});

describe('pet.drop', () => {
  const pet = { itemId: 21992, name: 'Vorki' };
  const source = { type: 'ACTIVITY', name: 'Vorkath' };
  const drop = { message: 'FOLLOWED', guessedPet: pet, guessedSource: source };

  it.each(['FOLLOWED', 'BACKPACK', 'DUPLICATE'])('accepts the message %s', (message) => {
    accepts(event('pet.drop', { ...drop, message }));
  });

  it('accepts a drop without guesses, a skill source and an unknown pet and skill', () => {
    accepts(event('pet.drop', { message: 'BACKPACK' }));
    accepts(event('pet.drop', { ...drop, guessedSource: { type: 'SKILL', name: 'WOODCUTTING' } }));
    accepts(
      event('pet.drop', {
        message: 'FOLLOWED',
        guessedPet: { itemId: 39999, name: 'Brand new pet' },
        guessedSource: { type: 'SKILL', name: 'NEW_SKILL' },
      }),
    );
  });

  it('never takes the chat text or any other extra key', () => {
    expect(issuePaths(event('pet.drop', { ...drop, text: 'You have a funny feeling...' }))).toEqual(
      ['payload'],
    );
    rejects(event('pet.drop', { ...drop, guessedPetItemId: 21992 }));
    rejects(event('pet.drop', { ...drop, guessedPet: { ...pet, quantity: 1 } }));
    rejects(event('pet.drop', { ...drop, guessedSource: { ...source, npcId: 8061 } }));
  });

  it.each([
    ['message', 'followed'],
    ['message', 'INSURED'],
    ['message', null],
    ['guessedPet', 21992],
    ['guessedPet', { itemId: 21992 }],
    ['guessedPet', { itemId: 0, name: 'Vorki' }],
    ['guessedPet', { itemId: 21992, name: '' }],
    ['guessedPet', { itemId: 21992, name: 'x'.repeat(101) }],
    ['guessedPet', null],
    ['guessedSource', 'Vorkath'],
    ['guessedSource', { type: 'ACTIVITY', name: '' }],
    ['guessedSource', { type: 'SKILL', name: 'Woodcutting' }],
    ['guessedSource', { type: 'PLAYER', name: null }],
    ['guessedSource', { name: 'Vorkath' }],
  ])('rejects %s = %j', (field, value) => {
    rejects(event('pet.drop', { ...drop, [field]: value }));
  });

  it('requires message', () => {
    rejects(event('pet.drop', without(drop, 'message')));
  });
});
