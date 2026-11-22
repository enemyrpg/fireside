import type { Invite, InviteStatus } from '@fireside/shared';
import { Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useFormat } from '@/hooks/useFormat';
import { inviteTitle } from '@/lib/invites';
import {
  LIST_ROW,
  LIST_ROW_BADGE,
  LIST_ROW_BUTTON,
  LIST_ROW_ID,
  LIST_ROW_ID_INLINE,
} from '@/components/list-row';
import { cn } from '@/lib/utils';

const STATUS: Record<InviteStatus, string> = {
  active: 'Active',
  used: 'Used',
  expired: 'Expired',
  revoked: 'Revoked',
};

/**
 * One invite or reset link in Settings → Users: ID, label, role, who made it,
 * when it expires and its status. Never the link. Active links have a revoke
 * button; the caller asks for confirmation.
 */
export function InviteRow({ invite, onRevoke }: { invite: Invite; onRevoke: () => void }) {
  const format = useFormat();
  const active = invite.status === 'active';
  const by = invite.createdBy?.username ?? 'a deleted user';
  let when: string;
  if (invite.status === 'used' && invite.usedAt !== null)
    when = `used ${format.dateTime(invite.usedAt)}`;
  else if (invite.status === 'revoked' && invite.revokedAt !== null) {
    when = `revoked ${format.dateTime(invite.revokedAt)}`;
  } else if (invite.status === 'expired') when = `expired ${format.dateTime(invite.expiresAt)}`;
  else when = `expires ${format.dateTime(invite.expiresAt)}`;
  const details =
    invite.type === 'invite'
      ? [
          invite.role === 'admin' ? 'Admin' : 'Member',
          invite.canCreateApiKeys ? 'can create API keys' : 'can’t create API keys',
        ]
      : [];
  const became =
    invite.type === 'invite' && invite.status === 'used'
      ? invite.usedBy
        ? `→ ${invite.usedBy.username}`
        : '→ user deleted'
      : undefined;

  return (
    <li className={LIST_ROW}>
      <span className={LIST_ROW_ID}>{invite.id}</span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate font-medium', !active && 'text-text-2')}>
            {inviteTitle(invite)}
          </span>
          {became !== undefined && <span className="text-text-2">{became}</span>}
        </div>
        <div className="text-xs text-text-3">
          <span className={LIST_ROW_ID_INLINE}>{invite.id} · </span>
          {[...details, `by ${by}`, `created ${format.dateTime(invite.createdAt)}`, when].join(
            ' · ',
          )}
        </div>
      </div>
      {active ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Revoke ${invite.id}`}
              className={LIST_ROW_BUTTON}
              onClick={onRevoke}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Revoke</TooltipContent>
        </Tooltip>
      ) : (
        <Badge className={LIST_ROW_BADGE}>{STATUS[invite.status]}</Badge>
      )}
    </li>
  );
}
