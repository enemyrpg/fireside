// Measures the layout shift (CLS) of Home while its cards load, on seed data,
// like a phone or a PC on a slow connection. Not part of CI: single runs vary
// too much, so it prints the median of several runs and is run by hand.
//
//   pnpm build && pnpm test:cls
//
// Needs `pnpm build` first (server/dist and web/dist). Seeds a database in a
// new temporary folder, starts the built server on a free port on 127.0.0.1,
// and stops only that process. Never touches DATA_DIR, ./data or port 3100.
// The server never reads .env and has every external source off; the check
// refuses to go on if it could call out (scripts/lib/scratch-server.ts).
//
// Every run is a new browser context (nothing cached) with Fast 4G (as Chrome
// DevTools: 165 ms, 8.1 Mbps down, 1.35 Mbps up) and a 4× slower CPU. CLS is
// the largest session window of layout shifts (1 s gap, 5 s at most), as
// web-vitals counts it. For the median run of each case it lists every shift
// with the elements that moved.
//
// Options (environment):
//   CLS_RUNS      runs per case, a whole number above 0 (default 5)
//   CLS_CASES     comma-separated case names (default all): pc-1, pc-all,
//                 mobile-1, mobile-all
//   CLS_THROTTLE  0: no network or CPU throttling (default 1)
//   CLS_UNTIL     the seed's end (default: now, to the hour, so runs in the
//                 same hour see the same data)
//   CLS_MAX       exit with 1 if a case's median is above this (default 0.1)
//   CLS_TMP       parent of the temporary folder (default: system temp)
//   CHROMIUM_PATH browser (default: Playwright's own Chromium)
//
// Writes .snapshots/cls/<case>.json (git-ignored) with every run's shifts.

import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions } from 'playwright';
import { seedScratch, startScratchServer, stopServer } from '../lib/scratch-server.ts';

const OUT = resolve(import.meta.dirname, '../../.snapshots/cls');
/** A number option; empty or unset gives the default, anything else must pass `valid`. */
function numberOption(name: string, fallback: number, valid: (value: number) => boolean): number {
  const text = process.env[name]?.trim() ?? '';
  if (text === '') return fallback;
  const value = Number(text);
  if (!valid(value)) {
    console.error(`[cls-check] ${name}=${text} is not valid`);
    process.exit(2);
  }
  return value;
}

const RUNS = numberOption('CLS_RUNS', 5, (value) => Number.isInteger(value) && value > 0);
const THROTTLE = process.env.CLS_THROTTLE !== '0';
const MAX = numberOption('CLS_MAX', 0.1, (value) => Number.isFinite(value) && value >= 0);

const PC: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const MOBILE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

const CASES = [
  { name: 'pc-1', path: '/1', context: PC },
  { name: 'pc-all', path: '/all', context: PC },
  { name: 'mobile-1', path: '/1', context: MOBILE },
  { name: 'mobile-all', path: '/all', context: MOBILE },
] as const;

/** Chrome DevTools' "Fast 4G" preset. */
const FAST_4G = {
  offline: false,
  latency: 165,
  downloadThroughput: (9_000_000 * 0.9) / 8,
  uploadThroughput: (1_500_000 * 0.9) / 8,
};

interface Source {
  node: string;
  /** previousRect → currentRect: x, y, width, height. */
  from: [number, number, number, number];
  to: [number, number, number, number];
}

interface Shift {
  startTime: number;
  value: number;
  sources: Source[];
}

interface Run {
  cls: number;
  shifts: Shift[];
}

function log(message: string): void {
  console.log(`[cls-check] ${message}`);
}

/** The largest session window: shifts less than 1 s apart, 5 s at most (web-vitals). */
function clsOf(shifts: readonly Pick<Shift, 'startTime' | 'value'>[]): number {
  let largest = 0;
  let current = 0;
  let first = 0;
  let previous = 0;
  for (const shift of shifts) {
    if (current > 0 && shift.startTime - previous < 1000 && shift.startTime - first < 5000) {
      current += shift.value;
    } else {
      current = shift.value;
      first = shift.startTime;
    }
    previous = shift.startTime;
    largest = Math.max(largest, current);
  }
  return largest;
}

