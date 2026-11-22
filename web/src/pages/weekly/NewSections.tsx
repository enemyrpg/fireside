import type {
  AccountScope,
  Pet,
  WeeklyBank,
  WeeklyCollectionLog,
  WeeklyPets,
  WeeklyQuests,
} from '@fireside/shared';
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useAccounts } from '@/api/hooks';
import { Badge } from '@/components/Badge';
import { Card, CardHeader } from '@/components/Card';
import { ItemIcon } from '@/components/ItemIcon';
import { ItemRow } from '@/components/ItemRow';
import { AccountDot } from '@/components/shell/AccountDot';
import { Sparkline } from '@/components/Sparkline';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatAxisWeekday, formatGp, formatGpExact, formatIsoWeek, titleCase } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { accountColors, accountNameById } from '@/lib/accounts';
import { bankHref } from '@/lib/bank';
import { clogHref } from '@/lib/clog';
import { petDetail, petsHref } from '@/lib/pets';
import { questsHref } from '@/lib/quests';
import { bankChangeText, clogSummary, questsSummary } from '@/lib/weekly';

// The later Weekly sections: new pets, the bank through the week, new
// collection log items and finished quests and diary tiers. Each is only
// rendered when the weekly response has it (`null` sections are hidden by the
// page).

/** Shown where a time is the sync that found something, not when it happened. */
const APPROXIMATE_TIP = '~ is the sync that found it, not the drop';

interface AccountLabel {
  name: string;
  color: string;
}

/** For `all`: the name and colour of an account, to say whose row it is. */
function useAccountLabel(scope: AccountScope): (accountId: number) => AccountLabel | undefined {
  const accounts = useAccounts().data?.accounts;
  const colors = useMemo(() => accountColors(accounts ?? []), [accounts]);
  return (accountId) =>
    scope === 'all' && accounts
      ? { name: accountNameById(accountId, accounts), color: colors.get(accountId) ?? 'var(--afk)' }
      : undefined;
}

function AccountChip({ account }: { account: AccountLabel | undefined }) {
  if (!account) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-text-3">
      <AccountDot color={account.color} />
      <span className="truncate">{account.name}</span>
    </span>
  );
}

function Summary({ children }: { children: ReactNode }) {
  return <span className="text-xs text-text-2 tabular-nums">{children}</span>;
}

