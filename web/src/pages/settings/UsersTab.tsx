import type {
  AdminApiKey,
  CreatedInviteResponse,
  CreateUserKeyResponse,
  Invite,
  ManagedUser,
} from '@fireside/shared';
import { useRef, useState } from 'react';
import { useAuthMe } from '@/api/auth';
import {
  formErrorMessage,
  useAdminKeys,
  useAdminRevokeKey,
  useCreatePasswordReset,
  useResetTwoFactor,
  useCreateUserKey,
  useDeleteUser,
  useInvites,
  useRevokeInvite,
  useUpdateUser,
  useUsers,
} from '@/api/users';
import { AdminKeyRow } from '@/components/AdminKeyRow';
import { Card, CardHeader } from '@/components/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CreateInviteForm } from '@/components/CreateInviteForm';
import { FormField } from '@/components/FormField';
import { InviteRow } from '@/components/InviteRow';
import { SecretReveal } from '@/components/SecretReveal';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import { Input } from '@/components/ui/input';
import { UserRow, type UserAction } from '@/components/UserRow';
import { inviteTitle, LOCAL_ONLY_WARNING } from '@/lib/invites';
import { HistoryLinkRow } from '@/components/HistoryLinkRow';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { activeInvites, activeKeys } from '@/lib/history';
import { ActiveCount } from './ActiveCount';
import { SETTINGS_INVITES_PAST_PATH, SETTINGS_USERS_KEYS_REVOKED_PATH } from './paths';
import { SettingsLayout } from './SettingsLayout';

// Settings → Users, admin only: users with their role, key permission and
// status, every user's API keys, invites and password reset links. A new link
// or key is shown once with Copy.

function LinkReveal({ created }: { created: CreatedInviteResponse }) {
  const reset = created.invite.type === 'password_reset';
  return (
    <SecretReveal
      label={reset ? 'New password reset link' : 'New invite link'}
      title={inviteTitle(created.invite)}
      value={created.url}
      announcement={`${reset ? 'Password reset link' : 'Invite link'} created. Copy it now.`}
      warning={created.localOnly ? LOCAL_ONLY_WARNING : undefined}
      hint={
        reset
          ? "Copy it now and send it to the user yourself. You won't see this link again. It works once, for 24 hours."
          : "Copy it now and send it yourself. You won't see this link again. It works once."
      }
    />
  );
}

/** Id of the heading of a key made from a user's menu, which gets focus. */
const USER_KEY_HEADING_ID = 'new-user-key';

function UserKeyReveal({ created, selfId }: { created: CreateUserKeyResponse; selfId: number }) {
  const owner = created.apiKey.owner;
  return (
    <SecretReveal
      headingId={USER_KEY_HEADING_ID}
      label={`New API key ${created.apiKey.name}`}
      title={
        owner.id === selfId ? created.apiKey.name : `${created.apiKey.name} · for ${owner.username}`
      }
      value={created.key}
      announcement="API key created. Copy it now."
      hint={
        owner.id === selfId
          ? "Copy it now. You won't see the full key again."
          : `Copy it now and give it to ${owner.username} yourself. You won't see the full key again.`
      }
    />
  );
}

/** A confirmation that is open, and for whom. */
type Pending =
  | {
      kind: 'disable' | 'delete' | 'rename' | 'block-keys' | 'create-key' | 'reset-2fa';
      user: ManagedUser;
    }
  | { kind: 'revoke'; invite: Invite }
  | { kind: 'revoke-key'; apiKey: AdminApiKey };

