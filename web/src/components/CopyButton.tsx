import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

type CopyState = 'idle' | 'copied' | 'failed';

/** How long "Copied" / "Copy failed" shows before the button goes back to "Copy". */
export const COPY_FEEDBACK_MS = 2_000;

/**
 * Copies `value` to the clipboard and says whether it worked. `look`: `filled`
 * (default) where copying is the one thing to do (a new API key); `neutral` next
 * to other actions (two-factor key and recovery codes).
 */
export function CopyButton({
  value,
  label = 'Copy',
  look = 'filled',
}: {
  value: string;
  label?: string;
  look?: 'filled' | 'neutral';
}) {
  const [state, setState] = useState<CopyState>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => {
      setState('idle');
    }, COPY_FEEDBACK_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [state]);

  const copy = async () => {
    try {
      // Missing outside a secure context; localhost counts as secure.
      if (!(navigator.clipboard as Clipboard | undefined)) throw new Error('No clipboard');
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <Button
      type="button"
      variant={look === 'neutral' ? 'ghost' : 'default'}
      onClick={() => {
        void copy();
      }}
    >
      {state === 'copied' ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      <span aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
      </span>
    </Button>
  );
}
