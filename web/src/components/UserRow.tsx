import type { ManagedUser } from '@fireside/shared';
import { MoreHorizontalIcon } from 'lucide-react';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useFormat } from '@/hooks/useFormat';
import { LIST_ROW_BADGE, LIST_ROW_BUTTON } from '@/components/list-row';
import { cn } from '@/lib/utils';

export type UserAction =
  | 'rename'
  | 'make-admin'
  | 'make-member'
  | 'allow-keys'
  | 'block-keys'
  | 'create-key'
  | 'reset-link'
  | 'reset-2fa'
  | 'disable'
  | 'enable'
  | 'delete';

/**
 * One user in Settings → Users: name, role, key permission, created and last
 * login, with a menu of actions. The caller asks for confirmation where needed.
 * Your own row has no deactivate or delete (that is under Profile).
 */
export function UserRow({
  user,
  loginMode,
  onAction,
}: {
  user: ManagedUser;
  /** In local mode nothing can be changed (the server says `409`). */
  loginMode: boolean;
  onAction: (action: UserAction) => void;
}) {
  const format = useFormat();
  const disabled = user.disabledAt !== null;
  const login =
    user.lastLoginAt === null
      ? 'never logged in'
      : `last login ${format.relative(user.lastLoginAt)}`;
  const item = (action: UserAction, label: string, destructive = false) => (
    <DropdownMenuItem
      variant={destructive ? 'destructive' : 'default'}
      className="h-9 rounded-lg px-2.5 data-[variant=destructive]:text-down"
      onSelect={() => {
        onAction(action);
      }}
    >
      {label}
    </DropdownMenuItem>
  );

  return (
    <li
      className={cn(
        'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 rounded-[10px] bg-raised px-3.5 py-3',
        disabled && 'opacity-60',
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <b className="truncate font-semibold">{user.username}</b>
          {user.isSelf && <span className="text-xs text-text-3">(you)</span>}
          <Badge className={LIST_ROW_BADGE}>{user.role === 'admin' ? 'Admin' : 'Member'}</Badge>
          {user.twoFactorEnabled && <Badge className={LIST_ROW_BADGE}>2FA</Badge>}
          {disabled && <Badge className={LIST_ROW_BADGE}>Deactivated</Badge>}
        </div>
        <div className="text-xs text-text-3">
          Created {format.dateTime(user.createdAt)} · {login} ·{' '}
          {user.canCreateApiKeys ? 'can create API keys' : 'can’t create API keys'} ·{' '}
          {user.activeApiKeys === 1 ? '1 active key' : `${String(user.activeApiKeys)} active keys`}
        </div>
      </div>
      {loginMode && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${user.username}`}
              className={cn(
                LIST_ROW_BUTTON,
                'aria-expanded:border-accent aria-expanded:bg-accent-wash aria-expanded:text-accent-text',
              )}
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-[260px] max-w-[calc(100vw-32px)] rounded-xl border-border-strong bg-raised p-1.5"
          >
            {item('rename', 'Rename')}
            {user.role === 'admin'
              ? item('make-member', 'Make member')
              : item('make-admin', 'Make admin')}
            {user.canCreateApiKeys
              ? item('block-keys', 'Block creating API keys')
              : item('allow-keys', 'Allow creating API keys')}
            {!disabled && item('create-key', 'Create API key…')}
            {!disabled && item('reset-link', 'Password reset link')}
            {!user.isSelf && user.twoFactorEnabled && item('reset-2fa', 'Turn off two-factor…')}
            {!user.isSelf && (
              <>
                <DropdownMenuSeparator className="mx-1 my-1.5 bg-border-strong" />
                {disabled ? item('enable', 'Activate') : item('disable', 'Deactivate')}
                {item('delete', 'Delete with all data', true)}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}
