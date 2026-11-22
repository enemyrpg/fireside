import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { CONTRACT_VERSION, EVENT_SCHEMA_VERSION } from '../contract.js';
import { API_SCHEMAS } from '../schemas/api/index.js';
import { buildJsonSchemas, JSON_SCHEMA_DIALECT } from './json-schema.js';
import { createZip, type ZipEntry } from './zip.js';

// Builds the contract package for the plugin repo: generated JSON Schemas,
// fixtures, a manifest and the license. See
// docs/architecture.md#the-contract-package. Same relative paths from src/ and
// dist/.
const sharedDir = join(import.meta.dirname, '..', '..');
const fixturesDir = join(sharedDir, 'fixtures');
const licenseFile = join(sharedDir, '..', 'LICENSE');

/** The fixture folders, with the explanation that goes into the manifest. */
export const FIXTURE_KINDS = {
  valid: 'Accepted by the server and by the JSON Schema.',
  invalid: 'Rejected by the server and by the JSON Schema.',
  'invalid-semantic':
    'Rejected by the server, but accepted by the JSON Schema: the rule (e.g. "endedAt >= startedAt") cannot be expressed in JSON Schema.',
} as const;

export type FixtureKind = keyof typeof FIXTURE_KINDS;

/** Extra notes for whoever uses the package. */
const NOTES = [
  'schema/api/ingest-request.json does not check the events in a batch. Validate each event against schema/event.json.',
  'schema/api/ingest-icons-request.json does not check the icons in a request. Validate each icon against schema/api/ingest-icon.json. The PNG structure (IHDR, at most 64x64, CRCs, IEND, no APNG) is only checked by the server; see the invalid-semantic fixtures of ingest-icon.',
  'schema/api/ingest-icon.json: an icon without "kind" is an item icon. "kind" SKILL or BOSS with "key" needs server contract 1.29.0 or newer, and so do "skills" and "bosses" in ingest-icons-wanted-request.json; an older server rejects them.',
];

/**
 * Fixture paths (relative to `fixtures/`) that don't fit the layout
 * `events/<kind>/<file>.json` or `api/<schema name>/<kind>/<file>.json`.
 * Anything else would ship in the package without being tested.
 */
export function unexpectedFixturePaths(paths: readonly string[]): string[] {
  const kinds: readonly string[] = Object.keys(FIXTURE_KINDS);
  const apiNames: readonly string[] = Object.keys(API_SCHEMAS);
  return paths.filter((path) => {
    const parts = path.split('/');
    const file = parts.at(-1) ?? '';
    const isJson = file.endsWith('.json') && file.length > '.json'.length;
    if (parts[0] === 'events' && parts.length === 3) {
      return !(kinds.includes(parts[1] ?? '') && isJson);
    }
    if (parts[0] === 'api' && parts.length === 4) {
      return !(apiNames.includes(parts[1] ?? '') && kinds.includes(parts[2] ?? '') && isJson);
    }
    return true;
  });
}

export interface ContractPackage {
  /** Folder with the unpacked package. */
  dir: string;
  zipFile: string;
  entries: ZipEntry[];
}

export function contractZipName(version = CONTRACT_VERSION): string {
  return `contract-v${version}.zip`;
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

/** Files below `dir` (not hidden ones), as paths relative to it with `/` separators. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => !isHidden(path))
    .sort();
}

/** Dotfiles such as `.DS_Store` or `.gitkeep`, or anything in a dot folder. */
export function isHidden(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

/** Collects the package files in memory. */
export function contractPackageEntries(): ZipEntry[] {
  const schemas = buildJsonSchemas();
  const schemaPaths = Object.keys(schemas)
    .sort()
    .map((path) => `schema/${path}`);

  const fixtureFiles = listFiles(fixturesDir);
  // Also keeps icons and other non-JSON files out of the package.
  const unexpected = unexpectedFixturePaths(fixtureFiles);
  if (unexpected.length > 0) {
    throw new Error(`Unexpected files in fixtures/: ${unexpected.join(', ')}`);
  }

  const manifest = {
    contractVersion: CONTRACT_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    schemas: schemaPaths,
    fixtureKinds: FIXTURE_KINDS,
    notes: NOTES,
  };

  return [
    { path: 'manifest.json', data: json(manifest) },
    { path: 'LICENSE', data: readFileSync(licenseFile) },
    ...Object.entries(schemas).map(([path, schema]) => ({
      path: `schema/${path}`,
      data: json(schema),
    })),
    ...fixtureFiles.map((path) => ({
      path: `fixtures/${path}`,
      data: readFileSync(join(fixturesDir, path)),
    })),
  ];
}

/**
 * Writes the package to `<outDir>/contract/` and `<outDir>/contract-v<version>.zip`.
 * The `contract/` folder and zips from other versions are removed first, so
 * `outDir` only holds the current package.
 */
export function buildContractPackage(outDir: string): ContractPackage {
  const entries = contractPackageEntries();
  const dir = join(outDir, 'contract');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const file of readdirSync(outDir)) {
    if (/^contract-v.*\.zip$/.test(file)) rmSync(join(outDir, file));
  }
  for (const entry of entries) {
    const file = join(dir, entry.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, entry.data);
  }
  const zipFile = join(outDir, contractZipName());
  writeFileSync(zipFile, createZip(entries));
  return { dir, zipFile, entries };
}
