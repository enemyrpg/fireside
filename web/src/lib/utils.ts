import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Our own font sizes (theme/tokens.css). Without them tailwind-merge reads
// `text-axis` as a colour and drops it next to `text-text-2`.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ['axis', 'table', 'tile', 'stat'] } },
});

/** Joins class names and lets later Tailwind classes override earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
