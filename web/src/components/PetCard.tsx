import type { Pet } from '@fireside/shared';
import type { ReactNode } from 'react';
import { Badge } from '@/components/Badge';
import { ItemIcon } from '@/components/ItemIcon';
import { AccountDot } from '@/components/shell/AccountDot';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useFormat } from '@/hooks/useFormat';
import { petDate, petDetail } from '@/lib/pets';

/** Its child with a tooltip, focusable so keyboard users get it too. */
function WithTooltip({ tooltip, children }: { tooltip: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex cursor-default rounded-sm">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * One pet in the trophy case: the icon at twice the game's size, the name,
 * where it came from with the KC or XP at the time, and the day. "Unconfirmed"
 * marks a pet only seen in chat. `account` is set for `all`, where the card
 * says whose pet it is. Read only: there is no way to add or remove a pet.
 */
export function PetCard({
  pet,
  account,
}: {
  pet: Pet;
  /** For "All accounts": the name and colour (`accountColor`) of the pet's account. */
  account?: { name: string; color: string } | undefined;
}) {
  const format = useFormat();
  const detail = petDetail(pet);
  const date = petDate(pet, format.timeZone);
  return (
    // The card's padding and radius, centred.
    <li className="flex min-w-0 flex-col items-center gap-2 rounded-2xl border border-border bg-card p-[18px] text-center desk:gap-2.5 desk:rounded-[14px] desk:px-6 desk:py-[22px]">
      <ItemIcon itemId={pet.itemId} name={pet.name} size="lg" />
      <div className="flex w-full min-w-0 flex-col gap-0.5">
        <h2 className="m-0 truncate font-display text-[17px] font-semibold desk:text-lg">
          {pet.name}
        </h2>
        {/* The line keeps its height without a source, so the cards of a row line up. */}
        <div className="min-h-[17px] truncate text-xs text-text-2">{detail}</div>
      </div>
      <div className="text-xs text-text-3 tabular-nums">
        {date === null ? (
          'Date unknown'
        ) : pet.approximate ? (
          <WithTooltip tooltip="~ is the sync that found it, not the drop">{date}</WithTooltip>
        ) : (
          date
        )}
      </div>
      <div className="flex min-h-[19px] flex-wrap justify-center gap-1">
        {account !== undefined && (
          <Badge className="max-w-full">
            <AccountDot color={account.color} className="size-2" />
            <span className="truncate">{account.name}</span>
          </Badge>
        )}
        {!pet.confirmed && (
          <WithTooltip tooltip="Seen in chat. Confirmed when your collection log has it.">
            <Badge>Unconfirmed</Badge>
          </WithTooltip>
        )}
      </div>
    </li>
  );
}
