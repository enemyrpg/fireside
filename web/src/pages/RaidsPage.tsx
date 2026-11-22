import { RAIDS, type RaidDrop } from '@fireside/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccounts, useDeleteRaidDrop, useKc, useRaids, useRaidSplits } from '@/api/hooks';
import { AddDropDialog } from '@/components/AddDropDialog';
import { Card, CardHeader } from '@/components/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EditDropDialog, type EditDropTarget } from '@/components/EditDropDialog';
import type { AccountsView } from '@/components/KcByAccount';
import { RaidCard } from '@/components/RaidCard';
import { RaidsStrip, type RaidTotals } from '@/components/RaidsStrip';
import { StackedColumns } from '@/components/StackedColumns';
import {
  SpecialLootList,
  SpecialLootTable,
  TAP_TO_EDIT,
  type AccountLabel,
} from '@/components/SpecialLootTable';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { accountColors, accountNameById } from '@/lib/accounts';
import { DEFAULT_MODE, dropRowId } from '@/lib/raid-splits';
import {
  raidCards,
  raidColumn,
  raidCompletions,
  splitRaidCards,
  totalSpecialLoot,
  type RaidCardData,
  type SharesState,
} from '@/lib/raids';
import { cn } from '@/lib/utils';
import { useAccountScope } from '@/routing/useAccountScope';

// Raids tab of Progress: the number row with your share and the account's
// default Split or FFA, a card per raid with completions (per mode the KC and
// best time per team size from `kc`, loot values from `raids`, your share from
// `raids/splits`), one dashed line naming the raids without, and the special
// loot with the owner's choices per purple. All time, and all values before GE
// tax.

/** Purples per "Load more" page, as for drops and sessions. */
export const SPECIAL_LOOT_PAGE_SIZE = 20;

export const SPECIAL_LOOT_EMPTY = 'Purples from your raids show up here.';

/** Pages fetched at most when jumping to a possible duplicate that isn't loaded yet. */
export const SHOW_DROP_MAX_PAGES = 5;
export const DROP_FURTHER_DOWN = 'The other drop is further down. Load more to find it.';

/** How long the row a jump landed on stays highlighted. */
const HIGHLIGHT_MS = 2500;

/** Under the cards when there are several: what the chips are (`ProgressRaidsAll`). */
export const BEST_TIMES_NOTE =
  'Best time per team size, fastest in each mode highlighted. Only the sizes you have done are shown.';

/** The Special loot heading, focused after the last drop in the list was deleted. */
const SPECIAL_LOOT_HEADING_ID = 'special-loot-heading';

/** "No completions yet: A · B." on one dashed line; on PC with when they show up. */
function NoCompletions({ raids }: { raids: readonly string[] }) {
  return (
    <p className="m-0 rounded-[14px] border border-dashed border-border-strong px-4 py-3 text-sm text-text-3 desk:rounded-xl desk:px-[18px] desk:py-3.5">
      No completions yet: {raids.join(' · ')}.
      <span className="max-desk:hidden"> They show up here after your first one.</span>
    </p>
  );
}

/**
 * The raid cards: only raids with something to show get a card. One: full
 * width. Several: two columns that stack on their own (`StackedColumns`, like
 * Weekly), alternating among the cards shown.
 */
function RaidCards({
  cards,
  shares,
  accounts,
}: {
  cards: readonly RaidCardData[];
  /** Raids with neither completions nor loot wait for the share (`splitRaidCards`). */
  shares: SharesState;
  accounts: AccountsView | undefined;
}) {
  const { shown, empty, pending } = splitRaidCards(cards, shares);
  return (
    <>
      {/* Only raids that wait for the tracker: a skeleton, not an empty space. */}
      {shown.length === 0 && pending > 0 && (
        <Card aria-busy="true">
          <CardSkeleton lines={5} />
        </Card>
      )}
      {shown.length === 1 && shown[0] && (
        <RaidCard card={shown[0]} layout="single" accounts={accounts} />
      )}
      {shown.length > 1 && (
        <div className="flex flex-col gap-4">
          <StackedColumns
            items={shown.map((card, index) => ({
              key: card.raid,
              column: raidColumn(index),
              node: <RaidCard card={card} layout="stacked" accounts={accounts} />,
            }))}
          />
          <p className="m-0 text-xs text-text-3">{BEST_TIMES_NOTE}</p>
        </div>
      )}
      {empty.length > 0 && <NoCompletions raids={empty} />}
    </>
  );
}

