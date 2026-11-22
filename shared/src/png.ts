// Structural PNG check for uploaded item icons (`POST /ingest/icons`). The server
// never decodes or re-encodes icons: the browser draws them, and a broken image
// body only makes the dashboard fall back to the placeholder. This checks the
// container format and the size caps, in plain TypeScript (no Node APIs), so it
// runs in the server and in tests.

/** Largest accepted icon, in bytes (decoded). */
export const MAX_ICON_BYTES = 16 * 1024;

/** Largest accepted width and height, in pixels. */
export const MAX_ICON_DIMENSION = 64;

/** The 8-byte PNG signature. */
export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Allowed bit depths per colour type (PNG spec, table 11.1). */
const BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16], // greyscale
  2: [8, 16], // truecolour
  3: [1, 2, 4, 8], // indexed
  4: [8, 16], // greyscale with alpha
  6: [8, 16], // truecolour with alpha
};

let crcTable: Uint32Array | undefined;

/** CRC-32 as used by PNG chunks (and zlib). */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = (crcTable[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Decodes standard base64 (with padding). The caller checks the alphabet first. */
export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encodes bytes as standard base64 with padding. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type PngCheck = { ok: true; width: number; height: number } | { ok: false; error: string };

function fail(error: string): PngCheck {
  return { ok: false, error };
}

/**
 * Checks that `bytes` is a single-image PNG that fits the icon caps:
 * signature, IHDR first (width and height 1–`MAX_ICON_DIMENSION`, a valid bit
 * depth and colour type, compression and filter 0, interlace 0 or 1), every
 * chunk in bounds with a correct CRC, PLTE for indexed images, at least one
 * IDAT, and IEND last with nothing after it. Animated PNGs (`acTL`) are
 * rejected. Image data is not inflated.
 */
export function checkPng(bytes: Uint8Array): PngCheck {
  if (bytes.length > MAX_ICON_BYTES) {
    return fail(`PNG is ${String(bytes.length)} bytes, at most ${String(MAX_ICON_BYTES)} allowed`);
  }
  if (bytes.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
    return fail('Not a PNG (bad signature)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let colourType = -1;
  let chunkCount = 0;
  let hasPalette = false;
  let hasData = false;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return fail('Truncated chunk header');
    const length = view.getUint32(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > 0x7fffffff || dataEnd + 4 > bytes.length) return fail('Chunk runs past the end');
    const type = String.fromCharCode(...bytes.subarray(typeStart, dataStart));
    if (!/^[A-Za-z]{4}$/.test(type)) return fail('Invalid chunk type');
    if (crc32(bytes, typeStart, dataEnd) !== view.getUint32(dataEnd)) {
      return fail(`Bad CRC in ${type} chunk`);
    }
    chunkCount++;

    if (chunkCount === 1) {
      if (type !== 'IHDR' || length !== 13) return fail('First chunk is not IHDR');
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      const bitDepth = bytes[dataStart + 8] ?? 0;
      colourType = bytes[dataStart + 9] ?? -1;
      if (width < 1 || height < 1) return fail('Width and height must be at least 1');
      if (width > MAX_ICON_DIMENSION || height > MAX_ICON_DIMENSION) {
        return fail(
          `Image is ${String(width)}×${String(height)}, at most ${String(MAX_ICON_DIMENSION)}×${String(MAX_ICON_DIMENSION)} allowed`,
        );
      }
      if (!BIT_DEPTHS[colourType]?.includes(bitDepth)) {
        return fail('Invalid bit depth or colour type');
      }
      if (bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0) {
        return fail('Unknown compression or filter method');
      }
      if ((bytes[dataStart + 12] ?? 2) > 1) return fail('Unknown interlace method');
    } else if (type === 'IHDR') {
      return fail('More than one IHDR chunk');
    } else if (type === 'PLTE') {
      hasPalette = true;
    } else if (type === 'IDAT') {
      hasData = true;
    } else if (type === 'acTL') {
      return fail('Animated PNG is not allowed');
    } else if (type === 'IEND') {
      if (dataEnd + 4 !== bytes.length) return fail('Data after IEND');
      if (colourType === 3 && !hasPalette) return fail('Indexed PNG without PLTE');
      if (!hasData) return fail('No IDAT chunk');
      return { ok: true, width, height };
    }
    offset = dataEnd + 4;
  }
  return fail('No IEND chunk');
}
