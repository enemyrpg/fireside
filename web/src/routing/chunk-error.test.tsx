import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { reloadPage } from '@/lib/reload';
import { mockApi, renderApp } from '@/test/render-app';

// A page whose code is gone, as in a tab opened before a release: the XP
// page's module never loads. The Bank page's module is held back to see when
// it is asked for.

const bank = vi.hoisted(() => ({ requested: false }));

vi.mock('@/lib/reload', () => ({ reloadPage: vi.fn() }));
vi.mock('@/pages/XpPage', () => {
  throw new TypeError('Failed to fetch dynamically imported module');
});
vi.mock('@/pages/BankPage', () => {
  bank.requested = true;
  return new Promise(() => undefined);
});

/** The server now serves another build than the one running. */
const newBuild = {
  '/': () =>
    new Response(
      '<!doctype html><html><head><script type="module" src="/assets/index-new.js"></script></head><body></body></html>',
      { headers: { 'content-type': 'text/html' } },
    ),
};

describe('a page whose code cannot be loaded', () => {
  it('says a new version is available, and reloads only when asked', async () => {
    const user = userEvent.setup();
    mockApi(newBuild);
    const { router } = renderApp('/1');
    expect(await screen.findByRole('heading', { name: /^This week$/ })).toBeTruthy();

    await act(() => router.navigate('/1/progress/xp'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'A new version is available' }),
    ).toBeTruthy();
    expect(screen.getByText('Reload to get it.')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(reloadPage).not.toHaveBeenCalled();

    // Back to a page that loads, then the missing one again: the message
    // again, never a reload by itself (no loop).
    await act(() => router.navigate('/1'));
    expect(await screen.findByRole('heading', { name: /^This week$/ })).toBeTruthy();
    await act(() => router.navigate('/1/progress/xp'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'A new version is available' }),
    ).toBeTruthy();
    expect(reloadPage).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('says the page could not be loaded when the build is the same or unknown', async () => {
    // No answer for `/`: the server can't tell which build it serves.
    mockApi();
    renderApp('/1/progress/xp');
    expect(
      await screen.findByRole('heading', { level: 1, name: "Couldn't load this page" }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(reloadPage).not.toHaveBeenCalled();
  });
});

describe('a page behind a data gate', () => {
  it('starts loading its code while the gate still waits for its data', async () => {
    mockApi({
      // The gate's question is never answered.
      '/api/v1/accounts/all/bank/summary': () => new Promise<Response>(() => undefined),
    });
    expect(bank.requested).toBe(false);
    renderApp('/1/bank');
    await vi.waitFor(() => {
      expect(bank.requested).toBe(true);
    });
    expect(screen.queryByTestId('page-skeleton')).toBeNull();
  });
});
