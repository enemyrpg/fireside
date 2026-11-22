import { describe, expect, it } from 'vitest';
import { keyboardInset } from './visual-viewport';

describe('keyboardInset', () => {
  it('is 0 without a keyboard', () => {
    expect(keyboardInset(844, { height: 844, offsetTop: 0 })).toBe(0);
  });

  it('is what the keyboard covers', () => {
    expect(keyboardInset(844, { height: 508, offsetTop: 0 })).toBe(336);
  });

  it('counts the part scrolled away at the top (iOS scrolls the page under the keyboard)', () => {
    expect(keyboardInset(844, { height: 508, offsetTop: 120 })).toBe(216);
  });

  it('is never negative (pinch zoom makes the visual viewport taller than the layout)', () => {
    expect(keyboardInset(844, { height: 900, offsetTop: 0 })).toBe(0);
  });
});
