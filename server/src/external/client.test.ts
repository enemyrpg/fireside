import { describe, expect, it } from 'vitest';
import { testConfig } from '../test-utils.js';
import { SERVER_VERSION } from '../version.js';
import {
  createExternalClient,
  ExternalDisabledError,
  ExternalRequestError,
  retryAfterMs,
} from './client.js';
import { EXTERNAL_SOURCES, isSourceActive } from './sources.js';

// No real network: every test passes its own fetch.

const ON = { PRICES_ENABLED: 'true', USER_AGENT_CONTACT: 'you@example.com' };
const PATH = '/api/v2/osrs/latest';
const { origin, minIntervalMs, maxBytes } = EXTERNAL_SOURCES.WIKI_PRICES;

type Reply = Response | Error | (() => Response | Promise<Response>);

const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

/** A client with a scripted fetch, a clock that only moves when the client sleeps, and captured logs. */
function setup(replies: Reply[], env: Record<string, string> = ON) {
  let nowMs = Date.parse('2026-11-16T12:00:00.000Z');
  const calls: { url: string; init: RequestInit; at: number }[] = [];
  const sleeps: number[] = [];
  const logs: { level: string; obj: object; msg: string }[] = [];
  const log = (level: string) => (obj: object, msg: string) => {
    logs.push({ level, obj, msg });
  };
  const fetchMock = ((url: string, init: RequestInit) => {
    calls.push({ url, init, at: nowMs });
    const reply = replies.shift();
    if (reply === undefined) return Promise.reject(new Error('No reply scripted'));
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(typeof reply === 'function' ? reply() : reply);
  }) as unknown as typeof fetch;
  const client = createExternalClient({
    config: testConfig(env),
    log: { info: log('info'), warn: log('warn'), error: log('error') },
    fetch: fetchMock,
    now: () => new Date(nowMs),
    sleep: (ms) => {
      sleeps.push(ms);
      nowMs += ms;
      return Promise.resolve();
    },
    random: () => 0,
  });
  return { client, calls, sleeps, logs };
}

const networkError = (code: string) =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

describe('isSourceActive', () => {
  it.each([
    [{}, false],
    [{ PRICES_ENABLED: 'true' }, false],
    [{ USER_AGENT_CONTACT: 'you@example.com' }, false],
    [{ PRICES_ENABLED: 'false', USER_AGENT_CONTACT: 'you@example.com' }, false],
    [ON, true],
  ])('%j → %s', (env, expected) => {
    expect(isSourceActive(testConfig(env), 'WIKI_PRICES')).toBe(expected);
  });
});

