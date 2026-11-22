import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TrustedProxy } from '../config.js';
import { isLoopbackAddress } from './local-only.js';

// The client's IP address.
//
// Fastify's `trustProxy` stays off, so `request.ip` is always the socket
// address. With `TRUSTED_PROXY=cloudflare`, cloudflared runs on this machine
// and connects to 127.0.0.1, so a request from loopback that carries
// `CF-Connecting-IP` came through the tunnel, and that header (set by
// Cloudflare, which overwrites anything the visitor sent) is the client.
// Anywhere else the header is ignored: without `TRUSTED_PROXY`, and from a
// socket that isn't loopback. `X-Forwarded-For` is never read.
//
// Accepted risk: another process on this machine can send the header. It
// can already read the database.

declare module 'fastify' {
  interface FastifyRequest {
    /** The client IP (see above). Set on every request by `addClientIp`. */
    clientIp: string;
    /** Whether the request came through the trusted proxy (see above). */
    viaTrustedProxy: boolean;
  }
}

export const CF_CONNECTING_IP = 'cf-connecting-ip';

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value.trim() : undefined;
}

/**
 * The IP the trusted proxy says the client has, or `undefined` when the
 * request didn't come through it (or the header isn't a single valid IP).
 */
export function proxiedClientIp(
  request: FastifyRequest,
  trustedProxy: TrustedProxy | null,
): string | undefined {
  if (trustedProxy !== 'cloudflare') return undefined;
  if (!isLoopbackAddress(request.ip)) return undefined;
  const value = header(request, CF_CONNECTING_IP);
  if (value === undefined || isIP(value) === 0) return undefined;
  return value.toLowerCase();
}

/** The client IP: from the trusted proxy (see above), otherwise the socket address. */
export function clientIpOf(request: FastifyRequest, trustedProxy: TrustedProxy | null): string {
  return proxiedClientIp(request, trustedProxy) ?? request.ip;
}

/**
 * Whether the visitor used https to reach the trusted proxy. Cloudflare says
 * so in `CF-Visitor` (`{"scheme":"https"}`); cloudflared also sets
 * `X-Forwarded-Proto`. Only meaningful when `viaTrustedProxy` is true.
 */
export function visitorUsedHttps(request: FastifyRequest): boolean {
  const visitor = header(request, 'cf-visitor');
  if (visitor !== undefined) {
    try {
      const parsed: unknown = JSON.parse(visitor);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { scheme?: unknown }).scheme === 'https'
      ) {
        return true;
      }
    } catch {
      // Not JSON: fall through to X-Forwarded-Proto.
    }
  }
  return header(request, 'x-forwarded-proto')?.toLowerCase() === 'https';
}

/** Sets `request.clientIp` and `request.viaTrustedProxy` on every request. */
export function addClientIp(app: FastifyInstance, trustedProxy: TrustedProxy | null): void {
  app.decorateRequest('clientIp', '');
  app.decorateRequest('viaTrustedProxy', false);
  app.addHook('onRequest', (request, _reply, done) => {
    const proxied = proxiedClientIp(request, trustedProxy);
    request.viaTrustedProxy = proxied !== undefined;
    request.clientIp = proxied ?? request.ip;
    done();
  });
}
