import type { SessionClogItem, SessionDetailResponse } from '@fireside/shared';
import { Link } from 'react-router';
import { ItemIcon } from '@/components/ItemIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatInt } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { clogHref, clogSlug } from '@/lib/clog';
import { ROWS_SHOWN } from '@/lib/show-all';
import { cn } from '@/lib/utils';
import { Section, type DetailVariant } from './sections';

// The Collection log section of Session detail: the new collection log
// items tied to the session. Up to six as rows (the six-row rule), more as a
// grid of tiles. Each opens its page on the Collection log. Only shown when the
// session has some.

/** A softer `--info` border (`#3B4A58` in Ember), as a mix of `--info` (no token of its own). */
const INFO_BORDER = 'border-info/35';

/** The item's page on the Collection log of its account. */
function pageHref(accountId: number, item: SessionClogItem): string {
  return clogHref(accountId, { tab: clogSlug(item.tab), page: clogSlug(item.page) });
}

/** "22:39", or "~22:41" for the time of the sync after the session. */
function ItemTime({ item }: { item: SessionClogItem }) {
  const format = useFormat();
  const time = format.clock(item.at);
  if (!item.approximate) {
    return <span className="font-mono text-xs text-text-3 tabular-nums">{time}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="font-mono text-xs text-text-3 tabular-nums">
          ~{time}
          <span className="sr-only">, found by the sync after the session</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>Found by the sync after the session</TooltipContent>
    </Tooltip>
  );
}

function ItemRows({
  accountId,
  items,
  variant,
}: {
  accountId: number;
  items: readonly SessionClogItem[];
  variant: DetailVariant;
}) {
  const pane = variant === 'pane';
  return (
    <ul aria-label="New collection log items" className="m-0 flex list-none flex-col gap-2 p-0">
      {items.map((item) => (
        <li
          key={item.itemId}
          className={cn(
            'grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3',
            // In the pane each item is a tinted box; on mobile the whole card is.
            pane && `rounded-[10px] border ${INFO_BORDER} bg-info-wash px-3 py-2.5`,
          )}
        >
          <ItemIcon itemId={item.itemId} name={item.name} size="slot" />
          <span className="flex min-w-0 flex-col">
            <Link
              to={pageHref(accountId, item)}
              className="truncate font-medium text-text no-underline hover:underline"
            >
              {item.name}
            </Link>
            <span className="truncate text-xs text-text-3">
              {item.page}
              {pane && (
                <>
                  {' '}
                  · {formatInt(item.pageObtained)} of {formatInt(item.pageTotal)} on this page
                </>
              )}
            </span>
          </span>
          <ItemTime item={item} />
        </li>
      ))}
    </ul>
  );
}

/** More than six: tiles, with the name, page and time in a tooltip (`SessionLong`). */
function ItemTiles({
  accountId,
  items,
  variant,
}: {
  accountId: number;
  items: readonly SessionClogItem[];
  variant: DetailVariant;
}) {
  const format = useFormat();
  return (
    <>
      <ul
        aria-label="New collection log items"
        className="m-0 grid list-none grid-cols-6 gap-[5px] p-0 desk:grid-cols-8"
      >
        {items.map((item) => {
          const time = `${item.approximate ? '~' : ''}${format.clock(item.at)}`;
          return (
            <li key={item.itemId} className="min-w-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    to={pageHref(accountId, item)}
                    aria-label={`${item.name}, ${item.page}, ${time}`}
                    className={`flex aspect-[11/10] items-center justify-center rounded-[7px] border ${INFO_BORDER} bg-info-wash p-0.5`}
                  >
                    <ItemIcon itemId={item.itemId} name={item.name} size="slot" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="font-semibold">{item.name}</div>
                  <div className="text-text-2">{item.page}</div>
                  <div className="tabular-nums">{time}</div>
                </TooltipContent>
              </Tooltip>
            </li>
          );
        })}
      </ul>
      <p className="m-0 mt-2.5 text-xs text-text-3">
        {variant === 'pane'
          ? 'Hover an item for its name, page and time. Click to open its page.'
          : 'Tap an item to open its page.'}
      </p>
    </>
  );
}

export function ClogSection({
  detail,
  variant,
}: {
  detail: SessionDetailResponse;
  variant: DetailVariant;
}) {
  const { items, obtained, total } = detail.collectionLog;
  if (items.length === 0) return null;
  const { accountId } = detail.session;
  const pane = variant === 'pane';
  return (
    <Section
      variant={variant}
      label="Collection log"
      title={
        <>
          Collection log{' '}
          <span
            className={cn(
              'text-xs font-normal',
              // Grey in the pane, `--info-text` on the tinted mobile card.
              pane ? 'text-text-3' : 'text-info-text',
            )}
          >
            {formatInt(items.length)} new
          </span>
        </>
      }
      action={
        obtained !== null && total !== null ? (
          <Link
            to={clogHref(accountId)}
            className={cn('no-underline', pane ? 'text-xs' : 'text-[13px] font-medium')}
          >
            {formatInt(obtained)} of {formatInt(total)} →
          </Link>
        ) : undefined
      }
      className={pane ? undefined : `${INFO_BORDER} bg-info-wash`}
    >
      {items.length > ROWS_SHOWN ? (
        <ItemTiles accountId={accountId} items={items} variant={variant} />
      ) : (
        <ItemRows accountId={accountId} items={items} variant={variant} />
      )}
    </Section>
  );
}
