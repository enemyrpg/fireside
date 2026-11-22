import { describe, expect, it } from 'vitest';

// Every source file of the dashboard, as text.
const sources = import.meta.glob<string>('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('focus ring', () => {
  it('never turns the outline off where a focus-visible outline is the only focus mark', () => {
    // Tailwind 4: `outline-none` and `outline-hidden` set the outline style to
    // none, and `focus-visible:outline-2` only sets the width, so the ring
    // never shows. Menu items are left out: their focus mark is the background
    // (`focus:bg-…`).
    const broken: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
      for (const [index, line] of text.split('\n').entries()) {
        if (
          /(?<![:\w-])outline-(none|hidden)\b/.test(line) &&
          /focus-visible:outline-\d/.test(line) &&
          !line.includes('focus:bg-')
        ) {
          broken.push(`${file}:${String(index + 1)}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
