import { describe, expect, it } from 'vitest';
import { sourceLabel } from './loot';

describe('sourceLabel', () => {
  it('shows player loot as "Player" and other sources by name', () => {
    expect(sourceLabel({ type: 'PLAYER', name: null })).toBe('Player');
    expect(sourceLabel({ type: 'EVENT', name: 'Barrows' })).toBe('Barrows');
  });
});
