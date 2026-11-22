import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, EVENT_SCHEMA_VERSION } from '../contract.js';
import { API_SCHEMAS } from '../schemas/api/index.js';
import { EVENT_TYPES } from '../schemas/events.js';
import { JSON_SCHEMA_DIALECT } from './json-schema.js';
import {
  buildContractPackage,
  contractPackageEntries,
  contractZipName,
  FIXTURE_KINDS,
  isHidden,
  unexpectedFixturePaths,
} from './package.js';
import { createZip } from './zip.js';

describe('contract package', () => {
  const entries = contractPackageEntries();
  const paths = entries.map((entry) => entry.path);

  it('has a manifest with the contract version', () => {
    const manifest = entries.find((entry) => entry.path === 'manifest.json');
    const parsed = JSON.parse(manifest?.data.toString() ?? '{}') as Record<string, unknown>;
    expect(parsed).toMatchObject({
      contractVersion: CONTRACT_VERSION,
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      jsonSchemaDialect: JSON_SCHEMA_DIALECT,
      fixtureKinds: FIXTURE_KINDS,
    });
    expect(JSON.stringify(parsed.notes)).toContain('ingest-request.json');
  });

  it('has a JSON Schema for every event type and API schema', () => {
    const expected = [
      'schema/event.json',
      ...EVENT_TYPES.map((type) => `schema/events/${type}.json`),
      ...Object.keys(API_SCHEMAS).map((name) => `schema/api/${name}.json`),
    ];
    expect(paths.filter((path) => path.startsWith('schema/')).sort()).toEqual(expected.sort());
    for (const entry of entries.filter((e) => e.path.startsWith('schema/'))) {
      expect(JSON.parse(entry.data.toString())).toMatchObject({ $schema: JSON_SCHEMA_DIALECT });
    }
  });

  it('includes the fixtures and the license, nothing else', () => {
    expect(paths).toContain('LICENSE');
    expect(paths).toContain('fixtures/events/invalid/loot-player-with-name.json');
    expect(paths).toContain('fixtures/events/invalid-semantic/session-afk-ends-before-start.json');
    const other = paths.filter(
      (path) =>
        !['manifest.json', 'LICENSE'].includes(path) &&
        !path.startsWith('schema/') &&
        !path.startsWith('fixtures/'),
    );
    expect(other).toEqual([]);
  });

  describe('buildContractPackage', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'contract-'));
    afterAll(() => {
      rmSync(outDir, { recursive: true, force: true });
    });

    it('removes zips from other versions', () => {
      const stale = join(outDir, contractZipName('0.9.0'));
      const unrelated = join(outDir, 'other.zip');
      writeFileSync(stale, '');
      writeFileSync(unrelated, '');
      buildContractPackage(outDir);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(unrelated)).toBe(true);
    });

    it('writes the folder and a deterministic zip', () => {
      const result = buildContractPackage(outDir);
      expect(result.zipFile).toBe(join(outDir, contractZipName()));
      expect(existsSync(join(outDir, 'contract', 'schema', 'event.json'))).toBe(true);
      expect(readFileSync(result.zipFile).equals(createZip(entries))).toBe(true);
    });
  });
});

describe('unexpectedFixturePaths', () => {
  it('accepts the fixture layout', () => {
    expect(
      unexpectedFixturePaths([
        'events/valid/kc.json',
        'events/invalid/kc-negative.json',
        'events/invalid-semantic/afk.json',
        'api/kc-response/valid/bosses.json',
        'api/kc-response/invalid-semantic/x.json',
      ]),
    ).toEqual([]);
  });

  it.each([
    'events/invalid-semantics/typo.json',
    'events/kc.json',
    'events/valid/nested/kc.json',
    'events/valid/icon.png',
    'events/valid/.json',
    'api/unknown-response/valid/x.json',
    'api/kc-response/x.json',
    'api/kc-response/other/x.json',
    'README.md',
  ])('rejects %s', (path) => {
    expect(unexpectedFixturePaths([path])).toEqual([path]);
  });
});

describe('isHidden', () => {
  it.each(['events/valid/.DS_Store', '.gitkeep', '.cache/events/valid/x.json'])(
    'hides %s',
    (path) => {
      expect(isHidden(path)).toBe(true);
    },
  );

  it.each(['events/valid/kc.json', 'api/kc-response/valid/a..b.json'])('keeps %s', (path) => {
    expect(isHidden(path)).toBe(false);
  });
});
