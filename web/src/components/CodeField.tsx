import {
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { CODE_LENGTH, insertedText, isCompleteCode } from '@/lib/code';
import { cn } from '@/lib/utils';

// The six-box code field for two-factor: one box per digit. A digit moves to
// the next box, Backspace in an empty box goes back and clears the previous
// one, the arrow keys move, and a pasted or autofilled code fills the boxes
// from the current one. Only the first box has `autocomplete="one-time-code"`,
// so the phone's code suggestion lands there; the boxes have no `maxlength` so
// a whole code can arrive in one box.

/** The value as six boxes, `''` for an empty box. */
function toBoxes(value: string): string[] {
  return Array.from({ length: CODE_LENGTH }, (_, index) => {
    const char = value.charAt(index);
    return /\d/.test(char) ? char : '';
  });
}

/** Six boxes back to the value: a space for an empty box, trailing gaps dropped. */
function fromBoxes(boxes: string[]): string {
  return boxes
    .map((box) => (box === '' ? ' ' : box))
    .join('')
    .trimEnd();
}

export interface CodeFieldHandle {
  /** Puts focus in the first box (after a wrong code cleared the field). */
  focusFirst: () => void;
}

export interface CodeFieldProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Sends the code by itself when the sixth digit is typed. Only the login
   * step uses this. Fires once per complete code: not while `pending`, and not
   * again for the same six digits until the user changes one (the field being
   * cleared from code doesn't count).
   */
  onComplete?: (code: string) => void;
  /** A request with this field's code is on its way. */
  pending?: boolean;
  /** Id of the visible label, which names the group. */
  labelledBy: string;
  describedBy?: string | undefined;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** `login`: 56 px boxes filling the card. `default`: 52 px boxes, at most 340 px wide. */
  size?: 'login' | 'default';
  ref?: Ref<CodeFieldHandle>;
}

export function CodeField({
  value,
  onChange,
  onComplete,
  pending = false,
  labelledBy,
  describedBy,
  invalid = false,
  disabled = false,
  autoFocus = false,
  size = 'default',
  ref,
}: CodeFieldProps) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  /**
   * Each box's selection just before its last edit (from the native
   * `beforeinput` event), so an edit can be split into what was there and
   * what was inserted, wherever the caret was.
   */
  const selections = useRef<({ start: number; end: number } | undefined)[]>([]);
  /**
   * The last code sent by itself. Released by the user's own edit to other
   * digits; clearing the field from code (after a wrong code) doesn't count.
   */
  const lastSent = useRef<string | undefined>(undefined);
  const boxes = toBoxes(value);

  useImperativeHandle(ref, () => ({
    focusFirst: () => {
      inputs.current[0]?.focus();
    },
  }));

  const focusBox = (index: number) => {
    const input = inputs.current[Math.max(0, Math.min(index, CODE_LENGTH - 1))];
    input?.focus();
    input?.select();
  };

  /** A user edit: report it, then send the code if it just became complete. */
  const commit = (next: string[]) => {
    const nextValue = fromBoxes(next);
    if (nextValue === value) return;
    onChange(nextValue);
    // Same six digits as the last code sent by itself: wait for a change.
    if (nextValue === lastSent.current) return;
    lastSent.current = undefined;
    if (onComplete !== undefined && !pending && isCompleteCode(nextValue)) {
      lastSent.current = nextValue;
      onComplete(nextValue);
    }
  };

  /** Puts digits into the boxes from `start` on, and moves focus after the last one. */
  const fill = (start: number, digits: string) => {
    const next = [...boxes];
    const used = digits.slice(0, CODE_LENGTH - start);
    for (let offset = 0; offset < used.length; offset += 1) {
      next[start + offset] = used.charAt(offset);
    }
    commit(next);
    focusBox(start + used.length);
  };

  const handleInput = (index: number, raw: string) => {
    const old = boxes[index] ?? '';
    const inserted = insertedText(old, raw, selections.current[index]);
    selections.current[index] = undefined;
    if (raw === '') {
      // Deleted.
      if (old !== '') {
        const next = [...boxes];
        next[index] = '';
        commit(next);
      }
      return;
    }
    const digits = inserted.replace(/\D/g, '');
    // Only non-digits typed: the box keeps its digit.
    if (digits === '') return;
    // A whole code (autofill, or a paste the browser didn't hand to onPaste)
    // fills from box 1, whichever box it went into.
    fill(digits.length >= CODE_LENGTH ? 0 : index, digits);
  };

  const handlePaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    const digits = event.clipboardData.getData('text').replace(/\D/g, '');
    event.preventDefault();
    if (digits === '') return;
    fill(digits.length >= CODE_LENGTH ? 0 : index, digits);
  };

  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && boxes[index] === '' && index > 0) {
      event.preventDefault();
      const next = [...boxes];
      next[index - 1] = '';
      commit(next);
      focusBox(index - 1);
    } else if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      focusBox(index - 1);
    } else if (event.key === 'ArrowRight' && index < CODE_LENGTH - 1) {
      event.preventDefault();
      focusBox(index + 1);
    }
  };

  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={cn('grid w-full grid-cols-6 gap-2', size === 'default' && 'max-w-[340px]')}
    >
      {boxes.map((box, index) => (
        <input
          // The boxes never move: the index is the box.
          key={index}
          ref={(element) => {
            inputs.current[index] = element;
            if (element === null) return;
            // The selection before the edit; React has no event with it.
            const remember = () => {
              selections.current[index] = {
                start: element.selectionStart ?? 0,
                end: element.selectionEnd ?? element.value.length,
              };
            };
            element.addEventListener('beforeinput', remember);
            return () => {
              element.removeEventListener('beforeinput', remember);
            };
          }}
          type="text"
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          aria-label={`Digit ${String(index + 1)} of ${String(CODE_LENGTH)}`}
          aria-invalid={invalid}
          autoFocus={autoFocus && index === 0}
          disabled={disabled}
          value={box}
          className={cn(
            'w-full min-w-0 rounded-[10px] border border-border-strong bg-page p-0 text-center font-mono text-text outline-none',
            'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40',
            'aria-invalid:border-down disabled:opacity-50',
            size === 'login' ? 'h-14 text-2xl' : 'h-[52px] text-[22px]',
          )}
          onFocus={(event) => {
            event.target.select();
          }}
          onChange={(event) => {
            handleInput(index, event.target.value);
          }}
          onPaste={(event) => {
            handlePaste(index, event);
          }}
          onKeyDown={(event) => {
            handleKeyDown(index, event);
          }}
        />
      ))}
    </div>
  );
}
