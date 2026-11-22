import {
  type GePriceSource,
  type RaidLootRecipient,
  type RaidDrop,
  type RaidDropCreateRequest,
  type RaidDropUpdateRequest,
  type RaidShareMonth,
  type SplitMode,
} from '@fireside/shared';
import { formatGp, formatInt, formatMonth } from '@/format';
import { localDateTimeToIso } from '@/lib/time';

// Raid loot split tracker in the Raids tab. The server works out every share;
// this file only reads and writes the user's choices and explains the numbers.

// Same limits as the contract (a test checks them). Copied because the schema
// module builds Zod schemas when it loads, which would pull Zod into the bundle.
export const NICKNAME_MAX_LENGTH = 30;
export const NOTE_MAX_LENGTH = 200;
export const PARTY_SIZE_MIN = 1;
export const PARTY_SIZE_MAX = 100;
export const DEFAULT_MODE: SplitMode = 'SPLIT';

/** A change that the server did not take, for a reason that isn't one of the fields. */
export const SAVE_FAILED = "Couldn't save. Try again.";
export const SOLD_FOR_INVALID = 'Enter a number, for example 850m or 850,000,000.';
export const PARTY_SIZE_INVALID = `Enter a party size from ${String(PARTY_SIZE_MIN)} to ${String(PARTY_SIZE_MAX)}.`;
/** Under Nickname and Note. */
export const OWN_NOTE_HELP = 'Your own note. Stored only on your server, never sent by the plugin.';

export function modeLabel(mode: SplitMode): string {
  return mode === 'FFA' ? 'FFA' : 'Split';
}

const GP_UNITS: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/**
 * GP as people type it.
 * - With `k`, `m` or `b`: a comma or a point is the decimal separator, with
 *   at most two decimals (`850m`, `1,2b`, `1.2b`, `850,5m`). Three digits
 *   after it (`1,200k`, `1.200m`) could also be a thousands group, so that
 *   is not read.
 * - Without: a whole number, where a comma, a point or a space is only a
 *   thousands separator in groups of three, the same one throughout
 *   (`850000000`, `850,000,000`, `850.000.000`, `850 000 000`).
 * `null` for anything else (`1,2`, `1,20,0`, `850.000.000,00`) and for more
 * than 2^53 − 1.
 */
export function parseGpInput(text: string): number | null {
  const input = text.trim().toLowerCase();
  let value: number;
  const withUnit = /^(\d+)(?:[.,](\d{1,2}))?([kmb])$/.exec(input);
  if (withUnit) {
    const [, whole = '', decimals = '0', suffix = ''] = withUnit;
    // Every unit has at least three zeros, so two decimals are whole gp.
    value = Math.round(Number(`${whole}.${decimals}`) * (GP_UNITS[suffix] ?? 1));
  } else if (/^(\d+|\d{1,3}(?:([., ])\d{3})(?:\2\d{3})*)$/.test(input)) {
    value = Number(input.replace(/[., ]/g, ''));
  } else {
    return null;
  }
  return Number.isSafeInteger(value) ? value : null;
}

/** DOM id of a drop's row in the table, the target of "Possible duplicate". */
export function dropRowId(dropId: string): string {
  return `drop-${dropId}`;
}

/** "You", the owner's nickname for the teammate, else "Teammate". Never a name from the game. */
export function gotByLabel(drop: Pick<RaidDrop, 'recipient' | 'nickname'>): string {
  if (drop.recipient === 'SELF') return 'You';
  return drop.nickname ?? 'Teammate';
}

/** How the share came about, for its tooltip. `null` when there is no share to explain. */
export function shareExplanation(
  drop: Pick<RaidDrop, 'share' | 'mode' | 'recipient' | 'value' | 'partySize'>,
): string | null {
  if (drop.share === null) return null;
  if (drop.mode === 'FFA') {
    return drop.recipient === 'SELF'
      ? 'FFA: your own drop, full value'
      : 'FFA: a teammate’s drop counts 0';
  }
  if (drop.value === null || drop.partySize === null) return null;
  return `Split: ${formatInt(drop.value)} ÷ ${String(drop.partySize)}`;
}

