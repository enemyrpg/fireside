import { BRANDING } from '@fireside/shared';
import { Suspense, useRef, useState, type Ref, type SyntheticEvent } from 'react';
import {
  useAuthMe,
  useIsAdmin,
  useNewRecoveryCodes,
  useTotpDisable,
  useTotpEnable,
  useTotpSetup,
  useTwoFactorStatus,
} from '@/api/auth';
import { fieldErrors } from '@/api/errors';
import { formErrorMessage } from '@/api/users';
import { Card, CardHeader } from '@/components/Card';
import { type CodeFieldHandle } from '@/components/CodeField';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CopyButton } from '@/components/CopyButton';
import { FormField } from '@/components/FormField';
import { TwoFactorCodeField } from '@/components/TwoFactorCodeField';
import { codeReady, isCompleteCode } from '@/lib/code';
import { lazyNamed } from '@/lib/lazy';
import { CardSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { useFormat } from '@/hooks/useFormat';
import { codeFieldRejected } from '@/lib/code-errors';

// Settings → Profile: "Two-factor authentication". Login mode only. Setup:
// password → QR code and secret → first code → recovery codes shown once. When
// on: new recovery codes and turning it off, both with password and a current
// code.

type Step =
  | { step: 'idle' }
  | { step: 'password' }
  | { step: 'scan'; secret: string; otpauthUri: string }
  | { step: 'codes'; codes: string[] };

// The QR code library is only needed here, so it loads on its own: when setup
// starts, so it is there by the time the QR code is shown.
const { Component: QrCode, load: loadQrCode } = lazyNamed(
  () => import('@/components/QrCode'),
  'QrCode',
);

/** The QR code's place while its code loads (192 px, as `QrCode`). */
function QrSkeleton() {
  const shown = useDelayedFlag(true);
  return (
    <Skeleton
      aria-busy="true"
      aria-label="Loading"
      className={cn('size-48 shrink-0', !shown && 'invisible')}
    />
  );
}

/** Saves the recovery codes as a text file, with no `data:` URI. */
function downloadCodes(codes: string[]) {
  const text = [
    `${BRANDING.displayName} recovery codes`,
    'Each code works once. Keep them somewhere safe, apart from your phone.',
    '',
    ...codes,
    '',
  ].join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${BRANDING.shortName}-recovery-codes.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** The recovery codes, shown once with Copy and Download. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <section
      aria-label="Recovery codes"
      className="flex flex-col gap-3.5 rounded-[14px] border border-accent bg-accent-wash px-6 py-[22px] max-desk:rounded-2xl max-desk:p-[18px]"
    >
      <p role="status" className="m-0 text-[15px] font-semibold">
        Save these recovery codes now. You won&apos;t see them again.
      </p>
      <ul className="m-0 grid list-none grid-cols-2 gap-x-6 gap-y-2 p-0 font-mono text-sm select-all">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <p className="m-0 text-xs text-text-2">
        Each code logs you in once if you lose your phone. Keep them somewhere safe, apart from your
        phone, like a password manager or on paper.
      </p>
      <p className="m-0 text-xs text-text-2">Other browsers and phones were logged out.</p>
      <div className="flex flex-wrap gap-2">
        <CopyButton value={codes.join('\n')} label="Copy codes" look="neutral" />
        <Button
          type="button"
          // Neutral like "Copy codes" next to it.
          variant="ghost"
          onClick={() => {
            downloadCodes(codes);
          }}
        >
          Download .txt
        </Button>
        <Button type="button" onClick={onDone}>
          I saved them
        </Button>
      </div>
    </section>
  );
}

