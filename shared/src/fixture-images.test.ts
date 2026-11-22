import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImageFixtures } from './fixture-images.js';

// Fixtures may only hold image bytes made by our own generators (see
// fixture-images.ts). Set WRITE_IMAGE_FIXTURES=1 to (re)write them.

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');
const apiDir = join(fixturesDir, 'api');
const built = buildImageFixtures();

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

if (process.env.WRITE_IMAGE_FIXTURES === '1') {
  for (const [path, value] of Object.entries(built)) {
    const file = join(apiDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serialize(value));
  }
}

/** Base64 starts of PNG, GIF and JPEG data, and the `png` field name. */
const IMAGE_MARKERS = [/"png"\s*:/, /iVBORw0KGgo/, /R0lGOD/, /\/9j\//];

function allFixtureFiles(): string[] {
  return readdirSync(fixturesDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('image fixtures', () => {
  it.each(Object.keys(built))('%s is byte-identical to our generator output', (path) => {
    expect(readFileSync(join(apiDir, path), 'utf8')).toBe(serialize(built[path]));
  });

  it('has no image data in any other fixture', () => {
    const known = new Set(Object.keys(built).map((path) => join(apiDir, path)));
    const unknown = allFixtureFiles()
      .filter((file) => !known.has(file))
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return IMAGE_MARKERS.some((marker) => marker.test(text));
      })
      .map((file) => relative(fixturesDir, file).split(sep).join('/'));
    expect(unknown).toEqual([]);
  });
});