/** Where a drop's GE price is from, as the label of its tooltip row. */
export function priceSourceLabel(source: GePriceSource): string {
  switch (source) {
    case 'DROP':
      return 'GE price when it dropped';
    case 'SPECIAL_LOOT':
      return 'GE price from another purple';
    case 'LOOT':
      return 'GE price from a loot drop';
    case 'BANK':
      return 'GE price from your bank';
  }
}

/** In the value tooltip of a drop added by hand whose price is newer than the drop. */
export const PRICE_FROM_LATER_DATE = 'No price from that time. This one is from a later date.';

/**
 * True for a drop added by hand with a date before any price of its item in
 * the owner's data: the server then stores the newest price instead, which
 * was seen after the drop.
 */
export function isPriceFromLaterDate(
  drop: Pick<RaidDrop, 'manual' | 'occurredAt' | 'gePriceAt'>,
): boolean {
  // Timestamps have one format, so string comparison is chronological.
  return drop.manual && drop.gePriceAt !== null && drop.gePriceAt > drop.occurredAt;
}

// --- Months -------------------------------------------------------------------

export interface MonthBar {
  key: string;
  /** Axis label: `Nov`, and `Jan 26` for January so years can be told apart. */
  label: string;
  /** Tooltip heading: `Nov 2026`. */
  title: string;
  value: number;
}

/** Your share per local month (`2026-11`) as bars, oldest first. */
export function monthBars(months: readonly RaidShareMonth[]): MonthBar[] {
  return months.map(({ month, share }) => ({
    key: month,
    label: formatMonth(month, month.endsWith('-01') ? '2-digit' : undefined),
    title: formatMonth(month, 'numeric'),
    value: share,
  }));
}

// --- The edit and add forms -----------------------------------------------------

/** The mode select's value for "follow the account's default". */
export const ACCOUNT_DEFAULT = 'DEFAULT';

export interface DropForm {
  soldFor: string;
  mode: SplitMode | typeof ACCOUNT_DEFAULT;
  partySize: string;
  nickname: string;
  note: string;
}

export interface DropChoices {
  ownValue: number | null;
  mode: SplitMode | null;
  partySize: number | null;
  nickname: string | null;
  note: string | null;
}

export type DropField = 'ownValue' | 'partySize' | 'nickname' | 'note';
export type DropFormErrors = Partial<
  Record<DropField | 'occurredAt' | 'time' | 'itemId' | 'raid', string>
>;

/**
 * The form as it opens: the drop's own choices. The party size is empty unless
 * the owner set one; the plugin's size is the field's placeholder.
 */
export function dropForm(drop: RaidDrop): DropForm {
  return {
    soldFor: drop.ownValue === null ? '' : formatInt(drop.ownValue),
    mode: drop.overridden ? drop.mode : ACCOUNT_DEFAULT,
    partySize: drop.partySizeOverridden && drop.partySize !== null ? String(drop.partySize) : '',
    nickname: drop.nickname ?? '',
    note: drop.note ?? '',
  };
}

function parsePartySize(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const size = Number(trimmed);
  return size >= PARTY_SIZE_MIN && size <= PARTY_SIZE_MAX ? size : undefined;
}

/**
 * Reads the form. An empty field is `null` ("not set"). The text rules for
 * nickname and note live on the server; its messages show under the fields.
 */
export function parseDropForm(
  form: DropForm,
): { ok: true; choices: DropChoices } | { ok: false; errors: DropFormErrors } {
  const errors: DropFormErrors = {};
  const soldFor = form.soldFor.trim();
  const ownValue = soldFor === '' ? null : parseGpInput(soldFor);
  if (soldFor !== '' && ownValue === null) errors.ownValue = SOLD_FOR_INVALID;
  const partySize = parsePartySize(form.partySize);
  if (partySize === undefined) errors.partySize = PARTY_SIZE_INVALID;
  if (partySize === undefined || Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    choices: {
      ownValue,
      mode: form.mode === ACCOUNT_DEFAULT ? null : form.mode,
      partySize,
      nickname: form.nickname.trim() || null,
      note: form.note.trim() || null,
    },
  };
}

/**
 * The `PATCH` body: only what changed. `null` clears a choice (the mode goes
 * back to the account default, the value to the GE value, the party size to
 * the plugin's). Only a teammate's drop can have a nickname.
 */
