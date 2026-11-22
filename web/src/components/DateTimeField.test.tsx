import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateTimeField } from './DateTimeField';

// The web test project runs with TZ=America/Los_Angeles. The field works on
// local dates of the server's time zone, so nothing here may follow the
// browser's zone or clock.

const onDate = vi.fn<(date: string) => void>();
const onTime = vi.fn<(time: string) => void>();

function Field({
  date = '2026-11-16',
  today = '2026-11-16',
  min = '2013-02-22',
  timeError,
  error,
}: {
  date?: string;
  today?: string;
  min?: string;
  timeError?: string;
  error?: string;
}) {
  const [value, setValue] = useState({ date, time: '21:40' });
  return (
    <DateTimeField
      label="Date and time"
      date={value.date}
      time={value.time}
      today={today}
      min={min}
      timeError={timeError}
      error={error}
      onDateChange={(next) => {
        onDate(next);
        setValue((current) => ({ ...current, date: next }));
      }}
      onTimeChange={(next) => {
        onTime(next);
        setValue((current) => ({ ...current, time: next }));
      }}
    />
  );
}

const dateButton = () => screen.getByRole('button', { name: /^Date: / });

async function openCalendar(): Promise<HTMLElement> {
  await userEvent.click(dateButton());
  return screen.findByRole('grid');
}

/** The button of a day of the shown month (not the greyed days of its neighbours). */
function day(grid: HTMLElement, number: number): HTMLButtonElement {
  const cell = within(grid)
    .getAllByRole('gridcell')
    .find((item) => item.textContent === String(number) && !('outside' in item.dataset));
  const button = cell?.querySelector('button');
  if (!button) throw new Error(`No day ${String(number)}`);
  return button;
}

afterEach(() => {
  vi.useRealTimers();
  onDate.mockClear();
  onTime.mockClear();
});

describe('DateTimeField', () => {
  it('shows the date as "Mon 16 Nov 2026" and the time in 24-hour HH:mm', () => {
    render(<Field />);
    expect(screen.getByRole('group', { name: 'Date and time' })).toBeTruthy();
    expect(dateButton().textContent).toBe('Mon 16 Nov 2026');
    const time = screen.getByRole<HTMLInputElement>('textbox', { name: 'Time' });
    expect(time.value).toBe('21:40');
    expect(time.placeholder).toBe('HH:mm');
    // Not the browser's own picker.
    expect(document.querySelector('input[type="datetime-local"], input[type="date"]')).toBeNull();
  });

  it('opens an English calendar with weeks starting on Monday', async () => {
    render(<Field />);
    const grid = await openCalendar();
    expect(screen.getByText('November 2026')).toBeTruthy();
    // The short names are hidden from screen readers; each day's button has the full date.
    expect([...grid.querySelectorAll('thead th')].map((header) => header.textContent)).toEqual([
      'Mo',
      'Tu',
      'We',
      'Th',
      'Fr',
      'Sa',
      'Su',
    ]);
    expect(day(grid, 16).getAttribute('aria-label')).toContain('Monday, November 16th, 2026');
    expect(day(grid, 16).closest('td')?.getAttribute('aria-selected')).toBe('true');
  });

  it('marks today from the server’s date, not the browser’s clock', async () => {
    // 05:00 UTC on the 16th: still the 15th in the browser's zone (Los Angeles).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T05:00:00.000Z'));
    expect(new Date().getDate()).toBe(15);
    render(<Field date="2026-11-10" today="2026-11-16" />);
    const grid = await openCalendar();
    expect(day(grid, 16).closest('td')?.dataset.today).toBe('true');
    expect(day(grid, 15).closest('td')?.dataset.today).toBeUndefined();
    // Today can be chosen; tomorrow can't.
    expect(day(grid, 16).disabled).toBe(false);
    expect(day(grid, 17).disabled).toBe(true);
  });

  it('chooses a day as a local date and closes', async () => {
    render(<Field />);
    const grid = await openCalendar();
    await userEvent.click(day(grid, 12));
    expect(onDate).toHaveBeenCalledExactlyOnceWith('2026-11-12');
    await waitFor(() => {
      expect(screen.queryByRole('grid')).toBeNull();
    });
    expect(dateButton().textContent).toBe('Thu 12 Nov 2026');
  });

  it('disables days after today and cannot go to later months', async () => {
    render(<Field date="2026-11-10" />);
    const grid = await openCalendar();
    for (const number of [17, 18, 30]) expect(day(grid, number).disabled).toBe(true);
    for (const number of [1, 10, 16]) expect(day(grid, number).disabled).toBe(false);
    await userEvent.click(day(grid, 17));
    expect(onDate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /next month/i }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    // Earlier months are open.
    await userEvent.click(screen.getByRole('button', { name: /previous month/i }));
    expect(screen.getByText('October 2026')).toBeTruthy();
  });

  it('disables days before the first day and cannot go to earlier months', async () => {
    render(<Field date="2013-02-25" />);
    const grid = await openCalendar();
    expect(screen.getByText('February 2013')).toBeTruthy();
    expect(day(grid, 21).disabled).toBe(true);
    expect(day(grid, 22).disabled).toBe(false);
    expect(
      screen.getByRole('button', { name: /previous month/i }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('has Today and Yesterday shortcuts', async () => {
    render(<Field date="2026-10-03" />);
    await openCalendar();
    await userEvent.click(screen.getByRole('button', { name: 'Yesterday' }));
    expect(onDate).toHaveBeenLastCalledWith('2026-11-15');
    expect(dateButton().textContent).toBe('Sun 15 Nov 2026');
    await openCalendar();
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(onDate).toHaveBeenLastCalledWith('2026-11-16');
    expect(screen.queryByRole('grid')).toBeNull();
  });

  it('works with the keyboard', async () => {
    render(<Field />);
    dateButton().focus();
    await userEvent.keyboard('{Enter}');
    const grid = await screen.findByRole('grid');
    // Focus starts on the chosen day.
    await waitFor(() => {
      expect(document.activeElement).toBe(day(grid, 16));
    });
    // A week up, a day back: Sunday 8 November.
    await userEvent.keyboard('{ArrowUp}{ArrowLeft}');
    expect(document.activeElement).toBe(day(grid, 8));
    await userEvent.keyboard('{Enter}');
    expect(onDate).toHaveBeenCalledExactlyOnceWith('2026-11-08');
    // Closed, with focus back on the date button.
    await waitFor(() => {
      expect(document.activeElement).toBe(dateButton());
    });
    expect(screen.queryByRole('grid')).toBeNull();
  });

  it('closes with Escape without changing the date', async () => {
    render(<Field />);
    await openCalendar();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('grid')).toBeNull();
    });
    expect(onDate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(dateButton());
  });

  it('passes on the time as typed and shows its error under it', async () => {
    const { rerender } = render(<Field />);
    const time = screen.getByRole('textbox', { name: 'Time' });
    await userEvent.clear(time);
    await userEvent.type(time, '9:05');
    expect(onTime).toHaveBeenLastCalledWith('9:05');
    expect(time.getAttribute('aria-invalid')).toBe('false');

    rerender(<Field timeError="Enter a 24-hour time." error="Must not be in the future" />);
    const message = screen.getByText('Enter a 24-hour time.');
    expect(time.getAttribute('aria-invalid')).toBe('true');
    expect(time.getAttribute('aria-describedby')).toBe(message.id);
    expect(
      screen.getByRole('group', { name: 'Date and time' }).getAttribute('aria-describedby'),
    ).toBe(screen.getByText('Must not be in the future').id);
  });
});
