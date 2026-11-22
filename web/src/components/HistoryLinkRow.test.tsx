import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { HistoryLinkRow } from './HistoryLinkRow';

describe('HistoryLinkRow', () => {
  it('links to the history with the count', () => {
    render(
      <MemoryRouter>
        <HistoryLinkRow to="/settings/keys/revoked" label="Revoked keys" count={5} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /Revoked keys · 5/ });
    expect(link.getAttribute('href')).toBe('/settings/keys/revoked');
    expect(link.className).toContain('border-dashed');
  });

  it('shows nothing when there is nothing behind it', () => {
    const { container } = render(
      <MemoryRouter>
        <HistoryLinkRow to="/x" label="Revoked keys" count={0} />
      </MemoryRouter>,
    );
    expect(container.innerHTML).toBe('');
  });
});
