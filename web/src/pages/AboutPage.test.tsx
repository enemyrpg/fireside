import { BRANDING } from '@fireside/shared';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import loggedIn from '../../../shared/fixtures/api/auth-me-response/valid/logged-in.json';
import loggedOut from '../../../shared/fixtures/api/auth-me-response/valid/logged-out.json';
import { mockApi, renderApp } from '@/test/render-app';

// The instance text on `/about` (linked from the login page), readable without
// logging in, as plain text only.

const TEXT =
  'Run by Ada. Contact: ada@example.invalid\n\nWhat is stored:\nyour username\n<b>not bold</b> **not bold** <script>alert(1)</script>';

/** Opens `path` in the browser's own address bar, where the auth gate looks. */
function open(path: string) {
  window.history.pushState({}, '', path);
  return renderApp('/');
}

afterEach(() => {
  window.history.pushState({}, '', '/');
  vi.restoreAllMocks();
});

describe('/about', () => {
  it('shows the instance text logged out, as plain paragraphs, with no app around it', async () => {
    mockApi({
      '/api/v1/auth/me': { body: loggedOut },
      '/api/v1/about': { body: { text: TEXT, isDefault: false } },
    });
    open('/about');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'About this instance' }),
    ).toBeTruthy();
    const first = await screen.findByText('Run by Ada. Contact: ada@example.invalid');
    expect(first.tagName).toBe('P');
    const second = screen.getByText(/What is stored:/);
    expect(second.tagName).toBe('P');
    // A single line break stays a line break inside the paragraph.
    expect(second.textContent).toBe(
      'What is stored:\nyour username\n<b>not bold</b> **not bold** <script>alert(1)</script>',
    );
    expect(second.querySelector('b, strong, script')).toBeNull();
    expect(document.querySelector('main script, main b')).toBeNull();
    expect(screen.getByRole('link', { name: 'Log in' }).getAttribute('href')).toBe('/');
    expect(screen.queryByRole('heading', { name: 'Log in' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: /main/i })).toBeNull();
    expect(screen.getByText(BRANDING.jagexDisclaimer)).toBeTruthy();
  });

  it('shows the same page logged in, with a way back, and no user data', async () => {
    mockApi({ '/api/v1/auth/me': { body: loggedIn } });
    open('/about/');
    expect(await screen.findByText(/This Fireside instance is run by \[your name\]/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the dashboard' }).getAttribute('href')).toBe(
      '/',
    );
    expect(screen.queryByText(loggedIn.user.username)).toBeNull();
  });

  it('works in local mode', async () => {
    mockApi();
    open('/about');
    expect(await screen.findByRole('heading', { name: 'About this instance' })).toBeTruthy();
  });
});

describe('the login page', () => {
  it('links to /about without showing the instance text', async () => {
    const fetchMock = mockApi({
      '/api/v1/auth/me': { body: loggedOut },
      '/api/v1/about': { body: { text: TEXT, isDefault: false } },
    });
    renderApp('/all');
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'About this instance and privacy' }).getAttribute('href'),
    ).toBe('/about');
    expect(screen.queryByText(/Run by Ada/)).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/about')).toBe(false);
  });
});

describe('footer', () => {
  it('links to /about on every page', async () => {
    mockApi();
    renderApp('/all');
    const footer = await screen.findByRole('contentinfo');
    expect(within(footer).getByRole('link', { name: 'About' }).getAttribute('href')).toBe('/about');
  });
});
