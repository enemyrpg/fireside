# API

An overview of the HTTP API: the endpoint groups, how requests are
authenticated, who may call what, the error format and how the API is
versioned. Request and response shapes are not repeated here. They are
defined once, as Zod schemas in [`shared/src/schemas/`](../shared/src/schemas/),
and published as JSON Schemas in the [contract package](#schemas).

Everything is under `/api/v1` on the same origin as the dashboard. Request and
response bodies are JSON. All timestamps are UTC ISO 8601 with milliseconds
(`2026-11-08T19:42:13.512Z`). Local dates and weeks (`2026-11-09`, `2026-W45`)
are in the server's `TZ`.

## Contents

- [Endpoint groups](#endpoint-groups)
- [Authentication](#authentication)
- [Access levels](#access-levels)
- [Errors](#errors)
- [Rate limits](#rate-limits)
- [Caching](#caching)
- [Versioning](#versioning)
- [Schemas](#schemas)

## Endpoint groups

`:accountId` is an account ID or `all` (all of the logged-in user's
accounts). The Zod file has the request and response schemas of each group.

| Group                       | Endpoints                                                                                                                                                                       | Access        | Schemas                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Health                      | `GET /health`                                                                                                                                                                   | none          | [`health.ts`](../shared/src/schemas/api/health.ts)                                                                                                           |
| Plugin (ingest)             | `GET /ingest/verify`, `POST /ingest`, `POST /ingest/icons/wanted`, `POST /ingest/icons`                                                                                         | API key       | [`ingest.ts`](../shared/src/schemas/api/ingest.ts), [`icons.ts`](../shared/src/schemas/api/icons.ts), events: [`events.ts`](../shared/src/schemas/events.ts) |
| About the instance          | `GET /about`                                                                                                                                                                    | public        | [`about.ts`](../shared/src/schemas/api/about.ts)                                                                                                             |
| Login and sessions          | `GET /auth/me`, `POST /auth/login`, `POST /auth/login/totp`, `POST /auth/logout`, `POST /auth/logout-all`, `POST /auth/password`, `POST /auth/delete-account`                   | public / user | [`auth.ts`](../shared/src/schemas/api/auth.ts)                                                                                                               |
| Two-factor                  | `GET /auth/totp`, `POST /auth/totp/setup`, `POST /auth/totp/enable`, `POST /auth/totp/disable`, `POST /auth/totp/recovery-codes`                                                | user          | [`auth.ts`](../shared/src/schemas/api/auth.ts)                                                                                                               |
| Invite and reset links      | `POST /auth/invite/lookup`, `POST /auth/invite/accept`, `POST /auth/password-reset`                                                                                             | public        | [`invites.ts`](../shared/src/schemas/api/invites.ts)                                                                                                         |
| Accounts and XP             | `GET /accounts`, `GET /accounts/:accountId`, `GET /accounts/:accountId/xp`, `GET /accounts/:accountId/gains`                                                                    | user          | [`accounts.ts`](../shared/src/schemas/api/accounts.ts), [`xp.ts`](../shared/src/schemas/api/xp.ts)                                                           |
| Sessions and calendar       | `GET /accounts/:accountId/sessions`, `GET /sessions/:sessionId`, `GET /accounts/:accountId/calendar`                                                                            | user          | [`sessions.ts`](../shared/src/schemas/api/sessions.ts)                                                                                                       |
| Screen time and weekly      | `GET /accounts/:accountId/screentime`, `…/screentime/heatmap`, `…/screentime/worlds`, `GET /accounts/:accountId/weekly`                                                         | user          | [`screentime.ts`](../shared/src/schemas/api/screentime.ts), [`weekly.ts`](../shared/src/schemas/api/weekly.ts)                                               |
| Feed                        | `GET /accounts/:accountId/feed`                                                                                                                                                 | user          | [`feed.ts`](../shared/src/schemas/api/feed.ts)                                                                                                               |
| Loot and kill counts        | `GET /accounts/:accountId/loot`, `…/loot/drops`, `GET /accounts/:accountId/kc`                                                                                                  | user          | [`loot.ts`](../shared/src/schemas/api/loot.ts), [`kc.ts`](../shared/src/schemas/api/kc.ts)                                                                   |
| Raids and the split tracker | `GET /accounts/:accountId/raids`, `…/raids/splits`, `PUT …/raids/split-default`, `POST …/raids/drops`, `PATCH`/`DELETE …/raids/drops/:dropId`                                   | user          | [`raids.ts`](../shared/src/schemas/api/raids.ts), [`raid-splits.ts`](../shared/src/schemas/api/raid-splits.ts)                                               |
| Bank                        | `GET /accounts/:accountId/bank`, `…/bank/summary`, `…/bank/history`, `…/bank/price-movers`, `…/potion-storage`                                                                  | user          | [`bank.ts`](../shared/src/schemas/api/bank.ts)                                                                                                               |
| Quests and diaries          | `GET /accounts/:accountId/quests`, `…/diaries`                                                                                                                                  | user          | [`quests.ts`](../shared/src/schemas/api/quests.ts)                                                                                                           |
| Collection log and pets     | `GET /accounts/:accountId/collection-log`, `…/collection-log/status`, `PUT …/collection-log/source`, `POST …/collection-log/sync`, `GET /accounts/:accountId/pets`              | user          | [`collection-log.ts`](../shared/src/schemas/api/collection-log.ts), [`pets.ts`](../shared/src/schemas/api/pets.ts)                                           |
| Icons                       | `GET /items/:itemId/icon`, `GET /skills/:skill/icon`, `GET /bosses/:boss/icon` (PNG)                                                                                            | user          | –                                                                                                                                                            |
| Your API keys               | `GET /keys`, `POST /keys`, `DELETE /keys/:id`                                                                                                                                   | user          | [`keys.ts`](../shared/src/schemas/api/keys.ts)                                                                                                               |
| Users and invites           | `GET /users`, `PATCH`/`DELETE /users/:id`, `POST /users/:id/password-reset`, `POST /users/:id/totp-reset`, `POST /users/:id/keys`, `GET`/`POST /invites`, `DELETE /invites/:id` | admin         | [`users.ts`](../shared/src/schemas/api/users.ts), [`invites.ts`](../shared/src/schemas/api/invites.ts), [`keys.ts`](../shared/src/schemas/api/keys.ts)       |
| Administration              | `POST /admin/rebuild`, `GET /admin/backups`, `GET /admin/external-sources`, `GET /admin/icons`, `GET /admin/keys`, `DELETE /admin/keys/:id`, `GET`/`PATCH /admin/settings`      | admin         | [`admin.ts`](../shared/src/schemas/api/admin.ts), [`settings.ts`](../shared/src/schemas/api/settings.ts), [`keys.ts`](../shared/src/schemas/api/keys.ts)     |

Each account in `GET /accounts` and `GET /accounts/:accountId` has
`latestSession`: the `endedAt` and `endReason` of its newest session by start
time (both `null` while it is open), or `null` without sessions (since 1.42.0).
These are facts; the dashboard decides "Online" from them with its own clock
(see [Online](design.md#online)).

The routes live in [`server/src/routes/`](../server/src/routes/), one file per
group. The shared error and pagination parts are in
[`common.ts`](../shared/src/schemas/api/common.ts).

## Authentication

There are two kinds of credentials, and neither is accepted where the other
belongs.

**API keys (the plugin).** Only `/api/v1/ingest` and the paths under
`/api/v1/ingest/` read them, as `Authorization: Bearer fs_<43 characters>`
(the prefix comes from `BRANDING.apiKeyPrefix`). Keys are random, shown once,
and stored as a SHA-256 hash. Each key belongs to a user, and everything it
sends belongs to that user. A key can send events and icons. It can read only
three small things: its own name and the server's versions and clock
(`GET /ingest/verify`), and which icons the server is missing
(`POST /ingest/icons/wanted`). A missing, malformed, unknown or revoked key,
or a key of a disabled user, gets `401` with `WWW-Authenticate: Bearer`.
Unknown paths under `/api/v1/ingest/` also get `401` without a valid key, so
the routes can't be mapped. See [ADR 0005](decisions/0005-security-defaults.md).

**Dashboard requests** depend on the mode
([ADR 0011](decisions/0011-local-and-login-mode.md)):

- **Local mode** (no user has a password): no login. Every dashboard route
  only answers requests from this machine: a loopback socket, a localhost
  `Host`, no proxy headers, and no `Origin` from another site on changes.
  Anything else gets `403`.
- **Login mode**: a session cookie, `__Host-fireside_session` (`HttpOnly`,
  `Secure`, `SameSite=Strict`), from `POST /auth/login`. With two-factor on,
  the right password gives `{ twoFactorRequired: true }` and a short-lived
  challenge cookie, and `POST /auth/login/totp` gives the session. A session
  rolls forward 30 days and lasts at most 90 days in all. Changes must have an
  `Origin` equal to `Host`, a `Sec-Fetch-Site` of `same-origin` when sent, and
  a JSON body (`415` otherwise). The `Host` must be localhost or the host in
  `PUBLIC_URL`; with `TRUSTED_PROXY` set, the `PUBLIC_URL` host only answers
  through the tunnel.

`GET /auth/me` tells the dashboard which mode it is in and who is logged in.
`GET /health` needs no credentials and holds no data about users or accounts.

## Access levels

Every dashboard route declares one level, and a route without one stops the
server at startup (`server/src/auth/dashboard-auth.ts`):

| Level      | Who                                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **public** | Anyone who passes the network check: no session needed in login mode. `about`, `auth/me`, login, logout, invite and reset links. |
| **user**   | A logged-in user (or the local user in local mode). Only ever sees their own accounts, sessions, keys and drops.                 |
| **admin**  | Users with the `admin` role. `403 FORBIDDEN` ("Only an admin can do this") for a member.                                         |

- **Another user's IDs** (account, session, raid drop, key) give exactly the
  same `404` as an ID that doesn't exist, also for an admin, and a change on
  another user's ID changes nothing.
- **Creating API keys** in login mode also needs `can_create_api_keys`
  (`403` without it); an admin can create a key for any user. At most 10 active
  keys per user (`409`).
- **Unknown paths under `/api/v1`** go through the same checks as a real
  dashboard route: in login mode `401` without a session, `404` with one.
- In local mode the one local user is an admin and can use everything.

## Errors

Every error, from every endpoint, has the same body (`errorResponseSchema` in
[`common.ts`](../shared/src/schemas/api/common.ts)):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": [{ "path": "query.limit", "message": "Too big: expected number to be <=100" }]
  }
}
```

- `code` is one of `VALIDATION_ERROR`, `BAD_REQUEST`, `UNAUTHORIZED`,
  `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`
  and `INTERNAL_ERROR`. Clients branch on the status and the code, never on
  the message.
- `details` is empty except for validation errors, where `path` is a dot path
  (`body.password`, `query.limit`) and the dashboard shows `message` under the
  field.
- Messages are safe to show. They never say whether a user, account, key or
  invite exists, and a `500` never includes the underlying error
  (`server/src/errors.ts`).
- `POST /ingest` answers `200` even when some events are rejected: the body
  lists `accepted`, `duplicates` and `rejected` (with the index, the
  `eventId` and the reason). Only a bad batch as a whole is a `400`.

## Rate limits

A limited request gets `429 RATE_LIMITED` with `Retry-After` in seconds.

- **Ingest:** 120 requests a minute per API key. Requests without a valid key
  are limited per client IP. A request with a valid key is never limited by its
  IP.
- **Login, two-factor codes, password checks and invite links** have their own
  limits per client IP, per username and per user, with waits that double up
  to 15 minutes (`server/src/auth/login-limiter.ts`). A browser that has logged
  in before skips the per-username limit. Nothing is ever locked out for good.
- **Password hashing** is shared by every route that hashes or checks a
  password. When too many are waiting, those routes answer `503` with
  `Retry-After` and code `RATE_LIMITED`; nothing was checked or used up, so the
  same request can be sent again.

The client IP is the socket address, or `CF-Connecting-IP` only for requests
through the trusted tunnel. IPv6 addresses are counted per /64.

## Caching

Every response under `/api` has `Cache-Control: no-store`, errors included.
The one exception is a found icon: `private, max-age=86400,
stale-while-revalidate=604800` with an `ETag`. The browser uses it for a day
without asking, then checks it with `If-None-Match` (a `304` when it has not
changed), and `private` keeps shared caches from storing it. A missing icon
(`404`) is `no-store`, so an icon uploaded later shows up on the next view
([ADR 0018](decisions/0018-icons-cached-privately-for-a-day.md)).

## Versioning

- The API's major version is in the path (`/api/v1`). Every event has a
  `schemaVersion` (now `1`).
- `CONTRACT_VERSION` in [`shared/src/contract.ts`](../shared/src/contract.ts)
  is the version of the whole contract (events and API), in semver. `GET
/health` and `GET /ingest/verify` report it.
- **Minor version:** additions that old clients don't notice: a new event
  type, a new optional field, a new endpoint, a new status on an existing
  route. Objects are strict, so a server only accepts fields from its own
  version or older; update the server before the plugin.
- **Breaking changes** (removing or renaming a field, changing its meaning or
  type) need a new major version and a new `/api/v2` or event `schemaVersion`.
  This applies to the dashboard's own endpoints too.
- A change to events or the API updates the Zod schemas, the fixtures,
  `CONTRACT_VERSION` and these docs in the same pull request
  ([the contract rule](../CONTRIBUTING.md#the-contract-rule)).

## Schemas

The JSON Schemas are generated from the Zod schemas, never written by hand:

```fish
pnpm --filter @fireside/shared build
```

This writes `shared/dist/contract/`:

- `schema/event.json` and `schema/events/<type>.json` for the events;
- `schema/api/<name>.json` for each request and response
  (`ingest-request.json`, `sessions-response.json`, `error-response.json`, …;
  the names come from `API_SCHEMAS` in
  [`shared/src/schemas/api/index.ts`](../shared/src/schemas/api/index.ts));
- `fixtures/` with valid and invalid examples of each;
- `manifest.json` with the contract version, the schema list and notes for
  schemas that leave a part to another schema.

The same files are published as `contract-v<version>.zip` on the repo's GitHub
releases, which is what the plugin pins (see
[the contract package](architecture.md#the-contract-package)).
