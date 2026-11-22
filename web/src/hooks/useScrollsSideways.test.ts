import { describe, expect, it } from 'vitest';
import { scrollRegionProps, scrollsSideways } from './useScrollsSideways';

describe('scrollsSideways', () => {
  it('is true only when the content is wider than the box', () => {
    expect(scrollsSideways({ scrollWidth: 800, clientWidth: 358 })).toBe(true);
    expect(scrollsSideways({ scrollWidth: 358, clientWidth: 358 })).toBe(false);
    // Rounding: one pixel is not a scroll.
    expect(scrollsSideways({ scrollWidth: 359, clientWidth: 358 })).toBe(false);
  });
});

describe('scrollRegionProps', () => {
  it('makes a scrolling box a named tab stop', () => {
    expect(scrollRegionProps(true, 'Activity calendar')).toEqual({
      tabIndex: 0,
      role: 'group',
      'aria-label': 'Activity calendar, scrolls sideways',
    });
  });

  it('adds nothing when everything fits', () => {
    expect(scrollRegionProps(false, 'Activity calendar')).toEqual({});
  });
});
