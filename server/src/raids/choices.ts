import { randomBytes } from 'node:crypto';
import {
  EARLIEST_MANUAL_DROP_AT,
  MAX_DROP_NICKNAME_LENGTH,
  MAX_DROP_NOTE_LENGTH,
  normalizeBossName,
  raidOf,
  type RaidDropCreateRequest,
  type RaidDropUpdateRequest,
  type RaidLootRecipient,
  type SplitMode,
} from '@fireside/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { raidDropChoices, raidManualDrops, raidSplitDefaults } from '../db/schema.js';
import {
  findTrackedDrop,
  manualDropPrice,
  type ChoiceKey,
  type DropChoices,
} from '../read/raid-splits.js';
import { characterCount, UNSAFE_TEXT_CHARS } from '../text.js';

// Writes for the raid loot split tracker: the user's own choices, stored outside raw
// events and derived tables. Nicknames and notes must never be logged: nothing here logs,
// and errors never quote the text.

/** A value the user sent that can't be stored. `field` is the body field; the message is safe to show. */
export class InvalidChoiceError extends Error {
  override name = 'InvalidChoiceError';
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

const NICKNAME_TEAMMATE_ONLY = 'Only a teammate’s drop can have a nickname';

/** Trims a nickname or note. Empty means not set (`null`). Throws `InvalidChoiceError`. */
export function normalizeChoiceText(
  field: 'nickname' | 'note',
  text: string | null,
): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const max = field === 'nickname' ? MAX_DROP_NICKNAME_LENGTH : MAX_DROP_NOTE_LENGTH;
  if (characterCount(trimmed) > max) {
    throw new InvalidChoiceError(field, `Too long (max ${String(max)} characters)`);
  }
  if (UNSAFE_TEXT_CHARS.test(trimmed)) {
    throw new InvalidChoiceError(field, 'Must not contain control characters or line breaks');
  }
  return trimmed;
}

/** A UUIDv7 for time `ms`, with random bits from the OS. */
export function newUuidV7(ms: number): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** Sets the account's default mode. */
export function setSplitDefault(db: Db, accountId: number, mode: SplitMode, now: Date): void {
  const updatedAt = now.toISOString();
  db.insert(raidSplitDefaults)
    .values({ accountId, mode, updatedAt })
    .onConflictDoUpdate({ target: raidSplitDefaults.accountId, set: { mode, updatedAt } })
    .run();
}

function choiceRow(key: ChoiceKey) {
  return and(
    eq(raidDropChoices.eventId, key.eventId),
    eq(raidDropChoices.itemIndex, key.itemIndex),
  );
}

/**
 * Changes a drop's choices: a field left out of `changes` is unchanged,
 * `null` clears it. Returns the drop's current ID, or `undefined` if the
 * account has no such drop. Throws `InvalidChoiceError`.
 */
export function updateDropChoices(
  db: Db,
  accountId: number,
  dropId: string,
  changes: RaidDropUpdateRequest,
  now: Date,
): string | undefined {
  return db.transaction((tx) => {
    const tracked = findTrackedDrop(tx, accountId, dropId);
    if (!tracked) return undefined;
    const { drop, storage } = tracked;

    const next: DropChoices = {
      mode: changes.mode !== undefined ? changes.mode : drop.overridden ? drop.mode : null,
      ownValue: changes.ownValue !== undefined ? changes.ownValue : drop.ownValue,
      partySize:
        changes.partySize !== undefined
          ? changes.partySize
          : drop.partySizeOverridden
            ? drop.partySize
            : null,
      nickname:
        changes.nickname !== undefined
          ? normalizeChoiceText('nickname', changes.nickname)
          : drop.nickname,
      note: changes.note !== undefined ? normalizeChoiceText('note', changes.note) : drop.note,
    };
    if (next.nickname !== null && drop.recipient !== 'TEAMMATE') {
      throw new InvalidChoiceError('nickname', NICKNAME_TEAMMATE_ONLY);
    }

    const updatedAt = now.toISOString();
    if (storage.kind === 'manual') {
      tx.update(raidManualDrops)
        .set({ ...next, updatedAt })
        .where(eq(raidManualDrops.id, storage.id))
        .run();
    } else {
      // The edit collapses the drop's rows: what the owner saw (both keys
      // merged) plus the changes is the whole row under `key`, and the chest
      // row goes. A field the owner cleared stays cleared.
      const { key, chestKey } = storage;
      if (chestKey) tx.delete(raidDropChoices).where(choiceRow(chestKey)).run();
      if (Object.values(next).every((value) => value === null)) {
        // Nothing set: no row, so the table only holds real choices.
        tx.delete(raidDropChoices).where(choiceRow(key)).run();
      } else {
        tx.insert(raidDropChoices)
          .values({ ...key, ...next, updatedAt })
          .onConflictDoUpdate({
            target: [raidDropChoices.eventId, raidDropChoices.itemIndex],
            set: { ...next, updatedAt },
          })
          .run();
      }
    }
    return drop.dropId;
  });
}

