import {
  addCapped,
  comparePets,
  compareSkills,
  diaryRegionName,
  isKnownSkill,
  isoWeekRange,
  MAX_QUEST_POINTS,
  periodAt,
  periodKey,
  WEEKLY_CLOG_ITEMS,
  type Drop,
  type WeeklyBankDay,
  type WeeklyClogItem,
  type WeeklyDiaryTier,
  type WeeklyQuest,
  type WeeklyResponse,
} from '@fireside/shared';
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import {
  accountPets,
  accounts,
  clogItems,
  clogObtained,
  clogSnapshots,
  lootEvents,
  lootItems,
  questSnapshots,
  questStates,
  weeklySummaries,
} from '../db/schema.js';
import { capLootValue } from '../projections/session-summaries.js';
import { bankHistory, netWorthBefore } from './bank.js';
import { kcWindowColumns, kcWindowGain, type KcWindowRow } from './kc.js';
import { apiSource } from './loot.js';
import { petOf, type AccountPetRow } from './pets.js';
import { HEARTBEAT_SECONDS, heartbeatTimes, worldMinutes } from './playtime.js';
import { diaryCompletionRows, questCompletionDates } from './quests.js';
import { snapshotPairs, sumGains } from './xp.js';

// `GET …/weekly?week=`. Every section is read by time in the local ISO week
// `[start, end)`, from derived tables only: heartbeats and AFK periods, XP
// snapshots, loot and KC observations, and (since 1.28.0) pets, bank and potion
// storage snapshots, the collection log and quest and diary snapshots.
//
// Each account's week is computed into `AccountWeek`, a format that can be
// summed, so `all` is the merge of the accounts' weeks. Completed weeks are
// stored per account in `weekly_summaries` when first read. The weekly
// summaries projection deletes stored weeks that an event can change, and the
// writers of pets and the collection log do the same for their changes
// (`invalidateWeeksFrom`).

/** Bump when the computation or `AccountWeek` changes, so stored rows are recomputed. */
export const WEEKLY_DATA_VERSION = 2;

const TOP_SKILLS = 3;
const TOP_DROPS = 5;

/** One account's week, as stored in `weekly_summaries.data`. */
export interface AccountWeek {
  v: number;
  playtime: {
    activeSeconds: number;
    afkSeconds: number;
    previousWeekPlayedSeconds: number;
    /** World → played seconds. */
    byWorld: Record<string, number>;
  };
  /** Skills in `SKILLS` with a gain → XP and levels gained. */
  xp: Record<string, { xp: number; levels: number }>;
  loot: { geValue: number; topDrops: Drop[] };
  /** Boss → KC gained, only bosses with a gain. */
  kc: Record<string, number>;
  /**
   * `account_pets` rows obtained in the week. The KC or XP at the drop is
   * looked up when the response is built (`petOf`), never stored, so a late
   * `kc` or `xp` event cannot leave an old number here.
   */
  pets: AccountPetRow[];
  /** `null` until the account has a bank or potion storage snapshot before the week's end. */
  bank: {
    /** Net worth before the week, `null` without a snapshot by then. */
    start: number | null;
    /** Net worth per local day with a value, oldest first (as `bank/history`). */
    days: WeeklyBankDay[];
  } | null;
  clog: {
    /** Items first seen in the week. */
    newItems: number;
    /** Counts of the last collection log stored before the week's end. */
    obtained: number | null;
    total: number | null;
    /** The newest of the new items, newest first. */
    recentItems: WeeklyClogItem[];
  };
  quests: {
    questPointsGained: number;
    /** First seen as finished in the week, newest first. */
    quests: WeeklyQuest[];
    diaries: WeeklyDiaryTier[];
  };
}

