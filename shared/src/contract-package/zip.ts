import { crc32 } from 'node:zlib';

// Minimal ZIP writer (PKWARE APPNOTE 6.3): stored entries only (no
// compression), no ZIP64, no encryption. Enough for the contract package, so
// we need no dependency. Output depends only on the input: entries are sorted,
// all get the same timestamp, and storing avoids differences between zlib
// versions, so the same contract gives the same bytes on any machine.

export interface ZipEntry {
  /** Path inside the zip, with `/` separators. */
  path: string;
  data: Buffer;
}

// 1980-01-01 00:00, the earliest DOS date.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

const VERSION = 10; // 1.0: stored files
const FLAG_UTF8 = 1 << 11;
const METHOD_STORED = 0;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

/** Relative file path: no empty, `.` or `..` segments and no backslashes. */
function assertValidPath(path: string): void {
  const segments = path.split('/');
  if (path.includes('\\') || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`Invalid zip entry path: ${path}`);
  }
}

/** Fields shared by the local header and the central directory record. */
function commonFields(crc: number, size: number, nameLength: number) {
  const buffer = Buffer.alloc(26);
  buffer.writeUInt16LE(VERSION, 0); // version needed
  buffer.writeUInt16LE(FLAG_UTF8, 2);
  buffer.writeUInt16LE(METHOD_STORED, 4);
  buffer.writeUInt16LE(DOS_TIME, 6);
  buffer.writeUInt16LE(DOS_DATE, 8);
  buffer.writeUInt32LE(crc, 10);
  buffer.writeUInt32LE(size, 14); // compressed size (same when stored)
  buffer.writeUInt32LE(size, 18);
  buffer.writeUInt16LE(nameLength, 22);
  buffer.writeUInt16LE(0, 24); // extra field length
  return buffer;
}

export function createZip(entries: readonly ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (sorted.length > MAX_UINT16) throw new Error('Too many zip entries');
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let previous: string | undefined;

  for (const entry of sorted) {
    assertValidPath(entry.path);
    if (entry.path === previous) throw new Error(`Duplicate zip entry: ${entry.path}`);
    previous = entry.path;

    const name = Buffer.from(entry.path, 'utf8');
    if (name.length > MAX_UINT16) throw new Error(`Zip entry path too long: ${entry.path}`);
    const fields = commonFields(crc32(entry.data), entry.data.length, name.length);

    const localHeader = Buffer.alloc(4);
    localHeader.writeUInt32LE(0x04034b50, 0);
    local.push(localHeader, fields, name, entry.data);

    // Central record: signature, version made by, the shared fields, then
    // comment length, disk, attributes and the local header offset.
    const centralHeader = Buffer.alloc(6);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(VERSION, 4); // version made by (MS-DOS, 1.0)
    const centralTail = Buffer.alloc(14);
    centralTail.writeUInt16LE(0, 0); // comment length
    centralTail.writeUInt16LE(0, 2); // disk number start
    centralTail.writeUInt16LE(0, 4); // internal attributes
    centralTail.writeUInt32LE(0, 6); // external attributes
    centralTail.writeUInt32LE(offset, 10); // offset of local header
    central.push(centralHeader, fields, centralTail, name);

    offset += 4 + fields.length + name.length + entry.data.length;
    if (offset > MAX_UINT32) throw new Error('Zip too large (ZIP64 not supported)');
  }

  const centralDirectory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...local, centralDirectory, end]);
}
