import { RAIDS, type RaidDrop, type RaidSplitsResponse } from '@fireside/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import kcFixture from '../../../shared/fixtures/api/kc-response/valid/bosses.json';
import manualDropFixture from '../../../shared/fixtures/api/raid-drop-response/valid/manual-possible-duplicate.json';
import noSplitsFixture from '../../../shared/fixtures/api/raid-splits-response/valid/no-data.json';
import splitsFixture from '../../../shared/fixtures/api/raid-splits-response/valid/page.json';
import noDataFixture from '../../../shared/fixtures/api/raids-response/valid/no-data.json';
import raidsFixture from '../../../shared/fixtures/api/raids-response/valid/page.json';
import { ADD_DROP_HELP, ADD_DROP_TITLE, GOT_BY_LABEL } from '@/components/AddDropDialog';
import {
  POSSIBLE_DUPLICATE,
  POSSIBLE_DUPLICATE_DETAIL,
  TAP_TO_EDIT,
} from '@/components/SpecialLootTable';
import { DEFAULT_LABEL, PICK_AN_ACCOUNT } from '@/components/RaidsStrip';
import {
  dropRowId,
  OWN_NOTE_HELP,
  PARTY_SIZE_INVALID,
  PRICE_FROM_LATER_DATE,
  SAVE_FAILED,
  SOLD_FOR_INVALID,
  TIME_IN_FUTURE,
  TIME_INVALID,
} from '@/lib/raid-splits';
import {
  RAID_EMPTY,
  SPECIAL_LOOT_MANUAL,
  SPECIAL_LOOT_MANUAL_RULE,
  SPECIAL_LOOT_RECORDED,
} from '@/lib/raids';
import { mockApi, renderApp, stubDesktop, stubWide, type MockAnswer } from '@/test/render-app';
import {
  BEST_TIMES_NOTE,
  DROP_FURTHER_DOWN,
  SHOW_DROP_MAX_PAGES,
  SPECIAL_LOOT_EMPTY,
} from './RaidsPage';

// The raids fixture has loot for CoX (4.2M gp) and ToA (9.8M gp, special
// 24.5M gp). The KC fixture has ToA Expert Mode (140, solo 29:10.0 and trio
// 21:40.2) and two bosses.
//
// The splits fixture: your share is 518M gp (18M from your own drops, 500M
// from teammates'), 210M in October and 308M in November; CoX 310M (and 30M
// special loot added by hand), ToB 200M, ToA 8M. Account 1 defaults to Split
// and account 2 to FFA. Six drops and a next cursor:
//   0 Osmumten's fang: own, split in a trio, 24M → 8M
//   1 Twisted bow: teammate "Nickname A", sold for 900M (GE 1B), a note → 300M
//   2 Masori mask: own, no party size → no share yet
//   3 Scythe (manual, account 2): "Nickname B", price from another purple,
//     possible duplicate of drop 4 → 200M
//   4 Scythe (account 2): teammate, FFA set on the drop → 0
//   5 Twisted bow (manual): own, from 5 Oct with a price seen on 1 Nov, split
//     in a trio, 30M → 10M

const splits = splitsFixture as RaidSplitsResponse;
const [fang, bow, mask, manualScythe, ffaScythe, ownManualBow] = splits.drops.items as [
  RaidDrop,
  RaidDrop,
  RaidDrop,
  RaidDrop,
  RaidDrop,
  RaidDrop,
];

const SPLITS_PATH = '/api/v1/accounts/1/raids/splits';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const failure = () =>
  json({ error: { code: 'INTERNAL_ERROR', message: 'Boom', details: [] } }, 500);

/** An own Ghrazi rapier with a split in a duo, for later pages. */
function extraDrop(index: number): RaidDrop {
  return {
    ...fang,
    dropId: `01933c4e-8a2b-7c3d-9e4f-0000000001${String(index).padStart(2, '0')}`,
    occurredAt: '2026-10-02T18:00:00.000Z',
    raid: 'Theatre of Blood',
    raidGroup: 'Theatre of Blood',
    itemId: 22324,
    name: 'Ghrazi rapier',
    gePriceEach: 30_000_000,
    geValue: 30_000_000,
    gePriceAt: '2026-10-02T18:00:00.000Z',
    value: 30_000_000,
    teamSize: 2,
    partySize: 2,
    share: 15_000_000,
    killCount: null,
  };
}

function cursorOf(url: string): string | null {
  return new URL(url, 'http://localhost').searchParams.get('cursor');
}

/** First page from the fixture; with a cursor, a last page with one more purple. */
const splitsAnswer: MockAnswer = (url) =>
  json(cursorOf(url) ? { ...splits, drops: { items: [extraDrop(0)], nextCursor: null } } : splits);

function mockRaidsApi(scope: string, answers: Record<string, MockAnswer> = {}) {
  return mockApi({
    [`/api/v1/accounts/${scope}/kc`]: { body: kcFixture },
    [`/api/v1/accounts/${scope}/raids`]: { body: raidsFixture },
    [`/api/v1/accounts/${scope}/raids/splits`]: splitsAnswer,
    ...answers,
  });
}

interface Call {
  method: string;
  path: string;
  cursor: string | null;
  body: unknown;
}

function calls(fetchMock: Mock): Call[] {
  return (fetchMock.mock.calls as [RequestInfo | URL, RequestInit | undefined][]).map(
    ([input, init]) => {
      const text =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(text, 'http://localhost');
      return {
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        cursor: url.searchParams.get('cursor'),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
    },
  );
}

/** Calls that change something. */
function writes(fetchMock: Mock): Call[] {
  return calls(fetchMock).filter((call) => call.method !== 'GET');
}

async function card(name: string | RegExp): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name });
  const section = heading.closest('section');
  if (!section) throw new Error(`No card for ${String(name)}`);
  return section;
}

/** The dashed line naming the raids without completions, if any. */
function dashedLine(): HTMLElement | undefined {
  return [...document.querySelectorAll('p')].find((p) =>
    p.textContent.startsWith('No completions yet:'),
  );
}

/** The number row at the top . */
async function strip(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'Raids summary' });
}

async function lootTable(): Promise<HTMLElement> {
  return screen.findByRole('table', { name: 'Special loot' });
}

function tableRows(table: HTMLElement): HTMLElement[] {
  return within(table).getAllByRole('row').slice(1);
}

function cells(row: HTMLElement | undefined): (string | null)[] {
  if (!row) throw new Error('No such row');
  return within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent);
}

function rowOf(table: HTMLElement, index: number): HTMLElement {
  const row = tableRows(table)[index];
  if (!row) throw new Error(`No row ${String(index)}`);
  return row;
}

/** Opens the edit dialog of the purple in row `index`. */
async function openEdit(index: number): Promise<HTMLElement> {
  const row = rowOf(await lootTable(), index);
  await userEvent.click(within(row).getByRole('button', { name: /^Edit / }));
  return screen.findByRole('dialog');
}

