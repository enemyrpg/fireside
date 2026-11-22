import type { BankItemResponse } from '@fireside/shared';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { BankTabs } from '@/components/BankTabs';
import { Card, CardHeader } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { Gp } from '@/components/Gp';
import { ItemGrid, ItemSlot } from '@/components/ItemGrid';
import { ItemIcon } from '@/components/ItemIcon';
import { SearchField } from '@/components/SearchField';
import { EmptyMessage } from '@/components/states';
import { Switch } from '@/components/Switch';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatBankTab, formatCount, formatGp, formatInt, formatItemCount } from '@/format';
import {
  BANK_COLUMNS,
  BANK_LIST_ROWS,
  countItems,
  countPlaceholders,
  hasTabs,
  listRows,
  searchBank,
  sectionsOf,
  slotKind,
  slotsValue,
  tabIconItem,
  valueOf,
  VALUE_MODE_LABEL,
  visibleSections,
  type BankSection,
  type TabChoice,
  type ValueMode,
} from '@/lib/bank';
import { cn } from '@/lib/utils';
import { BankSlotTooltip, ItemTooltip } from './tooltips';

// The Bank card: the bank 1:1 with the game. Tab buttons, search, the
// Placeholders switch, the grid with a separator per tab, "Show all" for a long
// bank, and the list view.

export interface BankCardProps {
  /** The tabs with slots, in display order (`bankSections`). */
  sections: readonly BankSection[];
  mode: ValueMode;
  tab: TabChoice;
  onTab: (tab: TabChoice) => void;
  query: string;
  onQuery: (query: string) => void;
  showPlaceholders: boolean;
  onShowPlaceholders: (show: boolean) => void;
  asList: boolean;
  onAsList: (asList: boolean) => void;
  /**
   * "Show all" of a long bank: page state only, not in the URL. Kept by the
   * page, so it survives the switch between the mobile and PC layouts.
   */
  expanded: boolean;
  onExpanded: (expanded: boolean) => void;
}

/** "Show all (933 slots)" and the like: 36 px, outline in `--border-strong`, accent text. */
export const SHOW_ALL_BUTTON =
  'h-11 border-border-strong px-4 font-medium text-accent-text hover:text-accent-text desk:h-9';

/**
 * Cards with an `ItemGrid` have less padding on mobile, so eight slots per
 * row are about 40 px wide on a 390 px screen.
 */
export const GRID_CARD = 'max-desk:px-3.5 max-desk:py-4 desk:p-5';

/** A line above a grid: a name, a count and the value on the right. */
export function Separator({
  first,
  children,
  value,
}: {
  /** The first separator of a card has no line above it. */
  first: boolean;
  children: ReactNode;
  value: number;
}) {
  return (
    <div
      className={cn(
        'mb-2.5 flex items-baseline gap-1.5 px-0.5 text-table text-text-3 desk:px-0 desk:pt-1',
        !first && 'mt-4 border-t border-hover pt-3 desk:pt-3',
      )}
    >
      {children}
      <Gp value={value} className="ml-auto text-text-2 tabular-nums" />
    </div>
  );
}

/**
 * The slots of one grid. Memoised: a bank has hundreds of slots, each with a
 * tooltip, and they must not be drawn again for every keystroke in the search
 * or any other change to the URL.
 */
const Slots = memo(function Slots({
  items,
  mode,
  showPlaceholders,
}: {
  items: readonly BankItemResponse[];
  mode: ValueMode;
  showPlaceholders: boolean;
}) {
  return items.map((item) => {
    const kind = slotKind(item);
    // Hidden placeholders keep their space, so rows and columns stay as in the game.
    if (kind === 'placeholder' && !showPlaceholders) {
      return <ItemSlot key={item.position} variant="empty" />;
    }
    return (
      <ItemSlot
        key={item.position}
        variant={kind}
        itemId={item.itemId}
        name={item.name}
        quantity={item.quantity}
        tooltip={<BankSlotTooltip item={item} mode={mode} />}
      />
    );
  });
});

function BankList({ items, mode }: { items: readonly BankItemResponse[]; mode: ValueMode }) {
  const [showAll, setShowAll] = useState(false);
  const rows = listRows(items, mode);
  // The list has no placeholders and no fillers, so a tab with only those is empty here.
  if (rows.length === 0)
    return <EmptyMessage>Only placeholders and reserved slots here.</EmptyMessage>;
  const columns: Column<BankItemResponse>[] = [
    {
      id: 'item',
      header: 'Item',
      // Fixed layout: long names are cut with "…", so the table never leaves the card.
      className: 'max-w-0',
      cell: (item) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="flex min-w-0 items-center gap-2 rounded-sm">
              <ItemIcon itemId={item.itemId} name={item.name} />
              <span className="truncate">{item.name}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <ItemTooltip item={item} mode={mode} extra={formatBankTab(item.tab)} />
          </TooltipContent>
        </Tooltip>
      ),
    },
    {
      id: 'quantity',
      header: 'Quantity',
      align: 'right',
      className: 'w-[92px]',
      cell: (item) => formatInt(item.quantity),
    },
    {
      id: 'value',
      header: 'Value',
      align: 'right',
      className: 'w-[92px]',
      cell: (item) => formatGp(valueOf(item, mode)),
    },
  ];
  return (
    <>
      <DataTable
        label={`Bank items by ${VALUE_MODE_LABEL[mode]} value`}
        className="table-fixed"
        columns={columns}
        rows={showAll ? rows : rows.slice(0, BANK_LIST_ROWS)}
        rowKey={(item) => item.position}
      />
      {rows.length > BANK_LIST_ROWS && (
        <div className="mt-3 text-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowAll((value) => !value);
            }}
          >
            {showAll ? 'Show fewer' : `Show all (${formatInt(rows.length)})`}
          </Button>
        </div>
      )}
    </>
  );
}