interface Range {
  start: number;
  end: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * An empty record without a prototype. Keys come from game data (boss names,
 * skills), so a boss called `__proto__` or `constructor` is an ordinary key.
 */
function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

// --- Computing one account's week -----------------------------------------------

function playtimeOf(db: Queryable, accountId: number, range: Range): AccountWeek['playtime'] {
  const filter = { accountIds: [accountId], from: iso(range.start), to: iso(range.end) };
  const byWorld = record<number>();
  let active = 0;
  let afk = 0;
  for (const minute of worldMinutes(db, filter)) {
    if (minute.afk) afk += HEARTBEAT_SECONDS;
    else active += HEARTBEAT_SECONDS;
    byWorld[minute.world] = (byWorld[minute.world] ?? 0) + HEARTBEAT_SECONDS;
  }
  return { activeSeconds: active, afkSeconds: afk, previousWeekPlayedSeconds: 0, byWorld };
}

function xpOf(db: Queryable, accountId: number, range: Range): AccountWeek['xp'] {
  const gains = sumGains(snapshotPairs(db, [accountId], iso(range.start), iso(range.end)));
  const xp: AccountWeek['xp'] = record();
  for (const skill of gains.skills) {
    if (!isKnownSkill(skill.skill)) continue;
    if (skill.xpGained <= 0 && skill.levelsGained <= 0) continue;
    xp[skill.skill] = { xp: skill.xpGained, levels: skill.levelsGained };
  }
  return xp;
}

function lootOf(db: Queryable, accountId: number, range: Range): AccountWeek['loot'] {
  const inWeek = and(
    eq(lootEvents.accountId, accountId),
    gte(lootEvents.occurredAt, iso(range.start)),
    lt(lootEvents.occurredAt, iso(range.end)),
  );
  const total = db
    .select({ geValue: sql<number>`total(${lootEvents.totalGeValue})` })
    .from(lootEvents)
    .where(inWeek)
    .get();
  const geValue = sql<number>`${lootItems.quantity} * ${lootItems.gePriceEach}`;
  const rows = db
    .select({
      lootEventId: lootEvents.id,
      accountId: lootEvents.accountId,
      sessionId: lootEvents.sessionId,
      occurredAt: lootEvents.occurredAt,
      sourceType: lootEvents.sourceType,
      sourceName: lootEvents.sourceName,
      itemId: lootItems.itemId,
      name: lootItems.itemName,
      quantity: lootItems.quantity,
      gePriceEach: lootItems.gePriceEach,
      haPriceEach: lootItems.haPriceEach,
    })
    .from(lootEvents)
    .innerJoin(lootItems, eq(lootItems.lootEventId, lootEvents.id))
    .where(inWeek)
    // Highest value first, then the drops order (newest first, payload order).
    .orderBy(
      desc(geValue),
      desc(lootEvents.occurredAt),
      desc(lootEvents.eventId),
      asc(lootItems.position),
    )
    .limit(TOP_DROPS)
    .all();
  return {
    geValue: capLootValue(total?.geValue ?? 0),
    topDrops: rows.map(({ sourceType, sourceName, ...row }) => ({
      ...row,
      source: apiSource(sourceType, sourceName),
      // Exact: the loot projection rejects events whose totals aren't safe integers.
      geValue: row.quantity * row.gePriceEach,
      haValue: row.quantity * row.haPriceEach,
    })),
  };
}

/** KC gained per boss in the week (`kcWindowGain`), only bosses with a gain. */
function kcOf(db: Queryable, accountId: number, range: Range): AccountWeek['kc'] {
  const from = iso(range.start);
  const to = iso(range.end);
  const rows = db.all<KcWindowRow & { boss: string }>(sql`
    SELECT pair.boss AS boss, ${kcWindowColumns(from, to)}
    FROM (SELECT DISTINCT account_id, boss FROM kc_observations
      WHERE account_id = ${accountId} AND observed_at >= ${from} AND observed_at < ${to}) AS pair
  `);
  const kc = record<number>();
  for (const row of rows) {
    const gained = kcWindowGain(row);
    if (gained > 0) kc[row.boss] = gained;
  }
  return kc;
}

/** Pets the account got in the week. A pet without a time is in no week. */
function petsOf(db: Queryable, accountId: number, range: Range): AccountWeek['pets'] {
  return db
    .select()
    .from(accountPets)
    .where(
      and(
        eq(accountPets.accountId, accountId),
        gte(accountPets.obtainedAt, iso(range.start)),
        lt(accountPets.obtainedAt, iso(range.end)),
      ),
    )
    .orderBy(asc(accountPets.petItemId))
    .all();
}

/**
 * Net worth per local day of the week, with the rule and code of
 * `bank/history` (snapshot prices, the last snapshot before the end of each
 * day, carried forward, clipped to now), and the net worth before the week.
 */
function bankOf(
  db: Queryable,
  accountId: number,
  range: Range,
  timeZone: string,
  nowMs: number,
): AccountWeek['bank'] {
  const days = bankHistory(
    db,
    [accountId],
    { from: iso(range.start), to: iso(range.end) },
    timeZone,
    nowMs,
  );
  if (days.length === 0) return null;
  return {
    start: netWorthBefore(db, accountId, iso(range.start)),
    days: days.map(({ date, geValue }) => ({ date, geValue })),
  };
}

/** Newest first; the item ID settles items with the same time. */
function compareClogItems(a: WeeklyClogItem, b: WeeklyClogItem): number {
  if (a.firstSeenAt !== b.firstSeenAt) return a.firstSeenAt < b.firstSeenAt ? 1 : -1;
  return a.accountId - b.accountId || a.itemId - b.itemId;
}

/**
 * Collection log items first seen in the week (approximate times count, as
 * on the Collection log page), and the counts of the last collection log
 * stored before the week's end.
 */
function clogOf(db: Queryable, accountId: number, range: Range): AccountWeek['clog'] {
  const counts = db
    .select({ obtained: clogSnapshots.obtained, total: clogSnapshots.total })
    .from(clogSnapshots)
    .where(and(eq(clogSnapshots.accountId, accountId), lt(clogSnapshots.takenAt, iso(range.end))))
    .orderBy(desc(clogSnapshots.takenAt), desc(clogSnapshots.snapshotId))
    .limit(1)
    .get();
  const fresh = db
    .select({
      itemId: clogObtained.itemId,
      firstSeenAt: clogObtained.firstSeenAt,
      approximate: clogObtained.approximate,
    })
    .from(clogObtained)
    .where(
      and(
        eq(clogObtained.accountId, accountId),
        gte(clogObtained.firstSeenAt, iso(range.start)),
        lt(clogObtained.firstSeenAt, iso(range.end)),
      ),
    )
    .all();
  const recentItems: WeeklyClogItem[] = [];
  if (fresh.length > 0) {
    // Name and page of each item: its first place in the game's order.
    const places = new Map<number, { name: string; page: string }>();
    for (const item of db
      .select({ itemId: clogItems.itemId, name: clogItems.name, page: clogItems.page })
      .from(clogItems)
      .where(eq(clogItems.accountId, accountId))
      .orderBy(asc(clogItems.tabPosition), asc(clogItems.pagePosition), asc(clogItems.position))
      .all()) {
      if (!places.has(item.itemId)) places.set(item.itemId, item);
    }
    for (const item of fresh) {
      const place = places.get(item.itemId);
      // An item the latest collection log no longer lists has no name to show.
      if (!place || item.firstSeenAt === null) continue;
      recentItems.push({
        accountId,
        itemId: item.itemId,
        name: place.name,
        page: place.page,
        firstSeenAt: item.firstSeenAt,
        approximate: item.approximate,
      });
    }
  }
  return {
    newItems: recentItems.length,
    obtained: counts?.obtained ?? null,
    total: counts?.total ?? null,
    recentItems: recentItems.sort(compareClogItems).slice(0, WEEKLY_CLOG_ITEMS),
  };
}

/** Newest first, then by account and name. */
function compareFinished(
  a: { at: string; accountId: number; name: string },
  b: { at: string; accountId: number; name: string },
): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.accountId - b.accountId || compareText(a.name, b.name);
}

