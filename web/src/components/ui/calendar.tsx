import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { DayPicker, type DayPickerProps } from 'react-day-picker';
import { cn } from '@/lib/utils';

/**
 * shadcn's Calendar (react-day-picker), styled only with the theme tokens:
 * the chosen day is filled in `--accent`, today has an accent border, and
 * focus uses the global accent ring. Weeks start on Monday, with English
 * month and day names (the picker's default locale). No stylesheet from the
 * library is loaded.
 *
 * Dates here are calendar dates carried in `Date` objects; pass `today`
 * explicitly, so it never comes from the browser's clock and time zone.
 */
function Calendar({ className, classNames, components, ...props }: DayPickerProps) {
  return (
    <DayPicker
      weekStartsOn={1}
      showOutsideDays
      fixedWeeks
      className={cn('w-fit', className)}
      classNames={{
        months: 'relative flex flex-col',
        month: 'flex flex-col gap-2',
        month_caption: 'flex h-8 items-center justify-center',
        caption_label: 'text-sm font-semibold',
        nav: 'absolute inset-x-0 top-0 z-10 flex h-8 items-center justify-between',
        button_previous:
          'inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text aria-disabled:pointer-events-none aria-disabled:opacity-40',
        button_next:
          'inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text aria-disabled:pointer-events-none aria-disabled:opacity-40',
        month_grid: 'border-collapse',
        weekday: 'size-9 text-axis font-medium text-text-3',
        day: 'size-9 p-0 text-center text-table tabular-nums',
        day_button:
          'inline-flex size-8 cursor-pointer items-center justify-center rounded-md border border-transparent hover:bg-hover disabled:pointer-events-none',
        today: '[&>button]:border-accent [&>button]:font-semibold',
        selected:
          '[&>button]:bg-accent [&>button]:font-semibold [&>button]:text-on-accent [&>button]:hover:bg-accent',
        outside: 'text-text-3',
        disabled: 'text-text-3 opacity-45',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: chevronClass }) =>
          orientation === 'left' ? (
            <ChevronLeftIcon aria-hidden="true" className={cn('size-4', chevronClass)} />
          ) : (
            <ChevronRightIcon aria-hidden="true" className={cn('size-4', chevronClass)} />
          ),
        ...components,
      }}
      {...props}
    />
  );
}

export { Calendar };