async function choose(dialog: HTMLElement, field: string, option: string) {
  await userEvent.click(within(dialog).getByRole('combobox', { name: field }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

// Columns: Date, Item, Raid, Got by, Party, Mode, Value, Your share, actions.
const [ITEM, RAID, GOT_BY, PARTY, MODE, VALUE, SHARE] = [1, 2, 3, 4, 5, 6, 7] as const;

describe('Raids', () => {
  // The special loot table is the PC layout; mobile has a list (tested below).
  beforeEach(() => {
    stubDesktop();
  });

  it('is a sub-tab of Progress', async () => {
    mockRaidsApi('1');
    renderApp('/1/progress/raids');
    const tabs = await screen.findByRole('navigation', { name: 'Progress views' });
    const raids = within(tabs).getByRole('link', { name: 'Raids' });
    expect(raids.getAttribute('href')).toBe('/1/progress/raids');
    expect(raids.getAttribute('aria-current')).toBe('page');
  });

  it('shows a card per raid with loot, your share, completions and best times', async () => {
    mockRaidsApi('1');
    renderApp('/1/progress/raids');
    const toa = await card('Tombs of Amascut');
    await within(toa).findByText('Expert Mode');
    // Only the modes with completions.
    const modes = within(toa).getByRole('list', { name: 'Tombs of Amascut modes' });
    const rows = within(modes)
      .getAllByRole('listitem')
      .filter((item) => item.parentElement === modes);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Expert Mode140');
    // Only the team sizes done, the fastest highlighted.
    const times = within(toa).getByRole('list', { name: 'Expert Mode best times' });
    const chips = within(times).getAllByRole('listitem');
    expect(chips.map((item) => item.textContent)).toEqual(['Solo29:10.0', 'Trio21:40.2(fastest)']);
    const [solo, trio] = chips;
    if (!solo || !trio) throw new Error('No best times');
    expect(within(trio).getByText('21:40.2').className).toContain('text-accent-text');
    expect(within(solo).getByText('29:10.0').className).not.toContain('text-accent-text');
    // Loot, special loot and your share. No Split/FFA switch on the card.
    expect(toa.textContent).toContain('9.8M gploot');
    expect(toa.textContent).toContain('24.5M gpspecial loot');
    expect(toa.textContent).toContain('8M gpyour share');
    expect(within(toa).queryByRole('radio')).toBeNull();

    // Loot but no completions: the card still shows the loot and the share.
    const cox = await card('Chambers of Xeric');
    // Placeholder icon with the raid's initials.
    expect(within(cox).getByText('COX')).toBeTruthy();
    expect(cox.textContent).toContain('4.2M gploot');
    expect(cox.textContent).toContain('310M gpyour share');
    expect(within(cox).getByText(RAID_EMPTY)).toBeTruthy();
    // Special loot has the own purple added by hand on top of what the plugin
    // recorded (0 here); the label says so, the tooltip has the parts and the rule.
    expect(within(cox).getByText('special loot · includes manual drops')).toBeTruthy();
    const special = within(cox).getByText('30M');
    await userEvent.hover(special);
    const shown = (await screen.findByRole('tooltip')).textContent;
    expect(shown).toContain(`${SPECIAL_LOOT_RECORDED}0 gp`);
    expect(shown).toContain(`${SPECIAL_LOOT_MANUAL}30,000,000 gp`);
    expect(shown).toContain(SPECIAL_LOOT_MANUAL_RULE);
    await userEvent.unhover(special);
    // Only purples the plugin recorded: the plain label.
    expect(within(toa).getByText('special loot')).toBeTruthy();

    // Only a share of a teammate's purple: the card shows it.
    expect((await card('Theatre of Blood')).textContent).toContain('200M gpyour share');

    // Nothing at all: no card, the raid is named on the dashed line.
    expect(screen.queryByRole('heading', { name: 'The Fractured Archive' })).toBeNull();
    expect(
      screen.getByText((_, element) =>
        element?.tagName === 'P'
          ? element.textContent ===
            'No completions yet: The Fractured Archive. They show up here after your first one.'
          : false,
      ),
    ).toBeTruthy();
    // Several cards: the chips are explained once, under them.
    expect(screen.getByText(BEST_TIMES_NOTE)).toBeTruthy();
    expect(within(toa).queryByText('Best time per team size')).toBeNull();
  });

  it('puts several cards in two columns, alternating among the cards shown', async () => {
    stubWide();
    mockRaidsApi('1');
    renderApp('/1/progress/raids');
    await card('Tombs of Amascut');
    const column = (side: string) => {
      const element = document.querySelector(`[data-column="${side}"]`);
      if (!(element instanceof HTMLElement)) throw new Error(`No ${side} column`);
      return within(element)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent);
    };
    // CoX, ToB and ToA have cards (TFA has none): left, right, left.
    expect(column('left')).toEqual(['COXChambers of Xeric', 'TOATombs of Amascut']);
    expect(column('right')).toEqual(['TOBTheatre of Blood']);
  });

  it('gives one raid a card in full width, with the times explained in it', async () => {
    const toaOnly = { bosses: kcFixture.bosses.filter((boss) => boss.category === 'raid') };
    mockRaidsApi('2', {
      '/api/v1/accounts/2/kc': { body: toaOnly },
      '/api/v1/accounts/2/raids': { body: noDataFixture },
      '/api/v1/accounts/2/raids/splits': {
        body: { ...noSplitsFixture, defaults: [{ accountId: 2, mode: 'SPLIT' }] },
      },
    });
    renderApp('/2/progress/raids');
    const toa = await card('Tombs of Amascut');
    expect(within(toa).getByText('Best time per team size')).toBeTruthy();
    expect(document.querySelector('[data-column]')).toBeNull();
    expect(screen.queryByText(BEST_TIMES_NOTE)).toBeNull();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          element.textContent.startsWith(
            'No completions yet: Chambers of Xeric · Theatre of Blood · The Fractured Archive.',
          ),
      ),
    ).toBeTruthy();
  });

  describe('the number row', () => {
    it('shows your share, where it is from and the bars per month', async () => {
      mockRaidsApi('1');
      renderApp('/1/progress/raids');
      const row = await strip();
      await waitFor(() => {
        expect(row.textContent).toContain('518Mgpyour share · all time');
      });
      expect(row.textContent).toContain('18Mgpfrom your drops');
      // The short label for mobile comes first; CSS shows one per layout.
      expect(row.textContent).toContain('500Mgpfrom teammatesfrom teammates’ drops');
      const bars = within(row).getByRole('list', { name: 'Your share per month' });
      expect(
        within(bars)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Oct', 'Nov']);
      expect(within(bars).getByLabelText('Oct 2026: 210M gp')).toBeTruthy();
      // Before GE tax, with no option for it.
      expect(screen.queryByText(/tax/i)).toBeNull();
    });

    it('saves the default Split or FFA for the account right away', async () => {
      let mode = 'SPLIT';
      const fetchMock = mockRaidsApi('1', {
        [SPLITS_PATH]: () =>
          json({
            ...splits,
            defaults: [
              { accountId: 1, mode },
              { accountId: 2, mode: 'FFA' },
            ],
          }),
        'PUT /api/v1/accounts/1/raids/split-default': () => {
          mode = 'FFA';
          return json({ accountId: 1, mode });
        },
      });
      renderApp('/1/progress/raids');
      const row = await strip();
      const toggle = await within(row).findByRole('radiogroup', { name: DEFAULT_LABEL });
      expect(within(toggle).getByRole('radio', { name: 'Split' }).dataset.state).toBe('on');
      await userEvent.click(within(toggle).getByRole('radio', { name: 'FFA' }));
      await waitFor(() => {
        expect(writes(fetchMock)).toEqual([
          {
            method: 'PUT',
            path: '/api/v1/accounts/1/raids/split-default',
            cursor: null,
            body: { mode: 'FFA' },
          },
        ]);
      });
      // The tracker is fetched again, and the choice stays.
      await waitFor(() => {
        expect(calls(fetchMock).filter((call) => call.path === SPLITS_PATH)).toHaveLength(2);
      });
      expect(within(toggle).getByRole('radio', { name: 'FFA' }).dataset.state).toBe('on');
    });

    it('goes back and says so when the default could not be saved', async () => {
      mockRaidsApi('1', { 'PUT /api/v1/accounts/1/raids/split-default': failure });
      renderApp('/1/progress/raids');
      const row = await strip();
      const toggle = await within(row).findByRole('radiogroup', { name: DEFAULT_LABEL });
      await userEvent.click(within(toggle).getByRole('radio', { name: 'FFA' }));
      expect(await within(row).findByText(SAVE_FAILED)).toBeTruthy();
      expect(within(toggle).getByRole('radio', { name: 'Split' }).dataset.state).toBe('on');
    });

    it('keeps a failed save on its own account', async () => {
      mockRaidsApi('1', {
        'PUT /api/v1/accounts/1/raids/split-default': failure,
        '/api/v1/accounts/2/kc': { body: kcFixture },
        '/api/v1/accounts/2/raids': { body: raidsFixture },
        '/api/v1/accounts/2/raids/splits': splitsAnswer,
      });
      const { router } = renderApp('/1/progress/raids');
      const row = await strip();
      const toggle = await within(row).findByRole('radiogroup', { name: DEFAULT_LABEL });
      await userEvent.click(within(toggle).getByRole('radio', { name: 'FFA' }));
      expect(await within(row).findByText(SAVE_FAILED)).toBeTruthy();

      await router.navigate('/2/progress/raids');
      // Account 2 defaults to FFA in the fixture, and has no failed save.
      await waitFor(() => {
        expect(screen.getByRole('radio', { name: 'FFA' }).dataset.state).toBe('on');
      });
      expect(screen.queryByText(SAVE_FAILED)).toBeNull();
    });

    it('shows special loot, completions and each account’s default for all accounts', async () => {
      mockRaidsApi('all');
      renderApp('/all/progress/raids');
      const row = await strip();
      await waitFor(() => {
        expect(row.textContent).toContain('Test Main · Split');
      });
      expect(row.textContent).toContain('518Mgpyour share · all time');
      // ToA's 24.5M recorded and CoX's 30M added by hand.
      expect(row.textContent).toContain('54.5Mgpspecial loot');
      // ToA Expert Mode is the only mode with completions.
      expect(row.textContent).toContain('140completionscompletions · 1 raid');
      expect(row.textContent).toContain('Default');
      expect(row.textContent).toContain('Test Main · Split');
      expect(row.textContent).toContain('Alt · FFA');
      expect(within(row).getByText(PICK_AN_ACCOUNT)).toBeTruthy();
      expect(within(row).queryByRole('radio')).toBeNull();
      expect(within(row).queryByRole('list', { name: 'Your share per month' })).toBeNull();
      // A drop added by hand belongs to one account.
      await lootTable();
      expect(screen.queryByRole('button', { name: 'Add drop' })).toBeNull();
    });
  });

  describe('Special loot', () => {
    it('lists who got each purple, the party, mode, value and your share', async () => {
      mockRaidsApi('1');
      renderApp('/1/progress/raids');
      const table = await lootTable();
      const rows = tableRows(table);
      expect(rows).toHaveLength(6);

      const own = cells(rows[0]);
      expect(own[0]).toMatch(/8 Nov/);
      expect(own[ITEM]).toContain("Osmumten's fang");
      // On mobile the item's second line has who got it, the party and the raid.
      expect(own[ITEM]).toContain('You · Trio · Tombs of Amascut: Expert Mode');
      expect(own.slice(RAID, VALUE + 1)).toEqual([
        'Tombs of Amascut: Expert Mode',
        'You',
        'Trio',
        'Split',
        '24M gp',
      ]);
      // The share cell also has the date for mobile, where the date column is hidden.
      expect(own[SHARE]).toMatch(/^8M gp.*8 Nov$/);

      // A teammate's drop: the owner's nickname, never a name from the game,
      // and the value it sold for.
      const teammate = cells(rows[1]);
      expect(teammate.slice(GOT_BY, VALUE + 1)).toEqual([
        'Nickname A',
        'Trio',
        'Split',
        '900M gpsold',
      ]);
      expect(teammate[SHARE]).toMatch(/^300M gp/);
      expect(within(rowOf(table, 1)).getByRole('img', { name: 'Note' })).toBeTruthy();

      // No party size: nothing to split by yet.
      const unknown = cells(rows[2]);
      expect(unknown[PARTY]).toBe('?');
      expect(within(rowOf(table, 2)).getByRole('button', { name: 'Set party size' })).toBeTruthy();

      // Added by hand, with the party size the owner set.
      const manual = cells(rows[3]);
      expect(manual[ITEM]).toContain('Manual');
      expect(manual[ITEM]).toContain(POSSIBLE_DUPLICATE);
      expect(manual.slice(GOT_BY, VALUE + 1)).toEqual(['Nickname B', '4', 'Split', '800M gp']);
      expect(within(rowOf(table, 3)).getByRole('button', { name: /^Delete / })).toBeTruthy();

      // Your own purple added by hand: "You" and "Manual", and it can be deleted.
      const ownManual = cells(rows[5]);
      expect(ownManual[ITEM]).toContain('Twisted bow');
      expect(ownManual[ITEM]).toContain('Manual');
      expect(ownManual[ITEM]).not.toContain(POSSIBLE_DUPLICATE);
      expect(ownManual.slice(GOT_BY, VALUE + 1)).toEqual(['You', 'Trio', 'Split', '30M gp']);
      expect(ownManual[SHARE]).toMatch(/^10M gp/);
      expect(within(rowOf(table, 5)).getByRole('button', { name: /^Delete / })).toBeTruthy();

      // FFA set on the drop: a teammate's drop counts 0.
      const ffa = cells(rows[4]);
      expect(ffa.slice(GOT_BY, MODE + 1)).toEqual(['Teammate', '4', 'FFAset']);
      expect(ffa[SHARE]).toMatch(/^0 gp/);
      expect(ffa[ITEM]).not.toContain('Manual');
      expect(within(rowOf(table, 4)).queryByRole('button', { name: /^Delete / })).toBeNull();

      // One account: no account names in the table.
      expect(within(table).queryByText('Test Main')).toBeNull();
    });

    it('explains the value, the share and the note in tooltips', async () => {
      mockRaidsApi('1');
      renderApp('/1/progress/raids');
      const table = await lootTable();
      const tooltip = async (row: number, text: string, role?: 'img') => {
        const scope = within(rowOf(table, row));
        const [target] = role ? [scope.getByRole(role, { name: text })] : scope.getAllByText(text);
        if (!target) throw new Error(`No ${text} in row ${String(row)}`);
        await userEvent.hover(target);
        const shown = (await screen.findByRole('tooltip')).textContent;
        await userEvent.unhover(target);
        await userEvent.keyboard('{Escape}');
        await waitFor(() => {
          expect(screen.queryByRole('tooltip')).toBeNull();
        });
        return shown;
      };

      // Sold for something else than the GE price: both.
      const sold = await tooltip(1, '900M gp');
      expect(sold).toContain('Sold for900,000,000 gp');
      expect(sold).toContain('GE price when it dropped1,000,000,000 gp');

      expect(await tooltip(0, '24M gp')).toBe('GE price when it dropped24,000,000 gp');
      expect(await tooltip(0, '8M gp')).toBe('8,000,000 gpSplit: 24,000,000 ÷ 3');
      expect(await tooltip(1, '300M gp')).toBe('300,000,000 gpSplit: 900,000,000 ÷ 3');
      expect(await tooltip(4, '0 gp')).toBe('0 gpFFA: a teammate’s drop counts 0');

      // A drop added by hand: where and when its price is from.
      const manual = await tooltip(3, '800M gp');
      expect(manual).toContain('GE price from another purple800,000,000 gp');
      expect(manual).toMatch(/Price seen .*12 Oct/);
      // That price is from before the drop.
      expect(manual).not.toContain(PRICE_FROM_LATER_DATE);
      // An own drop from before any price of the item: the price is newer than the drop.
      const ownManual = await tooltip(5, '30M gp');
      expect(ownManual).toContain('GE price from a loot drop30,000,000 gp');
      expect(ownManual).toContain(PRICE_FROM_LATER_DATE);
      expect(ownManual).toMatch(/Price seen .*1 Nov/);

      expect(await tooltip(1, 'Note', 'img')).toBe('Sold on day two');
    });

    it('asks for a value when a drop added by hand has no price', async () => {
      const noPrice: RaidDrop = {
        ...manualScythe,
        gePriceEach: null,
        geValue: null,
        gePriceSource: null,
        gePriceAt: null,
        value: null,
        valueUnknown: true,
        share: null,
        possibleDuplicate: false,
        duplicateOfDropId: null,
      };
      mockRaidsApi('1', {
        [SPLITS_PATH]: {
          body: {
            ...splits,
            drops: { items: [fang, bow, mask, noPrice, ffaScythe], nextCursor: null },
          },
        },
      });
      renderApp('/1/progress/raids');
      const row = rowOf(await lootTable(), 3);
      expect(cells(row)[VALUE]).toBe('Value unknownSet value');
      // In the Value column, and under the share on mobile.
      const [setValue] = within(row).getAllByRole('button', { name: 'Set value' });
      if (!setValue) throw new Error('No Set value button');
      await userEvent.click(setValue);
      const dialog = await screen.findByRole('dialog');
      expect(document.activeElement).toBe(within(dialog).getByLabelText(/^Sold for/));
      expect(
        within(dialog).getByText(/No GE price was known when you added this drop/),
      ).toBeTruthy();
    });

    it('names the account for all accounts and shows the KC split', async () => {
      mockRaidsApi('all');
      renderApp('/all/progress/raids');
      const table = await lootTable();
      await waitFor(() => {
        expect(within(table).getAllByText('Test Main')).toHaveLength(4);
      });
      expect(within(table).getAllByText('Alt')).toHaveLength(2);
      expect(await screen.findByLabelText('140: Test Main 140')).toBeTruthy();
    });

    it('loads more special loot with the cursor until there are no more', async () => {
      const fetchMock = mockRaidsApi('1');
      renderApp('/1/progress/raids');
      const table = await lootTable();
      await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
      await waitFor(() => {
        expect(tableRows(table)).toHaveLength(7);
      });
      const last = cells(tableRows(table)[6]);
      expect(last[ITEM]).toContain('Ghrazi rapier');
      expect(last.slice(GOT_BY, PARTY + 1)).toEqual(['You', 'Duo']);
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
      expect(
        calls(fetchMock)
          .filter((call) => call.path === SPLITS_PATH)
          .map((call) => call.cursor),
      ).toEqual([null, splits.drops.nextCursor]);
    });

    it('invites to raid when there is no data', async () => {
      mockRaidsApi('2', {
        '/api/v1/accounts/2/kc': { body: { bosses: [] } },
        '/api/v1/accounts/2/raids': { body: noDataFixture },
        '/api/v1/accounts/2/raids/splits': {
          body: { ...noSplitsFixture, defaults: [{ accountId: 2, mode: 'SPLIT' }] },
        },
      });
      renderApp('/2/progress/raids');
      expect(await screen.findByText(SPECIAL_LOOT_EMPTY)).toBeTruthy();
      expect((await strip()).textContent).toContain('0gpyour share · all time');
      // The default can be chosen before the first purple, and a drop can be added.
      expect(screen.getByRole('radiogroup', { name: DEFAULT_LABEL })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Add drop' })).toBeTruthy();
      // No cards: every raid is named on the dashed line.
      expect(
        await screen.findByText(
          (_, element) =>
            element?.tagName === 'P' &&
            element.textContent.startsWith(
              `No completions yet: ${RAIDS.map((raid) => raid.name).join(' · ')}.`,
            ),
        ),
      ).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Tombs of Amascut' })).toBeNull();
    });
  });

  describe('a possible duplicate', () => {
    it('warns on the manual drop and jumps to the detected one', async () => {
      mockRaidsApi('1');
      renderApp('/1/progress/raids');
      const table = await lootTable();
      const warning = within(rowOf(table, 3)).getByRole('button', { name: POSSIBLE_DUPLICATE });
      await userEvent.hover(warning);
      expect((await screen.findByRole('tooltip')).textContent).toBe(POSSIBLE_DUPLICATE_DETAIL);
      await userEvent.click(warning);
      const other = rowOf(table, 4);
      expect(other.id).toBe(dropRowId(ffaScythe.dropId));
      await waitFor(() => {
        expect(document.activeElement).toBe(other);
      });
      expect(other.className).toContain('bg-accent-wash');
      // Nothing is merged or hidden.
      expect(tableRows(table)).toHaveLength(6);
      expect(screen.queryByText(DROP_FURTHER_DOWN)).toBeNull();
    });

    it('jumps again when the warning is clicked again', async () => {
      mockRaidsApi('1');
      renderApp('/1/progress/raids');
      const table = await lootTable();
      const warning = within(rowOf(table, 3)).getByRole('button', { name: POSSIBLE_DUPLICATE });
      const other = rowOf(table, 4);
      await userEvent.click(warning);
      await waitFor(() => {
        expect(document.activeElement).toBe(other);
      });
      // Back on the manual drop, while the other row is still highlighted.
      warning.focus();
      expect(other.className).toContain('bg-accent-wash');
      await userEvent.click(warning);
      await waitFor(() => {
        expect(document.activeElement).toBe(other);
      });
    });

    it('shows the error, not "further down", when the next page fails', async () => {
      mockRaidsApi('1', {
        [SPLITS_PATH]: (url) =>
          cursorOf(url)
            ? failure()
            : json({
                ...splits,
                drops: { items: [fang, bow, mask, manualScythe], nextCursor: 'next' },
              }),
      });
      renderApp('/1/progress/raids');
      const table = await lootTable();
      await userEvent.click(
        within(rowOf(table, 3)).getByRole('button', { name: POSSIBLE_DUPLICATE }),
      );
      expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
      expect(screen.queryByText(DROP_FURTHER_DOWN)).toBeNull();
    });

    it('fetches the next page when the other drop is not loaded yet', async () => {
      mockRaidsApi('1', {
        [SPLITS_PATH]: (url) =>
          json(
            cursorOf(url)
              ? { ...splits, drops: { items: [ffaScythe], nextCursor: null } }
              : {
                  ...splits,
                  drops: { items: [fang, bow, mask, manualScythe], nextCursor: 'next' },
                },
          ),
      });
      renderApp('/1/progress/raids');
      const table = await lootTable();
      await userEvent.click(
        within(rowOf(table, 3)).getByRole('button', { name: POSSIBLE_DUPLICATE }),
      );
      await waitFor(() => {
        expect(document.activeElement?.id).toBe(dropRowId(ffaScythe.dropId));
      });
    });

    it('stops after five more pages and says the drop is further down', async () => {
      let page = 0;
      const fetchMock = mockRaidsApi('1', {
        [SPLITS_PATH]: (url) => {
          if (!cursorOf(url)) {
            return json({
              ...splits,
              drops: { items: [fang, bow, mask, manualScythe], nextCursor: 'page-1' },
            });
          }
          page++;
          return json({
            ...splits,
            drops: { items: [extraDrop(page)], nextCursor: `page-${String(page + 1)}` },
          });
        },
      });
      renderApp('/1/progress/raids');
      const table = await lootTable();
      await userEvent.click(
        within(rowOf(table, 3)).getByRole('button', { name: POSSIBLE_DUPLICATE }),
      );
      expect(await screen.findByText(DROP_FURTHER_DOWN)).toBeTruthy();
      const cursors = calls(fetchMock)
        .filter((call) => call.path === SPLITS_PATH)
        .map((call) => call.cursor);
      expect(cursors).toEqual([null, 'page-1', 'page-2', 'page-3', 'page-4', 'page-5']);
      expect(cursors).toHaveLength(SHOW_DROP_MAX_PAGES + 1);
      expect(tableRows(table)).toHaveLength(4 + SHOW_DROP_MAX_PAGES);
      // The owner can go on by hand.
      expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
    });
  });

  describe('editing a purple', () => {
    const BOW_PATH = `/api/v1/accounts/1/raids/drops/${bow.dropId}`;

    it('opens with the choices on the drop', async () => {
      mockRaidsApi('1');
      renderApp('/1/progress/raids');
      const dialog = await openEdit(1);
      expect(within(dialog).getByRole('heading', { name: 'Edit drop' })).toBeTruthy();
      expect(dialog.textContent).toContain('Twisted bow · ');
      expect(dialog.textContent).toContain('Chambers of Xeric: Challenge Mode · ');
      const soldFor = within(dialog).getByLabelText<HTMLInputElement>(/^Sold for/);
      expect(soldFor.value).toBe('900,000,000');
      expect(soldFor.placeholder).toBe('1,000,000,000');
      expect(
        within(dialog).getByText(
          'Leave empty to use the GE price when it dropped (1B gp). You can type 850m, 1,2b or 850.000.000.',
        ),
      ).toBeTruthy();
      const mode = within(dialog).getByRole('radiogroup', { name: 'Mode' });
      expect(
        within(mode).getByRole('radio', { name: 'Account default (Split)' }).dataset.state,
      ).toBe('on');
      // The plugin's size is the placeholder: empty means "use it".
      const partySize = within(dialog).getByLabelText<HTMLInputElement>('Party size');
      expect(partySize.value).toBe('');
      expect(partySize.placeholder).toBe('3');
      expect(
        within(dialog).getByText('Leave empty to use the size from the plugin (3).'),
      ).toBeTruthy();
      expect(within(dialog).getByLabelText<HTMLInputElement>(/^Nickname/).value).toBe('Nickname A');
      expect(within(dialog).getByLabelText<HTMLInputElement>(/^Note/).value).toBe(
        'Sold on day two',
      );
      // Nickname and note are the owner's own notes.
      expect(within(dialog).getAllByText(OWN_NOTE_HELP)).toHaveLength(2);
      // No GE tax option.
      expect(dialog.textContent).not.toMatch(/tax/i);
    });

    it('has no nickname for your own drop', async () => {
      mockRaidsApi('1');
      renderApp('/1/progress/raids');
      const dialog = await openEdit(0);
      expect(within(dialog).queryByLabelText(/^Nickname/)).toBeNull();
      expect(within(dialog).getByLabelText(/^Note/)).toBeTruthy();
    });

    it('closes Edit drop and Add drop with Escape and returns focus to the opener', async () => {
      mockRaidsApi('1');
      renderApp('/1/progress/raids');
      const row = rowOf(await lootTable(), 0);
      const edit = within(row).getByRole('button', { name: /^Edit / });
      await userEvent.click(edit);
      const dialog = await screen.findByRole('dialog', { name: 'Edit drop' });
      // A sheet from the bottom on mobile (the tests get the mobile layout).
      expect(dialog.className).toContain('max-desk:bottom-[var(--keyboard-inset,0px)]');
      expect(dialog.className).toContain('max-desk:rounded-t-[20px]');
      // On PC a dialog starts in its first field.
      expect(document.activeElement).toBe(within(dialog).getByLabelText(/^Sold for/));
      await userEvent.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(document.activeElement).toBe(edit);

      const add = screen.getByRole('button', { name: 'Add drop' });
      await userEvent.click(add);
      await screen.findByRole('dialog', { name: ADD_DROP_TITLE });
      await userEvent.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(document.activeElement).toBe(add);
    });

    it('sends only what changed and fetches the tracker again', async () => {
      const fetchMock = mockRaidsApi('1', { [`PATCH ${BOW_PATH}`]: { body: { drop: bow } } });
      renderApp('/1/progress/raids');
      const dialog = await openEdit(1);
      const soldFor = within(dialog).getByLabelText(/^Sold for/);
      await userEvent.clear(soldFor);
      await userEvent.type(soldFor, '850m');
      await userEvent.click(within(dialog).getByRole('radio', { name: 'FFA' }));
      await userEvent.type(within(dialog).getByLabelText('Party size'), '4');
      await userEvent.clear(within(dialog).getByLabelText(/^Note/));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(writes(fetchMock)).toEqual([
        {
          method: 'PATCH',
          path: BOW_PATH,
          cursor: null,
          body: { ownValue: 850_000_000, mode: 'FFA', partySize: 4, note: null },
        },
      ]);
      expect(calls(fetchMock).filter((call) => call.path === SPLITS_PATH)).toHaveLength(2);
      // Focus is back on the pencil.
      const table = await lootTable();
      await waitFor(() => {
        expect(document.activeElement).toBe(
          within(rowOf(table, 1)).getByRole('button', { name: 'Edit Twisted bow' }),
        );
      });
    });

    it('clears "Sold for" back to the GE price', async () => {
      const fetchMock = mockRaidsApi('1', { [`PATCH ${BOW_PATH}`]: { body: { drop: bow } } });
      renderApp('/1/progress/raids');
      const dialog = await openEdit(1);
      await userEvent.clear(within(dialog).getByLabelText(/^Sold for/));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(writes(fetchMock).map((call) => call.body)).toEqual([{ ownValue: null }]);
      });
    });

    it('reads a decimal comma with a suffix', async () => {
      const fetchMock = mockRaidsApi('1', { [`PATCH ${BOW_PATH}`]: { body: { drop: bow } } });
      renderApp('/1/progress/raids');
      const dialog = await openEdit(1);
      const soldFor = within(dialog).getByLabelText(/^Sold for/);
      await userEvent.clear(soldFor);
      await userEvent.type(soldFor, '1,2b');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(writes(fetchMock).map((call) => call.body)).toEqual([{ ownValue: 1_200_000_000 }]);
      });
    });

    it('reads points as thousands separators without a suffix', async () => {
      const fetchMock = mockRaidsApi('1', { [`PATCH ${BOW_PATH}`]: { body: { drop: bow } } });
      renderApp('/1/progress/raids');
      const dialog = await openEdit(1);
      const soldFor = within(dialog).getByLabelText(/^Sold for/);
      await userEvent.clear(soldFor);
      await userEvent.type(soldFor, '850.000.000');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(writes(fetchMock).map((call) => call.body)).toEqual([{ ownValue: 850_000_000 }]);
      });
    });

    it('rejects three digits after the separator before a suffix', async () => {
      const fetchMock = mockRaidsApi('1');
      renderApp('/1/progress/raids');
      const dialog = await openEdit(1);
      const soldFor = within(dialog).getByLabelText(/^Sold for/);
      await userEvent.clear(soldFor);
      await userEvent.type(soldFor, '1,200k');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(within(dialog).getByText(SOLD_FOR_INVALID)).toBeTruthy();
      expect(writes(fetchMock)).toEqual([]);
    });

    it('rejects a comma that is neither a decimal nor a thousands separator', async () => {
      const fetchMock = mockRaidsApi('1');
      renderApp('/1/progress/raids');
      const dialog = await openEdit(1);
      const soldFor = within(dialog).getByLabelText(/^Sold for/);
      await userEvent.clear(soldFor);
      await userEvent.type(soldFor, '1,2');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(within(dialog).getByText(SOLD_FOR_INVALID)).toBeTruthy();
      expect(writes(fetchMock)).toEqual([]);
    });

    it('rejects a party size that is not a number instead of clearing it', async () => {
      const fetchMock = mockRaidsApi('1');
      renderApp('/1/progress/raids');
      // The manual drop has a party size the owner set (4).
      const dialog = await openEdit(3);
      const partySize = within(dialog).getByLabelText<HTMLInputElement>('Party size');
      expect(partySize.value).toBe('4');
      await userEvent.type(partySize, 'x');
      expect(partySize.value).toBe('4x');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(within(dialog).getByText(PARTY_SIZE_INVALID)).toBeTruthy();
      expect(writes(fetchMock)).toEqual([]);
    });

    it('closes without a request when nothing changed', async () => {
      const fetchMock = mockRaidsApi('1');
      renderApp('/1/progress/raids');
      const dialog = await openEdit(1);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(writes(fetchMock)).toEqual([]);
    });

    it('shows a message under the field for a value it cannot read', async () => {
      const fetchMock = mockRaidsApi('1');
      renderApp('/1/progress/raids');
      const dialog = await openEdit(1);
      const soldFor = within(dialog).getByLabelText(/^Sold for/);
      await userEvent.clear(soldFor);
      await userEvent.type(soldFor, 'lots');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(within(dialog).getByText(SOLD_FOR_INVALID)).toBeTruthy();
      expect(soldFor.getAttribute('aria-invalid')).toBe('true');
      expect(writes(fetchMock)).toEqual([]);
      // Typing again clears the message.
      await userEvent.type(soldFor, '{backspace}');
      expect(within(dialog).queryByText(SOLD_FOR_INVALID)).toBeNull();
    });

    it('shows the server’s message under its field and stays open', async () => {
      mockRaidsApi('1', {
        [`PATCH ${BOW_PATH}`]: {
          status: 400,
          body: {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid request',
              details: [{ path: 'body.nickname', message: 'Must be at most 30 characters' }],
            },
          },
        },
      });
      renderApp('/1/progress/raids');
      const dialog = await openEdit(1);
      await userEvent.type(within(dialog).getByLabelText(/^Nickname/), ' B');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByText('Must be at most 30 characters')).toBeTruthy();
      expect(within(dialog).queryByText(SAVE_FAILED)).toBeNull();
    });

    it('says so when saving failed', async () => {
      mockRaidsApi('1', { [`PATCH ${BOW_PATH}`]: failure });
      renderApp('/1/progress/raids');
      const dialog = await openEdit(1);
      await userEvent.type(within(dialog).getByLabelText(/^Note/), '!');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByText(SAVE_FAILED)).toBeTruthy();
    });

    it('starts in the party size from "Set party size"', async () => {
      const path = `/api/v1/accounts/1/raids/drops/${mask.dropId}`;
      const fetchMock = mockRaidsApi('1', { [`PATCH ${path}`]: { body: { drop: mask } } });
      renderApp('/1/progress/raids');
      const table = await lootTable();
      await userEvent.click(
        within(rowOf(table, 2)).getByRole('button', { name: 'Set party size' }),
      );
      const dialog = await screen.findByRole('dialog');
      const partySize = within(dialog).getByLabelText('Party size');
      expect(document.activeElement).toBe(partySize);
      await userEvent.type(partySize, '2');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        // The drop ID has a dot (a purple only seen in the chest).
        expect(writes(fetchMock)).toEqual([
          { method: 'PATCH', path, cursor: null, body: { partySize: 2 } },
        ]);
      });
    });

    it('changes a drop on its own account under all accounts', async () => {
      const path = `/api/v1/accounts/2/raids/drops/${ffaScythe.dropId}`;
      const fetchMock = mockRaidsApi('all', { [`PATCH ${path}`]: { body: { drop: ffaScythe } } });
      renderApp('/all/progress/raids');
      const dialog = await openEdit(4);
      // The default of the drop's own account.
      await userEvent.click(within(dialog).getByRole('radio', { name: 'Account default (FFA)' }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(writes(fetchMock)).toEqual([
          { method: 'PATCH', path, cursor: null, body: { mode: null } },
        ]);
      });
    });
  });

  describe('a drop added by hand', () => {
    // 23:30 UTC on Sunday 15 November: already Monday the 16th, 00:30, on the
    // server (Europe/Oslo), and still the 15th in the browser (Los Angeles).
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-15T23:30:00.000Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('is added with the raid, item, time and the optional fields', async () => {
      const fetchMock = mockRaidsApi('1', {
        'POST /api/v1/accounts/1/raids/drops': { status: 201, body: manualDropFixture },
      });
      renderApp('/1/progress/raids');
      await lootTable();
      const addButton = screen.getByRole('button', { name: 'Add drop' });
      await userEvent.click(addButton);
      const dialog = await screen.findByRole('dialog', { name: ADD_DROP_TITLE });
      expect(within(dialog).getByText(ADD_DROP_HELP)).toBeTruthy();
      // A teammate's drop unless You is chosen.
      const gotBy = within(dialog).getByRole('radiogroup', { name: GOT_BY_LABEL });
      expect(
        within(gotBy).getByRole('radio', { name: 'Teammate' }).getAttribute('aria-checked'),
      ).toBe('true');
      // The item list belongs to the raid.
      expect(within(dialog).getByRole('combobox', { name: 'Item' })).toHaveProperty(
        'disabled',
        true,
      );
      await choose(dialog, 'Raid', 'Theatre of Blood: Hard Mode');
      await choose(dialog, 'Item', 'Ghrazi rapier');
      // Now in the server's zone (Europe/Oslo in the health fixture), in 24-hour time.
      const date = within(dialog).getByRole('button', { name: /^Date: / });
      expect(date.textContent).toBe('Mon 16 Nov 2026');
      const time = within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Time' });
      expect(time.value).toBe('00:30');
      expect(dialog.querySelector('input[type="datetime-local"]')).toBeNull();
      await userEvent.click(date);
      await userEvent.click(await screen.findByRole('button', { name: 'Yesterday' }));
      expect(date.textContent).toBe('Sun 15 Nov 2026');
      await userEvent.clear(time);
      await userEvent.type(time, '22:40');
      await userEvent.type(within(dialog).getByLabelText(/^Party size/), '4');
      await userEvent.type(within(dialog).getByLabelText(/^Nickname/), 'Nickname B');
      await userEvent.type(within(dialog).getByLabelText(/^Sold for/), '31.5m');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add drop' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(writes(fetchMock)).toEqual([
        {
          method: 'POST',
          path: '/api/v1/accounts/1/raids/drops',
          cursor: null,
          body: {
            raid: 'Theatre of Blood: Hard Mode',
            itemId: 22324,
            // 22:40 on 15 November in Oslo, whatever the browser's zone is.
            occurredAt: '2026-11-15T21:40:00.000Z',
            partySize: 4,
            recipient: 'TEAMMATE',
            ownValue: 31_500_000,
            nickname: 'Nickname B',
          },
        },
      ]);
      expect(calls(fetchMock).filter((call) => call.path === SPLITS_PATH)).toHaveLength(2);
      await waitFor(() => {
        expect(document.activeElement).toBe(addButton);
      });
    });

    it('adds an own purple without a nickname', async () => {
      const fetchMock = mockRaidsApi('1', {
        'POST /api/v1/accounts/1/raids/drops': { status: 201, body: { drop: ownManualBow } },
      });
      renderApp('/1/progress/raids');
      await lootTable();
      await userEvent.click(screen.getByRole('button', { name: 'Add drop' }));
      const dialog = await screen.findByRole('dialog', { name: ADD_DROP_TITLE });
      // Typed while Teammate was chosen: not sent for an own drop.
      await userEvent.type(within(dialog).getByLabelText(/^Nickname/), 'Nickname B');
      await userEvent.click(within(dialog).getByRole('radio', { name: 'You' }));
      expect(within(dialog).queryByLabelText(/^Nickname/)).toBeNull();
      await choose(dialog, 'Raid', 'Chambers of Xeric');
      await choose(dialog, 'Item', 'Twisted bow');
      await userEvent.type(within(dialog).getByLabelText(/^Party size/), '3');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add drop' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(writes(fetchMock).map((call) => call.body)).toEqual([
        {
          raid: 'Chambers of Xeric',
          itemId: 20997,
          occurredAt: '2026-11-15T23:30:00.000Z',
          recipient: 'SELF',
          partySize: 3,
        },
      ]);
    });

    it('asks for the raid and the item, and shows the server’s message for the time', async () => {
      const fetchMock = mockRaidsApi('1', {
        'POST /api/v1/accounts/1/raids/drops': {
          status: 400,
          body: {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid request',
              details: [{ path: 'body.occurredAt', message: 'Must not be in the future' }],
            },
          },
        },
      });
      renderApp('/1/progress/raids');
      await lootTable();
      await userEvent.click(screen.getByRole('button', { name: 'Add drop' }));
      const dialog = await screen.findByRole('dialog', { name: ADD_DROP_TITLE });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add drop' }));
      expect(within(dialog).getByText('Choose a raid.')).toBeTruthy();
      expect(within(dialog).getByText('Choose an item.')).toBeTruthy();
      expect(writes(fetchMock)).toEqual([]);

      await choose(dialog, 'Raid', 'Chambers of Xeric');
      await choose(dialog, 'Item', 'Twisted bow');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add drop' }));
      expect(await within(dialog).findByText('Must not be in the future')).toBeTruthy();
    });

    it('asks for a 24-hour time that is not in the future', async () => {
      const fetchMock = mockRaidsApi('1');
      renderApp('/1/progress/raids');
      await lootTable();
      await userEvent.click(screen.getByRole('button', { name: 'Add drop' }));
      const dialog = await screen.findByRole('dialog', { name: ADD_DROP_TITLE });
      await choose(dialog, 'Raid', 'Chambers of Xeric');
      await choose(dialog, 'Item', 'Twisted bow');
      const time = within(dialog).getByRole('textbox', { name: 'Time' });
      await userEvent.clear(time);
      await userEvent.type(time, '9pm');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add drop' }));
      expect(within(dialog).getByText(TIME_INVALID)).toBeTruthy();
      // One minute from now, on the server's clock.
      await userEvent.clear(time);
      await userEvent.type(time, '00:31');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add drop' }));
      expect(within(dialog).getByText(TIME_IN_FUTURE)).toBeTruthy();
      expect(writes(fetchMock)).toEqual([]);

      // Tomorrow can't be picked: today is the server's date.
      await userEvent.click(within(dialog).getByRole('button', { name: /^Date: / }));
      const grid = await screen.findByRole('grid');
      const dayButton = (number: string) =>
        within(grid)
          .getAllByRole('gridcell')
          .find((cell) => cell.textContent === number && !('outside' in cell.dataset))
          ?.querySelector('button');
      expect(dayButton('16')?.disabled).toBe(false);
      expect(dayButton('17')?.disabled).toBe(true);
    });

    it('is deleted after a confirmation', async () => {
      const path = `/api/v1/accounts/2/raids/drops/${manualScythe.dropId}`;
      const fetchMock = mockRaidsApi('1', { [`DELETE ${path}`]: { status: 204, body: null } });
      renderApp('/1/progress/raids');
      const table = await lootTable();
      await userEvent.click(within(rowOf(table, 3)).getByRole('button', { name: /^Delete / }));
      const dialog = await screen.findByRole('alertdialog', { name: 'Delete this drop?' });
      expect(writes(fetchMock)).toEqual([]);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
      await waitFor(() => {
        expect(screen.queryByRole('alertdialog')).toBeNull();
      });
      expect(writes(fetchMock)).toEqual([
        { method: 'DELETE', path, cursor: null, body: undefined },
      ]);
      expect(calls(fetchMock).filter((call) => call.path === SPLITS_PATH)).toHaveLength(2);
    });

    it('stays when deleting failed', async () => {
      const path = `/api/v1/accounts/2/raids/drops/${manualScythe.dropId}`;
      mockRaidsApi('1', { [`DELETE ${path}`]: failure });
      renderApp('/1/progress/raids');
      const table = await lootTable();
      await userEvent.click(within(rowOf(table, 3)).getByRole('button', { name: /^Delete / }));
      const dialog = await screen.findByRole('alertdialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
      expect(await within(dialog).findByText("Couldn't delete the drop. Try again.")).toBeTruthy();
    });
  });

  describe('errors', () => {
    it('shows Retry on the cards when kc fails, and keeps the rest', async () => {
      let fail = true;
      mockRaidsApi('1', {
        '/api/v1/accounts/1/kc': () => (fail ? failure() : json(kcFixture)),
      });
      renderApp('/1/progress/raids');
      await lootTable();
      // One Retry where the cards go.
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
      });
      expect((await strip()).textContent).toContain('518Mgp');
      fail = false;
      const [retry] = screen.getAllByRole('button', { name: 'Retry' });
      if (!retry) throw new Error('No Retry button');
      await userEvent.click(retry);
      const toa = await card('Tombs of Amascut');
      expect(await within(toa).findByText('Expert Mode')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });

    it('shows Retry on the cards when raids fails', async () => {
      mockRaidsApi('1', { '/api/v1/accounts/1/raids': failure });
      renderApp('/1/progress/raids');
      await lootTable();
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
      });
      expect(screen.queryByRole('heading', { name: 'Tombs of Amascut' })).toBeNull();
    });

    it('keeps the raid cards when the tracker fails, with Retry in the number row and the table', async () => {
      let fail = true;
      mockRaidsApi('1', { [SPLITS_PATH]: () => (fail ? failure() : json(splits)) });
      renderApp('/1/progress/raids');
      // The number row and the table. The cards don't need the tracker.
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2);
      });
      const toa = await card('Tombs of Amascut');
      expect(await within(toa).findByText('Expert Mode')).toBeTruthy();
      expect(toa.textContent).toContain('9.8M gploot');
      expect(toa.textContent).toContain('24.5M gpspecial loot');
      expect(toa.textContent).toContain('–your share');
      expect(within(await strip()).getByRole('button', { name: 'Retry' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Add drop' })).toBeNull();
      // Without the tracker, completions and loot decide: CoX has loot, ToB only a share.
      expect(await card('Chambers of Xeric')).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Theatre of Blood' })).toBeNull();
      expect(dashedLine()?.textContent).toMatch(
        /^No completions yet: Theatre of Blood · The Fractured Archive\./,
      );

      fail = false;
      await userEvent.click(within(await strip()).getByRole('button', { name: 'Retry' }));
      await lootTable();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      await waitFor(() => {
        expect(toa.textContent).toContain('8M gpyour share');
      });
      // The share gives ToB its card, and it leaves the dashed line.
      expect(await card('Theatre of Blood')).toBeTruthy();
      expect(dashedLine()?.textContent).toMatch(/^No completions yet: The Fractured Archive\./);
    });

    it('keeps special loot and completions for all accounts when the tracker fails', async () => {
      let fail = true;
      mockRaidsApi('all', {
        '/api/v1/accounts/all/raids/splits': () => (fail ? failure() : json(splits)),
      });
      renderApp('/all/progress/raids');
      const row = await strip();
      await waitFor(() => {
        expect(row.textContent).toContain('140completionscompletions · 1 raid');
      });
      // Only what comes from `kc` and `raids`: ToA's recorded 24.5M (the 30M
      // CoX purple added by hand is in the tracker).
      expect(row.textContent).toContain('24.5Mgpspecial loot');
      expect(row.textContent).toContain('–your share · all time');
      expect(within(row).queryByRole('alert')).toBeNull();

      fail = false;
      await userEvent.click(within(row).getByRole('button', { name: 'Retry' }));
      await waitFor(() => {
        expect(row.textContent).toContain('518Mgpyour share · all time');
      });
    });

    it('shows the whole row as an error when the tracker and the cards both fail', async () => {
      mockRaidsApi('all', {
        '/api/v1/accounts/all/raids/splits': failure,
        '/api/v1/accounts/all/kc': failure,
      });
      renderApp('/all/progress/raids');
      const row = await strip();
      expect(await within(row).findByRole('alert')).toBeTruthy();
      expect(row.textContent).not.toContain('special loot');
    });

    it('shows the raids with completions or loot while the tracker is still loading', async () => {
      mockRaidsApi('1', { [SPLITS_PATH]: () => new Promise<Response>(() => undefined) });
      renderApp('/1/progress/raids');
      const toa = await card('Tombs of Amascut');
      expect(await within(toa).findByText('Expert Mode')).toBeTruthy();
      expect(toa.textContent).toContain('–your share');
      // CoX has loot, so it shows too.
      expect(await card('Chambers of Xeric')).toBeTruthy();
      // ToB (only a share) and TFA (nothing) wait: neither a card nor on the dashed line.
      expect(screen.queryByRole('heading', { name: 'Theatre of Blood' })).toBeNull();
      expect(dashedLine()).toBeUndefined();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });
  });
});

