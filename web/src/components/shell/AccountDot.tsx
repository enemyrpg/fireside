import { cn } from '@/lib/utils';

/**
 * Account colour marker. `color` comes from `accountColor`. Without a colour
 * it is the "All accounts" dot, made from the first three account colours.
 */
export function AccountDot({ color, className }: { color?: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2.5 flex-none rounded-[3px]',
        color === undefined &&
          'bg-[conic-gradient(var(--acc-1)_0_33%,var(--acc-2)_0_66%,var(--acc-3)_0)]',
        className,
      )}
      style={color === undefined ? undefined : { background: color }}
    />
  );
}
