import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { AccountDot } from '@/components/shell/AccountDot';
import { cn } from '@/lib/utils';

export interface AccountCardStat {
  key: string;
  value: ReactNode;
  /** Text under the number: "slots", "net worth". */
  label: ReactNode;
}

export interface AccountCard {
  accountId: number;
  name: string;
  /** From `accountColor`. */
  color: string;
  /** Account type as text ("Ironman"); left out when unknown or a normal account. */
  type?: string | undefined;
  /** Where the card goes: the same page for this account. */
  to: string;
  /** The account's key numbers, side by side (wrapping in a narrow card). */
  stats: readonly AccountCardStat[];
  /** Under the numbers, e.g. a progress bar. */
  footer?: ReactNode;
}

/**
 * One link card per account, for `all` on pages that belong to one account
 * (Bank, Quests & diaries, Collection log). A click picks the account and stays
 * on the page. Accounts without data are left out by the caller. `note` is the
 * sentence under the cards ("A bank belongs to one account…").
 */
export function AccountCards({
  cards,
  label,
  note,
  size = 'md',
}: {
  cards: readonly AccountCard[];
  label: string;
  note?: ReactNode;
  /** Numbers at 22 px (`md`) or 24 px (`lg`, Bank). */
  size?: 'md' | 'lg';
}) {
  return (
    <div className="flex flex-col gap-3.5 desk:gap-5">
      <ul
        aria-label={label}
        className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(380px,100%),1fr))] gap-3 p-0 desk:gap-5"
      >
        {cards.map((card) => (
          <li key={card.accountId} className="min-w-0">
            <Link
              to={card.to}
              className="flex h-full items-center justify-between gap-4 rounded-2xl border border-border bg-card p-[18px] text-text no-underline hover:border-accent hover:text-text hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent desk:rounded-[14px] desk:px-6 desk:py-[22px]"
            >
              <span className="flex min-w-0 flex-auto flex-col gap-3">
                <span className="flex min-w-0 items-center gap-2.5">
                  <AccountDot color={card.color} className="size-2.5" />
                  <span className="truncate font-display text-lg font-semibold">{card.name}</span>
                  {card.type !== undefined && (
                    <span className="text-xs whitespace-nowrap text-text-3">{card.type}</span>
                  )}
                </span>
                <span className="flex flex-wrap gap-x-8 gap-y-3">
                  {card.stats.map((stat) => (
                    <span key={stat.key} className="flex min-w-0 flex-col">
                      <span
                        className={cn(
                          'font-display font-semibold whitespace-nowrap tabular-nums',
                          size === 'lg' ? 'text-2xl' : 'text-tile',
                        )}
                      >
                        {stat.value}
                      </span>
                      <span className="text-xs text-text-3">{stat.label}</span>
                    </span>
                  ))}
                </span>
                {card.footer}
              </span>
              <span aria-hidden="true" className="flex-none text-xl text-accent-text">
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {note !== undefined && <p className="m-0 text-table text-text-3">{note}</p>}
    </div>
  );
}
