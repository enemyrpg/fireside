import type { ServerSettings, UpdateServerSettingsRequest } from '@fireside/shared';
import { eq } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import type { Queryable } from '../db/index.js';
import { serverSettings } from '../db/schema.js';
import { normalizeInstanceText } from './instance-text.js';

// Settings for the whole server that the admin changes under Settings → Server.
// Stored in `server_settings` as JSON, one row per setting that has been set; a
// missing row is the default. Not user data, so deleting a user leaves them,
// and `rebuild` never touches them.

/** The settings stored here. The API adds the default instance text (from config). */
export type StoredSettings = Omit<ServerSettings, 'defaultInstanceText'>;

export const DEFAULT_SERVER_SETTINGS: StoredSettings = {
  defaultInviteCanCreateApiKeys: true,
  // `null`: the default text (settings/instance-text.ts) is shown.
  instanceText: null,
};

type SettingKey = keyof StoredSettings;

/** Column value for each setting. Snake case, like the rest of the database. */
const STORAGE_KEYS: Record<SettingKey, string> = {
  defaultInviteCanCreateApiKeys: 'default_invite_can_create_api_keys',
  instanceText: 'instance_text',
};

/** `setting:<key>`, the audit target for a setting. */
export const settingTarget = (key: SettingKey) => `setting:${STORAGE_KEYS[key]}`;

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  const value = parseJson(raw);
  return typeof value === 'boolean' ? value : fallback;
}

/** A stored instance text, or `null` (the default) when missing or unreadable. */
function parseInstanceText(raw: string | undefined): string | null {
  const value = parseJson(raw);
  if (typeof value !== 'string') return null;
  try {
    return normalizeInstanceText(value);
  } catch {
    return null;
  }
}

/** Every setting, with the default for those never set (or stored in a form we don't read). */
export function getServerSettings(db: Queryable): StoredSettings {
  const stored = new Map(
    db
      .select({ key: serverSettings.key, value: serverSettings.value })
      .from(serverSettings)
      .all()
      .map((row) => [row.key, row.value]),
  );
  return {
    defaultInviteCanCreateApiKeys: parseBoolean(
      stored.get(STORAGE_KEYS.defaultInviteCanCreateApiKeys),
      DEFAULT_SERVER_SETTINGS.defaultInviteCanCreateApiKeys,
    ),
    instanceText: parseInstanceText(stored.get(STORAGE_KEYS.instanceText)),
  };
}

/**
 * Stores the given settings and writes `settings.update` to `audit_log` for
 * each one that changed. Unchanged values write nothing. A value of `null`
 * (the default instance text) removes the row. Returns the result. Throws
 * `InvalidInstanceTextError` for an instance text that can't be stored.
 */
export function updateServerSettings(
  db: Queryable,
  patch: UpdateServerSettingsRequest,
  { actorUserId, now }: { actorUserId: number | null; now: Date },
): StoredSettings {
  const current = getServerSettings(db);
  const next: { [K in SettingKey]: StoredSettings[K] | undefined } = {
    defaultInviteCanCreateApiKeys: patch.defaultInviteCanCreateApiKeys,
    instanceText:
      typeof patch.instanceText === 'string'
        ? normalizeInstanceText(patch.instanceText)
        : patch.instanceText,
  };
  const at = now.toISOString();
  for (const key of Object.keys(STORAGE_KEYS) as SettingKey[]) {
    const value = next[key];
    if (value === undefined || value === current[key]) continue;
    const storageKey = STORAGE_KEYS[key];
    if (value === null) {
      db.delete(serverSettings).where(eq(serverSettings.key, storageKey)).run();
    } else {
      db.insert(serverSettings)
        .values({ key: storageKey, value: JSON.stringify(value), updatedAt: at })
        .onConflictDoUpdate({
          target: serverSettings.key,
          set: { value: JSON.stringify(value), updatedAt: at },
        })
        .run();
    }
    audit(db, { actorUserId, action: 'settings.update', target: settingTarget(key), now });
  }
  return getServerSettings(db);
}
