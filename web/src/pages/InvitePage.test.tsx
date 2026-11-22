import { BRANDING } from '@fireside/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import loggedOut from '../../../shared/fixtures/api/auth-me-response/valid/logged-out.json';
import { linkNavigation } from '@/lib/invites';
import { mockApi, renderApp } from '@/test/render-app';

// The pages an invite or reset link opens. The app reads the token from the
// fragment, drops it from the address bar and posts it in a body. Logged out
// (login mode), as a new user would be.

const TOKEN = 'Q2xhdWRlIG1hZGUgdGhpcyBmaXh0dXJlIHRva2VuIQ';
const INVALID = {
  status: 404,
  body: {
    error: { code: 'NOT_FOUND', message: 'This invite link is no longer valid', details: [] },
  },
};

/** Opens `path` in the browser's own address bar, where the auth gate looks. */
function open(path: string) {
  window.history.pushState({}, '', path);
  return renderApp('/');
}

function bodiesOf(fetchMock: ReturnType<typeof mockApi>, path: string) {
  return fetchMock.mock.calls
    .filter(([url]) => url === `/api/v1${path}`)
    .map(([, init]) =>
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    );
}

afterEach(() => {
  window.history.pushState({}, '', '/');
  vi.restoreAllMocks();
});

describe('invite page', () => {
  it('takes the token from the fragment, removes it, and posts it in the body', async () => {
    const enter = vi.spyOn(linkNavigation, 'enterApp').mockImplementation(() => undefined);
    const fetchMock = mockApi({
      '/api/v1/auth/me': { body: loggedOut },
      'POST /api/v1/auth/invite/lookup': { body: { type: 'invite' } },
      'POST /api/v1/auth/invite/accept': {
        status: 201,
        body: {
          user: {
            id: 2,
            username: 'ola',
            role: 'member',
            canCreateApiKeys: true,
            twoFactorEnabled: false,
          },
        },
      },
    });
    open(`/invite#${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeTruthy();
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/invite');
    expect(bodiesOf(fetchMock, '/auth/invite/lookup')[0]).toEqual({ token: TOKEN });
    // No request carries the token in its URL.
    for (const [url] of fetchMock.mock.calls) expect(JSON.stringify(url)).not.toContain(TOKEN);
    expect(document.head.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe(
      'no-referrer',
    );
    expect(screen.getByText(BRANDING.jagexPasswordWarning)).toBeTruthy();

    await userEvent.type(await screen.findByLabelText('Username'), 'ola');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.type(screen.getByLabelText('Repeat password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => {
      expect(enter).toHaveBeenCalled();
    });
    expect(bodiesOf(fetchMock, '/auth/invite/accept')).toEqual([
      { token: TOKEN, username: 'ola', password: 'correct horse battery' },
    ]);
  });

  it('says the link is no longer valid, whatever the reason', async () => {
    mockApi({ '/api/v1/auth/me': { body: loggedOut }, 'POST /api/v1/auth/invite/lookup': INVALID });
    open(`/invite#${TOKEN}`);
    expect(
      await screen.findByRole('heading', { name: 'This invite link is no longer valid' }),
    ).toBeTruthy();
    expect(screen.getByText(/Ask the person who runs this server for a new link/)).toBeTruthy();
  });

  it('says the same without a token, and asks nothing', async () => {
    const fetchMock = mockApi({ '/api/v1/auth/me': { body: loggedOut } });
    open('/invite');
    expect(
      await screen.findByRole('heading', { name: 'This invite link is no longer valid' }),
    ).toBeTruthy();
    expect(bodiesOf(fetchMock, '/auth/invite/lookup')).toEqual([]);
  });

  it('shows field errors, and that passwords must match', async () => {
    mockApi({
      '/api/v1/auth/me': { body: loggedOut },
      'POST /api/v1/auth/invite/lookup': { body: { type: 'invite' } },
      'POST /api/v1/auth/invite/accept': {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request',
            details: [{ path: 'body.username', message: 'That username is taken' }],
          },
        },
      },
    });
    open(`/invite#${TOKEN}`);
    await userEvent.type(await screen.findByLabelText('Username'), 'admin');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery');
    await userEvent.type(screen.getByLabelText('Repeat password'), 'something else');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText("The passwords don't match.")).toBeTruthy();
    await userEvent.clear(screen.getByLabelText('Repeat password'));
    await userEvent.type(screen.getByLabelText('Repeat password'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('That username is taken')).toBeTruthy();
  });

  it('a reset link on the invite page is not valid there', async () => {
    mockApi({
      '/api/v1/auth/me': { body: loggedOut },
      'POST /api/v1/auth/invite/lookup': {
        body: { type: 'password_reset', username: 'ola', twoFactorRequired: false },
      },
    });
    open(`/invite#${TOKEN}`);
    expect(
      await screen.findByRole('heading', { name: 'This invite link is no longer valid' }),
    ).toBeTruthy();
  });
});

