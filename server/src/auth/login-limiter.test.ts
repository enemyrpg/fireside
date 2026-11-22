import { describe, expect, it } from 'vitest';
import {
  AuthLimiters,
  beginAll,
  delayFor,
  FORGET_AFTER_MS,
  HardLimiter,
  IP_RULE,
  ipLimitKey,
  IpFailureLimiter,
  LOGIN_USER_RULE,
  REAUTH_RULE,
  TOTP_RULE,
  type Attempt,
} from './login-limiter.js';

/** The auth buckets on a fake clock. */
function setup(maxEntries?: number) {
  let now = Date.parse('2026-11-18T12:00:00.000Z');
  const limiters = new AuthLimiters({
    now: () => new Date(now),
    ...(maxEntries === undefined ? {} : { maxEntries }),
  });
  /** `login:ip` alone, as invite links use `invite:ip` (same rule). */
  const limiter = {
    beginIp: (ip: string) => limiters.loginIp.begin(ipLimitKey(ip)),
    get size() {
      return limiters.loginIp.size;
    },
  };
  return {
    limiters,
    limiter,
    advance: (ms: number) => {
      now += ms;
    },
    time: () => now,
  };
}

function finish(attempt: Attempt, succeeded: boolean): Attempt {
  if (attempt.status === 'allowed') attempt.finish(succeeded);
  return attempt;
}

const failLogin = (limiters: AuthLimiters, ip: string, username: string, knownDevice = false) =>
  finish(limiters.login(ip, username, { knownDevice }), false);

describe('delayFor', () => {
  it('is free up to the limit, then doubles from 2 s up to the cap', () => {
    expect(delayFor(LOGIN_USER_RULE, 9)).toBe(0);
    expect(delayFor(LOGIN_USER_RULE, 10)).toBe(2000);
    expect(delayFor(LOGIN_USER_RULE, 11)).toBe(4000);
    expect(delayFor(LOGIN_USER_RULE, 1000)).toBe(15 * 60_000);
    expect(delayFor(TOTP_RULE, 4)).toBe(0);
    expect(delayFor(TOTP_RULE, 5)).toBe(2000);
    expect(delayFor(REAUTH_RULE, 10)).toBe(2000);
    expect(delayFor(IP_RULE, 19)).toBe(0);
    expect(delayFor(IP_RULE, 20)).toBe(2000);
    expect(delayFor(IP_RULE, 1000)).toBe(15 * 60_000);
  });
});

