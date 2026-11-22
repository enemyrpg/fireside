import {
  addCapped,
  cashValue,
  itemValue,
  potionValue,
  tabsOf,
  type BankSnapshotEvent,
  type PotionStorageSnapshotEvent,
} from '@fireside/shared';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import {
  accounts,
  bankSnapshotItems,
  bankSnapshots,
  containerSnapshotItems,
  potionStorageItems,
  potionStorageSnapshots,
} from '../db/schema.js';
import type { Projection, Stored } from './framework.js';
import { accountIdOf } from './lookup.js';

// `bank_snapshots`, `bank_snapshot_items`, `container_snapshot_items`,
// `potion_storage_snapshots` and `potion_storage_items`.
//
// Keyed insert: every snapshot event gets a row with its totals (history).
// Items are kept only for each account's latest snapshot, by (`taken_at`,
// `event_id`): when the event being projected is the newest, the items of the
// account's other snapshots are deleted and its own are stored; an older,
// late event adds only its totals row. Snapshot rows exist only for events
// that projected without errors, so the latest row is always one whose items
// are stored, and the tables depend only on the set of events.

interface Priced {
  quantity: number;
  gePrice: number;
  haPrice: number;
}

function totals(items: readonly Priced[]): { ge: number; ha: number } {
  let ge = 0;
  let ha = 0;
  for (const item of items) {
    ge = addCapped(ge, itemValue(item.quantity, item.gePrice));
    ha = addCapped(ha, itemValue(item.quantity, item.haPrice));
  }
  return { ge, ha };
}

/** Rows for chunked inserts: SQLite limits bound parameters per statement. */
const INSERT_CHUNK = 500;

export function inChunks<T>(rows: readonly T[], insert: (chunk: T[]) => void): void {
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    insert(rows.slice(start, start + INSERT_CHUNK));
  }
}

type SnapshotTable = typeof bankSnapshots | typeof potionStorageSnapshots;

/**
 * If `id` is the account's newest snapshot: the IDs whose items to delete
 * (the previous newest, the only other one with items; empty if none).
 * `null` if `id` is not the newest, so its items are not stored. Two rows of
 * the (`account_id`, `taken_at`, `event_id`) index, so rebuild stays linear.
 */
function replacedIfLatest(tx: Queryable, table: SnapshotTable, accountId: number, id: number) {
  const rows = tx
    .select({ id: table.id })
    .from(table)
    .where(eq(table.accountId, accountId))
    .orderBy(desc(table.takenAt), desc(table.eventId))
    .limit(2)
    .all();
  if (rows[0]?.id !== id) return null;
  return rows.slice(1).map((row) => row.id);
}

function applyBank(tx: Queryable, event: Stored<BankSnapshotEvent>): void {
  const accountId = accountIdOf(tx, event);
  const { tabSizes, items, inventory, equipment, contentHash } = event.payload;
  const bank = totals(items);
  const inv = totals(inventory);
  const worn = totals(equipment);
  const snapshot = tx
    .insert(bankSnapshots)
    .values({
      accountId,
      sessionId: event.sessionId,
      eventId: event.eventId,
      takenAt: event.occurredAt,
      contentHash,
      tabSizes: JSON.stringify(tabSizes),
      totalGe: bank.ge,
      totalHa: bank.ha,
      inventoryGe: inv.ge,
      inventoryHa: inv.ha,
      equipmentGe: worn.ge,
      equipmentHa: worn.ha,
      cash: addCapped(cashValue(items), cashValue(inventory)),
    })
    .returning({ id: bankSnapshots.id })
    .get();

  const others = replacedIfLatest(tx, bankSnapshots, accountId, snapshot.id);
  if (others === null) return;
  if (others.length > 0) {
    tx.delete(bankSnapshotItems).where(inArray(bankSnapshotItems.snapshotId, others)).run();
    tx.delete(containerSnapshotItems)
      .where(inArray(containerSnapshotItems.snapshotId, others))
      .run();
  }
  const tabs = tabsOf(tabSizes, items.length);
  inChunks(
    items.map((item, position) => ({
      snapshotId: snapshot.id,
      position,
      tab: tabs[position] ?? 0,
      itemId: item.itemId,
      name: item.name,
      quantity: item.quantity,
      placeholder: item.placeholder,
      geEach: item.gePrice,
      haEach: item.haPrice,
    })),
    (chunk) => tx.insert(bankSnapshotItems).values(chunk).run(),
  );
  const containerRows = [
    ...inventory.map((item, position) => ({
      container: 'INVENTORY' as const,
      position,
      slot: null,
      ...item,
    })),
    ...equipment.map((item, position) => ({ container: 'EQUIPMENT' as const, position, ...item })),
  ].map(({ container, position, slot, itemId, name, quantity, gePrice, haPrice }) => ({
    snapshotId: snapshot.id,
    container,
    position,
    slot,
    itemId,
    name,
    quantity,
    geEach: gePrice,
    haEach: haPrice,
  }));
  inChunks(containerRows, (chunk) => tx.insert(containerSnapshotItems).values(chunk).run());
}