describe('external client', () => {
  it.each([
    ['nothing is set', {}],
    ['only the flag is set', { PRICES_ENABLED: 'true' }],
    ['only the contact is set', { USER_AGENT_CONTACT: 'you@example.com' }],
  ])('makes no request when %s', async (_name, env) => {
    const { client, calls } = setup([json({})], env);
    await expect(client.getJson('WIKI_PRICES', PATH)).rejects.toThrow(ExternalDisabledError);
    expect(calls).toEqual([]);
  });

  it('sends one GET to the source origin with the User-Agent, a timeout and no redirects', async () => {
    const { client, calls } = setup([json({ ok: true })]);
    expect(await client.getJson('WIKI_PRICES', PATH)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] ?? {};
    expect(url).toBe(`${origin}${PATH}`);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.body).toBeUndefined();
    const headers = init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(
      new RegExp(`^\\w+/${SERVER_VERSION.replaceAll('.', '\\.')} \\(\\+you@example\\.com\\)$`),
    );
    expect(Object.keys(headers).sort()).toEqual(['Accept', 'User-Agent']);
  });

  it.each(['latest', '//evil.example/latest', 'https://evil.example/latest', '/\\evil.example'])(
    'refuses the path %j without a request',
    async (path) => {
      const { client, calls } = setup([json({})]);
      await expect(client.getJson('WIKI_PRICES', path)).rejects.toThrow(ExternalRequestError);
      expect(calls).toEqual([]);
    },
  );

  it('retries a 5xx and a network error with backoff, then succeeds', async () => {
    const { client, calls, sleeps } = setup([
      new Response('down', { status: 503 }),
      networkError('ECONNRESET'),
      json({ ok: true }),
    ]);
    expect(await client.getJson('WIKI_PRICES', PATH)).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    // Backoff 2 s and 8 s, then the rest of the 10 s gap between requests.
    expect(sleeps).toEqual([2_000, minIntervalMs - 2_000, 8_000, minIntervalMs - 8_000]);
  });

  it('gives up after three attempts, with a message built from the status', async () => {
    const { client, calls } = setup([
      new Response('secret body', { status: 500 }),
      new Response('secret body', { status: 502 }),
      new Response('secret body', { status: 503 }),
    ]);
    const error = await client.getJson('WIKI_PRICES', PATH).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalRequestError);
    expect((error as ExternalRequestError).message).toBe('HTTP 503');
    expect((error as ExternalRequestError).status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it.each([400, 401, 403, 404])('does not retry a %i', async (status) => {
    const { client, calls } = setup([new Response('', { status }), json({})]);
    await expect(client.getJson('WIKI_PRICES', PATH)).rejects.toThrow(`HTTP ${String(status)}`);
    expect(calls).toHaveLength(1);
  });

  it('waits as long as a 429 asks with Retry-After', async () => {
    const { client, calls, sleeps } = setup([
      new Response('', { status: 429, headers: { 'Retry-After': '30' } }),
      json({ ok: true }),
    ]);
    expect(await client.getJson('WIKI_PRICES', PATH)).toEqual({ ok: true });
    expect(sleeps).toEqual([30_000]);
    expect(calls).toHaveLength(2);
  });

  it('gives up when Retry-After is longer than a minute', async () => {
    const { client, calls } = setup([
      new Response('', { status: 429, headers: { 'Retry-After': '3600' } }),
      json({}),
    ]);
    await expect(client.getJson('WIKI_PRICES', PATH)).rejects.toThrow('HTTP 429');
    expect(calls).toHaveLength(1);
  });

  it('retries a timeout and reports it without the URL', async () => {
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    const { client, calls } = setup([timeout, timeout, timeout]);
    await expect(client.getJson('WIKI_PRICES', PATH)).rejects.toThrow('No response within 15 s');
    expect(calls).toHaveLength(3);
  });

  it('reports a network error by its code only', async () => {
    const odd = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect to 10.0.0.1 with key abc'), { code: 'not a code' }),
    });
    const { client } = setup([odd, networkError('ENOTFOUND'), networkError('ENOTFOUND')]);
    await expect(client.getJson('WIKI_PRICES', PATH)).rejects.toThrow(
      /^Network error \(ENOTFOUND\)$/,
    );
    const second = setup([odd, odd, odd]);
    await expect(second.client.getJson('WIKI_PRICES', PATH)).rejects.toThrow(/^Network error$/);
  });

  it('refuses a response over the size limit, declared or not, without a retry', async () => {
    const declared = setup([
      new Response('{}', { headers: { 'Content-Length': String(maxBytes + 1) } }),
    ]);
    await expect(declared.client.getJson('WIKI_PRICES', PATH)).rejects.toThrow(/larger than/);
    expect(declared.calls).toHaveLength(1);

    const streamed = setup([new Response(`"${'x'.repeat(maxBytes)}"`)]);
    await expect(streamed.client.getJson('WIKI_PRICES', PATH)).rejects.toThrow(/larger than/);
    expect(streamed.calls).toHaveLength(1);
  });

  it('refuses a body that is not JSON, without a retry', async () => {
    const { client, calls } = setup([new Response('<html>'), json({})]);
    await expect(client.getJson('WIKI_PRICES', PATH)).rejects.toThrow('not valid JSON');
    expect(calls).toHaveLength(1);
  });

  it('keeps the gap between requests to one source, also for calls made at once', async () => {
    const { client, calls } = setup([json(1), json(2), json(3)]);
    const results = await Promise.all([
      client.getJson('WIKI_PRICES', PATH),
      client.getJson('WIKI_PRICES', PATH),
      client.getJson('WIKI_PRICES', PATH),
    ]);
    expect(results).toEqual([1, 2, 3]);
    const start = calls[0]?.at ?? 0;
    expect(calls.map((call) => call.at - start)).toEqual([0, minIntervalMs, 2 * minIntervalMs]);
  });

  it('goes on with the next call after a failed one', async () => {
    const { client } = setup([new Response('', { status: 404 }), json({ ok: true })]);
    await expect(client.getJson('WIKI_PRICES', PATH)).rejects.toThrow('HTTP 404');
    expect(await client.getJson('WIKI_PRICES', PATH)).toEqual({ ok: true });
  });

  it('logs the source, path, status, attempt and time, never headers, queries or bodies', async () => {
    const { client, logs } = setup([
      new Response('body-secret', { status: 500 }),
      json({ value: 'body-secret' }),
    ]);
    await client.getJson('WIKI_PRICES', `${PATH}?token=query-secret`);
    expect(logs.map((entry) => [entry.level, entry.msg, entry.obj])).toEqual([
      [
        'warn',
        'External request failed',
        {
          source: 'WIKI_PRICES',
          method: 'GET',
          url: `${origin}${PATH}`,
          status: 500,
          attempt: 1,
          durationMs: 0,
          reason: 'HTTP 500',
        },
      ],
      [
        'info',
        'External request done',
        {
          source: 'WIKI_PRICES',
          method: 'GET',
          url: `${origin}${PATH}`,
          status: 200,
          attempt: 2,
          durationMs: 0,
          bytes: 23,
        },
      ],
    ]);
    const output = JSON.stringify(logs);
    for (const secret of ['you@example.com', 'query-secret', 'body-secret', 'User-Agent']) {
      expect(output).not.toContain(secret);
    }
  });
});

