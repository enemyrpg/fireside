import type { DiariesResponse, DiaryTier, QuestResponse } from '@fireside/shared';

// Rules of the Quests & diaries page. The API gives quests and miniquests in
// one list sorted by name; how they are grouped, searched and shown lives here.

/** Path of the Quests & diaries page below `/:acc` (also in the page registry). */
export const QUESTS_PAGE_PATH = 'collections/quests';

/** Link to the Quests & diaries page of an account or `all`. */
export function questsHref(scope: string | number): string {
  return `/${String(scope)}/${QUESTS_PAGE_PATH}`;
}

/**
 * An answer of `…/quests` or `…/diaries` only if the account has a snapshot.
 * Without one the API answers `updatedAt: null` with zeros and empty lists,
 * which counts as no data everywhere: the page, its numbers, and whether the
 * page exists at all.
 */
export function withSnapshot<T extends { updatedAt: string | null }>(
  response: T | undefined,
): (T & { updatedAt: string }) | undefined {
  return response !== undefined && response.updatedAt !== null
    ? (response as T & { updatedAt: string })
    : undefined;
}

/**
 * The groups of the Quests card, in display order. The first three hold
 * quests only, by state; miniquests have a group of their own, like the
 * game's quest list.
 */
export const QUEST_GROUPS = [
  { id: 'inProgress', label: 'In progress', defaultOpen: true },
  { id: 'notStarted', label: 'Not started', defaultOpen: true },
  { id: 'completed', label: 'Completed', defaultOpen: false },
  { id: 'miniquests', label: 'Miniquests', defaultOpen: false },
] as const;

export type QuestGroupId = (typeof QUEST_GROUPS)[number]['id'];

export type QuestGroups = Record<QuestGroupId, QuestResponse[]>;

const GROUP_OF_STATE: Record<QuestResponse['state'], QuestGroupId> = {
  IN_PROGRESS: 'inProgress',
  NOT_STARTED: 'notStarted',
  FINISHED: 'completed',
};

/** The quests of each group, in the order given (the API's: by name). */
export function groupQuests(quests: readonly QuestResponse[]): QuestGroups {
  const groups: QuestGroups = { inProgress: [], notStarted: [], completed: [], miniquests: [] };
  for (const quest of quests) {
    groups[quest.kind === 'MINIQUEST' ? 'miniquests' : GROUP_OF_STATE[quest.state]].push(quest);
  }
  return groups;
}

/** Quests whose name contains `query`, ignoring case. An empty query matches all. */
export function searchQuests(
  quests: readonly QuestResponse[],
  query: string,
): readonly QuestResponse[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return quests;
  return quests.filter((quest) => quest.name.toLowerCase().includes(needle));
}

/** A quest or diary tier with the date it was first seen as completed. */
export type Completion =
  | { kind: 'quest'; key: string; name: string; at: string }
  | { kind: 'diary'; key: string; name: string; tier: DiaryTier; at: string };

/** Rows of "Recently completed". */
export const RECENT_COMPLETIONS = 5;

/**
 * The newest completions with a known date, newest first. What was completed
 * before tracking started has no date and is left out.
 */
export function recentCompletions(
  quests: readonly QuestResponse[],
  regions: DiariesResponse['regions'],
  limit = RECENT_COMPLETIONS,
): Completion[] {
  const completions: Completion[] = [];
  for (const quest of quests) {
    if (quest.finishedAt !== null) {
      completions.push({
        kind: 'quest',
        key: `quest:${quest.quest}`,
        name: quest.name,
        at: quest.finishedAt,
      });
    }
  }
  for (const region of regions) {
    for (const tier of region.tiers) {
      if (tier.completedAt !== null) {
        completions.push({
          kind: 'diary',
          key: `diary:${region.region}:${tier.tier}`,
          name: region.name,
          tier: tier.tier,
          at: tier.completedAt,
        });
      }
    }
  }
  // Timestamps are UTC ISO 8601, so they sort as text. Ties keep the order above.
  return completions.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}
