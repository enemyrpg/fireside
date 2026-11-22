import {
  DEFAULT_SPLIT_MODE,
  EARLIEST_MANUAL_DROP_AT,
  MAX_DROP_NICKNAME_LENGTH,
  MAX_DROP_NOTE_LENGTH,
  raidDropCreateRequestSchema,
  raidDropUpdateRequestSchema,
  type RaidDrop,
  type RaidSplitsResponse,
} from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import splitsFixture from '../../../shared/fixtures/api/raid-splits-response/valid/page.json';
import {
  ACCOUNT_DEFAULT,
  DEFAULT_MODE,
  dropChanges,
  dropForm,
  EARLIEST_DROP_DATE,
  gotByLabel,
  GP_INPUT_HINT,
  monthBars,
  NICKNAME_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  isPriceFromLaterDate,
  type AddDropForm,
  parseAddDropForm,
  parseDropForm,
  parseGpInput,
  PARTY_SIZE_INVALID,
  priceSourceLabel,
  shareExplanation,
  SOLD_FOR_INVALID,
  soldForHelp,
  TIME_IN_FUTURE,
  TIME_INVALID,
} from './raid-splits';

const drops = (splitsFixture as RaidSplitsResponse).drops.items;

function drop(name: string, manual = false): RaidDrop {
  const found = drops.find((item) => item.name === name && item.manual === manual);
  if (!found) throw new Error(`No ${name} in the fixture`);
  return found;
}

const fang = drop("Osmumten's fang"); // own, split, trio
const bow = drop('Twisted bow'); // teammate, split, sold for 900M, nickname and note
const mask = drop('Masori mask'); // own, split, no party size
const manualScythe = drop('Scythe of vitur (uncharged)', true); // manual, party size set
const ffaScythe = drop('Scythe of vitur (uncharged)'); // teammate, FFA set on the drop

describe('limits', () => {
  it('are the same as in the contract', () => {
    expect(NICKNAME_MAX_LENGTH).toBe(MAX_DROP_NICKNAME_LENGTH);
    expect(NOTE_MAX_LENGTH).toBe(MAX_DROP_NOTE_LENGTH);
    expect(DEFAULT_MODE).toBe(DEFAULT_SPLIT_MODE);
    expect(raidDropUpdateRequestSchema.safeParse({ partySize: 100 }).success).toBe(true);
    expect(raidDropUpdateRequestSchema.safeParse({ partySize: 101 }).success).toBe(false);
    expect(raidDropUpdateRequestSchema.safeParse({ partySize: 0 }).success).toBe(false);
  });
});

describe('parseGpInput', () => {
  it.each([
    ['850m', 850_000_000],
    ['850M', 850_000_000],
    ['24k', 24_000],
    [' 12 ', 12],
    ['0', 0],
    ['850000000', 850_000_000],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
    // With a suffix a comma or a point is the decimal separator, two decimals at most.
    ['1.2b', 1_200_000_000],
    ['1,2b', 1_200_000_000],
    ['850,5m', 850_500_000],
    ['2.5k', 2_500],
    ['2,5k', 2_500],
    ['4.35m', 4_350_000],
    ['1,25b', 1_250_000_000],
    // Without a suffix a comma, a point or a space is a thousands separator.
    ['850,000,000', 850_000_000],
    ['850.000.000', 850_000_000],
    ['850 000 000', 850_000_000],
    ['1,000', 1_000],
    ['1.000', 1_000],
    ['1 000', 1_000],
    ['12.345.678', 12_345_678],
  ])('reads %s', (text, value) => {
    expect(parseGpInput(text)).toBe(value);
  });

  it.each([
    '',
    'abc',
    '-5',
    '5x',
    '1e9',
    'm',
    '.5m',
    // Three digits after the separator could be a thousands group.
    '1,200k',
    '1.200m',
    '1.234b',
    '1.2345678912b',
    // Without a suffix: only groups of three, never decimals.
    '1,2',
    '1.5',
    '1,20,0',
    '1,2345',
    '1234,567',
    '1234.567',
    ',000',
    '1,000,',
    '1  000',
    '850.000.000,00',
    '850,000,000.00',
    '1,000.5',
    // The same separator throughout.
    '1.000,000',
    '1 000.000',
    '1,000 000',
    // One decimal separator at most, and no thousands groups before a suffix.
    '1,000,5m',
    '1.000,5m',
    '1,2,3b',
    '1.2,3b',
    '850 m',
    '9007199254740992',
    '10000000b',
  ])('rejects %j', (text) => {
    expect(parseGpInput(text)).toBeNull();
  });
});

