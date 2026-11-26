import {
  DEFAULT_SPLIT_MODE,
  periodKey,
  periodsBetween,
  POSSIBLE_DUPLICATE_WINDOW_MS,
  raidDropShare,
  RAIDS,
  type GePriceSource,
  type Page,
  type RaidDrop,
  type RaidLootRecipient,
  type RaidShare,
  type RaidShareMonth,
  type RaidShareTotal,
  type RaidSplitDefault,
  type SplitMode,
} from '@fireside/shared';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Queryable } from '../db/index.js';
import {
  accountIds,
  accounts,
  bankSnapshotItems,
  bankSnapshots,
  lootEvents,
  lootItems,
  raidDropChoices,
  raidManualDrops,
  raidSpecialLoot,
  raidSplitDefaults,
} from '../db/schema.js';
import { capLootValue } from '../projections/session-summaries.js';
import { mergeChoices, type ChoiceRow } from '../raids/choice-keys.js';
import { cursorParts, decodeCursor, encodeCursor } from './cursor.js';
import { chestEvent, chestItem, purpleGePrice, purpleQuantity, specialScope } from './raids.js';

// Raid loot split tracker. Reads the purples exactly like `GET …/raids` does
// (`raid_special_loot` with the chest item for linked purples), adds the manual
// drops (the owner's own and teammates') and the user's choices, and works out
// the share of each drop. A manual drop's GE price is stored when the drop is
// added, never looked up when read, so a share only changes when the user
// changes something.
//
// There are few purples (tens to hundreds), so every drop in scope is read
// and the sums, the months and the page are made in memory.

/** The user's choices for a drop. `null` = not set. */
export interface DropChoices {
  mode: SplitMode | null;
  ownValue: number | null;
  partySize: number | null;
  nickname: string | null;
  note: string | null;
}

/** Where a drop's choices are stored. */
export type DropStorage =
  | { kind: 'manual'; id: string }
  | {
      kind: 'event';
      /** The key the drop's choices are written under: its event's, else its chest's. */
      key: ChoiceKey;
      /**
       * The drop's chest key if it also has an event key. Rows under it are
       * read too, and an edit removes them (merged into the row under `key`).
       */
      chestKey: ChoiceKey | undefined;
    };

export interface ChoiceKey {
  eventId: string;
  itemIndex: number;
}

/** A drop as returned, plus its sort key and where its choices live. */
export interface TrackedDrop {
  drop: RaidDrop;
  /** Sort key after `occurredAt`: the event (or manual drop) ID and the item index. */
  keyId: string;
  keyIndex: number;
  storage: DropStorage;
  /** Also matches this drop: the chest key of a purple that now has its own event. */
  chestDropId: string | undefined;
}

const NO_CHOICES: DropChoices = {
  mode: null,
  ownValue: null,
  partySize: null,
  nickname: null,
  note: null,
};

function choiceMapKey(key: ChoiceKey): string {
  return `${key.eventId}.${String(key.itemIndex)}`;
}

/** Stored text is `SPLIT` or `FFA`; anything else counts as not set. */
function modeOf(value: string | null): SplitMode | null {
  return value === 'SPLIT' || value === 'FFA' ? value : null;
}

// --- Prices for manual drops ----------------------------------------------------

export interface SeenPrice {
  at: string;
  price: number;
  source: Exclude<GePriceSource, 'DROP'>;
}

// On a tie in time, the price closest to a raid drop wins.
const MANUAL_PRICE_SOURCES = ['SPECIAL_LOOT', 'LOOT', 'BANK'] as const;
const SOURCE_ORDER: readonly GePriceSource[] = MANUAL_PRICE_SOURCES;

/**
 * Every GE price above 0 the user's own data has for the items: purples, loot
 * items and the items of each account's latest bank snapshot, over all
 * accounts of `userId` (a price is the same for every account) and never
 * another user's.
 */
