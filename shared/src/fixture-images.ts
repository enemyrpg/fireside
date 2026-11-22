import { encodeBase64 } from './png.js';
import { makeSolidPng, makeTinyGif, makeTinyJpeg, pngChunk } from './test-images.js';

// Every fixture that holds image bytes, built from our own generators
// (test-images.ts). `fixture-images.test.ts` checks that each file is identical to
// what is built here, and that no other fixture holds a `png` field, so no
// image from anywhere else can end up in the fixtures (see docs/legal.md). Regenerate with
// `env WRITE_IMAGE_FIXTURES=1 pnpm test shared/src/fixture-images.test.ts`.

const b64 = encodeBase64;
const red = [200, 60, 40, 255] as const;
const blue = [40, 90, 200, 255] as const;

/** An `acTL` chunk: 1 frame, play once. Makes an APNG. */
const actl = pngChunk('acTL', [0, 0, 0, 1, 0, 0, 0, 0]);

const icon = (itemId: number, png: string) => ({ itemId, png });
const smallIcon = (itemId: number) => icon(itemId, b64(makeSolidPng(1, 1, blue)));
/** A skill or boss icon, 25×25 like the game's own. */
const named = (kind: string, key: string) => ({ kind, key, png: b64(makeSolidPng(25, 25, blue)) });

/** Fixture path below `fixtures/api/` → file content. */
export function buildImageFixtures(): Record<string, unknown> {
  return {
    'ingest-icon/valid/solid-32x32.json': icon(4151, b64(makeSolidPng(32, 32, red))),
    'ingest-icon/valid/max-64x64-transparent.json': icon(
      995,
      b64(makeSolidPng(64, 64, [0, 0, 0, 0])),
    ),
    'ingest-icon/valid/noted-item.json': icon(4152, b64(makeSolidPng(32, 32, red))),
    'ingest-icon/valid/rgba.json': icon(11840, b64(makeSolidPng(36, 32, blue, { format: 'rgba' }))),
    'ingest-icon/valid/skill.json': named('SKILL', 'ATTACK'),
    'ingest-icon/valid/boss.json': named('BOSS', "Kree'Arra"),
    'ingest-icon/valid/raid-mode.json': named('BOSS', 'Chambers of Xeric: Challenge Mode'),
    'ingest-icon/invalid/unknown-kind.json': named('NPC', 'Zulrah'),
    'ingest-icon/invalid/item-kind.json': {
      ...icon(4151, b64(makeSolidPng(32, 32, red))),
      kind: 'ITEM',
    },
    'ingest-icon/invalid/lowercase-skill.json': named('SKILL', 'Attack'),
    'ingest-icon/invalid/empty-boss.json': named('BOSS', ''),
    'ingest-icon/invalid/named-with-item-id.json': { ...named('BOSS', 'Zulrah'), itemId: 12921 },
    'ingest-icon/invalid/named-without-key.json': {
      kind: 'SKILL',
      png: b64(makeSolidPng(25, 25, blue)),
    },
    'ingest-icon/invalid/too-large.json': icon(
      4151,
      b64(makeSolidPng(64, 64, red, { format: 'rgba' })),
    ),
    'ingest-icon/invalid/wrong-format-gif.json': icon(4151, b64(makeTinyGif([200, 60, 40]))),
    'ingest-icon/invalid/wrong-format-jpeg.json': icon(4151, b64(makeTinyJpeg())),
    'ingest-icon/invalid/not-base64.json': icon(4151, 'iVBORw0KGgo not base64!'),
    'ingest-icon/invalid/negative-item-id.json': icon(-1, b64(makeSolidPng(32, 32, red))),
    'ingest-icon/invalid/extra-field.json': {
      ...icon(4151, b64(makeSolidPng(32, 32, red))),
      name: 'Abyssal whip',
    },
    'ingest-icon/invalid-semantic/too-wide-65.json': icon(4151, b64(makeSolidPng(65, 1, red))),
    'ingest-icon/invalid-semantic/bad-crc.json': icon(
      4151,
      b64(makeSolidPng(32, 32, red, { badIhdrCrc: true })),
    ),
    'ingest-icon/invalid-semantic/missing-iend.json': icon(
      4151,
      b64(makeSolidPng(32, 32, red, { omitIend: true })),
    ),
    'ingest-icon/invalid-semantic/apng.json': icon(
      4151,
      b64(makeSolidPng(32, 32, red, { extraChunks: [actl] })),
    ),
    'ingest-icons-request/valid/batch.json': {
      icons: [icon(4151, b64(makeSolidPng(32, 32, red))), smallIcon(995)],
    },
    'ingest-icons-request/valid/batch-with-invalid-icon.json': {
      icons: [icon(4151, b64(makeSolidPng(32, 32, red))), icon(995, b64(makeTinyGif([1, 2, 3])))],
    },
    'ingest-icons-request/valid/all-kinds.json': {
      icons: [smallIcon(995), named('SKILL', 'SAILING'), named('BOSS', 'The Fractured Archive')],
    },
    'ingest-icons-request/invalid/too-many-icons.json': {
      icons: Array.from({ length: 101 }, (_, i) => smallIcon(i + 1)),
    },
    'ingest-icons-request/invalid/extra-key.json': { icons: [smallIcon(995)], note: 'extra' },
  };
}
