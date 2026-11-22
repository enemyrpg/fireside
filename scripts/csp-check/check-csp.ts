// Runs the production build of the dashboard in Chromium with the server's
// Content-Security-Policy and fails on any CSP violation or uncaught error.
//
//   pnpm build && pnpm test:csp
//
// Needs `pnpm build` first (server/dist and web/dist). Seeds a database in a
// new temporary folder, starts the built server on a free port on 127.0.0.1,
// and stops only that process. Never touches DATA_DIR, ./data or port 3100.
// The server never reads .env and has every external source off; the check
// refuses to go on if it could call out (scripts/lib/scratch-server.ts).
//
// The database goes in a new folder under CSP_CHECK_TMP (default: the system
// temp folder). Chromium: CHROMIUM_PATH if set (e.g. /usr/bin/chromium, or Google
// Chrome in CI), otherwise the one from
// `pnpm --filter @fireside/scripts exec playwright install chromium`.

import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { seedScratch, startScratchServer, stopServer } from '../lib/scratch-server.ts';
import { totpNow } from '../lib/totp.ts';

const PASSWORD = 'csp check password 1';

/** Every account page (web/src/pages/registry.ts), below `/<account>`. */
const ACCOUNT_PAGES = [
  '',
  'activity/sessions',
  'activity/screentime',
  'activity/weekly',
  'progress/xp',
  'progress/loot',
  'progress/raids',
  'collections/log',
  'collections/pets',
  'collections/quests',
  'bank',
];
const SETTINGS_PAGES = [
  '/settings',
  '/settings/keys',
  '/settings/accounts',
  '/settings/users',
  '/settings/server',
  // History screens behind the link rows.
  '/settings/keys/revoked',
  '/settings/users/invites',
  '/settings/users/keys/revoked',
];

/** Overlay kinds that must have opened at least once, with no violation. */
const REQUIRED_OVERLAYS = ['dialog', 'select', 'popover', 'dropdown', 'toast'] as const;
type Overlay = (typeof REQUIRED_OVERLAYS)[number];

const problems: string[] = [];
const seen = new Set<Overlay>();

function log(message: string): void {
  console.log(`[csp-check] ${message}`);
}

