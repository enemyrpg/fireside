// Rules for short texts the owner types in (key names, raid drop nicknames and notes).

/**
 * Control characters (incl. ANSI escapes), line/paragraph separators and
 * invisible format characters (bidi marks and overrides, zero-width spaces and
 * joiners, BOM), lone surrogates (not valid text, can't be encoded as UTF-8)
 * and private-use characters. They could break, reorder or disguise a text
 * wherever it is shown (terminal, dashboard). This also rejects emoji joined
 * with U+200D.
 */
export const UNSAFE_TEXT_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

/** Length in code points, not UTF-16 units, so an emoji counts as one character. */
export function characterCount(text: string): number {
  return Array.from(text).length;
}
