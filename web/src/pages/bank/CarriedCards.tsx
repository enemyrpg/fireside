import type { AccountBank, AccountPotionStorage } from '@fireside/shared';
import type { ReactNode } from 'react';
import { Card, CardHeader } from '@/components/Card';
import { EquipmentGrid } from '@/components/EquipmentGrid';
import { Gp } from '@/components/Gp';
import { ItemGrid, ItemSlot } from '@/components/ItemGrid';
import { Button } from '@/components/ui/button';
import { formatCount, formatGp, formatInt } from '@/format';
import {
  INVENTORY_COLUMNS,
  inventoryCells,
  netWorth,
  POTION_COLUMNS,
  POTIONS_SHOWN,
  valueOf,
  type ValueMode,
} from '@/lib/bank';
import { shownRows } from '@/lib/show-all';
import { GRID_CARD } from './BankCard';
import { ItemTooltip, PotionTooltip } from './tooltips';

// Carried and Potion storage, the middle column on PC.

/** The card's total on the right of its title. */
function Total({ value }: { value: number }) {
  return <Gp value={value} className="font-semibold tabular-nums" />;
}

/**
 * Potion storage: six per row; the number on a slot is doses, as in the game.
 * The first four rows, then "Show all N" (page state only, kept by the page so
 * it survives the switch between mobile and PC, and reset for another account).
 */
export function PotionStorageCard({
  storage,
  mode,
  expanded,
  onExpanded,
}: {
  storage: AccountPotionStorage;
  mode: ValueMode;
  expanded: boolean;
  onExpanded: (expanded: boolean) => void;
}) {
  const value = valueOf(storage.totals, mode);
  const doses = storage.potions.reduce((sum, potion) => sum + potion.doses, 0);
  const shown = shownRows(storage.potions, expanded, POTIONS_SHOWN);
  return (
    <Card className={GRID_CARD}>
      <CardHeader title="Potion storage" action={<Total value={value} />} />
      <ItemGrid
        columns={POTION_COLUMNS}
        label={`Potion storage: ${formatCount(storage.potions.length, 'potion')}, ${formatCount(doses, 'dose')}, worth ${formatGp(value)}`}
      >
        {shown.rows.map((potion) => (
          <ItemSlot
            key={potion.position}
            variant="item"
            itemId={potion.itemId}
            name={potion.name}
            quantity={potion.doses}
            tooltip={<PotionTooltip potion={potion} mode={mode} />}
          />
        ))}
      </ItemGrid>
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-text-3">
        <span>The number is doses, as in the game.</span>
        {shown.foldable && (
          <Button
            variant="link"
            size="xs"
            aria-expanded={expanded}
            className="h-auto p-0 text-xs font-normal text-accent-text max-desk:min-h-11"
            onClick={() => {
              onExpanded(!expanded);
            }}
          >
            {expanded ? 'Show fewer' : `Show all ${formatInt(storage.potions.length)}`}
          </Button>
        )}
      </div>
    </Card>
  );
}

/** "Inventory" or "Equipment" with its own total, over its grid. */
function Part({ name, value, children }: { name: string; value: number; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* In a narrow column the total goes under the name instead of squeezing it. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-text-3">
        <span>{name}</span>
        <Gp value={value} className="whitespace-nowrap tabular-nums" />
      </div>
      {children}
    </div>
  );
}

/**
 * What the account carried when the bank was last closed: the inventory as
 * 4 × 7 slots and the equipment laid out like the game's panel. Side by side
 * when the card is wide enough for slots of at least the icon's 36 px; in a
 * narrower card (the middle column at 1101–1300 px) the equipment goes under
 * the inventory, each at most as wide as it would be side by side, so icons
 * are never shrunk and slots never balloon.
 */
export function CarriedCard({
  bank,
  mode,
}: {
  bank: Pick<AccountBank, 'items' | 'inventory' | 'equipment'>;
  mode: ValueMode;
}) {
  const worth = netWorth(bank, undefined, mode);
  const { inventory, equipment } = bank;
  return (
    <Card className={GRID_CARD}>
      <CardHeader
        title={
          <>
            Carried {/* On PC the row at the top says it; on mobile this card stands alone. */}
            <span className="ml-1 text-xs font-normal text-text-3 desk:hidden">
              When the bank was last closed
            </span>
          </>
        }
        action={<Total value={worth.carried} />}
      />
      <div className="@container">
        <div className="flex flex-col gap-[18px] @min-[300px]:flex-row">
          <div className="max-w-[220px] min-w-0 @min-[300px]:max-w-[271px] @min-[300px]:flex-[4_1_150px]">
            <Part name="Inventory" value={worth.inventory}>
              <ItemGrid
                columns={INVENTORY_COLUMNS}
                label={`Inventory: ${formatCount(inventory.items.length, 'item')} worth ${formatGp(worth.inventory)}`}
              >
                {inventoryCells(inventory.items).map((item, index) =>
                  item === null ? (
                    <ItemSlot key={index} variant="hole" />
                  ) : (
                    <ItemSlot
                      key={index}
                      variant="item"
                      itemId={item.itemId}
                      name={item.name}
                      quantity={item.quantity}
                      tooltip={<ItemTooltip item={item} mode={mode} />}
                    />
                  ),
                )}
              </ItemGrid>
            </Part>
          </div>
          <div className="max-w-[166px] min-w-0 @min-[300px]:max-w-[202px] @min-[300px]:flex-[3_1_110px]">
            <Part name="Equipment" value={worth.equipment}>
              <EquipmentGrid
                items={equipment.items}
                label={`Equipment: ${formatCount(equipment.items.length, 'item')} worth ${formatGp(worth.equipment)}`}
                tooltip={(item, slotName) => (
                  <ItemTooltip item={item} mode={mode} extra={slotName} />
                )}
              />
            </Part>
          </div>
        </div>
      </div>
    </Card>
  );
}
