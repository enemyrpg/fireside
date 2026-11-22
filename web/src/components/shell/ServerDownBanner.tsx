import { CloudOffIcon } from 'lucide-react';
import { useServerStatus } from '@/api/server-status';

/** Shown while the server can't be reached. Goes away by itself. */
export function ServerDownBanner() {
  const { down } = useServerStatus();
  if (!down) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 border-b border-border bg-raised px-4 py-2 text-table text-text"
    >
      <CloudOffIcon aria-hidden="true" className="size-4 text-down" />
      Can&apos;t reach the server. Retrying…
    </div>
  );
}
