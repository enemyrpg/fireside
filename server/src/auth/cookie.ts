import { BRANDING } from '@fireside/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DEVICE_TTL_MS } from './devices.js';
import { SESSION_TTL_MS } from './sessions.js';

// The dashboard's cookies. `__Host-` makes the browser refuse them unless they
// are Secure, have `Path=/` and no `Domain`, so no subdomain can set or read
// them. Chrome and Firefox keep Secure cookies on http://localhost (a secure
// context); Safari may not, which the login page explains.
//
// - session: the login session (30 days, rolling).
// - device: a browser that fully logged in (1 year). Skips the per-username
//   login limit for that user; never a login by itself.
// - mfa: the 2FA step between password and code (5 min).

export const SESSION_COOKIE = `__Host-${BRANDING.shortName}_session`;
export const DEVICE_COOKIE = `__Host-${BRANDING.shortName}_device`;
export const MFA_COOKIE = `__Host-${BRANDING.shortName}_mfa`;
export const MFA_TTL_MS = 5 * 60 * 1000;

const ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Strict';

function cookie(name: string, value: string, maxAgeMs: number): string {
  return `${name}=${value}; Max-Age=${String(Math.floor(maxAgeMs / 1000))}; ${ATTRIBUTES}`;
}

export function sessionCookie(token: string, maxAgeMs: number = SESSION_TTL_MS): string {
  return cookie(SESSION_COOKIE, token, maxAgeMs);
}

export const CLEARED_SESSION_COOKIE = `${SESSION_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;

/**
 * The value of cookie `name` from the `Cookie` header, or `undefined`. With
 * several cookies of that name (should not happen with `__Host-`), none is
 * trusted.
 */
export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 ? values[0] : undefined;
}

export function readSessionToken(request: FastifyRequest): string | undefined {
  return readCookie(request, SESSION_COOKIE);
}

/** Adds a `Set-Cookie` header, keeping any set before in this reply. */
function addSetCookie(reply: FastifyReply, value: string): void {
  const existing = reply.getHeader('set-cookie');
  const list =
    existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
  // Replaces an earlier header for the same cookie. Fastify appends to
  // `set-cookie` instead of replacing it, so the header is removed first.
  const name = value.slice(0, value.indexOf('=') + 1);
  void reply.removeHeader('set-cookie');
  void reply.header('set-cookie', [...list.filter((v) => !v.startsWith(name)), value]);
}

export function setSessionCookie(reply: FastifyReply, token: string, maxAgeMs?: number): void {
  addSetCookie(reply, sessionCookie(token, maxAgeMs));
}

export function clearSessionCookie(reply: FastifyReply): void {
  addSetCookie(reply, CLEARED_SESSION_COOKIE);
}

export function setDeviceCookie(reply: FastifyReply, token: string): void {
  addSetCookie(reply, cookie(DEVICE_COOKIE, token, DEVICE_TTL_MS));
}

export function clearDeviceCookie(reply: FastifyReply): void {
  addSetCookie(reply, `${DEVICE_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`);
}

export function setMfaCookie(reply: FastifyReply, token: string): void {
  addSetCookie(reply, cookie(MFA_COOKIE, token, MFA_TTL_MS));
}

export function clearMfaCookie(reply: FastifyReply): void {
  addSetCookie(reply, `${MFA_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`);
}
