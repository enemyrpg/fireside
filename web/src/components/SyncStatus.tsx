import type { CollectionLogStatusResponse } from '@fireside/shared';
import { useSyncCollectionLog } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/hooks/useFormat';
import { useNow } from '@/hooks/useNow';
import { canSyncNow, CLOG_SOURCE_NAME } from '@/lib/clog';

type Sync = ReturnType<typeof useSyncCollectionLog>;

/**
 * "Sync now" for an account with a collection log source: "Syncing…" while a
 * sync runs, and off for the first minute after an attempt and when the
 * source is off on the server (`canSyncNow`). The one sync button, on
 * Collection log and on Pets.
 */
export function SyncNowButton({
  status,
  stale = false,
  sync,
  className,
}: {
  status: CollectionLogStatusResponse;
  /** The status could not be read again: a running sync is no longer known, so no "Syncing…". */
  stale?: boolean;
  /** The page's own "Sync now" mutation, so the page can show its error. */
  sync: Sync;
  className?: string | undefined;
}) {
  // Often enough for "Sync now" to come back soon after its minute is over.
  const now = useNow(5_000);
  const syncing = (status.sync?.status === 'SYNCING' && !stale) || sync.isPending;
  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      disabled={syncing || !canSyncNow(status, now)}
      onClick={() => {
        sync.mutate({ accountId: status.accountId });
      }}
    >
      {syncing ? 'Syncing…' : 'Sync now'}
    </Button>
  );
}

/**
 * Sync state and "Sync now" for the top bar of the Collection log page. The
 * text is hidden on mobile; the button stays. With the source off there is
 * nothing to sync: only the age of what is stored.
 */
export function SyncStatus({
  status,
  stale = false,
  sync,
  button = true,
}: {
  status: CollectionLogStatusResponse;
  /**
   * The status could not be read again, so what it says about a running sync
   * is no longer known: no "Syncing…" (the banner says the server is away).
   */
  stale?: boolean;
  /** The page's own "Sync now" mutation, so the page can show its error. */
  sync: Sync;
  /** Off on mobile, where the page has its own full-width button. */
  button?: boolean;
}) {
  const format = useFormat();
  const text = 'text-table whitespace-nowrap text-text-3 max-desk:hidden';

  if (status.source === null || status.sync === null) {
    return (
      <span className={text}>
        Sync is off
        {status.updatedAt !== null && ` · updated ${format.relative(status.updatedAt)}`}
      </span>
    );
  }
  return (
    <>
      <span className={text}>
        {status.sync.lastSuccessAt !== null
          ? `Synced ${format.relative(status.sync.lastSuccessAt)}`
          : 'Not synced yet'}
        {` · ${CLOG_SOURCE_NAME}`}
      </span>
      {button && <SyncNowButton status={status} stale={stale} sync={sync} />}
    </>
  );
}
