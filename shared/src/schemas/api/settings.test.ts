import { describe, it } from 'vitest';
import { schemaAsserts } from '../../test-utils.js';
import { aboutResponseSchema } from './about.js';
import { MAX_INSTANCE_TEXT_LENGTH } from '../../instance-text.js';
import { serverSettingsSchema, updateServerSettingsRequestSchema } from './settings.js';

const base = { instanceText: null, defaultInstanceText: 'Run by [your name].' };

describe('server settings (GET /admin/settings)', () => {
  const settings = schemaAsserts(serverSettingsSchema);

  it('accepts both values', () => {
    settings.accepts({ ...base, defaultInviteCanCreateApiKeys: true });
    settings.accepts({ ...base, defaultInviteCanCreateApiKeys: false });
  });

  it('accepts an own instance text or null for the default', () => {
    settings.accepts({ ...base, defaultInviteCanCreateApiKeys: true, instanceText: 'Run by Ada.' });
  });

  it('requires every setting and rejects unknown ones', () => {
    settings.rejects({});
    settings.rejects({ defaultInviteCanCreateApiKeys: true });
    settings.rejects({ ...base, defaultInviteCanCreateApiKeys: true, other: 1 });
  });

  it('rejects an empty instance text', () => {
    settings.rejects({ ...base, defaultInviteCanCreateApiKeys: true, instanceText: '' });
    settings.rejects({ ...base, defaultInviteCanCreateApiKeys: true, defaultInstanceText: '' });
  });
});

describe('PATCH /admin/settings', () => {
  const request = schemaAsserts(updateServerSettingsRequestSchema);

  it('accepts a change', () => {
    request.accepts({ defaultInviteCanCreateApiKeys: false });
    request.accepts({ instanceText: 'Run by Ada.\n\nContact: ada@example.invalid' });
    request.accepts({ instanceText: null });
  });

  it('rejects wrong types, unknown fields and a text far over the limit', () => {
    request.rejects({ defaultInviteCanCreateApiKeys: 'yes' });
    request.rejects({ instanceText: 42 });
    request.rejects({ userAgentContact: 'me@example.invalid' });
    request.rejects({ instanceText: 'x'.repeat(MAX_INSTANCE_TEXT_LENGTH * 2 + 1) });
  });
});

describe('GET /about', () => {
  const about = schemaAsserts(aboutResponseSchema);

  it('accepts the text and whether it is the default', () => {
    about.accepts({ text: 'Run by Ada.', isDefault: false });
  });

  it('rejects anything else, such as user data', () => {
    about.rejects({ text: 'Run by Ada.', isDefault: false, username: 'ada' });
    about.rejects({ text: '', isDefault: true });
    about.rejects({ isDefault: true });
  });
});
