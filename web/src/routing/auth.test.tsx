import { BRANDING } from '@fireside/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import loggedIn from '../../../shared/fixtures/api/auth-me-response/valid/logged-in.json';
import loggedOut from '../../../shared/fixtures/api/auth-me-response/valid/logged-out.json';
import adminLogin from '../../../shared/fixtures/api/login-response/valid/admin.json';
import { mockApi, renderApp, type MockAnswer } from '@/test/render-app';

// Login mode in the dashboard.

const ADMIN_ME = { mode: 'login', user: adminLogin.user };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const error = (code: string, message: string, details: unknown[] = []) => ({
  error: { code, message, details },
});

/** `auth/me` answers in order: logged out first, then each next answer. */
function meSequence(...answers: unknown[]): MockAnswer {
  let index = 0;
  return () => {
    const body = answers[Math.min(index, answers.length - 1)];
    index += 1;
    return json(200, body);
  };
}

type FetchMock = ReturnType<typeof mockApi>;

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** The parsed JSON body of the first call to `path`, or `undefined`. */
function sentBody(fetchMock: FetchMock, path: string): unknown {
  const call = fetchMock.mock.calls.find(([input]) => urlOf(input).endsWith(path));
  const body = call?.[1]?.body;
  return typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined;
}

const called = (fetchMock: FetchMock, path: string) =>
  fetchMock.mock.calls.some(([input]) => urlOf(input).endsWith(path));

async function fillLogin(username: string, password: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Username'), username);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  return user;
}

describe('login page', () => {
  it('replaces the app in login mode without a session, with the warnings', async () => {
    mockApi({ '/api/v1/auth/me': { body: loggedOut } });
    renderApp('/all');
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeTruthy();
    expect(screen.getByText(BRANDING.jagexPasswordWarning)).toBeTruthy();
    expect(screen.getByText(BRANDING.jagexDisclaimer)).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: /main/i })).toBeNull();
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password');
  });

  it('logs in and shows the app', async () => {
    const fetchMock = mockApi({
      '/api/v1/auth/me': meSequence(loggedOut, ADMIN_ME),
      'POST /api/v1/auth/login': { body: adminLogin },
    });
    renderApp('/all');
    await fillLogin('admin', 'correct horse battery');
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(sentBody(fetchMock, '/auth/login')).toEqual({
      username: 'admin',
      password: 'correct horse battery',
    });
  });

  it('says so on a wrong password and clears the field', async () => {
    mockApi({
      '/api/v1/auth/me': { body: loggedOut },
      'POST /api/v1/auth/login': {
        status: 401,
        body: error('UNAUTHORIZED', 'Invalid username or password'),
      },
    });
    renderApp('/all');
    await fillLogin('admin', 'wrong password');
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong username or password.');
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');
    expect(screen.getByRole('heading', { name: 'Log in' })).toBeTruthy();
  });

  it('shows how long to wait when rate limited', async () => {
    mockApi({
      '/api/v1/auth/me': { body: loggedOut },
      'POST /api/v1/auth/login': {
        status: 429,
        body: error('RATE_LIMITED', 'Too many login attempts. Try again in 8 seconds.'),
      },
    });
    renderApp('/all');
    await fillLogin('admin', 'whatever');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many login attempts. Try again in 8 seconds.',
    );
  });

  it('explains a cookie the browser refused (Safari on http://localhost)', async () => {
    mockApi({
      '/api/v1/auth/me': { body: loggedOut },
      'POST /api/v1/auth/login': { body: adminLogin },
    });
    renderApp('/all');
    await fillLogin('admin', 'correct horse battery');
    expect((await screen.findByRole('alert')).textContent).toContain(
      "Safari doesn't allow secure cookies on http://localhost",
    );
  });

  it('comes back when a request gets 401 (session ended elsewhere)', async () => {
    mockApi({
      '/api/v1/auth/me': meSequence(ADMIN_ME, loggedOut),
      '/api/v1/accounts': { status: 401, body: error('UNAUTHORIZED', 'Log in to continue') },
    });
    renderApp('/all');
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeTruthy();
  });
});

describe('Settings → Profile', () => {
  it('sets the first password in local mode', async () => {
    const fetchMock = mockApi({
      '/api/v1/auth/me': meSequence({ mode: 'local', user: adminLogin.user }, ADMIN_ME),
      'POST /api/v1/auth/password': { status: 204, body: null },
    });
    renderApp('/settings');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Set a password' })).toBeTruthy();
    expect(screen.queryByLabelText('Current password')).toBeNull();
    await user.type(screen.getByLabelText('New password'), 'correct horse battery');
    await user.type(screen.getByLabelText('Repeat new password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Set password and turn on login' }));
    await waitFor(() => {
      expect(sentBody(fetchMock, '/auth/password')).toEqual({
        newPassword: 'correct horse battery',
      });
    });
    expect(await screen.findByRole('button', { name: 'Log out everywhere' })).toBeTruthy();
  });

  it('checks that the new passwords match before sending', async () => {
    const fetchMock = mockApi();
    renderApp('/settings');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New password'), 'correct horse battery');
    await user.type(screen.getByLabelText('Repeat new password'), 'correct horse batterY');
    await user.click(screen.getByRole('button', { name: 'Set password and turn on login' }));
    expect(await screen.findByText("The passwords don't match.")).toBeTruthy();
    expect(called(fetchMock, '/auth/password')).toBe(false);
  });

  it('changes the password in login mode and shows field errors', async () => {
    mockApi({
      '/api/v1/auth/me': { body: loggedIn },
      'POST /api/v1/auth/password': {
        status: 400,
        body: error('VALIDATION_ERROR', 'Invalid request', [
          { path: 'body.currentPassword', message: 'Wrong password' },
        ]),
      },
    });
    renderApp('/settings');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Current password'), 'not it');
    await user.type(screen.getByLabelText('New password'), 'a new long passphrase');
    await user.type(screen.getByLabelText('Repeat new password'), 'a new long passphrase');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Wrong password')).toBeTruthy();
  });

  it('logs out everywhere after confirming', async () => {
    const fetchMock = mockApi({
      '/api/v1/auth/me': meSequence(loggedIn, loggedOut),
      'POST /api/v1/auth/logout-all': { status: 204, body: null },
    });
    renderApp('/settings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Log out everywhere' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      Array.from(dialog.querySelectorAll('button')).find(
        (button) => button.textContent === 'Log out everywhere',
      ) ?? dialog,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeTruthy();
    expect(called(fetchMock, '/auth/logout-all')).toBe(true);
  });
});

describe('403 as a member', () => {
  it('says only an admin can see it, with a way back', async () => {
    mockApi({
      '/api/v1/auth/me': { body: loggedIn },
      '/api/v1/accounts': { status: 403, body: error('FORBIDDEN', 'Only an admin can do this') },
    });
    renderApp('/all');
    expect(await screen.findByText('Only an admin can see this.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Home' })).toBeTruthy();
  });

  it('keeps the localhost message for an admin', async () => {
    mockApi({
      '/api/v1/auth/me': { body: ADMIN_ME },
      '/api/v1/accounts': { status: 403, body: error('FORBIDDEN', 'Refused') },
    });
    renderApp('/all');
    expect(
      await screen.findByText('The dashboard only works on this PC (localhost) for now.'),
    ).toBeTruthy();
  });
});
