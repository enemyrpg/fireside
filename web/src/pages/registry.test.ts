import { matchPath } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DESTINATIONS, destinationOf, hrefOf, PAGES, pageById } from './registry';

const scoped = PAGES.filter((page) => page.scoped);

describe('page registry', () => {
  it('gives every account page a destination, and a tab label where it shares one', () => {
    for (const page of scoped) {
      expect(page.destination, page.id).toBeDefined();
      const shared = scoped.filter((other) => other.destination === page.destination);
      if (shared.length > 1) expect(page.tab, page.id).toBeTruthy();
    }
    expect(DESTINATIONS.map((destination) => destination.label)).toEqual([
      'Home',
      'Activity',
      'Progress',
      'Collections',
      'Bank',
    ]);
  });

  it('never lets an old path or a destination path match a new page path', () => {
    const newPaths = scoped.map((page) => `/:acc/${page.path}`);
    const oldPaths = scoped.flatMap((page) => page.oldPaths ?? []);
    const destinationPaths = DESTINATIONS.flatMap(({ path }) => (path ? [path] : []));
    for (const path of [...oldPaths, ...destinationPaths]) {
      const sample = `/1/${path.replace(/\/:[^/]+\??/g, '')}`;
      for (const pattern of newPaths) {
        expect(matchPath(pattern, sample), `${path} vs ${pattern}`).toBeNull();
      }
    }
    expect(new Set(oldPaths).size).toBe(oldPaths.length);
  });

  it('builds links by id and marks a detail page with its parent destination', () => {
    expect(hrefOf('weekly', 'all')).toBe('/all/activity/weekly');
    expect(hrefOf('raids', 2)).toBe('/2/progress/raids');
    expect(hrefOf('home', 1)).toBe('/1');
    expect(destinationOf(pageById('session'))?.id).toBe('activity');
    expect(destinationOf(pageById('settings'))).toBeUndefined();
  });
});