/**
 * Adds a purple the plugin didn't record by hand, the owner's own or a
 * teammate's (the default), and returns its ID. `raid` must be a mode of a
 * raid in `RAIDS` and `itemId` one of that raid's purples; the item's name
 * comes from `RAIDS`. `occurredAt` is between Old School's launch and now.
 * The GE price is looked up now and stored with the drop; without one the
 * value stays unknown until the user gives it. Only a teammate's drop can
 * have a nickname. Throws `InvalidChoiceError`.
 */
export function createManualDrop(
  db: Db,
  accountId: number,
  input: RaidDropCreateRequest,
  now: Date,
): string {
  const raidName = normalizeBossName(input.raid);
  const raid = raidOf(raidName);
  if (!raid) throw new InvalidChoiceError('raid', 'Unknown raid');
  const purple = raid.purples.find((item) => item.itemId === input.itemId);
  if (!purple) throw new InvalidChoiceError('itemId', 'Not a unique drop from this raid');
  // Timestamps have one format, so string comparison is chronological.
  if (input.occurredAt < EARLIEST_MANUAL_DROP_AT) {
    throw new InvalidChoiceError('occurredAt', 'Must not be before Old School RuneScape launched');
  }
  if (Date.parse(input.occurredAt) > now.getTime()) {
    throw new InvalidChoiceError('occurredAt', 'Must not be in the future');
  }
  const recipient: RaidLootRecipient = input.recipient ?? 'TEAMMATE';
  const nickname = normalizeChoiceText('nickname', input.nickname ?? null);
  if (nickname !== null && recipient !== 'TEAMMATE') {
    throw new InvalidChoiceError('nickname', NICKNAME_TEAMMATE_ONLY);
  }
  const note = normalizeChoiceText('note', input.note ?? null);
  const id = newUuidV7(now.getTime());
  const at = now.toISOString();
  return db.transaction((tx) => {
    const price = manualDropPrice(tx, accountId, purple.itemId, input.occurredAt);
    tx.insert(raidManualDrops)
      .values({
        id,
        accountId,
        occurredAt: input.occurredAt,
        raid: raidName,
        raidGroup: raid.name,
        itemId: purple.itemId,
        itemName: purple.name,
        recipient,
        gePriceEach: price?.price ?? null,
        gePriceSource: price?.source ?? null,
        gePriceAt: price?.at ?? null,
        mode: input.mode ?? null,
        ownValue: input.ownValue ?? null,
        partySize: input.partySize ?? null,
        nickname,
        note,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    return id;
  });
}

/** Deletes a manual drop. Detected drops come from events and can't be deleted. */
export function deleteManualDrop(
  db: Db,
  accountId: number,
  dropId: string,
): 'deleted' | 'not-manual' | 'not-found' {
  return db.transaction((tx) => {
    const tracked = findTrackedDrop(tx, accountId, dropId);
    if (!tracked) return 'not-found';
    if (tracked.storage.kind !== 'manual') return 'not-manual';
    tx.delete(raidManualDrops).where(eq(raidManualDrops.id, tracked.storage.id)).run();
    return 'deleted';
  });
}
