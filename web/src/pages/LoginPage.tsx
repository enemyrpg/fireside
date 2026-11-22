import { useRef, useState, type SyntheticEvent } from 'react';
import {
  codeErrorMessage,
  loginErrorMessage,
  loginTimedOut,
  useLogin,
  useLoginCode,
} from '@/api/auth';
import { AUTH_INPUT, AuthFrame, PasswordWarning } from '@/components/AuthFrame';
import { CodeField, type CodeFieldHandle } from '@/components/CodeField';
import { codeReady } from '@/lib/code';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { loginCodeRejected } from '@/lib/code-errors';
import { ABOUT_PATH } from '@/pages/settings/paths';

// Login page: one card in the middle of the page, no sidebar, the footer with the
// disclaimer. Shown by the auth gate in login mode when nobody is logged in. With 2FA
// on, a correct password leads to a second step that asks for a code: six boxes that
// send the code by themselves (only here), or one field for a recovery code.

/** The second step: a code from the app, or a recovery code. */
function CodeStep({ onRestart }: { onRestart: (message: string) => void }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const verify = useLoginCode();
  const boxes = useRef<CodeFieldHandle>(null);
  const ready = codeReady(code, recovery);

  const send = (value: string) => {
    if (verify.isPending) return;
    verify.mutate(value, {
      onError: (error) => {
        if (loginTimedOut(error)) {
          onRestart(codeErrorMessage(error));
          return;
        }
        // Only a wrong code clears the field; after a wait or a network
        // error the code stays for another try with the button.
        if (loginCodeRejected(error)) {
          setCode('');
          boxes.current?.focusFirst();
        }
      },
    });
  };
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (ready) send(code);
  };

  const message = verify.isError ? codeErrorMessage(verify.error) : undefined;

  return (
    <>
      <p className="-mt-2 mb-0 text-table text-text-2">
        {recovery
          ? 'Enter one of the recovery codes you saved when you turned on two-factor authentication. Each code works once.'
          : 'Enter the 6-digit code from your authenticator app.'}
      </p>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {recovery ? (
          <FormField label="Recovery code">
            {(control) => (
              <Input
                {...control}
                value={code}
                autoFocus
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="xxxxx-xxxxx"
                className={`${AUTH_INPUT} font-mono`}
                onChange={(event) => {
                  setCode(event.target.value);
                  if (verify.isError) verify.reset();
                }}
              />
            )}
          </FormField>
        ) : (
          <FormField label="Code" group>
            {(control, { labelId }) => (
              <CodeField
                ref={boxes}
                size="login"
                value={code}
                autoFocus
                labelledBy={labelId}
                describedBy={control['aria-describedby']}
                invalid={verify.isError && loginCodeRejected(verify.error)}
                pending={verify.isPending}
                onComplete={send}
                onChange={(value) => {
                  setCode(value);
                  if (verify.isError) verify.reset();
                }}
              />
            )}
          </FormField>
        )}
        {/* Says that the code went off by itself, without pressing the button. */}
        <span role="status" className="-mt-2 min-h-[18px] text-xs text-text-3">
          {verify.isPending ? 'Code entered, logging in…' : ''}
        </span>
        {message !== undefined && (
          <p role="alert" className="m-0 text-sm text-down">
            {message}
          </p>
        )}
        <Button type="submit" className="h-11" disabled={verify.isPending || !ready}>
          {verify.isPending ? 'Checking…' : 'Log in'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={() => {
            setRecovery(!recovery);
            setCode('');
            verify.reset();
          }}
        >
          {recovery ? 'Use the code from your app' : 'Use a recovery code'}
        </Button>
      </form>
    </>
  );
}

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const login = useLogin();

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (login.isPending) return;
    setNotice(undefined);
    login.mutate(
      { username, password },
      {
        onSuccess: (result) => {
          setPassword('');
          if (result.step === 'code') setNeedsCode(true);
        },
        onError: () => {
          setPassword('');
        },
      },
    );
  };

  const message = login.isError ? loginErrorMessage(login.error) : notice;

  return (
    <AuthFrame title={needsCode ? 'Two-factor authentication' : 'Log in'}>
      {needsCode ? (
        <CodeStep
          onRestart={(text) => {
            setNeedsCode(false);
            login.reset();
            setNotice(text);
          }}
        />
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <FormField label="Username">
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
                }}
              />
            )}
          </FormField>
          <FormField label="Password">
            {(control) => (
              <Input
                {...control}
                type="password"
                value={password}
                autoComplete="current-password"
                className={AUTH_INPUT}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            )}
          </FormField>
          {message !== undefined && (
            <p role="alert" className="m-0 text-sm text-down">
              {message}
            </p>
          )}
          <Button type="submit" className="h-11" disabled={login.isPending}>
            {login.isPending ? 'Logging in…' : 'Log in'}
          </Button>
        </form>
      )}
      <PasswordWarning />
      <AboutLink />
    </AuthFrame>
  );
}

/**
 * The link to the instance text: who runs this server and what it stores,
 * before anyone types a password. The text itself is on `/about`.
 */
function AboutLink() {
  return (
    <div className="border-t border-hover pt-3.5 text-xs">
      {/* A full page load: the auth gate reads the path once. */}
      <a href={ABOUT_PATH}>About this instance and privacy</a>
    </div>
  );
}
