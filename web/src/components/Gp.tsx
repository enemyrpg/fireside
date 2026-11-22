import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatCompact, formatGp, formatGpExact } from '@/format';

/**
 * Compact GP (`1.12M gp`) with the exact value on hover or focus. Focusable, so
 * keyboard users get the tooltip too.
 */
export function Gp({
  value,
  className,
  unit = true,
}: {
  value: number;
  className?: string;
  /** `false`: the number only (`1.12M`), for a layout that shows "gp" itself. */
  unit?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={className}>
          {unit ? formatGp(value) : formatCompact(value)}
        </span>
      </TooltipTrigger>
      <TooltipContent>{formatGpExact(value)}</TooltipContent>
    </Tooltip>
  );
}
