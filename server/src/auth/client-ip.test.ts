import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { Database } from '../db/index.js';
import { testConfig, testDatabase } from '../test-utils.js';
import { loginApp, type LoginApp } from '../users/testing.js';
import { IP_RULE } from './login-limiter.js';

// The client IP comes from `CF-Connecting-IP` only with
// TRUSTED_PROXY=cloudflare and a loopback socket (auth/client-ip.ts), and only
// then are Cloudflare's headers allowed by the network check (local-only.ts).

const PUBLIC_HOST = 'app.example.com';
const TRUSTED = { TRUSTED_PROXY: 'cloudflare', PUBLIC_URL: `https://${PUBLIC_HOST}` };
const VISITOR = '203.0.113.9';
const OUTSIDE_SOCKET = '198.51.100.7';

/** The proxy headers cloudflared sent through the real tunnel. */
const OBSERVED_TUNNEL_HEADERS = [
  'cdn-loop',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-warp-tag-id',
  'x-forwarded-for',
  'x-forwarded-proto',
];

/** Headers cloudflared sends for a visitor. */
function tunnelHeaders(ip = VISITOR): Record<string, string> {
  return {
    host: PUBLIC_HOST,
    origin: `https://${PUBLIC_HOST}`,
    'cf-connecting-ip': ip,
    'cf-ray': '8f00000000000000-OSL',
    'cf-visitor': '{"scheme":"https"}',
    'cf-ipcountry': 'NO',
    'cf-warp-tag-id': '00000000-0000-4000-8000-000000000000',
    'cdn-loop': 'cloudflare',
    'x-forwarded-for': ip,
    'x-forwarded-proto': 'https',
  };
}

describe('network check with a trusted proxy (login mode)', () => {
  let database: Database;
  let login: LoginApp & { adminToken: string };

  async function build(env: Record<string, string>) {
    await login.app.close();
    database = testDatabase();
    login = await loginApp(database, { env });
  }

  beforeEach(async () => {
    database = testDatabase();
    login = await loginApp(database, { env: TRUSTED });
  });
  afterEach(() => login.app.close());

  const me = (headers: Record<string, string>, remoteAddress?: string) =>
    login
      .send('GET', '/api/v1/auth/me', {
        token: login.adminToken,
        headers,
        ...(remoteAddress === undefined ? {} : { remoteAddress }),
      })
      .then((response) => response.statusCode);

  it('lets a request through the tunnel in, for the public host', async () => {
    expect(await me(tunnelHeaders())).toBe(200);
  });

  it('lets in a request with exactly the proxy headers seen through the real tunnel', async () => {
    const headers = tunnelHeaders();
    const proxyHeaders = Object.keys(headers).filter(
      (name) => name !== 'host' && name !== 'origin',
    );
    expect(proxyHeaders.sort()).toEqual(OBSERVED_TUNNEL_HEADERS);
    expect(await me(headers)).toBe(200);
  });

  it.each([
    ['cf-connecting-ipv6', '2001:db8::1'],
    ['cf-iplongitude', '10.75'],
    ['cf-ipcity', 'Oslo'],
  ])('lets in a Cloudflare header not seen yet (%s): cf-* stays a prefix', async (name, value) => {
    expect(await me({ ...tunnelHeaders(), [name]: value })).toBe(200);
  });

  it('still answers direct requests on localhost', async () => {
    expect(await me({})).toBe(200);
  });

  it('refuses a request through the tunnel for another host, localhost included', async () => {
    expect(await me({ ...tunnelHeaders(), host: 'localhost:3100' })).toBe(403);
    expect(await me({ ...tunnelHeaders(), host: 'evil.example.com' })).toBe(403);
  });

  it.each([
    ['forwarded', 'for=192.0.2.1'],
    ['via', '1.1 proxy'],
    ['x-real-ip', '192.0.2.1'],
    ['x-forwarded-host', 'evil.example.com'],
    ['tailscale-user-login', 'someone@example.com'],
  ])('refuses other proxy headers through the tunnel (%s)', async (name, value) => {
    expect(await me({ ...tunnelHeaders(), [name]: value })).toBe(403);
  });

  it.each(['', 'not-an-ip', '203.0.113.9, 10.0.0.1'])(
    'refuses Cloudflare headers without a valid CF-Connecting-IP (%j)',
    async (value) => {
      expect(await me({ ...tunnelHeaders(), 'cf-connecting-ip': value })).toBe(403);
    },
  );

  it('refuses Cloudflare headers with no CF-Connecting-IP at all', async () => {
    const headers = tunnelHeaders();
    delete headers['cf-connecting-ip'];
    expect(await me(headers)).toBe(403);
  });

  it('refuses the same headers from a socket that is not loopback', async () => {
    expect(await me(tunnelHeaders(), OUTSIDE_SOCKET)).toBe(403);
  });

  it('refuses Cloudflare headers without TRUSTED_PROXY', async () => {
    await build({ PUBLIC_URL: `https://${PUBLIC_HOST}` });
    expect(await me(tunnelHeaders())).toBe(403);
  });
});

