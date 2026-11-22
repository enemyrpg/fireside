import {
  BRANDING,
  INSTANCE_TEXT_PLACEHOLDERS,
  MAX_INSTANCE_TEXT_LENGTH,
  normalizeInstanceTextLayout,
} from '@fireside/shared';
import { DEVICE_TTL_MS } from '../auth/devices.js';
import { FORGET_AFTER_MS } from '../auth/login-limiter.js';
import { SESSION_MAX_AGE_MS, SESSION_TTL_MS } from '../auth/sessions.js';
import { retentionHorizon, type RetentionHorizon } from '../backup/retention.js';
import type { Config } from '../config.js';
import { isSourceActive } from '../external/sources.js';
import { characterCount, UNSAFE_TEXT_CHARS } from '../text.js';

// The instance text: who runs this server, what it stores about each user and for how
// long. Shown on `/about` (linked from the login page), without logging in. The admin
// writes it under Settings → Server; until then the default below is shown. Plain
// text: paragraphs separated by a blank line, never rendered as HTML or Markdown.
//
// Every sentence of the default must stay true of the code, and so must
// docs/data-collected.md, which says the same in more detail; change both
// together.

const DAY_MS = 24 * 60 * 60 * 1000;

function plural(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
}

function horizonText({ count, unit }: RetentionHorizon): string {
  return plural(count, unit);
}

