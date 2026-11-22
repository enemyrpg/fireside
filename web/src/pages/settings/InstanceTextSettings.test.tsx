import { MAX_INSTANCE_TEXT_LENGTH } from '@fireside/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import settingsDefault from '../../../../shared/fixtures/api/server-settings-response/valid/default.json';
import settingsOwn from '../../../../shared/fixtures/api/server-settings-response/valid/off.json';
import { mockApi, renderApp } from '@/test/render-app';

// Settings → Server → Instance text.

const NOTICE = 'Fill in who runs this instance and how to reach you before inviting others.';

function bodiesOf(fetchMock: ReturnType<typeof mockApi>, method: string, path: string) {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === `/api/v1${path}` && (init?.method ?? 'GET') === method)
    .map(([, init]) =>
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    );
}

async function card() {
  const heading = await screen.findByRole('heading', { name: 'Instance text' });
  const section = heading.closest('section');
  if (!section) throw new Error('Expected the Instance text card');
  return section;
}

describe('instance text setting', () => {
  it('shows the default with a notice to fill it in, and saves an own text', async () => {
    const saved = {
      ...settingsDefault,
      instanceText: 'Run by Ada.\n\nContact: ada@example.invalid',
    };
    const fetchMock = mockApi({ 'PATCH /api/v1/admin/settings': { body: saved } });
    renderApp('/settings/server');
    const section = await card();
    expect(await within(section).findByText(NOTICE)).toBeTruthy();
    const field = within(section).getByLabelText<HTMLTextAreaElement>('Instance text');
    expect(field.value).toBe(settingsDefault.defaultInstanceText);
    expect(
      within(section).getByText(/Replace \[your name\] and \[how to reach you\]/),
    ).toBeTruthy();
    expect(
      within(section).getByRole('link', { name: 'View the about page' }).getAttribute('href'),
    ).toBe('/about');

    const save = within(section).getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    await userEvent.clear(field);
    await userEvent.type(field, 'Run by Ada.{enter}{enter}Contact: ada@example.invalid');
    await userEvent.click(save);
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'PATCH', '/admin/settings')).toEqual([
        { instanceText: 'Run by Ada.\n\nContact: ada@example.invalid' },
      ]);
    });
    await waitFor(() => {
      expect(within(section).queryByText(NOTICE)).toBeNull();
    });
  });

  it('goes back to the default after confirming', async () => {
    const fetchMock = mockApi({
      '/api/v1/admin/settings': { body: settingsOwn },
      'PATCH /api/v1/admin/settings': { body: settingsDefault },
    });
    renderApp('/settings/server');
    const section = await card();
    await waitFor(() => {
      expect(within(section).getByLabelText<HTMLTextAreaElement>('Instance text').value).toBe(
        settingsOwn.instanceText,
      );
    });
    expect(within(section).queryByText(NOTICE)).toBeNull();
    await userEvent.click(within(section).getByRole('button', { name: 'Use the default' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Use the default' }));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, 'PATCH', '/admin/settings')).toEqual([{ instanceText: null }]);
    });
    expect(await within(section).findByText(NOTICE)).toBeTruthy();
  });

  it('refuses a text over the limit before sending, and shows the server’s error', async () => {
    const fetchMock = mockApi({
      'PATCH /api/v1/admin/settings': {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request',
            details: [
              { path: 'body.instanceText', message: 'Remove control and invisible characters' },
            ],
          },
        },
      },
    });
    renderApp('/settings/server');
    const section = await card();
    const field = await within(section).findByLabelText<HTMLTextAreaElement>('Instance text');
    fireEvent.change(field, { target: { value: 'x'.repeat(MAX_INSTANCE_TEXT_LENGTH + 1) } });
    expect(within(section).getByText(/Use at most 4,000 characters/)).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(
      true,
    );

    // Counted as stored: trailing spaces and extra blank lines don't count.
    const padded = `${'x'.repeat(MAX_INSTANCE_TEXT_LENGTH - 10)}${'   \n'.repeat(20)}\n\n\nend`;
    fireEvent.change(field, { target: { value: padded } });
    expect(within(section).queryByText(/Use at most/)).toBeNull();
    expect(within(section).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(
      false,
    );

    fireEvent.change(field, { target: { value: 'Run by Ada' } });
    await userEvent.click(within(section).getByRole('button', { name: 'Save' }));
    expect(
      await within(section).findByText('Remove control and invisible characters'),
    ).toBeTruthy();
    expect(bodiesOf(fetchMock, 'PATCH', '/admin/settings')).toHaveLength(1);
  });
});