function applyPotionStorage(tx: Queryable, event: Stored<PotionStorageSnapshotEvent>): void {
  const accountId = accountIdOf(tx, event);
  const { potions, contentHash } = event.payload;
  let ge = 0;
  let ha = 0;
  for (const potion of potions) {
    ge = addCapped(ge, potionValue(potion.gePrice, potion.doses, potion.itemDoses));
    ha = addCapped(ha, potionValue(potion.haPrice, potion.doses, potion.itemDoses));
  }
  const snapshot = tx
    .insert(potionStorageSnapshots)
    .values({
      accountId,
      sessionId: event.sessionId,
      eventId: event.eventId,
      takenAt: event.occurredAt,
      contentHash,
      totalGe: ge,
      totalHa: ha,
    })
    .returning({ id: potionStorageSnapshots.id })
    .get();

  const others = replacedIfLatest(tx, potionStorageSnapshots, accountId, snapshot.id);
  if (others === null) return;
  if (others.length > 0) {
    tx.delete(potionStorageItems).where(inArray(potionStorageItems.snapshotId, others)).run();
  }
  inChunks(
    potions.map((potion, position) => ({
      snapshotId: snapshot.id,
      position,
      potion: potion.name,
      itemId: potion.itemId,
      doses: potion.doses,
      itemDoses: potion.itemDoses,
      geEach: potion.gePrice,
      haEach: potion.haPrice,
    })),
    (chunk) => tx.insert(potionStorageItems).values(chunk).run(),
  );
}

export const bankProjection: Projection = {
  name: 'bank',

  apply(tx, event) {
    if (event.type === 'bank.snapshot') applyBank(tx, event);
  },

  reset(tx) {
    tx.delete(containerSnapshotItems).run();
    tx.delete(bankSnapshotItems).run();
    tx.delete(bankSnapshots).run();
  },

  snapshot(db) {
    const snapshots = db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        eventId: bankSnapshots.eventId,
        sessionId: bankSnapshots.sessionId,
        takenAt: bankSnapshots.takenAt,
        contentHash: bankSnapshots.contentHash,
        tabSizes: bankSnapshots.tabSizes,
        totalGe: bankSnapshots.totalGe,
        totalHa: bankSnapshots.totalHa,
        inventoryGe: bankSnapshots.inventoryGe,
        inventoryHa: bankSnapshots.inventoryHa,
        equipmentGe: bankSnapshots.equipmentGe,
        equipmentHa: bankSnapshots.equipmentHa,
        cash: bankSnapshots.cash,
      })
      .from(bankSnapshots)
      .innerJoin(accounts, eq(bankSnapshots.accountId, accounts.id))
      .orderBy(
        asc(accounts.userId),
        asc(accounts.accountHash),
        asc(bankSnapshots.takenAt),
        asc(bankSnapshots.eventId),
      )
      .all();
    const items = db
      .select({
        eventId: bankSnapshots.eventId,
        position: bankSnapshotItems.position,
        tab: bankSnapshotItems.tab,
        itemId: bankSnapshotItems.itemId,
        name: bankSnapshotItems.name,
        quantity: bankSnapshotItems.quantity,
        placeholder: bankSnapshotItems.placeholder,
        geEach: bankSnapshotItems.geEach,
        haEach: bankSnapshotItems.haEach,
      })
      .from(bankSnapshotItems)
      .innerJoin(bankSnapshots, eq(bankSnapshotItems.snapshotId, bankSnapshots.id))
      .orderBy(asc(bankSnapshots.eventId), asc(bankSnapshotItems.position))
      .all();
    const containers = db
      .select({
        eventId: bankSnapshots.eventId,
        container: containerSnapshotItems.container,
        position: containerSnapshotItems.position,
        slot: containerSnapshotItems.slot,
        itemId: containerSnapshotItems.itemId,
        name: containerSnapshotItems.name,
        quantity: containerSnapshotItems.quantity,
        geEach: containerSnapshotItems.geEach,
        haEach: containerSnapshotItems.haEach,
      })
      .from(containerSnapshotItems)
      .innerJoin(bankSnapshots, eq(containerSnapshotItems.snapshotId, bankSnapshots.id))
      .orderBy(
        asc(bankSnapshots.eventId),
        asc(containerSnapshotItems.container),
        asc(containerSnapshotItems.position),
      )
      .all();
    return { snapshots, items, containers };
  },
};

export const potionStorageProjection: Projection = {
  name: 'potion-storage',

  apply(tx, event) {
    if (event.type === 'potion_storage.snapshot') applyPotionStorage(tx, event);
  },

  reset(tx) {
    tx.delete(potionStorageItems).run();
    tx.delete(potionStorageSnapshots).run();
  },

  snapshot(db) {
    const snapshots = db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        eventId: potionStorageSnapshots.eventId,
        sessionId: potionStorageSnapshots.sessionId,
        takenAt: potionStorageSnapshots.takenAt,
        contentHash: potionStorageSnapshots.contentHash,
        totalGe: potionStorageSnapshots.totalGe,
        totalHa: potionStorageSnapshots.totalHa,
      })
      .from(potionStorageSnapshots)
      .innerJoin(accounts, eq(potionStorageSnapshots.accountId, accounts.id))
      .orderBy(
        asc(accounts.userId),
        asc(accounts.accountHash),
        asc(potionStorageSnapshots.takenAt),
        asc(potionStorageSnapshots.eventId),
      )
      .all();
    const potions = db
      .select({
        eventId: potionStorageSnapshots.eventId,
        position: potionStorageItems.position,
        potion: potionStorageItems.potion,
        itemId: potionStorageItems.itemId,
        doses: potionStorageItems.doses,
        itemDoses: potionStorageItems.itemDoses,
        geEach: potionStorageItems.geEach,
        haEach: potionStorageItems.haEach,
      })
      .from(potionStorageItems)
      .innerJoin(
        potionStorageSnapshots,
        eq(potionStorageItems.snapshotId, potionStorageSnapshots.id),
      )
      .orderBy(asc(potionStorageSnapshots.eventId), asc(potionStorageItems.position))
      .all();
    return { snapshots, potions };
  },
};
