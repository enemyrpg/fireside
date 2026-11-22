import type { AuthMeResponse } from '@fireside/shared';
import { UserIcon } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { useAuthMe, useChangePassword, useLogout } from '@/api/auth';
import { fieldErrors } from '@/api/errors';
import { Card, CardHeader } from '@/components/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// Settings → Profile: who is logged in, the password, logging out.

/** The user card at the top of Profile. */
export function UserCard() {
  const me = useAuthMe().data;
  const logout = useLogout();
  const [confirmAll, setConfirmAll] = useState(false);
  const loginMode = me?.mode === 'login';

  return (
    <Card>
      <CardHeader title="You" />
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-10 place-items-center rounded-full bg-raised text-accent-text">
          <UserIcon aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{me?.user?.username ?? 'Owner'}</div>
          <div className="text-xs text-text-3">
            {loginMode
              ? `Logged in${me.user ? ` · ${me.user.role === 'admin' ? 'admin' : 'member'}` : '.'}`
              : 'No login: the dashboard only answers on this PC. Set a password below to turn login on.'}
          </div>
        </div>
        {loginMode && (
          <div className="flex w-full gap-2 desk:w-auto">
            <Button
              variant="outline"
              className="max-desk:h-11 max-desk:flex-1"
              disabled={logout.isPending}
              onClick={() => {
                logout.mutate({});
              }}
            >
              Log out
            </Button>
            <Button
              variant="outline"
              className="max-desk:h-11 max-desk:flex-1"
              onClick={() => {
                setConfirmAll(true);
              }}
            >
              Log out everywhere
            </Button>
          </div>
        )}
      </div>
      {logout.isError && !confirmAll && (
        <p role="alert" className="mt-2 mb-0 text-xs text-down">
          Couldn&apos;t log out. Try again.
        </p>
      )}
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={(open) => {
          setConfirmAll(open);
          if (!open) logout.reset();
        }}
        title="Log out everywhere?"
        description="Every browser and phone logged in as you is logged out, this one too."
        confirmLabel="Log out everywhere"
        pendingLabel="Logging out…"
        pending={logout.isPending}
        error={logout.isError ? "Couldn't log out. Try again." : undefined}
        onConfirm={() => {
          logout.mutate({ everywhere: true });
        }}
      />
    </Card>
  );
}

function PasswordForm({ me }: { me: AuthMeResponse }) {
  const firstPassword = me.mode === 'local';
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [done, setDone] = useState(false);
  const change = useChangePassword();

  const errors = fieldErrors(change.error);
  const general =
    change.isError && errors.currentPassword === undefined && errors.newPassword === undefined
      ? "Couldn't change the password. Try again."
      : undefined;

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (change.isPending) return;
    if (next !== repeat) {
      setMismatch(true);
      return;
    }
    change.mutate(
      firstPassword ? { newPassword: next } : { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          setCurrent('');
          setNext('');
          setRepeat('');
          setDone(true);
        },
      },
    );
  };

  const edited = () => {
    setDone(false);
    setMismatch(false);
    if (change.isError) change.reset();
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {/* Lets password managers save the new password for the right account. */}
      <input type="text" hidden readOnly autoComplete="username" value={me.user?.username ?? ''} />
      {!firstPassword && (
        <FormField label="Current password" error={errors.currentPassword}>
          {(control) => (
            <Input
              {...control}
              type="password"
              value={current}
              autoComplete="current-password"
              className="bg-page"
              onChange={(event) => {
                setCurrent(event.target.value);
                edited();
              }}
            />
          )}
        </FormField>
      )}
      <FormField
        label="New password"
        error={errors.newPassword}
        help="At least 12 characters. A few words in a row is easy to remember."
      >
        {(control) => (
          <Input
            {...control}
            type="password"
            value={next}
            autoComplete="new-password"
            className="bg-page"
            onChange={(event) => {
              setNext(event.target.value);
              edited();
            }}
          />
        )}
      </FormField>
      <FormField
        label="Repeat new password"
        error={mismatch ? "The passwords don't match." : undefined}
      >
        {(control) => (
          <Input
            {...control}
            type="password"
            value={repeat}
            autoComplete="new-password"
            className="bg-page"
            onChange={(event) => {
              setRepeat(event.target.value);
              edited();
            }}
          />
        )}
      </FormField>
      {general !== undefined && (
        <p role="alert" className="m-0 text-xs text-down">
          {general}
        </p>
      )}
      {done && (
        <p role="status" className="m-0 text-xs text-text-2">
          Password changed. Other browsers and phones were logged out.
        </p>
      )}
      <Button type="submit" disabled={change.isPending} className="desk:self-start">
        {change.isPending
          ? 'Saving…'
          : firstPassword
            ? 'Set password and turn on login'
            : 'Change password'}
      </Button>
    </form>
  );
}

/** "Set a password" in local mode, "Change password" in login mode. */
export function PasswordCard() {
  const me = useAuthMe().data;
  if (!me) return null;
  return (
    <Card>
      <CardHeader title={me.mode === 'local' ? 'Set a password' : 'Password'} />
      {me.mode === 'local' && (
        <p className="mt-0 mb-4 text-xs text-text-2">
          With a password, the dashboard asks you to log in, also on this PC. Until access control
          is in place, it still only answers on this PC.
        </p>
      )}
      <PasswordForm me={me} />
    </Card>
  );
}
