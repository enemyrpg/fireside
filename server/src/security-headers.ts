import type { FastifyInstance, FastifyRequest } from 'fastify';
import { visitorUsedHttps } from './auth/client-ip.js';
import { isApiPath } from './errors.js';

// Security headers on every response: API, ingest, static files, the
// dashboard's index.html, 404s and errors.

/**
 * Content-Security-Policy for every response.
 * - Scripts only from this origin: no inline scripts and no eval. The theme
 *   script that runs before React is a file (web/vite.config.ts).
 * - `style-src-elem` allows inline `<style>` elements: Radix injects them at
 *   runtime with computed values (scroll lock), and Sonner injects a fixed
 *   stylesheet. A nonce and a build-time hash would add per-request HTML
 *   templating and a hash that can silently break on a Sonner update, for
 *   little gain: injecting a style first needs an HTML injection, which
 *   React already prevents.
 * - `style-src-attr` is not loosened (it falls back to `style-src 'self'`).
 *   React sets `style` through CSSOM, which CSP does not cover.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-elem 'self' 'unsafe-inline'",
  // `data:` for the favicon in the theme's colour (web/src/branding/favicon.ts).
  // An image can't run script.
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/**
 * Never `includeSubDomains` or `preload`: the parent domain stays free for a
 * project site that may not use https everywhere, and preload can't be undone.
 */
export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000';

/** Sent on every response. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  // Covers the invite and reset pages, whose token is in the fragment.
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
};

/**
 * The one exception to `no-store` under `/api`: a found icon (routes/items.ts).
 * The browser may use it for a day without asking, then serves it while it
 * checks it with the server (a cheap `304` via `ETag`) for up to a week more.
 * `private` keeps Cloudflare and any other shared cache from ever storing it.
 * A missing icon (404) stays `no-store`, so a newly uploaded one shows up at
 * once. Icons are shared by the instance and hold no user data
 * (docs/decisions/0018-icons-cached-privately-for-a-day.md). Any other value
 * under `/api` becomes `no-store`.
 */
export const ICON_CACHE = 'private, max-age=86400, stale-while-revalidate=604800';

export interface SecurityHeadersOptions {
  /** Host of `PUBLIC_URL` (`publicHostOf`). HSTS is only sent for it. */
  publicHost: string | undefined;
}

/**
 * HSTS only for a visitor who reached the public address over https through
 * the trusted proxy. Never on direct localhost: a browser would then refuse
 * http://localhost for a year.
 */
export function wantsHsts(request: FastifyRequest, publicHost: string | undefined): boolean {
  return (
    request.viaTrustedProxy &&
    publicHost !== undefined &&
    request.headers.host?.toLowerCase() === publicHost &&
    visitorUsedHttps(request)
  );
}

/** Adds the headers to every response of `app` (the root instance). */
export function addSecurityHeaders(app: FastifyInstance, { publicHost }: SecurityHeadersOptions) {
  app.addHook('onSend', (request, reply, payload, done) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      // A route may set a stricter CSP of its own (the icons: `default-src 'none'`).
      if (name === 'content-security-policy' && reply.hasHeader(name)) continue;
      void reply.header(name, value);
    }
    if (wantsHsts(request, publicHost)) {
      void reply.header('strict-transport-security', STRICT_TRANSPORT_SECURITY);
    }
    // API responses are per user and must never be stored by a browser or a
    // proxy. Only a found icon may be kept privately (`ICON_CACHE`).
    if (isApiPath(request.url) && reply.getHeader('cache-control') !== ICON_CACHE) {
      void reply.header('cache-control', 'no-store');
    }
    done(null, payload);
  });
}
