import { argon2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkNewPassword,
  createPasswordHasher,
  HasherBusyError,
  MAX_CONCURRENT_HASHES,
  MAX_QUEUED_HASHES,
  DEFAULT_ARGON2_PARAMS,
  hashPassword,
  InvalidPasswordError,
  MAX_PASSWORD_LENGTH,
  needsRehash,
  Semaphore,
  verifyPassword,
} from './password.js';

const CHEAP = { memory: 64, passes: 1, parallelism: 1 };

describe('checkNewPassword', () => {
  it.each(['', 'short', 'x'.repeat(11), ' '.repeat(11)])('rejects %j (under 12)', (password) => {
    expect(() => checkNewPassword(password)).toThrow(InvalidPasswordError);
  });

  it('accepts 12 to 256 characters, counted as code points, not trimmed', () => {
    expect(checkNewPassword('x'.repeat(12))).toBe('x'.repeat(12));
    expect(checkNewPassword(' '.repeat(12))).toBe(' '.repeat(12));
    // 12 emoji are 24 UTF-16 units but 12 characters.
    expect(checkNewPassword('🔥'.repeat(12))).toBe('🔥'.repeat(12));
    expect(() => checkNewPassword('🔥'.repeat(11))).toThrow(InvalidPasswordError);
    expect(checkNewPassword('x'.repeat(MAX_PASSWORD_LENGTH))).toHaveLength(MAX_PASSWORD_LENGTH);
    expect(() => checkNewPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toThrow(
      /max 256 characters/,
    );
  });
});

describe('hashPassword / verifyPassword', () => {
  it('writes a PHC string with the default parameters', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterY', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password!', CHEAP),
      hashPassword('same password!', CHEAP),
    ]);
    expect(a).not.toBe(b);
  });

  it('treats NFC and NFD spellings as the same password', async () => {
    const nfc = 'blåbærsyltetøy'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(await verifyPassword(nfd, await hashPassword(nfc, CHEAP))).toBe(true);
  });

  it('still verifies hashes made with other parameters, and asks to rehash weaker ones', async () => {
    const salt = Buffer.from('0123456789abcdef');
    const tag = argon2Sync('argon2id', {
      message: Buffer.from('an older password'),
      nonce: salt,
      parallelism: 1,
      tagLength: 32,
      memory: 1024,
      passes: 1,
    });
    const old = `$argon2id$v=19$m=1024,t=1,p=1$${salt.toString('base64').replace(/=+$/, '')}$${tag.toString('base64').replace(/=+$/, '')}`;
    expect(await verifyPassword('an older password', old)).toBe(true);
    expect(needsRehash(old)).toBe(true);
    expect(needsRehash(await hashPassword('x'.repeat(12)))).toBe(false);
  });

  it.each([
    '',
    'plain text',
    '$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA',
    '$argon2id$v=19$m=99999999,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA',
    '$argon2id$v=19$m=19456,t=99,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA',
  ])('never matches a malformed or unbounded hash %j', async (stored) => {
    expect(await verifyPassword('whatever password', stored)).toBe(false);
  });

  it('defaults to the OWASP baseline', () => {
    expect(DEFAULT_ARGON2_PARAMS).toEqual({ memory: 19_456, passes: 2, parallelism: 1 });
  });
});

describe('Semaphore', () => {
  it('runs at most `limit` tasks at once and lets the rest wait, failing none', async () => {
    const semaphore = new Semaphore(4);
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const tasks = Array.from({ length: 10 }, (_, index) =>
      semaphore.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
        return index;
      }),
    );
    // Let the first ones start.
    await new Promise((resolve) => setImmediate(resolve));
    expect(running).toBe(4);
    while (releases.length > 0 || running > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(4);
    expect(semaphore.running).toBe(0);
  });

  it('frees the slot when a task throws', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await semaphore.run(() => Promise.resolve('next'))).toBe('next');
  });
});

describe('a bounded queue', () => {
  it('turns away a caller when `maxWaiting` are already waiting, and takes callers again when there is room', async () => {
    const semaphore = new Semaphore(2, 3);
    const releases: (() => void)[] = [];
    const task = () => semaphore.run(() => new Promise<void>((resolve) => releases.push(resolve)));
    const accepted = Array.from({ length: 5 }, task);
    await new Promise((resolve) => setImmediate(resolve));
    expect(semaphore.running).toBe(2);
    expect(semaphore.queued).toBe(3);
    // The sixth is refused at once, and takes no slot.
    await expect(task()).rejects.toBeInstanceOf(HasherBusyError);
    expect(semaphore.queued).toBe(3);

    releases.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(semaphore.queued).toBe(2);
    const late = task();
    expect(semaphore.queued).toBe(3);
    while (releases.length > 0 || semaphore.running > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all([...accepted, late]);
    expect(semaphore.running).toBe(0);
  });

  it('never runs more than `limit` at once, however many are refused', async () => {
    const semaphore = new Semaphore(4, 8);
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const results = Array.from({ length: 100 }, () =>
      semaphore
        .run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise<void>((resolve) => releases.push(resolve));
          running -= 1;
          return 'ran';
        })
        .catch((error: unknown) => (error instanceof HasherBusyError ? 'busy' : 'failed')),
    );
    await new Promise((resolve) => setImmediate(resolve));
    while (releases.length > 0 || running > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const done = await Promise.all(results);
    expect(done.filter((result) => result === 'ran')).toHaveLength(12);
    expect(done.filter((result) => result === 'busy')).toHaveLength(88);
    expect(peak).toBe(4);
  });

  it('the default hasher runs 4 at once with 64 waiting', async () => {
    expect(MAX_CONCURRENT_HASHES).toBe(4);
    expect(MAX_QUEUED_HASHES).toBe(64);
    const hasher = createPasswordHasher({ params: CHEAP });
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        hasher.hash('correct horse battery').then(
          () => 'hashed',
          (error: unknown) => (error instanceof HasherBusyError ? 'busy' : 'failed'),
        ),
      ),
    );
    expect(results.filter((result) => result === 'hashed')).toHaveLength(68);
    expect(results.filter((result) => result === 'busy')).toHaveLength(32);
  });
});

describe('createPasswordHasher', () => {
  it('hashes and verifies with at most 4 argon2 operations at once', async () => {
    const hasher = createPasswordHasher({ params: CHEAP });
    const hash = await hasher.hash('a long enough pass');
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        hasher.verify(i % 2 === 0 ? 'a long enough pass' : 'wrong', hash),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(6);
  });
});
