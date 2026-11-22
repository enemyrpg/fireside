import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import loggedOut from '../../../shared/fixtures/api/auth-me-response/valid/logged-out.json';
import adminLogin from '../../../shared/fixtures/api/login-response/valid/admin.json';
import twoFactorRequired from '../../../shared/fixtures/api/login-response/valid/two-factor-required.json';
import recoveryCodes from '../../../shared/fixtures/api/recovery-codes-response/valid/ten-codes.json';
import totpSetup from '../../../shared/fixtures/api/totp-setup-response/valid/setup.json';
import statusOff from '../../../shared/fixtures/api/two-factor-status-response/valid/off.json';
import statusOn from '../../../shared/fixtures/api/two-factor-status-response/valid/on.json';
import usersTwo from '../../../shared/fixtures/api/users-response/valid/two-users.json';
import { mockApi, renderApp, type MockAnswer } from '@/test/render-app';

// Two-factor authentication in the dashboard.

const ADMIN_ME = { mode: 'login', user: adminLogin.user };
const MEMBER_ME = {
  mode: 'login',
  user: { ...adminLogin.user, id: 2, username: 'ola', role: 'member' },
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const error = (code: string, message: string, details: unknown[] = []) => ({
  error: { code, message, details },
});

function sequence(...answers: [number, unknown][]): MockAnswer {
  let index = 0;
  return () => {
    const [status, body] = answers[Math.min(index, answers.length - 1)] ?? [500, null];
    index += 1;
    // A 204 response can't have a body.
    return status === 204 ? new Response(null, { status }) : json(status, body);
  };
}

type FetchMock = ReturnType<typeof mockApi>;
const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
function bodies(fetchMock: FetchMock, path: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([input]) => urlOf(input).endsWith(path))
    .map(([, init]) =>
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    );
}

async function fillLogin(username: string, password: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Username'), username);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  return user;
}

/** Types a code into the six boxes named `name`, from the first box. */
async function typeCode(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  code: string,
  scope: HTMLElement = document.body,
) {
  const group = within(scope).getByRole('group', { name });
  await user.click(within(group).getByRole('textbox', { name: 'Digit 1 of 6' }));
  await user.keyboard(code);
}

const codeBox = (n: number) => screen.getByRole('textbox', { name: `Digit ${String(n)} of 6` });
const codeValue = () =>
  [1, 2, 3, 4, 5, 6].map((n) => (codeBox(n) as HTMLInputElement).value).join('');

