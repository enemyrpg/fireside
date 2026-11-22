import { describe, expect, it } from 'vitest';
import { keepPreviousOfSameScopeKind } from './query-client';

describe('keepPreviousOfSameScopeKind', () => {
  const previous = { levels: 198 };
  const from = (scope: unknown) => ({ queryKey: ['gains', scope, { period: 'week' }] });

  it('keeps data from the same kind of scope', () => {
    expect(keepPreviousOfSameScopeKind(1).placeholderData(previous, from(2))).toBe(previous);
    expect(keepPreviousOfSameScopeKind('all').placeholderData(previous, from('all'))).toBe(
      previous,
    );
  });

  it('never lets summed levels from all stand in for one account, or the other way round', () => {
    expect(keepPreviousOfSameScopeKind(1).placeholderData(previous, from('all'))).toBeUndefined();
    expect(keepPreviousOfSameScopeKind('all').placeholderData(previous, from(1))).toBeUndefined();
  });

  it('has nothing to keep on the first load', () => {
    expect(
      keepPreviousOfSameScopeKind(1).placeholderData<typeof previous>(undefined, undefined),
    ).toBeUndefined();
  });
});
