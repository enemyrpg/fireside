import { describe, expect, it } from 'vitest';
import { INSTANCE_TEXT_PLACEHOLDERS, normalizeInstanceTextLayout } from './instance-text.js';

describe('normalizeInstanceTextLayout', () => {
  it('stores line endings as \\n, drops trailing spaces and extra blank lines, and trims', () => {
    expect(normalizeInstanceTextLayout('  Run by Ada.  \r\n\r\n\r\n\rContact:\t \nada \n\n')).toBe(
      'Run by Ada.\n\nContact:\nada',
    );
  });

  it('keeps single line breaks and spaces inside lines', () => {
    expect(normalizeInstanceTextLayout('a  b\nc')).toBe('a  b\nc');
  });
});

describe('INSTANCE_TEXT_PLACEHOLDERS', () => {
  it('are the two bracketed placeholders', () => {
    expect(INSTANCE_TEXT_PLACEHOLDERS).toEqual(['[your name]', '[how to reach you]']);
  });
});
