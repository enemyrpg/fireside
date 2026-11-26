# Legal notes

How Fireside stays within the rules of Jagex, RuneLite and the external
services it can use, and how the project is licensed. **This is not legal
advice**, only an overview of the rules as we read them.

The rules are read again before every release that adds an external source
and before game data from the OSRS Wiki is added. Last reviewed: 22 November 2026.

**Contents**

1. [Summary](#summary)
2. [Jagex: third-party client rules](#jagex-third-party-client-rules)
3. [Jagex: Fan Content Policy](#jagex-fan-content-policy)
4. [RuneLite Plugin Hub](#runelite-plugin-hub)
5. [External sources](#external-sources)
6. [Privacy](#privacy)
7. [Licenses](#licenses)
8. [Contact](#contact)
9. [Sources](#sources)

## Summary

- Nobody approves plugins or companion apps in advance. Jagex approves
  clients (RuneLite), not single plugins, and RuneLite reviews a plugin when
  it is submitted to the Plugin Hub.
- Fireside only handles each player's own data, automates nothing and gives
  no advantage in the game.
- The project never distributes Jagex graphics. The item, skill and boss
  icons the dashboard shows only come from the user's own client into the
  user's own server. If Jagex asks, they are replaced with placeholders.

## Jagex: third-party client rules

**The rules.** Only the official clients and the clients on Jagex's Approved
Client List (RuneLite and HDOS) are allowed. Jagex's page "Macro and client
features not permitted" forbids, among other things, generating input (mouse
clicks, key presses), modifying the client, sending repeated or heavy
requests to Jagex's servers, and features forbidden by the Third Party
Client Guidelines. Jagex's Terms say they tolerate third-party software
within the rules, but give no licence for it. Schedule 4 of the EULA
("Official Game Client Plugins") is about plugins for Jagex's own clients
through their plugin library and does not apply to RuneLite plugins.

**Fireside.** The plugin only reads data about the player's own accounts,
automates nothing and gives no advantage in the game. It never sends input,
changes menus or shows information the game hides, and it never contacts
Jagex's servers.

## Jagex: Fan Content Policy

**The policy** (v1.4):

- Modifications and plugins are allowed "as part of official programs"
  (4.1.6).
- Jagex's property may **not** be used in companion, guide and other support
  apps. The reason given is that such apps are often used for phishing and
  malware (6.1.3).
- The policy doesn't cover the source code and software of the games (2.2).
- No commercial use (6.1.1), no competing with Jagex (6.1.4), no imitating
  Jagex or suggesting that Jagex is behind it (6.1.6), never the Jagex logo
  without permission (2.4).
- A fixed credit text is required (8.1).
- Jagex normally asks for something to stop before going further (9.1).

RuneScape and Old School RuneScape are trademarks of Jagex Limited.

**Fireside.**

- The plugin contains no Jagex graphics or other Jagex content. It is
  software in an approved client, covered by the client rules and the Plugin
  Hub rules like every other Hub plugin.
- The dashboard is a companion app. It shows item, skill, boss and collection
  log icons that the plugin takes from the user's own client and sends to
  the user's own server. The project itself never distributes them.
- Fireside is not what 6.1.3 is meant to stop: it never asks for a Jagex
  login, it is open source, and it is run by the user or someone the user
  trusts. The login page says clearly that a Fireside account is not the
  Jagex account and that the Jagex password must never be entered there.
- If Jagex asks us to remove the icons, they are replaced with placeholders
  in a patch release.

**What we do:**

- **The credit text**, unchanged, in the README of both repositories, the
  Plugin Hub description, the dashboard footer and the project website
  (fireside.tools):

  > Created using intellectual property belonging to Jagex Limited under the
  > terms of Jagex's Fan Content Policy. This content is not endorsed by or
  > affiliated with Jagex.

- **No Jagex assets in the repositories or the Docker image:** no item, skill
  or boss icons, game screenshots or logos in the source code, fixtures,
  seed data or image. Icons only reach a server from its user's own client,
  and are never downloaded from the OSRS Wiki or Jagex's websites. A CI check
  looks for image files in the image. Screenshots in the README use
  placeholder icons and simulated data.
- **No Jagex logo**, and nothing that looks like Jagex's products or
  websites. The Fireside name and logo are our own.
- **Non-commercial:** the project has no payments, paid features, donations
  or public or paid hosted service. Private instances for friends are fine.
  The MIT licence allows any use of the code, but Jagex's Fan Content Policy
  applies to anyone who uses Jagex's content, including anyone who runs an
  instance.

## RuneLite Plugin Hub

**The rules.** Plugins are reviewed to check that they are not harmful, don't
break Jagex's rules and aren't on RuneLite's list of rejected features. The
[Plugin Hub README](https://github.com/runelite/plugin-hub) lists the APIs
that are forbidden, the ones that are reviewed again on every change, and the
ones that need manual review.

**The plugin** has no dependencies outside runelite-client and uses none of
the forbidden or restricted APIs. Its sensitive uses are its network traffic
(only to the user's own server) and one `Client.runScript` call that reads
the doses in potion storage with the game's own script, like RuneLite's Bank
Tags plugin, without any server action. Nothing is sent until a server URL
and API key are set and sending is turned on.

**Rejected features that resemble Fireside:**

| Rejected                                                          | Fireside                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Crowdsourcing data about other players (location, gear, names)    | Only the player's own data. Other players' names are never sent                            |
| Plugins that expose player information over HTTP                  | The plugin runs no HTTP server; it only sends to the user's own server                     |
| Hiscores for personal bests and other data that can't be verified | No public lists or leaderboards, and no ranking or comparison between users on an instance |
| Features that can be abused for AFK training                      | AFK detection is only statistics and gives no alerts in the game                           |
| Plugins that change RuneLite's core UI or other plugins' config   | Only its own side panel and its own config group                                           |

## External sources

All external calls are off by default, go through one module in the server
(`server/src/external/client.ts`), and need both their own setting and a
contact (`USER_AGENT_CONTACT`) for the User-Agent. Tests never use the real
network. What each one sends is in
[data-collected.md](data-collected.md#external-services).

| Source                                                   | Terms                                                                                                                                                                                                                                                 | What Fireside does                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OSRS Wiki** (content)                                  | CC BY-NC-SA 3.0: attribution, non-commercial, share alike. Images on the wiki are Jagex's graphics and not covered by the wiki's licence                                                                                                              | Game data generated from the wiki (`shared/gamedata/`, not there yet) will be CC BY-NC-SA 3.0 with its own LICENSE and attribution, not MIT. Images are never downloaded from the wiki                                                     |
| **OSRS Wiki Prices** (`PRICES_ENABLED`)                  | A descriptive User-Agent, preferably with contact details. Tools that abuse the API can be blocked; use `/latest` without an `id` rather than one call per item                                                                                       | User-Agent `Fireside/<version> (+<contact>)`. One call to `/api/v2/osrs/latest` for all items, only when needed: at most once an hour, about 6 a day when idle                                                                             |
| **RuneProfile** (`RUNEPROFILE_ENABLED`)                  | The public API is for community projects: respect the rate limit (at the time of review 30 per minute without a key, 120 with one), cache responses, don't overload the service, only data for accounts you play yourself. Profiles are always public | At most 20 calls a minute and one sync per account per minute, only for accounts their owner turns on, the dashboard says the profile is public, and a name check keeps another player's old profile under the same name from being stored |
| **RuneLite plugins** (Chat Commands, Loot Tracker, Bank) | BSD-2-Clause                                                                                                                                                                                                                                          | Keep the copyright notice if code is copied                                                                                                                                                                                                |

## Privacy

- All data is the user's own and is stored on a server the user runs, or
  someone the user trusts runs. No telemetry. The plugin only sends the IP
  address and account data to the server set in its config.
- **Other players' names are never sent.** Loot from players has no name, and
  raid purples are only `SELF` or `TEAMMATE`. The one exception to "no data
  about other players" is nicknames and notes the owner types in the
  dashboard's raid split tracker. They live only in the tracker's own
  tables, are never sent by the plugin, never logged, and never in seed data.
- **Running an instance for others:** whoever runs it processes the other
  users' personal data (usernames, OSRS account names, play time, IP
  addresses in security log lines), and the GDPR may apply. The operator has
  to assess that for their own situation; a private group of friends may fall
  under the exemption for purely personal use. Either way, Fireside makes the
  simple things easy:
  - Users are fully separate. An admin doesn't see other users' game data in
    the dashboard, but has the database file and the backups, and the
    default instance text says so.
  - No hiscores or comparisons between users.
  - External lookups (RuneProfile) only for accounts their owner turns on.
  - The admin writes who runs the instance and how to reach them in the
    instance text, shown without login on `/about`. Until then, a default
    text built from the server's settings says what is stored and for how
    long.
  - Users can delete their user and all its data themselves.

Exactly what is collected, stored and sent: [data-collected.md](data-collected.md).

## Licenses

| Part                                                              | Licence                                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fireside` (server, dashboard, shared, scripts, docs)             | [MIT](../LICENSE)                                                                                                                                             |
| The Fireside logo (`assets/logo/`)                                | Our own drawing, MIT like the rest of the repository                                                                                                          |
| `shared/gamedata/` (generated from the OSRS Wiki, once it exists) | [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/), with attribution to the [Old School RuneScape Wiki](https://oldschool.runescape.wiki/) |
| [`fireside-plugin`](https://github.com/enemyrpg/fireside-plugin)  | BSD-2-Clause                                                                                                                                                  |

## Contact

Rights holders and anyone else with a concern can
[open an issue](https://github.com/enemyrpg/fireside/issues). For anything
sensitive, use
[private vulnerability reporting](https://github.com/enemyrpg/fireside/security/advisories/new).

## Sources

- [Jagex Fan Content Policy](https://legal.jagex.com/docs/policies/fan-content-policy)
- [Jagex EULA](https://legal.jagex.com/docs/terms/eula) (with Schedule 4)
- [Jagex Terms and Conditions](https://legal.jagex.com/docs/terms/terms-and-conditions)
- [Jagex: macro and client features not permitted](https://legal.jagex.com/docs/rules/macro-and-client-features-not-permitted)
- [Jagex: contact](https://legal.jagex.com/docs/contact-us)
- [RuneLite Plugin Hub](https://github.com/runelite/plugin-hub)
- [RuneLite: rejected or rolled back features](https://github.com/runelite/runelite/wiki/Rejected-or-Rolled-Back-Features)
- [Weird Gloop: licensing](https://meta.weirdgloop.org/w/Licensing)
- [OSRS Wiki: real-time prices](https://oldschool.runescape.wiki/w/RuneScape:Real-time_Prices)
- [RuneProfile terms](https://github.com/ReinhardtR/runeprofile/blob/main/apps/web/src/routes/legal/terms.tsx)
  and [API documentation](https://github.com/ReinhardtR/runeprofile/blob/main/apps/api/src/public/v1/index.ts)
