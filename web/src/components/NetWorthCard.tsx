import type { AccountScope } from '@fireside/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useBankHistory, useBankSummary, useHasBankData } from '@/api/hooks';
import { Card, CardHeader } from '@/components/Card';
import { LazySparkline, SparklineSkeleton } from '@/components/LazySparkline';
import { ErrorState, TextSkeleton } from '@/components/states';
import { TooltipRow } from '@/components/TooltipRow';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatAxisDate, formatCompact, formatGp, formatGpExact } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { useLocalToday } from '@/hooks/useLocalToday';
import { bankHref, historyPoints } from '@/lib/bank';
import { lastDaysRange } from '@/lib/time';

/** Days in the sparkline. */
export const NET_WORTH_SPARKLINE_DAYS = 30;

/**
 * Net worth on Home: the total (bank + potion storage + inventory + equipment
 * from `bank/summary`), a line of the last 30 days from `bank/history` and the
 * cash. Always GE: at current prices when the server fetches them (`prices`),
 * else at the prices of the snapshot. The line always uses the prices of each
 * day's snapshot. Renders nothing when no account in scope has a bank snapshot
 * (`updatedAt`), and the numbers without the line when the history can't be
 * loaded or has a single day (one day is a dot, not a trend).
 *
 * While the summary loads it takes the card's full height (`NetWorthPlaceholder`),
 * so Top skills under it doesn't move when it arrives (docs/design.md,
 * "Loading"). It skips that only when the menu's answer for all accounts
 * already says no account has bank data.
 */
export function NetWorthCard({ scope, live }: { scope: AccountScope; live: boolean }) {
  const format = useFormat();
  const today = useLocalToday(format.timeZone);
  const summary = useBankSummary(scope, { live });
  const shown = summary.data !== undefined && summary.data.updatedAt !== null;
  const history = useBankHistory(
    scope,
    lastDaysRange(NET_WORTH_SPARKLINE_DAYS, today, format.timeZone),
    { live, enabled: shown },
  );
  const anyBankData = useHasBankData();
  const data = summary.data;
  if (data === undefined) {
    if (anyBankData === false) return null;
    if (summary.isError) {
      // An error card only for a card that exists: some account is known to have bank data.
      return anyBankData === true ? (
        <NetWorthFrame scope={scope}>
          <ErrorState onRetry={() => void summary.refetch()} />
        </NetWorthFrame>
      ) : null;
    }
    return <NetWorthPlaceholder scope={scope} />;
  }
  const updatedAt = data.updatedAt;
  if (updatedAt === null) return null;
  const points = historyPoints(history.data?.days ?? [], 'ge');
  const first = points[0];
  const last = points.at(-1);
  // The line's place is kept until the history is in; it goes only if that fails or has one day.
  const historyLoading = history.data === undefined && !history.isError;

  return (
    <NetWorthFrame scope={scope}>
      <div className="flex flex-col gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="self-start font-display text-[36px] leading-[1.05] font-semibold tracking-[-0.02em] tabular-nums"
            >
              {formatCompact(data.geValue)}{' '}
              <span className="text-[17px] tracking-normal text-text-2">gp</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <TooltipRow strong label="Bank" value={formatGpExact(data.bankGeValue)} />
            <TooltipRow
              strong
              label="Potion storage"
              value={formatGpExact(data.potionStorageGeValue)}
            />
            <TooltipRow strong label="Inventory" value={formatGpExact(data.inventoryGeValue)} />
            <TooltipRow strong label="Equipment" value={formatGpExact(data.equipmentGeValue)} />
            {data.prices.fetchedAt !== null && (
              <div className="text-text-3">
                Current GE prices · fetched {format.relative(data.prices.fetchedAt)}
              </div>
            )}
          </TooltipContent>
        </Tooltip>
        <span className="text-xs text-text-3">
          GE value · updated {format.date(updatedAt)}, {format.clock(updatedAt)}
        </span>
      </div>
      {historyLoading && <SparklineSkeleton {...SPARKLINE_PLACEHOLDER} />}
      {points.length > 1 && first && last && (
        <LazySparkline
          variant="area"
          points={points}
          format={formatGpExact}
          label={`Net worth, last ${String(NET_WORTH_SPARKLINE_DAYS)} days: ${formatGp(first.value)} to ${formatGp(last.value)}`}
          startLabel={formatAxisDate(first.date)}
          endLabel={last.date === today ? 'Today' : formatAxisDate(last.date)}
        />
      )}
      <div className="flex justify-between border-t border-border pt-3">
        <span className="text-text-2">Cash</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="font-semibold tabular-nums">
              {formatGp(data.cashValue)}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <div className="font-semibold tabular-nums">{formatGpExact(data.cashValue)}</div>
            <div className="text-text-3">Coins and platinum tokens</div>
          </TooltipContent>
        </Tooltip>
      </div>
    </NetWorthFrame>
  );
}

/** The line's place while the history loads: its size with the labels row under it. */
const SPARKLINE_PLACEHOLDER = {
  variant: 'area',
  points: [],
  format: String,
  label: '',
  startLabel: '\u00a0',
  endLabel: '\u00a0',
} as const;

function NetWorthFrame({ scope, children }: { scope: AccountScope; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-4">
      <CardHeader
        title="Net worth"
        className="mb-0"
        action={<Link to={bankHref(scope)}>Bank →</Link>}
      />
      {children}
    </Card>
  );
}

/**
 * The card while its summary loads: the same lines in the same text sizes
 * (number, "GE value · updated", the line, Cash), with skeletons after 200 ms.
 */
function NetWorthPlaceholder({ scope }: { scope: AccountScope }) {
  return (
    <NetWorthFrame scope={scope}>
      <div
        aria-busy="true"
        aria-label="Loading"
        data-testid="net-worth-placeholder"
        className="contents"
      >
        <div className="flex flex-col gap-0.5">
          <TextSkeleton className="block w-40 self-start font-display text-[36px] leading-[1.05] font-semibold" />
          <TextSkeleton className="block w-56 text-xs" />
        </div>
        <SparklineSkeleton {...SPARKLINE_PLACEHOLDER} />
        <div className="flex justify-between border-t border-border pt-3">
          <span className="text-text-2">Cash</span>
          <TextSkeleton className="inline-block w-16 font-semibold" />
        </div>
      </div>
    </NetWorthFrame>
  );
}
