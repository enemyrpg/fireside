import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildJsonSchemas, EVENT_SCHEMAS_BY_TYPE } from './contract-package/json-schema.js';
import { FIXTURE_KINDS, type FixtureKind as Kind } from './contract-package/package.js';
import { API_SCHEMAS, type ApiSchemaName } from './schemas/api/index.js';
import { eventSchema, EVENT_TYPES, isEventType, type EventType } from './schemas/events.js';

// Every fixture is checked against both the Zod schema and the generated JSON
// Schema. Folders:
// - valid/            accepted by both
// - invalid/          rejected by both
// - invalid-semantic/ accepted by JSON Schema, rejected by Zod (rules JSON
//                     Schema can't express, e.g. "endedAt >= startedAt")

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');
const KINDS = Object.keys(FIXTURE_KINDS) as Kind[];

const EXPECTED: Record<Kind, { zod: boolean; json: boolean }> = {
  valid: { zod: true, json: true },
  invalid: { zod: false, json: false },
  'invalid-semantic': { zod: false, json: true },
};

interface Fixture {
  file: string;
  kind: Kind;
  data: unknown;
}

/** Loads all JSON files in `dir`. Throws if `dir` is missing, unless `optional`. */
function loadDir(dir: string, kind: Kind, optional = false): Fixture[] {
  if (optional && !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      kind,
      data: JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown,
    }));
}

/** Fixtures of all kinds in `dir`. `valid/` and `invalid/` are required. */
function loadFixtures(dir: string): Fixture[] {
  return KINDS.flatMap((kind) => loadDir(join(dir, kind), kind, kind === 'invalid-semantic'));
}

const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
const jsonSchemas = buildJsonSchemas();

function compiled(path: string): ValidateFunction {
  const schema = jsonSchemas[path];
  if (!schema) throw new Error(`No generated JSON Schema ${path}`);
  return ajv.compile(schema);
}

/** Checks one fixture against both validators and reports the errors on mismatch. */
function expectBoth(zodSchema: z.ZodType, validate: ValidateFunction, fixture: Fixture) {
  const zod = zodSchema.safeParse(fixture.data);
  const json = validate(fixture.data);
  expect({
    zod: zod.success,
    json,
    zodIssues: zod.error?.issues,
    jsonErrors: validate.errors ?? undefined,
  }).toMatchObject(EXPECTED[fixture.kind]);
}

describe('event fixtures', () => {
  const dir = join(fixturesDir, 'events');
  const fixtures = loadFixtures(dir);
  const validateEvent = compiled('event.json');
  const validateByType = Object.fromEntries(
    EVENT_TYPES.map((type) => [type, compiled(`events/${type}.json`)]),
  ) as Record<EventType, ValidateFunction>;

  it('has valid fixtures for every event type', () => {
    const types = new Set(
      fixtures
        .filter((fixture) => fixture.kind === 'valid')
        .map((fixture) => (fixture.data as { type: string }).type),
    );
    expect([...types].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('includes the PLAYER-loot-with-name fixture in invalid/', () => {
    const invalid = fixtures.filter((fixture) => fixture.kind === 'invalid');
    expect(invalid.map((fixture) => fixture.file)).toContain('loot-player-with-name.json');
  });

  it('includes the raid-special-loot-with-player-name fixture in invalid/', () => {
    const invalid = fixtures.filter((fixture) => fixture.kind === 'invalid');
    expect(invalid.map((fixture) => fixture.file)).toContain(
      'raid-special-loot-with-player-name.json',
    );
  });

  it.each(fixtures.map((fixture) => [`${fixture.kind}/${fixture.file}`, fixture] as const))(
    '%s',
    (_path, fixture) => {
      expectBoth(eventSchema, validateEvent, fixture);
    },
  );

  // Fixtures with a known `type` must give the same result with the per-type schema.
  const typed = fixtures.flatMap((fixture) => {
    const type = (fixture.data as { type?: unknown }).type;
    return isEventType(type) ? [[`${fixture.kind}/${fixture.file}`, type, fixture] as const] : [];
  });

  it.each(typed)('%s (per-type schema %s)', (_path, type, fixture) => {
    expectBoth(EVENT_SCHEMAS_BY_TYPE[type], validateByType[type], fixture);
  });
});

describe('API fixtures', () => {
  const apiDir = join(fixturesDir, 'api');
  const folders = readdirSync(apiDir).sort();
  const names = Object.keys(API_SCHEMAS).sort() as ApiSchemaName[];

  it('has a fixture folder for every API schema and no others', () => {
    expect(folders).toEqual(names);
  });

  it.each(names)('has valid and invalid fixtures for %s', (name) => {
    expect(loadDir(join(apiDir, name, 'valid'), 'valid').length).toBeGreaterThan(0);
    expect(loadDir(join(apiDir, name, 'invalid'), 'invalid').length).toBeGreaterThan(0);
  });

  it('includes PLAYER-with-name fixtures in invalid/ for loot responses', () => {
    for (const name of ['loot-response', 'drops-response']) {
      const files = loadDir(join(apiDir, name, 'invalid'), 'invalid').map((f) => f.file);
      expect(files).toContain('player-with-name.json');
    }
  });

  // The fixtures ship in the contract package. A nickname is the user's own
  // name for another player, so fixtures only use obviously invented ones.
  it('uses only invented nicknames in the raid split fixtures', () => {
    const nicknames: unknown[] = [];
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          if (key === 'nickname' && typeof child === 'string') nicknames.push(child);
          else collect(child);
        }
      }
    };
    for (const name of names.filter((name) => name.startsWith('raid-'))) {
      for (const fixture of loadFixtures(join(apiDir, name))) collect(fixture.data);
    }
    expect(nicknames.length).toBeGreaterThan(0);
    for (const nickname of nicknames) expect(nickname).toMatch(/^Nickname [A-Z]$/);
  });

  const cases = names.flatMap((name) =>
    loadFixtures(join(apiDir, name)).map(
      (fixture) => [`${name}/${fixture.kind}/${fixture.file}`, name, fixture] as const,
    ),
  );
  const validators = Object.fromEntries(
    names.map((name) => [name, compiled(`api/${name}.json`)]),
  ) as Record<ApiSchemaName, ValidateFunction>;

  it.each(cases)('%s', (_path, name, fixture) => {
    expectBoth(API_SCHEMAS[name], validators[name], fixture);
  });
});