describe('login:user', () => {
  it('refuses a username after 10 failures from any IPs, lifted within 15 minutes', () => {
    const { limiters, advance } = setup();
    for (let i = 0; i < LOGIN_USER_RULE.free; i++) {
      expect(failLogin(limiters, `10.0.0.${String(i)}`, 'testmain').status).toBe('allowed');
    }
    expect(limiters.login('198.51.100.7', 'testmain', { knownDevice: false })).toEqual({
      status: 'blocked',
      firstRefusal: true,
      retryAfterSeconds: 2,
    });
    // Another name is not affected.
    expect(limiters.login('198.51.100.7', 'other', { knownDevice: false }).status).toBe('allowed');

    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      const blocked = limiters.login(`203.0.113.${String(i)}`, 'testmain', { knownDevice: false });
      if (blocked.status !== 'blocked') throw new Error('expected a block');
      waits.push(blocked.retryAfterSeconds);
      advance(blocked.retryAfterSeconds * 1000);
      expect(failLogin(limiters, `203.0.113.${String(i)}`, 'testmain').status).toBe('allowed');
    }
    expect(waits.slice(0, 4)).toEqual([2, 4, 8, 16]);
    expect(Math.max(...waits)).toBe(15 * 60);
  });

  it('is skipped by a known device, which still counts per IP', () => {
    const { limiters } = setup();
    for (let i = 0; i < 30; i++) failLogin(limiters, `10.0.1.${String(i)}`, 'testmain');
    expect(limiters.login('198.51.100.7', 'testmain', { knownDevice: false }).status).toBe(
      'blocked',
    );
    expect(limiters.login('198.51.100.7', 'testmain', { knownDevice: true }).status).toBe(
      'allowed',
    );
    // The known device's own IP limit still applies.
    for (let i = 0; i < IP_RULE.free; i++) failLogin(limiters, '198.51.100.8', 'testmain', true);
    expect(limiters.login('198.51.100.8', 'testmain', { knownDevice: true }).status).toBe(
      'blocked',
    );
  });

  it('counts parallel attempts when they start', () => {
    const { limiters } = setup();
    const started = Array.from({ length: 15 }, (_, i) =>
      limiters.login(`10.0.0.${String(i)}`, 'testmain', { knownDevice: false }),
    );
    expect(started.filter((a) => a.status === 'allowed')).toHaveLength(10);
    expect(started.filter((a) => a.status === 'blocked')).toHaveLength(5);
  });

  it('treats an unknown username the same as a real one', () => {
    const { limiters } = setup();
    for (let i = 0; i < 10; i++) {
      failLogin(limiters, `10.0.0.${String(i)}`, 'admin');
      failLogin(limiters, `10.0.0.${String(i)}`, 'no-such-user');
    }
    expect(limiters.login('10.0.9.1', 'admin', { knownDevice: false })).toEqual(
      limiters.login('10.0.9.1', 'no-such-user', { knownDevice: false }),
    );
  });

  it('records nothing in any bucket when one of them refuses', () => {
    const { limiters } = setup();
    for (let i = 0; i < 10; i++) failLogin(limiters, `10.0.0.${String(i)}`, 'testmain');
    const ipSize = limiters.loginIp.size;
    for (let i = 0; i < 5; i++) limiters.login('192.0.2.1', 'testmain', { knownDevice: false });
    // 192.0.2.1 was never counted.
    expect(limiters.loginIp.size).toBe(ipSize);
  });
});

describe('totp:user and reauth:user', () => {
  it('refuses 2FA codes for a user after 5 failures, from any IP', () => {
    const { limiters } = setup();
    for (let i = 0; i < TOTP_RULE.free; i++) {
      expect(finish(limiters.totpLogin(`10.0.0.${String(i)}`, 7), false).status).toBe('allowed');
    }
    expect(limiters.totpLogin('10.0.1.1', 7).status).toBe('blocked');
    expect(limiters.totpCode(7).status).toBe('blocked');
    expect(limiters.totpCode(8).status).toBe('allowed');
  });

  it('keeps reauth:user apart from login:user, so a flood of logins never blocks the owner', () => {
    const { limiters } = setup();
    for (let i = 0; i < 40; i++) failLogin(limiters, `10.0.0.${String(i)}`, 'testmain');
    expect(limiters.login('10.0.9.9', 'testmain', { knownDevice: false }).status).toBe('blocked');
    expect(limiters.reauthenticate('198.51.100.7', 1).status).toBe('allowed');
  });

  it('limits password checks with a session per user across IPs', () => {
    const { limiters } = setup();
    for (let i = 0; i < REAUTH_RULE.free; i++) {
      finish(limiters.reauthenticate(`10.0.0.${String(i)}`, 1), false);
    }
    expect(limiters.reauthenticate('10.0.1.1', 1).status).toBe('blocked');
    expect(limiters.reauthenticate('10.0.1.1', 2).status).toBe('allowed');
  });
});

