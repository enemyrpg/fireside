import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEMES } from './themes';

// Contrast of the theme tokens, WCAG 2.x: text 4.5:1 on every surface it is
// used on, the marker for new collection log items 3:1. Checked in every theme,
// so a new theme or a changed value can't slip under.

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

const css = readFileSync(join(import.meta.dirname, 'themes.css'), 'utf8');

function variables(theme: string): Map<string, string> {
  const block = css.split(`[data-theme='${theme}']`)[1]?.split('}')[0] ?? '';
  return new Map(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [
      match[1] ?? '',
      (match[2] ?? '').trim(),
    ]),
  );
}

function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex !== undefined) {
    return [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).concat(1) as Rgba;
  }
  const parts = /^rgba?\(([^)]+)\)$/.exec(value)?.[1]?.split(',').map(Number);
  if (parts === undefined || parts.length < 3) throw new Error(`Not a colour: ${value}`);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
}

function over(top: Rgba, bottom: Rgb): Rgb {
  const alpha = top[3];
  return [0, 1, 2].map((i) => (top[i] ?? 0) * alpha + (bottom[i] ?? 0) * (1 - alpha)) as Rgb;
}

function luminance(colour: Rgb): number {
  const [r, g, b] = colour.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/** Every surface text stands on. The washes are see-through in Dark and Light, so over both. */
function surfaces(theme: string): Map<string, Rgb> {
  const vars = variables(theme);
  const solid = (name: string): Rgb => {
    const [r, g, b] = parse(vars.get(name) ?? '');
    return [r, g, b];
  };
  const result = new Map<string, Rgb>();
  for (const name of ['--page', '--card', '--raised', '--hover', '--info-wash']) {
    result.set(name, solid(name));
  }
  const wash = parse(vars.get('--accent-wash') ?? '');
  result.set('--accent-wash on --card', over(wash, solid('--card')));
  result.set('--accent-wash on --page', over(wash, solid('--page')));
  return result;
}

const TEXT = ['--text', '--text-2', '--text-3', '--accent-text', '--info-text'];
/** Never on a wash or the info card: errors, destructive actions and price changes. */
const STATUS = ['--up', '--down'];
const STATUS_SURFACES = ['--page', '--card', '--raised', '--hover'];

describe.each(THEMES.map((theme) => theme.id))('contrast in %s', (theme) => {
  const vars = variables(theme);
  const colour = (name: string): Rgb => {
    const [r, g, b] = parse(vars.get(name) ?? '');
    return [r, g, b];
  };

  it.each(TEXT)('%s is 4.5:1 on every surface', (token) => {
    const low = [...surfaces(theme)]
      .map(([surface, value]) => ({ surface, ratio: contrast(colour(token), value) }))
      .filter(({ ratio }) => ratio < 4.5);
    expect(low).toEqual([]);
  });

  it.each(STATUS)('%s is 4.5:1 as text on the page, cards, tiles and hovered rows', (token) => {
    const low = STATUS_SURFACES.map((surface) => ({
      surface,
      ratio: contrast(colour(token), colour(surface)),
    })).filter(({ ratio }) => ratio < 4.5);
    expect(low).toEqual([]);
  });

  it('text on filled buttons is 4.5:1', () => {
    expect(contrast(colour('--on-accent'), colour('--accent'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colour('--on-down'), colour('--down'))).toBeGreaterThanOrEqual(4.5);
  });

  it('the marker for new collection log items is 3:1 on every surface', () => {
    const low = [...surfaces(theme)]
      .map(([surface, value]) => ({ surface, ratio: contrast(colour('--info'), value) }))
      .filter(({ ratio }) => ratio < 3);
    expect(low).toEqual([]);
  });

  it('the focus ring is 3:1 on the page and on cards', () => {
    for (const surface of ['--page', '--card']) {
      expect(contrast(colour('--accent'), colour(surface))).toBeGreaterThanOrEqual(3);
    }
  });
});
