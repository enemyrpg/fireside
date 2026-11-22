import { BRANDING, type InviteLookupResponse } from '@fireside/shared';
import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { fieldErrors } from '@/api/errors';
import {
  formErrorMessage,
  INVALID_LINK_MESSAGE,
  isInvalidLink,
  useAcceptInvite,
  useInviteLookup,
  usePasswordReset,
} from '@/api/users';
import { AUTH_INPUT, AuthFrame, PasswordWarning } from '@/components/AuthFrame';
import { type CodeFieldHandle } from '@/components/CodeField';
import { FormField } from '@/components/FormField';
import { CardSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { TwoFactorCodeField } from '@/components/TwoFactorCodeField';
import { codeReady } from '@/lib/code';
import { Input } from '@/components/ui/input';
import { codeFieldRejected } from '@/lib/code-errors';
import { linkNavigation } from '@/lib/invites';
import { RESET_PASSWORD_PATH } from './settings/paths';

// The pages an invite link and a password reset link open: `/invite#<token>`
// and `/reset-password#<token>`. The token is in the fragment, which the
// browser never sends to the server; it is read once, removed from the address
// bar and history, and posted in a JSON body. Same frame as the login page,
// outside the app shell.

/** Reads the token from the fragment once, then removes it from the address bar and history. */
function useFragmentToken(): string {
  const [token] = useState(() => {
    try {
      return decodeURIComponent(window.location.hash.slice(1));
    } catch {
      // A malformed `%` sequence: not a token of ours.
      return '';
    }
  });
  useEffect(() => {
    if (window.location.hash !== '') {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  }, []);
  return token;
}

/** Asks the browser not to send this page's address on to anything it loads. */
function useNoReferrer(): void {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => {
      meta.remove();
    };
  }, []);
}

/** The login page's frame, with the Jagex warning under the form. */
function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <AuthFrame title={title}>
      {children}
      <PasswordWarning />
    </AuthFrame>
  );
}

function PasswordFields({
  password,
  repeat,
  error,
  mismatch,
  onPassword,
  onRepeat,
}: {
  password: string;
  repeat: string;
  error: string | undefined;
  mismatch: boolean;
  onPassword: (value: string) => void;
  onRepeat: (value: string) => void;
}) {
  return (
    <>
      <FormField
        label="Password"
        error={error}
        help="At least 12 characters. A few words in a row is easy to remember."
      >
        {(control) => (
          <Input
            {...control}
            type="password"
            value={password}
            autoComplete="new-password"
            className={AUTH_INPUT}
            onChange={(event) => {
              onPassword(event.target.value);
            }}
          />
        )}
      </FormField>
      <FormField
        label="Repeat password"
        error={mismatch ? "The passwords don't match." : undefined}
      >
        {(control) => (
          <Input
            {...control}
            type="password"
            value={repeat}
            autoComplete="new-password"
            className={AUTH_INPUT}
            onChange={(event) => {
              onRepeat(event.target.value);
            }}
          />
        )}
      </FormField>
    </>
  );
}

/** Logged in as the new or reset user: start the app fresh, without the old state. */
function enterApp() {
  linkNavigation.enterApp();
}

