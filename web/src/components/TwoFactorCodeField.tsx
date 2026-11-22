import type { ReactNode, Ref } from 'react';
import { CodeField, type CodeFieldHandle } from '@/components/CodeField';
import { FormField } from '@/components/FormField';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// A form's two-factor code: the six boxes for a code from the app. Where the
// server also takes a recovery code, the link "Use a recovery code instead"
// switches to one text field. Never sends by itself: only the login step does
// that (`LoginPage`).

export function TwoFactorCodeField({
  label,
  value,
  onChange,
  error,
  help,
  recovery,
  onRecoveryChange,
  codeRef,
  autoFocus = false,
  inputClassName,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  help?: ReactNode;
  /** Recovery mode (one text field). Leave out where only an app code works. */
  recovery?: boolean;
  onRecoveryChange?: (recovery: boolean) => void;
  codeRef?: Ref<CodeFieldHandle>;
  autoFocus?: boolean;
  /** Extra classes for the recovery code's text field. */
  inputClassName?: string;
}) {
  const canSwitch = onRecoveryChange !== undefined;
  return (
    <div className="flex flex-col gap-2">
      {recovery === true ? (
        <FormField label="Recovery code" error={error} help={help}>
          {(control) => (
            <Input
              {...control}
              value={value}
              autoFocus
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="xxxxx-xxxxx"
              className={cn('bg-page font-mono', inputClassName)}
              onChange={(event) => {
                onChange(event.target.value);
              }}
            />
          )}
        </FormField>
      ) : (
        <FormField label={label} error={error} help={help} group>
          {(control, { labelId }) => (
            <CodeField
              {...(codeRef === undefined ? {} : { ref: codeRef })}
              value={value}
              onChange={onChange}
              labelledBy={labelId}
              describedBy={control['aria-describedby']}
              invalid={control['aria-invalid']}
              autoFocus={autoFocus}
            />
          )}
        </FormField>
      )}
      {canSwitch && (
        <button
          type="button"
          className="self-start text-table text-accent-text hover:underline"
          onClick={() => {
            onChange('');
            onRecoveryChange(recovery !== true);
          }}
        >
          {recovery === true ? 'Use the code from your app instead' : 'Use a recovery code instead'}
        </button>
      )}
    </div>
  );
}
