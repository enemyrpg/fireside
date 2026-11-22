import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedFilter, SegmentedTabs } from './Segmented';

describe('SegmentedTabs', () => {
  it('shows a short label on mobile and keeps the full one as the accessible name', () => {
    render(
      <MemoryRouter>
        <SegmentedTabs
          label="Collections views"
          tabs={[
            { key: 'pets', to: '/1/collections/pets', label: 'Pets', current: false },
            {
              key: 'quests',
              to: '/1/collections/quests',
              label: 'Quests & diaries',
              shortLabel: 'Quests',
              current: true,
            },
          ]}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Quests & diaries' });
    // Both texts are in the link; CSS shows one per layout.
    expect([...link.querySelectorAll('span')].map((span) => span.textContent)).toEqual([
      'Quests',
      'Quests & diaries',
    ]);
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Pets' }).getAttribute('aria-label')).toBeNull();
  });

  it('is a nav of links with aria-current on the chosen one', () => {
    render(
      <MemoryRouter>
        <SegmentedTabs
          label="Activity views"
          tabs={[
            { key: 'a', to: '/a', label: 'Sessions', current: false },
            { key: 'b', to: '/b', label: 'Screen time', current: true },
          ]}
        />
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: 'Activity views' });
    const current = screen.getByRole('link', { name: 'Screen time' });
    expect(nav.contains(current)).toBe(true);
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.className).toContain('bg-accent');
    expect(screen.getByRole('link', { name: 'Sessions' }).getAttribute('aria-current')).toBeNull();
    // 44 px targets on mobile.
    expect(current.className).toContain('h-11');
  });
});

describe('SegmentedFilter', () => {
  const options = [
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
  ] as const;

  it('marks the chosen option in the wash and reports a new choice', async () => {
    const onChange = vi.fn();
    render(<SegmentedFilter label="Period" options={options} value="30d" onChange={onChange} />);
    expect(screen.getByRole('radiogroup', { name: 'Period' })).toBeTruthy();
    const chosen = screen.getByRole('radio', { name: '30 days' });
    expect(chosen.getAttribute('aria-checked')).toBe('true');
    expect(chosen.className).toContain('data-[state=on]:bg-accent-wash');
    expect(chosen.className).toContain('h-11');

    await userEvent.click(screen.getByRole('radio', { name: '7 days' }));
    expect(onChange).toHaveBeenCalledWith('7d');
  });

  it('keeps the choice when the chosen option is clicked again', async () => {
    const onChange = vi.fn();
    render(<SegmentedFilter label="Period" options={options} value="30d" onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: '30 days' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('spans the width in equal columns on mobile with block', () => {
    render(
      <SegmentedFilter block label="Period" options={options} value="7d" onChange={vi.fn()} />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Period' });
    expect(group.className).toContain('w-full');
    expect(group.style.gridTemplateColumns).toMatch(/^repeat\(2, /);
  });

  it('shows a short label on mobile but keeps the full accessible name', () => {
    render(
      <SegmentedFilter
        block
        label="Mode"
        options={[
          { value: 'default', label: 'Account default (Split)', shortLabel: 'Default (Split)' },
          { value: 'FFA', label: 'FFA' },
        ]}
        value="default"
        onChange={vi.fn()}
      />,
    );
    const option = screen.getByRole('radio', { name: 'Account default (Split)' });
    expect(screen.getByText('Default (Split)').className).toContain('desk:hidden');
    expect(screen.getByText('Account default (Split)').className).toContain('max-desk:hidden');
    expect(option.textContent).toBe('Default (Split)Account default (Split)');
  });
});
