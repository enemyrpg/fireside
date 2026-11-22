import { useId } from 'react';
import { Switch as SwitchControl } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

export interface SwitchProps {
  /** Shown to the right of the switch, and its accessible name. */
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/** On/off switch with its label to the right, e.g. "Placeholders". */
export function Switch({ label, checked, onChange, disabled, className }: SwitchProps) {
  const id = useId();
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm text-text', className)}>
      <SwitchControl
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        {...(disabled ? { disabled: true } : {})}
      />
      <label htmlFor={id} className={disabled ? undefined : 'cursor-pointer'}>
        {label}
      </label>
    </span>
  );
}
