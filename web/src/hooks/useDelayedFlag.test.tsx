import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardSkeleton } from '@/components/states';
import { SKELETON_DELAY_MS, useDelayedFlag } from './useDelayedFlag';

describe('useDelayedFlag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns on only after the delay', () => {
    const { result } = renderHook(() => useDelayedFlag(true));
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS - 1);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it('starts over when it turns off', () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active), {
      initialProps: { active: true },
    });
    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS);
    });
    rerender({ active: false });
    expect(result.current).toBe(false);
    rerender({ active: true });
    expect(result.current).toBe(false);
  });

  it('keeps the skeleton invisible for the first 200 ms', () => {
    render(<CardSkeleton lines={2} />);
    const lines = screen.getAllByTestId('skeleton-line');
    expect(lines.every((line) => line.classList.contains('invisible'))).toBe(true);
    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS);
    });
    expect(lines.some((line) => line.classList.contains('invisible'))).toBe(false);
  });
});
