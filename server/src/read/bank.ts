import {
  addCapped,
  addDays,
  compareBankTabs,
  fromLocal,
  itemValue,
  MAIN_BANK_TAB,
  periodKey,
  periodsBetween,
  potionValue,
  toLocal,
  type AccountBank,
  type AccountPotionStorage,
  type BankHistoryDay,
  type BankResponse,
  type BankSummaryResponse,
  type BankTab,
  type ContainerResponse,
  type PotionStorageResponse,
} from '@fireside/shared';
import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import {
  bankSnapshotItems,
  bankSnapshots,
  containerSnapshotItems,
  potionStorageItems,
  potionStorageSnapshots,
} from '../db/schema.js';
import { SNAPSHOT_PRICES, type PriceLookup } from './prices.js';

// Bank and potion storage. Functions take the account IDs in scope (one, or all for `all`). Reads
// only `bank_snapshots`, `bank_snapshot_items`, `container_snapshot_items`,
// `potion_storage_snapshots` and `potion_storage_items`. The latest snapshot per account is the
// newest by (`taken_at`, `event_id`); only it has item rows (see projections/bank.ts).
//
// The latest bank, inventory, equipment and potion storage are valued with
// the `PriceLookup` they are given: current prices when `PRICES_ENABLED` is on, the snapshot's own
// prices otherwise. `bank/history` always uses the snapshot's prices.

const iso = (ms: number) => new Date(ms).toISOString();

/** Days in the default history range: a rolling year ending with today. */
export const DEFAULT_HISTORY_DAYS = 365;

export interface TimeRange {
  from: string;
  to: string;
}

/** From local midnight 364 days ago to the next local midnight. */
export function defaultHistoryRange(nowMs: number, timeZone: string): TimeRange {
  const today = toLocal(nowMs, timeZone);
  return {
    from: iso(fromLocal(addDays(today, 1 - DEFAULT_HISTORY_DAYS), 0, 0, timeZone)),
    to: iso(fromLocal(addDays(today, 1), 0, 0, timeZone)),
  };
}

// --- Latest snapshots ---------------------------------------------------------

function latestBankRow(db: Queryable, accountId: number) {
  return db
    .select()
    .from(bankSnapshots)
    .where(eq(bankSnapshots.accountId, accountId))
    .orderBy(desc(bankSnapshots.takenAt), desc(bankSnapshots.eventId))
    .limit(1)
    .get();
}

function latestPotionRow(db: Queryable, accountId: number) {
  return db
    .select()
    .from(potionStorageSnapshots)
    .where(eq(potionStorageSnapshots.accountId, accountId))
    .orderBy(desc(potionStorageSnapshots.takenAt), desc(potionStorageSnapshots.eventId))
    .limit(1)
    .get();
}

function container(
  db: Queryable,
  snapshotId: number,
  kind: 'INVENTORY' | 'EQUIPMENT',
  prices: PriceLookup,
): ContainerResponse {
  const rows = db
    .select()
    .from(containerSnapshotItems)
    .where(
      and(
        eq(containerSnapshotItems.snapshotId, snapshotId),
        eq(containerSnapshotItems.container, kind),
      ),
    )
    .orderBy(asc(containerSnapshotItems.position))
    .all();
  const items = rows.map((row) => {
    const used = prices.priceOf(row.itemId, row.geEach);
    return {
      position: row.position,
      slot: row.slot,
      itemId: row.itemId,
      name: row.name,
      quantity: row.quantity,
      ...used,
      haPriceEach: row.haEach,
      geValue: itemValue(row.quantity, used.gePriceEach),
      haValue: itemValue(row.quantity, row.haEach),
    };
  });
  return {
    geValue: items.reduce((sum, item) => addCapped(sum, item.geValue), 0),
    haValue: items.reduce((sum, item) => addCapped(sum, item.haValue), 0),
    items,
  };
}

