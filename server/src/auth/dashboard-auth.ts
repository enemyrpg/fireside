import type { AuthMode } from '@fireside/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TrustedProxy } from '../config.js';
import type { UserRow } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { anyPasswordSet, findUserById, localUserId } from '../users/users.js';
import { readSessionToken, setSessionCookie } from './cookie.js';
import { localOnlyViolation, loginNetworkViolation } from './local-only.js';
import { lookupSession } from './sessions.js';

// Access to the dashboard scope.
//
// Two modes, decided per request from the database, so a password set with
// the CLI while the server runs takes effect at once:
// - local (no user has a password): no login, the dashboard acts as the
//   local user. The local-only check applies.
// - login (some user has a password): a session cookie is required, except
//   on `public` routes. The network check adds `PUBLIC_URL`'s host to
//   localhost, and allows requests through the trusted proxy
//   (auth/client-ip.ts). Unknown paths need a session too.
//
// Every route declares its access level (`config: { access }`);
// one without it stops the server at startup:
// - `public`: no session needed (login, logout, me).
// - `user`: any logged-in user. The route only reads and changes the user's
//   own data (`request.user`, see routes/account-scope.ts).
// - `admin`: logged-in admins only, `403` for members.
// In local mode the local user (an admin) may use every route.
// API keys are never read here: an `Authorization` header is ignored.

/** Who may use a dashboard route. */
export type RouteAccess = 'public' | 'user' | 'admin';

export const ROUTE_ACCESS: readonly RouteAccess[] = ['public', 'user', 'admin'];

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Required on every dashboard route (`addDashboardAuth`). */
    access?: RouteAccess;
  }
  interface FastifyRequest {
    /** Set on every dashboard request. */
    authMode: AuthMode;
    /** The logged-in session, in login mode. `undefined` in local mode or without one. */
    session: { id: string; user: UserRow } | undefined;
    /**
     * The user the request acts as: the local user in local mode, the
     * session's user in login mode. `undefined` only on a `public` route
     * without a session. Read it with `requestUser` (routes/account-scope.ts).
     */
    user: UserRow | undefined;
  }
}

/** Methods that only read, so a cross-site request can't change anything. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface DashboardAuthOptions {
  now: () => Date;
  /** Host of `PUBLIC_URL` (`publicHostOf`), allowed besides localhost in login mode. */
  publicHost?: string | undefined;
  /** `TRUSTED_PROXY`: with it, `publicHost` is only answered through that proxy. */
  trustedProxy?: TrustedProxy | null | undefined;
}

function hasBody(request: FastifyRequest): boolean {
  const length = request.headers['content-length'];
  return (
    request.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0')
  );
}

/**
 * Cross-site request checks for changes in login mode: an `Origin` from this
 * host is required (the local-only check only compares it when present),
 * `Sec-Fetch-Site` must say same-origin when sent, and a body must be JSON,
 * which a cross-site form can't send without a preflight. The cookie is also
 * `SameSite=Strict`.
 */
function csrfViolation(request: FastifyRequest): ApiError | undefined {
  if (SAFE_METHODS.has(request.method)) return undefined;
  const origin = request.headers.origin;
  let originHost: string | undefined;
  try {
    originHost = origin === undefined ? undefined : new URL(origin).host.toLowerCase();
  } catch {
    originHost = undefined;
  }
  if (originHost === undefined || originHost !== request.headers.host?.toLowerCase()) {
    return new ApiError(403, 'FORBIDDEN', 'Cross-site request refused');
  }
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin') {
    return new ApiError(403, 'FORBIDDEN', 'Cross-site request refused');
  }
  const type = request.headers['content-type'];
  if (hasBody(request) && !/^application\/json\s*(;|$)/i.test(type ?? '')) {
    return new ApiError(415, 'BAD_REQUEST', 'Request bodies must be JSON');
  }
  return undefined;
}

/**
 * Adds the access hook to `app`, the encapsulated dashboard scope. Call it
 * before registering any route: it also checks each route's `access`.
 */
export function addDashboardAuth(
  app: FastifyInstance,
  { now, publicHost, trustedProxy = null }: DashboardAuthOptions,
): void {
  app.decorateRequest('authMode', 'local');
  app.decorateRequest('session', undefined);
  app.decorateRequest('user', undefined);

  // Fail closed: a route without an access level never starts. Collected
  // here and thrown from `onReady`, which makes `ready()` (and `listen`)
  // reject; an error thrown inside `onRoute` would escape the plugin loader.
  const undeclared: string[] = [];
  app.addHook('onRoute', (route) => {
    const access = (route.config as { access?: unknown } | undefined)?.access;
    if (!ROUTE_ACCESS.includes(access as RouteAccess)) {
      const methods = Array.isArray(route.method) ? route.method.join(',') : route.method;
      undeclared.push(`${methods} ${route.url}`);
    }
  });
  app.addHook('onReady', (done) => {
    if (undeclared.length === 0) {
      done();
      return;
    }
    done(
      new Error(
        `Dashboard route ${undeclared.join(', ')} has no access level: ` +
          "add config: { access: 'public' | 'user' | 'admin' }",
      ),
    );
  });

  app.addHook('onRequest', async (request, reply) => {
    const login = anyPasswordSet(app.db);
    const reason = login
      ? loginNetworkViolation(request, publicHost, trustedProxy)
      : localOnlyViolation(request);
    if (reason !== undefined) {
      request.log.debug({ reason }, 'Dashboard request refused');
      throw new ApiError(403, 'FORBIDDEN', 'The dashboard is only available on localhost');
    }

    if (!login) {
      request.authMode = 'local';
      const user = findUserById(app.db, localUserId(app.db));
      request.user = user;
      return;
    }
    request.authMode = 'login';

    const csrf = csrfViolation(request);
    if (csrf) {
      request.log.debug({ reason: csrf.message }, 'Dashboard request refused');
      throw csrf;
    }

    const token = readSessionToken(request);
    const found = token === undefined ? undefined : lookupSession(app.db, token, now());
    if (token !== undefined && found?.status === 'valid') {
      request.session = { id: found.id, user: found.user };
      request.user = found.user;
      if (found.refreshedUntil) {
        setSessionCookie(reply, token, found.refreshedUntil.getTime() - now().getTime());
      }
    }

    // An unknown path is treated as a `user` route: `401` before login, so the
    // routes can't be mapped without a session, and `404` after.
    const access = request.is404 ? 'user' : request.routeOptions.config.access;
    if (access === 'public') return;
    if (!request.session) throw new ApiError(401, 'UNAUTHORIZED', 'Log in to continue');
    // `access` is always set (onRoute above); anything else is treated as admin.
    if (access !== 'user' && request.session.user.role !== 'admin') {
      throw new ApiError(403, 'FORBIDDEN', 'Only an admin can do this');
    }
  });
}

/** Route options for each access level, e.g. `app.get(url, USER_ROUTE, handler)`. */
export const PUBLIC_ROUTE = { config: { access: 'public' } } as const;
export const USER_ROUTE = { config: { access: 'user' } } as const;
export const ADMIN_ROUTE = { config: { access: 'admin' } } as const;
