// Paths of Settings tabs that other modules link to. This module imports
// nothing, so anything can use them without risking an import cycle (see
// `import-x/no-cycle` in eslint.config.js).

/** Settings → Users, the admin-only tab with users and invites. */
export const SETTINGS_USERS_PATH = '/settings/users';

/** Settings → Server, the admin-only tab. */
export const SETTINGS_SERVER_PATH = '/settings/server';

/** The public pages an invite link and a password reset link open. */
export const INVITE_PATH = '/invite';
export const RESET_PASSWORD_PATH = '/reset-password';

/** The public page with the instance text: who runs the server, what it stores. */
export const ABOUT_PATH = '/about';

/** Settings → API keys. */
export const SETTINGS_KEYS_PATH = '/settings/keys';

/** Your own revoked keys, behind a link row under API keys. */
export const SETTINGS_KEYS_REVOKED_PATH = '/settings/keys/revoked';

/** Every user's revoked keys, behind a link row under Users → API keys (admin). */
export const SETTINGS_USERS_KEYS_REVOKED_PATH = '/settings/users/keys/revoked';

/** Used, expired and revoked invites and reset links (admin). */
export const SETTINGS_INVITES_PAST_PATH = '/settings/users/invites';
