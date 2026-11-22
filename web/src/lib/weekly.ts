import type { WeeklyBank, WeeklyCollectionLog, WeeklyQuests } from '@fireside/shared';
import { formatGp, formatInt } from '@/format';

// Texts of the Weekly sections for the bank, the collection log and quests.

/** Path of the Weekly page below `/:acc`, without the week (also in the page registry). */
export const WEEKLY_PAGE_PATH = 'activity/weekly';

/**
 * The change in net worth through the week: `▲ 8.63M gp (+0.3%)`. One
 * decimal in the percentage, since a week is a small part of a bank. No
 * percentage from a start of 0, and `null` when the start is not known (the
 * first snapshot came during the week).
 */
export function bankChangeText(
  bank: Pick<WeeklyBank, 'startGeValue' | 'endGeValue'>,
): string | null {
  const start = bank.startGeValue;
  if (start === null) return null;
  const diff = bank.endGeValue - start;
  if (diff === 0) return 'No change';
  const percent =
    start === 0 ? '' : ` (${diff < 0 ? '−' : '+'}${(Math.abs(diff / start) * 100).toFixed(1)}%)`;
  return `${diff > 0 ? '▲' : '▼'} ${formatGp(Math.abs(diff))}${percent}`;
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${formatInt(count)} ${count === 1 ? one : many}`;

/** `3 new items · 712 of 1,568`; without the counts when no collection log was stored yet. */
export function clogSummary(
  clog: Pick<WeeklyCollectionLog, 'newItems' | 'obtained' | 'total'>,
): string {
  const items = plural(clog.newItems, 'new item');
  if (clog.obtained === null || clog.total === null) return items;
  return `${items} · ${formatInt(clog.obtained)} of ${formatInt(clog.total)}`;
}

/** `1 quest · 1 miniquest · 1 diary tier · +2 quest points`, only the parts that have any. */
export function questsSummary(section: WeeklyQuests): string {
  const quests = section.quests.filter((quest) => quest.kind === 'QUEST').length;
  const miniquests = section.quests.length - quests;
  const points = section.questPointsGained;
  return [
    quests > 0 && plural(quests, 'quest'),
    miniquests > 0 && plural(miniquests, 'miniquest'),
    section.diaries.length > 0 && plural(section.diaries.length, 'diary tier'),
    points > 0 && `+${plural(points, 'quest point')}`,
  ]
    .filter((part) => part !== false)
    .join(' · ');
}
