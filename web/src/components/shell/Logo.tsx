import {
  LOGO_CORNER_RADIUS,
  LOGO_FLAME,
  LOGO_LOGS,
  LOGO_STROKE_WIDTH,
  LOGO_VIEWBOX,
} from '@/branding/logo';
import { cn } from '@/lib/utils';

/**
 * The logo: flame above crossed logs on a rounded square in `--accent`, strokes
 * in `--on-accent`. Follows the theme.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox={LOGO_VIEWBOX}
      className={cn('size-7 flex-none', className)}
      fill="none"
      stroke="var(--on-accent)"
      strokeWidth={LOGO_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="24" height="24" rx={LOGO_CORNER_RADIUS} fill="var(--accent)" stroke="none" />
      <path d={LOGO_FLAME} />
      <path d={LOGO_LOGS} />
    </svg>
  );
}
