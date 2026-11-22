import { describe, expect, it } from 'vitest';
import { parseTypes } from './screentime.js';

describe('parseTypes', () => {
  it('gives each type once, in stored order', () => {
    expect(parseTypes('["MEMBERS","PVP","MEMBERS"]')).toEqual(['MEMBERS', 'PVP']);
    expect(parseTypes('[]')).toEqual([]);
  });

  it('gives no types for bad data', () => {
    expect(parseTypes('not json')).toEqual([]);
    expect(parseTypes('{"a":1}')).toEqual([]);
    expect(parseTypes('["MEMBERS",1,null]')).toEqual(['MEMBERS']);
  });
});