function seenPrices(
  db: Queryable,
  userId: number,
  itemIds: readonly number[],
): Map<number, SeenPrice[]> {
  const prices = new Map<number, SeenPrice[]>();
  if (itemIds.length === 0) return prices;
  const ownAccounts = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  const add = (itemId: number, price: SeenPrice) => {
    const list = prices.get(itemId);
    if (list) list.push(price);
    else prices.set(itemId, [price]);
  };

  const purples = db
    .select({
      itemId: raidSpecialLoot.itemId,
      at: raidSpecialLoot.occurredAt,
      price: raidSpecialLoot.gePriceEach,
    })
    .from(raidSpecialLoot)
    .where(
      and(
        inArray(raidSpecialLoot.accountId, ownAccounts),
        inArray(raidSpecialLoot.itemId, [...itemIds]),
        gt(raidSpecialLoot.gePriceEach, 0),
      ),
    )
    .all();
  for (const row of purples)
    add(row.itemId, { at: row.at, price: row.price, source: 'SPECIAL_LOOT' });

  const loot = db
    .select({ itemId: lootItems.itemId, at: lootEvents.occurredAt, price: lootItems.gePriceEach })
    .from(lootItems)
    .innerJoin(lootEvents, eq(lootItems.lootEventId, lootEvents.id))
    .where(
      and(
        inArray(lootEvents.accountId, ownAccounts),
        inArray(lootItems.itemId, [...itemIds]),
        gt(lootItems.gePriceEach, 0),
      ),
    )
    .all();
  for (const row of loot) add(row.itemId, { at: row.at, price: row.price, source: 'LOOT' });

  const bank = db
    .select({
      itemId: bankSnapshotItems.itemId,
      at: bankSnapshots.takenAt,
      price: bankSnapshotItems.geEach,
    })
    .from(bankSnapshotItems)
    .innerJoin(bankSnapshots, eq(bankSnapshotItems.snapshotId, bankSnapshots.id))
    .where(
      and(
        inArray(bankSnapshots.accountId, ownAccounts),
        inArray(bankSnapshotItems.itemId, [...itemIds]),
        gt(bankSnapshotItems.geEach, 0),
      ),
    )
    .all();
  for (const row of bank) add(row.itemId, { at: row.at, price: row.price, source: 'BANK' });

  return prices;
}

/**
 * The price to use for a manual drop at `occurredAt`: the latest one seen at
 * or before it, else the newest one. `undefined` if the item was never seen.
 */
function priceAt(prices: readonly SeenPrice[], occurredAt: string): SeenPrice | undefined {
  const newest = (candidates: readonly SeenPrice[]) =>
    candidates.reduce<SeenPrice | undefined>((best, price) => {
      if (!best || price.at > best.at) return price;
      if (price.at < best.at) return best;
      // Same instant: fixed source order, then the higher price, so the result is stable.
      const order = SOURCE_ORDER.indexOf(price.source) - SOURCE_ORDER.indexOf(best.source);
      if (order !== 0) return order < 0 ? price : best;
      return price.price > best.price ? price : best;
    }, undefined);
  return newest(prices.filter((price) => price.at <= occurredAt)) ?? newest(prices);
}

/**
 * The GE price for a manual drop of `itemId` at `occurredAt` on `accountId`,
 * from the data of the account's owner as it is now (any of that user's
 * accounts, never another user's). Used once, when the drop is added: the
 * price is stored with the drop and never looked up again.
 */
export function manualDropPrice(
  db: Queryable,
  accountId: number,
  itemId: number,
  occurredAt: string,
): SeenPrice | undefined {
  const owner = db
    .select({ userId: accountIds.userId })
    .from(accountIds)
    .where(eq(accountIds.id, accountId))
    .get();
  if (!owner) return undefined;
  return priceAt(seenPrices(db, owner.userId, [itemId]).get(itemId) ?? [], occurredAt);
}

// --- Drops ----------------------------------------------------------------------

interface DropFacts {
  dropId: string;
  manual: boolean;
  occurredAt: string;
  accountId: number;
  sessionId: string | null;
  raid: string;
  raidGroup: string;
  itemId: number;
  name: string;
  quantity: number;
  price: { each: number; source: GePriceSource; at: string } | undefined;
  recipient: RaidLootRecipient;
  teamSize: number | null;
  killCount: number | null;
}

/** The drop as returned: the facts, the choices and the share they give. */
export function trackedDrop(
  facts: DropFacts,
  choices: DropChoices,
  accountDefault: SplitMode,
): RaidDrop {
  const geValue = facts.price ? capLootValue(facts.quantity * facts.price.each) : null;
  const value = choices.ownValue ?? geValue;
  const mode = choices.mode ?? accountDefault;
  const partySize = choices.partySize ?? facts.teamSize;
  return {
    dropId: facts.dropId,
    manual: facts.manual,
    occurredAt: facts.occurredAt,
    accountId: facts.accountId,
    sessionId: facts.sessionId,
    raid: facts.raid,
    raidGroup: facts.raidGroup,
    itemId: facts.itemId,
    name: facts.name,
    quantity: facts.quantity,
    gePriceEach: facts.price?.each ?? null,
    geValue,
    gePriceSource: facts.price?.source ?? null,
    gePriceAt: facts.price?.at ?? null,
    ownValue: choices.ownValue,
    value,
    valueUnknown: value === null,
    recipient: facts.recipient,
    mode,
    overridden: choices.mode !== null,
    teamSize: facts.teamSize,
    partySize,
    partySizeOverridden: choices.partySize !== null,
    partySizeUnknown: mode === 'SPLIT' && partySize === null,
    share: raidDropShare({ value, mode, recipient: facts.recipient, partySize }),
    // A nickname is only for a teammate's drop (checked when written).
    nickname: facts.recipient === 'TEAMMATE' ? choices.nickname : null,
    note: choices.note,
    killCount: facts.killCount,
    possibleDuplicate: false,
    duplicateOfDropId: null,
  };
}

