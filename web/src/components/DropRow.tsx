import type { Drop } from '@fireside/shared';
import { Gp } from '@/components/Gp';
import { ItemIcon } from '@/components/ItemIcon';
import { AccountDot } from '@/components/shell/AccountDot';
import { formatInt } from '@/format';
import { useFormat } from '@/hooks/useFormat';
import { sourceLabel } from '@/lib/loot';

/**
 * One drop in a list (`<li>`): item × quantity, source (`PLAYER` as "Player"),
 * the account for `all`, value and time. Used by Loot and Weekly.
 */
export function DropRow({
  drop,
  accountLabel,
}: {
  drop: Drop;
  accountLabel?: { name: string; color: string } | undefined;
}) {
  const format = useFormat();
  return (
    <li className="flex min-w-0 items-center gap-2.5 border-b border-border py-2 last:border-b-0">
      <ItemIcon itemId={drop.itemId} name={drop.name} />
      <div className="min-w-0 flex-1">
        <div className="truncate">
          {drop.name}
          {drop.quantity > 1 && ` × ${formatInt(drop.quantity)}`}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-text-3">
          <span className="truncate">{sourceLabel(drop.source)}</span>
          {accountLabel && (
            <>
              <span aria-hidden="true">·</span>
              <AccountDot color={accountLabel.color} />
              <span className="truncate">{accountLabel.name}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex-none text-right">
        <Gp value={drop.geValue} className="block tabular-nums" />
        <div className="text-xs text-text-3">{format.relative(drop.occurredAt)}</div>
      </div>
    </li>
  );
}