const compareQuests = (a: WeeklyQuest, b: WeeklyQuest) =>
  compareFinished({ ...a, at: a.finishedAt }, { ...b, at: b.finishedAt }) ||
  compareText(a.quest, b.quest);

const compareDiaries = (a: WeeklyDiaryTier, b: WeeklyDiaryTier) =>
  compareFinished({ ...a, at: a.completedAt }, { ...b, at: b.completedAt }) ||
  compareText(a.tier, b.tier);

/**
 * Quest points gained in the week: the last snapshot before its end minus
 * the last one before its start, or minus the first one in the week when the
 * account has none before (as KC). Never negative.
 */
function questPointsGained(db: Queryable, accountId: number, range: Range): number {
  const points = (where: ReturnType<typeof and>, newest: boolean) =>
    db
      .select({ questPoints: questSnapshots.questPoints })
      .from(questSnapshots)
      .where(and(eq(questSnapshots.accountId, accountId), where))
      .orderBy(
        newest ? desc(questSnapshots.takenAt) : asc(questSnapshots.takenAt),
        newest ? desc(questSnapshots.eventId) : asc(questSnapshots.eventId),
      )
      .limit(1)
      .get()?.questPoints;
  const start = iso(range.start);
  const end = iso(range.end);
  const last = points(lt(questSnapshots.takenAt, end), true);
  if (last === undefined) return 0;
  const base =
    points(lt(questSnapshots.takenAt, start), true) ??
    points(and(gte(questSnapshots.takenAt, start), lt(questSnapshots.takenAt, end)), false) ??
    last;
  return Math.max(0, last - base);
}

