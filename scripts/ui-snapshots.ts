// Full-page screenshots of today's dashboard, as a reference set when the
// design changes. Not part of CI.
//
//   pnpm build && node scripts/ui-snapshots.ts
//
// Needs `pnpm build` first (server/dist and web/dist). Fills a new seed
// database (the same generator as `pnpm seed`) in a temporary folder, starts
// the built server on a free port on 127.0.0.1, and stops only the processes
// it started. Never touches DATA_DIR, ./data, ./data-seed or port 3100. The
// servers never read .env and have every external source off; the script
// refuses to go on if one could make an external call (lib/scratch-server.ts).
//
// Writes .snapshots/<width>/<page>-<state>.png (git-ignored).
// Options (environment):
//   SNAPSHOT_SEED    seed number (default 1)
//   SNAPSHOT_ONLY    only shots whose file name contains this text (or one of
//                    several, comma-separated)
//   SNAPSHOT_WIDTHS  comma-separated widths (default 390,1440); up to 860
//                    is the mobile layout, e.g. 390,960,1100,1440
//   SNAPSHOT_THEMES  comma-separated themes (ember, dark, light). When set,
//                    every shot (account pages, Session detail, settings,
//                    states) is taken in each of them. Without it: Ember and
//                    Dark for everything, Light only for LIGHT_PAGES
//   SNAPSHOT_MEASURE 1: also write <page>-<state>.styles.json next to each shot,
//                    with the computed styles of what is on screen (text,
//                    boxes and chart marks, colours as token names, and the
//                    contrast of each text against what is behind it), for
//                    checking exact values by hand
//   SNAPSHOT_AXE     1: also run axe-core on each shot (in the page, no
//                    network) and write axe-report-<widths>.json
//   SNAPSHOT_README  1: only the README screenshots, into docs/screenshots/
//                    (committed): Home, Sessions, Bank and Raids at 1440 px
//                    and Home at 390 px, in Ember, straight from the seed
//                    database (no sample answers, so no Price movers)
//   SNAPSHOT_TMP     parent of the temporary folder (default: system temp)
//   CHROMIUM_PATH    browser (default /usr/bin/chromium if it exists, else
//                    Playwright's own Chromium)

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  seedScratch,
  startScratchServer,
  stopServer,
  type ScratchServer,
} from './lib/scratch-server.ts';
import { totpNow } from './lib/totp.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, '.snapshots');
const PASSWORD = 'snapshot password 1';
const SEED = process.env.SNAPSHOT_SEED ?? '1';
const ONLY = (process.env.SNAPSHOT_ONLY ?? '')
  .split(',')
  .map((text) => text.trim())
  .filter((text) => text !== '');

const MEASURE = process.env.SNAPSHOT_MEASURE === '1';
const AXE = process.env.SNAPSHOT_AXE === '1';
const README = process.env.SNAPSHOT_README === '1';
const README_OUT = join(ROOT, 'docs/screenshots');

/** The theme tokens (web/src/theme/themes.css), for naming measured colours. */
const TOKENS = [
  'page',
  'card',
  'raised',
  'hover',
  'border',
  'border-strong',
  'text',
  'text-2',
  'text-3',
  'accent',
  'accent-text',
  'on-accent',
  'accent-wash',
  'active',
  'afk',
  'acc-1',
  'acc-2',
  'acc-3',
  'acc-4',
  'acc-5',
  'heat-0',
  'heat-1',
  'heat-2',
  'heat-3',
  'heat-4',
  'heat-5',
  'heat-6',
  'up',
  'down',
  'on-down',
  'live',
  'info',
  'info-text',
  'info-wash',
  'grid',
  'overlay',
];

/** Ember is the default. Dark gets every page too, Light only LIGHT_PAGES. */
const THEMES = ['ember', 'dark', 'light'] as const;
type Theme = (typeof THEMES)[number];

function isTheme(text: string): text is Theme {
  return (THEMES as readonly string[]).includes(text);
}

/** `SNAPSHOT_THEMES`: every shot in each of these themes. Unset: the default above. */
const THEMES_OPTION: Theme[] | undefined = process.env.SNAPSHOT_THEMES
  ? process.env.SNAPSHOT_THEMES.split(',')
      .map((text) => text.trim())
      .filter((text) => text !== '')
      .map((text) => {
        if (!isTheme(text)) throw new Error(`Bad theme: ${text} (use ${THEMES.join(', ')})`);
        return text;
      })
  : undefined;
if (THEMES_OPTION?.length === 0) {
  throw new Error(`SNAPSHOT_THEMES has no theme (use ${THEMES.join(', ')})`);
}

/** Only Light is limited, and only without `SNAPSHOT_THEMES`. */
function limitedTheme(theme: Theme): boolean {
  return THEMES_OPTION === undefined && theme === 'light';
}

interface Viewport {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
}

const DESKTOP: Viewport = { name: '1440', width: 1440, height: 900, mobile: false };
const VIEWPORTS: Viewport[] = process.env.SNAPSHOT_WIDTHS
  ? process.env.SNAPSHOT_WIDTHS.split(',')
      .map((text) => text.trim())
      .filter((text) => text !== '')
      .map((text) => {
        const width = Number(text);
        if (!Number.isInteger(width) || width < 320) throw new Error(`Bad width: ${text}`);
        const mobile = width <= 860;
        return { name: String(width), width, height: mobile ? 844 : 900, mobile };
      })
  : [{ name: '390', width: 390, height: 844, mobile: true }, DESKTOP];

/**
 * Account pages from web/src/pages/registry.ts: file name and path below
 * `/<scope>`. The file names are older than the current routes and are kept,
 * so earlier and later images line up; Boss KC is part of `loot`.
 */
const ACCOUNT_PAGES: [string, string][] = [
  ['overview', ''],
  ['sessions', 'activity/sessions'],
  ['screentime', 'activity/screentime'],
  ['weekly', 'activity/weekly'],
  ['xp', 'progress/xp'],
  ['loot', 'progress/loot'],
  ['loot-raids', 'progress/raids'],
  ['clog', 'collections/log'],
  ['pets', 'collections/pets'],
  ['bank', 'bank'],
  ['quests', 'collections/quests'],
];

