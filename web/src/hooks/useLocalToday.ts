import { useEffect, useState } from 'react';
import { localDateIn } from '@/format';

/** How often the date is checked. The component re-renders only when it changes. */
const CHECK_MS = 60_000;

/**
 * Today's local date (`2026-11-11`) in `timeZone`. Unlike `useNow`, the
 * component re-renders only when the date changes, not on every check.
 */
export function useLocalToday(timeZone: string): string {
  const [today, setToday] = useState(() => localDateIn(Date.now(), timeZone));
  useEffect(() => {
    // Same string = no re-render (React bails out on equal state).
    const check = () => {
      setToday(localDateIn(Date.now(), timeZone));
    };
    const first = setTimeout(check, 0); // picks up a new time zone
    const timer = setInterval(check, CHECK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [timeZone]);
  return today;
}
