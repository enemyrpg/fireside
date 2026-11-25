import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOG_FILE,
  PID_FILE,
  REPO_ROOT,
  activeSourceProblems,
  assertScratchEnv,
  externalRequestLines,
  scratchEnv,
  spawnRecorded,
  stopServer,
} from './scratch-server.ts';

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

  it('logs at info, where external requests are logged', () => {
    expect(scratchEnv(DIR, 4010).LOG_LEVEL).toBe('info');
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

describe('externalRequestLines', () => {
  it('finds external requests that worked or failed, and nothing else', () => {
    const log = [
      '{"level":30,"msg":"Server listening"}',
      '{"level":30,"source":"WIKI_PRICES","msg":"External request done"}',
      '{"level":40,"source":"RUNEPROFILE","msg":"External request failed"}',
      '',
    ].join('\n');
    expect(externalRequestLines(log)).toEqual([
      '{"level":30,"source":"WIKI_PRICES","msg":"External request done"}',
      '{"level":40,"source":"RUNEPROFILE","msg":"External request failed"}',
    ]);
    expect(externalRequestLines('{"msg":"Server listening"}\n')).toEqual([]);
  });
});

describe('spawnRecorded', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('records the PID at once, logs to the data folder, and removes the PID file on exit', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'scratch-pid-')), 'db');
    dirs.push(join(dir, '..'));
    // A stand-in for the server: logs one line, then waits to be stopped.
    const child = spawnRecorded(dir, { PATH: process.env.PATH ?? '' }, [
      '-e',
      'console.log(JSON.stringify({ msg: "Server listening" })); setInterval(() => {}, 1000);',
    ]);
    expect(readFileSync(join(dir, PID_FILE), 'utf8')).toBe(`${String(child.pid)}\n`);
    for (
      let i = 0;
      i < 100 && !readFileSync(join(dir, LOG_FILE), 'utf8').includes('listening');
      i++
    ) {
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(readFileSync(join(dir, LOG_FILE), 'utf8')).toContain('Server listening');

    await stopServer(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(existsSync(join(dir, PID_FILE))).toBe(false);
  });
});
