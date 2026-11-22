import { describe, expect, it } from 'vitest';
import { encodeBase64, MAX_ICON_BYTES } from '../../png.js';
import { makeSolidPng, pngChunk } from '../../test-images.js';
import { schemaAsserts } from '../../test-utils.js';
import {
  iconsUploadRequestSchema,
  iconsWantedRequestSchema,
  bossIconParamsSchema,
  iconsWantedResponseSchema,
  iconUploadSchema,
  iconUploadSchemaFor,
  itemIconParamsSchema,
  itemIconUploadSchema,
  skillIconParamsSchema,
  MAX_ICON_BASE64_LENGTH,
  MAX_ICONS_PER_REQUEST,
  MAX_ICON_IDS,
} from './icons.js';

const red = [200, 60, 40, 255] as const;
const png = encodeBase64(makeSolidPng(32, 32, red));

describe('iconUploadSchema', () => {
  const icon = schemaAsserts(iconUploadSchema);

  it('accepts a PNG icon', () => {
    icon.accepts({ itemId: 4151, png });
  });

  it('gives one issue per problem, with the PNG reason', () => {
    const result = itemIconUploadSchema.safeParse({
      itemId: 4151,
      png: encodeBase64(makeSolidPng(65, 1, red)),
    });
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['png', 'Image is 65×1, at most 64×64 allowed'],
    ]);
  });

  it('caps the base64 length at the 16 KB limit', () => {
    expect(MAX_ICON_BASE64_LENGTH).toBe(21848);
    const base = makeSolidPng(8, 8, red);
    const sized = (total: number) =>
      encodeBase64(
        makeSolidPng(8, 8, red, {
          extraChunks: [pngChunk('tEXt', new Uint8Array(total - base.length - 12).fill(0x61))],
        }),
      );
    icon.accepts({ itemId: 1, png: sized(MAX_ICON_BYTES) });
    // 16385 bytes still fit in 21848 base64 characters, so checkPng catches it.
    const justOver = itemIconUploadSchema.safeParse({ itemId: 1, png: sized(MAX_ICON_BYTES + 1) });
    expect(justOver.error?.issues.map((issue) => issue.message)).toEqual([
      'PNG is 16385 bytes, at most 16384 allowed',
    ]);
    const tooLong = itemIconUploadSchema.safeParse({ itemId: 1, png: sized(MAX_ICON_BYTES + 3) });
    expect(tooLong.error?.issues.map((issue) => issue.message)).toEqual([
      'Must be at most 16384 bytes',
    ]);
  });

  it('rejects base64 without padding, other formats and bad item IDs', () => {
    icon.rejects({ itemId: 4151, png: png.replace(/=+$/, '') + (png.endsWith('=') ? '' : 'A') });
    icon.rejects({ itemId: 4151, png: 'R0lGODlhAQABAAAAACw=' });
    icon.rejects({ itemId: -1, png });
    icon.rejects({ itemId: 1.5, png });
    icon.rejects({ itemId: '4151', png });
  });
});

describe('skill and boss icons (1.29.0)', () => {
  const icon = schemaAsserts(iconUploadSchema);

  it('accepts a skill and a boss or raid name as the game writes it', () => {
    icon.accepts({ kind: 'SKILL', key: 'ATTACK', png });
    icon.accepts({ kind: 'SKILL', key: 'OVERALL', png });
    icon.accepts({ kind: 'SKILL', key: 'SOME_NEW_SKILL', png });
    icon.accepts({ kind: 'BOSS', key: "Kree'Arra", png });
    icon.accepts({ kind: 'BOSS', key: 'Tombs of Amascut: Expert Mode', png });
  });

  it('rejects unknown kinds, bad keys and a mix of the two shapes', () => {
    icon.rejects({ kind: 'ITEM', key: '4151', png });
    icon.rejects({ kind: 'SKILL', key: 'Attack', png });
    icon.rejects({ kind: 'SKILL', key: '', png });
    icon.rejects({ kind: 'BOSS', key: '', png });
    icon.rejects({ kind: 'BOSS', key: ' Zulrah', png });
    icon.rejects({ kind: 'BOSS', key: 'x'.repeat(101), png });
    icon.rejects({ kind: 'BOSS', key: 'Zulrah', itemId: 12921, png });
    icon.rejects({ kind: 'BOSS', key: 'Zulrah' });
  });

  it('picks the member schema from kind, so errors name the field', () => {
    const issues = (raw: unknown) =>
      iconUploadSchemaFor(raw)
        .safeParse(raw)
        .error?.issues.map((issue) => issue.path.join('.'));
    expect(issues({ itemId: -1, png })).toEqual(['itemId']);
    expect(issues({ kind: 'SKILL', key: 'attack', png })).toEqual(['key']);
    expect(issues({ kind: 'BOSS', key: 'Zulrah', png: 'x' })).toEqual(['png']);
    expect(issues({ kind: 'NPC', key: 'Zulrah', png })).toEqual(['kind']);
    expect(issues('nope')).toEqual(['']);
  });
});

