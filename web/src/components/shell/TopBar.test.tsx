import type { AccountsResponse } from '@fireside/shared';
import { BRANDING } from '@fireside/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DESTINATIONS } from '@/pages/registry';
import { findMainNav, mockApi, renderApp, stubDesktop, stubWide } from '@/test/render-app';
import { json } from '@/test/sessions';

// The PC top bar is compact at 1100 px and narrower (not `wide:`), so it fits on
// one row on a phone in landscape. See "Navigation" in docs/design.md. Whether
// it really fits is a layout question jsdom cannot answer; this checks what is
// shown and what screen readers get.

const ACCOUNTS: AccountsResponse = {
  accounts: [
    {
      id: 1,
      displayName: 'Test Main',
      accountType: 'IRONMAN',
      firstSeenAt: '2026-11-01T18:00:00.000Z',
      lastSeenAt: '2026-11-10T12:00:00.000Z',
      totalLevel: 1850,
      totalXp: 123456789,
      latestSession: { endedAt: '2026-11-10T12:00:00.000Z', endReason: 'logout' },
    },
  ],
};

async function renderTopBar() {
  mockApi({
    '/api/v1/accounts': () => json(ACCOUNTS),
    '/api/v1/accounts/1/sessions': () => json({ items: [], nextCursor: null }),
  });
  renderApp('/1/activity/sessions');
  const banner = await screen.findByRole('banner');
  const switcher = await within(banner).findByRole('button', { name: /^Choose account/ });
  return { banner, switcher };
}

describe('TopBar', () => {
  it('is compact below the wide breakpoint: logo only, account name without type', async () => {
    stubDesktop();
    const { banner, switcher } = await renderTopBar();

    // The logo stays the link to Home, with the product name as its accessible name.
    const home = within(banner).getByRole('link', { name: BRANDING.displayName });
    expect(home.getAttribute('href')).toBe('/1');
    expect(within(home).getByText(BRANDING.displayName).classList.contains('sr-only')).toBe(true);

    expect(switcher.textContent).toContain('Test Main');
    expect(switcher.textContent).not.toContain('Ironman');
    // The accessible name keeps the type, as on a phone, where it is hidden too.
    expect(within(banner).getByRole('button', { name: 'Choose account: Test Main Ironman' })).toBe(
      switcher,
    );
  });

  it('shows the product name and the account type from the wide breakpoint', async () => {
    stubWide();
    const { banner, switcher } = await renderTopBar();

    const home = within(banner).getByRole('link', { name: BRANDING.displayName });
    expect(within(home).getByText(BRANDING.displayName).classList.contains('sr-only')).toBe(false);
    expect(switcher.textContent).toContain('Ironman');
    expect(within(banner).getByRole('button', { name: 'Choose account: Test Main Ironman' })).toBe(
      switcher,
    );
  });

  it('names each destination once, although a bold copy reserves its width', async () => {
    stubDesktop();
    await renderTopBar();
    const nav = await findMainNav();

    const links = within(nav).getAllByRole('link');
    expect(links.some((link) => link.getAttribute('aria-current') === 'page')).toBe(true);
    // Destinations without data (Collections, Bank) are left out of this account's nav.
    const labels = DESTINATIONS.map((destination) => destination.label).filter((label) =>
      links.some((link) => link.textContent === label + label),
    );
    expect(labels).toEqual(expect.arrayContaining(['Home', 'Activity']));
    expect(labels).toHaveLength(links.length);
    for (const label of labels) {
      // Only the visible label counts; the bold copy is hidden from screen readers.
      const link = within(nav).getByRole('link', { name: label });
      const hidden = link.querySelectorAll('[aria-hidden="true"]');
      expect(hidden).toHaveLength(1);
      expect(hidden[0]?.textContent).toBe(label);
      expect(hidden[0]?.classList.contains('invisible')).toBe(true);
      expect(hidden[0]?.classList.contains('font-semibold')).toBe(true);
    }
  });
});
