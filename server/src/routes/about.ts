import type { AboutResponse } from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import { PUBLIC_ROUTE } from '../auth/dashboard-auth.js';
import { getServerSettings } from '../settings/settings.js';

// `GET /api/v1/about`: the instance text for `/about` (linked from the login page).
// Public, so it is readable before logging in (in local mode only from localhost, like
// every dashboard route). It holds only the text the admin wrote (or the default),
// never user or account data.
//
// No rate limit: it reads one settings row, like `GET /auth/me`, and a
// limiter would keep visitors' IP addresses in memory.

export interface AboutRoutesOptions {
  /** Shown while the admin hasn't written their own text. */
  defaultInstanceText: string;
}

export const aboutRoutes: FastifyPluginCallback<AboutRoutesOptions> = (app, options, done) => {
  app.get('/about', PUBLIC_ROUTE, (): AboutResponse => {
    const { instanceText } = getServerSettings(app.db);
    return instanceText === null
      ? { text: options.defaultInstanceText, isDefault: true }
      : { text: instanceText, isDefault: false };
  });
  done();
};
