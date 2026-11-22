import type { BankItemResponse, ContainerItemResponse, PotionResponse } from '@fireside/shared';
import { TooltipRow } from '@/components/TooltipRow';
import { formatCount, formatGpExact, formatInt } from '@/format';
import { priceOf, slotKind, type ValueMode } from '@/lib/bank';

// Tooltips of slots on the Bank page: the name, the exact quantity, the GE and
// HA value, and the price each in the chosen value.

type Stack = Pick<
  ContainerItemResponse,
  'name' | 'quantity' | 'geValue' | 'haValue' | 'gePriceEach' | 'haPriceEach'
>;

/** An item in the bank, the inventory or worn. `extra` is the tab or the slot's name. */
export function ItemTooltip({
  item,
  mode,
  extra,
}: {
  item: Stack;
  mode: ValueMode;
  extra?: string | undefined;
}) {
  return (
    <>
      <div>
        <span className="font-semibold">{item.name}</span>
        {item.quantity > 1 && ` × ${formatInt(item.quantity)}`}
      </div>
      {extra !== undefined && <div className="text-text-3">{extra}</div>}
      <TooltipRow strong label="GE" value={formatGpExact(item.geValue)} />
      <TooltipRow strong label="HA" value={formatGpExact(item.haValue)} />
      {item.quantity > 1 && (
        <div className="text-text-3 tabular-nums">{formatGpExact(priceOf(item, mode))} each</div>
      )}
    </>
  );
}

/** A bank slot: an item, a placeholder or a filler. */
export function BankSlotTooltip({ item, mode }: { item: BankItemResponse; mode: ValueMode }) {
  const kind = slotKind(item);
  if (kind === 'filler') {
    return (
      <>
        <div className="font-semibold">Bank filler</div>
        <div className="text-text-3">Reserved slot · not counted</div>
      </>
    );
  }
  if (kind === 'placeholder') {
    return (
      <>
        <div className="font-semibold">{item.name}</div>
        <div className="text-text-3">Placeholder</div>
      </>
    );
  }
  return <ItemTooltip item={item} mode={mode} />;
}

/** A potion in potion storage: the number is doses, the price is for the full potion. */
export function PotionTooltip({ potion, mode }: { potion: PotionResponse; mode: ValueMode }) {
  return (
    <>
      <div>
        <span className="font-semibold">{potion.name}</span>
        {` × ${formatCount(potion.doses, 'dose')}`}
      </div>
      <TooltipRow strong label="GE" value={formatGpExact(potion.geValue)} />
      <TooltipRow strong label="HA" value={formatGpExact(potion.haValue)} />
      <div className="text-text-3 tabular-nums">
        {formatGpExact(priceOf(potion, mode))} per full potion (
        {formatCount(potion.itemDoses, 'dose')})
      </div>
    </>
  );
}