/** Its child with a tooltip, focusable so keyboard users get it too. */
function WithTooltip({ tooltip, children }: { tooltip: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex cursor-default rounded-sm">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

const ROW = 'flex min-w-0 items-center gap-2.5 border-b border-border py-2 last:border-b-0';
const ROW_DATE = 'text-xs whitespace-nowrap text-text-3 tabular-nums';

// --- Pets ---------------------------------------------------------------------------

function PetLine({
  pet,
  scope,
  account,
}: {
  pet: Pet;
  scope: AccountScope;
  account: AccountLabel | undefined;
}) {
  const format = useFormat();
  const detail = petDetail(pet);
  const date = pet.obtainedAt === null ? null : format.date(pet.obtainedAt);
  return (
    <Card
      aria-label={`New pet: ${pet.name}`}
      className="flex items-center gap-3.5 border-accent py-3.5"
    >
      <ItemIcon itemId={pet.itemId} name={pet.name} size="slot" className="flex-none" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-semibold">New pet: {pet.name}</span>
          {!pet.confirmed && (
            <WithTooltip tooltip="Seen in chat. Confirmed when your collection log has it.">
              <Badge>Unconfirmed</Badge>
            </WithTooltip>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-text-2 tabular-nums">
          {detail !== null && (
            <>
              <span className="truncate">{detail}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          {date !== null &&
            (pet.approximate ? (
              <WithTooltip tooltip={APPROXIMATE_TIP}>~{date}</WithTooltip>
            ) : (
              <span>{date}</span>
            ))}
          {account && (
            <>
              <span aria-hidden="true">·</span>
              <AccountChip account={account} />
            </>
          )}
        </div>
      </div>
      <Link to={petsHref(scope)} className="flex-none whitespace-nowrap">
        Pets →
      </Link>
    </Card>
  );
}

/** One accent-bordered line per new pet, above everything else. */
export function PetLines({ pets, scope }: { pets: WeeklyPets; scope: AccountScope }) {
  const accountLabel = useAccountLabel(scope);
  return (
    <>
      {pets.pets.map((pet) => (
        <PetLine
          key={`${String(pet.accountId)}:${String(pet.itemId)}`}
          pet={pet}
          scope={scope}
          account={accountLabel(pet.accountId)}
        />
      ))}
    </>
  );
}

// --- Bank ----------------------------------------------------------------------------

/**
 * Net worth through the week: the change in the header, the value at the end
 * (now, for the week in progress) and at the start, and a sparkline per day.
 * At the prices of each snapshot, as "Value over time" on the Bank page.
 */
export function BankCard({
  bank,
  week,
  complete,
  scope,
}: {
  bank: WeeklyBank;
  week: string;
  complete: boolean;
  scope: AccountScope;
}) {
  const change = bankChangeText(bank);
  const points = bank.days.map((day) => ({ date: day.date, value: day.geValue }));
  const first = points[0];
  const end = formatGp(bank.endGeValue);
  return (
    <Card className="flex flex-col gap-3.5">
      <CardHeader
        title="Bank"
        className="mb-0"
        action={
          <>
            {change !== null && <Summary>{change}</Summary>}
            <Link to={bankHref(scope)}>Bank →</Link>
          </>
        }
      />
      {/* The big number with a smaller "gp", the label under it. */}
      <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
        <WithTooltip tooltip={formatGpExact(bank.endGeValue)}>
          <span className="flex flex-col">
            <span className="font-display text-[26px] leading-tight font-semibold tabular-nums desk:text-[30px]">
              {end.replace(/ gp$/, '')}{' '}
              <span className="text-[15px] font-semibold text-text-2">gp</span>
            </span>
            <span className="text-xs text-text-3">
              {complete ? 'net worth at the end of the week' : 'net worth now'}
            </span>
          </span>
        </WithTooltip>
        {bank.startGeValue !== null && (
          <span className="flex flex-col pb-px">
            <span className="text-sm font-semibold text-text-2 tabular-nums">
              <WithTooltip tooltip={formatGpExact(bank.startGeValue)}>
                {formatGp(bank.startGeValue)}
              </WithTooltip>
            </span>
            <span className="text-xs text-text-3">at the start of the week</span>
          </span>
        )}
      </div>
      {/* One day is a dot, not a trend. */}
      {points.length > 1 && first && (
        <Sparkline
          variant="area"
          points={points}
          label={`Net worth per day, ${formatIsoWeek(week, { withYear: true })}: ${formatGp(first.value)} to ${end}`}
          format={formatGpExact}
          startLabel={formatAxisWeekday(first.date)}
          endLabel={complete ? formatAxisWeekday(points.at(-1)?.date ?? first.date) : 'Today'}
        />
      )}
    </Card>
  );
}

// --- Collection log -------------------------------------------------------------------

export function CollectionLogCard({
  clog,
  scope,
}: {
  clog: WeeklyCollectionLog;
  scope: AccountScope;
}) {
  const format = useFormat();
  const accountLabel = useAccountLabel(scope);
  const anyApproximate = clog.recentItems.some((item) => item.approximate);
  const more = clog.newItems - clog.recentItems.length;
  return (
    <Card>
      <CardHeader
        title="Collection log"
        action={
          <>
            <Summary>{clogSummary(clog)}</Summary>
            <Link to={clogHref(scope)}>Collection log →</Link>
          </>
        }
      />
      <ul aria-label="New collection log items" className="m-0 list-none p-0">
        {clog.recentItems.map((item) => {
          const account = accountLabel(item.accountId);
          return (
            <ItemRow
              key={`${String(item.accountId)}:${String(item.itemId)}`}
              itemId={item.itemId}
              itemName={item.name}
              name={item.name}
              detail={
                <>
                  <span className="truncate">
                    {item.page} · {item.approximate ? '~' : ''}
                    {format.date(item.firstSeenAt)}
                  </span>
                  {account && (
                    <>
                      <span aria-hidden="true">·</span>
                      <AccountDot color={account.color} />
                      <span className="truncate">{account.name}</span>
                    </>
                  )}
                </>
              }
            />
          );
        })}
      </ul>
      {(more > 0 || anyApproximate) && (
        <p className="mt-2.5 mb-0 text-xs text-text-3">
          {[more > 0 && `And ${String(more)} more.`, anyApproximate && `${APPROXIMATE_TIP}.`]
            .filter((part) => part !== false)
            .join(' ')}
        </p>
      )}
    </Card>
  );
}

// --- Quests & diaries -------------------------------------------------------------------

export function QuestsCard({ quests, scope }: { quests: WeeklyQuests; scope: AccountScope }) {
  const format = useFormat();
  const accountLabel = useAccountLabel(scope);
  // One list, newest first: the two lists are each newest first already.
  const rows = [
    ...quests.quests.map((quest) => ({
      key: `q:${String(quest.accountId)}:${quest.quest}`,
      accountId: quest.accountId,
      name: quest.name,
      badge: quest.kind === 'MINIQUEST' ? 'Miniquest' : undefined,
      at: quest.finishedAt,
    })),
    ...quests.diaries.map((tier) => ({
      key: `d:${String(tier.accountId)}:${tier.region}:${tier.tier}`,
      accountId: tier.accountId,
      name: `${tier.name} diary`,
      badge: titleCase(tier.tier),
      at: tier.completedAt,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return (
    <Card>
      <CardHeader
        title="Quests & diaries"
        action={
          <>
            <Summary>{questsSummary(quests)}</Summary>
            <Link to={questsHref(scope)}>Quests →</Link>
          </>
        }
      />
      {rows.length > 0 && (
        <ul aria-label="Completed quests and diary tiers" className="m-0 list-none p-0">
          {rows.map((row) => (
            <li key={row.key} className={ROW}>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate">{row.name}</span>
                {row.badge !== undefined && <Badge>{row.badge}</Badge>}
                <AccountChip account={accountLabel(row.accountId)} />
              </span>
              <span className={ROW_DATE}>{format.date(row.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
