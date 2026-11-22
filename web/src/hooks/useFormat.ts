import { useMemo } from 'react';
import { useHealth } from '@/api/hooks';
import { createFormatter, type Formatter } from '@/format';

/**
 * Time formatters in the server's time zone (`timeZone` from GET /health). The
 * shell renders pages only after health has loaded, so the UTC fallback is
 * never shown on a page.
 */
export function useFormat(): Formatter {
  const timeZone = useHealth().data?.timeZone ?? 'UTC';
  return useMemo(() => createFormatter(timeZone), [timeZone]);
}
