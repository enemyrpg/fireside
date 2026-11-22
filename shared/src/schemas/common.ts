import { z } from 'zod';
import { ACCOUNT_TYPES } from '../game/account-types.js';

/** UUIDv7, used for `eventId` and `sessionId`. */
export const uuidV7 = z.uuid({ version: 'v7' });

/** ISO 8601 timestamp in UTC with exactly three fractional digits, e.g. `2026-11-08T19:42:13.512Z`. */
export const utcTimestamp = z.iso.datetime({ precision: 3 });

/**
 * RuneLite account hash as a decimal string (a signed 64-bit long, so it can't
 * be a JS number). `-1` means "not logged in" and is never sent.
 */
export const accountHash = z
  .string()
  .regex(/^-?\d+$/, 'Must be a decimal integer string')
  .refine((value) => value !== '-1', 'Account hash -1 means not logged in')
  // The refine is lost in JSON Schema, so state the same rule there.
  .meta({ not: { const: '-1' } });

/** Pattern for `upperName`. */
export const UPPER_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Uppercase enum-style name from RuneLite (e.g. `ATTACK`, `IRONMAN`, `MEMBERS`).
 * Accepts unknown values so new game content never causes errors.
 */
export const upperName = z.string().regex(UPPER_NAME_PATTERN, 'Must be an UPPER_SNAKE_CASE name');

/** Whole number >= 0. */
export const nonNegativeInt = z.int().nonnegative();

/** Whole number >= 1. */
export const positiveInt = z.int().positive();

/** Semantic version, e.g. `0.1.0` or `1.2.0-beta.1`. */
export const semver = z.string().regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/, 'Must be semver');

/**
 * Skill name from RuneLite's `Skill` enum, e.g. `SLAYER`. Accepts unknown
 * names so a new skill never causes errors.
 */
export const skillName = upperName;

/** Account type, e.g. `IRONMAN`. One of `ACCOUNT_TYPES`. */
export const accountTypeName = z.enum(ACCOUNT_TYPES);
