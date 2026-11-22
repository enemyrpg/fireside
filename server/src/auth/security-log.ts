import type { FastifyRequest } from 'fastify';

// The only log lines with an IP address. The per-request log line has none
// (app.ts); a failed login, a wrong code, a rejected link, the first refused
// attempt (429) of each block, or an IP blocked for requests without a valid
// API key logs the client's address here, so the admin can see where an attack
// comes from. Once per block, so refused attempts can't flood the log. The
// address is the one the limiters use (auth/client-ip.ts): through the trusted
// proxy, the visitor's. Never log the typed username or anything secret with
// it.

export type SecurityEvent =
  /** Wrong username or password on `/auth/login`. */
  | 'login_failed'
  /** Wrong 2FA or recovery code (login, settings, reset link). */
  | 'code_failed'
  /** Wrong password with a session (`reauth:user`). */
  | 'reauth_failed'
  /** Unknown, used, expired or revoked invite or reset link. */
  | 'link_rejected'
  /** `429` from a limiter: the first refusal of each block (`Attempt.firstRefusal`). */
  | 'rate_limited';

/** Logs a security event at `warn` with the client's IP address. */
export function logSecurityEvent(
  request: FastifyRequest,
  event: SecurityEvent,
  message: string,
  fields: Record<string, string | number> = {},
): void {
  request.log.warn({ ...fields, securityEvent: event, clientIp: request.clientIp }, message);
}
