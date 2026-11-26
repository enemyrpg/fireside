import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SKELETON_DELAY_MS } from '@/hooks/useDelayedFlag';
import { TextSkeleton } from './states';

describe('TextSkeleton', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds a text line in its own classes at once, and shows its bar only after 200 ms', () => {
    vi.useFakeTimers();
    render(<TextSkeleton className="inline-block w-48 text-xs desk:text-table" />);
    const line = screen.getByTestId('text-skeleton');
    // A no-break space gives the line its height before anything is drawn.
    expect(line.textContent).toBe(' ');
    expect(line.className).toContain('text-xs');
    expect(line.className).toContain('desk:text-table');
    const bar = line.querySelector('[data-slot="skeleton"]');
    expect(bar?.className).toContain('absolute');
    expect(bar?.className).toContain('invisible');
    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS);
    });
    expect(bar?.className).not.toContain('invisible');
  });
});
