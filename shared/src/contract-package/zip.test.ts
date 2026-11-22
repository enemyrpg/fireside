import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createZip, type ZipEntry } from './zip.js';

/**
 * Reads a zip through its central directory (the way unzip tools do) and
 * checks each local header and CRC on the way.
 */
function readZip(zip: Buffer): ZipEntry[] {
  const endOffset = zip.length - 22;
  expect(zip.readUInt32LE(endOffset)).toBe(0x06054b50);
  const count = zip.readUInt16LE(endOffset + 10);
  const centralSize = zip.readUInt32LE(endOffset + 12);
  let pos = zip.readUInt32LE(endOffset + 16);
  expect(pos + centralSize).toBe(endOffset);

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(pos)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(pos + 16);
    const compressedSize = zip.readUInt32LE(pos + 20);
    const size = zip.readUInt32LE(pos + 24);
    const nameLength = zip.readUInt16LE(pos + 28);
    const extraLength = zip.readUInt16LE(pos + 30);
    const commentLength = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const path = zip.toString('utf8', pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;

    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(zip.readUInt16LE(localOffset + 8)).toBe(0); // stored
    expect(zip.readUInt32LE(localOffset + 14)).toBe(crc);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    expect(zip.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength)).toBe(path);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    expect(compressedSize).toBe(size);
    const data = Buffer.from(zip.subarray(dataStart, dataStart + size));

    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    entries.push({ path, data });
  }
  expect(pos).toBe(endOffset);
  return entries;
}

const entries: ZipEntry[] = [
  { path: 'schema/event.json', data: Buffer.from('{"type":"object"}\n') },
  { path: 'manifest.json', data: Buffer.from('{}\n') },
  { path: 'fixtures/empty.json', data: Buffer.alloc(0) },
  { path: 'fixtures/æøå.json', data: Buffer.from('"utf-8 name"') },
  { path: 'big.txt', data: Buffer.from('abc'.repeat(100_000)) },
];

describe('createZip', () => {
  it('round-trips all entries, sorted by path', () => {
    const read = readZip(createZip(entries));
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(read.map((entry) => entry.path)).toEqual(sorted.map((entry) => entry.path));
    for (const [i, entry] of read.entries()) {
      expect(entry.data.equals(sorted[i]?.data ?? Buffer.alloc(1))).toBe(true);
    }
  });

  it('is deterministic regardless of input order', () => {
    expect(createZip(entries).equals(createZip([...entries].reverse()))).toBe(true);
  });

  it('writes an empty zip', () => {
    expect(readZip(createZip([]))).toEqual([]);
  });

  it('rejects duplicate and unsafe paths', () => {
    const data = Buffer.from('x');
    expect(() =>
      createZip([
        { path: 'a', data },
        { path: 'a', data },
      ]),
    ).toThrow(/Duplicate/);
    for (const path of ['/abs', '../up', 'a/./b', 'a//b', 'dir/', '', 'a\\b']) {
      expect(() => createZip([{ path, data }])).toThrow(/Invalid/);
    }
  });

  it('accepts names with dots that are not path segments', () => {
    const data = Buffer.from('x');
    const paths = ['a..b.json', '.hidden', 'dir/..x'];
    expect(readZip(createZip(paths.map((path) => ({ path, data })))).map((e) => e.path)).toEqual(
      [...paths].sort(),
    );
  });
});
