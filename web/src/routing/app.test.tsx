import { BRANDING } from '@fireside/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import forbiddenFixture from '../../../shared/fixtures/api/error-response/valid/forbidden.json';
import { DESK_QUERY } from '@/hooks/useIsDesktop';
import { LAST_ACCOUNT_KEY } from '@/lib/accounts';
import { mockApi, renderApp, stubDesktop } from '@/test/render-app';
import { THEME_STORAGE_KEY } from '@/theme/themes';
import { UNKNOWN_ACCOUNT_MESSAGE } from './AccountRoute';

// The accounts fixture has accounts 1 ("Test Main") and 2 ("Alt").

async function expectDisclaimer() {
  expect(await screen.findByText(BRANDING.jagexDisclaimer)).toBeTruthy();
}

describe('routes and accounts', () => {
  it('sends / to /all without a remembered account', async () => {
    mockApi();
    const { router } = renderApp('/');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/all');
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(await screen.findByText('Test Main')).toBeTruthy();
    await expectDisclaimer();
  });

  it('sends / to the remembered account when it still exists', async () => {
    localStorage.setItem(LAST_ACCOUNT_KEY, '2');
    mockApi();
    const { router } = renderApp('/');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/2');
    });
  });

  it('sends / to /all when the remembered account is gone, without a toast', async () => {
    localStorage.setItem(LAST_ACCOUNT_KEY, '99');
    mockApi();
    const { router } = renderApp('/');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/all');
    });
    expect(screen.queryByText(UNKNOWN_ACCOUNT_MESSAGE)).toBeNull();
  });

  it('remembers a valid account and shows only that account', async () => {
    mockApi();
    renderApp('/2');
    // One account: its own online line, no chips for the other accounts.
    expect(await screen.findByText(/^Offline · last played/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Accounts' })).toBeNull();
    await waitFor(() => {
      expect(localStorage.getItem(LAST_ACCOUNT_KEY)).toBe('2');
    });
  });

  it.each(['/999', '/abc', '/0'])('shows a toast and goes to /all for %s', async (path) => {
    mockApi();
    const { router } = renderApp(path);
    expect(await screen.findByText(UNKNOWN_ACCOUNT_MESSAGE)).toBeTruthy();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/all');
    });
    // Stored by an effect after the redirect renders, so wait for it too.
    await waitFor(() => {
      expect(localStorage.getItem(LAST_ACCOUNT_KEY)).toBe('all');
    });
  });

  it('shows a full-page 404 for unknown pages, with the disclaimer', async () => {
    mockApi();
    renderApp('/all/does-not-exist');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Home' }).getAttribute('href')).toBe('/');
    await expectDisclaimer();
  });

  it('welcomes a new instance without accounts', async () => {
    mockApi({ '/api/v1/accounts': { body: { accounts: [] } } });
    renderApp('/all');
    expect(await screen.findByText(`Welcome to ${BRANDING.displayName}`)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create a key →' }).getAttribute('href')).toBe(
      '/settings/keys',
    );
  });
});

/** The top bar on PC (`<header>`, the page's banner). */
async function topBar() {
  return screen.findByRole('banner');
}

/** Link texts of a navigation, and the one marked as the current page. */
function linksOf(nav: HTMLElement) {
  const links = within(nav).getAllByRole('link');
  return {
    names: links.map((link) => link.textContent),
    current: links
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.textContent),
  };
}

