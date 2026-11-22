import type { AccountScope } from '@fireside/shared';
import { Link } from 'react-router';
import { useBankHistory, useBankSummary } from '@/api/hooks';
import { Card, CardHeader } from '@/components/Card';
import { Sparkline } from '@/components/Sparkline';
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
 * day's snapshot. Renders nothing until an account in scope has a bank snapshot
 * (`updatedAt`), and the numbers without the line when the history can't be
 * loaded or has a single day (one day is a dot, not a trend).
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
  const data = summary.data;
  const updatedAt = data?.updatedAt ?? null;
  if (data === undefined || updatedAt === null) return null;
  const points = historyPoints(history.data?.days ?? [], 'ge');
  const first = points[0];
  const last = points.at(-1);

  return (
    <Card className="flex flex-col gap-4">
      <CardHeader
        title="Net worth"
        className="mb-0"
        action={<Link to={bankHref(scope)}>Bank →</Link>}
      />
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
      {points.length > 1 && first && last && (
        <Sparkline
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
    </Card>
  );
}