describe('network check with a trusted proxy (local mode)', () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = buildApp({ db: testDatabase(), config: testConfig(TRUSTED) });
  });
  afterEach(() => app.close());

  it('refuses dashboard requests through the tunnel: local mode has no login', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts',
      headers: tunnelHeaders(),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('client IP for limits and logs', () => {
  let database: Database;
  let login: LoginApp & { adminToken: string };

  async function build(env: Record<string, string>) {
    await login.app.close();
    database = testDatabase();
    login = await loginApp(database, { env });
  }

  beforeEach(async () => {
    database = testDatabase();
    login = await loginApp(database, { env: TRUSTED });
  });
  afterEach(() => login.app.close());

  /** Ingest without a key: counted per client IP. */
  const noKey = (headers: Record<string, string>, remoteAddress?: string) =>
    login
      .send('GET', '/api/v1/ingest/verify', {
        headers,
        ...(remoteAddress === undefined ? {} : { remoteAddress }),
      })
      .then((response) => response.statusCode);

  /** Sends `IP_RULE.free + 1` requests, each from the IP `headersFor(i)` claims. */
  async function burst(
    headersFor: (i: number) => Record<string, string>,
    remoteAddress?: string,
  ): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 0; i <= IP_RULE.free; i++)
      statuses.push(await noKey(headersFor(i), remoteAddress));
    return statuses;
  }

  it('counts each visitor through the tunnel on its own IP', async () => {
    const statuses = await burst((i) => tunnelHeaders(`203.0.113.${String(i + 1)}`));
    expect(statuses.every((status) => status === 401)).toBe(true);
  });

  it('counts one visitor through the tunnel on its IP', async () => {
    const statuses = await burst(() => tunnelHeaders());
    expect(statuses.at(-1)).toBe(429);
    // Another visitor is not blocked.
    expect(await noKey(tunnelHeaders('203.0.113.200'))).toBe(401);
  });

  it('ignores a spoofed CF-Connecting-IP from a socket that is not loopback', async () => {
    const statuses = await burst(
      (i) => tunnelHeaders(`203.0.113.${String(i + 1)}`),
      OUTSIDE_SOCKET,
    );
    expect(statuses.at(-1)).toBe(429);
  });

  it('ignores a spoofed CF-Connecting-IP without TRUSTED_PROXY', async () => {
    await build({});
    const statuses = await burst((i) => ({ 'cf-connecting-ip': `203.0.113.${String(i + 1)}` }));
    expect(statuses.at(-1)).toBe(429);
  });

  it('limits logins by the visitor IP through the tunnel', async () => {
    // A new username each time, so only the per-IP rule applies.
    let n = 0;
    const attempt = (ip: string) =>
      login
        .send('POST', '/api/v1/auth/login', {
          headers: tunnelHeaders(ip),
          payload: { username: `user${String((n += 1))}`, password: 'wrong password!' },
        })
        .then((response) => response.statusCode);
    for (let i = 0; i < IP_RULE.free; i++) expect(await attempt(VISITOR)).toBe(401);
    expect(await attempt(VISITOR)).toBe(429);
    expect(await attempt('203.0.113.200')).toBe(401);
  });

  it('logs the visitor IP once, when ingest without a key blocks it, and only the socket IP otherwise', async () => {
    const blockedLines = () =>
      login.logs.filter((line) => line.includes('"securityEvent":"rate_limited"'));
    // Rejections before the block log no IP.
    for (let i = 1; i < IP_RULE.free; i++) await noKey(tunnelHeaders());
    expect(login.logs.join('\n')).not.toContain(VISITOR);
    // The failure that blocks the IP logs it once; refused requests after it don't.
    await noKey(tunnelHeaders());
    expect(await noKey(tunnelHeaders())).toBe(429);
    expect(await noKey(tunnelHeaders())).toBe(429);
    expect(blockedLines()).toHaveLength(1);
    expect(blockedLines()[0]).toContain(`"clientIp":"${VISITOR}"`);
    expect(login.logs.join('\n')).not.toContain('remoteAddress');

    login.logs.length = 0;
    await burst(() => tunnelHeaders('192.0.2.55'), OUTSIDE_SOCKET);
    const logs = login.logs.join('\n');
    expect(logs).toContain(`"clientIp":"${OUTSIDE_SOCKET}"`);
    expect(logs).not.toContain('192.0.2.55');
  });

  it('logs the visitor IP of a failed login through the tunnel, never the username', async () => {
    const response = await login.send('POST', '/api/v1/auth/login', {
      headers: tunnelHeaders(),
      payload: { username: 'someone-typed-this', password: 'wrong password!' },
    });
    expect(response.statusCode).toBe(401);
    const logs = login.logs.join('\n');
    expect(logs).toContain(`"securityEvent":"login_failed","clientIp":"${VISITOR}"`);
    expect(logs).not.toContain('someone-typed-this');
    expect(logs).not.toContain('remoteAddress');
  });
});