describe('HardLimiter and beginAll', () => {
  it('a success takes its own count back', () => {
    const { limiter } = setup();
    for (let i = 0; i < IP_RULE.free + 5; i += 1) finish(limiter.beginIp('10.0.0.1'), true);
    expect(limiter.size).toBe(0);
  });

  it('finishes once only', () => {
    const limiter = new HardLimiter(TOTP_RULE);
    const attempt = limiter.begin('k');
    finish(attempt, false);
    finish(attempt, true);
    for (let i = 1; i < TOTP_RULE.free; i++) finish(limiter.begin('k'), false);
    expect(limiter.begin('k').status).toBe('blocked');
  });

  it('needs at least one bucket', () => {
    expect(() => beginAll([])).toThrow();
  });

  it('forgets failures an hour after the last one: never a permanent lockout', () => {
    const { limiters, advance } = setup();
    for (let i = 0; i < 30; i++) failLogin(limiters, '10.0.0.1', 'testmain');
    expect(limiters.login('10.0.0.1', 'testmain', { knownDevice: false }).status).toBe('blocked');
    advance(FORGET_AFTER_MS);
    expect(limiters.login('10.0.0.1', 'testmain', { knownDevice: false }).status).toBe('allowed');
  });

  it('drops forgotten IPs and usernames from memory once the limiter is used again', () => {
    const { limiters, advance } = setup();
    failLogin(limiters, '10.0.0.1', 'testmain');
    failLogin(limiters, '10.0.0.2', 'other');
    // A success after a failure keeps the entry in its place in the order.
    finish(limiters.login('10.0.0.1', 'testmain', { knownDevice: false }), true);
    expect(limiters.loginIp.size).toBe(2);
    advance(FORGET_AFTER_MS);
    failLogin(limiters, '10.0.0.3', 'third');
    expect(limiters.loginIp.size).toBe(1);
    expect(limiters.loginUser.size).toBe(1);
  });

  it('keeps at most maxEntries keys per bucket, dropping the oldest', () => {
    const { limiters } = setup(10);
    for (let i = 0; i < 50; i++) failLogin(limiters, `10.0.${String(i)}.1`, `u${String(i)}`);
    expect(limiters.loginIp.size).toBe(10);
    expect(limiters.loginUser.size).toBe(10);
  });
});

describe('login:ip and invite:ip', () => {
  it('blocks an IP after the free failures and leaves other IPs alone', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < IP_RULE.free; i += 1)
      expect(finish(limiter.beginIp('10.0.0.1'), false).status).toBe('allowed');
    expect(limiter.beginIp('10.0.0.1')).toEqual({
      status: 'blocked',
      retryAfterSeconds: 2,
      firstRefusal: true,
    });
    expect(limiter.beginIp('10.0.0.2').status).toBe('allowed');
    advance(2000);
    expect(limiter.beginIp('10.0.0.1').status).toBe('allowed');
  });

  it('keeps invite links apart from logins', () => {
    const { limiters } = setup();
    for (let i = 0; i < IP_RULE.free; i += 1) finish(limiters.invite('10.0.0.1'), false);
    expect(limiters.invite('10.0.0.1').status).toBe('blocked');
    expect(limiters.login('10.0.0.1', 'admin', { knownDevice: true }).status).toBe('allowed');
  });
});

describe('ipLimitKey', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['::FFFF:203.0.113.9', '203.0.113.9'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:DB8:0001:0002:ffff::', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['64:ff9b::203.0.113.9', '203.0.113.9'],
    ['64:ff9b::cb00:7109', '203.0.113.9'],
    ['64:FF9B:0:0:0:0:CB00:7109', '203.0.113.9'],
    ['64:ff9b:1::cb00:7109', '64:ff9b:1:0::/64'],
  ])('%s → %s', (ip, key) => {
    expect(ipLimitKey(ip)).toBe(key);
  });

  it('puts every address of one /64 under one key, and another /64 under another', () => {
    expect(ipLimitKey('2001:db8:aa:bb::1')).toBe(ipLimitKey('2001:db8:aa:bb:ffff:1:2:3'));
    expect(ipLimitKey('2001:db8:aa:bb::1')).not.toBe(ipLimitKey('2001:db8:aa:bc::1'));
  });

  it('gives each IPv4 client behind NAT64 its own counter', () => {
    const { limiter } = setup();
    for (let i = 0; i < IP_RULE.free; i += 1) {
      const attempt = limiter.beginIp('64:ff9b::203.0.113.9');
      if (attempt.status === 'allowed') attempt.finish(false);
    }
    expect(limiter.beginIp('64:ff9b::cb00:7109').status).toBe('blocked');
    expect(limiter.beginIp('64:ff9b::203.0.113.10').status).toBe('allowed');
  });

  it('counts a whole IPv6 /64 as one IP for logins', () => {
    const { limiter } = setup();
    for (let i = 0; i < IP_RULE.free; i += 1) {
      const attempt = limiter.beginIp(`2001:db8:1:2::${i.toString(16)}`);
      if (attempt.status === 'allowed') attempt.finish(false);
    }
    expect(limiter.beginIp('2001:db8:1:2::ffff').status).toBe('blocked');
    expect(limiter.beginIp('2001:db8:1:3::1').status).toBe('allowed');
  });
});

