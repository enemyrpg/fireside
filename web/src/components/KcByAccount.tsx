import type { AccountSummary } from '@fireside/shared';
import { AccountDot } from '@/components/shell/AccountDot';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatInt } from '@/format';
import { accountNameById } from '@/lib/accounts';

/** The accounts with their colours, worked out once per page. */
export interface AccountsView {
  list: readonly AccountSummary[];
  colors: ReadonlyMap<number, string>;
}

/**
 * KC with the split per account for `all` (Boss KC, Raids): a dot per
 * account, names and KC in the tooltip.
 */
export function KcByAccount({
  name,
  killCount,
  byAccount,
  accounts,
}: {
  /** Boss or raid mode, the tooltip's title. */
  name: string;
  killCount: number;
  byAccount: readonly { accountId: number; killCount: number }[];
  accounts: AccountsView;
}) {
  const accountName = (accountId: number) => accountNameById(accountId, accounts.list);
  const color = (accountId: number) => accounts.colors.get(accountId) ?? 'var(--afk)';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="img"
          aria-label={`${formatInt(killCount)}: ${byAccount
            .map((entry) => `${accountName(entry.accountId)} ${formatInt(entry.killCount)}`)
            .join(', ')}`}
          className="inline-flex cursor-default items-center gap-1.5 rounded-sm"
        >
          <span className="font-semibold">{formatInt(killCount)}</span>
          <span aria-hidden="true" className="inline-flex gap-0.5">
            {byAccount.map((entry) => (
              <AccountDot key={entry.accountId} color={color(entry.accountId)} />
            ))}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="font-semibold">{name}</div>
        {byAccount.map((entry) => (
          <div key={entry.accountId} className="flex items-center gap-2 tabular-nums">
            <AccountDot color={color(entry.accountId)} />
            <span className="flex-1">{accountName(entry.accountId)}</span>
            <span>{formatInt(entry.killCount)}</span>
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