describe('navigation', () => {
  it('lists only destinations that exist, in the top bar and the tab bar, without More', async () => {
    mockApi();
    renderApp('/all');
    const bar = within(await topBar()).getByRole('navigation', { name: 'Main' });
    // No bank data and no collection log, pets or quests: no Bank or Collections.
    expect(linksOf(bar)).toEqual({ names: ['Home', 'Activity', 'Progress'], current: ['Home'] });
    const [, tabBar] = screen.getAllByRole('navigation', { name: 'Main' });
    if (!tabBar) throw new Error('No tab bar');
    expect(linksOf(tabBar)).toEqual({
      names: ['Home', 'Activity', 'Progress'],
      current: ['Home'],
    });
    expect(screen.queryByRole('link', { name: 'More' })).toBeNull();
    expect(screen.queryByText('Search')).toBeNull();
  });

  it('marks the destination and the sub-tab, and links to each sub-tab', async () => {
    mockApi({
      '/api/v1/accounts/all/kc': { body: { bosses: [] } },
      '/api/v1/accounts/all/raids': { body: { raids: [] } },
    });
    renderApp('/all/progress/raids');
    expect(await screen.findByRole('heading', { level: 1, name: 'Progress' })).toBeTruthy();
    const bar = within(await topBar()).getByRole('navigation', { name: 'Main' });
    expect(linksOf(bar).current).toEqual(['Progress']);
    const tabs = screen.getByRole('navigation', { name: 'Progress views' });
    expect(linksOf(tabs)).toEqual({ names: ['XP', 'Loot & KC', 'Raids'], current: ['Raids'] });
    expect(within(tabs).getByRole('link', { name: 'Loot & KC' }).getAttribute('href')).toBe(
      '/all/progress/loot',
    );
  });

  it('keeps the account in menu links and links a destination to its first sub-tab', async () => {
    mockApi();
    renderApp('/2');
    const bar = within(await topBar()).getByRole('navigation', { name: 'Main' });
    expect(within(bar).getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/2');
    expect(within(bar).getByRole('link', { name: 'Activity' }).getAttribute('href')).toBe(
      '/2/activity/sessions',
    );
    expect(within(bar).getByRole('link', { name: 'Progress' }).getAttribute('href')).toBe(
      '/2/progress/xp',
    );
  });

  it('goes through the top bar in order with Tab on PC', async () => {
    stubDesktop();
    mockApi();
    renderApp('/all');
    const bar = await topBar();
    await within(bar).findByRole('button', { name: /^Choose account/ });
    const user = userEvent.setup();
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      await user.tab();
      const focused = document.activeElement;
      order.push(focused?.getAttribute('aria-label') ?? focused?.textContent ?? '');
    }
    expect(order).toEqual([
      BRANDING.displayName,
      'Home',
      'Activity',
      'Progress',
      'Choose account: All accounts',
      'Settings and profile',
    ]);
    // Once in the document: not again in the page header.
    expect(screen.getAllByRole('button', { name: /^Choose account/ })).toHaveLength(1);
  });

  it('keeps focus on the account switcher when the window crosses the PC breakpoint', async () => {
    let desktop = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return query === DESK_QUERY && desktop;
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }));
    mockApi();
    renderApp('/all');
    const bar = await topBar();
    (await within(bar).findByRole('button', { name: /^Choose account/ })).focus();

    act(() => {
      desktop = false;
      for (const listener of listeners) listener();
    });
    const switcher = screen.getByRole('button', { name: /^Choose account/ });
    expect(bar.contains(switcher)).toBe(false);
    expect(document.activeElement).toBe(switcher);
  });

  it('has the account switcher and profile icon in the page header on mobile', async () => {
    mockApi();
    renderApp('/all');
    const bar = await topBar();
    await screen.findByRole('button', { name: /^Choose account/ });
    expect(within(bar).queryByRole('button', { name: /^Choose account/ })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Settings and profile' })).toHaveLength(1);
  });

  it('shows the server version and versions in the footer', async () => {
    mockApi();
    renderApp('/all');
    expect(await screen.findByText(/Server 0\.1\.0 · contract 1\.7\.0/)).toBeTruthy();
  });
});

