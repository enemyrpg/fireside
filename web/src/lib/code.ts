// Two-factor codes in the forms.

/** Digits in a code from an authenticator app. */
export const CODE_LENGTH = 6;

const COMPLETE_CODE = new RegExp(`^\\d{${String(CODE_LENGTH)}}$`);

/** True when the value holds `CODE_LENGTH` digits (the six-box field's value can have gaps). */
export function isCompleteCode(value: string): boolean {
  return COMPLETE_CODE.test(value);
}

/** Whether a code field holds something worth sending: six digits, or a recovery code. */
export function codeReady(code: string, recovery: boolean): boolean {
  return recovery ? code.trim() !== '' : isCompleteCode(code);
}

/**
 * What an edit inserted into a box: the new value without the part of the
 * old value outside the selection the edit replaced. Without a known
 * selection (an edit with no `beforeinput`), the whole old value counts as
 * replaced, as after the box selects itself on focus.
 */
export function insertedText(
  old: string,
  raw: string,
  selection: { start: number; end: number } | undefined,
): string {
  const start = Math.min(selection?.start ?? 0, old.length);
  const end = Math.min(Math.max(selection?.end ?? old.length, start), old.length);
  const before = old.slice(0, start);
  const after = old.slice(end);
  if (raw.length >= before.length + after.length && raw.startsWith(before) && raw.endsWith(after)) {
    return raw.slice(before.length, raw.length - after.length);
  }
  return raw;
}
