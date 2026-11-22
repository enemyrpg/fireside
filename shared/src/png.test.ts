import { describe, expect, it } from 'vitest';
import { checkPng, crc32, decodeBase64, encodeBase64, MAX_ICON_BYTES } from './png.js';
import { makeSolidPng, makeTinyGif, makeTinyJpeg, pngChunk } from './test-images.js';

const red = [200, 60, 40, 255] as const;

/** Replaces the IHDR byte at `offset` (0 = first data byte) and fixes the CRC. */
function withIhdrByte(png: Uint8Array, offset: number, value: number): Uint8Array {
  const out = png.slice();
  out[16 + offset] = value;
  const crc = crc32(out, 12, 29);
  new DataView(out.buffer).setUint32(29, crc);
  return out;
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('base64', () => {
  it('round-trips', () => {
    const bytes = makeSolidPng(3, 2, red);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });
});

describe('checkPng', () => {
  it('accepts indexed and RGBA PNGs and returns the size', () => {
    expect(checkPng(makeSolidPng(36, 32, red))).toEqual({ ok: true, width: 36, height: 32 });
    expect(checkPng(makeSolidPng(36, 32, red, { format: 'rgba' }))).toEqual({
      ok: true,
      width: 36,
      height: 32,
    });
  });

  it('accepts 64×64 and rejects 65 in either direction', () => {
    expect(checkPng(makeSolidPng(64, 64, red)).ok).toBe(true);
    expect(checkPng(makeSolidPng(65, 64, red))).toEqual({
      ok: false,
      error: 'Image is 65×64, at most 64×64 allowed',
    });
    expect(checkPng(makeSolidPng(1, 65, red)).ok).toBe(false);
  });

  it('accepts exactly MAX_ICON_BYTES and rejects one more', () => {
    const base = makeSolidPng(8, 8, red);
    // A tEXt chunk sized so the whole file hits the limit (12 bytes chunk overhead).
    const padded = (total: number) =>
      makeSolidPng(8, 8, red, {
        extraChunks: [pngChunk('tEXt', new Uint8Array(total - base.length - 12).fill(0x61))],
      });
    expect(padded(MAX_ICON_BYTES).length).toBe(MAX_ICON_BYTES);
    expect(checkPng(padded(MAX_ICON_BYTES)).ok).toBe(true);
    expect(checkPng(padded(MAX_ICON_BYTES + 1))).toEqual({
      ok: false,
      error: `PNG is ${String(MAX_ICON_BYTES + 1)} bytes, at most ${String(MAX_ICON_BYTES)} allowed`,
    });
  });

  it.each([
    ['GIF', makeTinyGif([1, 2, 3]), 'Not a PNG (bad signature)'],
    ['JPEG', makeTinyJpeg(), 'Not a PNG (bad signature)'],
    ['empty', new Uint8Array(), 'Not a PNG (bad signature)'],
    ['bad CRC', makeSolidPng(4, 4, red, { badIhdrCrc: true }), 'Bad CRC in IHDR chunk'],
    ['no IEND', makeSolidPng(4, 4, red, { omitIend: true }), 'No IEND chunk'],
    [
      'APNG',
      makeSolidPng(4, 4, red, { extraChunks: [pngChunk('acTL', [0, 0, 0, 1, 0, 0, 0, 0])] }),
      'Animated PNG is not allowed',
    ],
    [
      'zero width',
      withIhdrByte(makeSolidPng(4, 4, red), 3, 0),
      'Width and height must be at least 1',
    ],
    [
      'bit depth 16 indexed',
      withIhdrByte(makeSolidPng(4, 4, red), 8, 16),
      'Invalid bit depth or colour type',
    ],
    [
      'colour type 5',
      withIhdrByte(makeSolidPng(4, 4, red), 9, 5),
      'Invalid bit depth or colour type',
    ],
    [
      'compression 1',
      withIhdrByte(makeSolidPng(4, 4, red), 10, 1),
      'Unknown compression or filter method',
    ],
    ['interlace 2', withIhdrByte(makeSolidPng(4, 4, red), 12, 2), 'Unknown interlace method'],
  ])('rejects %s', (_name, bytes, error) => {
    expect(checkPng(bytes)).toEqual({ ok: false, error });
  });

  it('rejects data after IEND, truncation and a missing IDAT or PLTE', () => {
    const png = makeSolidPng(4, 4, red);
    expect(checkPng(new Uint8Array([...png, 0]))).toMatchObject({ error: 'Data after IEND' });
    expect(checkPng(png.subarray(0, png.length - 2))).toMatchObject({
      error: 'Chunk runs past the end',
    });
    expect(checkPng(png.subarray(0, png.length - 6))).toMatchObject({
      error: 'Truncated chunk header',
    });
    // Signature + IHDR (33 bytes), then straight to IEND.
    const iend = pngChunk('IEND');
    const rgba = makeSolidPng(4, 4, red, { format: 'rgba' });
    expect(checkPng(new Uint8Array([...rgba.subarray(0, 33), ...iend]))).toMatchObject({
      error: 'No IDAT chunk',
    });
    const withoutPlte = new Uint8Array([
      ...png.subarray(0, 33),
      ...png.subarray(33 + 12 + 3), // skip the PLTE chunk (3 bytes of data)
    ]);
    expect(checkPng(withoutPlte)).toMatchObject({ error: 'Indexed PNG without PLTE' });
  });

  it('rejects a second IHDR and a first chunk that is not IHDR', () => {
    const png = makeSolidPng(4, 4, red);
    const ihdr = png.subarray(8, 33);
    expect(checkPng(makeSolidPng(4, 4, red, { extraChunks: [ihdr] }))).toMatchObject({
      error: 'More than one IHDR chunk',
    });
    expect(checkPng(new Uint8Array([...png.subarray(0, 8), ...png.subarray(33)]))).toMatchObject({
      error: 'First chunk is not IHDR',
    });
  });
});