function KeyList({
  loginMode,
  onRevoke,
}: {
  loginMode: boolean;
  onRevoke: (apiKey: AdminApiKey) => void;
}) {
  const keys = useAdminKeys();
  if (keys.isError) {
    return (
      <ErrorState
        onRetry={() => {
          void keys.refetch();
        }}
      />
    );
  }
  if (!keys.data) return <CardSkeleton lines={2} />;
  const active = activeKeys(keys.data.keys);
  const revoked = keys.data.keys.length - active.length;
  return (
    <>
      {active.length === 0 ? (
        <EmptyState>{revoked > 0 ? 'No active API keys.' : 'No API keys yet.'}</EmptyState>
      ) : (
        <ul aria-label="All API keys" className="m-0 flex list-none flex-col gap-2.5 p-0">
          {active.map((apiKey) => (
            <AdminKeyRow
              key={apiKey.id}
              apiKey={apiKey}
              onRevoke={
                loginMode
                  ? () => {
                      onRevoke(apiKey);
                    }
                  : undefined
              }
            />
          ))}
        </ul>
      )}
      <HistoryLinkRow
        to={SETTINGS_USERS_KEYS_REVOKED_PATH}
        label="Revoked keys"
        count={revoked}
        className="mt-0"
      />
    </>
  );
}

function UserList({
  loginMode,
  onAction,
}: {
  loginMode: boolean;
  onAction: (user: ManagedUser, action: UserAction) => void;
}) {
  const users = useUsers();
  if (users.isError) {
    return (
      <ErrorState
        onRetry={() => {
          void users.refetch();
        }}
      />
    );
  }
  if (!users.data) return <CardSkeleton lines={2} />;
  return (
    <ul aria-label="Users" className="m-0 flex list-none flex-col gap-2.5 p-0">
      {users.data.users.map((user) => (
        <UserRow
          key={user.id}
          user={user}
          loginMode={loginMode}
          onAction={(action) => {
            onAction(user, action);
          }}
        />
      ))}
    </ul>
  );
}

function InviteList({ onRevoke }: { onRevoke: (invite: Invite) => void }) {
  const invites = useInvites();
  const isDesktop = useIsDesktop();
  if (invites.isError) {
    return (
      <ErrorState
        onRetry={() => {
          void invites.refetch();
        }}
      />
    );
  }
  if (!invites.data) return <CardSkeleton lines={2} />;
  const active = activeInvites(invites.data.invites);
  const past = invites.data.invites.length - active.length;
  return (
    <>
      {active.length === 0 ? (
        <EmptyState>
          No active invites. Links you create are listed here with an ID until they are used, expire
          or are revoked.
        </EmptyState>
      ) : (
        <ul aria-label="Invites" className="m-0 flex list-none flex-col gap-2.5 p-0">
          {active.map((invite) => (
            <InviteRow
              key={invite.id}
              invite={invite}
              onRevoke={() => {
                onRevoke(invite);
              }}
            />
          ))}
        </ul>
      )}
      <HistoryLinkRow
        to={SETTINGS_INVITES_PAST_PATH}
        label={isDesktop ? 'Used, expired and revoked invites' : 'Used, expired and revoked'}
        count={past}
        className="mt-0"
      />
    </>
  );
}

