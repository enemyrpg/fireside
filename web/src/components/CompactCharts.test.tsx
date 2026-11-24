import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ItemRow } from './ItemRow';
import { StackedBars } from './StackedBars';

const day = (key: string, label: string, active: number, afk: number) => ({
  key,
  label,
  title: label,
  activeSeconds: active,
  afkSeconds: afk,
});

describe('StackedBars variant="compact"', () => {
  it('draws one bar per day, a stub for a day without play, and the labels under them', () => {
    const { container } = render(
      <TooltipProvider>
        <StackedBars
          variant="compact"
          label="Play time per day"
          bars={[day('mon', 'Mon', 3600, 600), day('tue', 'Tue', 1800, 0), day('wed', 'Wed', 0, 0)]}
        />
      </TooltipProvider>,
    );
    const chart = screen.getByRole('img', { name: 'Play time per day' });
    // No axes or gridlines: no SVG at all.
    expect(container.querySelector('svg')).toBeNull();
    expect(chart.querySelectorAll('.bg-active')).toHaveLength(2);
    expect(chart.querySelectorAll('.bg-afk')).toHaveLength(1);
    // The empty day is a thin stub on the baseline.
    expect(chart.querySelectorAll('.bg-grid')).toHaveLength(1);
    // The tallest day fills the height; the others are in proportion.
    const heights = [...chart.querySelectorAll<HTMLElement>('[style*="height"]')].map(
      (bar) => bar.style.height,
    );
    expect(heights[0]).toBe('100%');
    expect(Number.parseFloat(heights[1] ?? '')).toBeCloseTo((1800 / 4200) * 100, 2);
    // Full names on PC, first letters on mobile (both in the DOM, one hidden).
    expect(chart.textContent).toContain('Mon');
    expect(chart.textContent).toContain('M');
  });
});

describe('StackedBars variant="chart"', () => {
  it('renders before it is measured (no ResizeObserver in tests)', () => {
    render(
      <StackedBars
        label="Play time per day"
        bars={[day('2026-01-31', '31', 3600, 0), day('2026-03-01', '1', 1800, 600)]}
      />,
    );
    expect(screen.getByRole('img', { name: 'Play time per day' })).toBeDefined();
  });
});

describe('ItemRow', () => {
  it('has the name, one line under it, and the value', () => {
    render(
      <ul>
        <ItemRow
          itemId={11286}
          itemName="Draconic visage"
          name="Draconic visage"
          detail="Vorkath · Sun 8 Nov"
          value="2.85M gp"
        />
      </ul>,
    );
    const row = screen.getByRole('listitem');
    expect(row.textContent).toBe('DrDraconic visageVorkath · Sun 8 Nov2.85M gp');
  });
});