/**
 * Quests, miniquests and diary tiers first seen as finished in the week
 * (`questCompletionDates`, `diaryCompletionRows`: what was finished before
 * tracking has no date and is in no week). A quest gets its name from the
 * account's latest snapshot; one that is no longer listed there is left out.
 */
function questsOf(db: Queryable, accountId: number, range: Range): AccountWeek['quests'] {
  const inWeek = (at: string) => at >= iso(range.start) && at < iso(range.end);

  const quests: WeeklyQuest[] = [];
  const finished = [...questCompletionDates(db, accountId)].filter(([, at]) => inWeek(at));
  if (finished.length > 0) {
    const states = new Map(
      db
        .select({ quest: questStates.quest, name: questStates.name, kind: questStates.kind })
        .from(questStates)
        .where(eq(questStates.accountId, accountId))
        .all()
        .map((row) => [row.quest, row]),
    );
    for (const [quest, finishedAt] of finished) {
      const state = states.get(quest);
      if (!state) continue;
      quests.push({ accountId, quest, name: state.name, kind: state.kind ?? 'QUEST', finishedAt });
    }
  }

  const diaries = diaryCompletionRows(db, accountId)
    .filter((row) => inWeek(row.at))
    .map((row): WeeklyDiaryTier => ({
      accountId,
      region: row.region,
      name: diaryRegionName(row.region),
      tier: row.tier,
      completedAt: row.at,
    }));

  return {
    questPointsGained: questPointsGained(db, accountId, range),
    quests: quests.sort(compareQuests),
    diaries: diaries.sort(compareDiaries),
  };
}

/**
 * One account's week `[start, end)` and the previous local week's play time.
 * `nowMs` only matters for a week that isn't over: the bank's days stop at now.
 */
export function computeAccountWeek(
  db: Queryable,
  accountId: number,
  range: Range,
  timeZone: string,
  nowMs: number,
): AccountWeek {
  const playtime = playtimeOf(db, accountId, range);
  // The previous local week, so a DST change in it is handled.
  const previous = { start: periodAt(range.start - 1, 'week', timeZone).start, end: range.start };
  playtime.previousWeekPlayedSeconds =
    heartbeatTimes(db, {
      accountIds: [accountId],
      from: iso(previous.start),
      to: iso(previous.end),
    }).length * HEARTBEAT_SECONDS;
  return {
    v: WEEKLY_DATA_VERSION,
    playtime,
    xp: xpOf(db, accountId, range),
    loot: lootOf(db, accountId, range),
    kc: kcOf(db, accountId, range),
    pets: petsOf(db, accountId, range),
    bank: bankOf(db, accountId, range, timeZone, nowMs),
    clog: clogOf(db, accountId, range),
    quests: questsOf(db, accountId, range),
  };
}

