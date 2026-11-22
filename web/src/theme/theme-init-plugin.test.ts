import type { HtmlTagDescriptor } from 'vite';
import { describe, expect, it } from 'vitest';
import { themeInitFileName, themeInitPlugin } from './theme-init-plugin';
import { DEFAULT_PAGE_COLOR, themeInitScript } from './themes';

// The CSP allows no inline scripts, so the theme script is a file, hashed under
// assets/ so it is cached for good (no check before first paint).

const FILE = themeInitFileName(themeInitScript());

describe('themeInitFileName', () => {
  it('is under assets/ with a hash of the content', () => {
    expect(FILE).toMatch(/^assets\/theme-init-[0-9a-f]{10}\.js$/);
    expect(themeInitFileName(themeInitScript())).toBe(FILE);
    expect(themeInitFileName(`${themeInitScript()};`)).not.toBe(FILE);
  });
});

describe('themeInitPlugin', () => {
  it('links the script as a file at the top of <head>, never inline, after theme-color', () => {
    const transform = themeInitPlugin().transformIndexHtml as () => HtmlTagDescriptor[];
    expect(transform()).toEqual([
      {
        tag: 'meta',
        attrs: { name: 'theme-color', content: DEFAULT_PAGE_COLOR },
        injectTo: 'head-prepend',
      },
      { tag: 'script', attrs: { src: `/${FILE}` }, injectTo: 'head-prepend' },
    ]);
    for (const tag of transform()) expect(tag.children).toBeUndefined();
  });

  it('emits the theme script as that file in the build', () => {
    const emitted: unknown[] = [];
    const generateBundle = themeInitPlugin().generateBundle as (this: {
      emitFile: (file: unknown) => void;
    }) => void;
    generateBundle.call({ emitFile: (file) => emitted.push(file) });
    expect(emitted).toEqual([{ type: 'asset', fileName: FILE, source: themeInitScript() }]);
  });
});