function AcceptForm({ token, onInvalid }: { token: string; onInvalid: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const accept = useAcceptInvite();
  const errors = fieldErrors(accept.error);
  const general =
    accept.isError && errors.username === undefined && errors.password === undefined
      ? formErrorMessage(accept.error, "Couldn't create your account. Try again.")
      : undefined;

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (accept.isPending) return;
    if (password !== repeat) {
      setMismatch(true);
      return;
    }
    accept.mutate(
      { token, username, password },
      {
        onSuccess: enterApp,
        onError: (error) => {
          if (isInvalidLink(error)) onInvalid();
        },
      },
    );
  };
  const edited = () => {
    setMismatch(false);
    if (accept.isError) accept.reset();
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <p className="m-0 text-table text-text-2">
        You&apos;ve been invited to this {BRANDING.displayName} server. Choose a username and a
        password to log in with.
      </p>
      <FormField
        label="Username"
        error={errors.username}
        help="3–32 characters: letters a–z, digits, dot, dash and underscore."
      >
        {(control) => (
          <Input
            {...control}
            value={username}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            className={AUTH_INPUT}
            onChange={(event) => {
              setUsername(event.target.value);
              edited();
            }}
          />
        )}
      </FormField>
      <PasswordFields
        password={password}
        repeat={repeat}
        error={errors.password}
        mismatch={mismatch}
        onPassword={(value) => {
          setPassword(value);
          edited();
        }}
        onRepeat={(value) => {
          setRepeat(value);
          edited();
        }}
      />
      {general !== undefined && (
        <p role="alert" className="m-0 text-sm text-down">
          {general}
        </p>
      )}
      <Button type="submit" className="h-11" disabled={accept.isPending}>
        {accept.isPending ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  );
}

function ResetForm({
  token,
  username,
  twoFactorRequired,
  onInvalid,
}: {
  token: string;
  username: string;
  /** The user has 2FA on: a code is needed too. */
  twoFactorRequired: boolean;
  onInvalid: () => void;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const boxes = useRef<CodeFieldHandle>(null);
  const [repeat, setRepeat] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const reset = usePasswordReset();
  const errors = fieldErrors(reset.error);
  const general =
    reset.isError && errors.password === undefined && errors.code === undefined
      ? formErrorMessage(reset.error, "Couldn't set the password. Try again.")
      : undefined;

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reset.isPending) return;
    if (password !== repeat) {
      setMismatch(true);
      return;
    }
    reset.mutate(twoFactorRequired ? { token, password, code } : { token, password }, {
      onSuccess: enterApp,
      onError: (error) => {
        if (isInvalidLink(error)) onInvalid();
        // Only a refused code clears the code; a wait or a network error keeps it.
        else if (codeFieldRejected(error)) {
          setCode('');
          boxes.current?.focusFirst();
        }
      },
    });
  };
  const edited = () => {
    setMismatch(false);
    if (reset.isError) reset.reset();
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <p className="m-0 text-table text-text-2">
        New password for <b className="text-text">{username}</b>. You&apos;ll be logged out
        everywhere else.
      </p>
      {/* Lets password managers save the new password for the right account. */}
      <input type="text" hidden readOnly autoComplete="username" value={username} />
      <PasswordFields
        password={password}
        repeat={repeat}
        error={errors.password}
        mismatch={mismatch}
        onPassword={(value) => {
          setPassword(value);
          edited();
        }}
        onRepeat={(value) => {
          setRepeat(value);
          edited();
        }}
      />
      {twoFactorRequired && (
        <TwoFactorCodeField
          label="Two-factor code"
          value={code}
          error={errors.code}
          help="Two-factor authentication stays on."
          recovery={recovery}
          onRecoveryChange={setRecovery}
          codeRef={boxes}
          inputClassName="h-11"
          onChange={(value) => {
            setCode(value);
            edited();
          }}
        />
      )}
      {general !== undefined && (
        <p role="alert" className="m-0 text-sm text-down">
          {general}
        </p>
      )}
      <Button
        type="submit"
        className="h-11"
        disabled={reset.isPending || (twoFactorRequired && !codeReady(code, recovery))}
      >
        {reset.isPending ? 'Saving…' : 'Set password and log in'}
      </Button>
    </form>
  );
}

type View =
  | { state: 'checking' }
  | { state: 'invalid' }
  | { state: 'error' }
  | { state: 'ready'; link: InviteLookupResponse };

export function InvitePage() {
  useNoReferrer();
  const token = useFragmentToken();
  const resetPage = window.location.pathname.replace(/\/+$/, '') === RESET_PASSWORD_PATH;
  const lookup = useInviteLookup();
  const [invalid, setInvalid] = useState(token === '');

  // Once per page: a mutation, so it never runs again on focus or remount.
  const { mutate } = lookup;
  useEffect(() => {
    if (token !== '') mutate(token);
  }, [token, mutate]);

  let view: View;
  if (invalid || (lookup.isError && isInvalidLink(lookup.error))) view = { state: 'invalid' };
  else if (lookup.isError) view = { state: 'error' };
  else if (lookup.data) view = { state: 'ready', link: lookup.data };
  else view = { state: 'checking' };
  // A link of the other kind on this page counts as not valid here.
  if (view.state === 'ready' && (view.link.type === 'password_reset') !== resetPage) {
    view = { state: 'invalid' };
  }

  const markInvalid = () => {
    setInvalid(true);
  };

  if (view.state === 'invalid') {
    return (
      <Frame title={INVALID_LINK_MESSAGE}>
        <p className="m-0 text-sm text-text-2">
          Links work once, for a limited time. Ask the person who runs this server for a new link.
        </p>
      </Frame>
    );
  }
  if (view.state === 'error') {
    return (
      <Frame title={resetPage ? 'Reset your password' : 'Create your account'}>
        <p role="alert" className="m-0 text-sm text-down">
          {formErrorMessage(lookup.error, "Couldn't check the link. Reload the page to try again.")}
        </p>
      </Frame>
    );
  }
  if (view.state === 'checking') {
    return (
      <Frame title={resetPage ? 'Reset your password' : 'Create your account'}>
        <CardSkeleton lines={3} />
      </Frame>
    );
  }
  if (view.link.type === 'password_reset') {
    return (
      <Frame title="Reset your password">
        <ResetForm
          token={token}
          username={view.link.username}
          twoFactorRequired={view.link.twoFactorRequired}
          onInvalid={markInvalid}
        />
      </Frame>
    );
  }
  return (
    <Frame title="Create your account">
      <AcceptForm token={token} onInvalid={markInvalid} />
    </Frame>
  );
}
