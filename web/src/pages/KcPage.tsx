import type { BossKc } from '@fireside/shared';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { useAccounts, useKc } from '@/api/hooks';
import { DataTable, type Column } from '@/components/DataTable';
import { BossIcon } from '@/components/BossIcon';
import { KcByAccount, type AccountsView } from '@/components/KcByAccount';
import { QueryCard } from '@/components/QueryCard';
import { EmptyState } from '@/components/states';
import { formatInt, formatPbTime, type Formatter } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { accountColors } from '@/lib/accounts';
import { useAccountScope } from '@/routing/useAccountScope';
import { hrefOf } from './registry';

// Boss KC card of Loot & KC: KC, KC in the last 30 days, best time and last
// kill per boss, all time, under the loot cards. Raid modes are on the Raids
// tab, so only `category: boss` is listed here. Mobile: a list with the last 30
// days and best time under the name.

export const KC_EMPTY = 'Boss kill counts show up here after your first kill.';

function kcColumns(accounts: AccountsView | undefined, format: Formatter): Column<BossKc>[] {
  return [
    {
      id: 'boss',
      header: 'Boss',
      cell: (boss) => (
        <span className="flex min-w-0 items-center gap-2">
          <BossIcon boss={boss.boss} />
          <span className="truncate">{boss.boss}</span>
        </span>
      ),
    },
    {
      id: 'kc',
      header: 'KC',
      align: 'right',
      cell: (boss) =>
        accounts ? (
          <KcByAccount
            name={boss.boss}
            killCount={boss.killCount}
            byAccount={boss.byAccount}
            accounts={accounts}
          />
        ) : (
          <span className="font-semibold">{formatInt(boss.killCount)}</span>
        ),
    },
    {
      id: 'gained',
      header: 'Last 30 days',
      align: 'right',
      cell: (boss) =>
        boss.gainedLast30Days > 0 ? (
          `+${formatInt(boss.gainedLast30Days)}`
        ) : (
          <span className="text-text-3">–</span>
        ),
    },
    {
      id: 'best',
      header: 'Best time',
      align: 'right',
      cell: (boss) =>
        boss.bestTimeSeconds === null ? (
          <span className="text-text-3">–</span>
        ) : (
          <span className="font-mono">{formatPbTime(boss.bestTimeSeconds)}</span>
        ),
    },
    {
      id: 'last',
      header: 'Last kill',
      align: 'right',
      cell: (boss) => <span className="text-text-2">{format.relative(boss.lastObservedAt)}</span>,
    },
  ];
}

/** "+7 in 30 days · best 0:52.8", the parts that exist. */
function kcDetail(boss: BossKc): string | undefined {
  const parts = [
    boss.gainedLast30Days > 0 ? `+${formatInt(boss.gainedLast30Days)} in 30 days` : undefined,
    boss.bestTimeSeconds === null ? undefined : `best ${formatPbTime(boss.bestTimeSeconds)}`,
  ].filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Mobile (`MobileProgressLoot`): icon, name, the last 30 days and best time, KC on the right. */
function KcList({
  bosses,
  accounts,
}: {
  bosses: readonly BossKc[];
  accounts: AccountsView | undefined;
}) {
  return (
    <ul aria-label="Boss kill count" className="m-0 list-none p-0">
      {bosses.map((boss) => {
        const detail = kcDetail(boss);
        return (
          <li
            key={boss.boss}
            className="grid min-h-12 grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 border-t border-hover py-1.5"
          >
            <BossIcon boss={boss.boss} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{boss.boss}</span>
              {detail !== undefined && (
                <span className="truncate text-xs text-text-3">{detail}</span>
              )}
            </span>
            <span className="tabular-nums">
              {accounts ? (
                <KcByAccount
                  name={boss.boss}
                  killCount={boss.killCount}
                  byAccount={boss.byAccount}
                  accounts={accounts}
                />
              ) : (
                <span className="font-semibold">{formatInt(boss.killCount)}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function KcPage() {
  const scope = useAccountScope();
  const format = useFormat();
  const desktop = useIsDesktop();
  const kc = useKc(scope);
  const list = useAccounts().data?.accounts;
  const accounts = useMemo(
    () => (list ? { list, colors: accountColors(list) } : undefined),
    [list],
  );
  const bosses = kc.data?.bosses.filter((boss) => boss.category === 'boss');

  return (
    <div className="flex flex-col gap-5">
      <QueryCard
        query={kc}
        skeletonLines={8}
        title={
          <span className="flex flex-wrap items-baseline gap-x-2.5">
            Boss kill count
            <span className="text-xs font-normal text-text-3">
              {bosses !== undefined && bosses.length > 0 && (
                <>
                  {formatInt(bosses.length)} {bosses.length === 1 ? 'boss' : 'bosses'} · all time
                  {/* The period above changes loot only; mobile has no room for the rest. */}
                  {desktop && ' · raids have their own tab'}
                </>
              )}
            </span>
          </span>
        }
        action={
          <Link to={hrefOf('raids', scope)} className="text-sm font-medium no-underline">
            Raids →
          </Link>
        }
      >
        {() =>
          bosses === undefined || bosses.length === 0 ? (
            <EmptyState className="min-h-[240px]">{KC_EMPTY}</EmptyState>
          ) : !desktop ? (
            <KcList bosses={bosses} accounts={scope === 'all' ? accounts : undefined} />
          ) : (
            <DataTable
              label="Boss kill count"
              columns={kcColumns(scope === 'all' ? accounts : undefined, format)}
              rows={bosses}
              rowKey={(boss) => boss.boss}
            />
          )
        }
      </QueryCard>
    </div>
  );
}
