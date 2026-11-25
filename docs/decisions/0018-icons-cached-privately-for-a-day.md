# 0018. Icons may be cached privately for a day

- **Date:** 2026-11-25
- **Status:** Accepted

## Context

A found icon was sent `private, no-cache`, so the browser had to check it with
the server before every use: a `304` round trip per icon, slow through the
Cloudflare Tunnel. Opening a page with icons in a new tab, or reloading it,
asked again for every icon (about a hundred on the Bank page), and their
placeholders showed while the answers came back.

## Decision

- Only found icons get `Cache-Control: private, max-age=86400,
stale-while-revalidate=604800`, with their `ETag` and a `304` for a matching
  `If-None-Match` (`ICON_CACHE` in `server/src/security-headers.ts`, sent by
  `server/src/routes/items.ts`).
- Everything else under `/api` stays `no-store`, missing icons (`404`)
  included. `private` keeps Cloudflare and other shared caches out.
- The dashboard shows an icon the browser already has at once, without a
  placeholder frame (`web/src/components/IconImage.tsx`).

## Consequences

- Icons show at once on remount and within a day make no requests.
- After that day, for up to 7 more days, the browser still shows a cached icon
  at once and checks it with the server in the background (a `304` when it has
  not changed). An icon replaced on the server could therefore show its old
  image once more, up to 8 days after it was cached. Icons can't be replaced
  through the API anyway ([ADR 0015](0015-icons-from-the-users-client.md)):
  only by deleting the row, after which the plugin uploads it again.
- On a shared device, the browser cache can keep icons after logout, usable
  for up to 8 days. That shows which items were viewed, but no user data: icons are
  shared by the instance ([ADR 0015](0015-icons-from-the-users-client.md)),
  the same image for every user, with no amounts, names or account. This is
  accepted because it reveals no more than which game items were looked at,
  and the gain on every page with icons is large.