// --- Merging and the response ----------------------------------------------------

function emptyWeek(): AccountWeek {
  return {
    v: WEEKLY_DATA_VERSION,
    playtime: {
      activeSeconds: 0,
      afkSeconds: 0,
      previousWeekPlayedSeconds: 0,
      byWorld: record(),
    },
    xp: record(),
    loot: { geValue: 0, topDrops: [] },
    kc: record(),
    pets: [],
    bank: null,
    clog: { newItems: 0, obtained: null, total: null, recentItems: [] },
    quests: { questPointsGained: 0, quests: [], diaries: [] },
  };
}

/**
 * The accounts' bank weeks summed per local day (as `bank/history` for
 * `all`: an account counts from its first snapshot). The start is only known
 * when every account that counts had a snapshot before the week: otherwise
 * that account's whole bank would look like a gain.
 */
function mergeBank(parts: readonly NonNullable<AccountWeek['bank']>[]): AccountWeek['bank'] {
  if (parts.length === 0) return null;
  const byDate = new Map<string, number>();
  let start: number | null = 0;
  for (const part of parts) {
    start = start === null || part.start === null ? null : addCapped(start, part.start);
    for (const day of part.days) {
      byDate.set(day.date, addCapped(byDate.get(day.date) ?? 0, day.geValue));
    }
  }
  const days = [...byDate]
    .map(([date, geValue]) => ({ date, geValue }))
    .sort((a, b) => compareText(a.date, b.date));
  return { start, days };
}

/** `null` + `null` stays `null`: no account had a collection log by then. */
function addNullable(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : a + b;
}

/**
 * Order of merged top drops: GE value, then newest first, then account ID.
 * Within one account, ties keep the stored order (the drops order), since
 * the sort is stable.
 */
function compareDrops(a: Drop, b: Drop): number {
  if (a.geValue !== b.geValue) return b.geValue - a.geValue;
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
  return a.accountId - b.accountId;
}

function addTo(sum: Record<string, number>, key: string, value: number): void {
  sum[key] = (sum[key] ?? 0) + value;
}

/**
 * The sum of several accounts' weeks (for `all`). The top drops of the union
 * are among each account's top drops, so the merged top 5 is exact.
 */
export function mergeWeeks(weeks: readonly AccountWeek[]): AccountWeek {
  if (weeks.length === 1 && weeks[0]) return weeks[0];
  const sum = emptyWeek();
  const drops: Drop[] = [];
  const banks: NonNullable<AccountWeek['bank']>[] = [];
  for (const week of weeks) {
    sum.pets.push(...week.pets);
    if (week.bank) banks.push(week.bank);
    sum.clog.newItems += week.clog.newItems;
    sum.clog.obtained = addNullable(sum.clog.obtained, week.clog.obtained);
    sum.clog.total = addNullable(sum.clog.total, week.clog.total);
    sum.clog.recentItems.push(...week.clog.recentItems);
    sum.quests.questPointsGained += week.quests.questPointsGained;
    sum.quests.quests.push(...week.quests.quests);
    sum.quests.diaries.push(...week.quests.diaries);
    sum.playtime.activeSeconds += week.playtime.activeSeconds;
    sum.playtime.afkSeconds += week.playtime.afkSeconds;
    sum.playtime.previousWeekPlayedSeconds += week.playtime.previousWeekPlayedSeconds;
    for (const [world, seconds] of Object.entries(week.playtime.byWorld))
      addTo(sum.playtime.byWorld, world, seconds);
    for (const [skill, gain] of Object.entries(week.xp)) {
      const total = (sum.xp[skill] ??= { xp: 0, levels: 0 });
      total.xp += gain.xp;
      total.levels += gain.levels;
    }
    sum.loot.geValue = capLootValue(sum.loot.geValue + week.loot.geValue);
    drops.push(...week.loot.topDrops);
    for (const [boss, gained] of Object.entries(week.kc)) addTo(sum.kc, boss, gained);
  }
  // A stable sort keeps each account's own order for exact ties.
  sum.loot.topDrops = drops.sort(compareDrops).slice(0, TOP_DROPS);
  sum.bank = mergeBank(banks);
  // The newest five of the union are among each account's newest five.
  sum.clog.recentItems = sum.clog.recentItems.sort(compareClogItems).slice(0, WEEKLY_CLOG_ITEMS);
  sum.quests.quests.sort(compareQuests);
  sum.quests.diaries.sort(compareDiaries);
  return sum;
}