/** Settings tabs (registry.ts): file name and path. */
const SETTINGS_PAGES: [string, string][] = [
  ['settings-profile', '/settings'],
  ['settings-keys', '/settings/keys'],
  ['settings-accounts', '/settings/accounts'],
  ['settings-users', '/settings/users'],
  ['settings-server', '/settings/server'],
  // History screens behind the link rows.
  ['settings-keys-revoked', '/settings/keys/revoked'],
  ['settings-users-keys-revoked', '/settings/users/keys/revoked'],
  ['settings-invites-past', '/settings/users/invites'],
];

/** Pages shot in the light theme too. */
const LIGHT_PAGES = new Set(['overview', 'bank']);

const written: string[] = [];
/** Members made for the two-factor states: each needs its own user. */
let members = 0;
const skipped: string[] = [];

function log(message: string): void {
  console.log(`[ui-snapshots] ${message}`);
}

const SCRATCH = { timeZone: process.env.TZ ?? 'Europe/Oslo' };

/** A scratch server on `dir` (scripts/lib/scratch-server.ts): never reads .env, every external source off. */
async function startServer(dir: string): Promise<ScratchServer> {
  const started = await startScratchServer(dir, SCRATCH);
  log(`server pid ${String(started.server.pid)} on ${started.base} (${dir})`);
  return started;
}

function apiHeaders(base: string, cookie?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    origin: base,
    ...(cookie === undefined ? {} : { cookie }),
  };
}

