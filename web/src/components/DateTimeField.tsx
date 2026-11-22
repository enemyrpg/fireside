import { addDays } from '@fireside/shared';
import { CalendarDays } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatLocalDateLong, parseLocalDate } from '@/format';
import { calendarDate, dateKey, localDateOfCalendar } from '@/lib/time';

export interface DateTimeFieldProps {
  /** Name of the pair, shown above it ("Date and time"). */
  label: string;
  /** Local date in the server's time zone (`2026-11-16`). */
  date: string;
  /** The time as typed, 24-hour `HH:mm`. */
  time: string;
  onDateChange: (date: string) => void;
  onTimeChange: (time: string) => void;
  /** Today in the server's time zone. Later days can't be chosen. */
  today: string;
  /** The first day that can be chosen. */
  min: string;
  /** Message under the time when it can't be read or isn't allowed. */
  timeError?: string | undefined;
  /** Message about the date and time together, e.g. from the server. */
  error?: string | undefined;
}

/**
 * A date and a time in the server's time zone: a button with the date as
 * `Mon 16 Nov 2026` that opens a calendar, and a 24-hour `HH:mm` field. Not the
 * browser's own date picker, which follows the browser's locale and time zone.
 * The values are plain local date and time strings; the caller turns them into
 * an instant in the server's zone.
 */
export function DateTimeField({
  label,
  date,
  time,
  onDateChange,
  onTimeChange,
  today,
  min,
  timeError,
  error,
}: DateTimeFieldProps) {
  const [open, setOpen] = useState(false);
  const popover = useRef<HTMLDivElement>(null);
  const id = useId();
  const labelId = `${id}-label`;
  const timeErrorId = `${id}-time-error`;
  const errorId = `${id}-error`;
  const yesterday = dateKey(addDays(parseLocalDate(today), -1));
  const dateText = formatLocalDateLong(date);

  const choose = (next: string) => {
    onDateChange(next);
    setOpen(false);
  };

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={error !== undefined ? errorId : undefined}
      className="flex flex-col gap-1.5"
    >
      <span id={labelId} className="text-xs text-text-2">
        {label}
      </span>
      <div className="flex gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              aria-label={`Date: ${dateText}`}
              className="min-w-0 flex-1 justify-start border-input bg-page px-3 font-normal text-text"
            >
              <CalendarDays aria-hidden="true" className="text-text-3" />
              <span className="truncate">{dateText}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            ref={popover}
            className="w-auto border-border bg-card p-3"
            // Start on the chosen day, so the arrow keys work at once. Radix
            // would otherwise focus the first button (the previous month).
            onOpenAutoFocus={(event) => {
              const chosen = popover.current?.querySelector<HTMLElement>(
                '[aria-selected="true"] button',
              );
              if (chosen) {
                event.preventDefault();
                chosen.focus();
              }
            }}
          >
            <Calendar
              mode="single"
              required
              selected={calendarDate(date)}
              defaultMonth={calendarDate(date)}
              today={calendarDate(today)}
              startMonth={calendarDate(min)}
              endMonth={calendarDate(today)}
              disabled={{ before: calendarDate(min), after: calendarDate(today) }}
              onSelect={(day) => {
                choose(localDateOfCalendar(day));
              }}
            />
            <div className="mt-2 flex gap-2 border-t border-border pt-3">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  choose(today);
                }}
              >
                Today
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={yesterday < min}
                onClick={() => {
                  choose(yesterday);
                }}
              >
                Yesterday
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <Input
          aria-label="Time"
          aria-invalid={timeError !== undefined}
          aria-describedby={timeError !== undefined ? timeErrorId : undefined}
          value={time}
          inputMode="numeric"
          autoComplete="off"
          placeholder="HH:mm"
          maxLength={5}
          className="w-[5.5rem] flex-none bg-page text-center tabular-nums"
          onChange={(event) => {
            onTimeChange(event.target.value);
          }}
        />
      </div>
      {timeError !== undefined && (
        <p id={timeErrorId} className="m-0 text-xs text-down">
          {timeError}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} className="m-0 text-xs text-down">
          {error}
        </p>
      )}
    </div>
  );
}