describe('login with two-factor', () => {
  it('asks for a code after the password, and sends a typed code by itself', async () => {
    const fetchMock = mockApi({
      '/api/v1/auth/me': sequence([200, loggedOut], [200, ADMIN_ME]),
      'POST /api/v1/auth/login': { body: twoFactorRequired },
      'POST /api/v1/auth/login/totp': { body: adminLogin },
    });
    renderApp('/all');
    const user = await fillLogin('admin', 'correct horse battery');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Two-factor authentication' }),
    ).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Code' })).toBeTruthy();
    expect(codeBox(1).getAttribute('autocomplete')).toBe('one-time-code');
    expect(codeBox(1).getAttribute('inputmode')).toBe('numeric');
    await waitFor(() => {
      expect(document.activeElement).toBe(codeBox(1));
    });
    // No button press: the sixth digit sends the code.
    await user.keyboard('123456');
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(bodies(fetchMock, '/auth/login/totp')).toEqual([{ code: '123456' }]);
  });

  it('sends a pasted code once, and blocks a second request while the first is pending', async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = mockApi({
      '/api/v1/auth/me': sequence([200, loggedOut], [200, ADMIN_ME]),
      'POST /api/v1/auth/login': { body: twoFactorRequired },
      'POST /api/v1/auth/login/totp': () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    renderApp('/all');
    const user = await fillLogin('admin', 'correct horse battery');
    await user.click(await screen.findByRole('textbox', { name: 'Digit 1 of 6' }));
    await user.paste('123 456');
    expect((await screen.findByRole('status')).textContent).toBe('Code entered, logging in…');
    const button = screen.getByRole('button', { name: 'Checking…' });
    expect(button.hasAttribute('disabled')).toBe(true);
    await user.click(codeBox(6));
    await user.keyboard('7');
    expect(bodies(fetchMock, '/auth/login/totp')).toEqual([{ code: '123456' }]);
    answer(json(200, adminLogin));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(bodies(fetchMock, '/auth/login/totp')).toHaveLength(1);
  });

  it('sends the right code once when a code is inserted after a digit in box 1', async () => {
    const fetchMock = mockApi({
      '/api/v1/auth/me': sequence([200, loggedOut], [200, ADMIN_ME]),
      'POST /api/v1/auth/login': { body: twoFactorRequired },
      'POST /api/v1/auth/login/totp': { body: adminLogin },
    });
    renderApp('/all');
    const user = await fillLogin('admin', 'correct horse battery');
    await user.click(await screen.findByRole('textbox', { name: 'Digit 1 of 6' }));
    await user.keyboard('9');
    // The phone's code suggestion lands in box 1, after the 9.
    const first = codeBox(1) as HTMLInputElement;
    first.focus();
    first.setSelectionRange(1, 1);
    first.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: '123456',
        inputType: 'insertReplacementText',
      }),
    );
    fireEvent.change(first, { target: { value: '9123456' } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(bodies(fetchMock, '/auth/login/totp')).toEqual([{ code: '123456' }]);
  });

  it('clears the boxes after a wrong code, focuses the first, and sends nothing more', async () => {
    const fetchMock = mockApi({
      '/api/v1/auth/me': { body: loggedOut },
      'POST /api/v1/auth/login': { body: twoFactorRequired },
      'POST /api/v1/auth/login/totp': { status: 401, body: error('UNAUTHORIZED', 'Invalid code') },
    });
    renderApp('/all');
    const user = await fillLogin('admin', 'correct horse battery');
    await user.click(await screen.findByRole('textbox', { name: 'Digit 1 of 6' }));
    await user.keyboard('654321');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Wrong code. Check the time on your phone, or use a recovery code.',
    );
    expect(codeValue()).toBe('');
    expect(document.activeElement).toBe(codeBox(1));
    expect(codeBox(1).getAttribute('aria-invalid')).toBe('true');
    // The same digits pasted again are not sent by themselves.
    await user.paste('654321');
    expect(bodies(fetchMock, '/auth/login/totp')).toEqual([{ code: '654321' }]);
  });

  it.each([
    [
      'a 429',
      () => json(429, error('RATE_LIMITED', 'Too many codes. Try again in 8 seconds.')),
      'Too many codes. Try again in 8 seconds.',
    ],
    [
      'a network error',
      () => Promise.reject(new TypeError('Failed to fetch')),
      "Couldn't reach the server. Try again.",
    ],
  ] as const)(
    'keeps the digits after %s, and sends them again only from the button',
    async (_name, failure, text) => {
      let calls = 0;
      const fetchMock = mockApi({
        // Logged in once the second try went through.
        '/api/v1/auth/me': () => json(200, calls >= 2 ? ADMIN_ME : loggedOut),
        'POST /api/v1/auth/login': { body: twoFactorRequired },
        'POST /api/v1/auth/login/totp': () => {
          calls += 1;
          return calls === 1 ? failure() : json(200, adminLogin);
        },
      });
      renderApp('/all');
      const user = await fillLogin('admin', 'correct horse battery');
      await user.click(await screen.findByRole('textbox', { name: 'Digit 1 of 6' }));
      await user.keyboard('123456');
      expect((await screen.findByRole('alert')).textContent).toBe(text);
      expect(codeValue()).toBe('123456');
      expect(codeBox(1).getAttribute('aria-invalid')).toBe('false');
      expect(bodies(fetchMock, '/auth/login/totp')).toHaveLength(1);
      await user.click(screen.getByRole('button', { name: 'Log in' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
      expect(bodies(fetchMock, '/auth/login/totp')).toEqual([
        { code: '123456' },
        { code: '123456' },
      ]);
    },
  );

  it('takes a recovery code, says when a code is wrong, and goes back on a timeout', async () => {
    const fetchMock = mockApi({
      '/api/v1/auth/me': { body: loggedOut },
      'POST /api/v1/auth/login': { body: twoFactorRequired },
      'POST /api/v1/auth/login/totp': sequence(
        [401, error('UNAUTHORIZED', 'Invalid code')],
        [401, error('UNAUTHORIZED', 'Your login timed out. Enter your password again.')],
      ),
    });
    renderApp('/all');
    const user = await fillLogin('admin', 'correct horse battery');
    await user.click(await screen.findByRole('button', { name: 'Use a recovery code' }));
    const field = screen.getByLabelText('Recovery code');
    expect(field.getAttribute('autocomplete')).toBe('off');
    await user.type(field, 'abcde-fgh23');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/^Wrong code/);
    expect(screen.getByLabelText<HTMLInputElement>('Recovery code').value).toBe('');
    await user.type(screen.getByLabelText('Recovery code'), 'abcde-fgh24');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your login timed out. Enter your password again.',
    );
    expect(bodies(fetchMock, '/auth/login/totp')).toEqual([
      { code: 'abcde-fgh23' },
      { code: 'abcde-fgh24' },
    ]);
  });
});