/** Newest first: `occurredAt` descending, key ID descending, index ascending. */
function compareDrops(
  a: { at: string; keyId: string; keyIndex: number },
  b: { at: string; keyId: string; keyIndex: number },
): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.keyId !== b.keyId) return a.keyId < b.keyId ? 1 : -1;
  return a.keyIndex - b.keyIndex;
}

function sortKey(tracked: TrackedDrop) {
  return { at: tracked.drop.occurredAt, keyId: tracked.keyId, keyIndex: tracked.keyIndex };
}

/**
 * Marks each manual drop that has a detected purple of the same item and
 * recipient in the same raid, for the same account, within the window: a
 * teammate's manual drop against detected teammate purples, an own one
 * against detected own purples (also those only known from the chest). The
 * closest in time is named. Nothing is merged or hidden.
 */
function markPossibleDuplicates(drops: readonly TrackedDrop[]): void {
  const detected = drops.filter(({ drop }) => !drop.manual);
  for (const { drop } of drops) {
    if (!drop.manual) continue;
    const at = Date.parse(drop.occurredAt);
    let closest: { dropId: string; distance: number } | undefined;
    for (const { drop: other } of detected) {
      if (
        other.recipient !== drop.recipient ||
        other.accountId !== drop.accountId ||
        other.itemId !== drop.itemId ||
        other.raidGroup !== drop.raidGroup
      ) {
        continue;
      }
      const distance = Math.abs(Date.parse(other.occurredAt) - at);
      if (distance > POSSIBLE_DUPLICATE_WINDOW_MS) continue;
      // `detected` is newest first, so a tie keeps the newer drop.
      if (!closest || distance < closest.distance) closest = { dropId: other.dropId, distance };
    }
    if (closest) {
      drop.possibleDuplicate = true;
      drop.duplicateOfDropId = closest.dropId;
    }
  }
}

/** The default mode per account that has chosen one. */
function storedDefaults(db: Queryable, accountIds: readonly number[]): Map<number, SplitMode> {
  const modes = new Map<number, SplitMode>();
  const rows = db
    .select()
    .from(raidSplitDefaults)
    .where(inArray(raidSplitDefaults.accountId, accountIds))
    .all();
  for (const row of rows) {
    const mode = modeOf(row.mode);
    if (mode) modes.set(row.accountId, mode);
  }
  return modes;
}

/** The account's default mode. */
export function splitDefault(db: Queryable, accountId: number): RaidSplitDefault {
  return { accountId, mode: storedDefaults(db, [accountId]).get(accountId) ?? DEFAULT_SPLIT_MODE };
}

/**
 * Every purple of the given (owned) accounts, detected and manual, with
 * choices and share, newest first.
 */
