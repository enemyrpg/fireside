import { CheckIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { THEMES } from '@/theme/themes';
import { useTheme } from '@/theme/useTheme';

/**
 * The theme picker: a card per theme with a small preview in the theme's own
 * colours (`data-theme` on the preview), the only place to choose a theme since
 * v2. Three in a row on mobile.
 */
export function ThemeList() {
  const [theme, setTheme] = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="grid grid-cols-3 gap-2 desk:grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] desk:gap-2.5"
    >
      {THEMES.map((item) => {
        const selected = item.id === theme;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => {
              setTheme(item.id);
            }}
            className={cn(
              'flex min-w-0 flex-col gap-2.5 rounded-[10px] border border-border bg-raised p-2.5 text-left hover:border-border-strong desk:p-3',
              selected && 'border-accent bg-accent-wash hover:border-accent',
            )}
          >
            <span
              aria-hidden="true"
              data-theme={item.id}
              className="flex h-11 gap-1 rounded-[7px] border border-border-strong bg-page p-1.5 desk:h-[54px] desk:gap-[5px] desk:p-2"
            >
              <span className="flex-1 rounded bg-card" />
              <span className="h-[70%] w-2.5 self-end rounded-[3px] bg-accent desk:w-3.5" />
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn('truncate', selected && 'font-semibold')}>{item.label}</span>
              <CheckIcon
                aria-hidden="true"
                className={cn(
                  'ml-auto size-4 flex-none text-accent-text',
                  !selected && 'invisible',
                )}
              />
            </span>
            <span className="-mt-2 truncate text-xs text-text-3">{item.note}</span>
          </button>
        );
      })}
    </div>
  );
}
