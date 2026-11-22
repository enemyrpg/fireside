import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('keeps our font sizes next to text colours', () => {
    expect(cn('text-axis text-text-2', 'text-live')).toBe('text-axis text-live');
    expect(cn('text-table', 'text-tile')).toBe('text-tile');
  });
});
