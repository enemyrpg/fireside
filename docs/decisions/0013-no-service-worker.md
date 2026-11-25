# 0013. No service worker

- **Date:** 2026-11-19
- **Status:** Accepted

## Context

The dashboard can be installed as an app on phones and desktops (a web app
manifest and icons). Service workers used to be required for that, and they
cache what they fetch.

## Decision

The dashboard has no service worker. Chrome hasn't required one (or a `fetch`
handler) for installing from the menu since version 108 on Android and 112 on
desktop, and iOS never did.

## Consequences

- Nothing is cached by the app: no user data is left on a shared phone after
  logging out. `/api` stays `no-store` and `index.html` `no-cache`.
- No offline mode and no push notifications.
- Adding a service worker needs a new decision.

See also [ADR 0018](0018-icons-cached-privately-for-a-day.md): found icons may
be kept in the browser's own cache for a day.