/** Records layout shifts in `window.clsShifts`, before any page script. */
function observeShifts(): void {
  const shifts: unknown[] = [];
  (window as unknown as { clsShifts: unknown[] }).clsShifts = shifts;
  /** A short name for a moved element: tag, label and where it is. */
  const describe = (node: Node | null): string => {
    if (!(node instanceof Element)) return node === null ? '(gone)' : node.nodeName;
    const own = [
      node.tagName.toLowerCase(),
      node.id ? `#${node.id}` : '',
      ...['aria-label', 'data-testid'].map((name) => {
        const value = node.getAttribute(name);
        return value === null ? '' : `[${name}="${value}"]`;
      }),
    ].join('');
    const classes = [...node.classList].slice(0, 3).join('.');
    // The nearest labelled section or heading tells which card it is in.
    let where = '';
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const label =
        parent.getAttribute('aria-label') ??
        parent.querySelector(':scope > h2, :scope > div > h2')?.textContent ??
        (parent.tagName === 'FOOTER' ? 'footer' : null);
      if (label) {
        where = ` in "${label.slice(0, 40)}"`;
        break;
      }
    }
    return `${own}${classes ? `.${classes}` : ''}${where}`;
  };
  const rect = (r: DOMRectReadOnly) => [r.x, r.y, r.width, r.height].map(Math.round);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & {
      value: number;
      hadRecentInput: boolean;
      sources?: {
        node: Node | null;
        previousRect: DOMRectReadOnly;
        currentRect: DOMRectReadOnly;
      }[];
    })[]) {
      if (entry.hadRecentInput) continue;
      shifts.push({
        startTime: Math.round(entry.startTime),
        value: entry.value,
        sources: (entry.sources ?? []).map((source) => ({
          node: describe(source.node),
          from: rect(source.previousRect),
          to: rect(source.currentRect),
        })),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
}

async function measure(
  browser: Browser,
  base: string,
  path: string,
  options: BrowserContextOptions,
): Promise<Run> {
  const context = await browser.newContext(options);
  try {
    await context.addInitScript(observeShifts);
    const page = await context.newPage();
    if (THROTTLE) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', FAST_4G);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle', timeout: 60_000 });
    // Late renders (the sparkline's chunk, the calendar) after the last request.
    await page.waitForTimeout(2000);
    const shifts = (await page.evaluate(
      () => (window as unknown as { clsShifts: unknown[] }).clsShifts,
    )) as Shift[];
    return { cls: clsOf(shifts), shifts };
  } finally {
    await context.close();
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function printShifts(run: Run): void {
  for (const shift of run.shifts) {
    console.log(`    ${String(shift.startTime).padStart(6)} ms  ${shift.value.toFixed(4)}`);
    for (const source of shift.sources) {
      const dy = source.to[1] - source.from[1];
      const dh = source.to[3] - source.from[3];
      console.log(
        `        ${source.node}  y ${String(source.from[1])}→${String(source.to[1])} (${dy >= 0 ? '+' : ''}${String(dy)})` +
          (dh === 0 ? '' : `, h ${dh >= 0 ? '+' : ''}${String(dh)}`),
      );
    }
  }
}

async function main(): Promise<void> {
  const only = (process.env.CLS_CASES ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  const cases = CASES.filter((entry) => only.length === 0 || only.includes(entry.name));
  const until = process.env.CLS_UNTIL ?? `${new Date().toISOString().slice(0, 13)}:00:00Z`;

  const dir = mkdtempSync(join(process.env.CLS_TMP ?? tmpdir(), 'cls-check-'));
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  const results: { name: string; median: number; runs: number[] }[] = [];
  try {
    log(`seeding ${dir} until ${until}`);
    // Never reads .env, every external source off (lib/scratch-server.ts).
    const dataDir = join(dir, 'db');
    seedScratch(dataDir, ['--accounts', '3', '--until', until]);
    const started = await startScratchServer(dataDir);
    server = started.server;
    const { base } = started;
    log(`server pid ${String(server.pid)} on ${base}`);

    // An empty CHROMIUM_PATH means Playwright's Chromium, as in csp-check.
    const executablePath = process.env.CHROMIUM_PATH?.trim() || undefined; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing -- an empty string must fall back too
    browser = await chromium.launch(executablePath ? { executablePath } : {});
    log(
      `browser ${browser.version()}, ${THROTTLE ? 'Fast 4G + 4× CPU' : 'no throttling'}, ${String(RUNS)} runs`,
    );

    mkdirSync(OUT, { recursive: true });
    for (const entry of cases) {
      const runs: Run[] = [];
      for (let i = 0; i < RUNS; i += 1)
        runs.push(await measure(browser, base, entry.path, entry.context));
      const values = runs.map((run) => run.cls);
      const mid = median(values);
      results.push({ name: entry.name, median: mid, runs: values });
      writeFileSync(join(OUT, `${entry.name}.json`), `${JSON.stringify(runs, null, 2)}\n`);
      log(
        `${entry.name} (${entry.path}): median ${mid.toFixed(3)}  runs ${values.map((v) => v.toFixed(3)).join(' ')}`,
      );
      // The run closest to the median, shift by shift.
      const closest = runs.reduce((best, run) =>
        Math.abs(run.cls - mid) < Math.abs(best.cls - mid) ? run : best,
      );
      printShifts(closest);
    }
  } finally {
    await browser?.close();
    await stopServer(server);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n| Case | Median CLS | Runs |\n| --- | --- | --- |');
  for (const result of results) {
    console.log(
      `| ${result.name} | ${result.median.toFixed(3)} | ${result.runs.map((v) => v.toFixed(3)).join(', ')} |`,
    );
  }
  if (results.some((result) => result.median > MAX)) {
    console.error(`[cls-check] a median is above ${String(MAX)}`);
    process.exitCode = 1;
  }
}

await main();