describe('labels', () => {
  it('names who got a drop without a name from the game', () => {
    expect(gotByLabel(fang)).toBe('You');
    expect(gotByLabel(bow)).toBe('Nickname A');
    expect(gotByLabel(ffaScythe)).toBe('Teammate');
  });

  it('explains a share', () => {
    expect(shareExplanation(fang)).toBe('Split: 24,000,000 ÷ 3');
    // From the owner's own value, not the GE value.
    expect(shareExplanation(bow)).toBe('Split: 900,000,000 ÷ 3');
    expect(shareExplanation(ffaScythe)).toBe('FFA: a teammate’s drop counts 0');
    expect(shareExplanation({ ...fang, mode: 'FFA', share: fang.value })).toBe(
      'FFA: your own drop, full value',
    );
    expect(shareExplanation(mask)).toBeNull();
  });

  it('says where a price is from', () => {
    expect(priceSourceLabel('DROP')).toBe('GE price when it dropped');
    expect(priceSourceLabel('SPECIAL_LOOT')).toBe('GE price from another purple');
    expect(priceSourceLabel('LOOT')).toBe('GE price from a loot drop');
    expect(priceSourceLabel('BANK')).toBe('GE price from your bank');
  });

  it('turns months into bars with the year on January', () => {
    expect(
      monthBars([
        { month: '2025-12', share: 5 },
        { month: '2026-01', share: 0 },
        { month: '2026-02', share: 7 },
      ]),
    ).toEqual([
      { key: '2025-12', label: 'Dec', title: 'Dec 2025', value: 5 },
      { key: '2026-01', label: 'Jan 26', title: 'Jan 2026', value: 0 },
      { key: '2026-02', label: 'Feb', title: 'Feb 2026', value: 7 },
    ]);
  });
});

describe('the edit form', () => {
  it('opens with the choices on the drop', () => {
    expect(dropForm(bow)).toEqual({
      soldFor: '900,000,000',
      mode: ACCOUNT_DEFAULT,
      // The plugin's size is the placeholder, not a value.
      partySize: '',
      nickname: 'Nickname A',
      note: 'Sold on day two',
    });
    expect(dropForm(ffaScythe).mode).toBe('FFA');
    expect(dropForm(mask)).toMatchObject({ soldFor: '', partySize: '' });
    // A size the owner set.
    expect(dropForm(manualScythe).partySize).toBe('4');
  });

  it('sends nothing when nothing changed', () => {
    for (const item of drops) {
      const parsed = parseDropForm(dropForm(item));
      if (!parsed.ok) throw new Error('The untouched form must be valid');
      expect(dropChanges(item, parsed.choices)).toEqual({});
    }
  });

  it('sends only what changed, and null for a cleared field', () => {
    const parsed = parseDropForm({
      soldFor: '',
      mode: 'FFA',
      partySize: '4',
      nickname: '  ',
      note: 'Sold on day two',
    });
    if (!parsed.ok) throw new Error('Expected a valid form');
    const changes = dropChanges(bow, parsed.choices);
    expect(changes).toEqual({ ownValue: null, mode: 'FFA', partySize: 4, nickname: null });
    expect(raidDropUpdateRequestSchema.safeParse(changes).success).toBe(true);
  });

  it('sets a value, a party size and a note on an own drop, never a nickname', () => {
    const parsed = parseDropForm({
      soldFor: '9.5m',
      mode: ACCOUNT_DEFAULT,
      partySize: '2',
      nickname: 'Ignored',
      note: ' Kept it ',
    });
    if (!parsed.ok) throw new Error('Expected a valid form');
    expect(dropChanges(mask, parsed.choices)).toEqual({
      ownValue: 9_500_000,
      partySize: 2,
      note: 'Kept it',
    });
  });

  it('goes back to the account default and the plugin’s party size', () => {
    // The plugin's size is not a choice: an empty field changes nothing.
    const untouched = parseDropForm({ ...dropForm(fang), partySize: ' ' });
    if (!untouched.ok) throw new Error('Expected a valid form');
    expect(dropChanges(fang, untouched.choices)).toEqual({});
    const parsed = parseDropForm({ ...dropForm(ffaScythe), mode: ACCOUNT_DEFAULT });
    if (!parsed.ok) throw new Error('Expected a valid form');
    expect(dropChanges(ffaScythe, parsed.choices)).toEqual({ mode: null });
    const cleared = parseDropForm({ ...dropForm(manualScythe), partySize: '' });
    if (!cleared.ok) throw new Error('Expected a valid form');
    expect(dropChanges(manualScythe, cleared.choices)).toEqual({ partySize: null });
  });

  it('rejects a bad value and party size with a message per field', () => {
    for (const partySize of ['0', '101', '2.5', 'two', '-1', '4x']) {
      const parsed = parseDropForm({ ...dropForm(fang), soldFor: 'lots', partySize });
      expect(parsed).toEqual({
        ok: false,
        errors: { ownValue: SOLD_FOR_INVALID, partySize: PARTY_SIZE_INVALID },
      });
    }
  });
});

