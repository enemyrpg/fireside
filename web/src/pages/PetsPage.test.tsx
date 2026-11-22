import type { CollectionLogStatusResponse } from '@fireside/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import clogFailed from '../../../shared/fixtures/api/collection-log-response/valid/failed-with-old-data-and-unknown-item.json';
import clogSynced from '../../../shared/fixtures/api/collection-log-response/valid/synced.json';
import statusNeverSynced from '../../../shared/fixtures/api/collection-log-status-response/valid/never-synced.json';
import clogStarted from '../../../shared/fixtures/api/collection-log-sync-response/valid/started.json';
import petsAll from '../../../shared/fixtures/api/pets-response/valid/all.json';
import petsOne from '../../../shared/fixtures/api/pets-response/valid/one-account.json';
import petsWithoutKc from '../../../shared/fixtures/api/pets-response/valid/source-without-kc.json';
import { findMainNav, mockApi, renderApp, type MockAnswer } from '@/test/render-app';

// The accounts fixture has 1 ("Test Main") and 2 ("Alt"). `one-account` is
// account 1's five pets: Vorki (chat, 1,204 KC, 2 Nov), Beaver (chat,
// unconfirmed, 9.84M Woodcutting XP, 20 Oct), Baby mole (collection log, seen
// by a sync on 1 Sep) and Pet snakeling and Phoenix (no time). `all` adds
// account 2's pets. By default no account has a collection log source.

/** The status endpoint's answer for a collection log fixture: the same without the tabs. */
function statusOf(log: object, accountId = 1): CollectionLogStatusResponse {
  const status = { ...log, accountId } as CollectionLogStatusResponse & { tabs?: unknown };
  delete status.tabs;
  return status;
}

const SYNCED = statusOf(clogSynced);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

/** Account 1's pets, also as the answer for `all`, so the page exists. */
function withPets(answers: Record<string, MockAnswer> = {}) {
  return mockApi({
    '/api/v1/accounts/all/pets': { body: petsAll },
    '/api/v1/accounts/1/pets': { body: petsOne },
    ...answers,
  });
}

function calls(fetchMock: ReturnType<typeof mockApi>, path: string, method = 'GET'): number {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(url, 'http://localhost').pathname === path && (init?.method ?? 'GET') === method;
  }).length;
}

async function cards(): Promise<HTMLElement[]> {
  return within(await screen.findByRole('list', { name: 'Pets' })).getAllByRole('listitem');
}

/** The pet's name: the heading of its card. */
const nameOf = (entry: HTMLElement) => within(entry).getByRole('heading').textContent;

async function names(): Promise<string[]> {
  return (await cards()).map(nameOf);
}

async function card(name: string): Promise<HTMLElement> {
  const found = (await cards()).find((entry) => nameOf(entry) === name);
  if (!found) throw new Error(`No card for ${name}`);
  return found;
}

