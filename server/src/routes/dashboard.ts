import type { FastifyPluginCallback } from 'fastify';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { loadConfig, type Config } from '../config.js';
import { defaultInstanceText } from '../settings/instance-text.js';
import { createPasswordHasher } from '../users/password.js';
import { isSourceActive } from '../external/sources.js';
import { addDashboardAuth } from '../auth/dashboard-auth.js';
import { notFoundHandler } from '../errors.js';
import { publicHostOf } from '../auth/local-only.js';
import { AuthLimiters } from '../auth/login-limiter.js';
import { createSecretBox, memoryKeyStore, type KeyStore } from '../auth/secret-box.js';
import { aboutRoutes } from './about.js';
import { accountRoutes } from './accounts.js';
import { adminKeyRoutes } from './admin-keys.js';
import { authRoutes, type AuthRoutesOptions } from './auth.js';
import { adminRoutes, type AdminRoutesOptions, type BackupRoutesOptions } from './admin.js';
import type { ClogSyncer } from '../clog/sync.js';
import { bankRoutes } from './bank.js';
import { collectionLogRoutes } from './collection-log.js';
import { itemRoutes } from './items.js';
import { inviteRoutes, type InviteRoutesOptions } from './invites.js';
import { keyRoutes } from './keys.js';
import { lootKcRoutes } from './loot-kc.js';
import { feedRoutes } from './feed.js';
import { petRoutes } from './pets.js';
import { questRoutes } from './quests.js';
import { raidSplitRoutes } from './raid-splits.js';
import { raidRoutes } from './raids.js';
import { screentimeRoutes } from './screentime.js';
import { sessionRoutes } from './sessions.js';
import { settingsRoutes } from './settings.js';
import { userRoutes } from './users.js';
import { weeklyRoutes } from './weekly.js';

export interface DashboardRoutesOptions {
  admin?: AdminRoutesOptions;
  /**
   * Login routes: hasher, limiters and the 2FA challenge store. Tests replace
   * them. `limiters` is shared with the invite routes.
   */
  auth?: AuthRoutesOptions;
  /** Invite routes: ID source. Tests replace it. */
  invites?: Pick<InviteRoutesOptions, 'generateId'>;
  /**
   * Where the key for 2FA secrets lives. Set by buildApp: the key file in
   * `DATA_DIR` for the real server, memory otherwise.
   */
  keyStore?: KeyStore;
  /** Set by buildApp from the config and the running backup job. */
  backup?: BackupRoutesOptions;
  /** Set by buildApp. Decides which external sources are on, and the default instance text. */
  config?: Config;
  /** Set by buildApp. Without it the collection log routes are not registered. */
  clogSyncer?: ClogSyncer;
  /**
   * Clock for the read endpoints (current period, end of a series) and for the
   * times stored when a key is created or revoked. Tests inject it.
   */
  now?: Clock;
}

/**
 * Every dashboard endpoint (all of `/api/v1` except health and ingest).
 * Network checks, sessions and access levels in auth/dashboard-auth.ts:
 * every route must declare `config: { access }`. Add new dashboard routes
 * here, so they get the checks.
 */
export const dashboardRoutes: FastifyPluginCallback<
  DashboardRoutesOptions & { timeZone: string }
> = (app, options, done) => {
  addDashboardAuth(app, {
    now: options.now ?? systemClock,
    publicHost: publicHostOf(options.config?.publicUrl),
    trustedProxy: options.config?.trustedProxy ?? null,
  });
  // Unknown paths under /api/v1 get this scope's hook first: the network check,
  // then `401` without a session in login mode, then `404`.
  app.setNotFoundHandler(notFoundHandler);
  // One set of limiters and one key for every auth route: a code on a reset
  // link counts in both `invite:ip` and `totp:user`.
  const limiters = options.auth?.limiters ?? new AuthLimiters({ now: options.now ?? systemClock });
  const secretBox =
    options.auth?.secretBox ?? createSecretBox(options.keyStore ?? memoryKeyStore());
  // One hasher for login, invites, reset links and password changes: at most 4
  // argon2 operations at once and one bounded queue for all of them
  // (users/password.ts).
  const hasher = options.auth?.hasher ?? createPasswordHasher();
  void app.register(authRoutes, {
    ...options.auth,
    hasher,
    limiters,
    secretBox,
    ...(options.now ? { now: options.now } : {}),
  });
  void app.register(adminRoutes, {
    ...options.admin,
    ...(options.backup ? { backup: options.backup } : {}),
    ...(options.config ? { config: options.config } : {}),
    timeZone: options.timeZone,
    prefix: '/admin',
  });
  void app.register(userRoutes, {
    publicUrl: options.config?.publicUrl ?? null,
    ...(options.invites?.generateId ? { generateId: options.invites.generateId } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  void app.register(inviteRoutes, {
    ...options.invites,
    limiters,
    secretBox,
    hasher,
    publicUrl: options.config?.publicUrl ?? null,
    maxUsers: options.config?.maxUsers ?? null,
    ...(options.now ? { now: options.now } : {}),
  });
  void app.register(keyRoutes, options.now ? { now: options.now } : {});
  void app.register(adminKeyRoutes, options.now ? { now: options.now } : {});
  // Built once: the config doesn't change while the server runs.
  const defaultText = defaultInstanceText(options.config ?? loadConfig({}));
  void app.register(settingsRoutes, {
    defaultInstanceText: defaultText,
    ...(options.now ? { now: options.now } : {}),
  });
  void app.register(aboutRoutes, { defaultInstanceText: defaultText });
  void app.register(accountRoutes, {
    timeZone: options.timeZone,
    ...(options.now ? { now: options.now } : {}),
  });
  void app.register(lootKcRoutes, {
    timeZone: options.timeZone,
    ...(options.now ? { now: options.now } : {}),
  });
  void app.register(raidRoutes);
  void app.register(raidSplitRoutes, {
    timeZone: options.timeZone,
    ...(options.now ? { now: options.now } : {}),
  });
  void app.register(bankRoutes, {
    timeZone: options.timeZone,
    currentPrices: options.config ? isSourceActive(options.config, 'WIKI_PRICES') : false,
    ...(options.now ? { now: options.now } : {}),
  });
  void app.register(questRoutes);
  void app.register(petRoutes);
  void app.register(feedRoutes);
  if (options.clogSyncer) {
    void app.register(collectionLogRoutes, {
      syncer: options.clogSyncer,
      ...(options.now ? { now: options.now } : {}),
    });
  }
  void app.register(itemRoutes);
  void app.register(sessionRoutes, {
    timeZone: options.timeZone,
    ...(options.now ? { now: options.now } : {}),
  });
  void app.register(screentimeRoutes, {
    timeZone: options.timeZone,
    ...(options.now ? { now: options.now } : {}),
  });
  void app.register(weeklyRoutes, {
    timeZone: options.timeZone,
    ...(options.now ? { now: options.now } : {}),
  });
  done();
};