describe('the help under "Sold for"', () => {
  it('says what an empty field means and which forms it reads', () => {
    expect(soldForHelp(bow)).toBe(
      'Leave empty to use the GE price when it dropped (1B gp). You can type 850m, 1,2b or 850.000.000.',
    );
    expect(soldForHelp(manualScythe)).toContain('the GE price from when you added it (800M gp)');
    expect(soldForHelp({ geValue: null, manual: true })).toContain('No GE price was known');
    // Every form the hint names is read.
    for (const example of ['850m', '1,2b', '850.000.000']) {
      expect(GP_INPUT_HINT).toContain(example);
      expect(parseGpInput(example)).not.toBeNull();
    }
  });
});

describe('adding a drop', () => {
  const OSLO = 'Europe/Oslo';
  const NOW = Date.parse('2026-11-16T12:00:00.000Z');
  const base: AddDropForm = {
    recipient: 'TEAMMATE',
    raid: 'Theatre of Blood: Hard Mode',
    itemId: '22486',
    date: '2026-10-12',
    time: '22:40',
    partySize: '',
    nickname: '',
    soldFor: '',
  };

  it('has the same first day as the contract', () => {
    expect(EARLIEST_MANUAL_DROP_AT.startsWith(`${EARLIEST_DROP_DATE}T`)).toBe(true);
  });

  it('builds the request in the server’s time zone and leaves out empty optional fields', () => {
    expect(parseAddDropForm(base, OSLO, NOW)).toEqual({
      ok: true,
      body: {
        raid: 'Theatre of Blood: Hard Mode',
        itemId: 22486,
        // 22:40 in Oslo in October (summer time) is 20:40 UTC.
        occurredAt: '2026-10-12T20:40:00.000Z',
        recipient: 'TEAMMATE',
      },
    });
    // Another server zone gives another instant for the same date and time.
    const tokyo = parseAddDropForm(base, 'Asia/Tokyo', NOW);
    expect(tokyo.ok && tokyo.body.occurredAt).toBe('2026-10-12T13:40:00.000Z');

    const full = parseAddDropForm(
      { ...base, partySize: '4', nickname: ' Nickname B ', soldFor: '850m' },
      OSLO,
      NOW,
    );
    if (!full.ok) throw new Error('Expected a valid form');
    expect(full.body).toMatchObject({
      partySize: 4,
      nickname: 'Nickname B',
      ownValue: 850_000_000,
    });
    expect(raidDropCreateRequestSchema.safeParse(full.body).success).toBe(true);
  });

  it('sends an own drop without a nickname, also one typed before choosing You', () => {
    const own = parseAddDropForm(
      // Too long for a nickname: not checked either, the field is hidden.
      { ...base, recipient: 'SELF', nickname: 'x'.repeat(40), partySize: '3' },
      OSLO,
      NOW,
    );
    expect(own).toEqual({
      ok: true,
      body: {
        raid: 'Theatre of Blood: Hard Mode',
        itemId: 22486,
        occurredAt: '2026-10-12T20:40:00.000Z',
        recipient: 'SELF',
        partySize: 3,
      },
    });
    expect(own.ok && raidDropCreateRequestSchema.safeParse(own.body).success).toBe(true);
  });

  it('knows when a manual drop’s price is from after the drop', () => {
    const manual = { manual: true, occurredAt: '2019-03-01T20:00:00.000Z' };
    expect(isPriceFromLaterDate({ ...manual, gePriceAt: '2026-11-08T19:00:00.000Z' })).toBe(true);
    // A price from the drop's own time or earlier, no price, and a detected drop.
    expect(isPriceFromLaterDate({ ...manual, gePriceAt: '2019-03-01T20:00:00.000Z' })).toBe(false);
    expect(isPriceFromLaterDate({ ...manual, gePriceAt: '2018-12-24T10:00:00.000Z' })).toBe(false);
    expect(isPriceFromLaterDate({ ...manual, gePriceAt: null })).toBe(false);
    expect(
      isPriceFromLaterDate({ ...manual, manual: false, gePriceAt: '2026-11-08T19:00:00.000Z' }),
    ).toBe(false);
  });

  it('asks for the raid, the item and a 24-hour time', () => {
    const parsed = parseAddDropForm(
      { ...base, raid: '', itemId: '', time: '9pm', partySize: '0', soldFor: 'x' },
      OSLO,
      NOW,
    );
    expect(parsed).toEqual({
      ok: false,
      errors: {
        raid: 'Choose a raid.',
        itemId: 'Choose an item.',
        time: TIME_INVALID,
        ownValue: SOLD_FOR_INVALID,
        partySize: PARTY_SIZE_INVALID,
      },
    });
  });

  it('rejects a time later than now, read in the server’s time zone', () => {
    // 13:00 in Oslo is 12:00 UTC: exactly now, so allowed.
    const now = parseAddDropForm({ ...base, date: '2026-11-16', time: '13:00' }, OSLO, NOW);
    expect(now.ok).toBe(true);
    const later = parseAddDropForm({ ...base, date: '2026-11-16', time: '13:01' }, OSLO, NOW);
    expect(later).toEqual({ ok: false, errors: { time: TIME_IN_FUTURE } });
  });
});