describe('Pets', () => {
  beforeEach(() => {
    // Only Date is faked, so Testing Library's timers keep working.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the count and the pets newest first, pets without a date last', async () => {
    withPets();
    renderApp('/1/collections/pets');
    expect(await names()).toEqual(['Vorki', 'Beaver', 'Baby mole', 'Pet snakeling', 'Phoenix']);
    expect(screen.getByText('5').parentElement?.textContent).toBe('5pets');
    expect(screen.getByRole('radio', { name: 'Newest' }).getAttribute('aria-checked')).toBe('true');
  });

  it('sorts A–Z from the toggle and from the URL', async () => {
    withPets();
    const { router } = renderApp('/1/collections/pets');
    await cards();
    await userEvent.click(screen.getByRole('radio', { name: 'A–Z' }));
    expect(await names()).toEqual(['Baby mole', 'Beaver', 'Pet snakeling', 'Phoenix', 'Vorki']);
    expect(router.state.location.search).toBe('?sort=az');

    await userEvent.click(screen.getByRole('radio', { name: 'Newest' }));
    expect((await names())[0]).toBe('Vorki');
    expect(router.state.location.search).toBe('');
  });

  it('opens A–Z from a link', async () => {
    withPets();
    renderApp('/1/collections/pets?sort=az');
    expect((await names())[0]).toBe('Baby mole');
    expect(screen.getByRole('radio', { name: 'A–Z' }).getAttribute('aria-checked')).toBe('true');
  });

  it('shows the source with KC or XP, and the date with the year, when known', async () => {
    withPets();
    renderApp('/1/collections/pets');
    expect((await card('Vorki')).textContent).toBe('VoVorkiVorkath · 1,204 KCMon 2 Nov 2026');
    expect((await card('Beaver')).textContent).toContain('Woodcutting · 9.84M XPTue 20 Oct 2026');
    // The time of the sync that found it, not of the drop.
    expect((await card('Baby mole')).textContent).toBe('BaBaby mole~Tue 1 Sept 2026');
    expect((await card('Phoenix')).textContent).toBe('PhPhoenixDate unknown');
  });

  it('shows a source without the KC when the KC is not known', async () => {
    withPets({ '/api/v1/accounts/1/pets': { body: petsWithoutKc } });
    renderApp('/1/collections/pets');
    expect((await card('Vorki')).textContent).toBe('VoVorkiVorkathMon 2 Nov 2026');
    expect(screen.getByText('1').parentElement?.textContent).toBe('1pet');
  });

  it('marks only pets the collection log has not confirmed', async () => {
    withPets();
    renderApp('/1/collections/pets');
    const list = await screen.findByRole('list', { name: 'Pets' });
    expect(within(list).getAllByText('Unconfirmed')).toHaveLength(1);
    expect(within(await card('Beaver')).getByText('Unconfirmed')).toBeTruthy();
    // One account: no account on the cards.
    expect(within(list).queryByText('Test Main')).toBeNull();
  });

  it('shows every account’s pets together for All accounts, each with its account', async () => {
    withPets();
    renderApp('/all/collections/pets');
    const all = await cards();
    expect(all).toHaveLength(petsAll.pets.length);
    // The count over its noun, in the row of numbers at the top.
    expect(screen.getByText(String(petsAll.pets.length)).parentElement?.textContent).toBe(
      `${String(petsAll.pets.length)}pets`,
    );
    expect(within(await card('Vorki')).getByText('Test Main')).toBeTruthy();
    expect(within(await card('Tiny tempor')).getByText('Alt')).toBeTruthy();
    // The help card and the sync belong to one account.
    expect(screen.queryByText('Missing a pet?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  it('says how to bring in a missing pet, with Sync now, when the account has a source', async () => {
    const fetchMock = withPets({
      '/api/v1/accounts/1/collection-log/status': { body: SYNCED },
      'POST /api/v1/accounts/1/collection-log/sync': { status: 202, body: clogStarted },
    });
    renderApp('/1/collections/pets');
    expect(await screen.findByRole('heading', { name: 'Missing a pet?' })).toBeTruthy();
    expect(
      screen.getByText(
        'Pets come from your collection log. In the game, open the Collection Log and click the RuneProfile button at the top left of the window. Then press Sync now.',
      ),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => {
      expect(calls(fetchMock, '/api/v1/accounts/1/collection-log/sync', 'POST')).toBe(1);
    });
  });

  it('points to Settings, without Sync now, when the account has no source', async () => {
    withPets();
    renderApp('/1/collections/pets');
    const help = (await screen.findByRole('heading', { name: 'Missing a pet?' })).closest(
      'section',
    );
    if (help === null) throw new Error('No help card');
    expect(help.textContent).toContain(
      'Pets you get while the plugin is running show up here. To bring in pets you already have, turn on collection log sync for this account in Settings.',
    );
    expect(within(help).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe(
      '/settings/accounts',
    );
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  it('says so under the help text when the last sync did not work', async () => {
    withPets({ '/api/v1/accounts/1/collection-log/status': { body: statusOf(clogFailed) } });
    renderApp('/1/collections/pets');
    await screen.findByRole('heading', { name: 'Missing a pet?' });
    const failed = statusOf(clogFailed).sync?.status;
    expect(failed).not.toBe('OK');
    // The pets stay, and the card has one line about the sync.
    expect(await names()).toHaveLength(5);
    const help = screen.getByRole('heading', { name: 'Missing a pet?' }).closest('section');
    expect(help?.querySelector('.text-down')).not.toBeNull();
  });

  it('says that pets show up here when the account has none, with the help text', async () => {
    withPets({
      '/api/v1/accounts/1/pets': { body: { pets: [] } },
      '/api/v1/accounts/1/collection-log/status': { body: statusNeverSynced },
    });
    renderApp('/1/collections/pets');
    expect(await screen.findByText('Pets you unlock show up here.')).toBeTruthy();
    expect(screen.getByText('0').parentElement?.textContent).toBe('0pets');
    expect(screen.getByRole('heading', { name: 'Missing a pet?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
  });

  it('reads the pets again after a sync that worked', async () => {
    let status = SYNCED;
    let pets: unknown = { pets: petsOne.pets.slice(0, 1) };
    const fetchMock = withPets({
      '/api/v1/accounts/1/collection-log/status': () => json(status),
      '/api/v1/accounts/1/pets': () => json(pets),
    });
    const { queryClient } = renderApp('/1/collections/pets');
    expect(await names()).toEqual(['Vorki']);
    expect(calls(fetchMock, '/api/v1/accounts/1/pets')).toBe(1);

    // A sync finds the rest of the pets.
    pets = petsOne;
    status = {
      ...SYNCED,
      updatedAt: '2026-11-11T11:59:00.000Z',
      sync: SYNCED.sync && { ...SYNCED.sync, lastSuccessAt: '2026-11-11T11:59:00.000Z' },
    };
    await queryClient.invalidateQueries({ queryKey: ['collection-log-status', 1] });
    await waitFor(async () => {
      expect(await names()).toHaveLength(5);
    });
    expect(calls(fetchMock, '/api/v1/accounts/1/pets')).toBe(2);
  });

  it('has no way to add or remove a pet', async () => {
    const fetchMock = withPets({ '/api/v1/accounts/1/collection-log/status': { body: SYNCED } });
    renderApp('/1/collections/pets');
    await cards();
    // The page itself, below the shell's header (title, account switcher, profile).
    const main = screen.getByRole('main').lastElementChild as HTMLElement;
    // The only button on the page is the sync.
    expect(
      within(main)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Sync now']);
    expect(within(main).queryByRole('textbox')).toBeNull();
    const methods = fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET');
    expect(new Set(methods)).toEqual(new Set(['GET']));
  });

  it('offers Retry when the pets cannot be loaded', async () => {
    let fail = true;
    withPets({
      '/api/v1/accounts/1/pets': () =>
        fail
          ? new Response(
              JSON.stringify({ error: { code: 'INTERNAL', message: 'x', details: [] } }),
              { status: 500, headers: { 'content-type': 'application/json' } },
            )
          : json(petsOne),
    });
    renderApp('/1/collections/pets');
    const retry = await screen.findByRole('button', { name: 'Retry' }, { timeout: 5000 });
    fail = false;
    await userEvent.click(retry);
    expect(await names()).toHaveLength(5);
  });
});

describe('Pets in the menu', () => {
  it('makes Collections open Pets when an account has a pet', async () => {
    withPets();
    renderApp('/1');
    const nav = await findMainNav();
    const link = await within(nav).findByRole('link', { name: 'Collections' });
    expect(link.getAttribute('href')).toBe('/1/collections/pets');
  });

  it('exists without pets when an account has a collection log', async () => {
    mockApi({
      '/api/v1/accounts/2/collection-log/status': { body: statusOf(clogSynced, 2) },
      '/api/v1/accounts/1/pets': { body: { pets: [] } },
    });
    renderApp('/1/collections/pets');
    expect(await screen.findByText('Pets you unlock show up here.')).toBeTruthy();
    const nav = await findMainNav();
    const link = await within(nav).findByRole('link', { name: 'Collections' });
    expect(link.getAttribute('aria-current')).toBe('page');
    // Collection log and Pets: both sub-tabs.
    const tabs = screen.getByRole('navigation', { name: 'Collections views' });
    expect(within(tabs).getByRole('link', { name: 'Pets' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('is not found, with no menu item, without a pet or a collection log', async () => {
    mockApi();
    renderApp('/all/collections/pets');
    expect(await screen.findByText("This page doesn't exist.")).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Collections' })).toBeNull();
  });

  it('opens Collections on Collection log, also when the pets answer comes first', async () => {
    let answerLog: (() => void) | undefined;
    withPets({
      '/api/v1/accounts/2/collection-log/status': () =>
        new Promise<Response>((resolve) => {
          answerLog = () => {
            resolve(json(statusOf(clogSynced, 2)));
          };
        }),
    });
    const { router } = renderApp('/1/collections');
    // Pets exists, but Collection log comes first and is still unknown: wait.
    expect(await screen.findByRole('heading', { level: 1, name: 'Collections' })).toBeTruthy();
    const nav = await findMainNav();
    expect(
      (await within(nav).findByRole('link', { name: 'Collections' })).getAttribute('aria-current'),
    ).toBe('page');
    expect(router.state.location.pathname).toBe('/1/collections');
    await waitFor(() => {
      expect(answerLog).toBeDefined();
    });
    answerLog?.();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/1/collections/log');
    });
  });

  it('opens after the first pet, also with "no pets" still in the cache', async () => {
    let pets: unknown = { pets: [] };
    mockApi({
      '/api/v1/accounts/all/pets': () => json(pets),
      '/api/v1/accounts/1/pets': () => json(petsOne),
    });
    const { router } = renderApp('/settings');
    const nav = await findMainNav();
    await within(nav).findByRole('link', { name: 'Progress' });
    expect(within(nav).queryByRole('link', { name: 'Collections' })).toBeNull();

    // A pet drops; the cached "no pets" is still fresh.
    pets = petsAll;
    await router.navigate('/1/collections/pets');
    expect(await names()).toHaveLength(5);
    expect(await within(nav).findByRole('link', { name: 'Collections' })).toBeTruthy();
  });
});
