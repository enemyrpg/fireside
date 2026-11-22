import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, activeSourceProblems, assertScratchEnv, scratchEnv } from './scratch-server.ts';

const DIR = '/tmp/scratch-test/db';

describe('scratchEnv', () => {
  it('takes nothing of the server configuration from the caller', () => {
    const env = scratchEnv(
      DIR,
      4010,
      {},
      {
        PATH: '/usr/bin',
        PRICES_ENABLED: 'true',
        RUNEPROFILE_ENABLED: 'true',
        RUNEPROFILE_API_KEY: 'secret',
        USER_AGENT_CONTACT: 'someone@example.com',
        DATA_DIR: 'data',
        PORT: '3100',
        PUBLIC_URL: 'https://example.com',
        SOMETHING_ELSE: 'x',
      },
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.PRICES_ENABLED).toBe('false');
    expect(env.RUNEPROFILE_ENABLED).toBe('false');
    expect(env.RUNEPROFILE_API_KEY).toBe('');
    expect(env.USER_AGENT_CONTACT).toBe('');
    expect(env.PUBLIC_URL).toBe('');
    expect(env.DATA_DIR).toBe(DIR);
    expect(env.PORT).toBe('4010');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.SOMETHING_ELSE).toBeUndefined();
  });

  it('preloads the module that keeps .env from being read', () => {
    expect(scratchEnv(DIR, 4010).NODE_OPTIONS).toMatch(/--import file:.*no-env-file\.ts$/);
  });

  it('passes its own guard', () => {
    expect(() => {
      assertScratchEnv(scratchEnv(DIR, 4010));
    }).not.toThrow();
  });
});

describe('assertScratchEnv', () => {
  const good = () => scratchEnv(DIR, 4010);

  it.each([
    ['PRICES_ENABLED', 'true'],
    ['RUNEPROFILE_ENABLED', 'true'],
    ['USER_AGENT_CONTACT', 'someone@example.com'],
    ['RUNEPROFILE_API_KEY', 'secret'],
    ['PUBLIC_URL', 'https://example.com'],
    ['HOST', '0.0.0.0'],
    ['PORT', '3100'],
    ['NODE_OPTIONS', ''],
  ])('refuses %s=%s', (name, value) => {
    expect(() => {
      assertScratchEnv({ ...good(), [name]: value });
    }).toThrow(/nothing was started/);
  });

  it.each(['PRICES_ENABLED', 'RUNEPROFILE_ENABLED', 'USER_AGENT_CONTACT', 'DATA_DIR'])(
    'refuses a missing %s (the server default or .env would decide)',
    (name) => {
      const env = Object.fromEntries(Object.entries(good()).filter(([key]) => key !== name));
      expect(() => {
        assertScratchEnv(env);
      }).toThrow(/nothing was started/);
    },
  );

  it.each(['data', 'data-dev', 'data-seed', 'data/sub'])('refuses the real folder %s', (dir) => {
    expect(() => {
      assertScratchEnv({ ...good(), DATA_DIR: join(REPO_ROOT, dir) });
    }).toThrow(/DATA_DIR must not be/);
    expect(() => {
      assertScratchEnv({ ...good(), DATA_DIR: dir });
    }).toThrow(/DATA_DIR must not be/);
  });

  it('allows another folder whose name only starts the same', () => {
    expect(() => {
      assertScratchEnv({ ...good(), DATA_DIR: join(REPO_ROOT, 'data-scratch') });
    }).not.toThrow();
  });
});

describe('activeSourceProblems', () => {
  const off = { enabled: false, active: false };

  it('is empty when everything is off', () => {
    expect(
      activeSourceProblems({
        contactSet: false,
        sources: [
          { id: 'WIKI_PRICES', ...off },
          { id: 'RUNEPROFILE', ...off },
        ],
      }),
    ).toEqual([]);
  });

  it('names a contact and every source that is on', () => {
    expect(
      activeSourceProblems({
        contactSet: true,
        sources: [
          { id: 'WIKI_PRICES', enabled: true, active: true },
          { id: 'RUNEPROFILE', enabled: true, active: false },
        ],
      }),
    ).toEqual(['USER_AGENT_CONTACT is set', 'WIKI_PRICES is on', 'RUNEPROFILE is on']);
  });
});
