import type { AccountScope, AccountSummary } from '@fireside/shared';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { LiveBadge } from '@/components/Badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAccounts } from '@/api/hooks';
import { formatAccountType, formatInt } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useNow } from '@/hooks/useNow';
import {
  accountColor,
  accountName,
  anyOnline,
  isOnline,
  parseScope,
  switchAccountPath,
} from '@/lib/accounts';
import { cn } from '@/lib/utils';
import { pageHref, PAGES } from '@/pages/registry';
import { useCurrentPage } from '@/routing/current-page';
import { AccountDot } from './AccountDot';

/** Type and total level, e.g. "Ironman · total 1,850". Unknown accounts show no type. */
function accountDetails(account: AccountSummary): string {
  const parts: string[] = [];
  if (account.displayName !== null && account.accountType !== null) {
    parts.push(formatAccountType(account.accountType));
  }
  if (account.totalLevel !== null) parts.push(`total ${formatInt(account.totalLevel)}`);
  return parts.join(' · ');
}

/**
 * Account switcher in the top bar. Changing account keeps the current page and
 * its query string. `compact`: the PC top bar at 1100 px and narrower, which
 * shows only the name (capped, with an ellipsis), not the account type.
 */
export function AccountSwitcher({
  scope,
  compact = false,
}: {
  scope: AccountScope;
  compact?: boolean;
}) {
  // Polls while an account shows as online, so a logout shows within one poll.
  const accounts = useAccounts({ live: anyOnline }).data?.accounts ?? [];
  const sorted = [...accounts].sort((a, b) => a.id - b.id);
  const format = useFormat();
  const navigate = useNavigate();
  const location = useLocation();
  const now = useNow();
  const current = scope === 'all' ? undefined : sorted.find((account) => account.id === scope);
  // A detail page without an account in the URL (a session) switches to its parent's list.
  const parentId = useCurrentPage()?.parent;
  const parent = PAGES.find((page) => page.id === parentId && page.scoped);

  const choose = (next: AccountScope) => {
    // On an account page, keep the page; elsewhere go to the account's overview.
    const onAccountPage = parseScope(location.pathname.split('/')[1]) !== null;
    let path = `/${String(next)}`;
    if (onAccountPage) path = switchAccountPath(location.pathname, location.search, next);
    else if (parent) path = pageHref(parent, next);
    void navigate(path);
  };

  // The name starts with what the button is for and holds the text on it, so
  // "click Seed Main" works with speech input (WCAG 2.5.3, Label in Name).
  const shownName = current ? accountName(current) : 'All accounts';
  const shownType =
    current?.displayName != null && current.accountType !== null
      ? ` ${formatAccountType(current.accountType)}`
      : '';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Choose account: ${shownName}${shownType}`}
          // Moves between the top bar and the page header (useCarryShellFocus).
          data-shell-control=""
          className={cn(
            'flex h-11 min-w-0 items-center gap-2 rounded-full border border-border bg-card px-3.5 font-medium hover:border-accent desk:h-9 desk:rounded-lg desk:px-3',
            !compact && 'desk:min-w-[190px]',
          )}
        >
          {current ? <AccountDot color={accountColor(current.id, sorted)} /> : <AccountDot />}
          <span
            className={cn(
              'max-w-[110px] truncate',
              compact ? 'desk:max-w-[136px]' : 'desk:max-w-none',
            )}
          >
            {current ? accountName(current) : 'All accounts'}
          </span>
          {/* A real space, so the text on the button reads "Seed Main Normal", as in its name. */}{' '}
          {!compact && current?.displayName != null && current.accountType !== null && (
            <span className="hidden text-xs font-normal text-text-3 desk:inline">
              {formatAccountType(current.accountType)}
            </span>
          )}
          <ChevronDownIcon aria-hidden="true" className="ml-auto size-4 text-text-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[260px] max-desk:w-[calc(100vw-16px)]">
        <DropdownMenuItem
          onSelect={() => {
            choose('all');
          }}
          className={cn('gap-2.5 py-2', scope === 'all' && 'bg-accent-wash')}
        >
          <AccountDot />
          <span>All accounts</span>
          {scope === 'all' && <CheckIcon aria-hidden="true" className="ml-auto text-accent-text" />}
        </DropdownMenuItem>
        {sorted.map((account) => (
          <DropdownMenuItem
            key={account.id}
            onSelect={() => {
              choose(account.id);
            }}
            className={cn('gap-2.5 py-2', scope === account.id && 'bg-accent-wash')}
          >
            <AccountDot color={accountColor(account.id, sorted)} />
            <span className="min-w-0">
              <span className="block truncate">{accountName(account)}</span>
              <span className="block text-xs text-text-3">{accountDetails(account)}</span>
            </span>
            <span className="ml-auto pl-2 text-xs text-text-3">
              {isOnline(account, now) ? (
                <LiveBadge>Online</LiveBadge>
              ) : (
                format.relative(account.lastSeenAt)
              )}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
