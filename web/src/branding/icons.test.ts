import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ICONS, MASKABLE_SAFE_RADIUS } from './icons';
import { LOGO_DEFAULT_ACCENT } from './logo';
import { renderIconPixels, renderIconPng } from './render-icon';

const publicFile = (file: string) =>
  readFileSync(join(import.meta.dirname, '..', '..', 'public', file));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('app icons', () => {
  it.each(APP_ICONS.map((icon) => [icon.file, icon] as const))(
    '%s has the right size and matches logo.ts',
    (file, icon) => {
      const png = publicFile(file);
      expect(pngSize(png)).toEqual({ width: icon.size, height: icon.size });
      // On failure, the drawing changed: run `pnpm icons` and commit the PNGs.
      expect(
        png.equals(renderIconPng(icon)),
        `public/${file} is out of date: run \`pnpm icons\``,
      ).toBe(true);
    },
  );

  it('keeps the maskable icon full-bleed, with the mark inside the safe zone', () => {
    const icon = APP_ICONS.find((candidate) => candidate.purpose === 'maskable');
    if (!icon) throw new Error('no maskable icon');
    const { width, height, pixels } = renderIconPixels(icon);
    const accent = [1, 3, 5].map((start) =>
      Number.parseInt(LOGO_DEFAULT_ACCENT.slice(start, start + 2), 16),
    );
    const centre = width / 2;
    const safe = MASKABLE_SAFE_RADIUS * width;
    let markPixels = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4;
        const rgba = [...pixels.subarray(at, at + 4)];
        // Every pixel is opaque: the platform's mask is the only shape.
        expect(rgba[3]).toBe(255);
        const isBackground = rgba.slice(0, 3).every((value, i) => value === accent[i]);
        if (isBackground) continue;
        markPixels++;
        expect(Math.hypot(x + 0.5 - centre, y + 0.5 - centre)).toBeLessThanOrEqual(safe);
      }
    }
    expect(markPixels).toBeGreaterThan(0);
  });
});
