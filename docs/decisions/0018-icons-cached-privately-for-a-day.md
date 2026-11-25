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
- An icon replaced on the server can show its old image for up to a day; the
  `ETag` check brings the new one after that.
- On a shared device, the browser cache can keep icons for a day after
  logout. That shows which items were viewed, but no user data: icons are
  shared by the instance ([ADR 0015](0015-icons-from-the-users-client.md)),
  the same image for every user, with no amounts, names or account. This is
  accepted because it reveals no more than which game items were looked at,
  and the gain on every page with icons is large.
