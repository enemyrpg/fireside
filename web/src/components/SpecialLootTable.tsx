import type { RaidDrop } from '@fireside/shared';
import { Pencil, StickyNote, Trash2, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/Badge';
import { DataTable, type Column } from '@/components/DataTable';
import type { EditDropTarget } from '@/components/EditDropDialog';
import { ItemIcon } from '@/components/ItemIcon';
import { AccountDot } from '@/components/shell/AccountDot';
import { TooltipRow } from '@/components/TooltipRow';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatCompact, formatGp, formatGpExact, formatInt, type Formatter } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import {
  dropRowId,
  gotByLabel,
  isPriceFromLaterDate,
  modeLabel,
  PRICE_FROM_LATER_DATE,
  priceSourceLabel,
  shareExplanation,
} from '@/lib/raid-splits';
import { teamSizeLabel } from '@/lib/raids';
import { cn } from '@/lib/utils';

export type AccountLabel = (accountId: number) => { name: string; color: string } | undefined;

export const POSSIBLE_DUPLICATE = 'Possible duplicate';
export const POSSIBLE_DUPLICATE_DETAIL = 'Possible duplicate of a detected drop. Show it.';
export const TAP_TO_EDIT = 'Tap a drop to edit value, mode, party size or note.';

export interface SpecialLootActions {
  onEdit: (target: EditDropTarget) => void;
  /** Only called for a drop added by hand. */
  onDelete: (drop: RaidDrop) => void;
  /** Jump to the detected drop a manual drop may duplicate. */
  onShowDrop: (dropId: string) => void;
}

