import { createHash } from 'node:crypto';
import {
  checkPng,
  decodeBase64,
  iconUploadSchemaFor,
  MAX_ICON_KEY_LENGTH,
  NAMED_ICON_KINDS,
  normalizeBossName,
  type IconRejection,
  type IconsStatusResponse,
  type IconsUploadResponse,
  type NamedIconKind,
  type NamedIconRef,
} from '@fireside/shared';
import { and, count, eq, inArray, max } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { itemIcons, namedIcons } from '../db/schema.js';
import { formatIssues } from '../ingest/validate.js';

// Icons (see docs/architecture.md#icons). Icons are assets, not events: they never go into `events` and
// `rebuild` never touches them. Item icons (`item_icons`) are keyed by the exact
// item ID used in events; the server never maps IDs (no noted → unnoted or
// placeholder lookup). Skill and boss icons (`named_icons`) are keyed by kind and
// key; a boss key is normalized with `normalizeBossName`, like boss names in KC
// data.

/** SQLite's default limit on bound parameters is far above this, but keep lookups small. */
const LOOKUP_CHUNK = 500;

/** A stored icon of any kind, as the dashboard routes serve it. */
export interface StoredIcon {
  png: Buffer;
  sha256: string;
}

/** The key a named icon is stored under: boss names are normalized, skills are kept. */
export function namedIconKey(kind: NamedIconKind, key: string): string {
  return kind === 'BOSS' ? normalizeBossName(key) : key;
}

/** The requested IDs without a stored icon, deduplicated, in request order. */
export function findMissingIcons(db: Db, itemIds: readonly number[]): number[] {
  const unique = [...new Set(itemIds)];
  const present = new Set<number>();
  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
    const chunk = unique.slice(i, i + LOOKUP_CHUNK);
    for (const row of db
      .select({ itemId: itemIcons.itemId })
      .from(itemIcons)
      .where(inArray(itemIcons.itemId, chunk))
      .all()) {
      present.add(row.itemId);
    }
  }
  return unique.filter((id) => !present.has(id));
}

/**
 * The requested skill or boss keys without a stored icon, as sent,
 * deduplicated, in request order. Boss keys are compared normalized.
 */
