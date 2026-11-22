import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useParamsOfData } from './useParamsOfData';

interface Props {
  data: unknown;
  isPlaceholderData: boolean;
  params: string;
}

function render(initial: Props) {
  return renderHook(
    ({ data, isPlaceholderData, params }: Props) =>
      useParamsOfData({ data, isPlaceholderData }, params),
    { initialProps: initial },
  );
}

describe('useParamsOfData', () => {
  it('follows the parameters once their data has arrived', () => {
    const hook = render({ data: undefined, isPlaceholderData: false, params: '7d' });
    expect(hook.result.current).toBe('7d');
    hook.rerender({ data: { week: 1 }, isPlaceholderData: false, params: '7d' });
    expect(hook.result.current).toBe('7d');
  });

  it('keeps the parameters of the data on screen while new ones load', () => {
    const week = { week: 1 };
    const hook = render({ data: week, isPlaceholderData: false, params: '7d' });
    // A new range: the previous data stays as a placeholder.
    hook.rerender({ data: week, isPlaceholderData: true, params: 'all' });
    expect(hook.result.current).toBe('7d');
    hook.rerender({ data: { all: 1 }, isPlaceholderData: false, params: 'all' });
    expect(hook.result.current).toBe('all');
  });

  it('stays right when the key changes for another reason, like a new day', () => {
    const week = { week: 1 };
    const hook = render({ data: week, isPlaceholderData: false, params: '7d' });
    // Same URL parameter, new query key (a new `from` after midnight).
    hook.rerender({ data: week, isPlaceholderData: true, params: '7d' });
    expect(hook.result.current).toBe('7d');
  });

  it('uses the new parameters when there is no earlier data', () => {
    const hook = render({ data: undefined, isPlaceholderData: false, params: '7d' });
    hook.rerender({ data: undefined, isPlaceholderData: false, params: 'all' });
    expect(hook.result.current).toBe('all');
  });
});
