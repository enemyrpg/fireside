import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface SearchFieldProps {
  /** The search in the URL (`?q=`). */
  query: string;
  onQuery: (query: string) => void;
  /** Placeholder and accessible name, e.g. "Search the bank". */
  label: string;
  className?: string;
}

/**
 * A search field whose text lives in the URL. What is typed lives here and is
 * sent to the URL, not read back from it: the URL follows a moment later, and a
 * field bound straight to it loses letters when typing fast. A change of the
 * URL that did not come from typing (back, or a click that clears the search)
 * is taken over.
 */
export function SearchField({ query, onQuery, label, className }: SearchFieldProps) {
  const [text, setText] = useState(query);
  // Values sent to the URL that it has not shown yet.
  const sent = useRef<string[]>([]);
  useEffect(() => {
    const index = sent.current.indexOf(query);
    if (index >= 0) {
      // Our own typing arriving in the URL (earlier values may have been skipped).
      sent.current = sent.current.slice(index + 1);
    } else {
      sent.current = [];
      setText(query);
    }
  }, [query]);
  return (
    <Input
      type="search"
      value={text}
      placeholder={label}
      aria-label={label}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        sent.current.push(next);
        onQuery(next);
      }}
      className={cn('min-w-[150px] flex-1', className)}
    />
  );
}