function accountBank(db: Queryable, accountId: number, prices: PriceLookup): AccountBank | null {
  const snapshot = latestBankRow(db, accountId);
  if (!snapshot) return null;
  const items = db
    .select()
    .from(bankSnapshotItems)
    .where(eq(bankSnapshotItems.snapshotId, snapshot.id))
    .orderBy(asc(bankSnapshotItems.position))
    .all()
    .map((row) => {
      const used = prices.priceOf(row.itemId, row.geEach);
      return {
        position: row.position,
        tab: row.tab,
        itemId: row.itemId,
        name: row.name,
        quantity: row.quantity,
        placeholder: row.placeholder,
        ...used,
        haPriceEach: row.haEach,
        geValue: itemValue(row.quantity, used.gePriceEach),
        haValue: itemValue(row.quantity, row.haEach),
      };
    });
  const byTab = new Map<number, BankTab>([
    [MAIN_BANK_TAB, { tab: MAIN_BANK_TAB, itemCount: 0, geValue: 0, haValue: 0 }],
  ]);
  for (const item of items) {
    const tab = byTab.get(item.tab) ?? { tab: item.tab, itemCount: 0, geValue: 0, haValue: 0 };
    tab.itemCount += 1;
    tab.geValue = addCapped(tab.geValue, item.geValue);
    tab.haValue = addCapped(tab.haValue, item.haValue);
    byTab.set(item.tab, tab);
  }
  return {
    accountId,
    takenAt: snapshot.takenAt,
    totals: {
      // Summed from the items, so it follows the prices that were used.
      geValue: items.reduce((sum, item) => addCapped(sum, item.geValue), 0),
      haValue: snapshot.totalHa,
      cashValue: snapshot.cash,
    },
    tabs: [...byTab.values()].sort((a, b) => compareBankTabs(a.tab, b.tab)),
    items,
    inventory: container(db, snapshot.id, 'INVENTORY', prices),
    equipment: container(db, snapshot.id, 'EQUIPMENT', prices),
  };
}

/** `GET …/bank`: the latest bank per account in scope, with summed totals. */
export function bank(
  db: Queryable,
  accountIds: readonly number[],
  prices: PriceLookup = SNAPSHOT_PRICES,
): BankResponse {
  const banks = [...accountIds]
    .sort((a, b) => a - b)
    .flatMap((id) => accountBank(db, id, prices) ?? []);
  const totals = { geValue: 0, haValue: 0, cashValue: 0 };
  for (const { totals: t } of banks) {
    totals.geValue = addCapped(totals.geValue, t.geValue);
    totals.haValue = addCapped(totals.haValue, t.haValue);
    totals.cashValue = addCapped(totals.cashValue, t.cashValue);
  }
  return { banks, totals, prices: prices.prices };
}

function accountPotionStorage(
  db: Queryable,
  accountId: number,
  prices: PriceLookup,
): AccountPotionStorage | null {
  const snapshot = latestPotionRow(db, accountId);
  if (!snapshot) return null;
  const potions = db
    .select()
    .from(potionStorageItems)
    .where(eq(potionStorageItems.snapshotId, snapshot.id))
    .orderBy(asc(potionStorageItems.position))
    .all()
    .map((row) => {
      const used = prices.priceOf(row.itemId, row.geEach);
      return {
        position: row.position,
        itemId: row.itemId,
        name: row.potion,
        doses: row.doses,
        itemDoses: row.itemDoses,
        ...used,
        haPriceEach: row.haEach,
        geValue: potionValue(used.gePriceEach, row.doses, row.itemDoses),
        haValue: potionValue(row.haEach, row.doses, row.itemDoses),
      };
    });
  return {
    accountId,
    takenAt: snapshot.takenAt,
    totals: {
      geValue: potions.reduce((sum, potion) => addCapped(sum, potion.geValue), 0),
      haValue: snapshot.totalHa,
    },
    potions,
  };
}

/** `GET …/potion-storage`: the latest potion storage per account in scope. */
export function potionStorage(
  db: Queryable,
  accountIds: readonly number[],
  prices: PriceLookup = SNAPSHOT_PRICES,
): PotionStorageResponse {
  const storages = [...accountIds]
    .sort((a, b) => a - b)
    .flatMap((id) => accountPotionStorage(db, id, prices) ?? []);
  const totals = { geValue: 0, haValue: 0 };
  for (const { totals: t } of storages) {
    totals.geValue = addCapped(totals.geValue, t.geValue);
    totals.haValue = addCapped(totals.haValue, t.haValue);
  }
  return { storages, totals, prices: prices.prices };
}