function PasswordStep({
  onCancel,
  onReady,
}: {
  onCancel: () => void;
  onReady: (secret: string, otpauthUri: string) => void;
}) {
  const [password, setPassword] = useState('');
  const setup = useTotpSetup();
  const errors = fieldErrors(setup.error);
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (setup.isPending || password === '') return;
    setup.mutate(password, {
      onSuccess: (result) => {
        onReady(result.secret, result.otpauthUri);
      },
      onError: () => {
        setPassword('');
      },
    });
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <FormField label="Password" error={errors.password}>
        {(control) => (
          <Input
            {...control}
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            className="bg-page"
            onChange={(event) => {
              setPassword(event.target.value);
              if (setup.isError) setup.reset();
            }}
          />
        )}
      </FormField>
      {setup.isError && errors.password === undefined && (
        <p role="alert" className="m-0 text-xs text-down">
          {formErrorMessage(setup.error, "Couldn't start the setup. Try again.")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={setup.isPending || password === ''}>
          {setup.isPending ? 'Checking…' : 'Continue'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ScanStep({
  secret,
  otpauthUri,
  onCancel,
  onEnabled,
}: {
  secret: string;
  otpauthUri: string;
  onCancel: () => void;
  onEnabled: (codes: string[]) => void;
}) {
  const [code, setCode] = useState('');
  const boxes = useRef<CodeFieldHandle>(null);
  const enable = useTotpEnable();
  const errors = fieldErrors(enable.error);
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (enable.isPending || !isCompleteCode(code)) return;
    enable.mutate(code, {
      onSuccess: (result) => {
        onEnabled(result.recoveryCodes);
      },
      onError: (error) => {
        // Only a refused code clears the boxes; after a wait it stays.
        if (codeFieldRejected(error)) {
          setCode('');
          boxes.current?.focusFirst();
        }
      },
    });
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <p className="m-0 text-table text-text-2">
        Scan the code with an authenticator app on your phone (or the one in your password manager).
        Then enter the code the app shows.
      </p>
      <div className="flex flex-wrap items-center gap-5">
        <Suspense fallback={<QrSkeleton />}>
          <QrCode value={otpauthUri} label="QR code for your authenticator app" />
        </Suspense>
        <div className="flex min-w-0 flex-1 basis-[200px] flex-col gap-2.5">
          <span className="text-xs text-text-3">Or type this key into the app</span>
          <code className="font-mono text-sm leading-[1.7] break-all select-all">
            {secret.replace(/(.{4})/g, '$1 ').trim()}
          </code>
          <div>
            <CopyButton value={secret} label="Copy key" look="neutral" />
          </div>
        </div>
      </div>
      <TwoFactorCodeField
        label="Code from the app"
        value={code}
        error={errors.code}
        codeRef={boxes}
        onChange={(value) => {
          setCode(value);
          if (enable.isError) enable.reset();
        }}
      />
      {enable.isError && errors.code === undefined && (
        <p role="alert" className="m-0 text-xs text-down">
          {formErrorMessage(enable.error, "Couldn't turn on two-factor authentication. Try again.")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={enable.isPending || !isCompleteCode(code)}>
          {enable.isPending ? 'Turning on…' : 'Turn on'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Password and code, for turning 2FA off or making new recovery codes. */
function ConfirmFields({
  password,
  code,
  recovery,
  errors,
  codeRef,
  onPassword,
  onCode,
  onRecovery,
}: {
  password: string;
  code: string;
  recovery: boolean;
  errors: Partial<Record<string, string>>;
  codeRef: Ref<CodeFieldHandle>;
  onPassword: (value: string) => void;
  onCode: (value: string) => void;
  onRecovery: (recovery: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <FormField label="Password" error={errors.password}>
        {(control) => (
          <Input
            {...control}
            type="password"
            value={password}
            autoComplete="current-password"
            className="bg-page"
            onChange={(event) => {
              onPassword(event.target.value);
            }}
          />
        )}
      </FormField>
      <TwoFactorCodeField
        label="Code from the app"
        value={code}
        error={errors.code}
        recovery={recovery}
        onRecoveryChange={onRecovery}
        codeRef={codeRef}
        onChange={onCode}
      />
    </div>
  );
}

export function TwoFactorCard() {
  const me = useAuthMe().data;
  const loginMode = me?.mode === 'login';
  const isAdmin = useIsAdmin();
  const format = useFormat();
  const status = useTwoFactorStatus(loginMode);
  const [step, setStep] = useState<Step>({ step: 'idle' });
  const [dialog, setDialog] = useState<'disable' | 'codes' | undefined>();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const boxes = useRef<CodeFieldHandle>(null);
  const disable = useTotpDisable();
  const newCodes = useNewRecoveryCodes();
  if (!loginMode) return null;

  const action = dialog === 'disable' ? disable : newCodes;
  const errors = fieldErrors(action.error);
  const ask = (which: 'disable' | 'codes') => {
    disable.reset();
    newCodes.reset();
    setPassword('');
    setCode('');
    setRecovery(false);
    setDialog(which);
    setOpen(true);
  };
  const edited = () => {
    if (action.isError) action.reset();
  };

  let body;
  if (step.step === 'codes') {
    body = (
      <RecoveryCodes
        codes={step.codes}
        onDone={() => {
          setStep({ step: 'idle' });
        }}
      />
    );
  } else if (step.step === 'password') {
    body = (
      <PasswordStep
        onCancel={() => {
          setStep({ step: 'idle' });
        }}
        onReady={(secret, otpauthUri) => {
          setStep({ step: 'scan', secret, otpauthUri });
        }}
      />
    );
  } else if (step.step === 'scan') {
    body = (
      <ScanStep
        secret={step.secret}
        otpauthUri={step.otpauthUri}
        onCancel={() => {
          setStep({ step: 'idle' });
        }}
        onEnabled={(codes) => {
          setStep({ step: 'codes', codes });
        }}
      />
    );
  } else if (!status.data) {
    body = <CardSkeleton lines={2} />;
  } else if (status.data.enabled) {
    const left = status.data.recoveryCodesLeft;
    body = (
      <>
        <p className="mt-0 mb-4 text-xs text-text-2">
          On{status.data.enabledAt ? ` since ${format.dateTime(status.data.enabledAt)}` : ''}.
          Logging in asks for a code from your app after the password.{' '}
          {left === 1 ? '1 recovery code left.' : `${String(left)} recovery codes left.`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              ask('codes');
            }}
          >
            New recovery codes
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              ask('disable');
            }}
          >
            Turn off
          </Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p className="mt-0 mb-4 text-xs text-text-2">
          Off. With two-factor authentication, logging in also needs a code from an authenticator
          app on your phone, so a stolen password alone isn&apos;t enough.
        </p>
        {isAdmin && (
          <p className="mt-0 mb-4 text-xs font-medium text-text">
            Strongly recommended for admins.
          </p>
        )}
        <Button
          className="desk:self-start"
          onClick={() => {
            // A failed load shows up when the QR code renders.
            loadQrCode().catch(() => undefined);
            setStep({ step: 'password' });
          }}
        >
          Set up two-factor authentication
        </Button>
      </>
    );
  }

  return (
    <Card>
      <CardHeader title="Two-factor authentication" />
      {body}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={
          dialog === 'disable' ? 'Turn off two-factor authentication?' : 'Make new recovery codes?'
        }
        description={
          dialog === 'disable'
            ? 'Logging in then only needs your password. Your recovery codes stop working.'
            : 'Your old recovery codes stop working, and other browsers and phones are logged out. Type your password and a code to confirm.'
        }
        confirmLabel={dialog === 'disable' ? 'Turn off' : 'Make new codes'}
        pendingLabel={dialog === 'disable' ? 'Turning off…' : 'Making codes…'}
        destructive={dialog === 'disable'}
        pending={action.isPending}
        confirmDisabled={password === '' || !codeReady(code, recovery)}
        error={
          action.isError && errors.password === undefined && errors.code === undefined
            ? formErrorMessage(action.error, "Couldn't save. Try again.")
            : undefined
        }
        onConfirm={() => {
          const body = { password, code };
          // Only a refused code clears the code; a wrong password or a wait keeps it.
          const onError = (error: unknown) => {
            if (codeFieldRejected(error)) {
              setCode('');
              boxes.current?.focusFirst();
            }
          };
          if (dialog === 'disable') {
            disable.mutate(body, {
              onSuccess: () => {
                setOpen(false);
              },
              onError,
            });
          } else {
            newCodes.mutate(body, {
              onSuccess: (result) => {
                setOpen(false);
                setStep({ step: 'codes', codes: result.recoveryCodes });
              },
              onError,
            });
          }
        }}
      >
        <ConfirmFields
          password={password}
          code={code}
          recovery={recovery}
          errors={errors}
          codeRef={boxes}
          onPassword={(value) => {
            setPassword(value);
            edited();
          }}
          onCode={(value) => {
            setCode(value);
            edited();
          }}
          onRecovery={(value) => {
            setRecovery(value);
            edited();
          }}
        />
      </ConfirmDialog>
    </Card>
  );
}