export function trackedDrops(db: Queryable, accountIds: readonly number[]): TrackedDrop[] {
  const defaults = storedDefaults(db, accountIds);
  const defaultOf = (accountId: number) => defaults.get(accountId) ?? DEFAULT_SPLIT_MODE;

  const choices = new Map<string, ChoiceRow>();
  for (const row of db.select().from(raidDropChoices).all()) choices.set(choiceMapKey(row), row);
  const choicesOf = (row: ChoiceRow | undefined): DropChoices =>
    row
      ? {
          mode: modeOf(row.mode),
          ownValue: row.ownValue,
          partySize: row.partySize,
          nickname: row.nickname,
          note: row.note,
        }
      : NO_CHOICES;

  // The same rows and LEFT JOIN as the special loot list in `raids.ts`.
  const detected = db
    .select({
      occurredAt: raidSpecialLoot.occurredAt,
      accountId: raidSpecialLoot.accountId,
      sessionId: raidSpecialLoot.sessionId,
      raid: raidSpecialLoot.raid,
      raidGroup: raidSpecialLoot.raidGroup,
      itemId: raidSpecialLoot.itemId,
      name: raidSpecialLoot.itemName,
      quantity: purpleQuantity,
      gePriceEach: purpleGePrice,
      recipient: raidSpecialLoot.recipient,
      teamSize: raidSpecialLoot.teamSize,
      killCount: raidSpecialLoot.killCount,
      specialEventId: raidSpecialLoot.specialEventId,
      lootEventId: raidSpecialLoot.lootEventId,
      lootItemPosition: raidSpecialLoot.lootItemPosition,
    })
    .from(raidSpecialLoot)
    .leftJoin(lootEvents, chestEvent)
    .leftJoin(lootItems, chestItem)
    .where(specialScope(accountIds))
    .all();

  const drops: TrackedDrop[] = [];
  for (const row of detected) {
    const chestKey: ChoiceKey | undefined =
      row.lootEventId !== null && row.lootItemPosition !== null
        ? { eventId: row.lootEventId, itemIndex: row.lootItemPosition }
        : undefined;
    const eventKey: ChoiceKey | undefined =
      row.specialEventId !== null ? { eventId: row.specialEventId, itemIndex: 0 } : undefined;
    const key = eventKey ?? chestKey;
    // Every row has one of the two events.
    if (!key) continue;
    const chestDropId = chestKey ? choiceMapKey(chestKey) : undefined;
    // Choices made while the purple was only known from the chest stay under
    // the chest key until the owner edits the drop: the chest an event is
    // matched with can still change. Both rows are read and merged
    // (docs/decisions/0020-raid-split-choice-keys.md).
    const eventRow = choices.get(choiceMapKey(key));
    const chestRow = eventKey && chestKey ? choices.get(choiceMapKey(chestKey)) : undefined;
    const merged = eventRow && chestRow ? mergeChoices(eventRow, chestRow) : (eventRow ?? chestRow);
    drops.push({
      drop: trackedDrop(
        {
          dropId: eventKey ? eventKey.eventId : choiceMapKey(key),
          manual: false,
          occurredAt: row.occurredAt,
          accountId: row.accountId,
          sessionId: row.sessionId,
          raid: row.raid,
          raidGroup: row.raidGroup,
          itemId: row.itemId,
          name: row.name,
          quantity: row.quantity,
          price: { each: row.gePriceEach, source: 'DROP', at: row.occurredAt },
          recipient: row.recipient as RaidLootRecipient,
          teamSize: row.teamSize,
          killCount: row.killCount,
        },
        choicesOf(merged),
        defaultOf(row.accountId),
      ),
      keyId: key.eventId,
      keyIndex: key.itemIndex,
      storage: { kind: 'event', key, chestKey: eventKey ? chestKey : undefined },
      chestDropId: eventKey ? chestDropId : undefined,
    });
  }

  const manual = db
    .select()
    .from(raidManualDrops)
    .where(inArray(raidManualDrops.accountId, accountIds))
    .all();
  for (const row of manual) {
    // The price stored when the drop was added, if there was one.
    const source = MANUAL_PRICE_SOURCES.find((candidate) => candidate === row.gePriceSource);
    const price =
      row.gePriceEach !== null && row.gePriceAt !== null && source
        ? { each: row.gePriceEach, source, at: row.gePriceAt }
        : undefined;
    drops.push({
      drop: trackedDrop(
        {
          dropId: row.id,
          manual: true,
          occurredAt: row.occurredAt,
          accountId: row.accountId,
          sessionId: null,
          raid: row.raid,
          raidGroup: row.raidGroup,
          itemId: row.itemId,
          name: row.itemName,
          quantity: 1,
          price,
          // Anything but `SELF` (rows from before own purples could be added by
          // hand have the default) is a teammate's.
          recipient: row.recipient === 'SELF' ? 'SELF' : 'TEAMMATE',
          teamSize: null,
          killCount: null,
        },
        {
          mode: modeOf(row.mode),
          ownValue: row.ownValue,
          partySize: row.partySize,
          nickname: row.nickname,
          note: row.note,
        },
        defaultOf(row.accountId),
      ),
      keyId: row.id,
      keyIndex: 0,
      storage: { kind: 'manual', id: row.id },
      chestDropId: undefined,
    });
  }

  drops.sort((a, b) => compareDrops(sortKey(a), sortKey(b)));
  markPossibleDuplicates(drops);
  return drops;
}

/**
 * One of the account's drops by ID. A purple that got its own event after
 * the ID was handed out is still found by its old chest ID.
 */
export function findTrackedDrop(
  db: Queryable,
  accountId: number,
  dropId: string,
): TrackedDrop | undefined {
  const drops = trackedDrops(db, [accountId]);
  return (
    drops.find((tracked) => tracked.drop.dropId === dropId) ??
    drops.find((tracked) => tracked.chestDropId === dropId)
  );
}

