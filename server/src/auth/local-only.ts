import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { TrustedProxy } from '../config.js';

// Network rules for dashboard routes, run by the dashboard hook
// (auth/dashboard-auth.ts) before anything else. API keys are never read here.
// - Local mode (`localOnlyViolation`): only requests made on this machine.
// - Login mode (`loginNetworkViolation`): the same, except that `Host` may also
//   be the host of `PUBLIC_URL`. The socket must still be loopback. Proxy
//   headers are refused, except Cloudflare's on a request that came through the
//   trusted proxy (`request.viaTrustedProxy`, see auth/client-ip.ts), which
//   must then be for the `PUBLIC_URL` host. With `TRUSTED_PROXY` set it holds
//   the other way too: the `PUBLIC_URL` host is only answered through the
//   trusted proxy.

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Headers set by reverse proxies: Tailscale Serve, and Cloudflare (Tunnel)
 * with `cf-*` and `cdn-loop`. Always refused in local mode.
 */
const PROXY_HEADER = /^(forwarded|via|x-forwarded-.*|x-real-ip|tailscale-.*|cf-.*|cdn-loop)$/;

/**
 * The proxy headers Cloudflare Tunnel sends (cloudflared adds the
 * `X-Forwarded-*` pair). Allowed only on a request through the trusted proxy
 * in login mode. They are never read, except `CF-Connecting-IP` (client-ip.ts)
 * and the scheme for HSTS (`CF-Visitor`, `X-Forwarded-Proto`).
 *
 * Seen through a real tunnel (browser and curl): `cdn-loop`,
 * `cf-connecting-ip`, `cf-ipcountry`, `cf-ray`, `cf-visitor`,
 * `cf-warp-tag-id`, `x-forwarded-for`, `x-forwarded-proto`. `cf-*` stays a
 * prefix on purpose: Cloudflare adds other `cf-*` headers
 * when settings change (visitor location headers, `cf-connecting-ipv6` with
 * Pseudo IPv4), and an exact list would then refuse everyone with `403`
 * without warning. They only pass on the trusted path, so a longer list gains
 * nothing.
 */
const CLOUDFLARE_HEADER = /^(cf-.*|cdn-loop|x-forwarded-for|x-forwarded-proto)$/;

/** Methods that only read, so a cross-site request can't change anything. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `127.0.0.0/8`, `::1` and IPv4-mapped `::ffff:127.x.x.x`. */
export function isLoopbackAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(ip) === 4) return ip.startsWith('127.');
  return ip === '::1';
}

/** `localhost`, `127.0.0.1` or `[::1]`, with or without a port. */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase());
}

/**
 * The host part of `PUBLIC_URL` (`app.example.com`, with a port if it has
 * one), lower case. `undefined` when unset.
 */
export function publicHostOf(publicUrl: string | null | undefined): string | undefined {
  return publicUrl ? new URL(publicUrl).host.toLowerCase() : undefined;
}

/** Why the request is refused, or `undefined` if it is local. Only for logs. */
export function localOnlyViolation(request: FastifyRequest): string | undefined {
  return networkViolation(request, undefined, 'never');
}

/**
 * Login mode: as `localOnlyViolation`, but `Host` may also be `publicHost`
 * (from `publicHostOf`). With `trustedProxy` set, `publicHost` and the
 * trusted proxy go together: neither is accepted without the other. Only for
 * logs.
 */
export function loginNetworkViolation(
  request: FastifyRequest,
  publicHost: string | undefined,
  trustedProxy: TrustedProxy | null = null,
): string | undefined {
  if (trustedProxy === null) return networkViolation(request, publicHost, 'never');
  return networkViolation(request, publicHost, request.viaTrustedProxy ? 'yes' : 'no');
}

/**
 * `never`: no trusted proxy is configured. `yes` / `no`: one is, and the
 * request did or did not come through it.
 */
type ViaTrustedProxy = 'never' | 'yes' | 'no';

function networkViolation(
  request: FastifyRequest,
  publicHost: string | undefined,
  via: ViaTrustedProxy,
): string | undefined {
  // `request.ip` is the socket address: `trustProxy` is off, so headers can't fake it.
  if (!isLoopbackAddress(request.ip)) return 'remote address';
  const host = request.headers.host;
  const isPublicHost = publicHost !== undefined && host?.toLowerCase() === publicHost;
  const viaTrustedProxy = via === 'yes';
  // Through the tunnel, the visitor asked for the public address.
  if (viaTrustedProxy && !isPublicHost) return 'Host header';
  // And the public address is only reached through the tunnel: a request for it
  // straight from this machine, or from another forwarder that adds no headers,
  // would share the client IP 127.0.0.1 and get no HSTS.
  if (via === 'no' && isPublicHost) return 'Host header';
  // A loopback socket with a foreign Host is DNS rebinding or a proxy.
  if (!isLoopbackHost(host) && !isPublicHost) return 'Host header';
  const refused = (name: string) =>
    PROXY_HEADER.test(name) && !(viaTrustedProxy && CLOUDFLARE_HEADER.test(name));
  if (Object.keys(request.headers).some(refused)) return 'proxy header';
  // A page on another site can POST here from the owner's browser (CSRF).
  const origin = request.headers.origin;
  if (!SAFE_METHODS.has(request.method) && origin !== undefined) {
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = undefined;
    }
    if (originHost?.toLowerCase() !== host?.toLowerCase()) return 'Origin header';
  }
  return undefined;
}
