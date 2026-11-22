import type { DiariesResponse, QuestResponse, QuestsResponse } from '@fireside/shared';
import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import {
  hasQuestData,
  useAccounts,
  useDiaries,
  useQuests,
  useQuestStatuses,
  type AccountQuestStatus,
} from '@/api/hooks';
import { AccountCards, type AccountCard } from '@/components/AccountCards';
import { Badge } from '@/components/Badge';
import { Card, CardHeader } from '@/components/Card';
import { CollapsibleSection } from '@/components/CollapsibleSection';
import { SearchField } from '@/components/SearchField';
import { CardSkeleton, EmptyMessage, EmptyState, ErrorState } from '@/components/states';
import { StatStrip } from '@/components/StatStrip';
import { TierPips } from '@/components/TierPips';
import { formatCount, formatInt, titleCase } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { accountCardInfo } from '@/lib/accounts';
import {
  groupQuests,
  QUEST_GROUPS,
  questsHref,
  recentCompletions,
  searchQuests,
  withSnapshot,
  type QuestGroupId,
} from '@/lib/quests';
import { cn } from '@/lib/utils';
import { useAccountScope } from '@/routing/useAccountScope';

// Quests & diaries: `/:acc/collections/quests?q=`. Three numbers, the diary tiers per region, what
// was completed lately, and the quests in groups that fold. Quest and diary status belongs to one
// account, so `all` shows one card per account instead. Nothing polls: the plugin sends a snapshot
// after login and when something changes. The page exists only once an account has quest or diary
// data (`requires` in the registry).

/** Shown for a number whose snapshot the account doesn't have yet. */
const NO_VALUE = '–';
const NO_DATA_NOTE = 'No data yet';

/** "21 of 32". */
function ofTotal(done: number, total: number): string {
  return `${formatInt(done)} of ${formatInt(total)}`;
}

// --- The three numbers --------------------------------------------------------

function QuestStrip({
  quests,
  diaries,
}: {
  /** Each only when the account has that snapshot (`withSnapshot`). */
  quests: (QuestsResponse & { updatedAt: string }) | undefined;
  diaries: DiariesResponse | undefined;
}) {
  const format = useFormat();
  return (
    <StatStrip
      label="Quests and diaries summary"
      mobileColumns={2}
      items={[
        // No "of N": the API has no maximum of quest points.
        {
          key: 'points',
          value: quests ? formatInt(quests.questPoints) : NO_VALUE,
          label: quests
            ? `quest points · updated ${format.relative(quests.updatedAt)}`
            : `quest points · ${NO_DATA_NOTE.toLowerCase()}`,
          shortLabel: 'quest points',
        },
        // Quests only. Miniquests are counted in their own group below.
        {
          key: 'quests',
          value: quests ? (
            <>
              <span className="desk:hidden">
                {ofTotal(quests.totals.finished, quests.totals.total)}
              </span>
              <span className="max-desk:hidden">{formatInt(quests.totals.finished)}</span>
            </>
          ) : (
            NO_VALUE
          ),
          label: quests
            ? `of ${formatInt(quests.totals.total)} quests completed`
            : 'quests completed',
          shortLabel: 'quests',
          note: quests ? `${formatInt(quests.totals.inProgress)} in progress` : NO_DATA_NOTE,
        },
        {
          key: 'tiers',
          value: diaries ? (
            <>
              <span className="desk:hidden">
                {ofTotal(diaries.totals.completed, diaries.totals.tiers)}
              </span>
              <span className="max-desk:hidden">{formatInt(diaries.totals.completed)}</span>
            </>
          ) : (
            NO_VALUE
          ),
          label: diaries ? `of ${formatInt(diaries.totals.tiers)} diary tiers` : 'diary tiers',
          shortLabel: 'diary tiers',
          note: diaries
            ? `${formatCount(diaries.totals.regionsCompleted, 'region')} fully done`
            : NO_DATA_NOTE,
        },
      ]}
    />
  );
}

// --- Achievement diaries ----------------------------------------------------------