/** "the last 7 days, 4 weeks and 6 months", leaving out levels set to 0. */
function levelsText(keep: Config['backup']['keep']): string {
  const parts = [
    keep.daily > 0 ? plural(keep.daily, 'day') : null,
    keep.weekly > 0 ? plural(keep.weekly, 'week') : null,
    keep.monthly > 0 ? plural(keep.monthly, 'month') : null,
  ].filter((part): part is string => part !== null);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`;
}

function backupParagraph(backup: Config['backup']): string {
  const horizon = retentionHorizon(backup.keep);
  if (!horizon) {
    return (
      (backup.enabled
        ? 'Backups: the server takes a backup every day and keeps only the newest one. '
        : 'Backups: the server takes no automatic backups. Of the backups the admin takes, only the newest is kept. ') +
      'Data you delete stays in it until the next backup replaces it.'
    );
  }
  const age = horizonText(horizon);
  const taken = backup.enabled
    ? `Backups: the server takes a backup every day and keeps the newest backup of each of the last ${levelsText(backup.keep)}.`
    : `Backups: the server takes no automatic backups. Backups the admin takes keep the newest of each of the last ${levelsText(backup.keep)}.`;
  return (
    `${taken} Copies taken before an update or a restore are kept too. ` +
    `No backup or copy is kept longer than ${age}, so data you delete stays in backups until they rotate out, up to ${age}.`
  );
}

function externalParagraph(config: Config): string {
  const prices = isSourceActive(config, 'WIKI_PRICES');
  const runeprofile = isSourceActive(config, 'RUNEPROFILE');
  if (!prices && !runeprofile) {
    return 'No external sources are used: the server sends nothing about you to other services.';
  }
  const sentences: string[] = [];
  if (prices) {
    sentences.push('Item prices come from OSRS Wiki Prices. Nothing about you is sent there.');
  }
  if (runeprofile) {
    sentences.push(
      'The collection log can come from RuneProfile, only for accounts you turn it on for yourself. ' +
        'The server then sends your OSRS display name to RuneProfile, and RuneProfile profiles are public.',
    );
  }
  return sentences.join(' ');
}

/**
 * The text shown until the admin writes their own, built from `config` so the
 * backup times, the Cloudflare sentence and the external sources match this
 * server.
 */
export function defaultInstanceText(config: Config): string {
  const sessionDays = Math.round(SESSION_TTL_MS / DAY_MS);
  const sessionMaxDays = Math.round(SESSION_MAX_AGE_MS / DAY_MS);
  const deviceDays = Math.round(DEVICE_TTL_MS / DAY_MS);
  const forgetMinutes = Math.round(FORGET_AFTER_MS / 60_000);
  const paragraphs = [
    `This ${BRANDING.displayName} instance is run by ${INSTANCE_TEXT_PLACEHOLDERS[0]}. Contact: ${INSTANCE_TEXT_PLACEHOLDERS[1]}.`,

    'What is stored about you: your username, a hash of your password, and, if you turn on two-factor authentication, an encrypted secret and hashed recovery codes. ' +
      'For each OSRS account the plugin sends data from: its account hash, account type, display names and their history, and play data ' +
      '(sessions and play time, world and region, XP, loot, kill counts, personal bests, bank and storage contents, quests, diaries, collection log and pets). ' +
      'Also the names of your API keys, and raid split names and notes you type yourself. ' +
      'All of this is kept until your user is deleted.',

    `Logins: a session lasts ${String(sessionDays)} days after you last use it, at most ${String(sessionMaxDays)} days in all, and stores your browser's user agent. ` +
      `A device remembered for two-factor authentication lasts up to ${String(deviceDays)} days. API keys are stored hashed. ` +
      'An audit log records logins, password and two-factor changes, invites, password reset links, API key changes and admin actions, by user ID, without IP addresses or passwords. ' +
      'When your user is deleted, your own entries are removed; entries by others keep only your former user ID number. ' +
      "The invite you joined with is kept, without the admin's label for it.",

    'IP addresses: the database stores none. The server log records your IP address for failed logins and other security events, such as a wrong two-factor code, a rejected link or too many attempts. ' +
      `To limit login attempts, the server keeps IP addresses and usernames typed in failed logins in memory and forgets them ${String(forgetMinutes)} minutes after the last failed attempt, or when it restarts. ` +
      'How long the server log is kept depends on how the admin runs the server.',

    "The admin has the database file and its backups and can read everything in them, even though the dashboard never shows other users' play data. " +
      'The admin can also give your user a new password, or create a password reset link and use it, and so log in as you. ' +
      'If you have two-factor authentication on, they would also have to turn it off. ' +
      'Each of these steps is recorded in the audit log, and your old password stops working.',

    backupParagraph(config.backup),

    ...(config.trustedProxy === 'cloudflare'
      ? [
          'This instance is reached through Cloudflare Tunnel, so traffic from outside passes through Cloudflare on its way to the server, and Cloudflare can see it.',
        ]
      : []),

    externalParagraph(config),

    'You can delete your user and all its data yourself under Settings → Profile → Delete my account.',
  ];
  return paragraphs.join('\n\n');
}

/** Thrown by `normalizeInstanceText`. The message is shown to the admin. */
export class InvalidInstanceTextError extends Error {
  override name = 'InvalidInstanceTextError';
}

/** Like UNSAFE_TEXT_CHARS, but a line break is allowed (paragraphs). */
function hasUnsafeChar(text: string): boolean {
  return Array.from(text).some((char) => char !== '\n' && UNSAFE_TEXT_CHARS.test(char));
}

/**
 * The instance text as stored: line endings as `\n`, spaces at the end of
 * lines and the text trimmed, at most one blank line between paragraphs.
 * Throws `InvalidInstanceTextError` if it is empty, too long, or holds
 * control or invisible characters (a tab included).
 */
export function normalizeInstanceText(text: string): string {
  const normalized = normalizeInstanceTextLayout(text);
  if (normalized === '') throw new InvalidInstanceTextError('Write a text, or use the default');
  if (characterCount(normalized) > MAX_INSTANCE_TEXT_LENGTH) {
    throw new InvalidInstanceTextError(
      `Use at most ${String(MAX_INSTANCE_TEXT_LENGTH)} characters`,
    );
  }
  if (hasUnsafeChar(normalized)) {
    throw new InvalidInstanceTextError('Remove control and invisible characters');
  }
  return normalized;
}
