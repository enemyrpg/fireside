import { z } from 'zod';
import { checkPng, decodeBase64, MAX_ICON_BYTES } from '../../png.js';
import { nonNegativeInt, utcTimestamp } from '../common.js';
import { intFromString } from './common.js';
import { MAX_INGEST_BYTES } from './ingest.js';

// Icons. See docs/architecture.md#icons. Icons are assets, not events: they
// never go into `events`. An item icon is keyed by the exact item ID used in
// events (noted items included); the server never maps IDs. A named icon is
// keyed by kind and key: `SKILL` + skill name, or `BOSS` + boss or raid name.

/** Max keys (item IDs, skills and bosses together) per `POST /ingest/icons/wanted`. */
export const MAX_ICON_IDS = 500;

/** Kinds of icon that are keyed by a name instead of an item ID. */
export const NAMED_ICON_KINDS = ['SKILL', 'BOSS'] as const;
export const namedIconKindSchema = z.enum(NAMED_ICON_KINDS);

/** Max length of a skill or boss key. */
export const MAX_ICON_KEY_LENGTH = 100;

/** A skill as in `SKILLS` and `xp.snapshot` (`ATTACK`), or `OVERALL`. Unknown skills are accepted. */
export const skillIconKey = z
  .string()
  .max(MAX_ICON_KEY_LENGTH)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Must be an UPPER_SNAKE_CASE skill name');

/**
 * A boss or raid name as the game writes it. The server normalizes it with
 * `normalizeBossName`, so any known alias works. Unknown names are accepted.
 */
export const bossIconKey = z
  .string()
  .max(MAX_ICON_KEY_LENGTH)
  .regex(/^\S(?:.*\S)?$/, 'Must not be empty or start or end with whitespace');

/** Max icons per `POST /ingest/icons`. */
export const MAX_ICONS_PER_REQUEST = 100;

/** Max request body size for `POST /ingest/icons` (larger gives 413). */
export const MAX_ICONS_BODY_BYTES = MAX_INGEST_BYTES;

/** Base64 length of `MAX_ICON_BYTES` bytes, with padding. */
export const MAX_ICON_BASE64_LENGTH = Math.ceil(MAX_ICON_BYTES / 3) * 4;

/**
 * Standard base64 with padding that starts with the PNG signature
 * (`89 50 4E 47 0D 0A 1A 0A` encodes as `iVBORw0KGgo`).
 */
export const ICON_PNG_PATTERN =
  /^(?=iVBORw0KGgo)(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * PNG as base64. The JSON Schema checks the encoding, the signature and the
 * length; the rest of the PNG check (`checkPng`: IHDR, at most 64×64, CRCs,
 * IEND, no APNG) is a refinement, so those fixtures are `invalid-semantic`.
 */
export const iconPng = z
  .string()
  .max(MAX_ICON_BASE64_LENGTH, `Must be at most ${String(MAX_ICON_BYTES)} bytes`)
  .regex(ICON_PNG_PATTERN, 'Must be a base64-encoded PNG')
  .superRefine((value, ctx) => {
    // The checks above don't abort, so skip what they already rejected.
    if (value.length > MAX_ICON_BASE64_LENGTH || !ICON_PNG_PATTERN.test(value)) return;
    const result = checkPng(decodeBase64(value));
    if (!result.ok) ctx.addIssue({ code: 'custom', message: result.error });
  });

/** An item icon in `POST /ingest/icons`. */
export const itemIconUploadSchema = z.strictObject({
  /** The exact item ID used in events, noted items included. */
  itemId: nonNegativeInt,
  png: iconPng,
});

/** A skill icon in `POST /ingest/icons` (contract 1.29.0). */
export const skillIconUploadSchema = z.strictObject({
  kind: z.literal('SKILL'),
  key: skillIconKey,
  png: iconPng,
});

/** A boss or raid icon in `POST /ingest/icons` (contract 1.29.0). */
export const bossIconUploadSchema = z.strictObject({
  kind: z.literal('BOSS'),
  key: bossIconKey,
  png: iconPng,
});

/**
 * One icon in `POST /ingest/icons`. Validated one by one, like events. An
 * icon without `kind` is an item icon, as before 1.29.0. The server picks the
 * member schema from `kind` (`iconUploadSchemaFor`), so errors name the field.
 */
export const iconUploadSchema = z.union([
  itemIconUploadSchema,
  skillIconUploadSchema,
  bossIconUploadSchema,
]);

/** The schema an uploaded icon is checked against: by `kind`, item icon without one. */
export function iconUploadSchemaFor(
  raw: unknown,
): typeof itemIconUploadSchema | typeof skillIconUploadSchema | typeof bossIconUploadSchema {
  const kind =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).kind : undefined;
  if (kind === 'SKILL') return skillIconUploadSchema;
  // Any other `kind` fails on the `kind` field of the boss schema.
  return kind === undefined ? itemIconUploadSchema : bossIconUploadSchema;
}

/**
 * `POST /api/v1/ingest/icons/wanted` body. `skills` and `bosses` are new in
 * 1.29.0. At least one list, and at most `MAX_ICON_IDS` keys in total.
 */