describe('Settings → Profile: two-factor', () => {
  it('sets up with password, QR code and first code, then shows the recovery codes once', async () => {
    const fetchMock = mockApi({
      '/api/v1/auth/me': { body: ADMIN_ME },
      '/api/v1/auth/totp': sequence([200, statusOff], [200, statusOn]),
      'POST /api/v1/auth/totp/setup': { body: totpSetup },
      'POST /api/v1/auth/totp/enable': { body: recoveryCodes },
    });
    renderApp('/settings');
    const user = userEvent.setup();
    expect(await screen.findByText('Strongly recommended for admins.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Set up two-factor authentication' }));
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const qr = await screen.findByRole('img', { name: 'QR code for your authenticator app' });
    expect(qr.tagName.toLowerCase()).toBe('svg');
    // No data: URI, canvas or inline style in the setup (CSP).
    expect(qr.closest('form')?.innerHTML).not.toMatch(/data:|<canvas| style=/);
    expect(screen.getByText(/^JBSW Y3DP/)).toBeTruthy();
    // App code only: six boxes, no recovery code, and nothing sent by itself.
    expect(screen.queryByRole('button', { name: 'Use a recovery code instead' })).toBeNull();
    await typeCode(user, 'Code from the app', '654321');
    expect(bodies(fetchMock, '/auth/totp/enable')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Turn on' }));

    const codes = await screen.findByRole('region', { name: 'Recovery codes' });
    expect(
      within(codes)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(recoveryCodes.recoveryCodes);
    expect(bodies(fetchMock, '/auth/totp/setup')).toEqual([{ password: 'correct horse battery' }]);
    expect(bodies(fetchMock, '/auth/totp/enable')).toEqual([{ code: '654321' }]);

    await user.click(within(codes).getByRole('button', { name: 'I saved them' }));
    expect(await screen.findByText(/8 recovery codes left/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Recovery codes' })).toBeNull();
  });

  it('keeps the setup code after a 429, and clears it when the code is wrong', async () => {
    const fetchMock = mockApi({
      '/api/v1/auth/me': { body: ADMIN_ME },
      '/api/v1/auth/totp': { body: statusOff },
      'POST /api/v1/auth/totp/setup': { body: totpSetup },
      'POST /api/v1/auth/totp/enable': sequence(
        [429, error('RATE_LIMITED', 'Too many tries. Try again in 8 seconds.')],
        [
          400,
          error('VALIDATION_ERROR', 'Invalid request', [
            { path: 'body.code', message: 'Wrong code. Check the time on your phone.' },
          ]),
        ],
      ),
    });
    renderApp('/settings');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Set up two-factor authentication' }),
    );
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('img', { name: 'QR code for your authenticator app' });
    await typeCode(user, 'Code from the app', '654321');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many tries. Try again in 8 seconds.',
    );
    expect(codeValue()).toBe('654321');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText('Wrong code. Check the time on your phone.')).toBeTruthy();
    expect(codeValue()).toBe('');
    expect(document.activeElement).toBe(codeBox(1));
    expect(bodies(fetchMock, '/auth/totp/enable')).toEqual([
      { code: '654321' },
      { code: '654321' },
    ]);
  });

  it('downloads the recovery codes as a text file from a blob, never a data: URI', async () => {
    const created: Blob[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob) => {
        created.push(blob);
        return 'blob:codes';
      },
      revokeObjectURL: () => undefined,
    });
    mockApi({
      '/api/v1/auth/me': { body: ADMIN_ME },
      '/api/v1/auth/totp': { body: statusOn },
      'POST /api/v1/auth/totp/recovery-codes': { body: recoveryCodes },
    });
    renderApp('/settings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New recovery codes' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByLabelText('Password'), 'correct horse battery');
    await typeCode(user, 'Code from the app', '123456', dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Make new codes' }));
    const codes = await screen.findByRole('region', { name: 'Recovery codes' });
    await user.click(within(codes).getByRole('button', { name: 'Download .txt' }));
    expect(created).toHaveLength(1);
    const text = await created[0]?.text();
    for (const code of recoveryCodes.recoveryCodes) expect(text).toContain(code);
  });

  it('turns off with password and code, with the server’s field errors', async () => {
    const fetchMock = mockApi({
      '/api/v1/auth/me': { body: MEMBER_ME },
      '/api/v1/auth/totp': sequence([200, statusOn], [200, statusOff]),
      'POST /api/v1/auth/totp/disable': sequence(
        [
          400,
          error('VALIDATION_ERROR', 'Invalid request', [
            { path: 'body.code', message: 'Wrong code' },
          ]),
        ],
        [204, null],
      ),
    });
    renderApp('/settings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByLabelText('Password'), 'correct horse battery');
    await typeCode(user, 'Code from the app', '000000', dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(await within(dialog).findByText('Wrong code')).toBeTruthy();
    // A refused code empties the boxes and puts focus back in the first.
    const first = within(dialog).getByRole('textbox', { name: 'Digit 1 of 6' });
    expect(document.activeElement).toBe(first);
    expect((first as HTMLInputElement).value).toBe('');
    // A recovery code works here too.
    await user.click(within(dialog).getByRole('button', { name: 'Use a recovery code instead' }));
    await user.type(within(dialog).getByLabelText('Recovery code'), 'abcde-fgh23');
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(await screen.findByText(/^Off\./)).toBeTruthy();
    // Not shown to members.
    expect(screen.queryByText('Strongly recommended for admins.')).toBeNull();
    expect(bodies(fetchMock, '/auth/totp/disable')).toEqual([
      { password: 'correct horse battery', code: '000000' },
      { password: 'correct horse battery', code: 'abcde-fgh23' },
    ]);
  });

  it('is not shown in local mode', async () => {
    mockApi();
    renderApp('/settings');
    expect(await screen.findByRole('heading', { name: 'Set a password' })).toBeTruthy();
    expect(screen.queryByText('Two-factor authentication')).toBeNull();
  });
});

describe('Settings → Users: an admin turns off a user’s two-factor', () => {
  it('asks first, and is not offered for yourself or users without 2FA', async () => {
    const withTwoFactor = {
      users: [
        usersTwo.users[0],
        { ...usersTwo.users[1], disabledAt: null, twoFactorEnabled: true },
      ],
    };
    const fetchMock = mockApi({
      '/api/v1/auth/me': { body: ADMIN_ME },
      '/api/v1/users': { body: withTwoFactor },
      'POST /api/v1/users/2/totp-reset': { status: 204, body: null },
    });
    renderApp('/settings/users');
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Users' });
    expect(within(list).getAllByRole('listitem')[1]?.textContent).toContain('2FA');

    await user.click(screen.getByRole('button', { name: 'Actions for admin' }));
    expect(screen.queryByRole('menuitem', { name: 'Turn off two-factor…' })).toBeNull();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Actions for ola' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Turn off two-factor…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Turn off two-factor for ola?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Turn off two-factor' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => urlOf(input).endsWith('/users/2/totp-reset')),
      ).toBe(true);
    });
  });
});
