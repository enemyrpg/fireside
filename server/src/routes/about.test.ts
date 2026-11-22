import {
  aboutResponseSchema,
  BRANDING,
  MAX_INSTANCE_TEXT_LENGTH,
  serverSettingsSchema,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { Database } from '../db/index.js';
import { auditLog, serverSettings } from '../db/schema.js';
import { defaultInstanceText, normalizeInstanceText } from '../settings/instance-text.js';
import { testConfig, testDatabase } from '../test-utils.js';
import { loginApp, type LoginApp } from '../users/testing.js';
import { FIRST_USER_ID } from '../users/users.js';

// The instance text on the login page and `/about`.

const ABOUT = '/api/v1/about';
const SETTINGS = '/api/v1/admin/settings';

describe('default instance text', () => {
  const paragraphs = (text: string) => text.split('\n\n');

  it('has the placeholders, plain paragraphs and the fixed promises', () => {
    const text = defaultInstanceText(testConfig());
    expect(text).toContain(`This ${BRANDING.displayName} instance is run by [your name].`);
    expect(text).toContain('Contact: [how to reach you].');
    expect(text).not.toMatch(/\n{3,}|<|\*\*|^#/m);
    expect(text).toContain('give your user a new password, or create a password reset link');
    expect(text).toContain('they would also have to turn it off');
    expect(text).toContain('recorded in the audit log');
    expect(text).toContain("never shows other users' play data");
    expect(text).toContain('IP addresses and usernames typed in failed logins');
    expect(text).toContain('Settings → Profile → Delete my account');
    expect(normalizeInstanceText(text)).toBe(text);
  });

  it('takes the backup levels and the max age from the config', () => {
    const text = defaultInstanceText(testConfig());
    expect(text).toContain('each of the last 7 days, 4 weeks and 6 months');
    expect(text).toContain('No backup or copy is kept longer than 6 months');
    expect(text).toContain('up to 6 months');

    const custom = defaultInstanceText(
      testConfig({ BACKUP_KEEP_DAILY: '14', BACKUP_KEEP_WEEKLY: '0', BACKUP_KEEP_MONTHLY: '12' }),
    );
    expect(custom).toContain('each of the last 14 days and 12 months');
    expect(custom).toContain('up to 12 months');

    const off = defaultInstanceText(testConfig({ BACKUP_ENABLED: 'false' }));
    expect(off).toContain('the server takes no automatic backups');
    expect(off).toContain('up to 6 months');

    const newestOnly = defaultInstanceText(
      testConfig({ BACKUP_KEEP_DAILY: '0', BACKUP_KEEP_WEEKLY: '0', BACKUP_KEEP_MONTHLY: '0' }),
    );
    expect(newestOnly).toContain('keeps only the newest one');
    expect(newestOnly).not.toContain('longer than');
  });

  it('mentions Cloudflare only with TRUSTED_PROXY=cloudflare', () => {
    expect(defaultInstanceText(testConfig())).not.toContain('Cloudflare');
    const tunnel = defaultInstanceText(
      testConfig({ TRUSTED_PROXY: 'cloudflare', PUBLIC_URL: 'https://app.example.com' }),
    );
    expect(paragraphs(tunnel)).toContain(
      'This instance is reached through Cloudflare Tunnel, so traffic from outside passes through Cloudflare on its way to the server, and Cloudflare can see it.',
    );
  });

  it('mentions only the external sources that are on', () => {
    const contact = { USER_AGENT_CONTACT: 'admin@example.invalid' };
    const none = defaultInstanceText(testConfig(contact));
    expect(paragraphs(none)).toContain(
      'No external sources are used: the server sends nothing about you to other services.',
    );
    expect(none).not.toMatch(/RuneProfile|OSRS Wiki Prices/);

    const prices = defaultInstanceText(testConfig({ ...contact, PRICES_ENABLED: 'true' }));
    expect(prices).toContain('Item prices come from OSRS Wiki Prices');
    expect(prices).not.toContain('RuneProfile');
    expect(prices).not.toContain('No external sources');

    const runeprofile = defaultInstanceText(
      testConfig({ ...contact, RUNEPROFILE_ENABLED: 'true' }),
    );
    expect(runeprofile).toContain('sends your OSRS display name to RuneProfile');
    expect(runeprofile).not.toContain('OSRS Wiki Prices');

    const both = defaultInstanceText(
      testConfig({ ...contact, PRICES_ENABLED: 'true', RUNEPROFILE_ENABLED: 'true' }),
    );
    expect(both).toContain('OSRS Wiki Prices');
    expect(both).toContain('RuneProfile');

    // A flag without USER_AGENT_CONTACT makes no call (external/sources.ts).
    expect(defaultInstanceText(testConfig({ PRICES_ENABLED: 'true' }))).toContain(
      'No external sources are used',
    );
  });
});

describe('normalizeInstanceText', () => {
  it('keeps paragraphs and line breaks, and tidies the rest', () => {
    expect(
      normalizeInstanceText('  Run by Ada.  \r\n\r\n\r\n\r\nContact:\rada@example.invalid \n'),
    ).toBe('Run by Ada.\n\nContact:\nada@example.invalid');
  });

  it('counts characters, not UTF-16 units', () => {
    expect(normalizeInstanceText('🔥'.repeat(MAX_INSTANCE_TEXT_LENGTH))).toHaveLength(
      MAX_INSTANCE_TEXT_LENGTH * 2,
    );
    expect(() => normalizeInstanceText('x'.repeat(MAX_INSTANCE_TEXT_LENGTH + 1))).toThrow(
      `Use at most ${String(MAX_INSTANCE_TEXT_LENGTH)} characters`,
    );
  });

  it.each([
    ['empty', '  \n\n '],
    ['a tab', 'Run\tby Ada'],
    ['an ANSI escape', 'Run by \u001b[31mAda'],
    ['a bidi override', 'Run by ‮Ada'],
    ['a zero-width space', 'Run by​Ada'],
    ['a line separator', 'Run by Ada'],
  ])('rejects %s', (_name, text) => {
    expect(() => normalizeInstanceText(text)).toThrow();
  });
});

describe('GET /about and the instance text setting', () => {
  let database: Database;
  let t: LoginApp & { adminToken: string };
  let member: { id: number; token: string };

  beforeEach(async () => {
    database = testDatabase();
    t = await loginApp(database);
    member = await t.addUser('ola');
  });
  afterEach(() => t.app.close());

  const about = async (token?: string) => {
    const response = await t.send('GET', ABOUT, token === undefined ? {} : { token });
    expect(response.statusCode).toBe(200);
    return aboutResponseSchema.parse(response.json());
  };
  const patch = (payload: object, token = t.adminToken) =>
    t.send('PATCH', SETTINGS, { token, payload });
  const audits = () =>
    database.db
      .select({ actor: auditLog.actorUserId, action: auditLog.action, target: auditLog.target })
      .from(auditLog)
      .where(eq(auditLog.action, 'settings.update'))
      .all();

  it('is readable without a session, and shows the default until the admin writes one', async () => {
    const shown = await about();
    expect(shown).toEqual({
      text: defaultInstanceText(testConfig({ LOG_LEVEL: 'trace' })),
      isDefault: true,
    });
    const settings = serverSettingsSchema.parse(
      (await t.send('GET', SETTINGS, { token: t.adminToken })).json(),
    );
    expect(settings.instanceText).toBeNull();
    expect(settings.defaultInstanceText).toBe(shown.text);
  });

  it('holds no user or account data, also with a session', async () => {
    const response = await t.send('GET', ABOUT, { token: member.token });
    expect(Object.keys(response.json<object>()).sort()).toEqual(['isDefault', 'text']);
    expect(response.body).not.toContain('ola');
    expect(response.body).not.toContain('"admin"');
  });

  it('stores the admin’s text, shows it, writes an audit row, and goes back to the default', async () => {
    const written = await patch({
      instanceText: 'Run by Ada.\r\n\r\n\r\nContact: ada@example.invalid  ',
    });
    expect(written.statusCode).toBe(200);
    expect(serverSettingsSchema.parse(written.json()).instanceText).toBe(
      'Run by Ada.\n\nContact: ada@example.invalid',
    );
    expect(await about()).toEqual({
      text: 'Run by Ada.\n\nContact: ada@example.invalid',
      isDefault: false,
    });

    // The same text again writes nothing.
    await patch({ instanceText: 'Run by Ada.\n\nContact: ada@example.invalid' });
    const reset = await patch({ instanceText: null });
    expect(serverSettingsSchema.parse(reset.json()).instanceText).toBeNull();
    expect((await about()).isDefault).toBe(true);
    expect(database.db.select().from(serverSettings).all()).toEqual([]);
    expect(audits()).toEqual([
      { actor: FIRST_USER_ID, action: 'settings.update', target: 'setting:instance_text' },
      { actor: FIRST_USER_ID, action: 'settings.update', target: 'setting:instance_text' },
    ]);
  });

  it('answers 400 on body.instanceText for a text it can’t store', async () => {
    for (const instanceText of ['   ', 'x'.repeat(MAX_INSTANCE_TEXT_LENGTH + 1), 'a\u0007b']) {
      const response = await patch({ instanceText });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { details: [{ path: 'body.instanceText' }] },
      });
    }
    expect(audits()).toEqual([]);
  });

  it('lets only the admin change it', async () => {
    expect((await patch({ instanceText: 'Mine now' }, member.token)).statusCode).toBe(403);
    expect((await about()).isDefault).toBe(true);
  });

  it('falls back to the default for a stored value it can’t read', async () => {
    database.db
      .insert(serverSettings)
      .values({ key: 'instance_text', value: '{"not":"text"}', updatedAt: '2026-11-19T00:00:00Z' })
      .run();
    expect((await about()).isDefault).toBe(true);
  });
});

describe('GET /about in local mode', () => {
  it('needs no login, like the rest of the dashboard on localhost', async () => {
    const app = buildApp({ db: testDatabase(), config: testConfig() });
    try {
      const response = await app.inject({ method: 'GET', url: ABOUT });
      expect(response.statusCode).toBe(200);
      expect(aboutResponseSchema.parse(response.json()).isDefault).toBe(true);
    } finally {
      await app.close();
    }
  });
});
