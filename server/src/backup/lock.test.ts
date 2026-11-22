import { BRANDING } from '@fireside/shared';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock, InstanceLockedError, lockPath } from './lock.js';
import { tempDir } from './testing.js';

const N = BRANDING.shortName;

describe('instance lock', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  function dataDir() {
    const { dir, remove } = tempDir();
    cleanups.push(remove);
    return join(dir, 'data');
  }

  it('lets only one holder have it at a time', () => {
    const dir = dataDir();
    const first = acquireInstanceLock(dir);
    expect(() => acquireInstanceLock(dir)).toThrow(InstanceLockedError);
    expect(() => acquireInstanceLock(dir)).toThrow(/already running on .*data/);
    first.release();
    first.release();
    acquireInstanceLock(dir).release();
  });

  it('is per data folder', () => {
    const a = acquireInstanceLock(dataDir());
    const b = acquireInstanceLock(dataDir());
    a.release();
    b.release();
  });

  it('lives in DATA_DIR, named after the product', () => {
    expect(lockPath('/data')).toBe(`/data/${N}.lock`);
  });
});