/** The world with the most play time; the lowest number on a tie. */
function mostPlayedWorld(byWorld: Record<string, number>): number | null {
  let best: { world: number; seconds: number } | undefined;
  for (const [key, seconds] of Object.entries(byWorld)) {
    const world = Number(key);
    if (!best || seconds > best.seconds || (seconds === best.seconds && world < best.world))
      best = { world, seconds };
  }
  return best?.world ?? null;
}

type WeeklySections = Pick<
  WeeklyResponse,
  'playtime' | 'xp' | 'loot' | 'kc' | 'pets' | 'bank' | 'collectionLog' | 'quests'
>;

/**
 * The response sections of a (merged) week. A section without content is
 * `null`. Reads `db` only for the KC or XP of the week's pets.
 */
export function weeklySections(db: Queryable, week: AccountWeek): WeeklySections {
  const { activeSeconds, afkSeconds, previousWeekPlayedSeconds, byWorld } = week.playtime;
  const playedSeconds = activeSeconds + afkSeconds;

  let xpGained = 0;
  let levelsGained = 0;
  for (const gain of Object.values(week.xp)) {
    xpGained += gain.xp;
    levelsGained += gain.levels;
  }
  const topSkills = Object.entries(week.xp)
    .filter(([, gain]) => gain.xp > 0)
    .sort(([a, ga], [b, gb]) => gb.xp - ga.xp || compareSkills(a, b))
    .slice(0, TOP_SKILLS)
    .map(([skill, gain]) => ({ skill, xpGained: gain.xp }));

  const bosses = Object.entries(week.kc)
    .filter(([, gained]) => gained > 0)
    .sort(([a], [b]) => compareText(a, b))
    .map(([boss, gained]) => ({ boss, gained }));

  const lastDay = week.bank?.days[week.bank.days.length - 1];
  const { quests } = week;

  return {
    playtime:
      playedSeconds > 0
        ? {
            playedSeconds,
            activeSeconds,
            afkSeconds,
            previousWeekPlayedSeconds,
            mostPlayedWorld: mostPlayedWorld(byWorld),
          }
        : null,
    xp: xpGained > 0 || levelsGained > 0 ? { xpGained, levelsGained, topSkills } : null,
    loot:
      week.loot.topDrops.length > 0 || week.loot.geValue > 0
        ? { geValue: week.loot.geValue, topDrops: week.loot.topDrops }
        : null,
    kc: bosses.length > 0 ? { bosses } : null,
    pets:
      week.pets.length > 0
        ? { pets: week.pets.map((pet) => petOf(db, pet)).sort(comparePets) }
        : null,
    bank:
      week.bank && lastDay
        ? { startGeValue: week.bank.start, endGeValue: lastDay.geValue, days: week.bank.days }
        : null,
    collectionLog: week.clog.newItems > 0 ? week.clog : null,
    quests:
      quests.quests.length > 0 || quests.diaries.length > 0 || quests.questPointsGained > 0
        ? { ...quests, questPointsGained: Math.min(quests.questPointsGained, MAX_QUEST_POINTS) }
        : null,
  };
}

