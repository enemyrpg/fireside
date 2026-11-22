/**
 * Project branding.
 *
 * Everything that shows or depends on the name must read it from here, so a
 * rename only touches this file.
 */
const DISPLAY_NAME = 'Fireside';

export const BRANDING = {
  /** Human-readable name, used in the UI and logs. */
  displayName: DISPLAY_NAME,
  /** Lowercase kebab-case name, used for file names, folders and identifiers. */
  shortName: 'fireside',
  /** Prefix for new API keys, e.g. `fs_<base62>`. */
  apiKeyPrefix: 'fs_',
  repositoryUrl: 'https://github.com/enemyrpg/fireside',
  pluginRepositoryUrl: 'https://github.com/enemyrpg/fireside-plugin',
  /**
   * Jagex Fan Content Policy disclaimer (see docs/legal.md). Shown in the
   * README, the Plugin Hub description and the dashboard footer.
   */
  jagexDisclaimer:
    "Created using intellectual property belonging to Jagex Limited under the terms of Jagex's " +
    'Fan Content Policy. This content is not endorsed by or affiliated with Jagex.',
  /**
   * Shown on the login page (Fan Content Policy 6.1.3 is about phishing).
   */
  jagexPasswordWarning:
    `This is a ${DISPLAY_NAME} account, not your Jagex or RuneScape account. ` +
    'Never enter your Jagex password here.',
} as const;

export type Branding = typeof BRANDING;