/** Text with a tooltip, focusable so keyboard users get it too. */
function WithTooltip({
  tooltip,
  className,
  children,
}: {
  tooltip: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn('cursor-default rounded-sm', className)}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function SmallButton({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={(event) => {
        // In a mobile row, which opens the sheet itself.
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </Button>
  );
}

/** "Possible duplicate" under a drop added by hand: a button that jumps to the detected drop. */
function DuplicateWarning({
  drop,
  onShowDrop,
}: {
  drop: RaidDrop;
  onShowDrop: SpecialLootActions['onShowDrop'];
}) {
  if (drop.duplicateOfDropId === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1 rounded-sm text-xs text-down underline-offset-2 hover:underline"
          onClick={(event) => {
            event.stopPropagation();
            if (drop.duplicateOfDropId !== null) onShowDrop(drop.duplicateOfDropId);
          }}
        >
          <TriangleAlert aria-hidden="true" className="size-3 flex-none" />
          {POSSIBLE_DUPLICATE}
        </button>
      </TooltipTrigger>
      <TooltipContent>{POSSIBLE_DUPLICATE_DETAIL}</TooltipContent>
    </Tooltip>
  );
}

/** The note as a small icon with the text in a tooltip. */
function NoteIcon({ note }: { note: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="img"
          aria-label="Note"
          className="flex-none cursor-default rounded-sm text-text-3"
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <StickyNote aria-hidden="true" className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-wrap">{note}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The value the share is worked out from: what the owner says it sold for, or
 * the GE price. The tooltip has both, and for a drop added by hand where and
 * when its GE price is from.
 */
function DropValue({ drop, format }: { drop: RaidDrop; format: Formatter }) {
  if (drop.value === null) return <span className="text-text-3">Value unknown</span>;
  const sold = drop.ownValue !== null;
  return (
    <WithTooltip
      className="whitespace-nowrap"
      tooltip={
        <>
          {drop.ownValue !== null && (
            <TooltipRow label="Sold for" value={formatGpExact(drop.ownValue)} strong />
          )}
          {drop.geValue !== null && drop.gePriceSource !== null ? (
            <TooltipRow
              label={priceSourceLabel(drop.gePriceSource)}
              value={formatGpExact(drop.geValue)}
              strong={!sold}
            />
          ) : (
            <div className="text-text-2">No GE price was known when it was added</div>
          )}
          {isPriceFromLaterDate(drop) && <div className="text-text-2">{PRICE_FROM_LATER_DATE}</div>}
          {drop.manual && drop.gePriceAt !== null && (
            <div className="text-text-2">
              Price seen {format.date(drop.gePriceAt)}, kept since the drop was added
            </div>
          )}
        </>
      }
    >
      <span className={sold ? undefined : 'text-text-2'}>{formatGp(drop.value)}</span>
      {sold && <span className="ml-1 text-xs text-text-3">sold</span>}
    </WithTooltip>
  );
}

/** Your share, or what is missing to work it out. */
function DropShare({ drop, onEdit }: { drop: RaidDrop; onEdit: SpecialLootActions['onEdit'] }) {
  if (drop.share !== null) {
    const explanation = shareExplanation(drop);
    const share = <span className="font-semibold">{formatGp(drop.share)}</span>;
    return (
      <WithTooltip
        className="whitespace-nowrap"
        tooltip={
          <>
            <div className="font-semibold">{formatGpExact(drop.share)}</div>
            {explanation !== null && <div className="text-text-2">{explanation}</div>}
          </>
        }
      >
        {share}
      </WithTooltip>
    );
  }
  if (drop.partySizeUnknown) {
    return (
      <SmallButton
        onClick={() => {
          onEdit({ drop, focus: 'partySize' });
        }}
      >
        Set party size
      </SmallButton>
    );
  }
  // No value: the button is in the Value column, which mobile doesn't have.
  return (
    <>
      <span className="text-text-3 max-desk:hidden" aria-label="No share yet">
        –
      </span>
      <span className="desk:hidden">
        <SmallButton
          onClick={() => {
            onEdit({ drop, focus: 'soldFor' });
          }}
        >
          Set value
        </SmallButton>
      </span>
    </>
  );
}

function columns(
  format: Formatter,
  accountLabel: AccountLabel,
  { onEdit, onDelete, onShowDrop }: SpecialLootActions,
): Column<RaidDrop>[] {
  const party = (drop: RaidDrop) =>
    drop.partySize === null ? undefined : teamSizeLabel(drop.partySize);
  return [
    {
      id: 'date',
      header: 'Date',
      minor: true,
      cell: (drop) => (
        <span className="whitespace-nowrap text-text-2">{format.date(drop.occurredAt)}</span>
      ),
    },
    {
      id: 'item',
      header: 'Item',
      // On mobile the item takes the space left and truncates, so the table fits 390 px.
      className: 'max-desk:w-full max-desk:max-w-0',
      cell: (drop) => {
        const account = accountLabel(drop.accountId);
        return (
          <span className="flex min-w-0 items-center gap-2 py-1">
            <ItemIcon itemId={drop.itemId} name={drop.name} />
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">
                  {drop.name}
                  {drop.quantity > 1 && ` × ${formatInt(drop.quantity)}`}
                </span>
                {drop.manual && <Badge>Manual</Badge>}
                {drop.note !== null && <NoteIcon note={drop.note} />}
              </span>
              {/* Who got it, the raid and the party have their own columns on desktop. */}
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-text-3">
                {/* The raid comes last: it is the part that can be cut short. */}
                <span className="truncate desk:hidden">
                  {gotByLabel(drop)}
                  {party(drop) !== undefined && ` · ${party(drop) ?? ''}`} · {drop.raid}
                </span>
                {account && (
                  <>
                    <AccountDot color={account.color} />
                    <span className="truncate max-desk:sr-only">{account.name}</span>
                  </>
                )}
              </span>
              <DuplicateWarning drop={drop} onShowDrop={onShowDrop} />
            </span>
          </span>
        );
      },
    },
    { id: 'raid', header: 'Raid', minor: true, cell: (drop) => drop.raid },
    {
      id: 'recipient',
      header: 'Got by',
      minor: true,
      cell: (drop) => (
        <span
          className={
            drop.recipient === 'SELF' || drop.nickname !== null ? undefined : 'text-text-2'
          }
        >
          {gotByLabel(drop)}
        </span>
      ),
    },
    {
      id: 'party',
      header: 'Party',
      align: 'right',
      minor: true,
      cell: (drop) =>
        party(drop) ?? (
          <span className="text-text-3" aria-label="Unknown party size">
            {/* Needed for a split, so it is a question; under FFA it doesn't matter. */}
            {drop.partySizeUnknown ? '?' : '–'}
          </span>
        ),
    },
    {
      id: 'mode',
      header: 'Mode',
      minor: true,
      cell: (drop) => (
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <Badge>{modeLabel(drop.mode)}</Badge>
          {drop.overridden && <span className="text-xs text-text-3">set</span>}
        </span>
      ),
    },
    {
      id: 'value',
      header: 'Value',
      align: 'right',
      minor: true,
      cell: (drop) => (
        <span className="flex items-center justify-end gap-2">
          <DropValue drop={drop} format={format} />
          {drop.valueUnknown && (
            <SmallButton
              onClick={() => {
                onEdit({ drop, focus: 'soldFor' });
              }}
            >
              Set value
            </SmallButton>
          )}
        </span>
      ),
    },
    {
      id: 'share',
      header: 'Your share',
      align: 'right',
      cell: (drop) => (
        <>
          <DropShare drop={drop} onEdit={onEdit} />
          {/* The date has its own column on desktop. On mobile the value is in the share's tooltip. */}
          <span className="block text-xs whitespace-nowrap text-text-3 desk:hidden">
            {format.date(drop.occurredAt)}
          </span>
        </>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      className: 'pl-0 max-desk:pr-0',
      cell: (drop) => (
        <span className="flex items-center justify-end gap-0.5 max-desk:flex-col">
          {/* The bin comes first, so the pencils line up in every row. */}
          {drop.manual && (
            <Button
              variant="link"
              size="icon-sm"
              className="text-text-3 hover:text-down"
              aria-label={`Delete ${drop.name}`}
              onClick={() => {
                onDelete(drop);
              }}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          )}
          <Button
            variant="link"
            size="icon-sm"
            className="text-text-3 hover:text-text"
            aria-label={`Edit ${drop.name}`}
            onClick={() => {
              onEdit({ drop });
            }}
          >
            <Pencil aria-hidden="true" />
          </Button>
        </span>
      ),
    },
  ];
}

/**
 * Purples, yours and teammates', newest first, with the owner's choices and
 * their share: who got it ("You", a nickname or "Teammate", never a name from
 * the game), party size, Split or FFA, the value and your share. `accountLabel`
 * names the account (only for `all`).
 */
export function SpecialLootTable({
  drops,
  accountLabel,
  highlightedDropId,
  ...actions
}: {
  drops: readonly RaidDrop[];
  accountLabel: AccountLabel;
  /** The row "Possible duplicate" just jumped to. */
  highlightedDropId?: string | undefined;
} & SpecialLootActions) {
  const format = useFormat();
  return (
    <DataTable
      label="Special loot"
      columns={columns(format, accountLabel, actions)}
      rows={drops}
      rowKey={(drop) => drop.dropId}
      rowId={(drop) => dropRowId(drop.dropId)}
      rowClassName={(drop) =>
        drop.dropId === highlightedDropId ? 'bg-accent-wash hover:bg-accent-wash' : undefined
      }
    />
  );
}

/** "of 24M sold" or "of 11.08M": the value the share is worked out from. */
function ofValue(drop: RaidDrop): string | undefined {
  if (drop.value === null) return undefined;
  return `of ${formatCompact(drop.value)}${drop.ownValue === null ? '' : ' sold'}`;
}

/**
 * Mobile: one row per purple, and the whole row opens
 * the edit sheet. The item's name is a button too, for keyboard and screen
 * readers. Under the name who got it, the party and the date; on the right
 * your share and the value it is from. A drop added by hand is deleted from
 * the sheet. "Set party size", "Set value" and "Possible duplicate" are their
 * own buttons.
 */
export function SpecialLootList({
  drops,
  accountLabel,
  highlightedDropId,
  onEdit,
  onShowDrop,
}: {
  drops: readonly RaidDrop[];
  accountLabel: AccountLabel;
  highlightedDropId?: string | undefined;
} & Pick<SpecialLootActions, 'onEdit' | 'onShowDrop'>) {
  const format = useFormat();
  return (
    <ul aria-label="Special loot" className="m-0 list-none p-0">
      {drops.map((drop) => {
        const account = accountLabel(drop.accountId);
        const party = drop.partySize === null ? undefined : teamSizeLabel(drop.partySize);
        const of = ofValue(drop);
        return (
          <li
            key={drop.dropId}
            id={dropRowId(drop.dropId)}
            // A jump to a possible duplicate, or a deletion, can focus the row.
            tabIndex={-1}
            onClick={() => {
              onEdit({ drop });
            }}
            className={cn(
              '-mx-2 grid min-h-12 cursor-pointer grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-t border-hover px-2 py-2 focus-visible:outline-2 focus-visible:outline-accent',
              drop.dropId === highlightedDropId && 'bg-accent-wash',
            )}
          >
            <ItemIcon itemId={drop.itemId} name={drop.name} size="row" />
            <span className="flex min-w-0 flex-col items-start">
              <span className="flex max-w-full min-w-0 flex-wrap items-center gap-x-1.5">
                <button
                  type="button"
                  aria-label={`Edit ${drop.name}`}
                  className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-medium text-inherit"
                  onClick={(event) => {
                    event.stopPropagation();
                    onEdit({ drop });
                  }}
                >
                  {drop.name}
                  {drop.quantity > 1 && ` × ${formatInt(drop.quantity)}`}
                </button>
                {drop.manual && <Badge>Manual</Badge>}
                {drop.note !== null && <NoteIcon note={drop.note} />}
              </span>
              <span className="flex max-w-full min-w-0 items-center gap-1.5 text-xs text-text-3">
                {account && (
                  <>
                    <AccountDot color={account.color} />
                    <span className="sr-only">{account.name}</span>
                  </>
                )}
                <span className="truncate">
                  {gotByLabel(drop)}
                  {party !== undefined && ` · ${party}`} · {format.date(drop.occurredAt)}
                </span>
              </span>
              <DuplicateWarning drop={drop} onShowDrop={onShowDrop} />
            </span>
            <span className="flex flex-col items-end text-right tabular-nums">
              {drop.share !== null ? (
                <span className="font-semibold">{formatCompact(drop.share)}</span>
              ) : drop.partySizeUnknown ? (
                <SmallButton
                  onClick={() => {
                    onEdit({ drop, focus: 'partySize' });
                  }}
                >
                  Set party size
                </SmallButton>
              ) : drop.valueUnknown ? (
                <SmallButton
                  onClick={() => {
                    onEdit({ drop, focus: 'soldFor' });
                  }}
                >
                  Set value
                </SmallButton>
              ) : (
                <span className="text-text-3" aria-label="No share yet">
                  –
                </span>
              )}
              {of !== undefined && <span className="text-xs text-text-3">{of}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
