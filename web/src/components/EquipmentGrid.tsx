import type { ContainerItemResponse } from '@fireside/shared';
import type { ReactNode } from 'react';
import { ItemGrid, ItemSlot } from '@/components/ItemGrid';
import { formatEquipmentSlot } from '@/format';
import { EQUIPMENT_COLUMNS, equipmentCells } from '@/lib/bank';

export interface EquipmentGridProps {
  /** Worn items with their `slot`. */
  items: readonly ContainerItemResponse[];
  /** Summary for screen readers. */
  label: string;
  /** Tooltip of a worn item; `slotName` is the slot's display name ("Quiver ammo"). */
  tooltip: (item: ContainerItemResponse, slotName: string) => ReactNode;
}

/**
 * Worn items in three columns, laid out like the game's equipment panel. Empty
 * slots are frames with the slot's name in the tooltip. The second ammo slot
 * (`QUIVER_AMMO`) shows only when it holds ammo.
 */
export function EquipmentGrid({ items, label, tooltip }: EquipmentGridProps) {
  return (
    <ItemGrid columns={EQUIPMENT_COLUMNS} label={label}>
      {equipmentCells(items).map((cell, index) => {
        if (cell.kind === 'gap') return <ItemSlot key={index} variant="empty" />;
        const slotName = formatEquipmentSlot(cell.slot);
        if (cell.item === null) {
          return (
            <ItemSlot
              key={index}
              variant="hole"
              tooltip={
                <>
                  <div className="font-semibold">{slotName}</div>
                  <div className="text-text-3">Empty</div>
                </>
              }
            />
          );
        }
        return (
          <ItemSlot
            key={index}
            variant="item"
            itemId={cell.item.itemId}
            name={cell.item.name}
            quantity={cell.item.quantity}
            tooltip={tooltip(cell.item, slotName)}
          />
        );
      })}
    </ItemGrid>
  );
}
