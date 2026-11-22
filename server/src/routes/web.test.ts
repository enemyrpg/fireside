import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { testConfig, testDatabase } from '../test-utils.js';
import { loginApp, type LoginApp } from '../users/testing.js';

const INDEX_HTML = '<!doctype html><title>app</title><div id="root"></div>';

describe('built dashboard on the same port', () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'web-dist-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), INDEX_HTML);
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
    app = buildApp({ db: testDatabase(), config: testConfig(), webDir: dir });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    '/',
    '/all',
    '/all/sessions',
    '/settings',
    '/sessions/01a1bc95-5deb-777c-a6cd-69dd8574ce04',
    '/1?period=week',
  ])('serves index.html for the app route %s', async (url) => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.body).toBe(INDEX_HTML);
  });

  it.each(['/invite', '/reset-password', '/invite/', '/settings', '/'])(
    'sends Referrer-Policy: no-referrer on %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.body).toBe(INDEX_HTML);
    },
  );

  it('answers HEAD for app routes', async () => {
    const response = await app.inject({ method: 'HEAD', url: '/all' });
    expect(response.statusCode).toBe(200);
  });

  it('serves hashed assets with a long cache', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.headers['cache-control']).toContain('immutable');
    expect(response.body).toBe('console.log(1)');
  });

  it('serves other files without a long cache', async () => {
    const response = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it.each(['/api/v1/nope', '/api/nope', '/api', '/api/v1/accounts/1/nope'])(
    'never serves the app for %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    },
  );

  it('gives a JSON 404 for a missing file, not the app', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('gives a JSON 404 for other methods', async () => {
    const response = await app.inject({ method: 'POST', url: '/settings' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('does not serve files outside the folder', async () => {
    const response = await app.inject({ method: 'GET', url: '/../package.json' });
    expect(response.statusCode).toBe(404);
  });

  it('keeps unknown ingest paths behind ingest auth', async () => {
    for (const url of ['/api/v1/ingest/nope', '/api/v1/ingest/verify/x']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    }
  });

  it('only caches files inside assets/ for a year', async () => {
    writeFileSync(join(dir, 'assets-manifest.json'), '{}');
    const response = await app.inject({ method: 'GET', url: '/assets-manifest.json' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('serves files added after startup', async () => {
    writeFileSync(join(dir, 'assets', 'app-new456.js'), 'console.log(2)');
    const response = await app.inject({ method: 'GET', url: '/assets/app-new456.js' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('console.log(2)');
  });

  it.each(['/%2e%2e/package.json', '/assets/..%2F..%2Fpackage.json', '/x%00.js'])(
    'never serves anything outside the folder for %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
    },
  );

  it('keeps the API working', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('serves the app to other machines, while dashboard data stays local-only', async () => {
    const remote = { remoteAddress: '192.168.1.20' };
    const page = await app.inject({ method: 'GET', url: '/all', ...remote });
    expect(page.statusCode).toBe(200);
    const data = await app.inject({ method: 'GET', url: '/api/v1/accounts', ...remote });
    expect(data.statusCode).toBe(403);
  });

  it('falls back to a JSON 404 while index.html is missing (build in progress)', async () => {
    rmSync(join(dir, 'index.html'));
    const response = await app.inject({ method: 'GET', url: '/all' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('without a built dashboard', () => {
  it('serves only the API while the folder is missing, and picks up a later build', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'web-later-')), 'dist');
    const app = buildApp({ db: testDatabase(), config: testConfig(), webDir: dir });
    const before = await app.inject({ method: 'GET', url: '/all' });
    expect(before.statusCode).toBe(404);
    expect(before.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.statusCode).toBe(200);

    mkdirSync(dir);
    writeFileSync(join(dir, 'index.html'), INDEX_HTML);
    const after = await app.inject({ method: 'GET', url: '/all' });
    expect(after.statusCode).toBe(200);
    expect(after.body).toBe(INDEX_HTML);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves only the API when no web folder is given', async () => {
    const app = buildApp({ db: testDatabase(), config: testConfig() });
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(404);
    await app.close();
  });
});

describe('installable app files in login mode', () => {
  // The manifest and icons hold no data, and the browser fetches the manifest
  // without cookies, so they are public like index.html and the assets.
  const MANIFEST = '{"name":"app","start_url":"/"}';
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
  let dir: string;
  let t: LoginApp & { adminToken: string };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'web-dist-'));
    mkdirSync(join(dir, 'icons'));
    writeFileSync(join(dir, 'index.html'), INDEX_HTML);
    writeFileSync(join(dir, 'manifest.webmanifest'), MANIFEST);
    writeFileSync(join(dir, 'icons', 'icon-192.png'), PNG);
    writeFileSync(join(dir, 'apple-touch-icon.png'), PNG);
    t = await loginApp(testDatabase(), { webDir: dir });
  });

  afterEach(async () => {
    await t.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the manifest without a session, as application/manifest+json', async () => {
    expect((await t.send('GET', '/api/v1/keys')).statusCode).toBe(401);
    const response = await t.send('GET', '/manifest.webmanifest');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/manifest\+json/);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).toBe(MANIFEST);
    expect((await t.send('HEAD', '/manifest.webmanifest')).statusCode).toBe(200);
  });

  it.each(['/icons/icon-192.png', '/apple-touch-icon.png'])(
    'serves %s without a session, as image/png',
    async (url) => {
      const response = await t.send('GET', url);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.rawPayload.equals(PNG)).toBe(true);
    },
  );
});