// --- Net worth: summary and history -----------------------------------------

/** Net-worth parts of one account at one time (or summed). */
interface Worth {
  bankGeValue: number;
  bankHaValue: number;
  potionStorageGeValue: number;
  potionStorageHaValue: number;
  inventoryGeValue: number;
  inventoryHaValue: number;
  equipmentGeValue: number;
  equipmentHaValue: number;
  cashValue: number;
}

const zeroWorth = (): Worth => ({
  bankGeValue: 0,
  bankHaValue: 0,
  potionStorageGeValue: 0,
  potionStorageHaValue: 0,
  inventoryGeValue: 0,
  inventoryHaValue: 0,
  equipmentGeValue: 0,
  equipmentHaValue: 0,
  cashValue: 0,
});

function addWorth(sum: Worth, part: Partial<Worth>): void {
  for (const key of Object.keys(sum) as (keyof Worth)[]) {
    sum[key] = addCapped(sum[key], part[key] ?? 0);
  }
}

type BankRow = Pick<
  typeof bankSnapshots.$inferSelect,
  | 'takenAt'
  | 'totalGe'
  | 'totalHa'
  | 'inventoryGe'
  | 'inventoryHa'
  | 'equipmentGe'
  | 'equipmentHa'
  | 'cash'
>;
type PotionRow = Pick<
  typeof potionStorageSnapshots.$inferSelect,
  'takenAt' | 'totalGe' | 'totalHa'
>;

const bankWorth = (row: BankRow): Partial<Worth> => ({
  bankGeValue: row.totalGe,
  bankHaValue: row.totalHa,
  inventoryGeValue: row.inventoryGe,
  inventoryHaValue: row.inventoryHa,
  equipmentGeValue: row.equipmentGe,
  equipmentHaValue: row.equipmentHa,
  cashValue: row.cash,
});

const potionWorth = (row: PotionRow): Partial<Worth> => ({
  potionStorageGeValue: row.totalGe,
  potionStorageHaValue: row.totalHa,
});

/** `geValue` = bank + potion storage + inventory + equipment. */
function netWorth(worth: Worth): number {
  return [
    worth.bankGeValue,
    worth.potionStorageGeValue,
    worth.inventoryGeValue,
    worth.equipmentGeValue,
  ].reduce(addCapped, 0);
}

/**
 * `GET …/bank/summary`: each account's latest bank and potion storage,
 * summed. `updatedAt` is the newest of those snapshots, `null` without any.
 * With snapshot prices the stored totals are used; with current prices the
 * items are valued again, exactly as `bank` and `potionStorage` do.
 */
export function bankSummary(
  db: Queryable,
  accountIds: readonly number[],
  prices: PriceLookup = SNAPSHOT_PRICES,
): BankSummaryResponse {
  const sum = zeroWorth();
  let updatedAt: string | null = null;
  const current = prices.prices.source === 'CURRENT';
  for (const accountId of accountIds) {
    const bankRow = latestBankRow(db, accountId);
    const potionRow = latestPotionRow(db, accountId);
    for (const row of [bankRow, potionRow]) {
      if (row && (updatedAt === null || row.takenAt > updatedAt)) updatedAt = row.takenAt;
    }
    if (bankRow && current) {
      const latest = accountBank(db, accountId, prices);
      if (latest) {
        addWorth(sum, {
          bankGeValue: latest.totals.geValue,
          inventoryGeValue: latest.inventory.geValue,
          equipmentGeValue: latest.equipment.geValue,
          cashValue: latest.totals.cashValue,
        });
      }
    } else if (bankRow) addWorth(sum, bankWorth(bankRow));
    if (potionRow && current) {
      const latest = accountPotionStorage(db, accountId, prices);
      if (latest) addWorth(sum, { potionStorageGeValue: latest.totals.geValue });
    } else if (potionRow) addWorth(sum, potionWorth(potionRow));
  }
  return {
    geValue: netWorth(sum),
    bankGeValue: sum.bankGeValue,
    potionStorageGeValue: sum.potionStorageGeValue,
    inventoryGeValue: sum.inventoryGeValue,
    equipmentGeValue: sum.equipmentGeValue,
    cashValue: sum.cashValue,
    updatedAt,
    prices: prices.prices,
  };
}

