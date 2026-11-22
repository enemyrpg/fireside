import { describe, expect, it } from 'vitest';
import { openFocusTarget } from './sheet';

function dialog(): { content: HTMLElement; title: HTMLElement; field: HTMLElement } {
  const content = document.createElement('div');
  content.innerHTML = '<h2 data-sheet-title tabindex="-1">Edit drop</h2><input />';
  const title = content.querySelector('h2');
  const field = content.querySelector('input');
  if (!title || !field) throw new Error('No title or field');
  return { content, title, field };
}

describe('openFocusTarget', () => {
  it('is the field on PC', () => {
    const { content, field } = dialog();
    expect(openFocusTarget(content, { sheet: false, field })).toBe(field);
  });

  it('leaves it to Radix on PC when there is no field', () => {
    const { content } = dialog();
    expect(openFocusTarget(content, { sheet: false, field: null })).toBeNull();
  });

  it('is the title on mobile, so the keyboard stays closed', () => {
    const { content, title, field } = dialog();
    expect(openFocusTarget(content, { sheet: true, field })).toBe(title);
    expect(openFocusTarget(content, { sheet: true, field: null })).toBe(title);
  });

  it('is the field on mobile when the sheet was opened for that field', () => {
    const { content, field } = dialog();
    expect(openFocusTarget(content, { sheet: true, field, asked: true })).toBe(field);
  });

  it('is the title on mobile when a field was asked for but is not there', () => {
    const { content, title } = dialog();
    expect(openFocusTarget(content, { sheet: true, field: null, asked: true })).toBe(title);
  });
});