export function RaidsPage() {
  const scope = useAccountScope();
  const desktop = useIsDesktop();
  const kc = useKc(scope);
  // Only the loot value per raid is read from `raids`; its list is not shown.
  const raids = useRaids(scope, { limit: 1 });
  const splits = useRaidSplits(scope, { limit: SPECIAL_LOOT_PAGE_SIZE });
  const list = useAccounts().data?.accounts;
  const accounts = useMemo(
    () => (list ? { list, colors: accountColors(list) } : undefined),
    [list],
  );

  const [editing, setEditing] = useState<EditDropTarget>();
  const [deleting, setDeleting] = useState<RaidDrop>();
  // Mobile deletes from the edit sheet, so the confirmation has no opener to
  // go back to: Cancel goes to the drop's row, a deletion to the next row (or
  // the heading when it was the last).
  const deleteFocus = useRef<{ fromSheet: boolean; row: string; afterDelete?: string }>({
    fromSheet: false,
    row: '',
  });
  const [adding, setAdding] = useState(false);
  // A new object per jump, so jumping to the same drop again scrolls and focuses again.
  const [highlighted, setHighlighted] = useState<{ dropId: string }>();
  const [jumpMessage, setJumpMessage] = useState<string>();
  const deleteDrop = useDeleteRaidDrop();

  // The cards need `kc` and `raids`: data when both have it, an error if either
  // failed, and Retry fetches the failed ones again. The share is optional: a
  // card shows "–" for it while the tracker loads or when it failed (the
  // Retry for that is in "Your share" at the top).
  const bosses = kc.data?.bosses;
  const summaries = raids.data?.pages[0]?.raids;
  const overview = splits.data?.pages[0];
  const shares = overview?.raids;
  const cards = useMemo(
    () =>
      bosses !== undefined && summaries !== undefined
        ? raidCards(RAIDS, bosses, summaries, shares)
        : undefined,
    [bosses, summaries, shares],
  );
  const cardsFailed = cards === undefined && (kc.isError || raids.isError);
  const retryCards = () => {
    if (kc.isError) void kc.refetch();
    if (raids.isError) void raids.refetch();
  };
  const totals: RaidTotals | undefined = useMemo(
    () => (cards ? { specialLoot: totalSpecialLoot(cards), ...raidCompletions(cards) } : undefined),
    [cards],
  );
  const raidAccounts = scope === 'all' ? accounts : undefined;

  const drops = splits.data?.pages.flatMap((page) => page.drops.items);
  const accountLabel: AccountLabel = (accountId) =>
    scope === 'all' && accounts
      ? {
          name: accountNameById(accountId, accounts.list),
          color: accounts.colors.get(accountId) ?? 'var(--afk)',
        }
      : undefined;
  // In the number row the dots stand alone, so they are named for every scope.
  const defaultsLabel: AccountLabel = (accountId) =>
    accounts
      ? {
          name: accountNameById(accountId, accounts.list),
          color: accounts.colors.get(accountId) ?? 'var(--afk)',
        }
      : undefined;

  // Scroll to and focus the row a jump landed on, and highlight it for a moment.
  useEffect(() => {
    if (highlighted === undefined) return undefined;
    const row = document.getElementById(dropRowId(highlighted.dropId));
    row?.scrollIntoView({ block: 'center' });
    row?.focus({ preventScroll: true });
    const timer = setTimeout(() => {
      setHighlighted(undefined);
    }, HIGHLIGHT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [highlighted]);

  /**
   * Jumps to a drop in the table (the detected drop a manual one may
   * duplicate). It is within two hours of the manual drop, so nearly always
   * loaded; if not, a few more pages are fetched, never the whole list.
   */
  const showDrop = async (dropId: string) => {
    setJumpMessage(undefined);
    let pages = splits.data?.pages ?? [];
    const loaded = () => pages.some((page) => page.drops.items.some((d) => d.dropId === dropId));
    for (
      let fetched = 0;
      !loaded() && fetched < SHOW_DROP_MAX_PAGES && pages.at(-1)?.drops.nextCursor != null;
      fetched++
    ) {
      const result = await splits.fetchNextPage();
      // A failed fetch shows its own error with Retry under the table; the
      // drop is not known to be further down.
      if (result.isError || result.data === undefined) return;
      pages = result.data.pages;
    }
    if (loaded()) setHighlighted({ dropId });
    else setJumpMessage(DROP_FURTHER_DOWN);
  };

  const startDelete = (drop: RaidDrop, fromSheet: boolean) => {
    deleteDrop.reset();
    deleteFocus.current = { fromSheet, row: dropRowId(drop.dropId) };
    setEditing(undefined);
    setDeleting(drop);
  };

  let body;
  if (drops !== undefined) {
    body =
      drops.length === 0 ? (
        <EmptyState className="min-h-[160px]">{SPECIAL_LOOT_EMPTY}</EmptyState>
      ) : (
        <>
          {desktop ? (
            <SpecialLootTable
              drops={drops}
              accountLabel={accountLabel}
              highlightedDropId={highlighted?.dropId}
              onEdit={setEditing}
              onDelete={(drop) => {
                startDelete(drop, false);
              }}
              onShowDrop={(dropId) => void showDrop(dropId)}
            />
          ) : (
            <SpecialLootList
              drops={drops}
              accountLabel={accountLabel}
              highlightedDropId={highlighted?.dropId}
              onEdit={setEditing}
              onShowDrop={(dropId) => void showDrop(dropId)}
            />
          )}
          {jumpMessage !== undefined && (
            <p role="status" className="m-0 mt-3 text-center text-sm text-text-2">
              {jumpMessage}
            </p>
          )}
          {splits.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                // Full width with a 44 px target on mobile (`MobileRaids`).
                className="max-desk:h-11 max-desk:w-full"
                disabled={splits.isFetchingNextPage}
                onClick={() => {
                  setJumpMessage(undefined);
                  void splits.fetchNextPage();
                }}
              >
                {splits.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
          {splits.isFetchNextPageError && (
            <ErrorState className="min-h-0" onRetry={() => void splits.fetchNextPage()} />
          )}
          {!desktop && <p className="m-0 mt-3 text-xs text-text-3">{TAP_TO_EDIT}</p>}
        </>
      );
  } else if (splits.isError) {
    body = <ErrorState onRetry={() => void splits.refetch()} />;
  } else {
    body = <CardSkeleton lines={6} />;
  }

  let raidSection;
  if (cards !== undefined) {
    const sharesState: SharesState =
      overview !== undefined ? 'loaded' : splits.isError ? 'failed' : 'loading';
    raidSection = <RaidCards cards={cards} shares={sharesState} accounts={raidAccounts} />;
  } else if (cardsFailed) {
    raidSection = (
      <Card>
        <ErrorState onRetry={retryCards} />
      </Card>
    );
  } else {
    raidSection = (
      <Card aria-busy="true">
        <CardSkeleton lines={5} />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <RaidsStrip
        scope={scope}
        query={{ data: overview, isError: splits.isError, refetch: () => splits.refetch() }}
        totals={totals}
        totalsFailed={cardsFailed}
        accountLabel={defaultsLabel}
      />
      {raidSection}
      <Card>
        <CardHeader
          headingId={SPECIAL_LOOT_HEADING_ID}
          title={
            <span className="flex items-baseline gap-2.5">
              Special loot
              <span className="text-xs font-normal text-text-3">
                {/* Mobile shows the share only (`MobileRaids`); PC has every column. */}
                {desktop ? 'All time' : 'your share'}
              </span>
            </span>
          }
          // A drop added by hand belongs to one account, so not under "All accounts".
          {...(scope !== 'all' && drops !== undefined
            ? {
                action: (
                  <Button
                    variant="outline"
                    className={cn('max-desk:h-11')}
                    onClick={() => {
                      setAdding(true);
                    }}
                  >
                    Add drop
                  </Button>
                ),
              }
            : {})}
        />
        {body}
      </Card>
      <EditDropDialog
        target={editing}
        defaultMode={
          overview?.defaults.find((entry) => entry.accountId === editing?.drop.accountId)?.mode ??
          DEFAULT_MODE
        }
        onClose={() => {
          setEditing(undefined);
        }}
        // Mobile rows have no bin: a drop added by hand is deleted from the sheet.
        {...(desktop
          ? {}
          : {
              onDelete: (drop: RaidDrop) => {
                startDelete(drop, true);
              },
            })}
      />
      {scope !== 'all' && (
        <AddDropDialog
          open={adding}
          accountId={scope}
          onClose={() => {
            setAdding(false);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title="Delete this drop?"
        description={
          deleting
            ? `${deleting.name} from ${deleting.raid}, which you added yourself. Its ${
                deleting.recipient === 'TEAMMATE' ? 'nickname, note' : 'note'
              } and value are deleted with it.`
            : ''
        }
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        pending={deleteDrop.isPending}
        destructive
        error={deleteDrop.isError ? "Couldn't delete the drop. Try again." : undefined}
        focusOnClose={() => {
          const { fromSheet, row, afterDelete } = deleteFocus.current;
          deleteFocus.current = { fromSheet: false, row: '' };
          if (!fromSheet) return null;
          return document.getElementById(afterDelete ?? row);
        }}
        onConfirm={() => {
          if (!deleting) return;
          const list = drops ?? [];
          const index = list.findIndex((drop) => drop.dropId === deleting.dropId);
          const next = index === -1 ? undefined : list[index + 1];
          deleteDrop.mutate(
            { accountId: deleting.accountId, dropId: deleting.dropId },
            {
              onSuccess: () => {
                // The next row, or the heading when the deleted drop was the last.
                deleteFocus.current.afterDelete = next
                  ? dropRowId(next.dropId)
                  : SPECIAL_LOOT_HEADING_ID;
                setDeleting(undefined);
              },
            },
          );
        }}
      />
    </div>
  );
}