/** Records CSP violations, CSP console messages and uncaught errors of a page. */
function watch(page: Page, label: () => string): void {
  page.on('console', (message) => {
    if (/content.security.policy/i.test(message.text())) {
      problems.push(`${label()}: console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    problems.push(`${label()}: uncaught error: ${error.message}`);
  });
}

async function newContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await recordViolations(context);
  return context;
}

/** Collects CSP violations in `window.cspViolations`, before any page script, on every navigation. */
async function recordViolations(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const list: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = list;
    document.addEventListener('securitypolicyviolation', (event) => {
      list.push(
        `${event.effectiveDirective} blocked ${event.blockedURI || '(inline)'} at ` +
          `${event.sourceFile}:${String(event.lineNumber)} sample=${event.sample}`,
      );
    });
  });
}

async function collectViolations(page: Page, label: string): Promise<void> {
  const violations = await page.evaluate(
    () => (window as unknown as { cspViolations?: string[] }).cspViolations ?? [],
  );
  for (const violation of violations) problems.push(`${label}: ${violation}`);
}

/** Which overlay is open now, if any. */
async function openOverlays(page: Page): Promise<Overlay[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const visible = (selector: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].some(
        (element) => element.offsetParent !== null || element.getClientRects().length > 0,
      );
    if (visible('[role="menu"]')) found.push('dropdown');
    if (visible('[role="listbox"]')) found.push('select');
    if (visible('[data-radix-popper-content-wrapper] [role="dialog"]')) found.push('popover');
    if (
      [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].some(
        (element) => element.closest('[data-radix-popper-content-wrapper]') === null,
      )
    ) {
      found.push('dialog');
    }
    if (visible('[data-sonner-toast]')) found.push('toast');
    return found;
  }) as Promise<Overlay[]>;
}

/** Opens every menu, select, popover and dialog trigger on the page, then closes it. */
async function openTriggers(page: Page, label: string): Promise<void> {
  const triggers = page.locator('[aria-haspopup]:visible, [role="combobox"]:visible');
  const count = Math.min(await triggers.count(), 12);
  for (let i = 0; i < count; i += 1) {
    const trigger = triggers.nth(i);
    try {
      // The list can change while overlays open and close.
      if (!(await trigger.isEnabled({ timeout: 1000 }))) continue;
      await trigger.click({ timeout: 2000 });
      await page.waitForTimeout(250);
      for (const overlay of await openOverlays(page)) seen.add(overlay);
    } catch (error) {
      log(
        `${label}: could not open trigger ${String(i)}: ${(error as Error).message.split('\n')[0] ?? ''}`,
      );
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
  }
}

async function visit(page: Page, base: string, path: string, interact = true): Promise<void> {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  if (interact) await openTriggers(page, path);
  for (const overlay of await openOverlays(page)) seen.add(overlay);
  await collectViolations(page, path);
}

/** Origin header for API calls made from Node. */
function apiHeaders(base: string, cookie?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    origin: base,
    ...(cookie === undefined ? {} : { cookie }),
  };
}

/** What the built manifest must say (web/src/branding/manifest.ts). */
const MANIFEST_FIELDS = { id: '/', start_url: '/', scope: '/', display: 'standalone' };
const MANIFEST_ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', purpose: 'any' },
  { src: '/icons/icon-maskable-512.png', sizes: '512x512', purpose: 'maskable' },
];
const APPLE_TOUCH_ICON = { src: '/apple-touch-icon.png', size: 180 };
const THEME_COLORS = { ember: '#14110f', dark: '#181927', light: '#d8ccb4' };

/**
 * On the login page without a session: the manifest and icons load without CSP
 * violations, and Chromium finds the app installable (what DevTools →
 * Application → Manifest shows). The theme-color tag follows the stored theme.
 * Runs in a persistent profile in `dir`: Chromium never offers to install from
 * an incognito-like context, which `browser.newContext()` is.
 */
async function checkInstallable(
  base: string,
  dir: string,
  executablePath: string | undefined,
): Promise<void> {
  const context = await chromium.launchPersistentContext(
    join(dir, 'chromium-profile'),
    executablePath ? { executablePath } : {},
  );
  try {
    await recordViolations(context);
    const page = await context.newPage();
    watch(page, () => 'install check');
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await checkInstallablePage(context, page);
  } finally {
    await context.close();
  }
}

async function checkInstallablePage(context: BrowserContext, page: Page): Promise<void> {
  const html = await page.content();
  for (const tag of ['rel="manifest"', 'rel="apple-touch-icon"', 'apple-mobile-web-app-title']) {
    if (!html.includes(tag)) problems.push(`index.html: no ${tag}`);
  }

  const manifest = await page.evaluate(async () => {
    const response = await fetch('/manifest.webmanifest', { credentials: 'omit' });
    return {
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      body: (await response.json()) as Record<string, unknown>,
    };
  });
  if (manifest.status !== 200) problems.push(`manifest: status ${String(manifest.status)}`);
  if (!manifest.type.startsWith('application/manifest+json')) {
    problems.push(`manifest: content-type ${manifest.type}`);
  }
  for (const [key, value] of Object.entries(MANIFEST_FIELDS)) {
    if (manifest.body[key] !== value) problems.push(`manifest: ${key} is not ${value}`);
  }
  if (typeof manifest.body.name !== 'string' || manifest.body.name === '') {
    problems.push('manifest: no name');
  }
  const icons = (manifest.body.icons ?? []) as { src: string; sizes: string; purpose: string }[];
  for (const expected of MANIFEST_ICONS) {
    if (
      !icons.some((icon) =>
        Object.entries(expected).every(([k, v]) => icon[k as keyof typeof icon] === v),
      )
    ) {
      problems.push(`manifest: no icon ${JSON.stringify(expected)}`);
    }
  }

  // Each icon loads as an image of the right size (img-src 'self').
  const sizes = [
    ...MANIFEST_ICONS.map((icon) => ({ src: icon.src, size: Number(icon.sizes.split('x')[0]) })),
    APPLE_TOUCH_ICON,
  ];
  const loaded = await page.evaluate(
    (list) =>
      Promise.all(
        list.map(
          ({ src }) =>
            new Promise<number>((done) => {
              const image = new Image();
              image.onload = () => {
                done(image.naturalWidth);
              };
              image.onerror = () => {
                done(0);
              };
              image.src = src;
            }),
        ),
      ),
    sizes,
  );
  sizes.forEach(({ src, size }, i) => {
    if (loaded[i] !== size)
      problems.push(`${src}: loaded at ${String(loaded[i])} px, not ${String(size)}`);
  });

  const cdp = await context.newCDPSession(page);
  const appManifest = await cdp.send('Page.getAppManifest');
  if (!appManifest.url.endsWith('/manifest.webmanifest')) {
    problems.push(`Chromium found no manifest (${appManifest.url})`);
  }
  for (const error of appManifest.errors) problems.push(`manifest: ${error.message}`);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  for (const error of installabilityErrors) {
    problems.push(`not installable: ${error.errorId} ${JSON.stringify(error.errorArguments)}`);
  }
  await cdp.detach();

  const themeColor = () =>
    page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    );
  if ((await themeColor()) !== THEME_COLORS.ember)
    problems.push('theme-color: not the Ember (default) page colour');
  // Each load gets a new violation list (recordViolations), so collect the
  // one that loaded the manifest and icons before reloading.
  await collectViolations(page, 'manifest and icons');
  await page.evaluate(() => {
    localStorage.setItem('theme', 'light');
  });
  await page.reload({ waitUntil: 'networkidle' });
  if ((await themeColor()) !== THEME_COLORS.light)
    problems.push('theme-color: does not follow the light theme');
  await collectViolations(page, 'install check, light theme');
  await page.evaluate(() => {
    localStorage.setItem('theme', 'dark');
  });
  await page.reload({ waitUntil: 'networkidle' });
  if ((await themeColor()) !== THEME_COLORS.dark)
    problems.push('theme-color: does not follow the dark theme');
  await collectViolations(page, 'install check, dark theme');
  await page.evaluate(() => {
    localStorage.removeItem('theme');
  });
  await page.reload({ waitUntil: 'networkidle' });
  if ((await themeColor()) !== THEME_COLORS.ember)
    problems.push('theme-color: not back to the Ember (default) page colour');
  await collectViolations(page, 'install check, default theme');
  log(`installable: ${String(installabilityErrors.length)} installability errors`);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(process.env.CSP_CHECK_TMP ?? tmpdir(), 'csp-check-'));
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    log(`seeding ${dir}`);
    // Never reads .env, every external source off (lib/scratch-server.ts).
    const dataDir = join(dir, 'db');
    seedScratch(dataDir, ['--accounts', '2', '--months', '1'], { timeZone: 'UTC' });
    const started = await startScratchServer(dataDir, { timeZone: 'UTC' });
    server = started.server;
    const { base } = started;
    log(`server pid ${String(server.pid)} on ${base}`);

    // index.html: the CSP is sent, and the file has no inline script or style.
    const index = await fetch(`${base}/`);
    const html = await index.text();
    const csp = index.headers.get('content-security-policy') ?? '';
    if (!csp.includes("script-src 'self'")) problems.push(`index.html: CSP missing (${csp})`);
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) problems.push('index.html: inline <script>');
    if (/\sstyle=/i.test(html)) problems.push('index.html: style attribute');
    // The theme script blocks the first paint, so it must never need a check.
    const theme = /<script src="(\/assets\/theme-init-[0-9a-f]+\.js)"/.exec(html)?.[1];
    if (theme === undefined) {
      problems.push('index.html: no hashed theme script in <head>');
    } else {
      const cache = (await fetch(`${base}${theme}`)).headers.get('cache-control') ?? '';
      if (!cache.includes('immutable')) problems.push(`${theme}: not cached for good (${cache})`);
    }

    // Local mode → login mode: the first password logs the browser in.
    const setPassword = await fetch(`${base}/api/v1/auth/password`, {
      method: 'POST',
      headers: apiHeaders(base),
      body: JSON.stringify({ newPassword: PASSWORD }),
    });
    if (setPassword.status !== 204) throw new Error(`Set password: ${String(setPassword.status)}`);

    // An empty CHROMIUM_PATH (CI without a preinstalled Chrome) means Playwright's Chromium.
    const executablePath = process.env.CHROMIUM_PATH?.trim() || undefined; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing -- an empty string must fall back too
    browser = await chromium.launch(executablePath ? { executablePath } : {});
    log(`browser ${executablePath ?? 'Playwright Chromium'} ${browser.version()}`);

    await checkInstallable(base, dir, executablePath);

    // --- Admin -------------------------------------------------------------
    const admin = await newContext(browser);
    const page = await admin.newPage();
    let current = '/';
    watch(page, () => current);

    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill(PASSWORD);
    const [loginResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/login')),
      page.getByRole('button', { name: 'Log in' }).click(),
    ]);
    if (loginResponse.status() !== 200) {
      throw new Error(`Login: ${String(loginResponse.status())} ${await loginResponse.text()}`);
    }
    await page.waitForLoadState('networkidle');
    await collectViolations(page, 'login');
    const cookie = (await admin.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');

    const accountsResponse = await fetch(`${base}/api/v1/accounts`, {
      headers: apiHeaders(base, cookie),
    });
    if (!accountsResponse.ok) {
      throw new Error(
        `Login failed or accounts unavailable: ${String(accountsResponse.status)} ` +
          `(cookies: ${(await admin.cookies()).map((c) => c.name).join(', ') || 'none'}). ` +
          `Page: ${(await page.locator('body').innerText()).slice(0, 300)}. Problems: ${problems.join(' | ')}`,
      );
    }
    const accounts = (await accountsResponse.json()) as { accounts: { id: number }[] };
    const accountId = accounts.accounts[0]?.id;
    if (accountId === undefined) throw new Error('Seed made no accounts');
    const sessions = (await (
      await fetch(`${base}/api/v1/accounts/all/sessions`, { headers: apiHeaders(base, cookie) })
    ).json()) as { items: { id: string }[] };

    const paths = [
      ...ACCOUNT_PAGES.map((path) => `/all${path ? `/${path}` : ''}`),
      ...ACCOUNT_PAGES.map((path) => `/${String(accountId)}${path ? `/${path}` : ''}`),
      ...(sessions.items[0] ? [`/sessions/${sessions.items[0].id}`] : []),
      ...SETTINGS_PAGES,
      // The instance text, logged in.
      '/about',
    ];
    for (const path of paths) {
      current = path;
      log(`admin ${path}`);
      await visit(page, base, path);
    }

    // A dialog with a select and a popover: "Add drop" on the raids page
    // (AddDropDialog.tsx with DateTimeField.tsx). Not every account has raids.
    for (const account of accounts.accounts) {
      current = `/${String(account.id)}/progress/raids (Add drop)`;
      await page.goto(`${base}/${String(account.id)}/progress/raids`, { waitUntil: 'networkidle' });
      const add = page.getByRole('button', { name: 'Add drop' }).first();
      if ((await add.count()) === 0) continue;
      log(current);
      await add.click();
      const dialog = page.getByRole('dialog').first();
      await dialog.waitFor();
      for (const overlay of await openOverlays(page)) seen.add(overlay);
      // One Escape closes the inner overlay, not the dialog.
      for (const selector of ['[aria-haspopup="dialog"]', '[role="combobox"]']) {
        const trigger = dialog.locator(selector).first();
        if ((await trigger.count()) === 0) continue;
        await trigger.click({ timeout: 5000 });
        await page.waitForTimeout(250);
        for (const overlay of await openOverlays(page)) seen.add(overlay);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
      }
      await collectViolations(page, current);
      break;
    }

    // A toast: an unknown account redirects with one (AccountRoute.tsx).
    current = '/999999';
    await page.goto(`${base}/999999`, { waitUntil: 'networkidle' });
    await page.locator('[data-sonner-toast]').first().waitFor({ timeout: 5000 });
    for (const overlay of await openOverlays(page)) seen.add(overlay);
    await collectViolations(page, current);

    // --- Invite page, and the dashboard as a member ------------------------
    const invite = (await (
      await fetch(`${base}/api/v1/invites`, {
        method: 'POST',
        headers: apiHeaders(base, cookie),
        body: JSON.stringify({ role: 'member', canCreateApiKeys: true }),
      })
    ).json()) as { url: string };
    const member = await newContext(browser);
    const memberPage = await member.newPage();
    watch(memberPage, () => current);
    current = '/invite';
    log('invite page');
    await memberPage.goto(invite.url, { waitUntil: 'networkidle' });
    await memberPage.getByLabel('Username').fill('kari');
    await memberPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await memberPage.getByLabel('Repeat password').fill(PASSWORD);
    await memberPage.getByRole('button', { name: 'Create account' }).click();
    // The page reloads the app once the account exists; going on before that
    // would race the login and leave the member logged out.
    await memberPage.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
    await collectViolations(memberPage, current);
    for (const path of ['/all', '/settings', '/settings/keys']) {
      current = `member ${path}`;
      log(current);
      await visit(memberPage, base, path);
    }

    // --- Two-factor: setup with the QR code, then the login step --
    current = 'member /settings (2FA setup)';
    log(current);
    await memberPage.goto(`${base}/settings`, { waitUntil: 'networkidle' });
    await memberPage.getByRole('button', { name: 'Set up two-factor authentication' }).click();
    await memberPage.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await memberPage.getByRole('button', { name: 'Continue' }).click();
    await memberPage.getByRole('img', { name: 'QR code for your authenticator app' }).waitFor();
    const secret = (await memberPage.locator('code').first().innerText()).replace(/\s/g, '');
    // The six-box code field: a whole code typed into the first box fills all
    // six, as a phone's code autofill does.
    await memberPage
      .getByRole('group', { name: 'Code from the app' })
      .getByRole('textbox', { name: 'Digit 1 of 6' })
      .fill(totpNow(secret));
    await memberPage.getByRole('button', { name: 'Turn on' }).click();
    const codesRegion = memberPage.getByRole('region', { name: 'Recovery codes' });
    await codesRegion.waitFor();
    const recovery = (await codesRegion.getByRole('listitem').first().innerText()).trim();
    await collectViolations(memberPage, current);
    await codesRegion.getByRole('button', { name: 'I saved them' }).click();

    current = '/ (2FA login step)';
    log(current);
    const secondBrowser = await newContext(browser);
    const codePage = await secondBrowser.newPage();
    watch(codePage, () => current);
    await codePage.goto(`${base}/`, { waitUntil: 'networkidle' });
    await codePage.getByLabel('Username').fill('kari');
    await codePage.getByLabel('Password').fill(PASSWORD);
    await codePage.getByRole('button', { name: 'Log in' }).click();
    await codePage.getByRole('heading', { name: 'Two-factor authentication' }).waitFor();
    await collectViolations(codePage, current);
    await codePage.getByRole('button', { name: 'Use a recovery code' }).click();
    await codePage.getByLabel('Recovery code').fill(recovery);
    await codePage.getByRole('button', { name: 'Log in' }).click();
    await codePage.getByRole('heading', { level: 1, name: 'Home' }).waitFor();
    await collectViolations(codePage, current);

    // --- Reset password page with a 2FA code field (not submitted) ---------
    const users = (await (
      await fetch(`${base}/api/v1/users`, { headers: apiHeaders(base, cookie) })
    ).json()) as { users: { id: number; username: string }[] };
    const kari = users.users.find((user) => user.username === 'kari');
    if (!kari) throw new Error('Member was not created');
    const reset = (await (
      await fetch(`${base}/api/v1/users/${String(kari.id)}/password-reset`, {
        method: 'POST',
        headers: apiHeaders(base, cookie),
        body: '{}',
      })
    ).json()) as { url: string };
    const stranger = await newContext(browser);
    const resetPage = await stranger.newPage();
    current = '/reset-password';
    watch(resetPage, () => current);
    log('reset password page');
    await resetPage.goto(reset.url, { waitUntil: 'networkidle' });
    await resetPage.getByLabel('Password', { exact: true }).waitFor();
    await resetPage.getByRole('group', { name: 'Two-factor code' }).waitFor();
    await collectViolations(resetPage, current);

    // The instance text without a session. The login page with its link to
    // `/about` was checked at the start.
    current = '/about (logged out)';
    log('about page, logged out');
    await resetPage.context().clearCookies();
    await resetPage.goto(`${base}/about`, { waitUntil: 'networkidle' });
    await resetPage.getByRole('heading', { name: 'About this instance' }).waitFor();
    await resetPage.getByText('instance is run by').first().waitFor();
    await collectViolations(resetPage, current);

    for (const overlay of REQUIRED_OVERLAYS) {
      if (!seen.has(overlay))
        problems.push(`never opened a ${overlay}: the check did not cover it`);
    }
  } finally {
    await browser?.close();
    await stopServer(server);
    rmSync(dir, { recursive: true, force: true });
  }

  log(`opened: ${[...seen].sort().join(', ')}`);
  if (problems.length > 0) {
    console.error(`[csp-check] ${String(problems.length)} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  log('no CSP violations');
}

await main();