type SnapshotTable = typeof bankSnapshots | typeof potionStorageSnapshots;

/**
 * One account's net worth (as `geValue` in `bank/history`) from its last bank
 * and potion storage snapshots taken before `before`, at the snapshots' own
 * prices. `null` without a snapshot by then.
 */
export function netWorthBefore(db: Queryable, accountId: number, before: string): number | null {
  const last = <T extends SnapshotTable>(table: T) =>
    db
      .select()
      .from(table)
      .where(and(eq(table.accountId, accountId), lt(table.takenAt, before)))
      .orderBy(desc(table.takenAt), desc(table.eventId))
      .limit(1)
      .get() as T['$inferSelect'] | undefined;
  const bankRow = last(bankSnapshots);
  const potionRow = last(potionStorageSnapshots);
  if (!bankRow && !potionRow) return null;
  const worth = zeroWorth();
  if (bankRow) addWorth(worth, bankWorth(bankRow));
  if (potionRow) addWorth(worth, potionWorth(potionRow));
  return netWorth(worth);
}

/**
 * Rows of one account that matter for `[from, to)`: the last one before
 * `from`, then every row in the range, oldest first. Two indexed queries.
 */
function rowsFor<T extends SnapshotTable>(
  db: Queryable,
  table: T,
  accountId: number,
  range: TimeRange,
): T['$inferSelect'][] {
  const before = db
    .select()
    .from(table)
    .where(and(eq(table.accountId, accountId), lt(table.takenAt, range.from)))
    .orderBy(desc(table.takenAt), desc(table.eventId))
    .limit(1)
    .all();
  const inRange = db
    .select()
    .from(table)
    .where(
      and(
        eq(table.accountId, accountId),
        gte(table.takenAt, range.from),
        lt(table.takenAt, range.to),
      ),
    )
    .orderBy(asc(table.takenAt), asc(table.eventId))
    .all();
  return [...before, ...inRange] as T['$inferSelect'][];
}

/**
 * Walks `rows` (sorted) and calls `onDay` for each day end with the last row
 * taken before it, carried forward. Days before the first row are skipped.
 */
function carryForward<R extends { takenAt: string }>(
  rows: readonly R[],
  ends: readonly string[],
  onDay: (index: number, row: R) => void,
): void {
  let current: R | undefined;
  let next = 0;
  ends.forEach((end, index) => {
    for (let row = rows[next]; row !== undefined && row.takenAt < end; row = rows[next]) {
      current = row;
      next += 1;
    }
    if (current) onDay(index, current);
  });
}

/**
 * `GET …/bank/history`: one entry per local day in `TZ` that overlaps
 * `[from, min(to, now))`. Per account, the bank and potion storage values are
 * the last snapshot taken before the end of the day (clipped to `to`),
 * carried forward over days without one; for `all` they are summed. Days on
 * which no account in scope has a snapshot yet are left out.
 */
export function bankHistory(
  db: Queryable,
  accountIds: readonly number[],
  range: TimeRange,
  timeZone: string,
  nowMs: number,
): BankHistoryDay[] {
  const toMs = Date.parse(range.to);
  const days = periodsBetween(Date.parse(range.from), Math.min(toMs, nowMs), 'day', timeZone).map(
    (day) => ({ ...day, worth: zeroWorth(), seen: false }),
  );
  const ends = days.map((day) => iso(Math.min(day.end, toMs)));
  const add = (index: number, part: Partial<Worth>) => {
    const day = days[index];
    if (!day) return;
    day.seen = true;
    addWorth(day.worth, part);
  };

  for (const accountId of accountIds) {
    carryForward(rowsFor(db, bankSnapshots, accountId, range), ends, (index, row) => {
      add(index, bankWorth(row));
    });
    carryForward(rowsFor(db, potionStorageSnapshots, accountId, range), ends, (index, row) => {
      add(index, potionWorth(row));
    });
  }

  return days
    .filter((day) => day.seen)
    .map((day) => ({
      date: periodKey(day.start, 'day', timeZone),
      start: iso(day.start),
      geValue: netWorth(day.worth),
      ...day.worth,
    }));
}
