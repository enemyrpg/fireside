import { z } from 'zod';
import { API_SCHEMAS, type ApiSchemaName } from '../schemas/api/index.js';
import {
  bankSnapshotEventSchema,
  diariesSnapshotEventSchema,
  eventSchema,
  kcEventSchema,
  lootEventSchema,
  pbRecordsEventSchema,
  petDropEventSchema,
  potionStorageSnapshotEventSchema,
  questsSnapshotEventSchema,
  raidSpecialLootEventSchema,
  sessionAfkEventSchema,
  sessionEndEventSchema,
  sessionHeartbeatEventSchema,
  sessionStartEventSchema,
  xpSnapshotEventSchema,
  type EventType,
} from '../schemas/events.js';

/** JSON Schema dialect of every generated schema. */
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** One schema per event type, so validators in other languages give clearer errors. */
export const EVENT_SCHEMAS_BY_TYPE = {
  'session.start': sessionStartEventSchema,
  'session.heartbeat': sessionHeartbeatEventSchema,
  'session.afk': sessionAfkEventSchema,
  'session.end': sessionEndEventSchema,
  'xp.snapshot': xpSnapshotEventSchema,
  loot: lootEventSchema,
  kc: kcEventSchema,
  'raid.special_loot': raidSpecialLootEventSchema,
  'pb.records': pbRecordsEventSchema,
  'bank.snapshot': bankSnapshotEventSchema,
  'potion_storage.snapshot': potionStorageSnapshotEventSchema,
  'quests.snapshot': questsSnapshotEventSchema,
  'diaries.snapshot': diariesSnapshotEventSchema,
  'pet.drop': petDropEventSchema,
} as const satisfies Record<EventType, z.ZodType>;

export type JsonSchema = Record<string, unknown>;

/**
 * API bodies the server receives. Like events, their JSON Schema describes the
 * input side: a field with a Zod default is optional for the sender.
 */
const REQUEST_SCHEMAS: ReadonlySet<string> = new Set<ApiSchemaName>([
  'ingest-request',
  'ingest-icons-wanted-request',
  'ingest-icons-request',
  'ingest-icon',
]);

function toJsonSchema(schema: z.ZodType, title: string, io: 'input' | 'output'): JsonSchema {
  // `throw` makes a schema that can't be exported fail the build instead of
  // silently becoming `{}`. Refinements are skipped: JSON Schema can't express
  // them (see the `invalid-semantic` fixtures).
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    io,
  }) as JsonSchema;
  const { $schema, ...rest } = generated;
  return { $schema, title, ...rest };
}

/**
 * All JSON Schemas in the contract package, keyed by path below `schema/`:
 * `event.json` (any event), `events/<type>.json` and `api/<name>.json`.
 * Events and request bodies use the input side (what the sender may send),
 * responses the output side (what the server returns).
 */
export function buildJsonSchemas(): Record<string, JsonSchema> {
  const schemas: Record<string, JsonSchema> = {
    'event.json': toJsonSchema(eventSchema, 'Event', 'input'),
  };
  for (const [type, schema] of Object.entries(EVENT_SCHEMAS_BY_TYPE)) {
    schemas[`events/${type}.json`] = toJsonSchema(schema, `Event: ${type}`, 'input');
  }
  for (const [name, schema] of Object.entries(API_SCHEMAS)) {
    schemas[`api/${name}.json`] = toJsonSchema(
      schema,
      `API: ${name}`,
      REQUEST_SCHEMAS.has(name) ? 'input' : 'output',
    );
  }
  return schemas;
}