describe('scroll and focus on navigation', () => {
  it('starts another page at the top and focuses its heading', async () => {
    mockApi();
    const { router } = renderApp('/all');
    const bar = within(await topBar()).getByRole('navigation', { name: 'Main' });
    window.scrollTo(0, 400);
    await userEvent.setup().click(within(bar).getByRole('link', { name: 'Activity' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/all/activity/sessions');
    });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Activity' });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(window.scrollY).toBe(0);
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('starts at the top on a page visited before, when a link opens it', async () => {
    mockApi();
    const { router } = renderApp('/all');
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    window.scrollTo(0, 400);
    await router.navigate('/all/activity/sessions');
    await screen.findByRole('heading', { level: 1, name: 'Activity' });
    await router.navigate('/all');
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    await waitFor(() => {
      expect(window.scrollY).toBe(0);
    });
  });

  it.each([false, true])(
    'keeps the place when only the query changes (replace: %s)',
    async (replace) => {
      mockApi();
      const { router } = renderApp('/all/progress/xp');
      const heading = await screen.findByRole('heading', { level: 1, name: 'Progress' });
      window.scrollTo(0, 600);
      await router.navigate('/all/progress/xp?period=month', { replace });
      await waitFor(() => {
        expect(router.state.location.search).toBe('?period=month');
      });
      await router.navigate('/all/progress/xp?period=year&skill=MAGIC', { replace });
      await waitFor(() => {
        expect(router.state.location.search).toBe('?period=year&skill=MAGIC');
      });
      expect(window.scrollY).toBe(600);
      expect(document.activeElement).not.toBe(heading);
    },
  );

  it('returns to the place on Back, without moving focus', async () => {
    mockApi();
    const { router } = renderApp('/all');
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    window.scrollTo(0, 400);
    await router.navigate('/all/activity/sessions');
    await screen.findByRole('heading', { level: 1, name: 'Activity' });
    await waitFor(() => {
      expect(window.scrollY).toBe(0);
    });
    window.scrollTo(0, 150);
    // The push above focused the heading (the same element on every page).
    (document.activeElement as HTMLElement | null)?.blur();
    await router.navigate(-1);
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    await waitFor(() => {
      expect(window.scrollY).toBe(400);
    });
    expect(document.activeElement).toBe(document.body);
    // Forward: Sessions where it was left.
    await router.navigate(1);
    await screen.findByRole('heading', { level: 1, name: 'Activity' });
    await waitFor(() => {
      expect(window.scrollY).toBe(150);
    });
  });

  it('keeps the place on Back across query changes of the same page', async () => {
    mockApi();
    const { router } = renderApp('/all/progress/xp');
    await screen.findByRole('heading', { level: 1, name: 'Progress' });
    window.scrollTo(0, 300);
    await router.navigate('/all/progress/xp?period=month');
    window.scrollTo(0, 700);
    await router.navigate(-1);
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    expect(window.scrollY).toBe(700);
  });

  it("doesn't move focus when an old URL opened directly redirects", async () => {
    mockApi();
    const { router } = renderApp('/all/xp');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/all/progress/xp');
    });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Progress' });
    expect(document.activeElement).not.toBe(heading);
  });
});

describe('old routes', () => {
  it.each([
    ['/all/activity/sessions', '/all/activity/sessions'],
    ['/2/activity/screentime?range=7d', '/2/activity/screentime?range=7d'],
    ['/all/activity/weekly', '/all/activity/weekly'],
    ['/1/activity/weekly/2026-W45', '/1/activity/weekly/2026-W45'],
    ['/all/progress/xp?period=month&skill=MAGIC', '/all/progress/xp?period=month&skill=MAGIC'],
    ['/all/progress/loot?range=7d&min=10m', '/all/progress/loot?range=7d&min=10m'],
    ['/all/progress/loot', '/all/progress/loot'],
    ['/all/progress/raids#top', '/all/progress/raids#top'],
    ['/all/collections/log?tab=bosses&page=zulrah', '/all/collections/log?tab=bosses&page=zulrah'],
    ['/all/collections/pets?sort=az', '/all/collections/pets?sort=az'],
    ['/2/collections/quests?q=dragon', '/2/collections/quests?q=dragon'],
    ['/all/progress', '/all/progress/xp'],
    ['/2/activity?x=1', '/2/activity/sessions?x=1'],
  ])('sends %s to %s', async (from, to) => {
    mockApi();
    const { router } = renderApp(from);
    await waitFor(() => {
      const { pathname, search, hash } = router.state.location;
      expect(`${pathname}${search}${hash}`).toBe(to);
    });
  });

  it('replaces the old URL, so Back goes to the page before it', async () => {
    mockApi();
    const { router } = renderApp('/all');
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    await router.navigate('/all/progress/loot?range=7d');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/all/progress/loot');
    });
    expect(router.state.location.search).toBe('?range=7d');
    await router.navigate(-1);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/all');
    });
  });

  it('gives the 404 for a destination none of whose pages exists', async () => {
    mockApi();
    renderApp('/all/collections');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeTruthy();
  });
});

describe('settings', () => {
  it.each([
    ['2', '/2/activity/sessions'],
    ['99', '/all/activity/sessions'],
  ])('links the menus to the remembered account %s only if it exists', async (last, href) => {
    localStorage.setItem(LAST_ACCOUNT_KEY, last);
    mockApi();
    renderApp('/settings');
    const bar = within(await topBar()).getByRole('navigation', { name: 'Main' });
    await waitFor(() => {
      expect(within(bar).getByRole('link', { name: 'Activity' }).getAttribute('href')).toBe(href);
    });
  });

  it('opens from the profile icon, which is marked there', async () => {
    mockApi();
    const { router } = renderApp('/all');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Settings and profile' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings');
    });
    expect(
      screen.getByRole('link', { name: 'Settings and profile' }).getAttribute('aria-current'),
    ).toBe('page');
    // No destination is marked on Settings.
    const bar = within(await topBar()).getByRole('navigation', { name: 'Main' });
    expect(linksOf(bar).current).toEqual([]);
  });

  it('has no account switcher, shows the time zone and the disclaimer', async () => {
    mockApi();
    renderApp('/settings');
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(await screen.findByText('Europe/Oslo')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Choose account/ })).toBeNull();
    await expectDisclaimer();
  });

  it('switches theme on <html> and remembers it', async () => {
    mockApi();
    renderApp('/settings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /Light/ }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(screen.getByRole('radio', { name: /Light/ }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('server errors', () => {
  it('replaces the app with an explanation on 403, keeping the disclaimer', async () => {
    mockApi({ '/api/v1/accounts': { status: 403, body: forbiddenFixture } });
    renderApp('/all');
    expect(
      await screen.findByText('The dashboard only works on this PC (localhost) for now.'),
    ).toBeTruthy();
    await expectDisclaimer();
  });

  it('shows a retry instead of an endless skeleton when health fails', async () => {
    mockApi({
      '/api/v1/health': {
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: [] } },
      },
    });
    renderApp('/settings');
    expect(await screen.findByText("Couldn't load this.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText("Can't reach the server. Retrying…")).toBeNull();
  });

  it('shows a banner while the server is unreachable', async () => {
    mockApi({
      '/api/v1/health': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    renderApp('/settings');
    expect(await screen.findByText("Can't reach the server. Retrying…")).toBeTruthy();
  });
});
