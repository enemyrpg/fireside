import { useState } from 'react';
import { useAuthMe, useIsAdmin } from '@/api/auth';
import { formErrorMessage, useDeleteAccount, useUsers } from '@/api/users';
import { Card, CardHeader } from '@/components/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// Settings → Profile: "Delete my account". The user deletes themselves and all
// their data after typing their password. Login mode only. The last admin can't
// (the server refuses with `409`), so an admin who is the only active one sees
// why instead of the button.

/** True when the logged-in admin is the only active admin. Members never ask `/users`. */
function useIsLastAdmin(): boolean {
  const isAdmin = useIsAdmin();
  const users = useUsers(isAdmin).data?.users;
  if (!isAdmin || !users) return false;
  return users.filter((user) => user.role === 'admin' && user.disabledAt === null).length <= 1;
}

export function DeleteAccountCard() {
  const me = useAuthMe().data;
  const lastAdmin = useIsLastAdmin();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const remove = useDeleteAccount();
  if (me?.mode !== 'login') return null;

  return (
    <Card>
      <CardHeader title="Delete my account" />
      {lastAdmin ? (
        <p className="m-0 text-xs text-text-2">
          You&apos;re the only admin, so you can&apos;t delete your account. Make another user an
          admin under Users first.
        </p>
      ) : (
        <>
          <p className="mt-0 mb-4 text-xs text-text-2">
            Deletes your login and all your data on this server: OSRS accounts, sessions, loot,
            bank, everything the plugin sent, your API keys and settings. Backups keep a copy until
            they rotate out.
          </p>
          <Button
            variant="destructive"
            className="desk:self-start"
            onClick={() => {
              setPassword('');
              remove.reset();
              setOpen(true);
            }}
          >
            Delete my account
          </Button>
        </>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete your account and all your data?"
        description="This can't be undone. Type your password to confirm."
        confirmLabel="Delete my account"
        pendingLabel="Deleting…"
        destructive
        pending={remove.isPending}
        confirmDisabled={password === ''}
        error={formErrorMessage(remove.error, "Couldn't delete your account. Try again.")}
        onConfirm={() => {
          remove.mutate(password, {
            onSuccess: () => {
              setOpen(false);
            },
          });
        }}
      >
        <FormField label="Password">
          {(control) => (
            <Input
              {...control}
              type="password"
              value={password}
              autoComplete="current-password"
              className="bg-page"
              onChange={(event) => {
                setPassword(event.target.value);
                if (remove.isError) remove.reset();
              }}
            />
          )}
        </FormField>
      </ConfirmDialog>
    </Card>
  );
}
