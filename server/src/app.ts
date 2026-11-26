import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { addClientIp } from './auth/client-ip.js';
import { publicHostOf } from './auth/local-only.js';
import type { Config } from './config.js';
import type { Database, Db } from './db/index.js';
import { notFoundHandler, toErrorResponse, withoutQuery } from './errors.js';
import { INGEST_PREFIX } from './auth/ingest-auth.js';
import { createRuneProfileProvider } from './clog/runeprofile.js';
import { createClogSyncer } from './clog/sync.js';
import { createExternalClient, type ExternalClient } from './external/client.js';
import { EXTERNAL_SOURCES } from './external/sources.js';
import { startBackupJob, type BackupJob } from './jobs/backup.js';
import { startClogJob, type ClogJob } from './jobs/clog.js';
import { startPricesJob, type PricesJob } from './jobs/prices.js';
import type { RunningJob } from './jobs/session-timeout.js';
import { startBackgroundJobs } from './jobs/startup.js';
import { dashboardRoutes, type DashboardRoutesOptions } from './routes/dashboard.js';
import { healthRoutes } from './routes/health.js';
import { ingestRoutes, type IngestRoutesOptions } from './routes/ingest.js';
import { registerWebApp } from './routes/web.js';
import { addSecurityHeaders } from './security-headers.js';
import { fileKeyStore, memoryKeyStore } from './auth/secret-box.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Drizzle database. The app closes the connection when it closes. */
    db: Db;
  }
}

export interface BuildAppOptions {
  config: Config;
  /** Opened and migrated database. Owned by the app from here on. */
  db: Database;
  /** Where logs go. Defaults to stdout. Used by tests to capture logs. */
  logStream?: NodeJS.WritableStream;
  /** Options for the ingest routes (clock, rate limit). Used by tests. */
  ingest?: IngestRoutesOptions;
  /** Options for the dashboard routes (clock, projections). Used by tests. */
  dashboard?: DashboardRoutesOptions;
  /**
   * Runs background jobs while the server listens: pending projections, then
   * the session timeout job (see jobs/startup.ts), and the price job when
   * prices are on (jobs/prices.ts), which also fetches when bank data is read.
   * Off by default so tests don't start timers or fetch on reads.
   */
  jobs?: boolean;
  /** Replaces the client for external calls. Used by tests, with a mocked fetch. */
  externalClient?: ExternalClient;
  /**
   * Path of the database file. With `jobs`, the daily backup runs (see
   * jobs/backup.ts). Left out for in-memory databases.
   */
  dbFile?: string;
  /**
   * Folder with the built dashboard (`web/dist`), served on the same port with
   * a fallback to index.html for app routes. Left out in tests that don't need it.
   */
  webDir?: string;
}

// Header values that must never reach the logs, wherever they end up in a log
// object. The address headers too: an IP is only logged on security events
// (auth/security-log.ts).
const REDACTED_PATHS = [
  'authorization',
  'cookie',
  'x-api-key',
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'forwarded',
].flatMap((header) => [
  `req.headers["${header}"]`,
  `headers["${header}"]`,
  `*.headers["${header}"]`,
]);

/**
 * Logs only these request fields, never headers, bodies or the client's
 * address: an IP is only logged on security events (auth/security-log.ts).
 */
function requestSerializer(request: FastifyRequest) {
  return {
    method: request.method,
    url: withoutQuery(request.url),
    host: request.host,
  };
}

