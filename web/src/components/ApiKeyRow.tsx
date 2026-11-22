import type { ApiKey } from '@fireside/shared';
import { Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useFormat } from '@/hooks/useFormat';
import {
  LIST_ROW,
  LIST_ROW_BADGE,
  LIST_ROW_BUTTON,
  LIST_ROW_ID,
  LIST_ROW_ID_INLINE,
} from '@/components/list-row';
import { cn } from '@/lib/utils';

/**
 * One API key: prefix, name, created, last used or revoked. Active keys have a
 * revoke button; the caller asks for confirmation. In login mode a key made or
 * revoked by an admin says so; in local mode the only other actor is the CLI on
 * the same PC, so it doesn't.
 */
export function ApiKeyRow({
  apiKey,
  showAdmin = false,
  onRevoke,
}: {
  apiKey: ApiKey;
  /** Say "by admin" for keys an admin made or revoked (login mode). */
  showAdmin?: boolean;
  onRevoke: () => void;
}) {
  const format = useFormat();
  const revoked = apiKey.revokedAt !== null;
  const byAdmin = showAdmin && apiKey.revokedBy === 'admin';
  let status: string;
  if (apiKey.revokedAt !== null) {
    status = `revoked ${byAdmin ? 'by admin ' : ''}${format.dateTime(apiKey.revokedAt)}`;
  } else if (apiKey.lastUsedAt !== null) status = `last used ${format.relative(apiKey.lastUsedAt)}`;
  else status = 'never used';

  return (
    <li className={LIST_ROW}>
      <span className={LIST_ROW_ID}>{apiKey.prefix}…</span>
      <div className="min-w-0">
        <div className={cn('truncate font-medium', revoked && 'text-text-2')}>{apiKey.name}</div>
        <div className="text-xs text-text-3">
          <span className={LIST_ROW_ID_INLINE}>{apiKey.prefix}… · </span>
          Created {showAdmin && apiKey.createdByAdmin ? 'by admin ' : ''}
          {format.dateTime(apiKey.createdAt)} · {status}
        </div>
      </div>
      {revoked ? (
        <Badge className={LIST_ROW_BADGE}>{byAdmin ? 'Revoked by admin' : 'Revoked'}</Badge>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Revoke ${apiKey.name}`}
              className={LIST_ROW_BUTTON}
              onClick={onRevoke}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Revoke</TooltipContent>
        </Tooltip>
      )}
    </li>
  );
}