async function api<T>(base: string, cookie: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}/api/v1${path}`, {
    ...init,
    headers: apiHeaders(base, cookie),
  });
  if (!response.ok) throw new Error(`${path}: ${String(response.status)} ${await response.text()}`);
  return (await response.json()) as T;
}

async function newContext(
  browser: Browser,
  viewport: Viewport,
  theme: Theme,
  storageState?: Awaited<ReturnType<BrowserContext['storageState']>>,
  deviceScaleFactor = 1,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    colorScheme: theme === 'light' ? 'light' : 'dark',
    reducedMotion: 'reduce',
    timezoneId: process.env.TZ ?? 'Europe/Oslo',
    locale: 'en-GB',
    ...(storageState ? { storageState } : {}),
  });
  // The theme is read from localStorage before React renders.
  await context.addInitScript((value) => {
    try {
      localStorage.setItem('theme', value);
    } catch {
      // Storage blocked: the default (Ember) theme.
    }
  }, theme);
  return context;
}

/**
 * Price movers with fixed sample numbers. The seed server has the price source off (it must never
 * call the wiki), so the browser answers instead: the bank says its prices are
 * current, and `…/bank/price-movers` gives these periods. Returns a function
 * that removes the answers again.
 */
async function samplePriceMovers(page: Page, accountId: number): Promise<() => Promise<void>> {
  const fetchedAt = '2026-11-21T12:00:04.000Z';
  const item = (
    itemId: number,
    name: string,
    quantity: number,
    priceEach: number,
    previousPriceEach: number,
  ) => ({
    kind: 'ITEM',
    itemId,
    name,
    quantity,
    priceEach,
    previousPriceEach,
    change: quantity * (priceEach - previousPriceEach),
  });
  const period = (name: string, baselineAt: string, items: ReturnType<typeof item>[]) => {
    const sorted = [...items].sort((a, b) => b.change - a.change || a.itemId - b.itemId);
    return {
      period: name,
      baselineAt,
      change: sorted.reduce((sum, row) => sum + row.change, 0),
      items: sorted,
    };
  };
  const body = {
    prices: { source: 'CURRENT', fetchedAt },
    periods: [
      period('24h', '2026-11-20T12:00:03.000Z', [
        item(27641, 'Saturated heart', 1, 61_090_000, 60_950_000),
        item(31106, 'Confliction gauntlets', 1, 57_270_000, 57_400_000),
      ]),
      // Expected: ▲ 4.18M, +4.2% 2.46M … −0.8% 1,540 (whole prices give 9,075 and 1,542).
      period('7d', '2026-11-14T00:00:05.000Z', [
        item(27641, 'Saturated heart', 1, 61_090_000, 58_630_000),
        item(27226, 'Masori body', 1, 47_250_000, 45_830_000),
        item(22978, 'Dragon hunter lance', 1, 39_380_000, 38_270_000),
        item(29801, 'Amulet of rancour', 1, 43_322_000, 42_556_000),
        item(31106, 'Confliction gauntlets', 1, 57_270_000, 58_800_000),
        item(11237, 'Dragon arrowtips', 356, 2_642, 2_755),
        item(9194, 'Onyx bolt tips', 55, 8_500, 8_665),
        item(1201, 'Rune kiteshield', 6, 31_800, 32_057),
      ]),
      period('30d', '2026-10-22T00:00:02.000Z', [
        item(27226, 'Masori body', 1, 47_250_000, 49_100_000),
        item(22978, 'Dragon hunter lance', 1, 39_380_000, 36_900_000),
      ]),
    ],
  };
  const bankUrl = `**/api/v1/accounts/${String(accountId)}/bank`;
  const moversUrl = `**/api/v1/accounts/${String(accountId)}/bank/price-movers`;
  await page.route(bankUrl, async (route) => {
    const response = await route.fetch();
    const bank = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...bank, prices: body.prices } });
  });
  await page.route(moversUrl, (route) => route.fulfill({ json: body }));
  return async () => {
    await page.unroute(bankUrl);
    await page.unroute(moversUrl);
  };
}

/**
 * A session with 14 new collection log items: the seed's sessions have two at
 * most, so the browser answers `sessions/:id` with the session's own detail
 * plus 14 sample items (real collection log names and item IDs; the seed has no
 * icons, so placeholders). Not used for the README. Returns a function that
 * removes the answer again.
 */
async function sampleManyClogItems(page: Page, sessionId: string): Promise<() => Promise<void>> {
  const url = `**/api/v1/sessions/${sessionId}`;
  const sample: [number, string, string][] = [
    [22006, "Vorkath's head", 'Vorkath'],
    [22111, 'Dragonbone necklace', 'Vorkath'],
    [12922, 'Tanzanite fang', 'Zulrah'],
    [12932, 'Magic fang', 'Zulrah'],
    [12927, 'Serpentine visage', 'Zulrah'],
    [28321, 'Chromium ingot', 'Duke Sucellus'],
    [28334, 'Eye of the duke', 'Duke Sucellus'],
    [29790, 'Noxious point', 'Araxxor'],
    [29792, 'Noxious blade', 'Araxxor'],
    [29794, 'Noxious pommel', 'Araxxor'],
    [28279, "Executioner's axe head", 'Vardorvis'],
    [28283, 'Virtus mask', 'Vardorvis'],
    [12938, 'Zul-andra teleport', 'Zulrah'],
    [21992, 'Vorki', 'Vorkath'],
  ];
  await page.route(url, async (route) => {
    const response = await route.fetch();
    const detail = (await response.json()) as {
      session: { startedAt: string; newCollectionLogCount: number };
      collectionLog: { obtained: number | null; total: number | null; items: unknown[] };
    };
    const start = Date.parse(detail.session.startedAt);
    const items = sample.map(([itemId, name, pageName], index) => ({
      itemId,
      name,
      tab: 'Bosses',
      page: pageName,
      pageObtained: 3,
      pageTotal: 9,
      at: new Date(start + (index + 1) * 7 * 60_000).toISOString(),
      approximate: index >= 12,
    }));
    await route.fulfill({
      response,
      json: {
        ...detail,
        session: { ...detail.session, newCollectionLogCount: items.length },
        collectionLog: { obtained: 355, total: 1734, items },
      },
    });
  });
  return async () => {
    await page.unroute(url);
  };
}

/**
 * Computed styles of the Price movers card, for checking exact values by
 * hand: written next to the screenshot as JSON.
 */
async function measurePriceMovers(page: Page, viewport: Viewport, name: string): Promise<void> {
  if (!wanted(viewport, name)) return;
  const styles = await page.evaluate(() => {
    const heading = [...document.querySelectorAll('h2')].find(
      (h2) => h2.textContent.trim() === 'Price movers',
    );
    const card = heading?.closest('section');
    if (!card) return null;
    const pick = (element: Element | null | undefined, properties: string[]) => {
      if (!element) return null;
      const computed = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const out: Record<string, string> = {
        width: `${String(Math.round(box.width * 100) / 100)}px`,
        height: `${String(Math.round(box.height * 100) / 100)}px`,
      };
      for (const property of properties) out[property] = computed.getPropertyValue(property);
      return out;
    };
    const text = ['font-family', 'font-size', 'font-weight', 'color'];
    const box = [
      'padding-top',
      'padding-right',
      'border-top-left-radius',
      'border-top-color',
      'border-top-width',
      'background-color',
      'row-gap',
      'column-gap',
    ];
    const group = (label: string) => card.querySelector(`[aria-label="${label}"]`);
    const button = (label: string, on: boolean) =>
      group(label)?.querySelector(`[data-state="${on ? 'on' : 'off'}"]`);
    const lists = [...card.querySelectorAll('ul')];
    const row = lists[0]?.querySelector('li');
    const lostRow = lists[1]?.querySelector('li');
    const sum = card.querySelector('.font-display');
    const footer = [...card.querySelectorAll('span')].find((span) =>
      span.textContent.startsWith('Ranked by'),
    );
    return {
      card: pick(card, box),
      heading: pick(heading, text),
      rankings: pick(group('Item rankings'), box),
      rankingOn: pick(button('Item rankings', true), [...text, ...box]),
      rankingOff: pick(button('Item rankings', false), [...text, ...box]),
      periods: pick(group('Period'), box),
      periodOn: pick(button('Period', true), [...text, ...box]),
      periodOff: pick(button('Period', false), [...text, ...box]),
      sum: pick(sum, text),
      sumRow: pick(sum?.parentElement, ['row-gap', 'column-gap']),
      caption: pick(sum?.nextElementSibling, text),
      listHeading: pick(card.querySelector('h3'), [
        ...text,
        'letter-spacing',
        'text-transform',
        'margin-bottom',
      ]),
      row: pick(row, [
        'display',
        'grid-template-columns',
        'column-gap',
        'padding-top',
        'padding-bottom',
        'min-height',
        'border-top-color',
        'border-top-width',
        'font-size',
      ]),
      icon: pick(row?.firstElementChild, ['border-top-left-radius']),
      name: pick(row?.children[1]?.firstElementChild ?? row?.children[1], text),
      percent: pick(row?.querySelector('.text-text-3'), [...text, 'text-align']),
      up: pick(row?.querySelector('.text-up'), [...text, 'text-align']),
      down: pick(lostRow?.querySelector('.text-down'), [...text, 'text-align']),
      footer: pick(footer, [...text, 'display']),
      vars: pick(document.documentElement, [
        '--card',
        '--page',
        '--border',
        '--hover',
        '--text',
        '--text-2',
        '--text-3',
        '--accent',
        '--accent-wash',
        '--accent-text',
        '--on-accent',
        '--up',
        '--down',
      ]),
    };
  });
  const file = join(OUT, viewport.name, `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(styles, null, 2)}\n`);
  log(`  ${viewport.name}/${name}.json`);
}

/** Waits until the page has loaded its data: no request in flight and no skeleton or "Loading" left. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-slot="skeleton"], [aria-busy="true"]') === null &&
        document.querySelector('h1, main') !== null,
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => {
      log(`  still loading after 15 s: ${page.url()}`);
    });
  // Charts measure their container after the first paint.
  await page.waitForTimeout(600);
}

interface AxeFinding {
  shot: string;
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string; html: string; summary: string }[];
}
const axeFindings: AxeFinding[] = [];
let axeShots = 0;

/**
 * Computed styles of everything visible, written next to the screenshot. One
 * entry per distinct style, with a sample text, how many elements share it and
 * where it is (the card's heading, a dialog, the header). Colours are token
 * names where they match one; a text also has the colour behind it (ancestors'
 * backgrounds, composited) and the contrast.
 */
async function measurePage(page: Page, viewport: Viewport, name: string): Promise<void> {
  const entries = await page.evaluate((tokens) => {
    type Rgba = [number, number, number, number];
    const parse = (color: string): Rgba | null => {
      const rgb = /^rgba?\(([^)]+)\)$/.exec(color);
      if (rgb) {
        const parts = (rgb[1] ?? '').split(/[,/ ]+/).filter((part) => part !== '');
        return [Number(parts[0]), Number(parts[1]), Number(parts[2]), Number(parts[3] ?? 1)];
      }
      const srgb = /^color\(srgb ([^)]+)\)$/.exec(color);
      if (srgb) {
        const parts = (srgb[1] ?? '').split(/[/ ]+/).filter((part) => part !== '');
        return [
          Math.round(Number(parts[0]) * 255),
          Math.round(Number(parts[1]) * 255),
          Math.round(Number(parts[2]) * 255),
          Number(parts[3] ?? 1),
        ];
      }
      return null;
    };
    const names = new Map<string, string>();
    for (const token of tokens) {
      // A new element each time, with no transition: a colour that is still
      // changing would be read as the one before it.
      const probe = document.createElement('span');
      probe.style.transition = 'none';
      probe.style.color = `var(--${token})`;
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      if (!names.has(value)) names.set(value, `--${token}`);
      probe.remove();
    }
    const named = (color: string): string => names.get(color) ?? color;
    const over = (top: Rgba, bottom: Rgba): Rgba => {
      const alpha = top[3] + bottom[3] * (1 - top[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      const mix = (i: 0 | 1 | 2) =>
        (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / alpha;
      return [mix(0), mix(1), mix(2), alpha];
    };
    /** What is painted behind `element`: its ancestors' backgrounds, composited. */
    const behind = (element: Element): { color: Rgba; name: string; opacity: number } => {
      const layers: Rgba[] = [];
      let name = '';
      let opacity = 1;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        opacity *= Number(style.opacity);
        const background = parse(style.backgroundColor);
        if (background && background[3] > 0) {
          layers.push(background);
          if (name === '') name = named(style.backgroundColor);
          if (background[3] === 1) break;
        }
      }
      let color: Rgba = [255, 255, 255, 1];
      for (const layer of layers.reverse()) color = over(layer, color);
      return { color, name, opacity };
    };
    const luminance = (color: Rgba): number => {
      const channel = (value: number) => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
    };
    const contrast = (a: Rgba, b: Rgba): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    };
    const where = (element: Element): string => {
      const dialog = element.closest(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
      );
      if (dialog) return `(${dialog.getAttribute('role') ?? ''})`;
      const card = element.closest('section');
      const heading = card?.querySelector('h2, h3');
      if (card) {
        const title = heading?.textContent.trim().slice(0, 40) ?? '';
        if (title !== '') return title;
        return card.getAttribute('aria-label') ?? '(card)';
      }
      if (element.closest('nav')) return '(nav)';
      if (element.closest('header')) return '(header)';
      if (element.closest('footer')) return '(footer)';
      return '(page)';
    };
    const px = (value: string) => value.replace(/(\d+\.\d{2})\d+px/g, '$1px');

    const found = new Map<string, Record<string, string | number>>();
    const add = (entry: Record<string, string | number>, sample: string) => {
      const key = JSON.stringify(entry);
      const existing = found.get(key);
      if (existing) existing.count = Number(existing.count) + 1;
      else found.set(key, { ...entry, sample, count: 1 });
    };
    for (const element of document.body.querySelectorAll('*')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const tag = element.tagName.toLowerCase();
      const place = where(element);
      const svg = element instanceof SVGElement && tag !== 'svg';
      if (svg) {
        if (!['rect', 'path', 'circle', 'line', 'text'].includes(tag)) continue;
        const paint = tag === 'line' || style.fill === 'none' ? style.stroke : style.fill;
        const color = parse(paint);
        if (!color || color[3] === 0) continue;
        const back = behind(element);
        add(
          {
            kind: 'mark',
            where: place,
            tag,
            paint: named(paint),
            behind: back.name,
            contrast: contrast(over(color, back.color), back.color),
            ...(tag === 'text' ? { 'font-size': style.fontSize } : {}),
          },
          element.textContent.trim().slice(0, 30),
        );
        continue;
      }
      const text = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('')
        .trim();
      const placeholder =
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value || element.placeholder
          : '';
      if (text !== '' || placeholder !== '') {
        const back = behind(element);
        const color = parse(style.color) ?? [0, 0, 0, 1];
        add(
          {
            kind: 'text',
            where: place,
            tag,
            font: (style.fontFamily.split(',')[0] ?? '').replace(/"/g, '').trim(),
            'font-size': style.fontSize,
            'font-weight': style.fontWeight,
            'line-height': px(style.lineHeight),
            'letter-spacing': px(style.letterSpacing),
            'text-transform': style.textTransform,
            color: named(style.color),
            behind: back.name,
            opacity: Math.round(back.opacity * 100) / 100,
            contrast: contrast(over(color, back.color), back.color),
          },
          (text || placeholder).slice(0, 40),
        );
      }
      const background = parse(style.backgroundColor);
      const bordered =
        Number.parseFloat(style.borderTopWidth) > 0 ||
        Number.parseFloat(style.borderBottomWidth) > 0;
      if ((background && background[3] > 0) || bordered) {
        const parent = element.parentElement ? behind(element.parentElement) : undefined;
        add(
          {
            kind: 'box',
            where: place,
            tag,
            role: element.getAttribute('role') ?? '',
            height: Math.round(box.height),
            padding: px(style.padding),
            gap: style.gap,
            radius: px(style.borderTopLeftRadius),
            border: bordered
              ? `${style.borderTopWidth} ${style.borderTopStyle} ${named(style.borderTopColor)} / bottom ${style.borderBottomWidth} ${named(style.borderBottomColor)}`
              : '',
            background: background && background[3] > 0 ? named(style.backgroundColor) : '',
            behind: parent?.name ?? '',
            'background-contrast':
              background && background[3] > 0 && parent
                ? contrast(over(background, parent.color), parent.color)
                : 0,
          },
          (element.getAttribute('aria-label') ?? element.textContent.trim()).slice(0, 30),
        );
      }
    }
    return [...found.values()];
  }, TOKENS);
  // `.styles.json`: `<name>.json` is the Price movers measurement.
  const file = join(OUT, viewport.name, `${name}.styles.json`);
  writeFileSync(file, `${JSON.stringify(entries, null, 1)}\n`);
}

/** axe-core on the page as it stands (an open dialog included). Runs in the page. */
async function runAxe(page: Page, viewport: Viewport, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  axeShots += 1;
  for (const violation of results.violations) {
    axeFindings.push({
      shot: `${viewport.name}/${name}`,
      id: violation.id,
      impact: violation.impact ?? null,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        target: node.target.join(' '),
        html: node.html.slice(0, 200),
        summary: (node.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 300),
      })),
    });
  }
  if (results.violations.length > 0) {
    log(`  axe: ${results.violations.map((violation) => violation.id).join(', ')}`);
  }
}

/** `fullPage` for pages; menus and dialogs are shot as the screen shows them. */
async function shoot(page: Page, viewport: Viewport, name: string, fullPage = true): Promise<void> {
  const file = join(OUT, viewport.name, `${name}.png`);
  mkdirSync(dirname(file), { recursive: true });
  if (!fullPage) {
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
  } else {
    // Playwright's fullPage leaves fixed elements (the mobile tab bar, the
    // sidebar) where the first screen ends. A viewport as tall as the page
    // puts them at the bottom and full height instead.
    const height = () => page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({
      width: viewport.width,
      height: Math.max(viewport.height, await height()),
    });
    await page.waitForTimeout(400);
    await page.setViewportSize({
      width: viewport.width,
      height: Math.max(viewport.height, await height()),
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
  }
  written.push(file);
  log(`  ${viewport.name}/${name}.png`);
  if (MEASURE) await measurePage(page, viewport, name);
  if (AXE) await runAxe(page, viewport, name);
}

function wanted(viewport: Viewport, name: string): boolean {
  return ONLY.length === 0 || ONLY.some((text) => `${viewport.name}/${name}`.includes(text));
}

/** Opens `path`, waits, shoots. A page that shows the 404 page (hidden: no data) is noted and skipped. */
async function shootPath(
  page: Page,
  base: string,
  viewport: Viewport,
  path: string,
  name: string,
): Promise<boolean> {
  if (!wanted(viewport, name)) return false;
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  if (await page.getByRole('heading', { name: /not found/i }).count()) {
    skipped.push(`${viewport.name}/${name}: ${path} shows "not found" (no data for it)`);
    log(`  skipped ${name}: not found`);
    return false;
  }
  await shoot(page, viewport, name);
  return true;
}

/** Runs `action` (open a menu or dialog) on `path`, then shoots. Escape closes it again. */
async function shootState(
  page: Page,
  base: string,
  viewport: Viewport,
  path: string,
  name: string,
  action: (page: Page) => Promise<boolean>,
): Promise<void> {
  if (!wanted(viewport, name)) return;
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  try {
    if (!(await action(page))) {
      skipped.push(`${viewport.name}/${name}: nothing to open on ${path}`);
      log(`  skipped ${name}`);
      return;
    }
    await page.waitForTimeout(400);
    await shoot(page, viewport, name, false);
  } catch (error) {
    skipped.push(`${viewport.name}/${name}: ${(error as Error).message.split('\n')[0] ?? ''}`);
    log(`  failed ${name}: ${(error as Error).message.split('\n')[0] ?? ''}`);
  }
  await page.keyboard.press('Escape');
}

async function clickFirstVisible(page: Page, selector: string): Promise<boolean> {
  const target = page.locator(`${selector} >> visible=true`).first();
  if ((await target.count()) === 0) return false;
  await target.click({ timeout: 5000 });
  return true;
}

/**
 * The README screenshots: Ember, seed data only, placeholder icons (the seed
 * database has no icons). PC pages show their first 1000 px; Home is whole when
 * it is at most 1400 px tall, and otherwise ends just below the activity
 * calendar. Home on mobile is the whole page at 2×.
 */
async function readmeShots(
  browser: Browser,
  base: string,
  session: Awaited<ReturnType<BrowserContext['storageState']>>,
  accountId: number,
): Promise<void> {
  mkdirSync(README_OUT, { recursive: true });
  const own = `/${String(accountId)}`;
  const shots: { file: string; path: string; viewport: Viewport; scale: number; home: boolean }[] =
    [
      { file: 'home.png', path: '/all', viewport: DESKTOP, scale: 1, home: true },
      {
        file: 'sessions.png',
        path: `${own}/activity/sessions`,
        viewport: DESKTOP,
        scale: 1,
        home: false,
      },
      { file: 'bank.png', path: `${own}/bank`, viewport: DESKTOP, scale: 1, home: false },
      {
        file: 'raids.png',
        path: `${own}/progress/raids`,
        viewport: DESKTOP,
        scale: 1,
        home: false,
      },
      {
        file: 'home-mobile.png',
        path: '/all',
        viewport: { name: '390', width: 390, height: 844, mobile: true },
        scale: 2,
        home: true,
      },
    ];
  for (const shot of shots) {
    const context = await newContext(browser, shot.viewport, 'ember', session, shot.scale);
    const page = await context.newPage();
    await page.goto(`${base}${shot.path}`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    let height = Math.min(pageHeight, 1000);
    if (shot.viewport.mobile) {
      height = pageHeight;
    } else if (shot.home && pageHeight > 1400) {
      // Just below the activity calendar's card.
      const calendar = await page.evaluate(() => {
        const card = document
          .querySelector('[role="img"][aria-label^="Activity calendar"]')
          ?.closest('section');
        return card ? card.getBoundingClientRect().bottom + window.scrollY : null;
      });
      height = calendar === null ? 1400 : Math.ceil(calendar) + 24;
    } else if (shot.home) {
      height = pageHeight;
    }
    await page.setViewportSize({ width: shot.viewport.width, height });
    await page.waitForTimeout(500);
    const file = join(README_OUT, shot.file);
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
    written.push(file);
    log(`  docs/screenshots/${shot.file} (${String(shot.viewport.width)} × ${String(height)})`);
    await context.close();
  }
}

/** ISO week of a date as the Weekly page's path takes it: `2026-W45`. */
function isoWeekKey(date: Date): string {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Thursday of this week decides the ISO year.
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${String(day.getUTCFullYear())}-W${String(week).padStart(2, '0')}`;
}

