import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BRANDING } from '../../shared/src/branding.ts';

// release-please (release-please-config.json): one version for the whole
// repo, tags v<version>, and nothing to do with the contract package, which
// is released separately with contract-v* tags (release-contract.yml). See
// docs/decisions/0016-release-setup.md.

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const json = (path: string): unknown => JSON.parse(read(path));

interface ExtraFile {
  type: string;
  path: string;
  jsonpath?: string;
}
interface Config {
  'include-component-in-tag': boolean;
  'include-v-in-tag': boolean;
  'bump-minor-pre-major': boolean;
  'release-as'?: string;
  packages: Record<
    string,
    {
      'release-type': string;
      'initial-version': string;
      'release-as'?: string;
      'extra-files': ExtraFile[];
    }
  >;
}

const config = json('release-please-config.json') as Config;
const manifest = json('.release-please-manifest.json') as Record<string, string>;
const PACKAGES = [
  'package.json',
  'server/package.json',
  'web/package.json',
  'shared/package.json',
  'scripts/package.json',
];

describe('release-please', () => {
  it('releases the repo as one package, tagged v<version>', () => {
    expect(Object.keys(config.packages)).toEqual(['.']);
    expect(Object.keys(manifest)).toEqual(['.']);
    expect(config['include-component-in-tag']).toBe(false);
    expect(config['include-v-in-tag']).toBe(true);
    expect(config['bump-minor-pre-major']).toBe(true);
    expect(config.packages['.']?.['release-type']).toBe('node');
  });

  it('has no release-as: the first version comes from the first commit', () => {
    expect(config['release-as']).toBeUndefined();
    expect(config.packages['.']?.['release-as']).toBeUndefined();
    expect(config.packages['.']?.['initial-version']).toBe('0.1.0');
  });

  it('updates every package.json and the compose image, nothing in the contract', () => {
    const extra = config.packages['.']?.['extra-files'] ?? [];
    expect(extra.map((file) => file.path).sort()).toEqual(
      [...PACKAGES.filter((p) => p !== 'package.json'), 'docker-compose.yml'].sort(),
    );
    for (const file of extra.filter((f) => f.type === 'json'))
      expect(file.jsonpath).toBe('$.version');
    expect(read('release-please-config.json')).not.toMatch(/contract/i);
  });

  it('keeps every version the same as the manifest', () => {
    for (const path of PACKAGES) {
      expect((json(path) as { version: string }).version, path).toBe(manifest['.']);
    }
    const compose = parse(read('docker-compose.yml')) as {
      services: Record<string, { image: string }>;
    };
    expect(compose.services[BRANDING.shortName]?.image.split(':').at(-1)).toBe(manifest['.']);
  });

  it('leaves its own files to itself: Prettier does not check them', () => {
    const ignored = read('.prettierignore').split('\n');
    expect(ignored).toEqual(
      expect.arrayContaining(['CHANGELOG.md', '.release-please-manifest.json']),
    );
  });
});
