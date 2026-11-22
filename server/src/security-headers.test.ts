import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import {
  CONTENT_SECURITY_POLICY,
  PRIVATE_REVALIDATE,
  SECURITY_HEADERS,
  STRICT_TRANSPORT_SECURITY,
} from './security-headers.js';
import { testConfig, testDatabase } from './test-utils.js';

// Security headers on every response.

const PUBLIC_HOST = 'app.example.com';
const TRUSTED = { TRUSTED_PROXY: 'cloudflare', PUBLIC_URL: `https://${PUBLIC_HOST}` };

/** Headers cloudflared sends for a visitor who used https. */
const TUNNEL_HEADERS = {
  host: PUBLIC_HOST,
  'cf-connecting-ip': '203.0.113.9',
  'cf-ray': '8f00000000000000-OSL',
  'cf-visitor': '{"scheme":"https"}',
  'cdn-loop': 'cloudflare',
  'x-forwarded-for': '203.0.113.9',
  'x-forwarded-proto': 'https',
};

/** The directives of a CSP, by name. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((parts) => parts[0] !== '')
      .map(([name = '', ...values]) => [name, values]),
  );
}

describe('security headers', () => {
  let dir: string;
  let app: FastifyInstance;
  let apps: FastifyInstance[] = [];

  function build(env: Record<string, string> = {}) {
    app = buildApp({ db: testDatabase(), config: testConfig(env), webDir: dir });
    apps.push(app);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'web-dist-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    build();
  });

  afterEach(async () => {
    await Promise.all(apps.map((built) => built.close()));
    apps = [];
    rmSync(dir, { recursive: true, force: true });
  });

  const local = { host: 'localhost:3100' };

  /** One request of every kind: API, ingest, dashboard, errors, files, the app. */
  const REQUESTS: [string, InjectOptions, number][] = [
    ['health', { method: 'GET', url: '/api/v1/health', headers: local }, 200],
    ['ingest without a key', { method: 'GET', url: '/api/v1/ingest/verify', headers: local }, 401],
    ['a dashboard route', { method: 'GET', url: '/api/v1/accounts', headers: local }, 200],
    ['an unknown API path', { method: 'GET', url: '/api/v1/nope', headers: local }, 404],
    [
      'a refused dashboard request',
      { method: 'GET', url: '/api/v1/accounts', headers: local, remoteAddress: '192.0.2.4' },
      403,
    ],
    ['a hashed asset', { method: 'GET', url: '/assets/app-abc123.js', headers: local }, 200],
    ['a missing file', { method: 'GET', url: '/missing.js', headers: local }, 404],
    ['the app (index.html)', { method: 'GET', url: '/settings', headers: local }, 200],
  ];

  describe.each(Object.entries(SECURITY_HEADERS))('%s', (name, value) => {
    it.each(REQUESTS)('is on %s', async (_label, request, status) => {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(status);
      expect(response.headers[name]).toBe(value);
    });
  });

  it('keeps a stricter CSP a route sets itself (icons)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/items/1/icon',
      headers: local,
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-security-policy']).toBe("default-src 'none'");
  });

  describe('Content-Security-Policy', () => {
    const policy = directives(CONTENT_SECURITY_POLICY);

    it('allows scripts only from this origin: never inline, eval or hashes', () => {
      expect(policy.get('script-src')).toEqual(["'self'"]);
      for (const [name, values] of policy) {
        if (name.startsWith('script-src') || name === 'default-src') {
          expect(values).not.toContain("'unsafe-inline'");
          expect(values).not.toContain("'unsafe-eval'");
          expect(values).not.toContain("'unsafe-hashes'");
        }
      }
    });

    it('allows inline <style> elements only, never style attributes', () => {
      expect(policy.get('style-src')).toEqual(["'self'"]);
      expect(policy.get('style-src-elem')).toEqual(["'self'", "'unsafe-inline'"]);
      // Falls back to style-src when absent; never loosened if present.
      expect(policy.get('style-src-attr') ?? []).not.toContain("'unsafe-inline'");
      expect(policy.get('style-src-attr') ?? []).not.toContain("'unsafe-hashes'");
    });

    it('blocks framing, plugins, base tags and everything not listed', () => {
      expect(policy.get('default-src')).toEqual(["'none'"]);
      expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
      expect(policy.get('object-src')).toEqual(["'none'"]);
      expect(policy.get('base-uri')).toEqual(["'none'"]);
    });

    it('never allows other origins, and data: only for images', () => {
      for (const [name, values] of policy) {
        for (const value of values) {
          if (name === 'img-src' && value === 'data:') continue;
          expect(value).toMatch(/^'(self|none|unsafe-inline)'$/);
        }
      }
      expect(policy.get('img-src')).toEqual(["'self'", 'data:']);
      expect(policy.get('font-src')).toEqual(["'self'"]);
    });
  });

  describe('Cache-Control', () => {
    it.each(
      REQUESTS.filter(
        ([, request]) => typeof request.url === 'string' && request.url.startsWith('/api'),
      ),
    )('is no-store on %s', async (_label, request) => {
      const response = await app.inject(request);
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it.each([
      ['public, max-age=60', 'no-store'],
      ['private, max-age=86400', 'no-store'],
      ['no-cache', 'no-store'],
      [PRIVATE_REVALIDATE, PRIVATE_REVALIDATE],
    ])(
      'turns %j from an /api route into %j: only private revalidation is kept',
      async (set, sent) => {
        app.get('/api/v1/test-cache', (_request, reply) =>
          reply.header('cache-control', set).send({}),
        );
        const response = await app.inject({ method: 'GET', url: '/api/v1/test-cache' });
        expect(response.headers['cache-control']).toBe(sent);
      },
    );

    it('keeps the exception private and without max-age', () => {
      expect(PRIVATE_REVALIDATE).toBe('private, no-cache');
    });

    it('leaves the caching of dashboard files alone', async () => {
      const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      const page = await app.inject({ method: 'GET', url: '/settings' });
      expect(page.headers['cache-control']).toBe('no-cache');
    });
  });

  describe('Strict-Transport-Security', () => {
    const hsts = (headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
      app
        .inject({ method: 'GET', url: '/api/v1/health', headers, remoteAddress })
        .then((response) => response.headers['strict-transport-security']);

    it('is sent through the trusted proxy over https, for the public host', async () => {
      build(TRUSTED);
      expect(await hsts(TUNNEL_HEADERS)).toBe(STRICT_TRANSPORT_SECURITY);
      const withoutVisitor: Record<string, string> = { ...TUNNEL_HEADERS };
      delete withoutVisitor['cf-visitor'];
      expect(await hsts(withoutVisitor)).toBe(STRICT_TRANSPORT_SECURITY);
    });

    it('never has includeSubDomains or preload', async () => {
      expect(STRICT_TRANSPORT_SECURITY).toBe('max-age=31536000');
      build(TRUSTED);
      const value = await hsts(TUNNEL_HEADERS);
      expect(value).not.toMatch(/includesubdomains/i);
      expect(value).not.toMatch(/preload/i);
    });

    it('is not sent on localhost, with or without TRUSTED_PROXY', async () => {
      expect(await hsts(local)).toBeUndefined();
      build(TRUSTED);
      expect(await hsts(local)).toBeUndefined();
    });

    it('is not sent when the visitor used http', async () => {
      build(TRUSTED);
      expect(
        await hsts({
          ...TUNNEL_HEADERS,
          'cf-visitor': '{"scheme":"http"}',
          'x-forwarded-proto': 'http',
        }),
      ).toBeUndefined();
    });

    it('is not sent for another host through the proxy', async () => {
      build(TRUSTED);
      expect(await hsts({ ...TUNNEL_HEADERS, host: 'other.example.com' })).toBeUndefined();
    });

    it('is not sent without TRUSTED_PROXY, whatever the headers say', async () => {
      build({ PUBLIC_URL: `https://${PUBLIC_HOST}` });
      expect(await hsts(TUNNEL_HEADERS)).toBeUndefined();
    });

    it('is not sent for a spoofed header from a socket that is not loopback', async () => {
      build(TRUSTED);
      expect(await hsts(TUNNEL_HEADERS, '198.51.100.7')).toBeUndefined();
    });

    it('is not sent through the proxy without a valid CF-Connecting-IP', async () => {
      build(TRUSTED);
      expect(await hsts({ ...TUNNEL_HEADERS, 'cf-connecting-ip': 'not-an-ip' })).toBeUndefined();
    });
  });
});