interface Account {
  id: number;
}
interface Session {
  id: string;
  accountId: number;
  endedAt: string | null;
  newCollectionLogCount: number;
}

async function main(): Promise<void> {
  // An empty CHROMIUM_PATH falls back too, as in scripts/csp-check.
  const executablePath =
    process.env.CHROMIUM_PATH?.trim() || // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing -- an empty string must fall back too
    (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  if (!existsSync(join(ROOT, 'server/dist/index.js'))) {
    throw new Error('No server/dist: run `pnpm build` first');
  }
  const dir = mkdtempSync(join(process.env.SNAPSHOT_TMP ?? tmpdir(), 'ui-snapshots-'));
  const seedDir = join(dir, 'seed');
  const emptyDir = join(dir, 'empty');
  mkdirSync(emptyDir);

  let seeded: ScratchServer | undefined;
  let empty: ScratchServer | undefined;
  let browser: Browser | undefined;
  try {
    // Same generator and defaults as `pnpm seed` (3 accounts, 6 months, until
    // now), so the last session is still open while the shots are taken.
    log(`seeding ${seedDir} (seed ${SEED})`);
    seedScratch(seedDir, ['--seed', SEED], SCRATCH);

    seeded = await startServer(seedDir);
    empty = await startServer(emptyDir);
    const { base } = seeded;

    // Local mode → login mode, so the login and invite pages exist.
    const setPassword = await fetch(`${base}/api/v1/auth/password`, {
      method: 'POST',
      headers: apiHeaders(base),
      body: JSON.stringify({ newPassword: PASSWORD }),
    });
    if (setPassword.status !== 204) throw new Error(`Set password: ${String(setPassword.status)}`);

    browser = await chromium.launch(executablePath ? { executablePath } : {});
    log(`browser ${executablePath ?? 'Playwright Chromium'} ${browser.version()}`);

    // Log in once and reuse the cookie in every context.
    const loginContext = await newContext(browser, DESKTOP, 'ember');
    const loginPage = await loginContext.newPage();
    await loginPage.goto(`${base}/`, { waitUntil: 'networkidle' });
    await loginPage.getByLabel('Username').fill('admin');
    await loginPage.getByLabel('Password').fill(PASSWORD);
    const [loginResponse] = await Promise.all([
      loginPage.waitForResponse((response) => response.url().endsWith('/api/v1/auth/login')),
      loginPage.getByRole('button', { name: 'Log in' }).click(),
    ]);
    if (loginResponse.status() !== 200) {
      throw new Error(`Login: ${String(loginResponse.status())} ${await loginResponse.text()}`);
    }
    await loginPage.waitForLoadState('networkidle');
    const session = await loginContext.storageState();
    const cookie = (await loginContext.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
    await loginContext.close();

    const { accounts } = await api<{ accounts: Account[] }>(base, cookie, '/accounts');
    const sorted = [...accounts].sort((a, b) => a.id - b.id);
    const { items: sessions } = await api<{ items: Session[] }>(
      base,
      cookie,
      '/accounts/all/sessions?limit=50',
    );
    const ongoing = sessions.find((s) => s.endedAt === null);
    const finished = sessions.find((s) => s.endedAt !== null);
    // The newest session with new collection log items, from a longer list.
    const { items: older } = await api<{ items: Session[] }>(
      base,
      cookie,
      '/accounts/all/sessions?limit=100',
    );
    const withClog = older.find((s) => s.newCollectionLogCount > 0);
    // "One account": the main account (the one still playing), which has
    // loot, raids and a stored collection log. Falls back to the first.
    const account = sorted.find((a) => a.id === ongoing?.accountId) ?? sorted[0];
    if (!account) throw new Error('Seed made no accounts');
    log(`single-account shots use account ${String(account.id)}`);

    // An account with a special-loot drop, for the drop dialogs.
    let raidAccount: number | undefined;
    for (const candidate of sorted) {
      const splits = await api<{ drops: { items: unknown[] } }>(
        base,
        cookie,
        `/accounts/${String(candidate.id)}/raids/splits?limit=1`,
      ).catch(() => undefined);
      if ((splits?.drops.items.length ?? 0) > 0) {
        raidAccount = candidate.id;
        break;
      }
    }

    const invite = await api<{ url: string }>(base, cookie, '/invites', {
      method: 'POST',
      body: JSON.stringify({ role: 'member', canCreateApiKeys: true }),
    });
    // The token is in the fragment: keep it.
    const inviteUrl = new URL(invite.url, base);
    const invitePath = inviteUrl.pathname + inviteUrl.search + inviteUrl.hash;

    // History: a revoked key and a revoked invite, so the link rows and the
    // screens behind them have something to show.
    const oldKey = await api<{ apiKey: { id: number } }>(base, cookie, '/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Old laptop' }),
    });
    const oldInvite = await api<{ invite: { id: string } }>(base, cookie, '/invites', {
      method: 'POST',
      body: JSON.stringify({ role: 'member', canCreateApiKeys: false }),
    });
    for (const path of [`/keys/${String(oldKey.apiKey.id)}`, `/invites/${oldInvite.invite.id}`]) {
      const revoked = await fetch(`${base}/api/v1${path}`, {
        method: 'DELETE',
        headers: apiHeaders(base, cookie),
      });
      if (revoked.status !== 204) throw new Error(`Revoke ${path}: ${String(revoked.status)}`);
    }

    // A member with two-factor on, for the login code step and the reset page
    // with the six-box code field.
    const memberInvite = await api<{ url: string }>(base, cookie, '/invites', {
      method: 'POST',
      body: JSON.stringify({ role: 'member', canCreateApiKeys: true }),
    });
    const memberToken = decodeURIComponent(new URL(memberInvite.url, base).hash.slice(1));
    const accepted = await fetch(`${base}/api/v1/auth/invite/accept`, {
      method: 'POST',
      headers: apiHeaders(base),
      body: JSON.stringify({ token: memberToken, username: 'kari', password: PASSWORD }),
    });
    if (accepted.status !== 201) throw new Error(`Accept invite: ${String(accepted.status)}`);
    const memberCookie = accepted.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .join('; ');
    const setup = await api<{ secret: string }>(base, memberCookie, '/auth/totp/setup', {
      method: 'POST',
      body: JSON.stringify({ password: PASSWORD }),
    });
    await api(base, memberCookie, '/auth/totp/enable', {
      method: 'POST',
      body: JSON.stringify({ code: totpNow(setup.secret) }),
    });
    const { users } = await api<{ users: { id: number; username: string }[] }>(
      base,
      cookie,
      '/users',
    );
    const kari = users.find((user) => user.username === 'kari');
    if (!kari) throw new Error('Member was not created');
    const reset = await api<{ url: string }>(
      base,
      cookie,
      `/users/${String(kari.id)}/password-reset`,
      { method: 'POST', body: '{}' },
    );
    const resetUrl = new URL(reset.url, base);
    const resetPath = resetUrl.pathname + resetUrl.search + resetUrl.hash;

    // The ISO week two weeks back, for Weekly on a finished week.
    const pastWeek = isoWeekKey(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000));

    if (README) {
      await readmeShots(browser, base, session, account.id);
      return;
    }

    for (const viewport of VIEWPORTS) {
      log(`--- ${viewport.name} px ---`);
      for (const theme of THEMES_OPTION ?? THEMES) {
        const context = await newContext(browser, viewport, theme, session);
        const page = await context.newPage();
        page.on('pageerror', (error) => {
          log(`  page error on ${page.url()}: ${error.message}`);
        });

        for (const [id, path] of ACCOUNT_PAGES) {
          if (limitedTheme(theme) && !LIGHT_PAGES.has(id)) continue;
          for (const scope of ['all', String(account.id)]) {
            const label = scope === 'all' ? 'all' : 'account';
            await shootPath(
              page,
              base,
              viewport,
              `/${scope}${path ? `/${path}` : ''}`,
              `${id}-${label}-${theme}`,
            );
          }
        }
        // The Bank's sub-tabs on mobile (`?section=`); on PC everything is on one page.
        if (viewport.mobile) {
          for (const section of ['carried', 'potions', 'value']) {
            await shootPath(
              page,
              base,
              viewport,
              `/${String(account.id)}/bank?section=${section}`,
              `bank-account-${section}-${theme}`,
            );
          }
        }
        // Other views of the same pages: periods, the list and table views, a past week.
        if (!limitedTheme(theme)) {
          const own = `/${String(account.id)}`;
          const variants: [string, string][] = [
            ['bank-account-list', `${own}/bank?view=list`],
            ['bank-account-ha', `${own}/bank?value=ha`],
            ['xp-account-day', `${own}/progress/xp?period=day`],
            ['xp-account-year', `${own}/progress/xp?period=year`],
            ['loot-account-all-time', `${own}/progress/loot?range=all`],
            ['screentime-account-90d', `${own}/activity/screentime?range=90d`],
            ['weekly-account-past', `${own}/activity/weekly/${pastWeek}`],
            ['overview-account-drops', `${own}?show=drops`],
            ['pets-account-az', `${own}/collections/pets?sort=az`],
          ];
          for (const [name, path] of variants) {
            await shootPath(page, base, viewport, path, `${name}-${theme}`);
          }
          await shootState(
            page,
            base,
            viewport,
            `${own}/activity/screentime`,
            `screentime-account-table-${theme}`,
            async (p) => {
              await p.getByRole('button', { name: 'Show as table' }).first().click();
              return true;
            },
          );
          // Loading and error: the feed never answers, then fails.
          const feed = `**/api/v1/accounts/${String(account.id)}/feed*`;
          const weekly = `**/api/v1/accounts/${String(account.id)}/weekly*`;
          if (wanted(viewport, `overview-account-error-${theme}`)) {
            await page.route(feed, (route) => route.fulfill({ status: 500, json: {} }));
            await page.route(weekly, (route) => route.fulfill({ status: 500, json: {} }));
            await shootPath(page, base, viewport, own, `overview-account-error-${theme}`);
            await page.unroute(feed);
            await page.unroute(weekly);
          }
        }
        // Price movers: sample numbers answered in the browser, see `samplePriceMovers`.
        {
          const restore = await samplePriceMovers(page, account.id);
          const bankPath = `/${String(account.id)}/bank`;
          if (viewport.mobile) {
            await shootPath(
              page,
              base,
              viewport,
              `${bankPath}?section=value`,
              `bank-account-value-movers-${theme}`,
            );
            await measurePriceMovers(page, viewport, `bank-account-value-movers-${theme}`);
          } else {
            await shootPath(page, base, viewport, bankPath, `bank-account-movers-${theme}`);
            await measurePriceMovers(page, viewport, `bank-account-movers-${theme}`);
            await shootPath(
              page,
              base,
              viewport,
              `${bankPath}?top=valuable`,
              `bank-account-movers-valuable-${theme}`,
            );
          }
          await restore();
        }
        if (limitedTheme(theme)) {
          await context.close();
          continue;
        }

        if (finished) {
          await shootPath(
            page,
            base,
            viewport,
            `/sessions/${finished.id}`,
            `session-finished-${theme}`,
          );
        } else skipped.push(`${viewport.name}/session-finished: the seed has no finished session`);
        // 14 new collection log items (sample answer, see `sampleManyClogItems`).
        if (withClog) {
          const restore = await sampleManyClogItems(page, withClog.id);
          await shootPath(
            page,
            base,
            viewport,
            `/sessions/${withClog.id}`,
            `session-clog-many-${theme}`,
          );
          await restore();
        }
        if (withClog) {
          // On PC this opens the list with the session selected (the pane).
          await shootPath(
            page,
            base,
            viewport,
            `/sessions/${withClog.id}`,
            `session-clog-${theme}`,
          );
        } else
          skipped.push(`${viewport.name}/session-clog: no session with new collection log items`);
        if (ongoing) {
          await shootPath(
            page,
            base,
            viewport,
            `/sessions/${ongoing.id}`,
            `session-ongoing-${theme}`,
          );
        } else skipped.push(`${viewport.name}/session-ongoing: no open session in the seed`);

        for (const [id, path] of SETTINGS_PAGES) {
          await shootPath(page, base, viewport, path, `${id}-${theme}`);
        }
        await shootPath(page, base, viewport, '/about', `about-${theme}`);

        // --- States -------------------------------------------------------
        const accountPath = `/${String(account.id)}`;
        await shootState(
          page,
          base,
          viewport,
          accountPath,
          `overview-account-switcher-open-${theme}`,
          (p) => clickFirstVisible(p, 'button[aria-label^="Choose account"]'),
        );
        if (raidAccount !== undefined) {
          const raidsPath = `/${String(raidAccount)}/progress/raids`;
          await shootState(
            page,
            base,
            viewport,
            raidsPath,
            `loot-raids-edit-drop-dialog-${theme}`,
            (p) => clickFirstVisible(p, 'button[aria-label^="Edit "]'),
          );
          await shootState(
            page,
            base,
            viewport,
            raidsPath,
            `loot-raids-add-drop-dialog-${theme}`,
            async (p) => {
              await p.getByRole('button', { name: 'Add drop' }).first().click();
              await p.getByRole('dialog').first().waitFor();
              return true;
            },
          );
        } else {
          skipped.push(`${viewport.name}/drop dialogs: no account with special loot`);
        }
        // ConfirmDialog: revoking the seed's API key (not confirmed).
        await shootState(
          page,
          base,
          viewport,
          '/settings/keys',
          `settings-keys-confirm-dialog-${theme}`,
          async (p) => {
            const revoke = p.getByRole('button', { name: /^Revoke/ }).first();
            if ((await revoke.count()) === 0) return false;
            await revoke.click();
            await p.getByRole('alertdialog').first().waitFor();
            return true;
          },
        );
        // The user ⋯ menu under Users.
        await shootState(
          page,
          base,
          viewport,
          '/settings/users',
          `settings-users-menu-open-${theme}`,
          (p) => clickFirstVisible(p, 'button[aria-label^="Actions for"]'),
        );
        // The Settings dropdown on mobile.
        if (viewport.mobile) {
          await shootState(page, base, viewport, '/settings', `settings-menu-open-${theme}`, (p) =>
            clickFirstVisible(p, 'button[aria-label^="Settings section"]'),
          );
        }
        // Two-factor setup with the QR code and the six boxes.
        await shootState(
          page,
          base,
          viewport,
          '/settings',
          `settings-2fa-setup-${theme}`,
          async (p) => {
            await p.getByRole('button', { name: 'Set up two-factor authentication' }).click();
            await p.getByLabel('Password', { exact: true }).fill(PASSWORD);
            await p.getByRole('button', { name: 'Continue' }).click();
            await p.getByRole('img', { name: 'QR code for your authenticator app' }).waitFor();
            return true;
          },
        );
        await context.close();

        // --- Logged out -------------------------------------------------
        const guest = await newContext(browser, viewport, theme);
        const guestPage = await guest.newPage();
        await shootPath(guestPage, base, viewport, '/', `login-${theme}`);
        await shootPath(guestPage, base, viewport, invitePath, `invite-${theme}`);
        await shootPath(guestPage, base, viewport, resetPath, `reset-password-${theme}`);
        // The login code step, never sent.
        await shootState(guestPage, base, viewport, '/', `login-2fa-${theme}`, async (p) => {
          await p.getByLabel('Username').fill('kari');
          await p.getByLabel('Password').fill(PASSWORD);
          await p.getByRole('button', { name: 'Log in' }).click();
          await p.getByRole('heading', { name: 'Two-factor authentication' }).waitFor();
          return true;
        });
        await guest.close();

        // --- Two-factor: the recovery codes and "Turn off", on a new member
        // each time.
        if (
          wanted(viewport, `settings-recovery-codes-${theme}`) ||
          wanted(viewport, `settings-2fa-turn-off-dialog-${theme}`)
        ) {
          members += 1;
          const username = `member${String(members)}`;
          const link = await api<{ url: string }>(base, cookie, '/invites', {
            method: 'POST',
            body: JSON.stringify({ role: 'member', canCreateApiKeys: true }),
          });
          const joined = await fetch(`${base}/api/v1/auth/invite/accept`, {
            method: 'POST',
            headers: apiHeaders(base),
            body: JSON.stringify({
              token: decodeURIComponent(new URL(link.url, base).hash.slice(1)),
              username,
              password: PASSWORD,
            }),
          });
          if (joined.status !== 201) throw new Error(`Accept invite: ${String(joined.status)}`);
          const member = await newContext(browser, viewport, theme);
          const memberPage = await member.newPage();
          try {
            // Logs in through the page: the member has no two-factor yet.
            await memberPage.goto(`${base}/settings`, { waitUntil: 'networkidle' });
            await memberPage.getByLabel('Username').fill(username);
            await memberPage.getByLabel('Password').fill(PASSWORD);
            await Promise.all([
              memberPage.waitForResponse((response) =>
                response.url().endsWith('/api/v1/auth/login'),
              ),
              memberPage.getByRole('button', { name: 'Log in' }).click(),
            ]);
            await settle(memberPage);
            await memberPage
              .getByRole('button', { name: 'Set up two-factor authentication' })
              .click();
            await memberPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
            await memberPage.getByRole('button', { name: 'Continue' }).click();
            await memberPage
              .getByRole('img', { name: 'QR code for your authenticator app' })
              .waitFor();
            const secret = ((await memberPage.locator('code').first().textContent()) ?? '').replace(
              /\s/g,
              '',
            );
            await memberPage.getByLabel('Digit 1 of 6').click();
            await memberPage.keyboard.type(totpNow(secret));
            await memberPage.getByRole('button', { name: 'Turn on' }).click();
            await memberPage.getByRole('region', { name: 'Recovery codes' }).waitFor();
            await memberPage.waitForTimeout(300);
            if (wanted(viewport, `settings-recovery-codes-${theme}`)) {
              await shoot(memberPage, viewport, `settings-recovery-codes-${theme}`);
            }
            await memberPage.getByRole('button', { name: 'I saved them' }).click();
            await memberPage.getByRole('button', { name: 'Turn off' }).click();
            await memberPage.getByRole('alertdialog').first().waitFor();
            await memberPage.waitForTimeout(400);
            if (wanted(viewport, `settings-2fa-turn-off-dialog-${theme}`)) {
              await shoot(memberPage, viewport, `settings-2fa-turn-off-dialog-${theme}`, false);
            }
          } catch (error) {
            const reason = (error as Error).message.split('\n')[0] ?? '';
            skipped.push(`${viewport.name}/two-factor states (${theme}): ${reason}`);
            log(`  failed two-factor states: ${reason}`);
          }
          await member.close();
        }

        // --- Empty database (local mode, no accounts) --------------------
        const fresh = await newContext(browser, viewport, theme);
        const freshPage = await fresh.newPage();
        await shootPath(freshPage, empty.base, viewport, '/all', `overview-empty-${theme}`);
        // Activity and Progress on a new instance: inviting empty states, not empty cards.
        for (const [id, path] of ACCOUNT_PAGES) {
          if (!path.startsWith('activity/') && !path.startsWith('progress/')) continue;
          await shootPath(freshPage, empty.base, viewport, `/all/${path}`, `${id}-empty-${theme}`);
        }
        await fresh.close();
      }
    }
  } finally {
    await browser?.close();
    await stopServer(seeded?.server);
    await stopServer(empty?.server);
    rmSync(dir, { recursive: true, force: true });
  }

  log(`${String(written.length)} screenshots in ${OUT}`);
  if (AXE) {
    // One report per set of widths, so runs side by side don't overwrite each other.
    const file = join(
      OUT,
      `axe-report-${VIEWPORTS.map((viewport) => viewport.name).join('-')}.json`,
    );
    writeFileSync(file, `${JSON.stringify(axeFindings, null, 1)}\n`);
    const rules = new Map<string, number>();
    for (const finding of axeFindings) rules.set(finding.id, (rules.get(finding.id) ?? 0) + 1);
    log(
      `axe: ${String(axeShots)} shots checked, ${String(axeFindings.length)} findings in ${file}`,
    );
    for (const [id, count] of rules) log(`  ${id}: ${String(count)} shots`);
  }
  if (skipped.length > 0) {
    log('not taken:');
    for (const line of skipped) log(`  ${line}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
