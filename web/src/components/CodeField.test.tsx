import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { insertedText, isCompleteCode } from '@/lib/code';
import { CodeField, type CodeFieldHandle } from './CodeField';

// The six-box code field.

function Harness({
  onComplete,
  pending = false,
  initial = '',
}: {
  onComplete?: (code: string) => void;
  pending?: boolean;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<CodeFieldHandle>(null);
  return (
    <>
      <span id="label">Code</span>
      <CodeField
        ref={ref}
        value={value}
        onChange={setValue}
        labelledBy="label"
        pending={pending}
        {...(onComplete === undefined ? {} : { onComplete })}
      />
      <output data-testid="value">{value}</output>
      <button
        type="button"
        onClick={() => {
          // What a page does after a wrong code: clear from code, focus box 1.
          setValue('');
          ref.current?.focusFirst();
        }}
      >
        Reject
      </button>
    </>
  );
}

/**
 * What a phone's code suggestion or a browser paste does to one box: a
 * `beforeinput` with the caret where it is, then the box's new value.
 */
function insertAt(input: HTMLElement, caret: number, inserted: string) {
  const element = input as HTMLInputElement;
  element.focus();
  element.setSelectionRange(caret, caret);
  element.dispatchEvent(
    new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: inserted,
      inputType: 'insertText',
    }),
  );
  const old = element.value;
  fireEvent.change(element, {
    target: { value: old.slice(0, caret) + inserted + old.slice(caret) },
  });
}

const box = (n: number) => screen.getByRole('textbox', { name: `Digit ${String(n)} of 6` });
const value = () => screen.getByTestId('value').textContent;

describe('CodeField', () => {
  it('is a group named by its label, with six labelled boxes', () => {
    render(<Harness />);
    const group = screen.getByRole('group', { name: 'Code' });
    expect(group).toBeTruthy();
    expect(screen.getAllByRole('textbox')).toHaveLength(6);
    expect(box(1).getAttribute('autocomplete')).toBe('one-time-code');
    expect(box(2).getAttribute('autocomplete')).toBe('off');
    for (let n = 1; n <= 6; n += 1) {
      expect(box(n).getAttribute('inputmode')).toBe('numeric');
      expect(box(n).hasAttribute('maxlength')).toBe(false);
    }
  });

  it('moves to the next box as digits are typed, and ignores other characters', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(box(1));
    await user.keyboard('1a2-3');
    expect(value()).toBe('123');
    expect(document.activeElement).toBe(box(4));
  });

  it('fills all boxes from a pasted code, and from a code autofilled into box 1', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(box(3));
    await user.paste('987 654');
    expect(value()).toBe('987654');
    expect(document.activeElement).toBe(box(6));
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    // An autofilled code arrives as one input event in the first box.
    fireEvent.change(box(1), { target: { value: '246810' } });
    expect(value()).toBe('246810');
  });

  it('pastes a shorter run from the current box onward', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(box(2));
    await user.paste('45');
    expect(value()).toBe(' 45');
    expect(document.activeElement).toBe(box(4));
  });

  it('Backspace in an empty box clears the previous box; the arrows move', async () => {
    const user = userEvent.setup();
    render(<Harness initial="123" />);
    await user.click(box(4));
    await user.keyboard('{Backspace}');
    expect(value()).toBe('12');
    expect(document.activeElement).toBe(box(3));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(box(2));
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(box(4));
  });

  it('typing over a filled box replaces its digit', async () => {
    const user = userEvent.setup();
    render(<Harness initial="123" />);
    await user.click(box(2));
    await user.keyboard('7');
    expect(value()).toBe('173');
  });

  it('sends the code by itself once when the sixth digit is typed', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);
    await user.click(box(1));
    await user.keyboard('12345');
    expect(onComplete).not.toHaveBeenCalled();
    await user.keyboard('6');
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('123456');
  });

  it('does not send while a request is pending', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} pending />);
    await user.click(box(1));
    await user.paste('123456');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not send the same digits again by itself until one is changed', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);
    await user.click(box(1));
    await user.paste('123456');
    expect(onComplete).toHaveBeenCalledTimes(1);
    // The page cleared the field after the answer; the same code again is not sent.
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(document.activeElement).toBe(box(1));
    expect(value()).toBe('');
    await user.paste('123456');
    expect(onComplete).toHaveBeenCalledTimes(1);
    // Changing a digit is a new code.
    await user.click(box(6));
    await user.keyboard('7');
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenLastCalledWith('123457');
  });

  it.each([
    ['after', 1],
    ['before', 0],
  ])('fills all six boxes from a code inserted %s the digit already in a box', (_where, caret) => {
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} initial="9" />);
    insertAt(box(1), caret, '123456');
    expect(value()).toBe('123456');
    expect(onComplete).toHaveBeenCalledExactlyOnceWith('123456');
  });

  it('fills from box 1 when a whole code goes into box 3, also over a digit', async () => {
    const user = userEvent.setup();
    render(<Harness initial="  7" />);
    await user.click(box(3));
    await user.paste('123456');
    expect(value()).toBe('123456');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    insertAt(box(3), 0, '654321');
    expect(value()).toBe('654321');
  });

  it('puts the description on the group only', () => {
    render(
      <>
        <span id="label">Code</span>
        <span id="help">Help</span>
        <CodeField value="" onChange={() => undefined} labelledBy="label" describedBy="help" />
      </>,
    );
    expect(screen.getByRole('group').getAttribute('aria-describedby')).toBe('help');
    for (const input of screen.getAllByRole('textbox')) {
      expect(input.hasAttribute('aria-describedby')).toBe(false);
    }
  });

  it('works out the inserted text from the selection before the edit', () => {
    expect(insertedText('9', '9123456', { start: 1, end: 1 })).toBe('123456');
    expect(insertedText('9', '1234569', { start: 0, end: 0 })).toBe('123456');
    expect(insertedText('9', '123456', { start: 0, end: 1 })).toBe('123456');
    // No known selection: the old digit counts as replaced.
    expect(insertedText('9', '7', undefined)).toBe('7');
    expect(insertedText('', '246810', undefined)).toBe('246810');
  });

  it('knows a complete code', () => {
    expect(isCompleteCode('123456')).toBe(true);
    expect(isCompleteCode('12 456')).toBe(false);
    expect(isCompleteCode('12345')).toBe(false);
  });
});
