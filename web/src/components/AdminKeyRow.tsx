import type { AdminApiKey } from '@fireside/shared';
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

/** A user as named in a key row; `null` is the CLI or a deleted user. */
function who(user: AdminApiKey['createdBy']): string {
  return user ? user.username : 'the server';
}

/**
 * One key in Settings → Users → API keys: like `ApiKeyRow`, plus the owner as a
 * badge and who made and revoked it. Never the key itself. Active keys have a
 * revoke button.
 */
export function AdminKeyRow({
  apiKey,
  onRevoke,
}: {
  apiKey: AdminApiKey;
  /** Leave out in local mode, where the server can't revoke from here (`409`). */
  onRevoke?: (() => void) | undefined;
}) {
  const format = useFormat();
  const revoked = apiKey.revokedAt !== null;
  const madeBy = apiKey.createdBy?.id === apiKey.owner.id ? '' : ` by ${who(apiKey.createdBy)}`;
  let status: string;
  if (apiKey.revokedAt !== null) {
    const by = apiKey.revokedBy === 'owner' ? apiKey.owner.username : who(apiKey.revokedByUser);
    status = `revoked by ${by} ${format.dateTime(apiKey.revokedAt)}`;
  } else if (apiKey.lastUsedAt !== null) {
    status = `last used ${format.relative(apiKey.lastUsedAt)}`;
  } else {
    status = 'never used';
  }

  return (
    <li className={LIST_ROW}>
      <span className={LIST_ROW_ID}>{apiKey.prefix}…</span>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={cn('truncate font-medium', revoked && 'text-text-2')}>
            {apiKey.name}
          </span>
          <Badge className={LIST_ROW_BADGE}>{apiKey.owner.username}</Badge>
        </div>
        <div className="text-xs text-text-3">
          <span className={LIST_ROW_ID_INLINE}>{apiKey.prefix}… · </span>
          Created{madeBy} {format.dateTime(apiKey.createdAt)} · {status}
        </div>
      </div>
      {revoked && <Badge className={LIST_ROW_BADGE}>Revoked</Badge>}
      {!revoked && onRevoke && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Revoke ${apiKey.name} (${apiKey.owner.username})`}
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
