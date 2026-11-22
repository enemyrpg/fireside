import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { HBarList } from './HBarList';

const rows = Array.from({ length: 9 }, (_, index) => ({
  key: String(index),
  label: `Row ${String(index + 1)}`,
  value: 100 - index,
}));

function renderList(props: Partial<Parameters<typeof HBarList>[0]> = {}) {
  render(
    <TooltipProvider>
      <HBarList label="List" rows={rows} format={String} {...props} />
    </TooltipProvider>,
  );
  return () => within(screen.getByRole('list', { name: 'List' })).getAllByRole('listitem');
}

describe('HBarList', () => {
  it('shows six rows, then all of them with Show all', async () => {
    const items = renderList();
    expect(items()).toHaveLength(6);
    const button = screen.getByRole('button', { name: 'Show all (9)' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(button);
    expect(items()).toHaveLength(9);
    await userEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(items()).toHaveLength(6);
  });

  it('has no button for six rows or fewer', () => {
    render(
      <TooltipProvider>
        <HBarList label="Short" rows={rows.slice(0, 6)} format={String} />
      </TooltipProvider>,
    );
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });

  it('shows every row without a limit', () => {
    const items = renderList({ limit: false });
    expect(items()).toHaveLength(9);
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });

  it('folds again when the reset key changes without a remount', async () => {
    const { rerender } = render(
      <TooltipProvider>
        <HBarList label="Reused" rows={rows} format={String} resetKey="session-1" />
      </TooltipProvider>,
    );
    const items = () =>
      within(screen.getByRole('list', { name: 'Reused' })).getAllByRole('listitem');
    await userEvent.click(screen.getByRole('button', { name: 'Show all (9)' }));
    expect(items()).toHaveLength(9);
    // Same rows, another session: folded.
    rerender(
      <TooltipProvider>
        <HBarList label="Reused" rows={[...rows]} format={String} resetKey="session-2" />
      </TooltipProvider>,
    );
    expect(items()).toHaveLength(6);
  });

  it('stays unfolded when the same rows render again', async () => {
    const { rerender } = render(
      <TooltipProvider>
        <HBarList label="Same" rows={rows} format={String} />
      </TooltipProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show all (9)' }));
    rerender(
      <TooltipProvider>
        <HBarList label="Same" rows={rows.map((row) => ({ ...row }))} format={String} />
      </TooltipProvider>,
    );
    expect(
      within(screen.getByRole('list', { name: 'Same' })).getAllByRole('listitem'),
    ).toHaveLength(9);
  });
});
