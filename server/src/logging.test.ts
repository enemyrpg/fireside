import { Writable } from 'node:stream';
import { BRANDING, raidSplitsResponseSchema } from '@fireside/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { emptyRun, eventFactory, ingestBatch } from './projections/testing.js';
import { testConfig, testDatabase } from './test-utils.js';

const SECRET = `${BRANDING.apiKeyPrefix}5uP3rS3cr3tK3yTh4tMu5tN3v3rB3L0gg3d`;

/** App that logs at trace level into `lines`. */
function appWithCapturedLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const app = buildApp({
    db: testDatabase(),
    config: testConfig({ LOG_LEVEL: 'trace' }),
    logStream: stream,
  });
  return { app, lines, output: () => lines.join('') };
}

describe('logging', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
  });

  it('writes structured JSON request logs', async () => {
    const { app, lines } = appWithCapturedLogs();
    close = () => app.close();

    await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(lines.length).toBeGreaterThan(0);
    const entries = lines.map((line) => JSON.parse(line) as { msg?: unknown });
    expect(entries.some((entry) => entry.msg === 'incoming request')).toBe(true);
  });

  it('never logs the Authorization, Cookie or X-Api-Key header', async () => {
    const { app, lines, output } = appWithCapturedLogs();
    close = () => app.close();
    // Simulates a future mistake: a route that logs the raw request or headers.
    app.get('/test/log-headers', (request) => {
      request.log.info({ headers: request.headers }, 'headers');
      request.log.info({ req: request }, 'request');
      throw new Error('boom');
    });
    const headers = {
      authorization: `Bearer ${SECRET}`,
      cookie: `session=${SECRET}`,
      'x-api-key': SECRET,
    };

    await app.inject({ method: 'GET', url: '/api/v1/health', headers });
    await app.inject({ method: 'GET', url: '/api/v1/missing', headers });
    await app.inject({ method: 'GET', url: '/test/log-headers', headers });

    expect(lines.length).toBeGreaterThan(5);
    expect(output()).not.toContain(SECRET);
  });

  // An IP address is only logged on security events (auth/security-log.ts).
  it('logs no IP address for a normal request, and never the address headers', async () => {
    const { app, lines, output } = appWithCapturedLogs();
    close = () => app.close();
    app.get('/test/log-headers', (request) => {
      request.log.info({ headers: request.headers }, 'headers');
      return {};
    });
    const headers = {
      'x-forwarded-for': '203.0.113.71',
      'cf-connecting-ip': '203.0.113.72',
      'x-real-ip': '203.0.113.73',
      forwarded: 'for=203.0.113.74',
    };

    await app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: '203.0.113.70' });
    await app.inject({ method: 'GET', url: '/test/log-headers', headers });

    expect(lines.length).toBeGreaterThan(3);
    expect(output()).not.toMatch(/203\.0\.113\.7\d/);
    expect(output()).not.toContain('remoteAddress');
    expect(output()).not.toContain('clientIp');
  });

  // A nickname or note on a raid drop is the owner's own note about someone
  // else, so it must never reach the logs, also when refused.
  it('never logs a raid drop nickname or note', async () => {
    const run = emptyRun();
    const f = eventFactory();
    ingestBatch(run, [
      f.sessionStart('18:00'),
      f.raidSpecialLoot('19:00', { recipient: 'TEAMMATE', teamSize: 3 }),
    ]);
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const app = buildApp({
      db: run.database,
      config: testConfig({ LOG_LEVEL: 'trace' }),
      logStream: stream,
    });
    close = () => app.close();

    const base = '/api/v1/accounts/1/raids';
    const overview = await app.inject({ method: 'GET', url: `${base}/splits` });
    const { drops } = raidSplitsResponseSchema.parse(overview.json());
    const dropId = drops.items[0]?.dropId ?? '';

    const NICKNAME = 'Secr3tNickname';
    const NOTE = 'Secr3tNote';
    const patched = await app.inject({
      method: 'PATCH',
      url: `${base}/drops/${dropId}`,
      payload: { nickname: NICKNAME, note: NOTE },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const created = await app.inject({
      method: 'POST',
      url: `${base}/drops`,
      payload: {
        raid: 'Tombs of Amascut',
        itemId: 26219,
        occurredAt: '2026-11-08T20:00:00.000Z',
        nickname: NICKNAME,
        note: NOTE,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    // Refused: too long, a field of the wrong type, and an unknown field.
    const refused = [
      { nickname: `${NICKNAME}${'x'.repeat(40)}` },
      { nickname: [NICKNAME] },
      { [NICKNAME]: NOTE },
      { note: `${NOTE}\nmore` },
    ];
    for (const payload of refused) {
      const response = await app.inject({
        method: 'PATCH',
        url: `${base}/drops/${dropId}`,
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
    }
    await app.inject({ method: 'GET', url: `${base}/splits` });

    const output = lines.join('');
    expect(output).toContain('Raid drop choices changed');
    expect(output).toContain('Manual raid drop added');
    expect(output).not.toContain(NICKNAME);
    expect(output).not.toContain(NOTE);
  });
});