describe('IpFailureLimiter (ingest without a valid key)', () => {
  function failures(maxEntries?: number) {
    let now = Date.parse('2026-11-18T12:00:00.000Z');
    const limiter = new IpFailureLimiter({
      now: () => new Date(now),
      ...(maxEntries === undefined ? {} : { maxEntries }),
    });
    return {
      limiter,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('lets the free failures through, then asks for 2, 4, 8 … s', () => {
    const { limiter, advance } = failures();
    for (let i = 0; i < IP_RULE.free; i += 1) expect(limiter.fail('10.0.0.1')).toBeUndefined();
    expect(limiter.fail('10.0.0.1')).toEqual({ retryAfterSeconds: 2 });
    expect(limiter.fail('10.0.0.2')).toBeUndefined();
    advance(2000);
    expect(limiter.fail('10.0.0.1')).toBeUndefined();
    expect(limiter.fail('10.0.0.1')).toEqual({ retryAfterSeconds: 4 });
  });

  it('tells whether an IP is blocked without recording anything', () => {
    const { limiter, advance } = failures();
    expect(limiter.blocked('10.0.0.1')).toBeUndefined();
    for (let i = 0; i < IP_RULE.free; i += 1) limiter.fail('10.0.0.1');
    for (let i = 0; i < 10; i += 1)
      expect(limiter.blocked('10.0.0.1')).toEqual({ retryAfterSeconds: 2 });
    advance(2000);
    expect(limiter.blocked('10.0.0.1')).toBeUndefined();
    expect(limiter.size).toBe(1);
  });

  it('records nothing while blocked, so waiting is never made longer', () => {
    const { limiter, advance } = failures();
    for (let i = 0; i < IP_RULE.free; i += 1) limiter.fail('10.0.0.1');
    for (let i = 0; i < 50; i += 1)
      expect(limiter.fail('10.0.0.1')).toEqual({ retryAfterSeconds: 2 });
    advance(2000);
    expect(limiter.fail('10.0.0.1')).toBeUndefined();
  });

  it('never waits longer than 15 minutes, and forgets an IP after an hour', () => {
    const { limiter, advance } = failures();
    for (let i = 0; i < 60; i += 1) {
      const blocked = limiter.fail('10.0.0.1');
      if (blocked) {
        expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(IP_RULE.maxDelayMs / 1000);
        advance(blocked.retryAfterSeconds * 1000);
      }
    }
    advance(FORGET_AFTER_MS);
    expect(limiter.size).toBe(1);
    for (let i = 0; i < IP_RULE.free; i += 1) expect(limiter.fail('10.0.0.1')).toBeUndefined();
  });

  it('keeps at most maxEntries IPs, dropping the oldest', () => {
    const { limiter } = failures(100);
    for (let i = 0; i < 101; i += 1) limiter.fail(`10.0.${String(i >> 8)}.${String(i & 255)}`);
    expect(limiter.size).toBe(100);
  });

  it('keeps at most 100 000 IPs by default', () => {
    const { limiter } = failures();
    for (let i = 0; i < 100_001; i += 1)
      limiter.fail(`10.${String(i >> 16)}.${String((i >> 8) & 255)}.${String(i & 255)}`);
    expect(limiter.size).toBe(100_000);
  });
});

describe('AuthLimiters memory', () => {
  it('keeps at most 100 000 keys by default', () => {
    const { limiter } = setup();
    for (let i = 0; i < 100_001; i += 1) {
      finish(
        limiter.beginIp(`10.${String(i >> 16)}.${String((i >> 8) & 255)}.${String(i & 255)}`),
        false,
      );
    }
    expect(limiter.size).toBe(100_000);
  });
});

// A flood of other keys must never push a waiting key out of a full bucket.
describe('a full bucket never drops a key that is waiting', () => {
  const MAX = 50;
  const ip = (i: number) => `10.${String(i >> 8)}.${String(i & 255)}.1`;
  const login = (limiters: AuthLimiters, address: string, username: string, knownDevice = false) =>
    limiters.login(address, username, { knownDevice });
  /** Fails `username` from fresh IPs until it must wait. Returns the wait in seconds. */
  function block(limiters: AuthLimiters, username: string, from = 1000): number {
    for (let i = 0; i < LOGIN_USER_RULE.free; i++) failLogin(limiters, ip(from + i), username);
    const refused = login(limiters, ip(from + 999), username);
    if (refused.status !== 'blocked') throw new Error('expected a block');
    return refused.retryAfterSeconds;
  }

  it('keeps a blocked username through a flood of other usernames, and its count', () => {
    const { limiters, advance } = setup(MAX);
    expect(block(limiters, 'bob')).toBe(2);
    // The flood: 20 times the size of the bucket, each name once, fresh IPs.
    for (let i = 0; i < MAX * 20; i++) failLogin(limiters, ip(i), `flood${String(i)}`);
    expect(limiters.loginUser.size).toBe(MAX);
    expect(login(limiters, ip(5000), 'bob')).toMatchObject({ status: 'blocked' });
    // The wait ends; the count is still there, so the next wait is longer.
    advance(2000);
    for (let i = 0; i < MAX * 20; i++) failLogin(limiters, ip(i), `again${String(i)}`);
    failLogin(limiters, ip(5001), 'bob');
    expect(login(limiters, ip(5002), 'bob')).toMatchObject({
      status: 'blocked',
      retryAfterSeconds: 4,
    });
  });

  it('drops a key within its free attempts before one whose wait is over', () => {
    const { limiters, advance } = setup(3);
    block(limiters, 'waited'); // 2 s wait
    advance(3000); // over
    block(limiters, 'waiting', 2000);
    failLogin(limiters, ip(1), 'free');
    expect(limiters.loginUser.size).toBe(3);
    failLogin(limiters, ip(2), 'new');
    expect(limiters.loginUser.size).toBe(3);
    // `waited` kept its count: one more failure and the wait is the next step.
    failLogin(limiters, ip(3), 'waited');
    expect(login(limiters, ip(4), 'waited')).toMatchObject({
      status: 'blocked',
      retryAfterSeconds: 4,
    });
    expect(login(limiters, ip(4), 'waiting').status).toBe('blocked');
  });

  it('drops a key whose wait is over when no key is within its free attempts', () => {
    const { limiters, advance } = setup(2);
    block(limiters, 'waited');
    advance(3000);
    block(limiters, 'waiting', 2000);
    // Full, and neither is within its free attempts: `waited` makes room.
    expect(finish(login(limiters, ip(1), 'new'), false).status).toBe('allowed');
    expect(limiters.loginUser.size).toBe(2);
    expect(login(limiters, ip(2), 'waiting').status).toBe('blocked');
    // `waited` starts over (its hour was not up, but its wait was).
    expect(block(limiters, 'waited', 4000)).toBe(2);
  });

  it('login:user fails closed when every key is waiting: a new username is refused, nothing is recorded', () => {
    const { limiters, advance } = setup(3);
    for (const [index, name] of ['a', 'b', 'c'].entries())
      block(limiters, name, 1000 * (index + 1));
    const ipsBefore = limiters.loginIp.size;
    const refused = login(limiters, ip(1), 'newcomer');
    // Until the first of the three waits ends.
    expect(refused).toMatchObject({ status: 'blocked', retryAfterSeconds: 2 });
    expect(limiters.loginUser.size).toBe(3);
    expect(limiters.loginIp.size).toBe(ipsBefore);
    for (const name of ['a', 'b', 'c']) {
      expect(login(limiters, ip(2), name).status).toBe('blocked');
    }
    // A known device never touches the bucket.
    const known = login(limiters, ip(3), 'newcomer', true);
    expect(known.status).toBe('allowed');
    finish(known, true);
    // When a wait is over there is room again, without resetting the others.
    advance(2000);
    failLogin(limiters, ip(4), 'newcomer');
    expect(limiters.loginUser.size).toBe(3);
  });

  it('refusing in a full bucket never makes the stored waits shorter or longer', () => {
    const { limiters, advance } = setup(2);
    block(limiters, 'a');
    block(limiters, 'b', 3000);
    for (let i = 0; i < 100; i++) login(limiters, ip(i), `x${String(i)}`);
    advance(1999);
    expect(login(limiters, ip(1), 'a').status).toBe('blocked');
    advance(1);
    expect(login(limiters, ip(1), 'a').status).toBe('allowed');
  });

  it('totp:user and reauth:user fail closed too', () => {
    const { limiters } = setup(1);
    for (let i = 0; i <= TOTP_RULE.free; i++) finish(limiters.totpCode(1), false);
    expect(limiters.totpCode(1).status).toBe('blocked');
    expect(limiters.totpCode(2).status).toBe('blocked');
    for (let i = 0; i <= REAUTH_RULE.free; i++) finish(limiters.reauth.begin('id:1'), false);
    expect(limiters.reauth.begin('id:2').status).toBe('blocked');
  });

  it('login:ip and invite:ip fail open when every IP is waiting: a new IP is let through uncounted', () => {
    const { limiters, limiter } = setup(2);
    for (const address of ['10.0.0.1', '10.0.0.2']) {
      for (let i = 0; i <= IP_RULE.free; i++) finish(limiter.beginIp(address), false);
      expect(limiter.beginIp(address).status).toBe('blocked');
    }
    for (let i = 0; i < 100; i++) {
      expect(finish(limiter.beginIp(`10.1.0.${String(i)}`), false).status).toBe('allowed');
    }
    expect(limiter.size).toBe(2);
    expect(limiter.beginIp('10.0.0.1').status).toBe('blocked');
    expect(limiter.beginIp('10.0.0.2').status).toBe('blocked');
    for (let i = 0; i <= IP_RULE.free; i++) finish(limiters.invite('10.0.0.1'), false);
    for (let i = 0; i <= IP_RULE.free; i++) finish(limiters.invite('10.0.0.2'), false);
    expect(limiters.invite('10.0.0.3').status).toBe('allowed');
    expect(limiters.invite('10.0.0.1').status).toBe('blocked');
  });

  it('a login from a new IP still counts per username when login:ip is full', () => {
    const { limiters, limiter } = setup(2);
    for (const address of ['10.0.0.1', '10.0.0.2']) {
      for (let i = 0; i <= IP_RULE.free; i++) finish(limiter.beginIp(address), false);
    }
    for (let i = 0; i < LOGIN_USER_RULE.free; i++)
      failLogin(limiters, `10.2.0.${String(i)}`, 'bob');
    expect(limiters.login('10.3.0.1', 'bob', { knownDevice: false }).status).toBe('blocked');
  });

  it('the ingest limiter keeps blocked IPs through a flood, and lets new IPs through uncounted when all wait', () => {
    let now = Date.parse('2026-11-18T12:00:00.000Z');
    const limiter = new IpFailureLimiter({ now: () => new Date(now), maxEntries: 2 });
    for (let i = 0; i <= IP_RULE.free; i++) limiter.fail('10.0.0.1');
    for (let i = 0; i < 100; i++) limiter.fail(`10.1.0.${String(i)}`);
    expect(limiter.blocked('10.0.0.1')).toEqual({ retryAfterSeconds: 2 });
    for (let i = 0; i <= IP_RULE.free; i++) limiter.fail('10.0.0.2');
    // Both stored IPs wait: a new IP's failures are not counted.
    for (let i = 0; i < 100; i++) expect(limiter.fail('10.2.0.1')).toBeUndefined();
    expect(limiter.size).toBe(2);
    expect(limiter.blocked('10.0.0.1')).toBeDefined();
    expect(limiter.blocked('10.0.0.2')).toBeDefined();
    // Once a wait is over, the new IP is counted again.
    now += 2000;
    limiter.fail('10.2.0.1');
    expect(limiter.size).toBe(2);
    expect(limiter.blocked('10.0.0.1')).toBeUndefined();
  });
});

// A full bucket drops the key with the fewest failures first, so a flood of new
// names can't reset a name that is a few guesses short of its limit.
describe('a full bucket drops the key with the fewest failures first', () => {
  const ip = (i: number) => `10.${String(i >> 8)}.${String(i & 255)}.1`;
  let next = 0;
  const fail = (limiters: AuthLimiters, username: string, times = 1) => {
    for (let i = 0; i < times; i++) failLogin(limiters, ip((next += 1)), username);
  };
  const attempt = (limiters: AuthLimiters, username: string) =>
    limiters.login(ip((next += 1)), username, { knownDevice: false });
  /** Failures still free for `username`: counted by failing until refused. */
  function freeLeft(limiters: AuthLimiters, username: string): number {
    let count = 0;
    while (finish(attempt(limiters, username), false).status === 'allowed') count += 1;
    return count;
  }

  it('keeps a username at 9 failures through a flood of new names', () => {
    const { limiters } = setup(50);
    fail(limiters, 'bob', LOGIN_USER_RULE.free - 1);
    for (let i = 0; i < 5000; i++) fail(limiters, `flood${String(i)}`);
    expect(limiters.loginUser.size).toBe(50);
    // Still 9: one more failure is free, the next attempt must wait.
    expect(freeLeft(limiters, 'bob')).toBe(1);
  });

  it('keeps it too when the flood gives every name several failures, as long as they are fewer', () => {
    const { limiters } = setup(20);
    fail(limiters, 'bob', 9);
    for (let i = 0; i < 500; i++) fail(limiters, `flood${String(i)}`, 8);
    expect(freeLeft(limiters, 'bob')).toBe(1);
  });

  it('drops the oldest of the keys with the fewest failures', () => {
    const { limiters } = setup(4);
    fail(limiters, 'three', 3);
    fail(limiters, 'older', 1);
    fail(limiters, 'newer', 1);
    fail(limiters, 'two', 2);
    fail(limiters, 'x'); // drops `older`
    fail(limiters, 'y'); // drops `newer`
    fail(limiters, 'z'); // drops `x`
    expect(limiters.loginUser.size).toBe(4);
    // `three` and `two` kept their counts; `y` and `z` are the other two.
    expect(freeLeft(limiters, 'three')).toBe(LOGIN_USER_RULE.free - 3);
    expect(freeLeft(limiters, 'two')).toBe(LOGIN_USER_RULE.free - 2);
  });

  it('a key that fails again moves up, and is no longer the first to go', () => {
    const { limiters } = setup(2);
    fail(limiters, 'a');
    fail(limiters, 'b');
    fail(limiters, 'a'); // a: 2, b: 1
    fail(limiters, 'c'); // drops b
    expect(freeLeft(limiters, 'a')).toBe(LOGIN_USER_RULE.free - 2);
  });

  it('a success that takes a failure back moves the key down again', () => {
    const { limiters } = setup(2);
    fail(limiters, 'a', 2);
    fail(limiters, 'b', 2);
    finish(attempt(limiters, 'a'), true); // back to 2 after counting 3
    finish(attempt(limiters, 'b'), false); // b: 3
    fail(limiters, 'c'); // drops a (2), not b (3)
    expect(freeLeft(limiters, 'b')).toBe(LOGIN_USER_RULE.free - 3);
  });

  it('among keys whose wait is over, drops the one with the fewest failures', () => {
    const { limiters, advance } = setup(2);
    fail(limiters, 'twelve', 10);
    advance(2000);
    fail(limiters, 'twelve');
    advance(4000);
    fail(limiters, 'twelve'); // 12 failures, waits 8 s
    fail(limiters, 'ten', 10); // 10 failures, waits 2 s
    advance(8000); // both waits are over
    fail(limiters, 'new'); // drops `ten`, the newer but with fewer failures
    // `twelve` kept its count: the next failure gives a 16 s wait.
    fail(limiters, 'twelve');
    expect(attempt(limiters, 'twelve')).toMatchObject({ status: 'blocked', retryAfterSeconds: 16 });
  });

  it('never drops a waiting key, whatever its count, to keep one with more failures', () => {
    const { limiters } = setup(2);
    fail(limiters, 'waiting', 10); // waits 2 s
    fail(limiters, 'nine', 9);
    fail(limiters, 'new'); // drops `nine`: the only key that isn't waiting
    expect(attempt(limiters, 'waiting').status).toBe('blocked');
    expect(limiters.loginUser.size).toBe(2);
  });
});

// A block is reported once, not once per refused attempt.
describe('firstRefusal: a wait is reported once', () => {
  const refusal = (attempt: Attempt) =>
    attempt.status === 'blocked' ? attempt.firstRefusal : null;

  it('is true for the first refusal of a wait and false for the rest of it', () => {
    const { limiters, advance } = setup();
    const begin = () => limiters.loginIp.begin('10.0.0.1');
    for (let i = 0; i < IP_RULE.free; i++) finish(begin(), false);
    expect(refusal(begin())).toBe(true);
    for (let i = 0; i < 50; i++) expect(refusal(begin())).toBe(false);
    // The wait ends, a new failure starts the next wait: reported again, once.
    advance(2000);
    expect(finish(begin(), false).status).toBe('allowed');
    expect(refusal(begin())).toBe(true);
    expect(refusal(begin())).toBe(false);
  });

  it('is per key: another IP in its own wait is reported too', () => {
    const { limiters } = setup();
    for (const address of ['10.0.0.1', '10.0.0.2']) {
      for (let i = 0; i < IP_RULE.free; i++) finish(limiters.loginIp.begin(address), false);
    }
    expect(refusal(limiters.loginIp.begin('10.0.0.1'))).toBe(true);
    expect(refusal(limiters.loginIp.begin('10.0.0.2'))).toBe(true);
    expect(refusal(limiters.loginIp.begin('10.0.0.1'))).toBe(false);
  });

  it('a blocked username is reported once, whichever IPs keep trying', () => {
    const { limiters } = setup();
    for (let i = 0; i < LOGIN_USER_RULE.free; i++)
      failLogin(limiters, `10.0.1.${String(i)}`, 'bob');
    const from = (address: string) => limiters.login(address, 'bob', { knownDevice: false });
    expect(refusal(from('10.0.2.1'))).toBe(true);
    for (let i = 0; i < 20; i++) expect(refusal(from(`10.0.3.${String(i)}`))).toBe(false);
  });

  it('with two buckets refusing, each wait is reported once', () => {
    const { limiters } = setup();
    for (let i = 0; i < IP_RULE.free; i++) failLogin(limiters, '10.0.0.1', `name${String(i)}`);
    for (let i = 0; i < LOGIN_USER_RULE.free; i++)
      failLogin(limiters, `10.0.1.${String(i)}`, 'bob');
    // The IP and the username both wait: one report covers both.
    expect(refusal(limiters.login('10.0.0.1', 'bob', { knownDevice: false }))).toBe(true);
    expect(refusal(limiters.login('10.0.0.1', 'other', { knownDevice: false }))).toBe(false);
    expect(refusal(limiters.login('10.0.9.9', 'bob', { knownDevice: false }))).toBe(false);
  });

  it('works the same for the per-user buckets', () => {
    const { limiters } = setup();
    for (let i = 0; i < TOTP_RULE.free; i++) finish(limiters.totpCode(7), false);
    expect(refusal(limiters.totpCode(7))).toBe(true);
    expect(refusal(limiters.totpCode(7))).toBe(false);
    expect(refusal(limiters.totpLogin('10.0.0.1', 7))).toBe(false);
  });

  it('a full bucket that refuses new keys is reported once until its first wait ends', () => {
    const { limiters, advance } = setup(1);
    for (let i = 0; i < LOGIN_USER_RULE.free; i++)
      failLogin(limiters, `10.0.1.${String(i)}`, 'bob');
    failLogin(limiters, '10.0.1.99', 'bob');
    const stranger = (i: number) =>
      limiters.login(`10.0.2.${String(i)}`, `new${String(i)}`, { knownDevice: false });
    expect(refusal(stranger(1))).toBe(true);
    for (let i = 2; i < 30; i++) expect(refusal(stranger(i))).toBe(false);
    advance(2000);
    // bob's wait is over, so there is room: the new name is let in.
    expect(stranger(31).status).toBe('allowed');
  });
});