describe('Raids on mobile', () => {
  async function lootList(): Promise<HTMLElement> {
    return screen.findByRole('list', { name: 'Special loot' });
  }

  function rowOfDrop(drop: RaidDrop): HTMLElement {
    const row = document.getElementById(dropRowId(drop.dropId));
    if (!row) throw new Error(`No row for ${drop.name}`);
    return row;
  }

  it('lists each purple with who got it, the party, your share and its value', async () => {
    mockRaidsApi('1');
    renderApp('/1/progress/raids');
    const list = await lootList();
    expect(screen.queryByRole('table', { name: 'Special loot' })).toBeNull();
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    // Own fang, split in a trio: 8M of 24M.
    const fangRow = rowOfDrop(fang);
    expect(fangRow.textContent).toContain('You · Trio');
    expect(fangRow.textContent).toContain('8M');
    expect(fangRow.textContent).toContain('of 24M');
    // Sold for 900M: the value says so.
    expect(rowOfDrop(bow).textContent).toContain('of 900M sold');
    // No party size under split: a button instead of the share.
    expect(within(rowOfDrop(mask)).getByRole('button', { name: 'Set party size' })).toBeTruthy();
    expect(screen.getByText(TAP_TO_EDIT)).toBeTruthy();
    // No bins on the rows: a drop added by hand is deleted from the sheet.
    expect(screen.queryByRole('button', { name: /^Delete / })).toBeNull();
  });

  it('opens the sheet from anywhere on the row, and at the field a button asks for', async () => {
    mockRaidsApi('1');
    renderApp('/1/progress/raids');
    await lootList();
    await userEvent.click(within(rowOfDrop(bow)).getByText('of 900M sold'));
    const dialog = await screen.findByRole('dialog', { name: 'Edit drop' });
    // A sheet starts on its title, not in a field: the on-screen keyboard
    // stays closed until a field is tapped.
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: 'Edit drop' }));
    // A teammate's drop seen by the plugin: nothing to delete.
    expect(within(dialog).queryByRole('button', { name: 'Delete drop' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    await userEvent.click(within(rowOfDrop(mask)).getByRole('button', { name: 'Set party size' }));
    const again = await screen.findByRole('dialog', { name: 'Edit drop' });
    // The exception: the sheet was opened to fill in this field.
    expect(document.activeElement).toBe(within(again).getByLabelText(/^Party size/));
  });

  it('starts the Add drop sheet on its title, and returns focus to the button', async () => {
    mockRaidsApi('1');
    renderApp('/1/progress/raids');
    await lootList();
    const add = screen.getByRole('button', { name: 'Add drop' });
    await userEvent.click(add);
    const dialog = await screen.findByRole('dialog', { name: 'Add a drop' });
    expect(document.activeElement).toBe(
      within(dialog).getByRole('heading', { name: 'Add a drop' }),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(add);
  });

  it('deletes a drop added by hand from the sheet, after a confirmation', async () => {
    const path = `/api/v1/accounts/2/raids/drops/${manualScythe.dropId}`;
    const fetchMock = mockRaidsApi('1', { [`DELETE ${path}`]: { status: 204, body: null } });
    renderApp('/1/progress/raids');
    await lootList();
    await userEvent.click(within(rowOfDrop(manualScythe)).getByRole('button', { name: /^Edit / }));
    const sheet = await screen.findByRole('dialog', { name: 'Edit drop' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Delete drop' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete this drop?' });
    expect(screen.queryByRole('dialog', { name: 'Edit drop' })).toBeNull();
    expect(writes(fetchMock)).toEqual([]);

    // Cancel: back to the drop's row.
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(rowOfDrop(manualScythe));
    });

    // Delete: on to the next row.
    await userEvent.click(within(rowOfDrop(manualScythe)).getByRole('button', { name: /^Edit / }));
    await userEvent.click(
      within(await screen.findByRole('dialog', { name: 'Edit drop' })).getByRole('button', {
        name: 'Delete drop',
      }),
    );
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(writes(fetchMock)).toEqual([{ method: 'DELETE', path, cursor: null, body: undefined }]);
    await waitFor(() => {
      expect(document.activeElement).toBe(rowOfDrop(ffaScythe));
    });
  });

  it('goes to the Special loot heading after deleting the last drop in the list', async () => {
    const path = `/api/v1/accounts/1/raids/drops/${ownManualBow.dropId}`;
    mockRaidsApi('1', {
      [`DELETE ${path}`]: { status: 204, body: null },
      // One page, so the manual bow is the last row.
      [SPLITS_PATH]: () => json({ ...splits, drops: { ...splits.drops, nextCursor: null } }),
    });
    renderApp('/1/progress/raids');
    await lootList();
    await userEvent.click(within(rowOfDrop(ownManualBow)).getByRole('button', { name: /^Edit / }));
    await userEvent.click(
      within(await screen.findByRole('dialog', { name: 'Edit drop' })).getByRole('button', {
        name: 'Delete drop',
      }),
    );
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: /^Special loot/ }));
    });
  });

  it('has no Delete drop in the dialog on PC, where the row has a bin', async () => {
    stubDesktop();
    mockRaidsApi('1');
    renderApp('/1/progress/raids');
    const table = await lootTable();
    await userEvent.click(within(rowOf(table, 3)).getByRole('button', { name: /^Edit / }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit drop' });
    expect(within(dialog).queryByRole('button', { name: 'Delete drop' })).toBeNull();
  });
});
