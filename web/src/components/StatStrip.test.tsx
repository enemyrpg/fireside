import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatStrip } from './StatStrip';

describe('StatStrip', () => {
  it('shows each number with its label, the first one large', () => {
    render(
      <StatStrip
        label="Summary"
        items={[
          { key: 'a', value: '15 h 34 min', label: 'play time · last 30 days' },
          { key: 'b', value: '26', label: 'sessions · longest 4 h', shortLabel: 'sessions' },
        ]}
      />,
    );
    const strip = screen.getByRole('region', { name: 'Summary' });
    const first = within(strip).getByText('15 h 34 min');
    expect(first.className).toContain('text-[44px]');
    expect(first.className).toContain('font-display');
    expect(within(strip).getByText('26').className).toContain('text-[22px]');
    // Both labels are there; CSS shows one per layout.
    expect(within(strip).getByText('sessions').className).toContain('desk:hidden');
    expect(within(strip).getByText('sessions · longest 4 h').className).toContain(
      'max-desk:hidden',
    );
  });

  it('shows skeletons while loading and the error instead of the numbers', () => {
    const { rerender } = render(<StatStrip label="Summary" items={undefined} />);
    expect(screen.getByRole('region', { name: 'Summary' }).getAttribute('aria-busy')).toBe('true');
    rerender(<StatStrip label="Summary" items={undefined} error={<p>Failed</p>} />);
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('holds the numbers\u2019 own line sizes while loading, and the loading aside', () => {
    render(
      <StatStrip
        label="Summary"
        size="hero"
        items={undefined}
        aside={<p>Loaded aside</p>}
        loadingAside={<p>Bars box</p>}
      />,
    );
    const strip = screen.getByRole('region', { name: 'Summary' });
    const skeletons = within(strip).getAllByTestId('text-skeleton');
    // A value and a label per number, inside the spans that size the loaded text.
    expect(skeletons).toHaveLength(8);
    expect(skeletons[0]?.parentElement?.className).toContain('text-[44px]');
    expect(skeletons[0]?.parentElement?.className).toContain('desk:text-[56px]');
    expect(skeletons[2]?.parentElement?.className).toContain('text-[24px]');
    expect(skeletons[1]?.parentElement?.className).toContain('desk:text-table');
    expect(within(strip).getByText('Bars box')).toBeTruthy();
    expect(within(strip).queryByText('Loaded aside')).toBeNull();
  });

  it('shows a unit after the number (only the first on mobile) and an aside', () => {
    render(
      <StatStrip
        label="Summary"
        items={[
          { key: 'a', value: '17.69M', label: 'loot', unit: 'gp' },
          { key: 'b', value: '385K', label: 'average per drop', unit: 'gp' },
        ]}
        aside={<button type="button">Split</button>}
      />,
    );
    const strip = screen.getByRole('region', { name: 'Summary' });
    const units = within(strip).getAllByText('gp');
    expect(units).toHaveLength(2);
    expect(units[0]?.className).not.toContain('max-desk:hidden');
    expect(units[1]?.className).toContain('max-desk:hidden');
    expect(within(strip).getByRole('button', { name: 'Split' })).toBeTruthy();
  });

  it("lets the hero's aside shrink, so it stays on the row of the numbers (Home at 1440 px)", () => {
    const { container } = render(
      <StatStrip
        label="This week"
        size="hero"
        items={[{ key: 'played', label: 'played', value: '9 h 50 min' }]}
        aside={<div>bars</div>}
      />,
    );
    const aside = container.querySelector('[data-slot="stat-strip-aside"]');
    // Counted as 240 px when the row is laid out, up to 340 px when there is room.
    expect(aside?.className).toContain('desk:flex-[1_1_240px]');
    expect(aside?.className).toContain('desk:max-w-[340px]');
  });

  it('shows no aside while loading', () => {
    render(
      <StatStrip label="Summary" items={undefined} aside={<button type="button">Split</button>} />,
    );
    expect(screen.queryByRole('button', { name: 'Split' })).toBeNull();
  });

  it('has a hero size and a slot beside the first number on mobile', () => {
    render(
      <StatStrip
        label="This week"
        size="hero"
        beside={<div data-testid="bars" />}
        items={[
          { key: 'a', value: '7 h 10 min', label: 'played' },
          { key: 'b', value: '14.42M', label: 'loot', unit: 'gp' },
        ]}
      />,
    );
    const strip = screen.getByRole('region', { name: 'This week' });
    const first = within(strip).getByText('7 h 10 min');
    expect(first.className).toContain('text-[44px]');
    expect(first.className).toContain('desk:text-[56px]');
    expect(within(strip).getByText('14.42M').className).toContain('text-[24px]');
    expect(within(strip).getByText('gp').className).toContain('desk:text-[22px]');
    // The bars share the first number's row, on mobile only.
    const beside = within(strip).getByTestId('bars').parentElement;
    expect(beside?.className).toContain('desk:hidden');
    expect(beside?.parentElement).toBe(first.parentElement?.parentElement);
  });
});