// --- Overview -------------------------------------------------------------------

/** Cursor key: (`occurred_at`, event or manual drop ID, index), as for the special loot list. */
const dropCursorSchema = z.tuple([cursorParts.timestamp, cursorParts.eventId, cursorParts.index]);

export interface RaidSplitsOptions {
  /** The accounts to read: owned account IDs, resolved by the route. */
  accountIds: readonly number[];
  cursor?: string | undefined;
  limit: number;
  timeZone: string;
  now: Date;
}

export interface RaidSplits {
  defaults: RaidSplitDefault[];
  total: RaidShareTotal;
  raids: RaidShare[];
  months: RaidShareMonth[];
  drops: Page<RaidDrop>;
}

interface Sums {
  own: number;
  teammates: number;
}

interface RaidSums extends Sums {
  /** GE value of the own purples added by hand. */
  manualSpecialLoot: number;
}

const noRaidSums = (): RaidSums => ({ own: 0, teammates: 0, manualSpecialLoot: 0 });

/**
 * What an own purple added by hand adds to its raid's special loot: its GE
 * value, like every other loot value. Only without a GE price is it what the
 * user says it sold for, and 0 without that too. ("Sold for" still decides
 * the drop's value and the share.)
 */
function manualSpecialLootValue(drop: RaidDrop): number {
  if (!drop.manual || drop.recipient !== 'SELF') return 0;
  return drop.geValue ?? drop.ownValue ?? 0;
}

function shareSums(sums: Sums): RaidShareTotal {
  const fromOwnDrops = capLootValue(sums.own);
  const fromTeammateDrops = capLootValue(sums.teammates);
  return { share: capLootValue(fromOwnDrops + fromTeammateDrops), fromOwnDrops, fromTeammateDrops };
}

/** Your share in total, per raid and per local month, and one page of drops. */
export function raidSplits(db: Queryable, options: RaidSplitsOptions): RaidSplits {
  const { accountIds, timeZone } = options;
  const tracked = trackedDrops(db, accountIds);

  const total: Sums = { own: 0, teammates: 0 };
  const byRaid = new Map<string, RaidSums>(RAIDS.map((raid) => [raid.name, noRaidSums()]));
  const byMonth = new Map<string, number>();
  for (const { drop } of tracked) {
    // A share that can't be worked out (`null`) counts 0.
    const share = drop.share ?? 0;
    const field = drop.recipient === 'SELF' ? 'own' : 'teammates';
    total[field] += share;
    const raid = byRaid.get(drop.raidGroup);
    if (raid) {
      raid[field] += share;
      raid.manualSpecialLoot += manualSpecialLootValue(drop);
    }
    const month = periodKey(Date.parse(drop.occurredAt), 'month', timeZone);
    byMonth.set(month, (byMonth.get(month) ?? 0) + share);
  }

  // Every month from the first drop to now (or the last drop, if a clock was ahead).
  const times = tracked.map(({ drop }) => Date.parse(drop.occurredAt));
  const months: RaidShareMonth[] =
    times.length === 0
      ? []
      : periodsBetween(
          Math.min(...times),
          Math.max(options.now.getTime(), ...times) + 1,
          'month',
          timeZone,
        ).map((period) => {
          const month = periodKey(period.start, 'month', timeZone);
          return { month, share: capLootValue(byMonth.get(month) ?? 0) };
        });

  let rest = tracked;
  if (options.cursor !== undefined) {
    const [at, keyId, keyIndex] = decodeCursor(options.cursor, dropCursorSchema);
    rest = tracked.filter((drop) => compareDrops(sortKey(drop), { at, keyId, keyIndex }) > 0);
  }
  const page = rest.slice(0, options.limit);
  const last = page.at(-1);

  const defaults = storedDefaults(db, accountIds);
  return {
    defaults: accountIds.map((accountId) => ({
      accountId,
      mode: defaults.get(accountId) ?? DEFAULT_SPLIT_MODE,
    })),
    total: shareSums(total),
    raids: RAIDS.map((raid) => {
      const sums = byRaid.get(raid.name) ?? noRaidSums();
      return {
        raid: raid.name,
        ...shareSums(sums),
        manualSpecialLootValue: capLootValue(sums.manualSpecialLoot),
      };
    }),
    months,
    drops: {
      items: page.map(({ drop }) => drop),
      nextCursor:
        rest.length > options.limit && last
          ? encodeCursor([last.drop.occurredAt, last.keyId, last.keyIndex])
          : null,
    },
  };
}
