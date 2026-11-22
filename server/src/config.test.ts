import { BRANDING } from '@fireside/shared';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalTimeZone, ConfigError, ENV_NAMES, loadConfig } from './config.js';
import { REPO_ROOT } from './paths.js';

const N = BRANDING.shortName;

describe('loadConfig', () => {
  it('uses defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3100,
      timeZone: 'UTC',
      dataDir: resolve(REPO_ROOT, 'data'),
      logLevel: 'info',
      backup: {
        dir: resolve(REPO_ROOT, 'data', 'backups'),
        enabled: true,
        time: { hour: 4, minute: 0 },
        keep: { daily: 7, weekly: 4, monthly: 6 },
      },
      userAgentContact: null,
      publicUrl: null,
      trustedProxy: null,
      maxUsers: null,
      prices: { enabled: false },
      runeprofile: { enabled: false, apiKey: null },
    });
  });

  it('binds to 127.0.0.1 by default, also when HOST is empty', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1');
    expect(loadConfig({ HOST: '' }).host).toBe('127.0.0.1');
    expect(loadConfig({ HOST: '   ' }).host).toBe('127.0.0.1');
  });

  it('treats empty values as unset', () => {
    expect(
      loadConfig({
        PORT: '',
        TZ: '',
        DATA_DIR: '',
        LOG_LEVEL: '',
        USER_AGENT_CONTACT: '',
        PRICES_ENABLED: '',
        BACKUP_DIR: '',
        BACKUP_ENABLED: '',
        BACKUP_TIME: '',
        BACKUP_KEEP_DAILY: '',
      }),
    ).toEqual(loadConfig({}));
  });

  it('reads every variable', () => {
    expect(
      loadConfig({
        HOST: '0.0.0.0',
        PORT: '8080',
        TZ: 'Europe/Oslo',
        DATA_DIR: '/var/lib/tracker',
        LOG_LEVEL: 'debug',
        USER_AGENT_CONTACT: 'you@example.com',
        PUBLIC_URL: 'https://App.Example.com/',
        TRUSTED_PROXY: 'cloudflare',
        MAX_USERS: '10',
        PRICES_ENABLED: 'true',
        RUNEPROFILE_ENABLED: 'true',
        RUNEPROFILE_API_KEY: 'rp_test-key',
        BACKUP_DIR: `/mnt/backup/${N}`,
        BACKUP_ENABLED: 'false',
        BACKUP_TIME: '23:45',
        BACKUP_KEEP_DAILY: '3',
        BACKUP_KEEP_WEEKLY: '0',
        BACKUP_KEEP_MONTHLY: '12',
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 8080,
      timeZone: 'Europe/Oslo',
      dataDir: '/var/lib/tracker',
      logLevel: 'debug',
      backup: {
        dir: `/mnt/backup/${N}`,
        enabled: false,
        time: { hour: 23, minute: 45 },
        keep: { daily: 3, weekly: 0, monthly: 12 },
      },
      userAgentContact: 'you@example.com',
      publicUrl: 'https://app.example.com',
      trustedProxy: 'cloudflare',
      maxUsers: 10,
      prices: { enabled: true },
      runeprofile: { enabled: true, apiKey: 'rp_test-key' },
    });
  });

  it('accepts TRUSTED_PROXY=cloudflare with an https PUBLIC_URL', () => {
    expect(
      loadConfig({ TRUSTED_PROXY: 'cloudflare', PUBLIC_URL: 'https://app.example.com' })
        .trustedProxy,
    ).toBe('cloudflare');
    expect(loadConfig({ TRUSTED_PROXY: ' ' }).trustedProxy).toBeNull();
  });

  it.each([
    [
      { TRUSTED_PROXY: 'nginx', PUBLIC_URL: 'https://app.example.com' },
      /TRUSTED_PROXY: Must be cloudflare/,
    ],
    [{ TRUSTED_PROXY: 'Cloudflare', PUBLIC_URL: 'https://app.example.com' }, /TRUSTED_PROXY/],
    [{ TRUSTED_PROXY: 'cloudflare' }, /TRUSTED_PROXY: Needs PUBLIC_URL set to an https URL/],
    [
      { TRUSTED_PROXY: 'cloudflare', PUBLIC_URL: 'http://localhost:3100' },
      /TRUSTED_PROXY: Needs PUBLIC_URL set to an https URL/,
    ],
  ])('rejects TRUSTED_PROXY in %o', (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });

  it('accepts MAX_USERS as a positive whole number', () => {
    expect(loadConfig({ MAX_USERS: '1' }).maxUsers).toBe(1);
    for (const value of ['0', '-1', '2.5', 'ten']) {
      expect(() => loadConfig({ MAX_USERS: value })).toThrow(/MAX_USERS/);
    }
  });

  it('accepts PUBLIC_URL as an https origin, or http on a loopback host', () => {
    const publicUrl = (value: string) => loadConfig({ PUBLIC_URL: value }).publicUrl;
    expect(publicUrl('https://app.example.com')).toBe('https://app.example.com');
    expect(publicUrl('https://app.example.com:8443/')).toBe('https://app.example.com:8443');
    expect(publicUrl('http://localhost:3100')).toBe('http://localhost:3100');
    expect(publicUrl('http://127.0.0.1:3100')).toBe('http://127.0.0.1:3100');
    expect(publicUrl('http://[::1]:3100')).toBe('http://[::1]:3100');
    expect(loadConfig({ PUBLIC_URL: '  ' }).publicUrl).toBeNull();
  });

  it.each([
    ['http://app.example.com', /PUBLIC_URL: Must use https:\/\/ .*Secure/],
    ['http://192.168.1.10:3100', /PUBLIC_URL: Must use https:\/\//],
    ['http://localhost.example.com', /PUBLIC_URL: Must use https:\/\//],
    ['ftp://app.example.com', /PUBLIC_URL: Must start with https:\/\//],
    ['app.example.com', /PUBLIC_URL: Must be a URL/],
    ['https://app.example.com/dashboard', /PUBLIC_URL: Must be only the scheme and host/],
    ['https://app.example.com/?x=1', /PUBLIC_URL: Must be only the scheme and host/],
    ['https://user:pw@app.example.com', /PUBLIC_URL: Must be only the scheme and host/],
  ])('refuses PUBLIC_URL=%s', (value, message) => {
    expect(() => loadConfig({ PUBLIC_URL: value })).toThrow(ConfigError);
    expect(() => loadConfig({ PUBLIC_URL: value })).toThrow(message);
  });

  it('ignores unrelated variables', () => {
    expect(loadConfig({ PATH: '/usr/bin', HOME: '/home/x' })).toEqual(loadConfig({}));
  });

  it.each(['true', 'false', 'yes', ''])(
    'ignores a leftover LOG_PROXY_HEADER_NAMES=%j from an old .env (the variable was removed)',
    (value) => {
      expect(loadConfig({ LOG_PROXY_HEADER_NAMES: value })).toEqual(loadConfig({}));
      expect(ENV_NAMES).not.toContain('LOG_PROXY_HEADER_NAMES');
    },
  );

  it('resolves a relative DATA_DIR from the repo root, not the working directory', () => {
    expect(REPO_ROOT).toBe(resolve(import.meta.dirname, '../..') + '/');
    expect(loadConfig({ DATA_DIR: 'some/dir' }).dataDir).toBe(resolve(REPO_ROOT, 'some/dir'));
    expect(loadConfig({ DATA_DIR: './data' }, '/srv/tracker').dataDir).toBe('/srv/tracker/data');
    expect(loadConfig({}, '/srv/tracker').dataDir).toBe('/srv/tracker/data');
  });

  it('keeps an absolute DATA_DIR as is', () => {
    expect(loadConfig({ DATA_DIR: '/var/lib/x' }, '/srv/tracker').dataDir).toBe('/var/lib/x');
  });

  it('puts backups under DATA_DIR by default, and resolves a relative BACKUP_DIR from the repo root', () => {
    expect(loadConfig({ DATA_DIR: '/var/lib/x' }).backup.dir).toBe('/var/lib/x/backups');
    expect(loadConfig({ DATA_DIR: 'd' }, '/srv/f').backup.dir).toBe('/srv/f/d/backups');
    expect(loadConfig({ BACKUP_DIR: './b' }, '/srv/f').backup.dir).toBe('/srv/f/b');
  });

  it.each([
    ['0:05', { hour: 0, minute: 5 }],
    ['04:00', { hour: 4, minute: 0 }],
    ['23:59', { hour: 23, minute: 59 }],
  ])('reads BACKUP_TIME=%s', (value, expected) => {
    expect(loadConfig({ BACKUP_TIME: value }).backup.time).toEqual(expected);
  });

  it('accepts ports 1 to 65535', () => {
    expect(loadConfig({ PORT: '1' }).port).toBe(1);
    expect(loadConfig({ PORT: '65535' }).port).toBe(65535);
  });

  it.each([
    ['europe/oslo', 'Europe/Oslo'],
    ['utc', 'UTC'],
    ['Etc/UTC', 'UTC'],
    ['US/Eastern', 'America/New_York'],
  ])('stores TZ=%s as %s', (value, expected) => {
    expect(loadConfig({ TZ: value }).timeZone).toBe(expected);
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['PORT', '1e3'],
    ['PORT', '-1'],
    ['PORT', '80.5'],
    ['PORT', '0080'],
    ['PORT', '0'],
    ['TZ', 'Mars/Base'],
    ['TZ', '+01:00'],
    ['TZ', '-0500'],
    ['LOG_LEVEL', 'loud'],
    ['BACKUP_ENABLED', 'yes'],
    ['PRICES_ENABLED', 'yes'],
    ['PRICES_ENABLED', '1'],
    ['BACKUP_TIME', '24:00'],
    ['BACKUP_TIME', '4'],
    ['BACKUP_TIME', '04:60'],
    ['BACKUP_TIME', '4am'],
    ['BACKUP_KEEP_DAILY', '-1'],
    ['BACKUP_KEEP_WEEKLY', 'many'],
  ])('rejects %s=%s and names the variable', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(ConfigError);
    expect(() => loadConfig({ [name]: value })).toThrow(new RegExp(`\\b${name}\\b`));
  });

  it('accepts an email address or URL as USER_AGENT_CONTACT', () => {
    for (const contact of [
      'you@example.com',
      'https://example.com/contact',
      'mailto:you@example.com',
    ]) {
      expect(loadConfig({ USER_AGENT_CONTACT: contact }).userAgentContact).toBe(contact);
    }
  });

  it.each(['two words', 'a(b)', 'line\nbreak', 'tab\there', 'me\\', 'say"hi'])(
    'rejects USER_AGENT_CONTACT %j',
    (value) => {
      expect(() => loadConfig({ USER_AGENT_CONTACT: value })).toThrow(/\bUSER_AGENT_CONTACT\b/);
    },
  );

  it('lists every invalid variable in one error', () => {
    try {
      loadConfig({ PORT: 'abc', TZ: 'Mars/Base' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toMatch(/\bPORT\b/);
      expect(message).toMatch(/\bTZ\b/);
    }
  });
});

describe('.env.example', () => {
  const example = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');

  it.each(ENV_NAMES)('documents %s', (name) => {
    // Set (`NAME=`) or shown commented out (`# NAME=`), at the start of a line.
    expect(example).toMatch(new RegExp(`^(# )?${name}=`, 'm'));
  });

  it('keeps external sources off', () => {
    expect(example).not.toMatch(/^PRICES_ENABLED=true/m);
    expect(example).not.toMatch(/^USER_AGENT_CONTACT=/m);
  });

  it('keeps the tunnel off', () => {
    expect(example).not.toMatch(/^TRUSTED_PROXY=/m);
    expect(example).not.toMatch(/^PUBLIC_URL=/m);
    expect(example).not.toMatch(/^COMPOSE_PROFILES=/m);
    // A variable that no longer exists.
    expect(example).not.toMatch(/LOG_PROXY_HEADER_NAMES/);
    // The token lives in a file, never in .env.
    expect(example).not.toMatch(/^#? ?TUNNEL_TOKEN=/m);
  });
});

describe('canonicalTimeZone', () => {
  it('returns the standard name, or undefined for offsets and unknown zones', () => {
    expect(canonicalTimeZone('Europe/Oslo')).toBe('Europe/Oslo');
    expect(canonicalTimeZone('+01:00')).toBeUndefined();
    expect(canonicalTimeZone('Mars/Base')).toBeUndefined();
  });
});