/** Builds the app without listening, so tests can use `app.inject`. */
export function buildApp({
  config,
  db,
  logStream,
  ingest = {},
  dashboard = {},
  jobs = false,
  dbFile,
  webDir,
  externalClient,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
      serializers: { req: requestSerializer },
      ...(logStream ? { stream: logStream } : {}),
    },
  });

  app.decorate('db', db.db);
  // Before every other hook and route: the limiters and the network check
  // read the client IP, and every response gets the headers.
  addClientIp(app, config.trustedProxy);
  addSecurityHeaders(app, { publicHost: publicHostOf(config.publicUrl) });

  // Never calls out unless the source's flag and USER_AGENT_CONTACT are set.
  const client = externalClient ?? createExternalClient({ config, log: app.log });
  // Collection log from RuneProfile, only for accounts the owner turned it on for.
  const clogSyncer = createClogSyncer({
    db: db.db,
    config,
    provider: createRuneProfileProvider({ client }),
    log: app.log,
    ...(dashboard.now ? { now: dashboard.now } : {}),
  });

  let backupJob: BackupJob | undefined;
  // Started on listen. Reads of bank data before that (or without `jobs`) fetch nothing.
  let pricesJob: PricesJob | undefined;
  if (jobs) {
    let running: RunningJob | undefined;
    let clogJob: ClogJob | undefined;
    app.addHook('onListen', () => {
      running = startBackgroundJobs({ db: db.db, log: app.log });
      // Does nothing unless PRICES_ENABLED and USER_AGENT_CONTACT are set.
      pricesJob = startPricesJob({
        db: db.db,
        config,
        client,
        log: app.log,
        ...(dashboard.now ? { now: dashboard.now } : {}),
      });
      if (config.runeprofile.enabled && config.userAgentContact === null) {
        app.log.warn(
          {},
          `${EXTERNAL_SOURCES.RUNEPROFILE.envName} is on, but USER_AGENT_CONTACT is not set: collection logs are not fetched`,
        );
      }
      clogJob = startClogJob({ db: db.db, syncer: clogSyncer, log: app.log });
      if (dbFile !== undefined) {
        backupJob = startBackupJob({
          dbFile,
          config: config.backup,
          timeZone: config.timeZone,
          log: app.log,
        });
      }
    });
    // preClose runs before every onClose hook, so the jobs are stopped before
    // the database closes and the instance lock is released.
    app.addHook('preClose', async () => {
      running?.stop();
      pricesJob?.stop();
      clogJob?.stop();
      // A backup still compressing gets a few seconds to finish, then is
      // stopped: it must not rename or prune in BACKUP_DIR once the lock is
      // released (a `restore` may have taken it).
      await backupJob?.shutdown();
    });
  }
  // A sync that is still out makes no further request and stores nothing.
  // It is waited for a few seconds at most, so closing never hangs on it.
  app.addHook('preClose', () => clogSyncer.shutdown());

  app.addHook('onClose', () => {
    db.close();
  });

  app.setErrorHandler((error, request, reply) => {
    const { statusCode, body, retryAfterSeconds } = toErrorResponse(error);
    if (retryAfterSeconds !== undefined)
      void reply.header('retry-after', String(retryAfterSeconds));
    // A `503` the server chose to give (full password queue) is no failure.
    if (statusCode >= 500 && retryAfterSeconds === undefined) {
      request.log.error({ err: error }, 'Request failed');
    } else {
      request.log.info({ statusCode, code: body.error.code }, body.error.message);
    }
    return reply.code(statusCode).send(body);
  });

  // With a web folder, the not-found handler also serves the dashboard app.
  if (webDir === undefined) app.setNotFoundHandler(notFoundHandler);
  else registerWebApp(app, webDir);

  void app.register(healthRoutes, { timeZone: config.timeZone, prefix: '/api/v1' });
  // API keys are only valid here (see
  // docs/decisions/0005-security-defaults.md).
  void app.register(ingestRoutes, { ...ingest, prefix: INGEST_PREFIX });
  // Network checks, login and access levels: auth/dashboard-auth.ts.
  void app.register(dashboardRoutes, {
    ...dashboard,
    // The real server (with a database file) keeps the 2FA key in DATA_DIR;
    // in-memory databases (tests) keep it in memory, never in ./data.
    keyStore:
      dashboard.keyStore ??
      (dbFile === undefined ? memoryKeyStore() : fileKeyStore(config.dataDir)),
    backup: { config: config.backup, state: () => backupJob?.state() },
    config,
    clogSyncer,
    onPricesRead: () => pricesJob?.requested(),
    timeZone: config.timeZone,
    prefix: '/api/v1',
  });

  return app;
}
