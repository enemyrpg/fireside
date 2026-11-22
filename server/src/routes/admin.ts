import type {
  BackupStatusResponse,
  ExternalSourcesResponse,
  IconsStatusResponse,
  RebuildResponse,
} from '@fireside/shared';
import type { FastifyPluginCallback } from 'fastify';
import { rebuildDerivedTables, type AdminRunOptions } from '../admin/rebuild.js';
import { CLOG_SYNC_INTERVAL_MS } from '../clog/sync.js';
import type { BackupConfig, Config } from '../config.js';
import { externalSourcesStatus } from '../external/state.js';
import { iconsStatus } from '../icons/store.js';
import { PRICES_INTERVAL_MS } from '../prices/fetch.js';
import { backupStatus, type BackupJobState } from '../jobs/backup.js';
import { ADMIN_ROUTE } from '../auth/dashboard-auth.js';

export interface BackupRoutesOptions {
  config: BackupConfig;
  /** The running backup job's state, or `undefined` when no job runs (tests). */
  state: () => BackupJobState | undefined;
}

export type AdminRoutesOptions = Pick<AdminRunOptions, 'projections' | 'now'>;

/**
 * `/api/v1/admin/*`. Registered inside the dashboard scope. Every route is
 * `admin`: `403` for members. Rebuild, backups and the external sources concern
 * the whole instance, every user's data.
 */
export const adminRoutes: FastifyPluginCallback<
  AdminRoutesOptions & { backup?: BackupRoutesOptions; config?: Config; timeZone: string }
> = (app, { backup, config, timeZone, ...options }, done) => {
  // Runs synchronously, so other requests wait until it is done.
  app.post('/rebuild', ADMIN_ROUTE, (request): RebuildResponse => {
    const { processed, failed, durationMs } = rebuildDerivedTables(app.db, {
      ...options,
      log: request.log,
    });
    return { processed, failed: failed.length, durationMs };
  });

  // Counts only: shows the owner that the plugin's icon import has finished.
  app.get('/icons', ADMIN_ROUTE, (): IconsStatusResponse => iconsStatus(app.db));

  // Never returns the folder path: in Docker it is the container's path.
  if (backup) {
    app.get('/backups', ADMIN_ROUTE, (): BackupStatusResponse =>
      backupStatus(backup.config, timeZone, backup.state(), ...(options.now ? [options.now] : [])),
    );
  }

  // Flags and times only: never the contact, and never anything a source returned.
  if (config) {
    app.get('/external-sources', ADMIN_ROUTE, (): ExternalSourcesResponse =>
      externalSourcesStatus(
        app.db,
        config,
        { WIKI_PRICES: PRICES_INTERVAL_MS, RUNEPROFILE: CLOG_SYNC_INTERVAL_MS },
        ...(options.now ? [options.now] : []),
      ),
    );
  }
  done();
};