export const iconsWantedRequestSchema = z
  .strictObject({
    itemIds: z.array(nonNegativeInt).min(1).max(MAX_ICON_IDS).optional(),
    skills: z.array(skillIconKey).min(1).max(MAX_ICON_IDS).optional(),
    bosses: z.array(bossIconKey).min(1).max(MAX_ICON_IDS).optional(),
  })
  .superRefine((value, ctx) => {
    const total =
      (value.itemIds?.length ?? 0) + (value.skills?.length ?? 0) + (value.bosses?.length ?? 0);
    if (total === 0)
      ctx.addIssue({ code: 'custom', message: 'Must have itemIds, skills or bosses' });
    if (total > MAX_ICON_IDS)
      ctx.addIssue({
        code: 'custom',
        message: `Must have at most ${String(MAX_ICON_IDS)} keys in total`,
      });
  });

/** `POST /api/v1/ingest/icons/wanted` response (200). */
export const iconsWantedResponseSchema = z.strictObject({
  /** The requested IDs the server has no icon for, deduplicated, in request order. */
  missing: z.array(nonNegativeInt),
  /** Only when the request had `skills`: those without an icon, as sent, deduplicated, in request order. */
  missingSkills: z.array(skillIconKey).optional(),
  /** Only when the request had `bosses`: those without an icon, as sent, deduplicated, in request order. */
  missingBosses: z.array(bossIconKey).optional(),
});

/**
 * `POST /api/v1/ingest/icons` body. Icons are not validated here: the server
 * validates each one (with `iconUploadSchema`), so one bad icon is rejected
 * without failing the rest.
 */
export const iconsUploadRequestSchema = z.strictObject({
  icons: z.array(z.unknown()).min(1).max(MAX_ICONS_PER_REQUEST).meta({
    description:
      'Icons are not checked here. Validate each icon against schema/api/ingest-icon.json.',
  }),
});

/** A named icon in an upload response: `kind` and `key` as sent. */
export const namedIconRefSchema = z.strictObject({
  kind: namedIconKindSchema,
  key: z.string().min(1).max(MAX_ICON_KEY_LENGTH),
});

export const iconRejectionSchema = z.strictObject({
  /** Position of the icon in the request. */
  index: nonNegativeInt,
  /**
   * The icon's `itemId` as sent, or `null` if it was missing or not a
   * non-negative integer. Always `null` for an icon sent with `kind`.
   */
  itemId: nonNegativeInt.nullable(),
  /** Only for an icon sent with `kind`: the kind, or `null` if it was not a known kind. */
  kind: namedIconKindSchema.nullable().optional(),
  /** Only for an icon sent with `kind`: the key as sent, or `null` if it was not a usable string. */
  key: z.string().min(1).max(MAX_ICON_KEY_LENGTH).nullable().optional(),
  error: z.string().min(1),
});

/**
 * `POST /api/v1/ingest/icons` response (200). Every icon is in exactly one
 * list. Since 1.38.0 the first icon for a key wins: an upload never replaces
 * a stored icon (before, other bytes replaced it and were `stored`).
 */
export const iconsUploadResponseSchema = z.strictObject({
  /** Icons for keys that had none. */
  stored: z.array(nonNegativeInt),
  /**
   * Icons for keys that already have one, which was kept: the same bytes, or
   * (since 1.38.0) other bytes. The answer does not say which.
   */
  unchanged: z.array(nonNegativeInt),
  rejected: z.array(iconRejectionSchema),
  /** Only when the request had an icon with `kind`: skill and boss icons for keys that had none. */
  storedNamed: z.array(namedIconRefSchema).optional(),
  /** Only when the request had an icon with `kind`: skill and boss icons whose key already has one. */
  unchangedNamed: z.array(namedIconRefSchema).optional(),
});

/** `GET /api/v1/items/:itemId/icon` path. */
export const itemIconParamsSchema = z.strictObject({
  itemId: intFromString(z.int().nonnegative()),
});

/** `GET /api/v1/skills/:skill/icon` path. */
export const skillIconParamsSchema = z.strictObject({ skill: skillIconKey });

/** `GET /api/v1/bosses/:boss/icon` path. Any known alias works; a raid mode falls back to its raid. */
export const bossIconParamsSchema = z.strictObject({ boss: bossIconKey });

/** `GET /api/v1/admin/icons` response: how many icons are stored, per kind. */
export const iconsStatusResponseSchema = z.strictObject({
  items: nonNegativeInt,
  skills: nonNegativeInt,
  bosses: nonNegativeInt,
  /** When an icon was last stored, or `null` if there are none. */
  lastStoredAt: utcTimestamp.nullable(),
});

export type NamedIconKind = z.infer<typeof namedIconKindSchema>;
export type NamedIconRef = z.infer<typeof namedIconRefSchema>;
export type IconsStatusResponse = z.infer<typeof iconsStatusResponseSchema>;
export type IconUpload = z.infer<typeof iconUploadSchema>;
export type IconsWantedRequest = z.infer<typeof iconsWantedRequestSchema>;
export type IconsWantedResponse = z.infer<typeof iconsWantedResponseSchema>;
export type IconsUploadRequest = z.infer<typeof iconsUploadRequestSchema>;
export type IconRejection = z.infer<typeof iconRejectionSchema>;
export type IconsUploadResponse = z.infer<typeof iconsUploadResponseSchema>;
