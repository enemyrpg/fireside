# Self-hosting Fireside

This guide covers running a Fireside server: installing it with or without
Docker, every setting, users and logins, API keys, backups, upgrades and
remote access. Commands are for the fish shell; they work the same in bash
unless noted.

**Contents**

1. [Requirements](#requirements)
2. [Docker](#docker)
3. [Without Docker](#without-docker)
4. [Configuration](#configuration)
5. [Local mode and login mode](#local-mode-and-login-mode)
6. [Users and invites](#users-and-invites)
7. [API keys](#api-keys)
8. [Two-factor authentication](#two-factor-authentication)
9. [Autostart](#autostart)
10. [Backups and restore](#backups-and-restore)
11. [Upgrading](#upgrading)
12. [Moving to another machine](#moving-to-another-machine)
13. [Remote access](#remote-access)
14. [Installing on a phone](#installing-on-a-phone)
15. [Optional external sources](#optional-external-sources)

## Requirements

- **Linux**, on amd64 or arm64.
- Either **Docker Engine (rootful) with the Compose plugin**, or **Node.js 26**
  (the version in `.node-version`) and **pnpm**.
- Rootless Docker is not supported: its host network is not the real host's.
  On Docker Desktop (macOS, Windows) host networking is untested; run without
  Docker there.
- The [RuneLite plugin](../README.md#plugin-setup) on the computer you play on.

Fireside needs no internet access. It never calls out unless you turn on an
[optional external source](#optional-external-sources).

## Docker

```fish
git clone https://github.com/enemyrpg/fireside.git
cd fireside
cp .env.example .env          # optional: every setting has a default
mkdir -p data                 # must exist, or Docker creates it owned by root
docker compose up -d          # pull the release image and start in the background
docker compose ps             # STATUS shows "healthy" after a few seconds
docker compose logs -f
```

The dashboard and the plugin's server URL are `http://127.0.0.1:3100`. The
container restarts with Docker (`restart: unless-stopped`); see
[Autostart](#autostart).

Docker reads `TZ`, `LOG_LEVEL`, the backup settings, `PUBLIC_URL`,
`TRUSTED_PROXY`, `MAX_USERS` and the external source settings from `.env`.

> [!IMPORTANT]
> **Docker ignores `HOST`, `PORT`, `DATA_DIR` and `BACKUP_DIR` in `.env`.**
> `docker-compose.yml` sets them for the container (`127.0.0.1`,
> `FIRESIDE_PORT`, `/data` and `/data/backups`). To change the port or the
> data folder in Docker, set the `FIRESIDE_*` variables instead
> ([Docker settings](#docker-settings)).

### The image

`docker-compose.yml` runs the release image from the GitHub Container
Registry, `ghcr.io/enemyrpg/fireside`, for linux/amd64 and linux/arm64. The
tag in `docker-compose.yml` is the version of the release your checkout is
on, so the code and the image always match; each release moves it. Every
release is also tagged `<major>.<minor>` (e.g. `0.1`) and `latest`, for use
outside this repo.

Each image has a build provenance attestation from the workflow that built
it. To check where an image came from:

```fish
gh attestation verify oci://ghcr.io/enemyrpg/fireside:0.1.0 -R enemyrpg/fireside
```

### Building the image yourself

To run your own changes, or not to pull from GHCR, build the image from the
checkout with `docker-compose.build.yml`. Add it to `.env`, so every
`docker compose` command uses it:

```sh
# .env
COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml
```

```fish
docker compose up -d --build
```

The built image is tagged `fireside:local` (`FIRESIDE_LOCAL_IMAGE`). Without
`COMPOSE_FILE`, the next `docker compose up -d` goes back to the release
image.

### Changing the port

Set `FIRESIDE_PORT` in `.env`, then recreate the container. It is the only
port variable Compose reads: `PORT` is ignored in Docker.

```sh
# .env
FIRESIDE_PORT=3110
```

```fish
docker compose up -d
```

The dashboard and the plugin's server URL are then `http://127.0.0.1:3110`.
With the tunnel, also change the route's Service URL in Cloudflare
([docs/tunnel.md](tunnel.md#add-the-route)). Setting `PORT` instead has no
effect in Docker: the container stays on 3100, and if something else already
uses 3100 it keeps restarting (see [Troubleshooting](#troubleshooting)).

**CLI in the container.** The image has the CLI as `fireside`. It prints the
database it uses:

```fish
docker compose exec fireside fireside keys create "Gaming PC"
docker compose exec fireside fireside keys list
docker compose exec fireside fireside users set-password admin
docker compose exec fireside fireside backup
```

Every `pnpm cli …` command in this guide works this way in Docker. The
exception is `restore`, which needs the server stopped and runs in a one-off
container ([Restore](#restore)).

### Why host networking

The dashboard only answers requests made on the machine it runs on (see
[Local mode and login mode](#local-mode-and-login-mode)). With a normal
published port, the server would see the Docker bridge address and answer
`403`. So the container uses `network_mode: host` and always listens on
`127.0.0.1`. Nothing on your network can reach it.

The trade-off: the container shares the host's network instead of getting
its own. To make up for that, it runs as a non-root user with all
capabilities dropped, `no-new-privileges` and a read-only file system.

### The data folder is private

The database, its backups and the two-factor key hold every user's password
hashes and game data. At every start the server makes the data folder and
its backups folder readable by their owner only: folders `0700`, the
server's own files `0600`, including files that were there before. The log
says how many paths it changed (`File permissions: …`). If a path belongs to
someone else, the server can't change it: it logs a warning and runs anyway.

On the host, `./data` can then only be opened by the user in `FIRESIDE_UID`.
Set `FIRESIDE_UID` and `FIRESIDE_GID` to your own user (`id -u`, `id -g`) to
list the folder and copy backups without `sudo`. Another user on the machine,
or a backup tool running as another user, can't read it.
`docker compose exec fireside fireside …` runs as the same user.

### Logs

The server logs to stdout. `docker-compose.yml` rotates the container's log
(`json-file`, 10 MB × 5 files), so Docker doesn't keep it forever. A change
to that setting applies when the container is recreated
(`docker compose up -d`). With systemd, the journal decides how long logs are
kept: set `SystemMaxUse=` and `MaxRetentionSec=` in `journald.conf`.

The log only holds IP addresses for security events: failed logins, wrong
codes, rejected links, IPs blocked for requests without a valid API key, and
too many attempts. See [What data Fireside collects](data-collected.md).

### Docker and `pnpm dev` at the same time

Only one server can use a data folder at a time
([One server per database](#one-server-per-database)). Docker ignores
`DATA_DIR` and `PORT` in `.env`, so they can be the development values while
Docker keeps the real database in `./data` on 3100:

```sh
# .env
DATA_DIR=./data-dev
PORT=3101
```

### A second instance in another clone

To try a branch or a new version next to your real instance, use a second
clone with its own settings, and mind two things Docker shares between
clones:

- **The project name.** Compose names containers and networks after the
  folder, so two clones in folders with the same name (e.g. `~/a/fireside`
  and `~/b/fireside`) are the same project, and `docker compose up` in one
  replaces the other's container. Clone into a folder with another name, or
  set `COMPOSE_PROJECT_NAME=fireside-test` in the second clone's `.env`.
- **The image, if you build it.** With the release image, both clones use
  the tag pinned in their own `docker-compose.yml`, and nothing is shared.
  With [`docker-compose.build.yml`](#building-the-image-yourself), both tag
  the image `fireside:local` by default, so `docker compose up --build` in
  the second clone replaces the image your real instance uses. The running
  container keeps its old image, but the next time it is recreated
  (`docker compose up -d`, an upgrade, a changed setting), it starts the
  second clone's code. Give the test clone its own tag in its `.env`:

  ```sh
  # .env in the second clone
  COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml
  FIRESIDE_LOCAL_IMAGE=fireside:test
  ```

And in the second clone's `.env`: another `FIRESIDE_PORT` (e.g. `3110`), its
own data folder (the default `./data` inside that clone is fine), and no
`COMPOSE_PROFILES=tunnel`, so only one `cloudflared` uses your tunnel token.

### Troubleshooting

**The container is stuck in "Restarting", and the log says `EADDRINUSE`**
(`docker compose ps` shows `Restarting`, `docker compose logs fireside` shows
`listen EADDRINUSE: address already in use 127.0.0.1:3100`). Another program
already listens on that port: another Fireside (Docker, the systemd service
or `pnpm dev`) or something else. Find it with `ss -tlnp | grep :3100`. Then
stop it, or give this container another port with `FIRESIDE_PORT` (not
`PORT`, which Docker ignores) and run `docker compose up -d`.

**It exits with "Fireside is already running on …".** Another server uses the
same data folder ([One server per database](#one-server-per-database)). Give
this one its own `FIRESIDE_DATA_PATH`.

## Without Docker

```fish
git clone https://github.com/enemyrpg/fireside.git
cd fireside
cp .env.example .env
pnpm install
pnpm build
```

Then run the server as a systemd user service ([Autostart](#autostart)). The
service runs `server/dist/index.js` with `NODE_ENV=production`, which serves
the dashboard and the API on `http://127.0.0.1:3100`. The CLI is `pnpm cli`
in the repo folder.

## Configuration

Settings come from `.env` in the repo folder (copy it from `.env.example`,
which has the same notes). Variables set in the environment take precedence
over `.env`. Every variable is optional, and an empty value means the
default.

If a value is invalid, the server lists every problem (never the values) and
exits with code 78. The systemd service doesn't restart then. The CLI and
`pnpm seed` exit with code 1. Relative paths are resolved from the repo
folder, however the server is started.

### Network

| Variable | Default     | Values     | Meaning                                                                                                                                                                                                             |
| -------- | ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`   | `127.0.0.1` | an address | Interface the server listens on. **Keep `127.0.0.1`.** Docker ignores it (always `127.0.0.1`). Any other value makes it reachable from other machines. For access from outside, see [Remote access](#remote-access) |
| `PORT`   | `3100`      | 1–65535    | Port for the dashboard and the API. Docker ignores it: use `FIRESIDE_PORT`                                                                                                                                          |

### Remote access

Leave these unset unless you follow [docs/tunnel.md](tunnel.md).

| Variable                     | Default                  | Values                                          | Meaning                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                 | unset                    | an origin, e.g. `https://dashboard.example.com` | The address the dashboard is reached at from outside (scheme and host only). In login mode it is the one host besides localhost the dashboard answers to, and invite and reset links use it. Must be `https` (`http` only for localhost), or the server refuses to start   |
| `TRUSTED_PROXY`              | unset                    | `cloudflare`                                    | Cloudflare Tunnel is in front. In login mode, requests from loopback with Cloudflare's headers are allowed for the `PUBLIC_URL` host, which is then only answered that way. The client IP for limits and logs comes from `CF-Connecting-IP`. Needs an `https` `PUBLIC_URL` |
| `COMPOSE_PROFILES`           | unset                    | `tunnel`                                        | Docker only, read by Compose: also start and update the `cloudflared` service                                                                                                                                                                                              |
| `FIRESIDE_TUNNEL_TOKEN_FILE` | `./secrets/tunnel-token` | a path                                          | Docker only, read by Compose: the file with the tunnel token, mode `0600`, owned by `FIRESIDE_UID`. `scripts/systemd/install.sh --tunnel` always reads `./secrets/tunnel-token`                                                                                            |

### Users

| Variable    | Default          | Values   | Meaning                                                                                                                                                 |
| ----------- | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_USERS` | unset (no limit) | 1–100000 | Most users this instance may have, disabled ones included. Checked when an admin creates an invite and when it is used (not by `pnpm cli users create`) |

### Time and storage

| Variable   | Default  | Values                           | Meaning                                                                                                                                                         |
| ---------- | -------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TZ`       | `UTC`    | an IANA name, e.g. `Europe/Oslo` | Time zone for days and weeks (screen time, weekly summaries, backup times). Offsets like `+01:00` are refused. Timestamps are stored in UTC                     |
| `DATA_DIR` | `./data` | a path                           | Folder for the database (`fireside.db`), the lock file and the two-factor key. Docker ignores it and uses `/data`: use `FIRESIDE_DATA_PATH` for the host folder |

### Backups

| Variable              | Default              | Values          | Meaning                                                                                                                                   |
| --------------------- | -------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKUP_DIR`          | `<DATA_DIR>/backups` | a path          | Folder for backups. Docker uses `/data/backups` (`data/backups` on the host)                                                              |
| `BACKUP_ENABLED`      | `true`               | `true`, `false` | Automatic backups while the server runs. `pnpm cli backup` works either way                                                               |
| `BACKUP_TIME`         | `04:00`              | `HH:MM`         | Time of the daily backup, in `TZ`                                                                                                         |
| `BACKUP_KEEP_DAILY`   | `7`                  | 0–1000          | Keep the newest backup of each of the last N days. `0` turns the level off                                                                |
| `BACKUP_KEEP_WEEKLY`  | `4`                  | 0–1000          | The same for ISO weeks (Monday to Sunday)                                                                                                 |
| `BACKUP_KEEP_MONTHLY` | `6`                  | 0–1000          | The same for months. The longest level that is on is also the maximum age of every file (see [Backups and restore](#backups-and-restore)) |

### Logging

| Variable    | Default | Values                                                       | Meaning                  |
| ----------- | ------- | ------------------------------------------------------------ | ------------------------ |
| `LOG_LEVEL` | `info`  | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` | How much the server logs |

### External sources

All off by default. Nothing is called until both the feature and
`USER_AGENT_CONTACT` are set. See
[Optional external sources](#optional-external-sources).

| Variable              | Default | Values                                | Meaning                                                                                                                                                      |
| --------------------- | ------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `USER_AGENT_CONTACT`  | unset   | an email address or URL, no spaces    | Contact for whoever runs this instance, sent as `Fireside/<version> (+<contact>)` in the User-Agent of every external call. Required for any external source |
| `PRICES_ENABLED`      | `false` | `true`, `false`                       | Fetch current Grand Exchange prices from the OSRS Wiki, at most once an hour                                                                                 |
| `RUNEPROFILE_ENABLED` | `false` | `true`, `false`                       | Fetch the collection log from RuneProfile for the accounts each owner turns it on for                                                                        |
| `RUNEPROFILE_API_KEY` | unset   | printable ASCII, up to 200 characters | Optional RuneProfile API key (ask in the RuneProfile Discord). Not needed. Keep it secret                                                                    |

### Docker settings

Read by Docker Compose from `.env` or your shell, not by the server.

| Variable               | Default          | Values                                        | Meaning                                                                                                                                                          |
| ---------------------- | ---------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIRESIDE_DATA_PATH`   | `./data`         | a path                                        | Host folder with the database, mounted at `/data`. Relative to `docker-compose.yml`. An existing database is used as is                                          |
| `FIRESIDE_PORT`        | `3100`           | 1–65535                                       | Port on `127.0.0.1` for the dashboard and the plugin. The only port variable Compose reads: in Docker, change this, not `PORT`                                   |
| `FIRESIDE_UID`         | `1000`           | a user ID                                     | User the server and `cloudflared` run as. Must own `FIRESIDE_DATA_PATH` and the token file                                                                       |
| `FIRESIDE_GID`         | `1000`           | a group ID                                    | Group the server and `cloudflared` run as                                                                                                                        |
| `COMPOSE_FILE`         | unset            | `docker-compose.yml:docker-compose.build.yml` | Read by Compose: build the image from the checkout instead of pulling the release ([Building the image yourself](#building-the-image-yourself))                  |
| `FIRESIDE_LOCAL_IMAGE` | `fireside:local` | an image tag                                  | Tag for the image built with `docker-compose.build.yml`. Give a second clone its own ([A second instance in another clone](#a-second-instance-in-another-clone)) |

## Local mode and login mode

Fireside starts in **local mode**: no login, and the dashboard only answers
on the machine it runs on. A request is refused with `403` unless it comes
from a loopback address (`127.0.0.1`, `::1`) with `Host` set to `localhost`,
`127.0.0.1` or `[::1]`, without any proxy header. Changes also need a
matching `Origin` if the browser sends one. You act as the admin.

As soon as any user has a password, the server is in **login mode**: the
dashboard asks for a username and password, also on that machine. It still
only answers on localhost, unless you set up [remote access](#remote-access).

```fish
pnpm cli users set-password admin     # turn login on (asks for the password)
pnpm cli users rename admin <name>    # pick your own username
pnpm cli users list
pnpm cli users clear-password <name>  # back to local mode (only with one user)
```

You can also set the first password under **Settings → Profile**. Passwords
are at least 12 characters. The CLI reads them from the terminal (or one per
line from stdin), never from arguments. With more than one user, the server
refuses to start unless at least one has a password.

The health check, the plugin's ingest (`/api/v1/ingest`, which needs an API
key) and the dashboard's static files are not behind this check. They hold no
data without a key.

**Sessions.** The login cookie is `Secure`. Chrome and Firefox keep it on
`http://localhost`; Safari may not, so use Chrome or Firefox there, or HTTPS.
A login lasts 30 days after you last used it, and at most 90 days in all.
A password change, a password reset and **Log out everywhere** end every
session.

**Login limits.** Failed logins are limited per IP (20, then a growing wait
up to 15 minutes) and per username (10). A browser you have fully logged in
from is remembered for a year and skips the per-username limit, so someone
guessing your password can't lock you out of a device you've used before. A
new browser (also a private window) can stay blocked as long as someone keeps
attacking your username: log in from a device you've used before, which also
clears the failures counted against your name. Limits are kept in memory and
forgotten an hour after the last failure, or on restart.

## Users and invites

Users only join by invite, in login mode. Every user's data is separate: a
user sees only their own OSRS accounts, and an admin sees other users'
names and API keys, not their game data. There is no ranking or comparison
between users.

**Before you invite anyone**, write who runs the instance and how to reach
you under **Settings → Server → Instance text**. It is shown without login on
`/about`, linked from the login page and the footer. Until you change it, a
default text describes what this server stores and for how long, built from
your settings, with `[your name]` and `[how to reach you]` placeholders.

**Inviting someone** (admin): **Settings → Users → Create invite**.

- A label (who it is for, only shown to admins), the role (Member or Admin),
  how long the link works (1, 7 or 30 days) and **Can create API keys**. The
  default for that switch is under **Settings → Server → New invites**.
- Copy the link and send it however you like. It works once. The secret part
  is after the `#`, so it never reaches a server log.
- At most 20 invites can be active at a time, and `MAX_USERS` limits the
  number of users.
- The person opens the link in a browser, picks a username and password, and
  is logged in.
- With `PUBLIC_URL` set, links use it. Without it, they use the address you
  opened the dashboard at and only work on this machine.

**Managing users** (admin, Settings → Users): rename, change role, allow or
block creating API keys (optionally revoking their active keys), disable
(ends their sessions; their keys stop working), turn off 2FA, create a
**password reset link** (works for 24 hours; asks for a 2FA code too if they
have 2FA), and delete. The last active admin can't be demoted, disabled or
deleted. Users can delete themselves under **Settings → Profile**. Deleting a
user removes all their data, including the raw events.

`pnpm cli users create <name> [--admin]` also creates a user (login mode
only) and asks for their password.

## API keys

The plugin authenticates with an API key. Keys start with `fs_`, are shown
once when created, and only a hash is stored.

- **Settings → API keys:** create your own key (in login mode only if you are
  allowed to), see when each one was last used, and revoke it.
- **Settings → Users** (admin): create a key for any user, and see and revoke
  everyone's keys. A key an admin revokes shows as "Revoked by admin" to its
  owner.
- **CLI:** `pnpm cli keys create <name> [--user <username>]`, `keys list`
  (every user's keys with owners) and `keys revoke <id>`. `--user` is needed
  when there are several users. The CLI isn't limited by the
  "Can create API keys" switch.

Each user can have at most 10 active keys. Make one key per computer, so you
can revoke one without touching the others.

A key only works for the plugin's endpoints under `/api/v1/ingest`: sending
events and icons, and checking the connection. It can't read your data or log
in to the dashboard. A revoked key, or the key of a disabled user, gets `401`
at once, and the plugin then stops sending and says so. Requests without a
valid key are limited per IP.

## Two-factor authentication

Two-factor authentication (2FA) is optional for every user and strongly
recommended for admins: **Settings → Profile → Two-factor authentication**.
Scan the QR code with an authenticator app, enter its code, and save the ten
recovery codes. Each recovery code logs you in once if you lose your phone.
Turning 2FA on and making new recovery codes log out your other browsers.

A remembered browser never skips the 2FA step: it only skips the
per-username login limit. A password reset link keeps 2FA on and asks for a
code too.

If someone loses both their phone and their recovery codes, an admin turns
2FA off under **Settings → Users**, or you run:

```fish
pnpm cli users reset-2fa <name>
```

### The two-factor key, `fireside.key`

The first time someone turns on 2FA, the server makes `DATA_DIR/fireside.key`
(in Docker: `data/fireside.key` on the host, next to the database). It
encrypts the 2FA secrets in the database and is **never in a backup**, so a
copy of the database or a backup alone can't make login codes.

> [!IMPORTANT]
> Keep a copy of `fireside.key` separately from the backups (once is enough,
> e.g. in your password manager). When you restore or move to another
> machine, put it back in `DATA_DIR` with mode `0600`. Without it, users with
> 2FA can't log in and their recovery codes don't work, until you turn 2FA
> off for them with `pnpm cli users reset-2fa <name>`. The server logs a
> warning for each of them when it starts.

## Autostart

Pick **one** way to run the server: Docker or a systemd user service. Both
restart it after a crash and start it again after a reboot.

### Docker

The container has `restart: unless-stopped`, so it comes back whenever the
Docker daemon starts. Enable that at boot:

```fish
sudo systemctl enable --now docker.service
```

`docker compose stop` or `down` keeps the container stopped after a reboot.
`docker compose up -d` brings it back.

### systemd

Build once, then install the service:

```fish
pnpm install
pnpm build
./scripts/systemd/install.sh
```

The script writes `~/.config/systemd/user/fireside.service` with absolute
paths (from `deploy/systemd/server.service.in`), then enables and starts it.
The service reads `.env`, runs `server/dist/index.js` with
`NODE_ENV=production`, restarts 5 seconds after a crash (not after a
configuration error or when another server holds the database), has
`UMask=0077`, and logs to the journal.

Options: `--print` shows the unit without installing it, `--no-enable` only
writes it, `--node <path>` uses a specific Node binary, and `--uninstall`
removes it. `--tunnel` does the same for the Cloudflare Tunnel service
([docs/tunnel.md](tunnel.md)).

```fish
systemctl --user status fireside
journalctl --user -u fireside -f
systemctl --user restart fireside
```

**Node from fnm.** fnm puts `node` on a temporary per-shell path that a
service can't see. So the unit doesn't store a Node path: each time it starts,
it asks fnm (`fnm exec --using=.node-version`) for the installed Node that
matches `.node-version`. A Node upgrade within that version is picked up on
the next restart, and it never runs a different major version than the one
`pnpm install` built the native modules for. If no matching version is
installed, the service stops with an error in the journal (run
`fnm install`). Without fnm, the script uses the `node` on your `PATH`.

**Start at boot, or at login.** A user service starts when you log in and
stops when you log out. To start it at boot and keep it running after you
log out, turn on lingering once:

```fish
loginctl enable-linger $USER    # undo: loginctl disable-linger $USER
```

**`pnpm dev` next to the service.** Both read the same `.env`, so give the
dev server its own folder and port. Variables set in the shell take
precedence over `.env`:

```fish
env DATA_DIR=./data-dev PORT=3101 pnpm dev
```

### One server per database

While a server runs, it holds a lock on `DATA_DIR/fireside.lock`. The
operating system releases it when the server stops, also after a crash, so
there is never a stale lock to remove. A second server on the same folder
(Docker, systemd or `pnpm dev`) exits with code 75 before it opens the
database, and says which server might be running.

`pnpm cli` (keys, users, rebuild, reprocess, backup) works while the server
runs. Without a server, the CLI holds the lock while it runs and applies
pending migrations. While a server runs, the CLI never migrates: if your
checkout expects a newer database version than the running server uses, it
refuses and asks you to stop the server first. `restore` and `pnpm seed` need
the folder to themselves.

## Backups and restore

While the server runs, it backs up the database every day at `BACKUP_TIME`
(default 04:00 in `TZ`), and when it starts if the newest backup is more than
24 hours old. Backups are safe while the plugin sends data (SQLite
`VACUUM INTO`, a consistent snapshot), and each one is checked with
`PRAGMA integrity_check`, and read back after compression, before it counts. **Settings → Server** shows the
last backup, how many are kept, and the last error if one failed.

Backups are gzipped and named `fireside-<YYYYMMDD>-<HHMMSS>Z.db.gz` (UTC) in
`BACKUP_DIR`, usually a quarter to a fifth of the database's size. Backups from
before compression (`fireside-<…>Z.db`) still count, age out the same way and
restore as before. While a backup is written it has a temporary name
(`.fireside-backup-….tmp`): a backup that is interrupted (a crash, a full disk)
never counts, and its temporary files are removed an hour later. When the
server stops during a backup, it waits up to 10 seconds for it to finish,
then stops it, and that backup doesn't count.

**Which ones are kept.** The newest backup of each of the last 7 days, 4 ISO
weeks and 6 months (`BACKUP_KEEP_*`), in `TZ`. The newest backup is always
kept. No file is kept longer than the longest level reaches (6 months by
default): not a backup taken by hand with `pnpm cli backup`, and not the
copies the server takes before a migration (`fireside-pre-migrate-….db`) or
a restore (`fireside-pre-restore-….db`). Other files in `BACKUP_DIR` are
never deleted.

Old files are removed after each backup and when the server starts. The age
counts only the time the server has run since the newest earlier backup, not
the wall clock, so a clock that jumps ahead can't wipe the folder. After the
server has been stopped for a while, old files go that much later. With every
`BACKUP_KEEP_*` at 0 only the newest backup is kept.

```fish
pnpm cli backup                                     # back up now (safe while the server runs)
pnpm cli restore data/backups/fireside-20261114-030000Z.db.gz
pnpm cli restore fireside-20261114-030000Z.db.gz    # a bare name is looked up in BACKUP_DIR
pnpm cli restore fireside-20261001-030000Z.db       # an older, uncompressed backup
```

A bare name without `.gz` finds the compressed backup too, so
`pnpm cli restore fireside-20261114-030000Z.db` also works.

**Opening a backup by hand.** A backup is an ordinary SQLite database in gzip.
Copy it out of `BACKUP_DIR`, unpack it with `-k` (keeps the `.gz`) and open
the copy read-only:

```fish
mkdir -p ~/fireside-inspect
cp data/backups/fireside-20261114-030000Z.db.gz ~/fireside-inspect/
gunzip -k ~/fireside-inspect/fireside-20261114-030000Z.db.gz
sqlite3 -readonly ~/fireside-inspect/fireside-20261114-030000Z.db
```

Don't unpack inside `BACKUP_DIR`: there the unpacked file has a backup's name,
and retention deletes it after the next backup (the `.gz` is kept). Settings →
Server doesn't count it as another backup. Delete the
copy when you are done; it holds everything the database does.

### Disk space

`DATA_DIR` and `BACKUP_DIR` are usually on the same disk (in Docker,
`data/backups` is inside `data`), so count them together.

- **During a backup**, the database is first copied uncompressed and then
  gzipped, and both exist for a moment: you need free space for about the
  size of the database plus its compressed copy (about 1.1–1.3 times the
  database). Afterwards only the compressed backup is left.
- **During a restore**, up to three database-sized files exist at once, next
  to the backup itself: the current database, the unpacked backup and the
  copy that becomes the new database; then the current database, that copy
  and the pre-restore copy of the current database. That is about three times
  the database's size in all, plus the compressed backup. All of it is
  written in `DATA_DIR` and `BACKUP_DIR`, never in `/tmp` (a RAM-backed tmpfs
  in Docker).

> [!TIP]
> On a small disk, check the free space before you restore (`df -h` on the
> folder that holds `DATA_DIR`). A restore that runs out of space changes
> nothing, but it is quicker to free space first, for example by moving old
> backups or `fireside-pre-*` copies elsewhere.

### Restore

Restore replaces the database with a backup:

1. Stop the server (Ctrl-C, `systemctl --user stop fireside`, or
   `docker compose stop`). Restore refuses while a server uses the same
   `DATA_DIR`.
2. Run `pnpm cli restore <file>`. In Docker:
   `docker compose run --rm fireside fireside restore <file>` (backups are
   in `/data/backups` in the container, so the file name is enough). It
   takes a compressed `.db.gz` backup or an older uncompressed `.db` one. It
   unpacks a compressed backup into `DATA_DIR` and checks it first and changes nothing if the file is damaged or
   comes from a newer Fireside version (upgrade first). A backup from an
   older version is migrated. The current database is kept as
   `fireside-pre-restore-<time>.db` in `BACKUP_DIR`, until it ages out like
   the other backups.
3. Start the server again.

If a restore is interrupted (Ctrl-C, a crash), nothing was changed unless it
said "Restored". Its temporary files in `DATA_DIR` (`.fireside.db.restore-…`)
are removed the next time the server starts or `pnpm cli` runs with the
server stopped.

If the restored database has users with 2FA, `fireside.key` must be in
`DATA_DIR` ([The two-factor key](#the-two-factor-key-firesidekey)).

### Copying backups elsewhere

> [!IMPORTANT]
> Backups on the same disk as the database do not protect against a disk
> failure. Copy `BACKUP_DIR` to another disk or machine as well.

- **Copy it regularly**, e.g. with a daily `rsync` or your normal backup
  tool. The backups and their folder are readable only by the user the
  server runs as (`0600` in a `0700` folder), so run the copy as that user.
  In Docker that is `FIRESIDE_UID`. Leave out the temporary files of a backup
  that is being written (`.fireside-backup-*`). The backups are already
  compressed, so compressing them again in transit (`rsync -z`) gains
  little. For example, as a daily user timer or cron job:

  ```sh
  rsync -a --delete --exclude '.fireside-backup-*' ~/fireside/data/backups/ /mnt/backup-disk/fireside/
  ```

- **Or put `BACKUP_DIR` on another disk.** Without Docker, set `BACKUP_DIR`
  in `.env`. In Docker, mount the disk at `/data/backups` in a
  `docker-compose.override.yml` (the folder must be writable by
  `FIRESIDE_UID`):

  ```yaml
  services:
    fireside:
      volumes:
        - /mnt/backup-disk/fireside:/data/backups
  ```

Keep `fireside.key` separately, not with the copied backups.

## Upgrading

Take a backup first (`pnpm cli backup`). Then:

- **Docker:** `git pull` (it brings the new image tag in
  `docker-compose.yml`), then `docker compose pull` and `docker compose up -d`.
  With the tunnel profile on, `pull` also fetches a new `cloudflared` image
  ([docs/tunnel.md](tunnel.md#7-updating)). If you
  [build the image yourself](#building-the-image-yourself):
  `git pull`, `docker compose pull --ignore-buildable` (for `cloudflared`),
  then `docker compose up -d --build`.
- **systemd:** `git pull`, `pnpm install`, `pnpm build`, then
  `systemctl --user restart fireside`. Run `install.sh` again only if you
  move the repo.

When a new version needs database changes, the server first copies the
database to `fireside-pre-migrate-<time>.db` in `BACKUP_DIR` (and stops if
that fails), then applies all pending migrations in one transaction. A
database from a newer Fireside version is refused ("Is the database from a
newer version?"): restore a backup from before the downgrade, or upgrade
again.

When a new version changes how existing data is derived (for example, how AFK
time is counted), the server recomputes it at the same startup, after the
migrations and in the same transaction. The copy before migrating is taken
first. There is no manual step. That start takes a little longer, and the log
says "Recomputed projections after a rule change" with the time it took. The
plugin retries anything it sends meanwhile.

## Moving to another machine

1. **On the old machine, take a fresh backup** while the server runs:
   `pnpm cli backup` (Docker: `docker compose exec fireside fireside backup`).
2. **Stop the server** (and the tunnel, if you use one).
3. **Copy to the new machine:** that backup (`fireside-….db.gz`), `fireside.key` from `DATA_DIR`
   (if anyone uses 2FA), `.env` and, with the tunnel, `secrets/tunnel-token`.
   Keep them `0600` and owned by the user that runs Fireside there.
4. **On the new machine:** install Fireside as above, put `fireside.key` in
   the data folder, and restore the backup ([Restore](#restore)). Then start
   the server.
5. **Plugins:** with a tunnel, the address stays the same and nobody changes
   anything ([docs/tunnel.md](tunnel.md#8-moving-to-another-machine)).
   Otherwise, change the plugin's server URL. Data sent in the meantime waits
   in the plugin's queue.

## Remote access

By default the dashboard and the plugin only work on the machine the server
runs on.

**Cloudflare Tunnel** is the supported way to reach the dashboard from
outside: from your phone, or for friends whose plugins send data to your
server. `cloudflared` on the same machine connects out to Cloudflare, so no
ports are opened on your router and the server keeps listening on
`127.0.0.1`. You need a domain on Cloudflare (the free plan is enough), login
mode and 2FA for the admin. The dashboard is then on the public internet,
protected by the login, and Cloudflare can see the traffic. The full guide is
in [docs/tunnel.md](tunnel.md).

**Tailscale Serve is not supported yet.** `tailscale serve` forwards requests
with its own `Host` and `X-Forwarded-*` and `Tailscale-*` headers, which the
dashboard refuses (`403`). The plugin's ingest isn't behind that check, so a
plugin can send data through `tailscale serve`, but every request then comes
from `127.0.0.1` as far as the server knows, so the limit for requests
without a valid key is shared by all of them. Don't set `HOST` to a Tailscale
address either: that makes the server listen beyond loopback, which the
dashboard refuses anyway.

## Installing on a phone

The dashboard can be installed as an app on your home screen. It opens
without the browser's address bar, with the Fireside icon. A phone only
offers this over HTTPS, so it works once the server is reachable through the
tunnel ([Remote access](#remote-access)). On a computer, Chrome also offers
it on `http://localhost`.

- **Android (Chrome):** open the dashboard, then menu (⋮) → _Install app_ (or
  _Add to home screen_ → _Install_).
- **iPhone and iPad (Safari):** open the dashboard, then Share → _Add to Home
  Screen_.

If you were invited, **create your account from the invite link first**, in
the phone's browser, and install the app afterwards. Invite and password
reset links always open in the browser, not in the installed app. The app
keeps nothing for offline use: there is no service worker, and the server
tells the browser never to store its data responses, so your data isn't left
on the phone after you log out.

## Optional external sources

Fireside works without internet access. Everything that calls out is off by
default, and nothing is called until **both** the feature and a contact are
set in `.env`:

```sh
USER_AGENT_CONTACT=you@example.com   # sent in the User-Agent of every call
PRICES_ENABLED=true
```

- **`PRICES_ENABLED`** fetches current Grand Exchange prices from the
  [OSRS Wiki](https://oldschool.runescape.wiki/w/RuneScape:Real-time_Prices):
  one request for all items, at most once an hour. The bank and the net worth
  are then valued at current prices. Bank history, loot and raid drops keep
  the prices from when they happened. Items the wiki has no price for keep the
  price the plugin recorded. If a fetch fails, the last prices are kept.
- **`RUNEPROFILE_ENABLED`** fetches the collection log from
  [RuneProfile](https://runeprofile.com) for the accounts their owners turn
  it on for under **Settings → OSRS accounts**, by the account's current
  name. It needs the RuneProfile plugin in RuneLite, and **a RuneProfile
  profile is public**: anyone can see its collection log, quests and diaries.
  It syncs a couple of minutes after a session ends, every six hours and with
  **Sync now**, never more than once a minute per account. Turning it off for
  an account stops the lookups and keeps what was fetched.

**Settings → Server** shows each source, its last fetch and its last error.
What each call sends is in
[What data Fireside collects](data-collected.md#external-services).