export function BankCard({
  sections,
  mode,
  tab,
  onTab,
  query,
  onQuery,
  showPlaceholders,
  onShowPlaceholders,
  asList,
  onAsList,
  expanded,
  onExpanded,
}: BankCardProps) {
  const searching = query.trim() !== '';
  const matches = useMemo(() => {
    if (!searching) return [];
    const found = searchBank(sections, query, showPlaceholders);
    // The list shows items only, so a placeholder is no match there.
    return asList ? found.filter((item) => slotKind(item) === 'item') : found;
  }, [sections, query, showPlaceholders, searching, asList]);
  const chosen = sectionsOf(sections, tab);
  const view = useMemo(() => visibleSections(sections, tab, expanded), [sections, tab, expanded]);

  let body: ReactNode;
  if (sections.length === 0) {
    body = <EmptyMessage>This bank is empty.</EmptyMessage>;
  } else if (searching && matches.length === 0) {
    body = <EmptyMessage>Nothing in the bank matches “{query.trim()}”.</EmptyMessage>;
  } else if (searching) {
    // As in the game: the matches from every tab together, without tab buttons.
    const value = slotsValue(matches, mode);
    body = (
      <>
        <Separator first value={value}>
          <span>
            <b className="font-semibold text-text">{formatCount(countItems(matches), 'item')}</b>{' '}
            {countItems(matches) === 1 ? 'matches' : 'match'} “{query.trim()}”
          </span>
        </Separator>
        {asList ? (
          <BankList items={matches} mode={mode} />
        ) : (
          <ItemGrid
            columns={BANK_COLUMNS}
            label={`${formatCount(countItems(matches), 'item')} matching “${query.trim()}”, worth ${formatGp(value)}`}
          >
            <Slots items={matches} mode={mode} showPlaceholders={showPlaceholders} />
          </ItemGrid>
        )}
      </>
    );
  } else if (asList) {
    // Follows the chosen tab. Keyed by it, so "Show all" starts over on a new tab.
    body = (
      <BankList key={String(tab)} items={chosen.flatMap((section) => section.items)} mode={mode} />
    );
  } else {
    body = (
      <>
        {view.sections.map((section, index) => {
          const value = valueOf(section, mode);
          const name = formatBankTab(section.tab);
          const count = formatCount(section.itemCount, 'item');
          return (
            <div key={section.tab}>
              <Separator first={index === 0} value={value}>
                <b className="font-semibold text-text">{name}</b>
                <span>· {count}</span>
              </Separator>
              <ItemGrid columns={BANK_COLUMNS} label={`${name}: ${count} worth ${formatGp(value)}`}>
                <Slots items={section.visible} mode={mode} showPlaceholders={showPlaceholders} />
              </ItemGrid>
            </div>
          );
        })}
        {view.cut && (
          // The fade runs over the last 64 px of the grid, down to the button.
          <div className="relative pt-3.5 text-center before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-16 before:bg-linear-to-b before:from-transparent before:to-card">
            <Button
              variant="outline"
              className={SHOW_ALL_BUTTON}
              onClick={() => {
                onExpanded(true);
              }}
            >
              Show all ({formatCount(view.totalSlots, 'slot')})
            </Button>
          </div>
        )}
        {view.collapsible && !view.cut && (
          <div className="pt-3.5 text-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onExpanded(false);
              }}
            >
              Show less
            </Button>
          </div>
        )}
      </>
    );
  }

  const items = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  return (
    <Card className={GRID_CARD}>
      <CardHeader
        title={
          <>
            Bank{' '}
            <span className="ml-1 text-table font-normal text-text-3">
              {formatItemCount(countItems(items), countPlaceholders(items))}
            </span>
          </>
        }
        action={
          <Button
            variant="outline"
            size="sm"
            aria-pressed={asList}
            className="border-border-strong text-table font-normal text-text-2 max-desk:h-11"
            onClick={() => {
              onAsList(!asList);
            }}
          >
            {asList ? 'Show as grid' : 'Show as list'}
          </Button>
        }
      />
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <SearchField
          query={query}
          onQuery={onQuery}
          label="Search the bank"
          className="min-w-0 flex-[1_1_200px]"
        />
        <Switch label="Placeholders" checked={showPlaceholders} onChange={onShowPlaceholders} />
      </div>
      {!searching && hasTabs(sections) && (
        <BankTabs
          tabs={sections.map((section) => {
            const icon = tabIconItem(section);
            return {
              tab: section.tab,
              icon: icon && { itemId: icon.itemId, name: icon.name },
              value: valueOf(section, mode),
            };
          })}
          selected={tab}
          onSelect={onTab}
          valueLabel={VALUE_MODE_LABEL[mode]}
        />
      )}
      {body}
    </Card>
  );
}
