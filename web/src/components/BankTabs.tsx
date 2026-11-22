import { MAIN_BANK_TAB } from '@fireside/shared';
import type { ReactNode } from 'react';
import { ItemIcon } from '@/components/ItemIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatBankTab, formatGp } from '@/format';
import { cn } from '@/lib/utils';

export interface BankTabButton {
  /** 0 is the main tab. */
  tab: number;
  /** The tab's first item, shown as its icon. The main tab has the text "Main". */
  icon?: { itemId: number; name: string } | undefined;
  /** Value in the chosen mode, for the tooltip. */
  value: number;
}

export interface BankTabsProps {
  /** In display order: the main tab first, then tabs 1–9. */
  tabs: readonly BankTabButton[];
  /** `'all'` or a tab number. */
  selected: 'all' | number;
  onSelect: (tab: 'all' | number) => void;
  /** "GE" or "HA", for the tooltip. */
  valueLabel: string;
}

function TabButton({
  pressed,
  label,
  tooltip,
  onClick,
  children,
}: {
  pressed: boolean;
  label: string;
  tooltip: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={pressed}
          aria-label={label}
          onClick={onClick}
          className={cn(
            // Mobile: a cell of the six-column grid, 44 px; PC: 36 px buttons that wrap.
            'inline-flex h-11 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border px-0 desk:h-9 desk:min-w-11 desk:rounded-lg desk:px-2.5',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
            pressed
              ? 'border-accent bg-accent-wash font-semibold text-accent-text'
              : 'border-border bg-card text-text-2 hover:text-text desk:bg-raised',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The bank's tab buttons: "All", "Main", then one button per tab with slots,
 * showing the tab's first item and its number. On mobile a grid of six columns,
 * so every tab shows without scrolling sideways.
 */
export function BankTabs({ tabs, selected, onSelect, valueLabel }: BankTabsProps) {
  return (
    <div
      role="group"
      aria-label="Bank tabs"
      className="mb-3.5 grid grid-cols-6 gap-1.5 desk:flex desk:flex-wrap"
    >
      <TabButton
        pressed={selected === 'all'}
        label="All tabs"
        tooltip={
          <>
            <div className="font-semibold">All</div>
            <div className="text-text-3">Every tab, main tab first</div>
          </>
        }
        onClick={() => {
          onSelect('all');
        }}
      >
        All
      </TabButton>
      {tabs.map(({ tab, icon, value }) => {
        const main = tab === MAIN_BANK_TAB;
        return (
          <TabButton
            key={tab}
            pressed={selected === tab}
            label={formatBankTab(tab)}
            tooltip={
              <>
                <div className="font-semibold">{formatBankTab(tab)}</div>
                {main && <div className="text-text-3">Items that are not in a tab</div>}
                <div className="tabular-nums">
                  {valueLabel} {formatGp(value)}
                </div>
              </>
            }
            onClick={() => {
              onSelect(tab);
            }}
          >
            {main ? (
              'Main'
            ) : (
              <>
                {icon && (
                  <ItemIcon
                    itemId={icon.itemId}
                    name={icon.name}
                    size="slot"
                    className="h-6 w-[27px] rounded"
                  />
                )}
                {tab}
              </>
            )}
          </TabButton>
        );
      })}
    </div>
  );
}