function DiariesCard({ diaries }: { diaries: DiariesResponse }) {
  return (
    <Card>
      <CardHeader
        title="Achievement diaries"
        action={
          <>
            <span className="text-xs text-text-3 max-desk:hidden desk:text-table">
              {ofTotal(diaries.totals.completed, diaries.totals.tiers)} tiers
            </span>
            {/* On mobile the pips have initials only: the header says which is which. */}
            <span aria-hidden="true" className="text-xs text-text-3 desk:hidden">
              E · M · H · E
            </span>
          </>
        }
      />
      {diaries.regions.length === 0 ? (
        <EmptyMessage>No diaries in the latest snapshot.</EmptyMessage>
      ) : (
        <ul aria-label="Achievement diaries" className="m-0 list-none p-0 text-table">
          {diaries.regions.map((region) => (
            <li
              key={region.region}
              className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-t border-hover desk:py-[9px]"
            >
              <span className="min-w-0 flex-1 truncate">{region.name}</span>
              <TierPips tiers={region.tiers} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// --- Recently completed ---------------------------------------------------------

function RecentCard({ completions }: { completions: ReturnType<typeof recentCompletions> }) {
  const format = useFormat();
  return (
    <Card>
      <CardHeader title="Recently completed" />
      <ul aria-label="Recently completed" className="m-0 list-none p-0">
        {completions.map((entry) => (
          <li
            key={entry.key}
            className="flex min-w-0 items-center gap-2.5 border-t border-hover py-2 text-table"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate">
                {entry.kind === 'diary' ? `${entry.name} diary` : entry.name}
              </span>
              {entry.kind === 'diary' && <Badge>{titleCase(entry.tier)}</Badge>}
            </span>
            <span className="text-xs whitespace-nowrap text-text-3">{format.date(entry.at)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- Quests ---------------------------------------------------------------------

type OpenGroups = Record<QuestGroupId, boolean>;

const DEFAULT_OPEN = Object.fromEntries(
  QUEST_GROUPS.map((group) => [group.id, group.defaultOpen]),
) as OpenGroups;

const ALL_OPEN = Object.fromEntries(QUEST_GROUPS.map((group) => [group.id, true])) as OpenGroups;

/** What stands to the right of a quest's name: the date, or the state where the group mixes them. */
function QuestRow({ quest, withState }: { quest: QuestResponse; withState: boolean }) {
  const format = useFormat();
  let detail: string | undefined;
  if (quest.finishedAt !== null) detail = format.date(quest.finishedAt);
  else if (withState && quest.state === 'FINISHED') detail = 'Completed';
  else if (withState && quest.state === 'IN_PROGRESS') detail = 'In progress';
  return (
    <li className="flex h-9 min-w-0 items-center gap-2 border-b border-hover last:border-b-0">
      <span
        className={cn('min-w-0 flex-1 truncate', quest.state === 'FINISHED' && 'text-text-2')}
        title={quest.name}
      >
        {quest.name}
      </span>
      {detail !== undefined && (
        <span className="text-xs whitespace-nowrap text-text-3">{detail}</span>
      )}
    </li>
  );
}

function QuestsCard({ quests }: { quests: readonly QuestResponse[] }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const searching = query.trim() !== '';
  // Folding is page state, not in the URL. A search has its own folding, so
  // clearing the search brings the groups back as they were.
  const [open, setOpen] = useState(DEFAULT_OPEN);
  const [openInSearch, setOpenInSearch] = useState(ALL_OPEN);
  // A search starts with every group open (the matches may be in a folded
  // one), however it starts: typing, back, or a link with `?q=`. Typing on
  // keeps what was folded since.
  const [wasSearching, setWasSearching] = useState(searching);
  if (searching !== wasSearching) {
    setWasSearching(searching);
    if (searching) setOpenInSearch(ALL_OPEN);
  }
  const groups = useMemo(() => groupQuests(searchQuests(quests, query)), [quests, query]);

  const shown = QUEST_GROUPS.filter((group) =>
    // While searching: only groups with matches. Else the three quest groups
    // always, and Miniquests when the account has any.
    searching || group.id === 'miniquests' ? groups[group.id].length > 0 : true,
  );

  let body: ReactNode;
  if (quests.length === 0) {
    body = <EmptyMessage>No quests in the latest snapshot.</EmptyMessage>;
  } else if (shown.length === 0) {
    body = <EmptyMessage>No quests match “{query.trim()}”.</EmptyMessage>;
  } else {
    body = shown.map((group) => {
      const rows = groups[group.id];
      const mini = group.id === 'miniquests';
      const finished = rows.filter((quest) => quest.state === 'FINISHED').length;
      return (
        <CollapsibleSection
          key={group.id}
          title={group.label}
          // Miniquests mix the states, so the count says how many are done.
          count={mini ? `${ofTotal(finished, rows.length)} completed` : formatInt(rows.length)}
          open={(searching ? openInSearch : open)[group.id]}
          onOpenChange={(next) => {
            (searching ? setOpenInSearch : setOpen)((previous) => ({
              ...previous,
              [group.id]: next,
            }));
          }}
        >
          <ul
            aria-label={group.label}
            className="m-0 grid list-none gap-x-7 px-1 pt-1 pb-2 text-table"
          >
            {rows.map((quest) => (
              <QuestRow key={quest.quest} quest={quest} withState={mini} />
            ))}
          </ul>
        </CollapsibleSection>
      );
    });
  }

  return (
    <Card className="flex flex-col gap-3 desk:gap-3.5">
      <CardHeader title="Quests" className="mb-0" />
      <SearchField
        query={query}
        // Search replaces the URL.
        onQuery={(value) => {
          setSearchParams(
            (previous) => {
              const next = new URLSearchParams(previous);
              if (value === '') next.delete('q');
              else next.set('q', value);
              return next;
            },
            { replace: true },
          );
        }}
        label="Search quests"
        className="flex-none max-desk:h-11"
      />
      <div className="flex flex-col gap-1.5">{body}</div>
      <span className="text-xs text-text-3">Searching opens every group with a match.</span>
    </Card>
  );
}

// --- One account --------------------------------------------------------------

function Loading({ tiles }: { tiles: boolean }) {
  return (
    <>
      {tiles && (
        <StatStrip items={undefined} label="Quests and diaries summary" skeletonCount={3} />
      )}
      <Card>
        <CardSkeleton lines={8} />
      </Card>
    </>
  );
}

function AccountView({ accountId }: { accountId: number }) {
  const desktop = useIsDesktop();
  const quests = useQuests(accountId);
  const diaries = useDiaries(accountId);
  const questData = withSnapshot(quests.data);
  const diaryData = withSnapshot(diaries.data);
  const recent = useMemo(
    () => recentCompletions(questData?.quests ?? [], diaryData?.regions ?? []),
    [questData, diaryData],
  );

  if (quests.data === undefined || diaries.data === undefined) {
    if (quests.isError || diaries.isError) {
      return (
        <Card>
          <ErrorState
            onRetry={() => {
              if (quests.isError) void quests.refetch();
              if (diaries.isError) void diaries.refetch();
            }}
          />
        </Card>
      );
    }
    return <Loading tiles />;
  }
  if (!questData && !diaryData) {
    return (
      <Card>
        <EmptyState>
          Log in to the game with the plugin running and this account&apos;s quests and diaries show
          up here.
        </EmptyState>
      </Card>
    );
  }
  const diaryCard = diaryData && <DiariesCard diaries={diaryData} />;
  const recentCard = recent.length > 0 && <RecentCard completions={recent} />;
  const questCard = questData && <QuestsCard quests={questData.quests} />;
  return (
    <>
      <QuestStrip quests={questData} diaries={diaryData} />
      {desktop ? (
        // PC: diaries left (with Recently completed under them), quests right.
        <div className="flex flex-wrap items-start gap-5">
          {(diaryData !== undefined || recent.length > 0) && (
            <div className="flex min-w-0 flex-[1.4_1_520px] flex-col gap-5">
              {diaryCard}
              {recentCard}
            </div>
          )}
          {questCard && <div className="min-w-0 flex-[1_1_380px]">{questCard}</div>}
        </div>
      ) : (
        // Mobile: quests first, then diaries; Recently completed last.
        <>
          {questCard}
          {diaryCard}
          {recentCard}
        </>
      )}
    </>
  );
}

// --- All accounts ---------------------------------------------------------------

function AllAccountsView() {
  const { statuses, isSettled, isError, refetch } = useQuestStatuses();
  const accounts = useAccounts().data?.accounts ?? [];
  const failed = (
    <Card>
      <ErrorState onRetry={refetch} />
    </Card>
  );

  if (statuses === undefined || !isSettled) {
    // Without the account list there is nobody to ask.
    return statuses === undefined && isError ? failed : <Loading tiles={false} />;
  }

  const cards: AccountCard[] = statuses
    .filter(hasQuestData)
    .map(({ accountId, quests, diaries }: AccountQuestStatus) => {
      const questData = withSnapshot(quests);
      const diaryData = withSnapshot(diaries);
      return {
        ...accountCardInfo(accountId, accounts),
        to: questsHref(accountId),
        // Side by side by their own width, wrapping in a narrow card.
        stats: [
          {
            key: 'points',
            label: 'quest points',
            value: questData ? formatInt(questData.questPoints) : NO_VALUE,
          },
          {
            key: 'quests',
            label: 'quests',
            value: questData
              ? ofTotal(questData.totals.finished, questData.totals.total)
              : NO_VALUE,
          },
          {
            key: 'tiers',
            label: 'diary tiers',
            value: diaryData
              ? ofTotal(diaryData.totals.completed, diaryData.totals.tiers)
              : NO_VALUE,
          },
        ],
      };
    });

  // A failed call never hides the accounts that answered: their cards stay,
  // with the Retry for the rest below.
  return (
    <>
      {cards.length > 0 && (
        <AccountCards
          cards={cards}
          label="Quests and diaries per account"
          note="Quests and diaries belong to one account. Pick an account to see them."
        />
      )}
      {isError && failed}
    </>
  );
}

// --- Page ---------------------------------------------------------------------

export function QuestsPage() {
  const scope = useAccountScope();
  return (
    <div className="flex flex-col gap-4 desk:gap-5">
      {scope === 'all' ? (
        <AllAccountsView />
      ) : (
        // Keyed by account: folding starts over for another account.
        <AccountView key={scope} accountId={scope} />
      )}
    </div>
  );
}