describe('getText', () => {
  it('gives the body exactly as received, and its JSON', async () => {
    const body = '{ "b": 1,\n  "a": [ 2 ] }\n';
    const { client } = setup([new Response(body)]);
    expect(await client.getText('WIKI_PRICES', PATH)).toEqual({
      text: body,
      json: { b: 1, a: [2] },
    });
  });

  it('marks a body that cannot be used, apart from a failed request', async () => {
    const { client } = setup([
      new Response('<html>'),
      new Response('x'.repeat(maxBytes + 1)),
      new Response('', { status: 404 }),
    ]);
    const failure = (path: string) =>
      client.getText('WIKI_PRICES', path).then(
        () => null,
        (error: unknown) => error as ExternalRequestError,
      );
    expect(await failure(PATH)).toMatchObject({ status: 200, invalidBody: true });
    expect(await failure(PATH)).toMatchObject({ status: null, invalidBody: true });
    expect(await failure(PATH)).toMatchObject({ status: 404, invalidBody: false });
  });
});

describe('a source with its own headers', () => {
  const RUNEPROFILE = { RUNEPROFILE_ENABLED: 'true', USER_AGENT_CONTACT: 'you@example.com' };
  const PROFILE = '/v1/accounts/Seed%20Main/collection-log';

  it('sends X-API-Key only when a key is set, and never logs it', async () => {
    const without = setup([json({})], RUNEPROFILE);
    await without.client.getJson('RUNEPROFILE', PROFILE);
    expect(Object.keys(without.calls[0]?.init.headers as object).sort()).toEqual([
      'Accept',
      'User-Agent',
    ]);

    const withKey = setup([new Response('', { status: 401 })], {
      ...RUNEPROFILE,
      RUNEPROFILE_API_KEY: 'rp_secret-key',
    });
    // A refused key is not tried again.
    await expect(withKey.client.getJson('RUNEPROFILE', PROFILE)).rejects.toThrow('HTTP 401');
    expect(withKey.calls).toHaveLength(1);
    const headers = withKey.calls[0]?.init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('rp_secret-key');
    expect(headers['User-Agent']).toContain('(+you@example.com)');
    expect(withKey.calls[0]?.url).toBe(`https://api.runeprofile.com${PROFILE}`);
    expect(JSON.stringify(withKey.logs)).not.toContain('rp_secret-key');
  });

  it('never logs the OSRS display name in the path', async () => {
    const { client, calls, logs } = setup(
      [json({}), new Response('', { status: 404 })],
      RUNEPROFILE,
    );
    await client.getJson('RUNEPROFILE', '/v1/accounts/Seed%20Main');
    await expect(client.getJson('RUNEPROFILE', PROFILE)).rejects.toThrow('HTTP 404');
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.runeprofile.com/v1/accounts/Seed%20Main',
      `https://api.runeprofile.com${PROFILE}`,
    ]);
    const logged = JSON.stringify(logs);
    expect(logged).not.toMatch(/Seed/);
    expect(logs.map((entry) => (entry.obj as { url?: string }).url)).toEqual([
      'https://api.runeprofile.com/v1/accounts/<name>',
      'https://api.runeprofile.com/v1/accounts/<name>/collection-log',
    ]);
  });

  it('is off without its own flag, whatever other sources are on', async () => {
    const { client, calls } = setup([json({})]);
    await expect(client.getJson('RUNEPROFILE', PROFILE)).rejects.toThrow(ExternalDisabledError);
    expect(calls).toEqual([]);
  });
});

describe('retryAfterMs', () => {
  const now = Date.parse('2026-11-16T12:00:00.000Z');
  it.each([
    [null, null],
    ['30', 30_000],
    ['0', 0],
    ['Mon, 16 Nov 2026 12:00:45 GMT', 45_000],
    ['Mon, 16 Nov 2026 11:00:00 GMT', 0],
    ['soon', null],
  ])('%j → %j', (header, expected) => {
    expect(retryAfterMs(header, now)).toBe(expected);
  });
});