export function findMissingNamedIcons(
  db: Db,
  kind: NamedIconKind,
  keys: readonly string[],
): string[] {
  const unique = [...new Set(keys)];
  const stored = [...new Set(unique.map((key) => namedIconKey(kind, key)))];
  const present = new Set<string>();
  for (let i = 0; i < stored.length; i += LOOKUP_CHUNK) {
    const chunk = stored.slice(i, i + LOOKUP_CHUNK);
    for (const row of db
      .select({ key: namedIcons.key })
      .from(namedIcons)
      .where(and(eq(namedIcons.kind, kind), inArray(namedIcons.key, chunk)))
      .all()) {
      present.add(row.key);
    }
  }
  return unique.filter((key) => !present.has(namedIconKey(kind, key)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The icon's `itemId` as sent, or `null` if it is missing or not a non-negative integer. */
function rawItemId(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const id = raw.itemId;
  return Number.isSafeInteger(id) && (id as number) >= 0 ? (id as number) : null;
}

/** `kind` and `key` as sent, each `null` if it can't be echoed. */
function rawNamedRef(raw: Record<string, unknown>): Pick<IconRejection, 'kind' | 'key'> {
  const { kind, key } = raw;
  return {
    kind: NAMED_ICON_KINDS.find((known) => known === kind) ?? null,
    key:
      typeof key === 'string' && key.length >= 1 && key.length <= MAX_ICON_KEY_LENGTH ? key : null,
  };
}

interface IconImage {
  png: Buffer;
  sha256: string;
  width: number;
  height: number;
}

interface ValidItemIcon extends IconImage {
  itemId: number;
}

interface ValidNamedIcon extends IconImage {
  kind: NamedIconKind;
  /** The key as sent, for the response. */
  sentKey: string;
  /** The key it is stored under. */
  key: string;
}

function imageOf(png: string, label: string): IconImage {
  const bytes = decodeBase64(png);
  const check = checkPng(bytes);
  // The schema already ran checkPng; this narrows the type and gives the size.
  if (!check.ok) throw new Error(`Icon ${label} passed the schema but not checkPng`);
  return {
    png: Buffer.from(bytes),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: check.width,
    height: check.height,
  };
}

/** What `storeIcons` did: the answer to the plugin, and a count for the log. */
export interface StoreIconsResult {
  response: IconsUploadResponse;
  /** Valid icons that were not stored because the key has an icon with other bytes. */
  kept: number;
}

/**
 * Validates each icon on its own (one bad icon never fails the rest) and stores
 * the valid ones in one transaction. **The first icon for a key wins**: a key
 * without an icon gets one (`stored`); a key that has one is never written,
 * whether the bytes are the same or not (`unchanged`, row untouched). Icons are
 * shared by every user of the instance, so one user's key must not be able to
 * change what the others see. Different bytes are `unchanged` and not
 * `rejected`: the icon is valid and the server has one for the key, and an
 * ingest key should not learn from the answer what bytes are stored. A
 * repeated `itemId`, or kind and (normalized) key, in one request: the first is
 * used, later ones are rejected. Every icon ends up in exactly one list.
 * `storedNamed` and `unchangedNamed` are only in the answer when an icon was
 * sent with `kind`, so a client that only sends item icons gets the same answer
 * as before 1.29.0.
 */
export function storeIcons(db: Db, rawIcons: readonly unknown[], now: Date): StoreIconsResult {
  const rejected: IconRejection[] = [];
  const validItems: ValidItemIcon[] = [];
  const validNamed: ValidNamedIcon[] = [];
  const seen = new Set<string>();
  const isNamed = (raw: unknown) => isRecord(raw) && raw.kind !== undefined;
  const anyNamed = rawIcons.some(isNamed);

  rawIcons.forEach((raw, index) => {
    const named = isRecord(raw) && raw.kind !== undefined;
    const reject = (error: string) => {
      rejected.push({
        index,
        itemId: named ? null : rawItemId(raw),
        ...(named ? rawNamedRef(raw) : {}),
        error,
      });
    };
    const result = iconUploadSchemaFor(raw).safeParse(raw);
    if (!result.success) {
      reject(formatIssues(result.error.issues, 'icon'));
      return;
    }
    const icon = result.data;
    if ('itemId' in icon) {
      const id = `ITEM ${String(icon.itemId)}`;
      if (seen.has(id)) {
        reject('itemId: Duplicate itemId in request');
        return;
      }
      seen.add(id);
      validItems.push({ itemId: icon.itemId, ...imageOf(icon.png, id) });
      return;
    }
    const key = namedIconKey(icon.kind, icon.key);
    const id = `${icon.kind} ${key}`;
    if (seen.has(id)) {
      reject('key: Duplicate key in request');
      return;
    }
    seen.add(id);
    validNamed.push({ kind: icon.kind, sentKey: icon.key, key, ...imageOf(icon.png, id) });
  });

  const stored: number[] = [];
  const unchanged: number[] = [];
  const storedNamed: NamedIconRef[] = [];
  const unchangedNamed: NamedIconRef[] = [];
  const updatedAt = now.toISOString();
  let kept = 0;
  // Immediate: the check and the insert of two uploads can't interleave.
  db.transaction(
    (tx) => {
      for (const { itemId, png, sha256, width, height } of validItems) {
        const existing = tx
          .select({ sha256: itemIcons.sha256 })
          .from(itemIcons)
          .where(eq(itemIcons.itemId, itemId))
          .get();
        if (existing) {
          if (existing.sha256 !== sha256) kept++;
          unchanged.push(itemId);
          continue;
        }
        tx.insert(itemIcons).values({ itemId, png, sha256, width, height, updatedAt }).run();
        stored.push(itemId);
      }
      for (const { kind, sentKey, key, png, sha256, width, height } of validNamed) {
        const ref = { kind, key: sentKey };
        const existing = tx
          .select({ sha256: namedIcons.sha256 })
          .from(namedIcons)
          .where(and(eq(namedIcons.kind, kind), eq(namedIcons.key, key)))
          .get();
        if (existing) {
          if (existing.sha256 !== sha256) kept++;
          unchangedNamed.push(ref);
          continue;
        }
        tx.insert(namedIcons).values({ kind, key, png, sha256, width, height, updatedAt }).run();
        storedNamed.push(ref);
      }
    },
    { behavior: 'immediate' },
  );
  return {
    response: { stored, unchanged, rejected, ...(anyNamed ? { storedNamed, unchangedNamed } : {}) },
    kept,
  };
}

/** The stored item icon, or `undefined`. */
export function getIcon(db: Db, itemId: number): StoredIcon | undefined {
  return db
    .select({ png: itemIcons.png, sha256: itemIcons.sha256 })
    .from(itemIcons)
    .where(eq(itemIcons.itemId, itemId))
    .get();
}

function getNamedIcon(db: Db, kind: NamedIconKind, key: string): StoredIcon | undefined {
  return db
    .select({ png: namedIcons.png, sha256: namedIcons.sha256 })
    .from(namedIcons)
    .where(and(eq(namedIcons.kind, kind), eq(namedIcons.key, key)))
    .get();
}

/** The stored skill icon, or `undefined`. */
export function getSkillIcon(db: Db, skill: string): StoredIcon | undefined {
  return getNamedIcon(db, 'SKILL', skill);
}

/**
 * The stored icon of a boss or raid, by any known alias, or `undefined`. A
 * raid mode without an icon of its own (the game has none for the entry
 * modes) gets its raid's: the name before the colon.
 */
export function getBossIcon(db: Db, boss: string): StoredIcon | undefined {
  // Normalized first, so an alias written without a colon finds its raid too.
  const name = normalizeBossName(boss);
  const own = getNamedIcon(db, 'BOSS', name);
  const colon = name.indexOf(':');
  if (own || colon === -1) return own;
  return getNamedIcon(db, 'BOSS', normalizeBossName(name.slice(0, colon)));
}

/** How many icons are stored per kind, and when one was last stored. */
export function iconsStatus(db: Db): IconsStatusResponse {
  const items = db
    .select({ n: count(), last: max(itemIcons.updatedAt) })
    .from(itemIcons)
    .get();
  const named = db
    .select({ kind: namedIcons.kind, n: count(), last: max(namedIcons.updatedAt) })
    .from(namedIcons)
    .groupBy(namedIcons.kind)
    .all();
  const of = (kind: NamedIconKind) => named.find((row) => row.kind === kind)?.n ?? 0;
  // ISO timestamps from `toISOString()` sort as text.
  const last = [items?.last, ...named.map((row) => row.last)]
    .filter((value): value is string => typeof value === 'string')
    .sort()
    .at(-1);
  return {
    items: items?.n ?? 0,
    skills: of('SKILL'),
    bosses: of('BOSS'),
    lastStoredAt: last ?? null,
  };
}