export function UsersTab() {
  const me = useAuthMe().data;
  const loginMode = me?.mode === 'login';
  const selfId = me?.user?.id ?? 0;
  const [createdInvite, setCreatedInvite] = useState<CreatedInviteResponse>();
  const [createdReset, setCreatedReset] = useState<CreatedInviteResponse>();
  const [createdKey, setCreatedKey] = useState<CreateUserKeyResponse>();
  /** Set when a key was just made from a user's menu: the dialog hands focus to its reveal. */
  const focusNewKey = useRef(false);
  /** Which button of the block dialog runs, for its "…ing" label. */
  const [blockOnly, setBlockOnly] = useState(false);
  // Kept after closing, so the title doesn't go blank while the dialog animates out.
  const [pending, setPending] = useState<Pending>();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const update = useUpdateUser();
  const remove = useDeleteUser();
  const resetLink = useCreatePasswordReset();
  const revoke = useRevokeInvite();
  const createKey = useCreateUserKey();
  const revokeKey = useAdminRevokeKey();
  const resetTwoFactor = useResetTwoFactor();
  const userCount = useUsers().data?.users.length;
  const adminKeys = useAdminKeys().data?.keys;
  const activeKeyCount = adminKeys === undefined ? undefined : activeKeys(adminKeys).length;

  const ask = (next: Pending) => {
    update.reset();
    remove.reset();
    revoke.reset();
    createKey.reset();
    revokeKey.reset();
    resetTwoFactor.reset();
    setTyped(next.kind === 'rename' ? next.user.username : '');
    setPending(next);
    setOpen(true);
  };

  const onAction = (user: ManagedUser, action: UserAction) => {
    update.reset();
    resetLink.reset();
    switch (action) {
      case 'rename':
      case 'disable':
      case 'delete':
      case 'create-key':
      case 'reset-2fa':
        ask({ kind: action, user });
        return;
      case 'reset-link':
        resetLink.mutate(user.id, { onSuccess: setCreatedReset });
        return;
      case 'make-admin':
      case 'make-member':
        update.mutate({ id: user.id, role: action === 'make-admin' ? 'admin' : 'member' });
        return;
      case 'allow-keys':
        update.mutate({ id: user.id, canCreateApiKeys: true });
        return;
      case 'block-keys':
        // With active keys, ask whether to revoke them too.
        if (user.activeApiKeys > 0) ask({ kind: 'block-keys', user });
        else update.mutate({ id: user.id, canCreateApiKeys: false });
        return;
      case 'enable':
        update.mutate({ id: user.id, disabled: false });
        return;
    }
  };

  // Errors of actions taken straight from the menu (no dialog).
  const inlineError = open
    ? undefined
    : (formErrorMessage(update.error, "Couldn't change the user. Try again.") ??
      formErrorMessage(resetLink.error, "Couldn't create the link. Try again."));

  const close = () => {
    setOpen(false);
  };
  const dialog = (() => {
    if (!pending) return null;
    if (pending.kind === 'revoke-key') {
      const { apiKey } = pending;
      return {
        title: `Revoke “${apiKey.name}” (${apiKey.owner.username})?`,
        description: `RuneLite clients using this key stop sending data right away. ${apiKey.owner.username} sees “Revoked by admin”. This can’t be undone.`,
        confirmLabel: 'Revoke key',
        pendingLabel: 'Revoking…',
        destructive: true,
        busy: revokeKey.isPending,
        error: revokeKey.isError ? "Couldn't revoke the key. Try again." : undefined,
        disabled: false,
        fields: null,
        secondary: undefined,
        run: () => {
          revokeKey.mutate(apiKey.id, {
            onSuccess: () => {
              close();
              if (createdKey?.apiKey.id === apiKey.id) setCreatedKey(undefined);
            },
          });
        },
      };
    }
    if (pending.kind === 'revoke') {
      return {
        title: `Revoke ${inviteTitle(pending.invite)}?`,
        description: 'The link stops working right away. This can’t be undone.',
        confirmLabel: 'Revoke link',
        pendingLabel: 'Revoking…',
        destructive: true,
        busy: revoke.isPending,
        error: revoke.isError ? "Couldn't revoke the link. Try again." : undefined,
        disabled: false,
        fields: null,
        secondary: undefined,
        run: () => {
          revoke.mutate(pending.invite.id, {
            onSuccess: () => {
              close();
              if (createdInvite?.invite.id === pending.invite.id) setCreatedInvite(undefined);
              if (createdReset?.invite.id === pending.invite.id) setCreatedReset(undefined);
            },
          });
        },
      };
    }
    const { user } = pending;
    if (pending.kind === 'block-keys') {
      const n = user.activeApiKeys;
      const keys = n === 1 ? '1 active key' : `${String(n)} active keys`;
      return {
        title: `Block ${user.username} from creating API keys?`,
        description: `They can’t create new keys, but still see theirs and can revoke them. They have ${keys}. Blocking alone keeps ${n === 1 ? 'it' : 'them'} working; revoking stops ${n === 1 ? 'it' : 'them'} right away, and their plugin keeps what it hasn’t sent.`,
        confirmLabel:
          n === 1 ? 'Block and revoke their key' : `Block and revoke their ${String(n)} keys`,
        pendingLabel: 'Revoking…',
        destructive: true,
        busy: update.isPending,
        error: formErrorMessage(update.error, "Couldn't change the user. Try again."),
        disabled: false,
        fields: null,
        secondary: {
          label: 'Block only',
          pendingLabel: 'Blocking…',
          running: blockOnly,
          onClick: () => {
            setBlockOnly(true);
            update.mutate({ id: user.id, canCreateApiKeys: false }, { onSuccess: close });
          },
        },
        run: () => {
          setBlockOnly(false);
          update.mutate(
            { id: user.id, canCreateApiKeys: false, revokeActiveKeys: true },
            {
              onSuccess: () => {
                close();
                if (createdKey?.apiKey.owner.id === user.id) setCreatedKey(undefined);
              },
            },
          );
        },
      };
    }
    if (pending.kind === 'create-key') {
      return {
        title: `Create an API key for ${user.username}`,
        description: `The key belongs to ${user.username}: what their plugin sends with it is theirs. You see it once, then give it to them. It counts towards their limit of 10 active keys.`,
        confirmLabel: 'Create key',
        pendingLabel: 'Creating…',
        destructive: false,
        busy: createKey.isPending,
        error: formErrorMessage(createKey.error, "Couldn't create the key. Try again."),
        disabled: false,
        secondary: undefined,
        fields: (
          <FormField label="Name">
            {(control) => (
              <Input
                {...control}
                value={typed}
                placeholder="Gaming PC"
                autoComplete="off"
                className="bg-page"
                onChange={(event) => {
                  setTyped(event.target.value);
                  if (createKey.isError) createKey.reset();
                }}
              />
            )}
          </FormField>
        ),
        run: () => {
          createKey.mutate(
            { id: user.id, name: typed },
            {
              onSuccess: (created) => {
                // The key shows once, under the Users card: focus goes there
                // when the dialog closes, so it is in view and announced.
                focusNewKey.current = true;
                close();
                setCreatedKey(created);
              },
            },
          );
        },
      };
    }
    if (pending.kind === 'rename') {
      return {
        title: `Rename ${user.username}`,
        description: 'They log in with the new name from now on.',
        confirmLabel: 'Rename',
        pendingLabel: 'Renaming…',
        destructive: false,
        busy: update.isPending,
        error: formErrorMessage(update.error, "Couldn't rename the user. Try again."),
        disabled: typed.trim() === '',
        secondary: undefined,
        fields: (
          <FormField label="New username">
            {(control) => (
              <Input
                {...control}
                value={typed}
                autoCapitalize="none"
                spellCheck={false}
                autoComplete="off"
                className="bg-page"
                onChange={(event) => {
                  setTyped(event.target.value);
                }}
              />
            )}
          </FormField>
        ),
        run: () => {
          update.mutate({ id: user.id, username: typed }, { onSuccess: close });
        },
      };
    }
    if (pending.kind === 'reset-2fa') {
      return {
        title: `Turn off two-factor for ${user.username}?`,
        description:
          'For a user who lost both their phone and their recovery codes. They are logged out everywhere and log in with just their password until they turn it on again. Send them a password reset link too if they forgot the password.',
        confirmLabel: 'Turn off two-factor',
        pendingLabel: 'Turning off…',
        destructive: true,
        busy: resetTwoFactor.isPending,
        error: formErrorMessage(
          resetTwoFactor.error,
          "Couldn't turn off two-factor authentication. Try again.",
        ),
        disabled: false,
        fields: null,
        secondary: undefined,
        run: () => {
          resetTwoFactor.mutate(user.id, { onSuccess: close });
        },
      };
    }
    if (pending.kind === 'disable') {
      return {
        title: `Deactivate ${user.username}?`,
        description:
          'They are logged out everywhere and can’t log in. Their API keys stop working, and their plugin keeps what it hasn’t sent. Their data stays, and you can activate them again.',
        confirmLabel: 'Deactivate',
        pendingLabel: 'Deactivating…',
        destructive: true,
        busy: update.isPending,
        error: formErrorMessage(update.error, "Couldn't deactivate the user. Try again."),
        disabled: false,
        fields: null,
        secondary: undefined,
        run: () => {
          update.mutate({ id: user.id, disabled: true }, { onSuccess: close });
        },
      };
    }
    return {
      title: `Delete ${user.username} and all their data?`,
      description:
        'Their OSRS accounts, sessions, loot, bank, everything the plugin sent, their API keys and settings are deleted for good. Backups keep a copy until they rotate out. This can’t be undone.',
      confirmLabel: 'Delete user',
      pendingLabel: 'Deleting…',
      destructive: true,
      busy: remove.isPending,
      error: formErrorMessage(remove.error, "Couldn't delete the user. Try again."),
      disabled: typed.trim().toLowerCase() !== user.username,
      secondary: undefined,
      fields: (
        <FormField label={`Type ${user.username} to confirm`}>
          {(control) => (
            <Input
              {...control}
              value={typed}
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="off"
              className="bg-page"
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
          )}
        </FormField>
      ),
      run: () => {
        remove.mutate(user.id, {
          onSuccess: () => {
            close();
            if (
              createdReset?.invite.type === 'password_reset' &&
              createdReset.invite.targetUser.id === user.id
            ) {
              setCreatedReset(undefined);
            }
            if (createdKey?.apiKey.owner.id === user.id) setCreatedKey(undefined);
          },
        });
      },
    };
  })();

  return (
    <SettingsLayout section="users">
      <Card>
        <CardHeader
          title={
            <ActiveCount
              title="Users"
              count={userCount}
              unit={userCount === 1 ? 'user' : 'users'}
            />
          }
          className="mb-1.5"
        />
        <p className="mt-0 mb-[18px] text-text-2">
          Everyone who can log in to this server. Each user only sees their own OSRS accounts. You
          can’t see their data in the dashboard, but you have the database file and the backups.
        </p>
        <div className="flex flex-col gap-2.5">
          {createdReset && <LinkReveal created={createdReset} />}
          {inlineError !== undefined && (
            <p role="alert" className="m-0 text-sm text-down">
              {inlineError}
            </p>
          )}
          <UserList loginMode={loginMode} onAction={onAction} />
        </div>
      </Card>
      {createdKey && <UserKeyReveal created={createdKey} selfId={selfId} />}
      <Card>
        <CardHeader title="Invites" className="mb-1.5" />
        {loginMode ? (
          <>
            <p className="mt-0 mb-[18px] text-text-2">
              An invite link lets one person choose a username and password. It works once, until it
              expires or you revoke it. Password reset links show up here too.
            </p>
            <div className="flex flex-col gap-2.5">
              <CreateInviteForm onCreated={setCreatedInvite} />
              {createdInvite && <LinkReveal created={createdInvite} />}
              <InviteList
                onRevoke={(invite) => {
                  ask({ kind: 'revoke', invite });
                }}
              />
            </div>
          </>
        ) : (
          <p className="m-0 text-text-2">
            Set a password under Profile first. That turns login on, which other users need.
          </p>
        )}
      </Card>
      <Card>
        <CardHeader
          title={<ActiveCount title="API keys" count={activeKeyCount} unit="active · all users" />}
          className="mb-1.5"
        />
        <p className="mt-0 mb-[18px] text-text-2">
          Every user’s keys. You never see a key again after it is made, only its start. Revoking
          one stops that user’s plugin right away; they see “Revoked by admin”. To give someone a
          key, use Create API key in their menu above.
        </p>
        <div className="flex flex-col gap-2.5">
          <KeyList
            loginMode={loginMode}
            onRevoke={(apiKey) => {
              ask({ kind: 'revoke-key', apiKey });
            }}
          />
        </div>
      </Card>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={dialog?.title ?? ''}
        description={dialog?.description ?? ''}
        confirmLabel={dialog?.confirmLabel ?? ''}
        pendingLabel={dialog?.pendingLabel ?? ''}
        destructive={dialog?.destructive ?? false}
        pending={dialog?.busy ?? false}
        error={dialog?.error}
        confirmDisabled={dialog?.disabled ?? false}
        onConfirm={() => dialog?.run()}
        focusOnClose={() => {
          if (!focusNewKey.current) return null;
          focusNewKey.current = false;
          return document.getElementById(USER_KEY_HEADING_ID);
        }}
        secondary={dialog?.secondary}
      >
        {dialog?.fields}
      </ConfirmDialog>
    </SettingsLayout>
  );
}
