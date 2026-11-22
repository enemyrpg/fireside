import type { AccountSummary } from '@fireside/shared';
import { useIsAdmin } from '@/api/auth';
import {
  useCollectionLogStatus,
  useExternalSources,
  useSetCollectionLogSource,
  useSyncCollectionLog,
} from '@/api/hooks';
import { Switch } from '@/components/Switch';
import { Button } from '@/components/ui/button';
import { formatInt } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useNow } from '@/hooks/useNow';
import { accountName } from '@/lib/accounts';
import { canSyncNow, CLOG_NEEDS_ACTION, CLOG_SOURCE_NAME, clogStatusText } from '@/lib/clog';

// Settings → OSRS accounts: the owner's opt-in to fetch one account's
// collection log from RuneProfile. Nothing is looked up for an account until
// its switch is on.

export function CollectionLogSource({ account }: { account: AccountSummary }) {
  const log = useCollectionLogStatus(account.id);
  // Which `.env` setting is missing: only admins may read the server's sources.
  const isAdmin = useIsAdmin();
  const sources = useExternalSources({ enabled: isAdmin });
  const setSource = useSetCollectionLogSource();
  const syncNow = useSyncCollectionLog();
  const format = useFormat();
  // Often enough for "Sync now" to come back soon after its minute is over.
  const now = useNow(5_000);

  if (log.isError) {
    return (
      <div role="alert" className="mt-1.5 flex items-center gap-2 text-xs text-text-2">
        Couldn&apos;t load the collection log settings.
        <Button
          variant="link"
          size="xs"
          className="h-auto px-0"
          onClick={() => {
            void log.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (!log.data) return null;

  const { source, sourceAvailable, sync, obtained, total, updatedAt } = log.data;
  const on = source === 'RUNEPROFILE';
  // Off on the server: the switch can still be turned off, never on. Read
  // from the account's own status, so members see it too.
  const unavailable = !sourceAvailable;
  const server = sources.data?.sources.find((entry) => entry.id === 'RUNEPROFILE');
  const canSync = on && canSyncNow(log.data, now) && !syncNow.isPending;
  const text = sync ? clogStatusText(sync.status, accountName(account)) : null;

  return (
    <div className="border-t border-hover pt-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <Switch
          label={`Collection log from ${CLOG_SOURCE_NAME}`}
          checked={on}
          disabled={setSource.isPending || (unavailable && !on)}
          onChange={(checked) => {
            setSource.mutate({ accountId: account.id, source: checked ? 'RUNEPROFILE' : null });
          }}
        />
        {on && (
          <Button
            variant="outline"
            disabled={!canSync}
            onClick={() => {
              syncNow.mutate({ accountId: account.id });
            }}
          >
            Sync now
          </Button>
        )}
      </div>
      <p className="mt-1.5 mb-0 text-xs text-text-3">
        Needs the {CLOG_SOURCE_NAME} plugin in RuneLite. A {CLOG_SOURCE_NAME} profile is public:
        anyone can see its collection log, quests and diaries.
      </p>
      {unavailable &&
        (server ? (
          <p className="mt-1 mb-0 text-xs text-text-3">
            Off on this server: set{' '}
            <code className="font-mono">
              {server.enabled ? 'USER_AGENT_CONTACT' : `${server.envName}=true`}
            </code>{' '}
            in <code className="font-mono">.env</code>.
          </p>
        ) : (
          !isAdmin && (
            <p className="mt-1 mb-0 text-xs text-text-3">
              Off on this server. The server&apos;s admin can turn it on.
            </p>
          )
        ))}
      {setSource.isError && (
        <p role="alert" className="mt-1 mb-0 text-xs text-down">
          Couldn&apos;t save the setting. Try again.
        </p>
      )}
      {on && sync && (
        <div className="mt-1.5 text-xs text-text-2">
          {obtained !== null && total !== null && updatedAt !== null && (
            <p className="m-0">
              {formatInt(obtained)} of {formatInt(total)} collection log slots
              {sync.lastSuccessAt && ` · synced ${format.relative(sync.lastSuccessAt)}`}
            </p>
          )}
          {text !== null && (
            <p
              {...(CLOG_NEEDS_ACTION.has(sync.status) ? { role: 'alert' } : { role: 'status' })}
              className="m-0"
            >
              {text}
            </p>
          )}
          {syncNow.isError && (
            <p role="alert" className="m-0 text-down">
              Couldn&apos;t start a sync. Try again in a minute.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