// --- Stored weeks -------------------------------------------------------------------

interface StoredWeek {
  week: AccountWeek;
  computedAt: string;
}

/** A stored row, or `undefined` if missing or stale (other `TZ` or data version). */
function storedWeek(
  db: Queryable,
  accountId: number,
  key: string,
  range: Range,
): StoredWeek | undefined {
  const row = db
    .select()
    .from(weeklySummaries)
    .where(and(eq(weeklySummaries.accountId, accountId), eq(weeklySummaries.isoWeek, key)))
    .get();
  if (row?.start !== iso(range.start) || row.end !== iso(range.end)) return undefined;
  try {
    const week = JSON.parse(row.data) as AccountWeek;
    return week.v === WEEKLY_DATA_VERSION ? { week, computedAt: row.computedAt } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A completed week of one account: the stored row, or computed and stored.
 * Computing and storing run in one immediate transaction, so no event can be
 * projected (and invalidate the week) between reading and writing.
 */
function completedWeek(
  db: Queryable,
  accountId: number,
  key: string,
  range: Range,
  timeZone: string,
  nowIso: string,
): StoredWeek {
  const stored = storedWeek(db, accountId, key, range);
  if (stored) return stored;
  return db.transaction(
    (tx) => {
      // Another request may have stored it in the meantime.
      const again = storedWeek(tx, accountId, key, range);
      if (again) return again;
      const week = computeAccountWeek(tx, accountId, range, timeZone, Date.parse(nowIso));
      const row = {
        accountId,
        isoWeek: key,
        start: iso(range.start),
        end: iso(range.end),
        data: JSON.stringify(week),
        computedAt: nowIso,
      };
      tx.insert(weeklySummaries)
        .values(row)
        .onConflictDoUpdate({
          target: [weeklySummaries.accountId, weeklySummaries.isoWeek],
          set: { start: row.start, end: row.end, data: row.data, computedAt: row.computedAt },
        })
        .run();
      return { week, computedAt: nowIso };
    },
    { behavior: 'immediate' },
  );
}

/** ID and first event time of the given (owned) accounts. */
function accountsOf(
  db: Queryable,
  accountIds: readonly number[],
): { id: number; firstSeenAt: string }[] {
  return db
    .select({ id: accounts.id, firstSeenAt: accounts.firstSeenAt })
    .from(accounts)
    .where(inArray(accounts.id, accountIds))
    .orderBy(asc(accounts.id))
    .all();
}

/**
 * The weekly summary of `week` (default: the current local week) for the
 * given accounts, merged. The current and future weeks are computed on the
 * fly; completed weeks are served from `weekly_summaries`. The route resolves
 * the IDs to accounts the user owns.
 */
export function weeklySummary(
  db: Queryable,
  accountIds: readonly number[],
  week: string | undefined,
  timeZone: string,
  nowMs: number,
): WeeklyResponse {
  const key = week ?? periodKey(nowMs, 'week', timeZone);
  const range = isoWeekRange(key, timeZone);
  const nowIso = iso(nowMs);
  const complete = range.end <= nowMs;

  let computedAt = nowIso;
  const weeks: AccountWeek[] = [];
  for (const { id, firstSeenAt } of accountsOf(db, accountIds)) {
    // Every event is at or after `first_seen_at`, so earlier weeks are empty.
    // They aren't stored, so reading old weeks never fills the table.
    if (range.end <= Date.parse(firstSeenAt)) continue;
    if (!complete) {
      weeks.push(computeAccountWeek(db, id, range, timeZone, nowMs));
      continue;
    }
    const stored = completedWeek(db, id, key, range, timeZone, nowIso);
    weeks.push(stored.week);
    // The oldest data in the answer.
    if (stored.computedAt < computedAt) computedAt = stored.computedAt;
  }

  return {
    week: key,
    start: iso(range.start),
    end: iso(range.end),
    complete,
    computedAt,
    ...weeklySections(db, mergeWeeks(weeks)),
  };
}