describe('reset password page', () => {
  it('names the user, sets the password and logs in', async () => {
    const enter = vi.spyOn(linkNavigation, 'enterApp').mockImplementation(() => undefined);
    const fetchMock = mockApi({
      '/api/v1/auth/me': { body: loggedOut },
      'POST /api/v1/auth/invite/lookup': {
        body: { type: 'password_reset', username: 'ola', twoFactorRequired: false },
      },
      'POST /api/v1/auth/password-reset': { status: 204, body: null },
    });
    open(`/reset-password#${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'Reset your password' })).toBeTruthy();
    expect(screen.getByText('ola')).toBeTruthy();
    expect(window.location.hash).toBe('');
    // The same warning as on the login and invite pages.
    expect(screen.getByText(BRANDING.jagexPasswordWarning)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Password'), 'another long password');
    await userEvent.type(screen.getByLabelText('Repeat password'), 'another long password');
    await userEvent.click(screen.getByRole('button', { name: 'Set password and log in' }));
    await waitFor(() => {
      expect(enter).toHaveBeenCalled();
    });
    expect(bodiesOf(fetchMock, '/auth/password-reset')).toEqual([
      { token: TOKEN, password: 'another long password' },
    ]);
  });

  it('asks for a 2FA code when the user has 2FA on, and shows a wrong one under the field', async () => {
    const enter = vi.spyOn(linkNavigation, 'enterApp').mockImplementation(() => undefined);
    let calls = 0;
    const fetchMock = mockApi({
      '/api/v1/auth/me': { body: loggedOut },
      'POST /api/v1/auth/invite/lookup': {
        body: { type: 'password_reset', username: 'ola', twoFactorRequired: true },
      },
      'POST /api/v1/auth/password-reset': () => {
        calls += 1;
        return calls === 1
          ? new Response(
              JSON.stringify({
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'Invalid request',
                  details: [{ path: 'body.code', message: 'Wrong code' }],
                },
              }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            )
          : new Response(null, { status: 204 });
      },
    });
    open(`/reset-password#${TOKEN}`);
    await userEvent.type(await screen.findByLabelText('Password'), 'another long password');
    await userEvent.type(screen.getByLabelText('Repeat password'), 'another long password');
    const group = screen.getByRole('group', { name: 'Two-factor code' });
    const first = within(group).getByRole('textbox', { name: 'Digit 1 of 6' });
    expect(first.getAttribute('autocomplete')).toBe('one-time-code');
    await userEvent.click(first);
    await userEvent.paste('000000');
    // Never sent by itself outside the login page.
    expect(bodiesOf(fetchMock, '/auth/password-reset')).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Set password and log in' }));
    expect(await screen.findByText('Wrong code')).toBeTruthy();
    // A refused code empties the boxes and puts focus back in the first.
    expect((first as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(first);
    await userEvent.keyboard('123456');
    await userEvent.click(screen.getByRole('button', { name: 'Set password and log in' }));
    await waitFor(() => {
      expect(enter).toHaveBeenCalled();
    });
    expect(bodiesOf(fetchMock, '/auth/password-reset').at(-1)).toEqual({
      token: TOKEN,
      password: 'another long password',
      code: '123456',
    });
  });

  it('keeps the code after a 429, and takes a recovery code instead', async () => {
    const enter = vi.spyOn(linkNavigation, 'enterApp').mockImplementation(() => undefined);
    let calls = 0;
    const fetchMock = mockApi({
      '/api/v1/auth/me': { body: loggedOut },
      'POST /api/v1/auth/invite/lookup': {
        body: { type: 'password_reset', username: 'ola', twoFactorRequired: true },
      },
      'POST /api/v1/auth/password-reset': () => {
        calls += 1;
        return calls === 1
          ? new Response(
              JSON.stringify({
                error: { code: 'RATE_LIMITED', message: 'Try again in 8 seconds.', details: [] },
              }),
              { status: 429, headers: { 'content-type': 'application/json' } },
            )
          : new Response(null, { status: 204 });
      },
    });
    open(`/reset-password#${TOKEN}`);
    await userEvent.type(await screen.findByLabelText('Password'), 'another long password');
    await userEvent.type(screen.getByLabelText('Repeat password'), 'another long password');
    const group = screen.getByRole('group', { name: 'Two-factor code' });
    const first = within(group).getByRole('textbox', { name: 'Digit 1 of 6' });
    await userEvent.click(first);
    await userEvent.keyboard('123456');
    await userEvent.click(screen.getByRole('button', { name: 'Set password and log in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Try again in 8 seconds.');
    expect((first as HTMLInputElement).value).toBe('1');
    await userEvent.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    await userEvent.type(screen.getByLabelText('Recovery code'), 'abcde-fgh23');
    await userEvent.click(screen.getByRole('button', { name: 'Set password and log in' }));
    await waitFor(() => {
      expect(enter).toHaveBeenCalled();
    });
    expect(bodiesOf(fetchMock, '/auth/password-reset')).toEqual([
      { token: TOKEN, password: 'another long password', code: '123456' },
      { token: TOKEN, password: 'another long password', code: 'abcde-fgh23' },
    ]);
  });

  it('turns invalid when the link stops working while the form is open', async () => {
    mockApi({
      '/api/v1/auth/me': { body: loggedOut },
      'POST /api/v1/auth/invite/lookup': {
        body: { type: 'password_reset', username: 'ola', twoFactorRequired: false },
      },
      'POST /api/v1/auth/password-reset': INVALID,
    });
    open(`/reset-password#${TOKEN}`);
    await userEvent.type(await screen.findByLabelText('Password'), 'another long password');
    await userEvent.type(screen.getByLabelText('Repeat password'), 'another long password');
    await userEvent.click(screen.getByRole('button', { name: 'Set password and log in' }));
    expect(
      await screen.findByRole('heading', { name: 'This invite link is no longer valid' }),
    ).toBeTruthy();
  });
});
