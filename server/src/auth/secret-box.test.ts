import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANDING } from '@fireside/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSecretBox,
  fileKeyStore,
  keyFilePath,
  memoryKeyStore,
  SecretBoxError,
} from './secret-box.js';

describe('secret box', () => {
  it('round-trips a secret for the same user only', () => {
    const box = createSecretBox(memoryKeyStore());
    const sealed = box.seal(2, 'JBSWY3DPEHPK3PXP');
    expect(sealed).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.open(2, sealed)).toBe('JBSWY3DPEHPK3PXP');
    // Copied into another user's row, it doesn't decrypt.
    expect(() => box.open(3, sealed)).toThrow(SecretBoxError);
  });

  it('uses a new IV each time', () => {
    const box = createSecretBox(memoryKeyStore());
    expect(box.seal(1, 'same')).not.toBe(box.seal(1, 'same'));
  });

  it('refuses a tampered value, another key and an unknown format', () => {
    const box = createSecretBox(memoryKeyStore());
    const sealed = box.seal(1, 'JBSWY3DPEHPK3PXP');
    const [v, iv, tag, body] = sealed.split(':') as [string, string, string, string];
    const flipped = body.startsWith('A') ? `B${body.slice(1)}` : `A${body.slice(1)}`;
    expect(() => box.open(1, [v, iv, tag, flipped].join(':'))).toThrow(SecretBoxError);
    expect(() => box.open(1, [v, iv, tag.slice(0, 8), body].join(':'))).toThrow(SecretBoxError);
    expect(() => createSecretBox(memoryKeyStore()).open(1, sealed)).toThrow(SecretBoxError);
    expect(() => box.open(1, `v2:${iv}:${tag}:${body}`)).toThrow(SecretBoxError);
  });

  it('derives the recovery code key from the key, never the key itself', () => {
    const store = memoryKeyStore();
    const box = createSecretBox(store);
    const derived = box.recoveryCodeKey(true);
    expect(derived).toHaveLength(32);
    expect(derived.equals(store.key ?? Buffer.alloc(0))).toBe(false);
    expect(createSecretBox(store).recoveryCodeKey(false)).toEqual(derived);
    expect(createSecretBox(memoryKeyStore()).recoveryCodeKey(true)).not.toEqual(derived);
    expect(() => createSecretBox(memoryKeyStore()).recoveryCodeKey(false)).toThrow(SecretBoxError);
  });

  it('says the key is missing rather than failing silently', () => {
    const box = createSecretBox(memoryKeyStore());
    expect(() => box.open(1, 'v1:a:b:c')).toThrow(/key file is missing/);
  });
});

describe('the key file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `${BRANDING.shortName}-key-`));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lives in DATA_DIR as <shortName>.key, made on first use with mode 0600', () => {
    const store = fileKeyStore(dir);
    expect(keyFilePath(dir)).toBe(join(dir, `${BRANDING.shortName}.key`));
    expect(store.load()).toBeUndefined();
    const key = store.loadOrCreate();
    expect(key).toHaveLength(32);
    expect(readFileSync(keyFilePath(dir))).toEqual(key);
    expect(statSync(keyFilePath(dir)).mode & 0o777).toBe(0o600);
    // Never replaced once made.
    expect(fileKeyStore(dir).loadOrCreate()).toEqual(key);
  });

  it('opens what was sealed after a restart (a new store on the same file)', () => {
    const sealed = createSecretBox(fileKeyStore(dir)).seal(1, 'JBSWY3DPEHPK3PXP');
    expect(createSecretBox(fileKeyStore(dir)).open(1, sealed)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('never replaces an existing key, and leaves no temporary file behind', () => {
    const first = fileKeyStore(dir).loadOrCreate();
    // A second store (another process) finds the file and uses it.
    expect(fileKeyStore(dir).loadOrCreate()).toEqual(first);
    expect(readdirSync(dir)).toEqual([`${BRANDING.shortName}.key`]);
  });

  it('reads the key once and keeps it in memory', () => {
    const store = fileKeyStore(dir);
    const key = store.loadOrCreate();
    rmSync(keyFilePath(dir));
    expect(store.load()).toEqual(key);
    // A new process (a new store) sees that it is gone.
    expect(fileKeyStore(dir).load()).toBeUndefined();
  });

  it('refuses a key file of the wrong size', () => {
    writeFileSync(keyFilePath(dir), 'short');
    expect(() => fileKeyStore(dir).load()).toThrow(SecretBoxError);
    expect(() => fileKeyStore(dir).loadOrCreate()).toThrow(SecretBoxError);
  });
});
