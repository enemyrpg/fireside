# What data Fireside collects

Fireside only handles your own game data. The RuneLite plugin sends it to the
Fireside server **you** set in its settings, run by you or someone you trust,
and nowhere else. There is no central Fireside service and no telemetry.

This page lists exactly what the plugin sends, what it never sends, what it
keeps on your computer, what the server stores and for how long, what the
server sends to other services when they are turned on, and how to delete it.
It is checked against the API contract (the Zod schemas in
[`shared/src/schemas/`](../shared/src/schemas/)) and the plugin's code.

**Contents**

1. [When the plugin sends anything](#when-the-plugin-sends-anything)
2. [What every request carries](#what-every-request-carries)
3. [Events, by setting](#events-by-setting)
4. [Icons](#icons)
5. [What is never sent](#what-is-never-sent)
6. [On your own computer](#on-your-own-computer)
7. [What the server stores, and for how long](#what-the-server-stores-and-for-how-long)
8. [External services](#external-services)
9. [Deleting data](#deleting-data)

## When the plugin sends anything

Only when all three are true:

- **Send data** is on in the plugin's settings (off by default),
- a **Server URL** is set, and
- an **API key** is set.

The plugin only talks to that server URL: it accepts plain `http(s)`
addresses only, never follows redirects (so the key can't be sent to another
host), and makes no request to any other host. "Open dashboard" opens the
same URL in your browser.

Each kind of data below can be turned off under **Data** in the plugin's
settings, except sessions, which are always sent while sending is on. Bank,
quests and diaries, and pets are only read on normal worlds (not Leagues,
Deadman or beta worlds).

## What every request carries

- `Authorization: Bearer <your API key>`.
- Your **IP address**, as with any web request. The server never stores it
  in the database; it only appears in the server log for security events (see
  [below](#what-the-server-stores-and-for-how-long)).
- RuneLite's HTTP client's own User-Agent. The plugin sets none of its own.

Every event has the same envelope:

| Field           | What it is                                                                   |
| --------------- | ---------------------------------------------------------------------------- |
| `eventId`       | A random ID (UUIDv7), so the same event is never stored twice                |
| `schemaVersion` | The event format version                                                     |
| `type`          | The event type below                                                         |
| `accountHash`   | RuneLite's account hash, which tells your OSRS accounts apart. Not your name |
| `occurredAt`    | When it happened in the game (UTC)                                           |
| `sessionId`     | A random ID for the play session                                             |
| `payload`       | The data for that type                                                       |

The server rejects any field it doesn't know, so the plugin can't send more
than what is listed here.

## Events, by setting

### Always (sessions)

| Event               | Payload                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `session.start`     | Your own display name, account type (normal, ironman, group ironman …), world, plugin version                                |
| `session.heartbeat` | Every minute: region ID, world, world types, the world's location and activity from the world list, and whether you are idle |
| `session.afk`       | Start and end of a period you were AFK (no input for the AFK threshold, 5 minutes by default)                                |
| `session.end`       | Why it ended: logout, client closed or world hop                                                                             |

### XP

| Event         | Payload                                                                             |
| ------------- | ----------------------------------------------------------------------------------- |
| `xp.snapshot` | XP and level for every skill, at login, at logout and every 5 minutes if it changed |

### Loot

| Event  | Payload                                                                                                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loot` | The source (an NPC with its name, ID and combat level; an event, clue or other source by name; or **a player, always without a name**), the items (ID, name, quantity, GE and high alch price) |

### Kill counts

| Event        | Payload                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `kc`         | Boss or activity, kill count, and when the game shows them: kill time, personal best and team size                                          |
| `pb.records` | Your own raid personal bests per team size, when you open The Fractured Archive's records table yourself. The plugin never opens it for you |

This setting also covers the kill count attached to `loot` and
`raid.special_loot`.

### Raid purples

| Event               | Payload                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `raid.special_loot` | The raid, the item (ID, name, quantity, GE price), **who got it: `SELF` or `TEAMMATE` only**, team size and kill count |

### Bank

| Event                     | Payload                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `bank.snapshot`           | Your bank as the game has it (tab sizes, items in order with placeholders, quantity, GE and high alch price), inventory and equipment |
| `potion_storage.snapshot` | The potions in potion storage, with doses and prices                                                                                  |

Sent when you close the bank, only if something changed, and at most once
every 15 minutes per account. The plugin only reads the game's own item
containers and bank tab settings, never the layout of other plugins.

### Quests and diaries

| Event              | Payload                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `quests.snapshot`  | Quest points, and every quest and miniquest: not started, in progress or finished |
| `diaries.snapshot` | Which achievement diary tiers are completed, per region                           |

### Pets

| Event      | Payload                                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pet.drop` | Which of the game's pet messages you got (followed you, went to your backpack, duplicate), and the plugin's guess of which pet and from what (based on your latest kill, loot or skill) |

The text of the message is never sent.

## Icons

With **Upload item icons** on (the default), the plugin uploads small PNG
images (at most 64×64) taken from your own RuneLite client, so the dashboard
can show them: item icons the server doesn't have yet, skill and boss icons,
and once, about 1,800 collection log icons. They are stored only on your
server. Fireside's source code, Docker image and seed data contain no game
images. See [legal.md](legal.md).

The plugin also calls `GET /api/v1/ingest/verify` to check the connection.
It sends nothing but the key, and gets back the key's name and the server's
version and time.

## What is never sent

- **Other players' names.** Loot from another player is sent as `PLAYER`
  without a name. A raid purple is only `SELF` or `TEAMMATE`: the name in the
  game's message is only compared with yours and then dropped. The server
  rejects these events if they carry any other field.
- **Chat messages.** The plugin reads a few game messages (kill counts,
  drops, pets) and only sends the values in them, never the text.
- **Your Jagex password or login.** Fireside never asks for them. A Fireside
  login is a separate account on your server.
- Anything to any host other than your server.

## On your own computer

- **The queue:** `.runelite/plugin-data/fireside/queue/` in your home folder.
  `pending.jsonl` holds events waiting to be sent, exactly as they will be
  sent (including your display name from `session.start`). They are removed
  once the server has them. `rejected.jsonl` keeps events the server refused,
  for troubleshooting, and is never cleaned up automatically. While **Send
  data** is on, events are queued even if the server URL or key is missing;
  they are sent once both are set.
- **The API key** is stored by RuneLite with the plugin's settings, as a
  secret setting.

## What the server stores, and for how long

A server you run stores this. On a server someone else runs, its admin
describes it on `/about` (linked from the login page and the footer).

| Where                                                   | What                                                                                                                                                                                                            | How long                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Users                                                   | Username, password hash (argon2id), 2FA secret encrypted with `fireside.key`, hashed recovery codes, when the user was created, last logged in or was disabled                                                  | Until the user is deleted                                                                                              |
| Sessions                                                | A hash of the session token, times, the browser's user agent (200 characters). No IP                                                                                                                            | 30 days after last use, at most 90 days. Also deleted on logout, password change and deletion                          |
| Remembered browsers                                     | A hash of the device token and times. No IP or user agent                                                                                                                                                       | Up to 365 days, at most 20 per user                                                                                    |
| API keys                                                | The name you gave it, a hash, a short prefix, when it was last used                                                                                                                                             | Revoked keys are kept until the user is deleted                                                                        |
| Invites                                                 | The admin's label, who created it and who used it                                                                                                                                                               | Kept. When a user is deleted, the invite they came from loses its label and its link to them                           |
| Audit log                                               | Time, the acting user's ID, the action (logins, password and 2FA changes, invites, reset links, key changes, admin actions) and its target ID. No IP, names or secrets                                          | Kept. When a user is deleted, their own entries about themselves and their keys go; other entries keep only the old ID |
| Game data (raw events and everything derived from them) | Per OSRS account: account hash, account type, display names and their history, sessions and play time (world, region, AFK), XP, loot, kill counts, PBs, bank and storage, quests, diaries, collection log, pets | Until the user is deleted                                                                                              |
| Raid split tracker                                      | Nicknames and notes you type yourself for raid drops. Never sent by the plugin                                                                                                                                  | Until you delete them or the user is deleted                                                                           |
| RuneProfile data                                        | The raw RuneProfile response, only for accounts you turned it on for                                                                                                                                            | Until the user is deleted                                                                                              |
| Memory (login limits)                                   | IP addresses (IPv6 per /64), usernames typed in failed logins, user IDs                                                                                                                                         | An hour after the last failure, or until restart                                                                       |
| Memory (2FA step)                                       | User ID and password hash between the password and the code                                                                                                                                                     | 5 minutes, or until restart                                                                                            |
| Server log                                              | IP addresses only for security events: failed logins (never the username), wrong codes, invalid links, too many attempts, an IP blocked for requests without a valid key                                        | Depends on how the server is run. Docker rotates it (10 MB × 5 files); with systemd the journal's settings decide      |
| Backups                                                 | Full copies of the database                                                                                                                                                                                     | 7 daily, 4 weekly and 6 monthly by default, and no file older than the longest level (6 months)                        |

The database has no column for IP addresses. Item icons, prices and server
settings hold no personal data. Users are separate: nobody sees another
user's game data in the dashboard. An admin sees usernames and API key names,
and whoever runs the server has the database file and the backups.

## External services

The server only calls out when the admin turns a source on and sets a
contact (`USER_AGENT_CONTACT`); see
[Optional external sources](self-hosting.md#optional-external-sources). Every
call sends the User-Agent `Fireside/<version> (+<contact>)`, so the service
can reach whoever runs the instance. The plugin never calls these services.

| Service                                                              | When                                                                                                                                        | What is sent                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OSRS Wiki Prices](https://prices.runescape.wiki) (`PRICES_ENABLED`) | At most once an hour, one request for all items                                                                                             | The server's IP address and the User-Agent with the contact. **Nothing about you or your accounts**                                                                                          |
| [RuneProfile](https://runeprofile.com) (`RUNEPROFILE_ENABLED`)       | For accounts whose owner turned it on under Settings → OSRS accounts: a few minutes after a session ends, every 6 hours and on **Sync now** | The server's IP address, the User-Agent, the account's **current display name** (in the request path), and the instance's RuneProfile API key if one is set. RuneProfile profiles are public |

The server log never contains the display name sent to RuneProfile. No other
service is called.

## Deleting data

- **Your user and everything in it:** **Settings → Profile → Delete my
  account** (asks for your password), or an admin deletes the user under
  **Settings → Users**. This removes all of that user's data, the raw events
  included, at once. It needs login mode: in local mode the only user is the
  admin, who can't be deleted.
- **Raid split nicknames and notes** can be changed or cleared in the raid
  split tracker, and drops you added by hand can be deleted there.
- **RuneProfile:** turning it off for an account stops the lookups and keeps
  what was already fetched; deleting the user removes it.
- **Backups:** deleted data stays in older backups until they age out (6
  months by default). The admin can delete backup files by hand.
- **Server log:** depends on how the server is run (see the table above).
- **On your computer:** delete `.runelite/plugin-data/fireside/` and remove
  the plugin. Revoke its API key under **Settings → API keys**.

There is no way to delete a single OSRS account's data while keeping the
user.
