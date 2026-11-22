import type { AccountSummary } from '@fireside/shared';
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useAccount, useAccounts } from '@/api/hooks';
import { Badge, LiveBadge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { AccountDot } from '@/components/shell/AccountDot';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatAccountType, formatInt } from '@/format';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { useFormat } from '@/hooks/useFormat';
import { useNow } from '@/hooks/useNow';
import { accountColors, accountName, isOnline } from '@/lib/accounts';
import { CollectionLogSource } from './CollectionLogSource';
import { SettingsLayout } from './SettingsLayout';

/** One row of an account card: label on the left, value on the right. */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-t border-hover py-[9px]">
      <span className="text-text-3">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

/** Earlier names, newest first, from `accounts/:id`. "No earlier names" until a name change. */
function NameHistory({ accountId }: { accountId: number }) {
  const detail = useAccount(accountId);
  const format = useFormat();
  const showSkeleton = useDelayedFlag(detail.isPending);

  if (detail.isError) {
    return (
      <span role="alert" className="inline-flex items-center gap-2 text-text-2">
        Couldn&apos;t load the name history.
        <Button
          variant="link"
          size="xs"
          className="h-auto px-0"
          onClick={() => {
            void detail.refetch();
          }}
        >
          Retry
        </Button>
      </span>
    );
  }
  if (!detail.data) {
    return (
      <Skeleton
        aria-label="Loading"
        className={showSkeleton ? 'inline-block h-3.5 w-40' : 'invisible inline-block h-3.5 w-40'}
      />
    );
  }
  const names = detail.data.names;
  if (names.length < 2) return <>No earlier names</>;
  return (
    <>
      {[...names].reverse().map((name, index) => (
        <Fragment key={`${name.displayName}-${name.firstSeenAt}`}>
          {index > 0 && ' ← '}
          {name.displayName}{' '}
          <span className="text-text-3">({format.monthYear(name.firstSeenAt)})</span>
        </Fragment>
      ))}
    </>
  );
}

/** One card per account. */
function AccountCard({ account, color }: { account: AccountSummary; color: string }) {
  const format = useFormat();
  const now = useNow();
  const known = account.displayName !== null && account.accountType !== null;
  const detail = [
    known && account.accountType !== null ? formatAccountType(account.accountType) : undefined,
    account.totalLevel !== null ? `total level ${formatInt(account.totalLevel)}` : undefined,
  ].filter((part) => part !== undefined);
  return (
    <li className="min-w-0">
      <Card className="flex flex-col">
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <AccountDot color={color} className="size-3 rounded-full" />
            <div className="flex min-w-0 flex-col">
              <h2 className="m-0 truncate font-display text-lg font-semibold">
                {accountName(account)}
              </h2>
              {detail.length > 0 && (
                <span className="text-xs text-text-3">{detail.join(' · ')}</span>
              )}
            </div>
          </div>
          {isOnline(account, now) ? (
            <LiveBadge>Online</LiveBadge>
          ) : (
            <Badge>Last seen {format.relative(account.lastSeenAt)}</Badge>
          )}
        </div>
        <InfoRow label="First seen">{format.date(account.firstSeenAt)}</InfoRow>
        <InfoRow label="Name history">
          <NameHistory accountId={account.id} />
        </InfoRow>
        <CollectionLogSource account={account} />
      </Card>
    </li>
  );
}

function AccountList() {
  const accounts = useAccounts();
  if (accounts.isError) {
    return (
      <ErrorState
        onRetry={() => {
          void accounts.refetch();
        }}
      />
    );
  }
  if (!accounts.data) return <CardSkeleton lines={3} />;
  // Sorted by ID like the account switcher, so the colours match.
  const sorted = [...accounts.data.accounts].sort((a, b) => a.id - b.id);
  const colors = accountColors(sorted);
  if (sorted.length === 0) {
    return (
      <EmptyState action={<Link to="/settings/keys">Create an API key</Link>}>
        Accounts show up here the first time they log in with the plugin.
      </EmptyState>
    );
  }
  return (
    <ul aria-label="OSRS accounts" className="m-0 flex list-none flex-col gap-5 p-0">
      {sorted.map((account) => (
        <AccountCard
          key={account.id}
          account={account}
          color={colors.get(account.id) ?? 'var(--afk)'}
        />
      ))}
    </ul>
  );
}

/** Settings → OSRS accounts. No account switcher here. */
export function AccountsTab() {
  return (
    <SettingsLayout section="accounts">
      <AccountList />
      <p className="m-0 text-table text-text-3">
        Accounts appear here the first time they log in with the plugin. They&apos;re matched by
        RuneLite&apos;s account hash, so name changes keep their history. Each account keeps its
        colour on every page.
      </p>
    </SettingsLayout>
  );
}
