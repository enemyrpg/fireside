import { useId, type ReactNode } from 'react';
import { Label } from '@/components/ui/label';

export interface FieldControlProps {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
}

/**
 * A labelled form field with help text and an error message under it. The error
 * replaces nothing: it shows above the help.
 */
export function FormField({
  label,
  optional = false,
  help,
  error,
  group = false,
  children,
}: {
  label: string;
  /** Adds "(optional)" after the label. */
  optional?: boolean;
  help?: ReactNode;
  error?: string | undefined;
  /**
   * The control is a group of inputs (`CodeField`): the label names it with
   * `aria-labelledby` and points at no single input.
   */
  group?: boolean;
  /**
   * The control; spread the props on it. A control that isn't one input (the
   * six-box `CodeField`) names itself with `labelId` instead.
   */
  children: (control: FieldControlProps, label: { labelId: string }) => ReactNode;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const labelId = `${id}-label`;
  const describedBy =
    [error !== undefined && errorId, help !== undefined && helpId].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <Label
        id={labelId}
        htmlFor={group ? undefined : id}
        className="gap-1 text-xs font-normal text-text-2"
      >
        {label}
        {optional && <span className="text-text-3">(optional)</span>}
      </Label>
      {children(
        { id, 'aria-invalid': error !== undefined, 'aria-describedby': describedBy },
        { labelId },
      )}
      {error !== undefined && (
        <p id={errorId} className="m-0 text-xs text-down">
          {error}
        </p>
      )}
      {help !== undefined && (
        <p id={helpId} className="m-0 text-xs text-text-3">
          {help}
        </p>
      )}
    </div>
  );
}
