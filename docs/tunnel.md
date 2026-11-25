# Remote access with Cloudflare Tunnel

This guide makes your Fireside dashboard reachable from anywhere, at an
address like `https://dashboard.example.com`, so you can use it on your phone and
invite friends whose plugins send data to your server. You don't need to open
any ports on your router, and your friends don't install anything except the
plugin.

**How it works.** A small program from Cloudflare, `cloudflared`, runs on the
same machine as Fireside. It connects _out_ to Cloudflare and keeps that
connection open. When someone opens `https://dashboard.example.com`, Cloudflare
sends the request down that connection, and `cloudflared` passes it to
Fireside at `http://127.0.0.1:3100`. Fireside itself still only listens on
`127.0.0.1`: nothing on your network or the internet can reach it directly.

**What this means.** Your dashboard is then on the public internet, and the
login is what protects it. Cloudflare can see the traffic (it decrypts HTTPS
at its edge); the default instance text on `/about` says so. Take the
prerequisites below seriously.

The example throughout is the domain `example.com`, with the dashboard at
`dashboard.example.com`. Use your own domain wherever you see it. Commands are for the fish shell; they work the same in bash unless noted.

**Contents**

1. [Before you start](#1-before-you-start)
2. [Create the tunnel](#2-create-the-tunnel)
3. [Turn it on](#3-turn-it-on)
4. [Cloudflare settings](#4-cloudflare-settings)
5. [Check it](#5-check-it)
6. [Invite a friend](#6-invite-a-friend)
7. [Updating](#7-updating)
8. [Moving to another machine](#8-moving-to-another-machine)
9. [Turning it off](#9-turning-it-off)
10. [Troubleshooting](#10-troubleshooting)
11. [Sources](#sources)

## 1. Before you start

- **A domain on Cloudflare, free plan.** Everything here works on the Free
  plan.
  - Bought from Cloudflare Registrar? It's already there. Skip ahead.
  - Registered somewhere else? In the
    [Cloudflare dashboard](https://dash.cloudflare.com): **Domains → Onboard
    a domain**, enter the domain (`example.com`, not `dashboard.example.com`),
    choose the **Free** plan, and Cloudflare shows you two nameservers. Set
    those as the domain's nameservers at your registrar (turn DNSSEC off there
    first if it's on). The domain is active on Cloudflare once the change has
    spread, usually within a few hours
    ([Add a site](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/)).
- **Fireside running and healthy** on this machine, with Docker
  (`docker compose ps` says `healthy`) or as the systemd service
  ([Autostart](self-hosting.md#autostart)).
- **Login mode, with two-factor authentication for the admin.** Set a password
  ([Local mode and login mode](self-hosting.md#local-mode-and-login-mode)),
  log in, then Settings → Profile → Two-factor authentication. Without a
  password, Fireside is in local mode: the dashboard answers `403` to every
  request through the tunnel, and with `TRUSTED_PROXY` set the server warns
  about it at startup. The plugin's ingest (`/api/v1/ingest`), the health check
  and the dashboard's static files are not behind that check, so they would
  still answer through the tunnel: turn login mode on first.
- **The instance text filled in:** Settings → Server → Instance text.
  Your friends see it on `/about` before they create an account. Replace every
  `[placeholder]` with what's true for your instance.
- For running without Docker: `cloudflared` **2025.4.0 or newer** (it reads
  the token from a file). On Arch: `pacman -S cloudflared`. Other systems:
  [Downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).
  You only need the program; don't run `cloudflared service install` (see
  [step 3](#3-turn-it-on)).

## 2. Create the tunnel

A _remotely managed_ tunnel keeps its settings in the Cloudflare dashboard.
All `cloudflared` needs on your machine is a token
([Create a tunnel (dashboard)](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)).

1. In the Cloudflare dashboard: **Networking → Tunnels → Create a tunnel**.
   Give it a name (e.g. `fireside`) and select **Create Tunnel**.
2. Cloudflare shows install commands for different systems. **Don't run
   them.** Each one contains the token: the long string that starts with
   `eyJ`. Copy just that string.
3. Save it in a file only you can read, in the Fireside folder. Run these from
   the Fireside folder, paste the token at the empty line, press Enter, then
   Ctrl-D:

   ```fish
   install -d -m 700 secrets
   install -m 600 /dev/stdin secrets/tunnel-token
   ```

   This keeps the token out of your shell history. The newline after the token
   is fine: `cloudflared` ignores spaces and newlines around it. The file must
   belong to the user Fireside runs as (`FIRESIDE_UID` in Docker, default
   1000; check with `ls -l secrets/tunnel-token`). Never put the token in
   `.env`, a chat, an issue or a commit: anyone with it can run your tunnel.
   `secrets/` is in `.gitignore`.

4. Leave the Cloudflare page open. Its **Continue** button can't be selected
   until `cloudflared` is connected, which happens in
   [step 3](#3-turn-it-on); you add the route after that. (If you close the
   page, the tunnel is still listed under **Networking → Tunnels**.)

## 3. Turn it on

**Tell Fireside about the tunnel.** Add to `.env`:

```sh
PUBLIC_URL=https://dashboard.example.com
TRUSTED_PROXY=cloudflare
```

`PUBLIC_URL` is the address people use; Fireside builds invite links from it
and only answers that host through the tunnel. `TRUSTED_PROXY=cloudflare`
lets requests through the tunnel in, and reads the visitor's real IP address
from Cloudflare (for the login limits and the log of security events).

Run `cloudflared` **one way only**: with Docker or as the systemd service,
never both. Two copies with the same token both connect and Cloudflare splits
the traffic between them, and they would both want the metrics port
`127.0.0.1:20241`, so the second keeps restarting. When you switch from one
to the other, turn the old one off first ([step 9](#9-turning-it-off)).

### With Docker

Also add to `.env`:

```sh
COMPOSE_PROFILES=tunnel
```

The `cloudflared` service in `docker-compose.yml` is behind the profile
`tunnel`, so it never runs unless you ask for it. With `COMPOSE_PROFILES` in
`.env`, the usual Compose commands include it, so it is started and updated
along with Fireside. Then:

```fish
docker compose up -d
docker compose ps                       # both fireside and cloudflared: healthy
docker compose logs cloudflared         # look for "Registered tunnel connection"
```

If the token file isn't in `secrets/tunnel-token`, set
`FIRESIDE_TUNNEL_TOKEN_FILE` in `.env` to its path. The container runs as
`FIRESIDE_UID`, so that user must own the file.

What the service does (see the comments in `docker-compose.yml`): host
networking like Fireside, so the tunnel reaches it on `127.0.0.1`; the image
is pinned to a version and digest, and Dependabot updates it; it runs as your
user with no privileges and a read-only file system; it reads the token from
the file (never from an environment variable, which `docker inspect` would
show); its metrics stay on `127.0.0.1:20241`; it starts once Fireside is
healthy; and it never updates itself.

### Without Docker

Restart Fireside so it reads `.env` (`systemctl --user restart fireside`),
then install the tunnel as a second systemd user service next to it:

```fish
scripts/systemd/install.sh --tunnel
journalctl --user -u fireside-tunnel -n 20   # look for "Registered tunnel connection"
```

The script writes `~/.config/systemd/user/fireside-tunnel.service`, enables it
and starts it. It checks that `cloudflared` is 2025.4.0 or newer and that
`secrets/tunnel-token` is yours with mode `600`. Other options:
`--tunnel --print` (show the unit, change nothing), `--tunnel --no-enable`,
`--tunnel --uninstall`, and `--cloudflared <path>` for a `cloudflared` that
isn't on your `PATH`. Like the Fireside service it starts when you log in,
or at boot with `loginctl enable-linger`.

Why not `cloudflared service install`: it installs a system service that runs
as root and keeps its own copy of the token under `/etc`. A user service with
the token in one file you own is enough.

**Check the log.** Fireside must not print
`TRUSTED_PROXY is set, but no user has a password` at startup. If it does,
set a password first (step 1).

### Add the route

Once `cloudflared` is connected, the tunnel shows as healthy in the
Cloudflare dashboard and the wizard's **Continue** works (or open the tunnel
from **Networking → Tunnels**). On the **Routes** tab: **Add route →
Published application**:

- **Subdomain:** `dashboard`
- **Domain:** `example.com` (your domain)
- **Service URL:** `http://127.0.0.1:3100` (your `FIRESIDE_PORT` or `PORT`).
  Use `127.0.0.1`, not `localhost`.

Then **Add route**. Cloudflare creates the DNS record for
`dashboard.example.com` itself. Check that:

- the route is in the tunnel's route list, and
- `cloudflared` got it: `docker compose logs cloudflared` (without Docker:
  `journalctl --user -u fireside-tunnel`) shows a line with
  `Updated to new configuration` that contains `dashboard.example.com`.

If `curl` or the browser then says the name can't be found, see
[Troubleshooting](#10-troubleshooting).

## 4. Cloudflare settings

All of these are on the Free plan. Paths are in the
[Cloudflare dashboard](https://dash.cloudflare.com) with your domain selected.
Cloudflare moves menus around now and then: if a path doesn't match, search
for the setting's name in the dashboard.

### Always Use HTTPS

**Why:** a visitor who types `http://dashboard.example.com` is redirected to
https instead of sending their login cookie and password unencrypted. Fireside
also sets HSTS through the tunnel, so browsers remember to use https.

**Where:** SSL/TLS → Edge Certificates → **Always Use HTTPS**: on. (The
SSL/TLS encryption mode on SSL/TLS → Overview must not be _Off_; the tunnel
itself is encrypted either way.)
[Docs](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)

### Minimum TLS version 1.2

**Why:** TLS 1.0 and 1.1 are outdated and insecure. Every current browser and
RuneLite's Java use 1.2 or 1.3.

**Where:** SSL/TLS → Edge Certificates → **Minimum TLS Version**: TLS 1.2.
[Docs](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/)

### Leave Cloudflare's HSTS off

**Why:** Fireside sends its own `Strict-Transport-Security` header, only for
the dashboard's host and never with `includeSubDomains` or `preload`, so the
rest of your domain is free to do what it likes. Cloudflare's HSTS setting
would apply to the whole domain and can add those flags, and `preload` can't
be undone.

**Where:** SSL/TLS → Edge Certificates → **HTTP Strict Transport Security
(HSTS)**: leave it disabled.

### Don't cache the API

**Why:** API responses hold your data. Fireside already marks them
`Cache-Control: no-store` (found icons `private` for a day, which Cloudflare
never stores), and Cloudflare doesn't
cache JSON by default, but a rule makes sure no setting elsewhere changes
that.

**Where:** Caching → Cache Rules → **Create rule**
([how](https://developers.cloudflare.com/cache/how-to/cache-rules/create-dashboard/)):

- Rule name: `Never cache the API`
- If incoming requests match: **Custom filter expression**, Field **URI
  Path**, Operator **starts with**, Value `/api/`
  (expression: `starts_with(http.request.uri.path, "/api/")`)
- Cache eligibility: **Bypass cache**

[Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/) ·
[Default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)

### Rate limit logins

**Why:** a second limit in front of the server, so a single IP that hammers
the login form is turned away at Cloudflare instead of reaching your machine.
It covers the four requests a visitor who isn't logged in can repeat to guess:
logging in, the 2FA step, accepting an invite and using a password reset link.

**What the Free plan allows:** one rate limiting rule; the expression can
only use the path (and Verified Bot); requests are counted per IP, and each
Cloudflare data center keeps its own count; the period is 10 seconds and a
blocked IP is blocked for 10 seconds
([availability](https://developers.cloudflare.com/waf/rate-limiting-rules/#availability),
[how counting works](https://developers.cloudflare.com/learning-paths/application-security/rate-limiting/configurations/),
[create a rule](https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/)).

**Where:** Security → Security rules → **Create rule → Rate limiting rule**:

- Rule name: `Logins`
- If incoming requests match: four rows joined with **Or**, each Field **URI
  Path**, Operator **equals**, with the values `/api/v1/auth/login`,
  `/api/v1/auth/login/totp`, `/api/v1/auth/invite/accept` and
  `/api/v1/auth/password-reset`. If the builder offers **is in**, one row
  with all four values is the same. In the expression editor that is:

  ```
  (http.request.uri.path in {"/api/v1/auth/login" "/api/v1/auth/login/totp" "/api/v1/auth/invite/accept" "/api/v1/auth/password-reset"})
  ```

- With the same characteristics: **IP**
- When rate exceeds: **10** requests per **10 seconds**
- Then take action: **Block**, for **10 seconds**

**Why these numbers.** A real login takes one or two of these requests (two
with 2FA), so 10 in 10 seconds never hits a person, even one who mistypes a
few times. It leaves out `/api/v1/auth/me`, which every page load calls. One
IP reaching one data center can then send at most about 30 password checks a
minute (10, then 10 seconds blocked). Fireside checks four passwords at a time
and lets at most 64 wait (then `503`), and it has its own limits: 20 failed
logins per IP, then a growing wait up to 15 minutes, and 10 per username from
devices it doesn't know.

**What it can't do.** The rule counts per IP, and separately in each
Cloudflare data center, so a distributed attacker gets a fresh bucket for
every address and every data center it reaches. It does little against an
attacker with thousands of addresses. Against that,
Fireside's own limit per username is what protects a password, and a browser
you've logged in from before is never locked out. Measured on a laptop,
Fireside checks about 300 passwords a second; a small ARM board is much
slower, and this rule matters more there.

### Let the plugin through: Browser Integrity Check off for ingest

**Why:** Browser Integrity Check blocks requests whose headers look like a
bot's rather than a browser's. The RuneLite plugin is not a browser, so turn
it off for the plugin's paths (and only there).

Configuration Rules are on the Free plan (10 rules).

**Where:** Rules → Overview → **Create rule → Configuration Rule**:

- Rule name: `Plugin: no browser check`
- Field **URI Path**, Operator **starts with**, Value `/api/v1/ingest`
  (expression: `starts_with(http.request.uri.path, "/api/v1/ingest")`)
- Then the settings are: **Browser Integrity Check** → Off

Leave Browser Integrity Check on everywhere else: it does no harm to
browsers, and the rule only exempts the plugin's paths.

[Configuration Rules](https://developers.cloudflare.com/rules/configuration-rules/) ·
[create one](https://developers.cloudflare.com/rules/configuration-rules/create-dashboard/) ·
[settings](https://developers.cloudflare.com/rules/configuration-rules/settings/) ·
[Browser Integrity Check](https://developers.cloudflare.com/waf/tools/browser-integrity-check/)

### Bot Fight Mode off

**Why:** Bot Fight Mode challenges traffic that looks automated, and
Cloudflare says it "may challenge API or mobile app traffic": your friends'
plugins would stop sending. On the Free plan it can't be turned off for a
single path ("You cannot bypass or skip Bot Fight Mode using WAF custom rules
or Page Rules"), so it has to be off for the whole domain. It also injects a
script into every page (JavaScript Detections), which Fireside's content
security policy blocks anyway.

**Where:** Security → Settings, filter **Bot traffic** → **Bot Fight Mode**:
off.
[Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/) ·
[JavaScript Detections](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/)

### Turn off features that change your pages

**Why:** some Cloudflare features rewrite the HTML on its way to the browser
by adding scripts, links or styles. Fireside's content security policy only
allows its own scripts, so injected scripts are blocked and show up as errors
in the browser console, and a page that was changed in transit is harder to
reason about. Web Analytics also sends data about your visitors to Cloudflare.
Fireside works without any of them. Turn off each one that is on:

| Feature                       | What it changes                                                                | Where to turn it off                                                                                      | Docs                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Rocket Loader**             | Rewrites every script tag so Cloudflare's loader runs them                     | Speed → Settings → Content Optimization → Rocket Loader                                                   | [Rocket Loader](https://developers.cloudflare.com/speed/optimization/content/rocket-loader/)                            |
| **Email Address Obfuscation** | Replaces email addresses (e.g. in the instance text) and adds a decode script  | Security → Settings, filter Client-side abuse → Email Address Obfuscation (on by default for new domains) | [Email Address Obfuscation](https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/)       |
| **Web Analytics**             | Adds Cloudflare's analytics beacon to every page (on by default for new sites) | Account home → Web Analytics → your site → Manage site → automatic setup: **Disable**                     | [Web Analytics](https://developers.cloudflare.com/web-analytics/get-started/)                                           |
| **AI Labyrinth**              | Adds invisible links to your pages that lead AI crawlers into generated pages  | Security → Settings, filter Bot traffic → AI Labyrinth                                                    | [AI Labyrinth](https://developers.cloudflare.com/bots/additional-configurations/ai-labyrinth/)                          |
| **Cloudflare Fonts**          | Replaces Google Fonts links with inline CSS (Fireside has none; keep it off)   | Speed → Settings → Content Optimization → Cloudflare Fonts                                                | [Cloudflare Fonts](https://developers.cloudflare.com/speed/optimization/content/fonts/)                                 |
| **Zaraz**                     | Adds its script to every page once you set it up for the domain                | Don't set it up for this domain. If you did, remove its tools in Zaraz (account home → Zaraz → Tag setup) | [Zaraz](https://developers.cloudflare.com/zaraz/)                                                                       |
| **JavaScript Detections**     | Adds a challenge script to every page                                          | Comes with Bot Fight Mode; off once Bot Fight Mode is off (above)                                         | [JavaScript Detections](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/) |
| **Speed Brain**               | A `Speculation-Rules` header (not HTML) that makes browsers prefetch links     | Speed → Settings → Content Optimization → Speed Brain (on by default; optional, off keeps things simple)  | [Speed Brain](https://developers.cloudflare.com/speed/optimization/content/speed-brain/)                                |

Automatic HTTPS Rewrites (SSL/TLS → Edge Certificates) only changes `http://`
links to `https://`; Fireside's pages have none, so it can stay as it is.
Hotlink Protection doesn't change pages either.

**How to tell:** after turning the tunnel on, open the dashboard through the
tunnel with the browser's developer tools (Console). There must be no
"Content Security Policy" errors. The page source at `https://dashboard.example.com/`
should look the same as at `http://127.0.0.1:3100/`.

### Optional: Cloudflare Access

Cloudflare Access can put an email code in front of the dashboard, before
anyone even sees the login page. It isn't the default because it means
logging in twice. If you use it, exclude `/api/v1/ingest*`: the plugin can
only send its API key.

## 5. Check it

Do these once, after the settings above.

**Fireside and cloudflared only listen on loopback:**

```fish
ss -tlnp | grep -E ':3100|:20241'
```

Every line must show `127.0.0.1:3100` or `127.0.0.1:20241`, never `0.0.0.0`,
`*` or your LAN address. (20241 is `cloudflared`'s metrics.)

**Port 3100 is not reachable from outside.** From another computer on your
network (use your machine's LAN address, e.g. from `ip -brief address`):

```fish
curl --max-time 5 http://192.168.1.20:3100/api/v1/health
```

must fail ("Connection refused" or a timeout). From a phone on mobile data
(Wi-Fi off), opening `http://<your public IP>:3100` must fail too.

**HSTS through the tunnel, not on localhost:**

```fish
curl -sI https://dashboard.example.com/ | grep -i strict-transport-security
curl -sI http://127.0.0.1:3100/ | grep -i strict-transport-security
```

The first prints `strict-transport-security: max-age=31536000` (no
`includeSubDomains`, no `preload`). The second prints nothing.

**http goes to https:** `curl -sI http://dashboard.example.com/` answers `301`
with `location: https://dashboard.example.com/`.

**From a phone on mobile data:** open `https://dashboard.example.com`, log in
with your password and 2FA code, look around, and log out. Then install the
app ([Installing on a phone](self-hosting.md#installing-on-a-phone)).

**The plugin:** in RuneLite, set the plugin's server URL to
`https://dashboard.example.com` and use **Test connection**.

## 6. Invite a friend

1. **Settings → Users → Create invite** (admin only). Choose how long the
   link works and whether they may make their own API keys, then copy the
   link and send it to your friend however you like. It works once.
2. Your friend opens the link in a browser, picks a username and password, and
   is logged in. They should turn on 2FA (Settings → Profile).
3. They need an API key for their plugin: either they make one under
   Settings → API keys (if you allowed it in the invite), or you make one for
   them under Settings → Users (their API keys).
4. In RuneLite, in the Fireside plugin's settings, they enter:
   - **Server URL:** `https://dashboard.example.com` (no `/api/v1`)
   - **API key:** their own key, never yours
   - and turn on sending. **Test connection** should say it's connected.

Each person's data is separate: they see only their own accounts, and you see
only yours.

**Always `https://`.** The plugin warns when the URL is plain `http://` to
another machine, because the API key would travel unencrypted. Behind the
tunnel it wouldn't work anyway: Cloudflare redirects http to https (Always
Use HTTPS), and the plugin doesn't follow redirects, so its key is never sent
anywhere else.

## 7. Updating

With `COMPOSE_PROFILES=tunnel` in `.env`, the usual update covers the tunnel
too:

```fish
git pull
docker compose pull      # the new Fireside and cloudflared images, if the pins changed
docker compose up -d
```

The `cloudflared` version is pinned in `docker-compose.yml` (version and
digest), so it only changes when you pull a new version of Fireside. If you
[build the Fireside image yourself](self-hosting.md#building-the-image-yourself),
use `docker compose pull --ignore-buildable` (it skips the image that is
built locally; without it `pull` stops with "pull access denied for
fireside") and `docker compose up -d --build`.

Without Docker, update `cloudflared` with your system's packages (e.g.
`pacman -Syu`), then `systemctl --user restart fireside-tunnel`.

## 8. Moving to another machine

The address stays the same, so nobody else changes anything: your friends'
plugins and their bookmarks keep working.

1. **Take a fresh backup** on the old machine while it still runs
   (`docker compose exec fireside fireside backup`, or `pnpm cli backup`) and
   copy it to the new one
   ([Backups and restore](self-hosting.md#backups-and-restore)).
2. **Stop Fireside and the tunnel on the old machine.** Two `cloudflared` with
   the same token both connect, and Cloudflare splits the traffic between
   them. Docker: `docker compose stop` (stops both services). Without Docker:
   `systemctl --user stop fireside-tunnel fireside`. Data the plugins send
   after the backup waits in their queues and arrives once the new machine is
   up.
3. **Copy `fireside.key` separately** from `data/` (it exists once someone has
   turned on 2FA, and is never in a backup). Without it, nobody with 2FA can
   log in. Keep it `0600`.
4. **Copy `.env` and `secrets/tunnel-token`** (keep `0600`, owned by the user
   that runs Fireside there).
5. On the new machine: set up Fireside as usual, put `fireside.key` in the
   data folder, restore the backup (Docker: `docker compose run --rm fireside
fireside restore <file>`; without Docker: `pnpm cli restore <file>`), and
   start everything as in [step 3](#3-turn-it-on). If the port changes, edit
   the route's Service URL in the Cloudflare dashboard.
6. Run [the checks](#5-check-it) again on the new machine.

## 9. Turning it off

1. **Stop the tunnel.**
   - Docker: `docker compose stop cloudflared` and
     `docker compose rm -f cloudflared`, then remove `COMPOSE_PROFILES=tunnel`
     from `.env` (otherwise the next `docker compose up -d` starts it again).
   - Without Docker: `scripts/systemd/install.sh --tunnel --uninstall`.
2. **Remove `TRUSTED_PROXY` and `PUBLIC_URL` from `.env`** and restart
   Fireside (`docker compose up -d`, or `systemctl --user restart fireside`).
   Without them the dashboard's API refuses every request with proxy headers again.
3. **Optional, in Cloudflare:** delete the route or the whole tunnel under
   Networking → Tunnels. Deleting the tunnel makes the token useless, so you
   can then delete `secrets/tunnel-token`.

**If the token leaked:** Networking → Tunnels → your tunnel → **Rotate
token**, put the new token in `secrets/tunnel-token` as in
[step 2](#2-create-the-tunnel), and restart `cloudflared`. Connections that
already use the old token stay up until they restart
([Tunnel tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/)).

Your data stays as it is, and everyone can use the dashboard again once it's
back on (or on the server's own machine in the meantime).

## 10. Troubleshooting

**"Could not resolve host" (or the browser can't find the site) right after
adding the route.** The name exists, but your computer asked for it before
Cloudflare created it, and its DNS cache remembers that it didn't exist.
Check that the record is there:

```fish
dig +short dashboard.example.com @1.1.1.1
```

If that prints addresses, only your local cache is behind. Either:

- flush the system cache: `resolvectl flush-caches` (with systemd-resolved),
- clear the browser's own cache: `chrome://net-internals/#dns` → **Clear host
  cache** in Chrome, `about:networking#dns` → **Clear DNS Cache** in Firefox,
- or wait a while (up to the cache's lifetime for a missing name).

A phone on mobile data (Wi-Fi off) uses other DNS servers and works at once.

**`403` "The dashboard is only available on localhost" through the tunnel.**
Check that `.env` has both `PUBLIC_URL` (exactly the address you open, with
`https://`) and `TRUSTED_PROXY=cloudflare`, that a user has a password (login
mode), and that you restarted Fireside after changing `.env`. Without
`TRUSTED_PROXY`, Cloudflare's headers are refused.

## Sources

Checked against Cloudflare's documentation on 19 November 2026, and against
`cloudflared` 2026.11.1:

- [Run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/)
  (`--token-file` since 2025.4.0, `--no-autoupdate`, `--loglevel`) and
  [Tunnel metrics](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/metrics/)
  (in a container the metrics listen on `0.0.0.0` by default, so Fireside sets `127.0.0.1`)
- [Create a tunnel (dashboard)](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/),
  [Tunnel tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/),
  [Downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
- [Add a site](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/)
- [Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/),
  [Minimum TLS Version](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/),
  [Automatic HTTPS Rewrites](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/automatic-https-rewrites/)
- [Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/),
  [Default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)
- [Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/),
  [parameters](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/)
  and [rate limiting configurations](https://developers.cloudflare.com/learning-paths/application-security/rate-limiting/configurations/)
  (counts per data center)
- [Configuration Rules](https://developers.cloudflare.com/rules/configuration-rules/)
  (on the Free plan, 10 rules) and their [settings](https://developers.cloudflare.com/rules/configuration-rules/settings/),
  [Browser Integrity Check](https://developers.cloudflare.com/waf/tools/browser-integrity-check/)
- [Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/),
  [JavaScript Detections](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/),
  [AI Labyrinth](https://developers.cloudflare.com/bots/additional-configurations/ai-labyrinth/)
- [Rocket Loader](https://developers.cloudflare.com/speed/optimization/content/rocket-loader/),
  [Email Address Obfuscation](https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/),
  [Web Analytics](https://developers.cloudflare.com/web-analytics/get-started/),
  [Cloudflare Fonts](https://developers.cloudflare.com/speed/optimization/content/fonts/),
  [Zaraz](https://developers.cloudflare.com/zaraz/),
  [Speed Brain](https://developers.cloudflare.com/speed/optimization/content/speed-brain/)