describe('request envelopes', () => {
  it('takes skills and bosses in wanted, with at most 500 keys in total', () => {
    const wanted = schemaAsserts(iconsWantedRequestSchema);
    wanted.accepts({ skills: ['ATTACK'] });
    wanted.accepts({ bosses: ['Zulrah'] });
    wanted.accepts({ itemIds: [1], skills: ['ATTACK'], bosses: ['Zulrah'] });
    wanted.accepts({
      itemIds: Array.from({ length: MAX_ICON_IDS - 2 }, (_, i) => i),
      skills: ['ATTACK'],
      bosses: ['Zulrah'],
    });
    wanted.rejects({
      itemIds: Array.from({ length: MAX_ICON_IDS - 1 }, (_, i) => i),
      skills: ['ATTACK'],
      bosses: ['Zulrah'],
    });
    wanted.rejects({});
    wanted.rejects({ skills: [] });
    wanted.rejects({ skills: ['attack'] });
    wanted.rejects({ bosses: [''] });
  });

  it('keeps the answer to an item-only request as before', () => {
    const response = schemaAsserts(iconsWantedResponseSchema);
    response.accepts({ missing: [1] });
    response.accepts({ missing: [], missingSkills: ['ATTACK'], missingBosses: ["Kree'Arra"] });
    response.rejects({ missingSkills: ['ATTACK'] });
  });

  it('limits wanted IDs to 1–500', () => {
    const wanted = schemaAsserts(iconsWantedRequestSchema);
    wanted.accepts({ itemIds: [0] });
    wanted.accepts({ itemIds: Array.from({ length: MAX_ICON_IDS }, (_, i) => i) });
    wanted.rejects({ itemIds: Array.from({ length: MAX_ICON_IDS + 1 }, (_, i) => i) });
    wanted.rejects({ itemIds: [] });
  });

  it('limits uploads to 1–100 icons without checking them', () => {
    const upload = schemaAsserts(iconsUploadRequestSchema);
    upload.accepts({ icons: [{ anything: true }] });
    upload.accepts({ icons: new Array(MAX_ICONS_PER_REQUEST).fill({}) });
    upload.rejects({ icons: new Array(MAX_ICONS_PER_REQUEST + 1).fill({}) });
    upload.rejects({ icons: [] });
  });
});

describe('skill and boss icon params', () => {
  it('takes the names used in the data', () => {
    expect(skillIconParamsSchema.parse({ skill: 'ATTACK' })).toEqual({ skill: 'ATTACK' });
    expect(bossIconParamsSchema.parse({ boss: 'Theatre of Blood: Entry Mode' })).toEqual({
      boss: 'Theatre of Blood: Entry Mode',
    });
    for (const skill of ['attack', '', 'A B', '1ST']) {
      expect(skillIconParamsSchema.safeParse({ skill }).success).toBe(false);
    }
    for (const boss of ['', ' ', 'x'.repeat(101)]) {
      expect(bossIconParamsSchema.safeParse({ boss }).success).toBe(false);
    }
  });
});

describe('itemIconParamsSchema', () => {
  it('parses a whole number and rejects anything else', () => {
    expect(itemIconParamsSchema.parse({ itemId: '4151' })).toEqual({ itemId: 4151 });
    expect(itemIconParamsSchema.parse({ itemId: '0' })).toEqual({ itemId: 0 });
    for (const itemId of ['-1', '01', 'abc', '1.5', '99999999999999999999']) {
      expect(itemIconParamsSchema.safeParse({ itemId }).success).toBe(false);
    }
  });
});
