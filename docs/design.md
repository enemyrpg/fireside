# Dashboard design

The rules for the dashboard's layout, colors, type and components. Every page
follows them. If something new is needed, update this document in the same
pull request instead of inventing a style for one page.

The values themselves live in the code, and this document says what they are
for: tokens in [`web/src/theme/themes.css`](../web/src/theme/themes.css) and
[`tokens.css`](../web/src/theme/tokens.css), pages and navigation in
[`web/src/pages/registry.ts`](../web/src/pages/registry.ts), formats in
[`web/src/format.ts`](../web/src/format.ts).

## Contents

- [Principles](#principles)
- [Page map](#page-map)
- [Navigation](#navigation)
- [Pages](#pages)
- [Settings](#settings)
- [Login, invite and about pages](#login-invite-and-about-pages)
- [Themes](#themes)
- [Chart colors](#chart-colors)
- [Typography](#typography)
- [Layout and density](#layout-and-density)
- [Placeholders and icons](#placeholders-and-icons)
- [Logo and app icons](#logo-and-app-icons)
- [Libraries](#libraries)
- [Shared patterns](#shared-patterns)
- [Components](#components)
- [Data and fetching](#data-and-fetching)
- [Online](#online)
- [Empty states](#empty-states)
- [Loading](#loading)
- [Errors](#errors)
- [Number and time formats](#number-and-time-formats)
- [Time zone](#time-zone)
- [Legal](#legal)
- [Accessibility](#accessibility)

## Principles

1. **Calm first.** A page opens on a few big numbers. Explanations,
   comparisons and details sit behind a tooltip, a click or their own page.
   Rather one card too few than one too many.
2. **OSRS in the colors, not in the graphics.** The default theme, Ember, is a
   warm charcoal background with one ember-orange accent and big numbers in
   Space Grotesk. Dark (indigo) and Light (parchment) are the same structure
   in other colors. No Jagex logos, game fonts, stone textures or anything
   that looks like the game's own websites.
3. **A PC next to the game first, phones fully.** On a PC the dashboard is
   often half a screen wide (900–1400 px). On a phone (the installed app
   through the tunnel) it has a tab bar at the bottom, sheets from the bottom
   and touch targets of at least 44 px.
4. **One style.** Every page uses the components and tokens below.

## Page map

`:acc` is an account ID or `all`. The account is in the URL, so links and the
back button work. The last chosen account is remembered in `localStorage`;
`/` goes there, otherwise to `/all`.

Five destinations, each with sub-tabs where it has several pages. Settings is
behind the profile icon.

| Destination | Pages                                           | Routes                                                                                                           |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Home        | –                                               | `/:acc`                                                                                                          |
| Activity    | Sessions, Screen time, Weekly                   | `/:acc/activity/sessions`, `/:acc/activity/screentime`, `/:acc/activity/weekly/:week?`                           |
| Progress    | XP, Loot & KC, Raids                            | `/:acc/progress/xp`, `/:acc/progress/loot`, `/:acc/progress/raids`                                               |
| Collections | Collection log, Pets, Quests & diaries          | `/:acc/collections/log`, `/:acc/collections/pets`, `/:acc/collections/quests`                                    |
| Bank        | (on a phone: Bank, Carried, Potions, Value)     | `/:acc/bank`                                                                                                     |
| Settings    | Profile, API keys, OSRS accounts, Users, Server | `/settings`, `/settings/keys`, `/settings/accounts`, `/settings/users`, `/settings/server`, plus history screens |

- **Session detail** is its own screen at `/sessions/:id` on a phone and for
  direct links. On a PC, Sessions shows the list on the left and the chosen
  session on the right, with the session in `?session=<id>`.
- A destination's own path (`/:acc/collections`) goes to its first page that
  exists.
- **Old links keep working.** Each page lists its earlier paths in `oldPaths`
  in `registry.ts`, and `LegacyRedirect` (`web/src/routing/`) forwards them
  with the same parameters, query and hash, replacing the history entry.
- All internal links are built from the registry (`pageHref`, `hrefOf`) or
  the path helpers in `web/src/lib/`, never written by hand.
- **A page shows only when it has data**, and so does its menu item. There is
  never a "coming soon". Bank needs a bank snapshot on some account; Quests &
  diaries a quest or diary snapshot; Collection log collection log data; Pets
  a pet or collection log data. A destination without pages isn't shown.
- **State that changes what a page shows is in the query string**: period,
  filter, sorting, search, tabs. A new tab or period adds a history entry;
  search, sorting and switches replace it.

## Navigation

The menu and sub-tabs come from one list, `web/src/pages/registry.ts`.

**PC (wider than 860 px):** a sticky top bar the full width of the window:
the logo and the product name (a link to Home), the five destinations, the
account switcher and the profile icon (a link to `/settings`). The chosen
destination is `--accent-wash` with `--accent-text`. No sidebar and no search
field.

**Phone (860 px and narrower):** a fixed tab bar at the bottom with the same
five destinations (icon over name, at least 52 px high, `--safe-bottom`
below). The page header scrolls with the page and has up to three rows: the
title with the account switcher and profile icon, the sub-tabs in the full
width, and the page's own controls. An empty row takes no space. The account
switcher opens as a sheet. Cards, grids and tables become one column, and
table columns marked less important are hidden.

- The account switcher and the profile icon are rendered once, in the top bar
  on a PC and in the page header on a phone (`useIsDesktop`), never twice and
  hidden with CSS.
- Sub-tabs sit next to the page title as a segmented control (the chosen tab
  filled in `--accent`). The page's own controls (period, sorting, week
  navigation) are on the right on a PC and on their own row on a phone.
- The account switcher is hidden on Settings, and when the account list is
  loaded and empty.
- The theme is chosen only under Settings → Profile.
- **Scrolling and focus:** a link to another path starts at the top and moves
  focus to the page title (`h1` with `tabIndex={-1}`, no visible ring). Back
  and forward restore the scroll position. A change only in the query never
  scrolls.

## Pages

What each page puts first. The page's own file in `web/src/pages/` and the
rules in `web/src/lib/` have the details, with tests.

### Home

The "This week" stat strip (play time with bars per day, XP with the number of
skills, loot, kills) and a line on who is online ([Online](#online)). Below it "Latest" on the
left: a feed of sessions, drops over 1M, new collection log items, level-ups
and pets, per local day, with a filter in `?show=`, six rows and then a link to
the page with the rest. An ongoing session is pinned on top with a Live badge.
World hops are merged into one row, and short empty sessions are left out. On
the right the net worth card and the top three skills this week. At the bottom
the activity calendar for the last 365 days. A new instance without accounts
shows a welcome in three numbered steps instead (create a key, install the
plugin, log in to the game).

### Sessions

Sessions grouped by local day with a day total, 20 per page with "Load more".
World hops less than 2 minutes apart are one row that opens the first part.
Consecutive short sessions fold into one dashed row. A badge shows new
collection log items. Polls while a session is live, like Home.

### Session detail

The stat strip (duration, XP, loot, kills, new collection log items), the
session timeline with AFK periods, drops and new collection log items, then XP
by skill, kill count, collection log and loot by the six-row rule. "Older" and
"Newer" for the same account. A hop chain shows "Part 2 of 3" with links. An
ongoing session is Live and polls.

### Screen time

`?range=7d|30d|90d`. The stat strip and stacked active/AFK bars (per day for
7 and 30 days, per week for 90), with "Show as table". "When you play" (a
7 × 24 heatmap with the busiest day and hour), world types, locations and
worlds.

### Weekly

`/:acc/activity/weekly/:week?` (an ISO week; without one, this week). Sections
in two columns: play time, XP, loot, kill counts, pets, bank, collection log
and quests. A section that is `null` is hidden; with all of them `null`, "No
play time this week." ← → between weeks, an archive of weeks, "In progress" for
this week.

### XP

`?period=day|week|month|year`. The stat strip and a gains table of skills with
XP in the period; the rest in a dense grid below. XP over time for Overall or a
chosen skill. Levels show only for one account.

### Loot & KC

One page: total value and value per source, valuable drops with a 100K+/1M+/10M+
filter (7 days, 30 days, all time), and boss KC (all time, best time, last
kill) in the full width below. Raids have their own tab.

### Raids

A stat strip with your share (from your drops and from teammates' drops) and a
Split/FFA default per account. One card per raid with completions: completions
per mode, the fastest time per team size (only sizes you've done), and loot
value. Raids without completions are listed on one dashed line. Special loot
(purples) as a table on a PC and a list on a phone: date, raid and mode, "You"
or "Teammate", party size and value. A drop can be edited (value, mode, party
size, nickname, note) and added by hand.

### Collection log

`?tab=&page=&find=`. Three columns on a PC: the pages, the chosen page and the
latest items. Missing items are the same icon at 38 % opacity. "Sync now" and
the sync status.

### Pets

A trophy case: unlocked pets with date, source and KC or XP, and
"Unconfirmed" for a pet guessed from a chat message. The only page that shows
without data, with help on syncing the collection log.

### Quests & diaries

Three numbers (quest points, quests completed, diary tiers), diaries with four
tier pips per region, recently completed, and quests in four collapsible groups
as in the game.

### Bank

`?value=ge|ha` applies to every number on the page. The stat strip (net worth,
cash, bank and potion storage, carried). Three columns on a PC: the bank 1:1
with the game (main tab first, the tabs, 8 slots per row, placeholders and
fillers), Carried and Potion storage, and value over time, most valuable,
price movers and value by tab. On a phone these are sub-tabs. Today's GE prices
only apply to what exists now; history keeps the prices from then.

Most valuable and Price movers follow the chosen tab, and their subtitle names
it ("Tab 3 · GE"). For a tab, Price movers count only that tab's items (no
placeholders) and recompute the sum and the order. With all tabs, Price movers
are called "Everything held", because they also cover inventory, equipment and
potion storage; Most valuable stays "All tabs".

### All accounts

Pages that belong to one account (Bank, Quests & diaries, Collection log) show
what can be summed for `all`, then one link card per account (`AccountCards`).

## Settings

A menu on the left on a PC, a dropdown on a phone. Users and Server are for
admins only; for a member they don't exist (a full-page 404).

- **Profile:** "You" (local mode: "No login: the dashboard only answers on this
  PC."; login mode: log out, log out everywhere), theme, password (in local
  mode, setting one turns login on), two-factor (login mode only), time zone
  (shown, set by the server), and "Delete my account" (login mode only).
- **API keys:** active keys with prefix, name, created and last used; create
  (the full key is shown once with Copy); revoke with a confirmation. Revoked
  keys are on their own screen behind a history link row. Without
  `canCreateApiKeys`, the create form is replaced by a line to ask the admin.
- **OSRS accounts:** one card per account with its color, type and total
  level, first seen, name history, and the collection log source switch.
- **Users** (admin): users with role, status, two-factor and key count, and a
  ⋯ menu; invites with a create form; every user's API keys. Used, expired and
  revoked items are on history screens.
- **Server** (admin): versions and icon counts, instance text, defaults for new
  invites, backups, external sources, and Rebuild with a confirmation.
- A secret (API key, invite or reset link, recovery codes) is shown once, in
  a box with an `--accent` border and a Copy button, and disappears when you
  leave the tab.

## Login, invite and about pages

One card in the middle of the page, outside the app shell, with the footer.

- **Login:** says it is a Fireside account, not a Jagex account, and never to
  type a Jagex password. With two-factor, a second step with six code boxes
  that submits when the sixth digit is typed, and a link to use a recovery
  code instead. On http://localhost in Safari, a note that Safari drops secure
  cookies there.
- **Invite and reset links** (`/invite#<token>`, `/reset-password#<token>`):
  the page reads the token from the fragment once and removes it from the
  address bar. Pick a username and password, or a new password (and a code
  when two-factor is on).
- **About** (`/about`): the instance text as plain paragraphs, readable without
  logging in.

## Themes

Each theme is one block of CSS variables under `[data-theme="<id>"]` in
`web/src/theme/themes.css`, plus one line in `web/src/theme/themes.ts`
(`id`, `label`, `note`, `page`, `scheme`). Components and charts only read the
variables, so a new theme needs no component change. A test checks that every
theme has the same variables.

- **Ember** is the default. **Dark** (indigo) and **Light** (parchment) are the
  others. The choice is kept in `localStorage` and set on `<html>` by a script
  file that runs before React, so the page never flashes.
- `theme-color` and the favicon follow the theme's `--page` and `--accent`.
  The web app manifest can only have one color: the default theme's `--page`.
- The tokens are Tailwind names in one place, `web/src/theme/tokens.css`,
  which also maps shadcn/ui's names onto them. Tailwind's default palette and
  breakpoints are off, so components can only use the tokens. The breakpoints
  are `desk:` (wider than 860 px) and `wide:` (wider than 1100 px).
- Scrollbars are styled once in `tokens.css` (thin, `--text-3` thumb).

| Token                                  | Used for                                                       |
| -------------------------------------- | -------------------------------------------------------------- |
| `--page`                               | Page background                                                |
| `--card`                               | Cards, menus                                                   |
| `--raised`                             | Rows and tiles inside cards, badges, slots                     |
| `--hover`                              | Hover on rows and menu items, row separators                   |
| `--border`, `--border-strong`          | Borders; the strong one on neutral buttons and dialogs         |
| `--text`, `--text-2`, `--text-3`       | Body text and numbers; secondary text; labels, axes, metadata  |
| `--accent`                             | Filled buttons, the chosen sub-tab, focus rings                |
| `--accent-text`                        | Links, outline buttons, the chosen filter (readable text)      |
| `--accent-wash`                        | The chosen destination and filter, "done" and "have"           |
| `--on-accent`, `--on-down`             | Text on `--accent` and on `--down`                             |
| `--active`, `--afk`                    | Active play time and single series; AFK and "Other"            |
| `--acc-1` … `--acc-5`                  | Account colors                                                 |
| `--heat-0` … `--heat-6`                | Heatmap and calendar (0 = no time)                             |
| `--up`, `--down`                       | Errors, destructive actions, price changes                     |
| `--live`                               | The Live and Online dot                                        |
| `--info`, `--info-text`, `--info-wash` | New collection log items only                                  |
| `--grid`                               | Chart grid lines                                               |
| `--shadow`, `--overlay`                | Menus and tooltips; the backdrop behind dialogs                |
| `--safe-top` … `--safe-left`           | Safe areas of an installed app (0 on a PC and in a normal tab) |

**Contrast:** all text is at least 4.5:1 and large numbers and graphics at least
3:1 against every surface they sit on, in every theme
(`web/src/theme/contrast.test.ts`). `--afk` is the accepted exception: charts
with AFK always have a tooltip, and Screen time has a table view. Don't add a
color without checking it the same way.

## Chart colors

The account colors and the accent were checked for color blindness (protan
and deutan, Machado 2009) and distance (CIEDE2000), and for contrast against
`--card` in every theme.

- **Active and AFK:** active has the color, AFK is neutral. In stacked bars,
  active is at the bottom, with 2 px between segments.
- **Accounts:** the color follows the account, never its position or rank:
  ascending account ID, first account `--acc-1`. The same on every page and in
  every theme. The first three can stand together in any chart; accounts 4 and
  5 need direct labels; from the sixth on, the rest is "Other" (`--afk`).
  Account colors and active/AFK never share a chart.
- **Skills have no colors.** Skill charts have one series (`--active`) with
  names on the bars.
- **Heat:** one scale for the heatmap and the calendar. Step =
  `1 + floor(sqrt(v / max) × 6)`, at most 6; 0 is `--heat-0` (`heatStep` in
  `web/src/lib/heat.ts`).
- **Changes against the previous period are neutral:** ▲/▼ in `--text-2`,
  never green or red. Less play time isn't "bad". The one exception is price
  changes (Price movers on Bank), in `--up` and `--down`, always with ▲ or ▼.
- **Status colors** (`--up`, `--down`, `--live`) are for errors, destructive
  actions and the live dot, always with text or an icon too. Never a series
  color. Done and "have" are `--accent-wash`, never green.
- **Text never uses a series color.** A colored dot or bar next to it carries
  the identity.
- **One axis per chart.** No charts with two y-axes.

## Typography

- **Space Grotesk** (500, 600, 700) for big numbers, page titles, dialog
  titles and the login and error pages. **Inter** for the rest of the UI.
  **JetBrains Mono** for API keys, IDs, file and variable names, versions and
  PB times. All are bundled; the dashboard never loads fonts or anything else
  from the internet.
- Weights 400, 500 and 600. **Filled buttons are 600.**
- `font-variant-numeric: tabular-nums` in tables, axes and numbers that stand
  under each other.
- Sentence case in UI text ("Create key", not "Create Key").

| Role                            | Size / weight                                             |
| ------------------------------- | --------------------------------------------------------- |
| Big numbers in the stat strip   | 48 (44 on a phone, 56 on Home)                            |
| Page title                      | 30 / 600 (24 on a phone)                                  |
| Numbers in cards                | 20–30                                                     |
| Numbers in tiles                | 22 / 600 (19 on a phone)                                  |
| Card title                      | 16 / 600                                                  |
| Body text                       | 14 / 400 (text fields 16 on a phone, so iOS doesn't zoom) |
| Tables                          | 13 / 400                                                  |
| Labels, metadata, table headers | 12 / 400                                                  |
| Axes, the smallest text         | 11 / 400 (never smaller)                                  |

## Layout and density

- Content is centered with a max width of **1376 px**. The top bar is the full
  width; its content and the footer follow the content's edge.
- **Cards:** radius 14 px (16 on a phone), padding 22 × 24 px (18 on a phone),
  1 px border, 20 px between cards. Tiles inside cards: radius 8, `--raised`.
- Table rows 36 px. Spacing on a 4/8 px grid.
- **Buttons:** radius 8 (10 on a phone), 36 px high on a PC and 44 on a phone,
  14 px text. Neutral buttons (`ghost`: Cancel, Load more, Show all) have a
  `--border-strong` border; `outline` buttons an `--accent` border.
- **Fields and selects:** 40 px with radius 8 on a PC, 44 px with radius 10 on
  a phone.
- **Breakpoints:** at 1100 px and narrower, pages with two or three columns
  become one. At 860 px and narrower, the phone layout.
- **Touch targets** on a phone are at least 44 px.
- Icons: `lucide-react`, outline.
- **Safe areas:** `viewport-fit=cover`, and `--safe-*` keep content clear of
  the notch, status bar and home indicator in an installed app.

## Placeholders and icons

The repo never has game graphics. Real icons come only from the user's own
database, uploaded by their plugin
([ADR 0015](decisions/0015-icons-from-the-users-client.md)).

- **`ItemIcon`:** a dashed square with the first two letters of the name, and
  the real icon from `GET /api/v1/items/:itemId/icon` on top once it has
  loaded. The placeholder stays on `404` or an error. The box always has a
  fixed size, so nothing jumps.
- **`SkillIcon`:** a square with a fixed abbreviation (`Ra`, `HP`, `RC` …).
  **`BossIcon`:** initials (`COX`, `TOB`, `KBD`; a one-word name gives two
  letters, `Vo`). Both show the real sprite on top, the same way
  (`IconImage`).
- **Sizes are whole multiples only**, since the icons are pixel art: items
  `sm` 24 × 24 (scaled down to fit), `slot` 36 × 32 (the game's size, in
  grids), `lg` 72 × 64 (2×, pets); skills and bosses 25 × 25 or 50 × 50
  (`image-rendering: pixelated`).
- **Account types** are text ("Ironman", "HC group ironman"), never helmet
  icons.
- Seed data, tests and screenshots only ever show placeholders.

## Logo and app icons

A flame over two crossed logs, drawn for the project
(`web/src/branding/logo.ts`). Round strokes in the lucide style on a rounded
square in `--accent`, the strokes in `--on-accent`, so it follows the theme.
`assets/logo/` and `web/public/favicon.svg` are made from it, and a test checks
they match. The app icons (`web/public/icons/`, `apple-touch-icon.png`) are
PNGs of the same logo in the default theme's colors; the maskable and Apple
ones are full squares with the mark inside the safe circle. The name next to
the logo comes from `BRANDING`.

## Libraries

| Library                      | Why                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| shadcn/ui (Radix + Tailwind) | Components copied into the repo (`web/src/components/ui/`), so we own them. Radix gives keyboard, focus and screen reader support |
| Recharts                     | SVG charts whose colors can be `var(--…)`, so charts follow the theme                                                             |
| Own components               | Heatmap, activity calendar and session timeline are simple CSS/SVG grids                                                          |
| TanStack Query               | Fetching, caching and polling                                                                                                     |
| React Router                 | Routes                                                                                                                            |

## Shared patterns

1. **Stat strip on top (`StatStrip`):** the most important numbers straight on
   the page background, no card, with a line under. On a phone the first number
   is big and the rest in a row below.
2. **Cards** as in [Layout and density](#layout-and-density).
3. **Six rows:** a list the dashboard already has in full shows the first six,
   then "Show all (n)", which unfolds in place. The number in the card's header
   says how many there are. Lists fetched page by page with a cursor (Sessions,
   Valuable drops, Special loot) have no total and keep "Load more" without a
   number.
4. **Segmented controls (`Segmented`):** two looks. Sub-tabs (`SegmentedTabs`)
   are filled in `--accent` with `--on-accent`. Period, filter and sorting
   (`SegmentedFilter`) have the chosen option in `--accent-wash` with
   `--accent-text`.
5. **Dialogs:** a box in the middle on a PC, a sheet from the bottom on a phone.
   Esc closes, and focus goes back to what opened it. On a PC, focus starts in
   the first field; on a phone, on the sheet's title, so the keyboard only opens
   when you tap a field. A sheet stays above the on-screen keyboard and scrolls
   inside.
6. **History link row (`HistoryLinkRow`):** a dashed row at the bottom of a
   list ("Revoked keys · 5 →"), only when there is something behind it.
7. **Code field (`CodeField`):** six boxes, one per digit; a pasted or
   suggested code fills all of them. Only the first box has
   `autocomplete="one-time-code"`.

## Components

The building blocks are in `web/src/components/`. The main ones:

| Component                                                                    | What it is                                                                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `AppShell`, `TopBar`, `BottomTabBar`, `PageHeader`, `SubTabs`                | The shell and navigation (above). `AppShell` waits for `health` before showing a page                             |
| `Footer`                                                                     | The Jagex disclaimer from `BRANDING`, server and contract version, About and GitHub links                         |
| `AccountSwitcher`                                                            | "All accounts" and each account with its color, type, total level and Online (see [Online](#online)) or last seen |
| `Card`, `CardHeader`, `QueryCard`                                            | Cards with a title on the left and a link or controls on the right ("Weekly →")                                   |
| `StatStrip`, `Delta`                                                         | The stat strip; a neutral ▲/▼ with duration and percent                                                           |
| `HBarList`, `ShowAllButton`                                                  | Name, bar and value, with the six-row rule                                                                        |
| `DataTable`                                                                  | shadcn Table: right-aligned numbers, tabular digits, row hover                                                    |
| `StackedBars`, `XpLine`, `ValueLine`, `ValueBars`, `Sparkline`               | Charts: active/AFK, one series over time, bars, a line without axes                                               |
| `HourHeatmap`, `ActivityCalendar`, `WeekDayBars`                             | Heat grids and the bars per weekday                                                                               |
| `SessionTimeline`, `SessionRow`, `ShortSessionsRow`, `HopChainBar`           | Sessions                                                                                                          |
| `ItemIcon`, `SkillIcon`, `BossIcon`, `ItemGrid`, `ItemSlot`, `EquipmentGrid` | Icons and the game's own grids                                                                                    |
| `Gp`                                                                         | A compact gp value with the exact value in a tooltip                                                              |
| `Badge`, `LiveBadge`                                                         | Account type, Live, Revoked, New, Unconfirmed, Manual …                                                           |
| `EmptyState`, `ErrorState`, `CardSkeleton`                                   | The states below                                                                                                  |
| `ConfirmDialog`, `EditDropDialog`, `AddDropDialog`                           | Dialogs and sheets (`web/src/components/ui/sheet.tsx`)                                                            |
| `SecretReveal`, `CopyButton`                                                 | A secret shown once, with Copy                                                                                    |
| `StackedColumns`                                                             | Two columns that stack on their own (Weekly, Raids); one column below 1100 px                                     |
| `AccountCards`                                                               | One link card per account for `all`                                                                               |
| `QrCode`                                                                     | The two-factor QR code: one SVG path, always black on white (the one exception to the tokens)                     |

## Data and fetching

- **One hook per endpoint** in `web/src/api/hooks.ts`, with types from
  `shared/src/schemas/api/`. The query key holds the account and every
  parameter.
- `staleTime` is 30 s. When the period or account changes, the previous data
  stays (`keepPreviousData`) with a skeleton only where there is none. Pages
  where one account's numbers must never show under another's (Bank) don't
  keep previous data across accounts.
- **Polling only for an ongoing session:** while a session is live (see
  [Online](#online)), Home, Sessions and Session detail refetch every 30 s;
  paused when the tab is hidden. The accounts list (switcher, Home, Settings →
  OSRS accounts) refetches every 30 s while any account shows as Online, so a
  logout shows as offline within one poll. No polling otherwise.
- Responses are validated with Zod in development and tests only
  (`web/src/api/validate.ts`). Zod is kept out of the production bundle; the
  build fails if it gets back in.
- The client only talks to its own origin (`web/src/api/client.ts`).
- An unknown account ID in the URL gives a toast ("That account doesn't exist")
  and goes to `/all`.

## Online

One rule for every "Online" (the account switcher, the line on Home, the
account chips, Settings → OSRS accounts), in `isOnline`
(`web/src/lib/accounts.ts`). An account is Online when both hold:

- its last heartbeat is less than 3 minutes old, and
- its newest session (`latestSession` in `GET /accounts`) is **live**: open,
  or ended by a world hop less than 2 minutes ago (the window for merging
  hops), so a hop never flickers to offline.

A logout or a closed client is offline at once. A killed client leaves its
session open, so it stays Online until the 3 minutes pass. The server sends
only facts (`endedAt`, `endReason`); the dashboard applies the rule with its
own clock. The same "live" test (`isSessionLive`) decides when Home, Sessions
and Session detail poll.

## Empty states

An invitation, not an apology: one sentence, and an action where it fits.

- **No accounts yet:** the welcome on Home in three numbered steps, linking to
  `/settings/keys`.
- **A card without data** keeps its height with a short line ("Valuable drops
  show up here.", "No XP gained today yet.").
- Pages for data that doesn't exist yet are hidden, not empty (see
  [Page map](#page-map)).
- An account without a display name or type (before its first
  `session.start`) shows as "Unknown account" without a type badge.

## Loading

- A skeleton in the shape of the content, per card. Never a spinner for the
  whole page.
- Skeletons show after 200 ms, so fast answers don't flash.
- A button that is waiting says so ("Creating…", "Rebuilding…") and can't be
  pressed twice.

## Errors

- **Per card:** "Couldn't load this." with a Retry button. The rest of the page
  keeps working.
- **The server doesn't answer:** a banner ("Can't reach the server.
  Retrying…") that goes away by itself.
- **`403`** in local mode: a full-page message that the dashboard only works on
  this PC. **`403`** for a member on an admin action: "Admins only".
- **`404`** for a session or account: a full-page message with a link back.
- **Form errors** (`VALIDATION_ERROR`): `details[].message` under the field.
- **`429` and `503` with `RATE_LIMITED`** on login and settings forms: the
  server's message.
- Never show raw errors or stack traces.

## Number and time formats

All formatting is in one module, `web/src/format.ts`, with a test per row
(`web/src/format.test.ts`). The locale is `en-GB`.

| What                   | Rule                                                                                                                                   | Example                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Whole numbers          | Thousands separator                                                                                                                    | `2,851`                                          |
| Compact (XP, gp)       | Under 10,000 whole; under 1M K (1 decimal under 100K); under 1B M (2 decimals under 100M); else B (2 decimals). Trailing zeros dropped | `8,866` `26.7K` `175K` `12.08M` `333.1M` `2.13B` |
| Gp                     | Compact + " gp", exact value in a tooltip                                                                                              | `1.12M gp`                                       |
| XP in tables           | Whole number, `+` for a gain                                                                                                           | `+553,151`                                       |
| Duration               | `H h M min`, `H h`, `M min`; never seconds                                                                                             | `4 h 55 min`, `3 h`, `40 min`                    |
| Time axes              | Hours                                                                                                                                  | `0h` `4h` `12h`                                  |
| Percent                | `Intl` percent, no space                                                                                                               | `20%`                                            |
| Change                 | Neutral ▲/▼, value and percent                                                                                                         | `▼ 4 h 1 min (−2%) vs previous 30 days`          |
| PB times               | `m:ss.s` in mono                                                                                                                       | `18:08.4`                                        |
| Clock                  | 24-hour                                                                                                                                | `16:32`                                          |
| Date                   | Weekday, day, month; the year only when it isn't this year                                                                             | `Tue 10 Nov`, `Sat 7 Dec 2025`                   |
| Within 24 hours        | Relative                                                                                                                               | `just now`, `12 min ago`, `3 h ago`              |
| Older times            | Date and clock                                                                                                                         | `1 Nov, 16:26`                                   |
| Week                   | ISO week                                                                                                                               | `Week 46`, `2026 · week 46`                      |
| Skills                 | Title case of the enum name                                                                                                            | `RUNECRAFT` → `Runecraft`                        |
| Locations, world types | A table of display names; unknown values in title case                                                                                 | `UNITED_STATES_OF_AMERICA` → `United States`     |

## Time zone

- Days, weeks, the heatmap and the calendar are computed on the server in `TZ`.
  The dashboard shows **every** time and date in that same zone, never the
  browser's; otherwise a session at 00:30 could land on the wrong day.
- The zone comes from `GET /api/v1/health` (`timeZone`) and goes into every
  `Intl.DateTimeFormat` call.
- Local dates from the API (`2026-11-09`, `2026-W45`) are formatted as dates,
  never through `new Date()` in local time. Date pickers use the server's date.

## Legal

The rules come from [legal.md](legal.md).

- The footer with `BRANDING.jagexDisclaimer` is on **every** page, also
  Settings, the login page and error pages.
- No Jagex graphics: placeholders, or real icons from the user's own database.
- Other players' names are never shown or stored
  ([ADR 0006](decisions/0006-no-data-about-other-players.md)). `PLAYER` loot
  shows as "Player". A teammate's purple shows as "Teammate". A nickname on a
  raid drop is the user's own note, typed in the dashboard; the dialog says
  "Your own note. Stored only on your server, never sent by the plugin."
- The product name and logo come from `BRANDING`, never written by hand.

## Accessibility

- Every color is contrast-checked (see [Themes](#themes)).
- Charts with several series always have a legend. Values are in tooltips, and
  Screen time has a table view. Charts and grids have `role="img"` and a short
  name.
- Menus, tabs, dialogs and tooltips use Radix: keyboard, focus and Esc. Every
  focusable element has a visible ring in `--accent`
  (`web/src/theme/focus-ring.test.ts`).
- Icon buttons have an `aria-label`, and an element's name contains its
  visible text.
- Links inside text are underlined.
- A box that scrolls sideways is a tab stop with a name while it scrolls.
- Headings go down one level at a time.
- `prefers-reduced-motion`: no animations; without it, only the Live dot
  pulses.
- `SNAPSHOT_AXE=1 node scripts/ui-snapshots.ts` runs axe-core on every page and
  state. Accepted exceptions: Radix hides the page behind an open modal menu
  (no `main` or `h1` while it's open), and placeholder letters in icons count
  as visible text (gone with real icons).
