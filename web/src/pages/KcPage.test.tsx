import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import dropsFixture from '../../../shared/fixtures/api/drops-response/valid/page.json';
import kcFixture from '../../../shared/fixtures/api/kc-response/valid/bosses.json';
import lootFixture from '../../../shared/fixtures/api/loot-response/valid/by-source.json';
import { mockApi as mockAnyApi, renderApp, stubDesktop, type MockAnswer } from '@/test/render-app';
import { KC_EMPTY } from './KcPage';

// The KC fixture has a raid mode (Tombs of Amascut: Expert Mode), Vorkath
// (412: account 1 has 400 and account 2 has 12, best 1:14.4) and Zulrah (5,
// account 2 only, no time, nothing in the last 30 days).

/**
 * Boss KC stands under Loot on Progress → Loot & KC, so the loot calls of
 * every scope get an answer too.
 */
function mockApi(answers: Record<string, MockAnswer>) {
  const loot: Record<string, MockAnswer> = {};
  for (const scope of ['1', '2', 'all']) {
    loot[`/api/v1/accounts/${scope}/loot`] = { body: { ...lootFixture, from: null, to: null } };
    loot[`/api/v1/accounts/${scope}/loot/drops`] = { body: dropsFixture };
  }
  return mockAnyApi({ ...loot, ...answers });
}

async function kcTable() {
  return screen.findByRole('table', { name: 'Boss kill count' });
}

function rowTexts(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    );
}

describe('Boss KC', () => {
  // The table is the PC layout; mobile has a list (tested below).
  beforeEach(() => {
    stubDesktop();
  });

  it('lists bosses only, with KC, the last 30 days, best time and last kill', async () => {
    mockApi({ '/api/v1/accounts/1/kc': { body: kcFixture } });
    renderApp('/1/progress/loot');
    const table = await kcTable();
    const rows = rowTexts(table);
    // Raid modes belong in the Raids tab.
    expect(rows).toHaveLength(2);
    expect(rows[0]?.[0]).toContain('Vorkath');
    expect(rows[1]?.[0]).toContain('Zulrah');
    expect(screen.queryByText(/Tombs of Amascut/)).toBeNull();
    expect(rows[0]?.slice(1, 4)).toEqual(['412', '+37', '1:14.4']);
    expect(rows[1]?.slice(1, 4)).toEqual(['5', '–', '–']);
    // Raid modes are left out; the card says where they are, and links there.
    // All time: the period toggle above changes loot only.
    expect(screen.getByText('2 bosses · all time · raids have their own tab')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Raids →' }).getAttribute('href')).toBe(
      '/1/progress/raids',
    );
    // One account: no split per account.
    expect(within(table).queryByLabelText(/Test Main/)).toBeNull();
  });

  it('shows the split per account for all accounts', async () => {
    mockApi({ '/api/v1/accounts/all/kc': { body: kcFixture } });
    renderApp('/all/progress/loot');
    await kcTable();
    const vorkath = await screen.findByLabelText('412: Test Main 400, Alt 12');
    await userEvent.hover(vorkath);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Test Main');
    expect(tooltip.textContent).toContain('400');
    expect(screen.getByLabelText('5: Alt 5')).toBeTruthy();
  });

  it('invites to play when there are no boss kills, also with raids only', async () => {
    const raidsOnly = { bosses: kcFixture.bosses.filter((boss) => boss.category === 'raid') };
    mockApi({ '/api/v1/accounts/2/kc': { body: raidsOnly } });
    renderApp('/2/progress/loot');
    expect(await screen.findByText(KC_EMPTY)).toBeTruthy();
    expect(screen.queryByText(/bosses?$/)).toBeNull();
  });

  it('shows an error with Retry', async () => {
    let fail = true;
    mockApi({
      '/api/v1/accounts/1/kc': () =>
        new Response(
          JSON.stringify(
            fail ? { error: { code: 'INTERNAL_ERROR', message: 'Boom', details: [] } } : kcFixture,
          ),
          { status: fail ? 500 : 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    renderApp('/1/progress/loot');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Boom')).toBeNull();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(async () => {
      expect(await kcTable()).toBeTruthy();
    });
  });

  it('never shows the KC for all accounts under one account', async () => {
    // Replaced by the promise's resolve below.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockApi({
      '/api/v1/accounts/all/kc': { body: kcFixture },
      '/api/v1/accounts/1/kc': async () => {
        await held;
        return new Response(JSON.stringify(kcFixture), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const { router } = renderApp('/all/progress/loot');
    expect(await screen.findByLabelText('412: Test Main 400, Alt 12')).toBeTruthy();

    await router.navigate('/1/progress/loot');
    // The summed KC is gone while account 1 loads: a skeleton, not the old table.
    await waitFor(() => {
      expect(screen.queryByRole('table', { name: 'Boss kill count' })).toBeNull();
    });

    release();
    expect(await kcTable()).toBeTruthy();
    expect(screen.queryByLabelText('412: Test Main 400, Alt 12')).toBeNull();
  });
});

describe('Boss KC on mobile', () => {
  it('lists each boss with the last 30 days and best time under the name', async () => {
    mockApi({ '/api/v1/accounts/1/kc': { body: kcFixture } });
    renderApp('/1/progress/loot');
    const list = await screen.findByRole('list', { name: 'Boss kill count' });
    expect(screen.queryByRole('table', { name: 'Boss kill count' })).toBeNull();
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('+37 in 30 days · best 1:14.4');
    expect(items[0]?.textContent).toContain('412');
    // Nothing in the last 30 days and no time: no line under the name.
    expect(items[1]?.textContent).not.toContain('30 days');
    expect(screen.getByText('2 bosses · all time')).toBeTruthy();
  });

  it('shows the split per account for all accounts', async () => {
    mockApi({ '/api/v1/accounts/all/kc': { body: kcFixture } });
    renderApp('/all/progress/loot');
    expect(await screen.findByLabelText('412: Test Main 400, Alt 12')).toBeTruthy();
  });
});
