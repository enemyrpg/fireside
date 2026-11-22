import { updateServerSettingsRequestSchema, type ServerSettings } from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { ADMIN_ROUTE } from '../auth/dashboard-auth.js';
import { ApiError } from '../errors.js';
import { InvalidInstanceTextError } from '../settings/instance-text.js';
import {
  getServerSettings,
  updateServerSettings,
  type StoredSettings,
} from '../settings/settings.js';
import { fieldError } from './auth.js';
import { requestUser } from './account-scope.js';
import { jsonBodiesOnly } from './json-body.js';
import { parseRequest } from './parse.js';

// `/api/v1/admin/settings` (Settings → Server). Admin only. Works in local mode
// too: the settings are defaults for later, not a way in.

export interface SettingsRoutesOptions {
  /** The text shown while the admin hasn't written their own. */
  defaultInstanceText: string;
  now?: Clock;
}

export const settingsRoutes: FastifyPluginCallback<SettingsRoutesOptions> = (
  app,
  options,
  done,
) => {
  const now = options.now ?? systemClock;

  jsonBodiesOnly(app);

  const withDefault = (settings: StoredSettings): ServerSettings => ({
    ...settings,
    defaultInstanceText: options.defaultInstanceText,
  });

  app.get('/admin/settings', ADMIN_ROUTE, (): ServerSettings =>
    withDefault(getServerSettings(app.db)),
  );

  app.patch('/admin/settings', ADMIN_ROUTE, (request): ServerSettings => {
    const body = parseRequest(updateServerSettingsRequestSchema, request.body, 'body');
    if (Object.values(body).every((value) => value === undefined)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
        { path: 'body', message: 'Change at least one setting' },
      ]);
    }
    const actorUserId = requestUser(request).id;
    let settings: StoredSettings;
    try {
      settings = app.db.transaction(
        (tx) => updateServerSettings(tx, body, { actorUserId, now: now() }),
        { behavior: 'immediate' },
      );
    } catch (error) {
      if (error instanceof InvalidInstanceTextError) {
        throw fieldError('body.instanceText', error.message);
      }
      throw error;
    }
    request.log.info({ settings: Object.keys(body) }, 'Server settings changed');
    return withDefault(settings);
  });

  done();
};