export function dropChanges(drop: RaidDrop, choices: DropChoices): RaidDropUpdateRequest {
  const changes: RaidDropUpdateRequest = {};
  if (choices.ownValue !== drop.ownValue) changes.ownValue = choices.ownValue;
  if (choices.mode !== (drop.overridden ? drop.mode : null)) changes.mode = choices.mode;
  // Against the owner's own size: clearing a field that only showed the plugin's changes nothing.
  const ownPartySize = drop.partySizeOverridden ? drop.partySize : null;
  if (choices.partySize !== ownPartySize) changes.partySize = choices.partySize;
  if (drop.recipient === 'TEAMMATE' && choices.nickname !== drop.nickname) {
    changes.nickname = choices.nickname;
  }
  if (choices.note !== drop.note) changes.note = choices.note;
  return changes;
}

// --- Adding a drop ------------------------------------------------------------------

/** "Got by" in the "Add a drop" dialog. A teammate is chosen from the start. */
export const RECIPIENT_OPTIONS = [
  { value: 'SELF', label: 'You' },
  { value: 'TEAMMATE', label: 'Teammate' },
] as const satisfies readonly { value: RaidLootRecipient; label: string }[];

/**
 * The first day a drop added by hand can have: the day Old School RuneScape
 * launched. Same day as `EARLIEST_MANUAL_DROP_AT` in the contract (a test
 * checks it).
 */
export const EARLIEST_DROP_DATE = '2013-02-22';

export const TIME_INVALID = 'Enter a 24-hour time as HH:mm, for example 21:40.';
export const TIME_IN_FUTURE = 'Enter a time that is not in the future.';

export interface AddDropForm {
  raid: string;
  /** Who got it. Can't be changed after the drop is added. */
  recipient: RaidLootRecipient;
  /** Item ID as text; empty until chosen. */
  itemId: string;
  /** Local date in the server's time zone (`2026-11-16`). */
  date: string;
  /** 24-hour time as typed (`21:40`), in the server's time zone. */
  time: string;
  partySize: string;
  nickname: string;
  soldFor: string;
}

/**
 * Reads the "Add a drop" form into the `POST` body. The date and time are
 * read in the server's time zone, never the browser's. Empty optional fields
 * are left out, and so is the nickname for an own drop (the field is hidden
 * then, and only a teammate's drop can have one).
 */
export function parseAddDropForm(
  form: AddDropForm,
  timeZone: string,
  now: number = Date.now(),
): { ok: true; body: RaidDropCreateRequest } | { ok: false; errors: DropFormErrors } {
  const errors: DropFormErrors = {};
  if (form.raid === '') errors.raid = 'Choose a raid.';
  if (form.itemId === '') errors.itemId = 'Choose an item.';
  const occurredAt = localDateTimeToIso(form.date, form.time, timeZone);
  if (occurredAt === null) errors.time = TIME_INVALID;
  else if (Date.parse(occurredAt) > now) errors.time = TIME_IN_FUTURE;
  const parsed = parseDropForm({
    soldFor: form.soldFor,
    mode: ACCOUNT_DEFAULT,
    partySize: form.partySize,
    nickname: form.recipient === 'TEAMMATE' ? form.nickname : '',
    note: '',
  });
  if (!parsed.ok) Object.assign(errors, parsed.errors);
  if (!parsed.ok || occurredAt === null || Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  const { ownValue, partySize, nickname } = parsed.choices;
  return {
    ok: true,
    body: {
      raid: form.raid,
      itemId: Number(form.itemId),
      occurredAt,
      recipient: form.recipient,
      ...(partySize !== null ? { partySize } : {}),
      ...(ownValue !== null ? { ownValue } : {}),
      ...(nickname !== null ? { nickname } : {}),
    },
  };
}

/** After the help under "Sold for": the forms `parseGpInput` reads. */
export const GP_INPUT_HINT = 'You can type 850m, 1,2b or 850.000.000.';

/** Help under "Sold for": what the value is when the field is empty. */
export function soldForHelp(drop: Pick<RaidDrop, 'geValue' | 'manual'>): string {
  if (drop.geValue === null) {
    return `No GE price was known when you added this drop, so it counts 0 until you enter what it sold for. ${GP_INPUT_HINT}`;
  }
  const price = drop.manual
    ? 'the GE price from when you added it'
    : 'the GE price when it dropped';
  return `Leave empty to use ${price} (${formatGp(drop.geValue)}). ${GP_INPUT_HINT}`;
}
