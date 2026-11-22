import { sql } from 'drizzle-orm';
import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// The database. Which tables are raw and which are derived:
// docs/architecture.md#raw-events-and-projections.
// All timestamps are ISO 8601 UTC strings. After changing this file, run
// `pnpm --filter @fireside/server db:generate` and commit the migration.

/**
 * People who can use this instance. Every install has user 1 (`admin`), created by
 * the migration that added this table: everything from before belongs to that
 * user. Users are never shown each other's data.
 */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Unique, lower case. */
  username: text('username').notNull().unique(),
  /** argon2id. `null` in local mode: no login. */
  passwordHash: text('password_hash'),
  /** `admin` or `member`. */
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  canCreateApiKeys: integer('can_create_api_keys', { mode: 'boolean' }).notNull(),
  /**
   * The active TOTP secret, encrypted with the key file (`auth/secret-box.ts`),
   * never in plain text. `null` without 2FA.
   */
  totpSecret: text('totp_secret'),
  /** When 2FA was turned on. `null` = off. */
  totpEnabledAt: text('totp_enabled_at'),
  /** The last accepted TOTP time step, so a code can't be used twice. */
  totpLastStep: integer('totp_last_step'),
  /** A secret being set up, encrypted like `totp_secret`. Valid until `totp_pending_expires_at`. */
  totpPendingSecret: text('totp_pending_secret'),
  totpPendingExpiresAt: text('totp_pending_expires_at'),
  disabledAt: text('disabled_at'),
  createdAt: text('created_at').notNull(),
  lastLoginAt: text('last_login_at'),
});

/**
 * Login sessions. The cookie holds a random token; only its SHA-256 is stored,
 * so a copy of the database can't be used to log in. Rows are deleted on
 * logout, "log out everywhere" and password changes.
 */
export const userSessions = sqliteTable(
  'user_sessions',
  {
    /** SHA-256 (hex) of the session token. */
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    /** Rolling: moved forward by 30 days on use (at most once an hour). */
    expiresAt: text('expires_at').notNull(),
    /** Shortened `User-Agent` at login, so the owner can tell sessions apart. */
    userAgent: text('user_agent'),
  },
  (table) => [index('user_sessions_user_idx').on(table.userId)],
);

/**
 * Recovery codes for 2FA. Only the SHA-256 of each code is stored. A code works
 * once (`used_at`); making new codes deletes the old. Not derived: `rebuild`
 * never touches it. Deleted with the user.
 */
export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 (hex) of the normalised code. */
    codeHash: text('code_hash').notNull().unique(),
    createdAt: text('created_at').notNull(),
    usedAt: text('used_at'),
  },
  (table) => [index('recovery_codes_user_idx').on(table.userId)],
);

/**
 * Browsers a user has fully logged in from. The device cookie holds a random
 * token; only its SHA-256 is stored. A known device skips the per-username
 * login limit, never the per-IP one or 2FA. Deleted on a password change or
 * reset, "log out everywhere", deactivation, an admin turning off 2FA, and with
 * the user.
 */
export const trustedDevices = sqliteTable(
  'trusted_devices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 (hex) of the device token. */
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (table) => [index('trusted_devices_user_idx').on(table.userId)],
);

/**
 * What users and admins did. Never holds
 * secrets: no passwords, tokens, keys or invite links.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: text('at').notNull(),
    /** `null` when done from the CLI on the server itself. */
    actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** E.g. `auth.login`, `user.rename`. */
    action: text('action').notNull(),
    /** What it was done to, e.g. `user:2`. No secrets. */
    target: text('target'),
  },
  (table) => [index('audit_log_at_idx').on(table.at)],
);

/**
 * Invite links and password reset links. The link carries a random token in its
 * fragment; only the token's SHA-256 is stored, so neither the link nor the
 * token can be read back. Rows are never deleted (like API keys), except a
 * reset link together with its target user. Status is worked out when read:
 * revoked, used, expired or active.
 */
export const invites = sqliteTable(
  'invites',
  {
    /** Short, visible, random ID (8 characters of Crockford base32). Not a secret. */
    id: text('id').primaryKey(),
    type: text('type', { enum: ['invite', 'password_reset'] }).notNull(),
    /** SHA-256 (hex) of the token. */
    tokenHash: text('token_hash').notNull().unique(),
    /** The admin's own note, e.g. who it is for. Invites only. */
    label: text('label'),
    /** `null` when the admin who made it has been deleted. */
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    /** Role of the new user. Invites only. */
    role: text('role', { enum: ['admin', 'member'] }),
    /** Key permission of the new user. Invites only. */
    canCreateApiKeys: integer('can_create_api_keys', { mode: 'boolean' }),
    /** The user whose password a reset link sets. Reset links only. */
    targetUserId: integer('target_user_id').references(() => users.id, { onDelete: 'cascade' }),
    usedAt: text('used_at'),
    /** The user the invite became, or who used the reset link. `null` once that user is deleted. */
    usedBy: integer('used_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: text('revoked_at'),
    revokedBy: integer('revoked_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('invites_type_target_idx').on(table.type, table.targetUserId),
    index('invites_created_at_idx').on(table.createdAt),
  ],
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The key's owner: events sent with it belong to this user. */
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    /** Who made the key. `null` when that user has been deleted. */
    createdByUserId: integer('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /**
     * Who revoked the key. `null` while the key is active, and when the user
     * who revoked it has been deleted: `revoked_at` decides whether it is revoked.
     */
    revokedByUserId: integer('revoked_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    /** SHA-256 of the full key. The key itself is never stored. */
    keyHash: text('key_hash').notNull().unique(),
    /** Start of the key, shown in lists so the owner can tell keys apart. */
    prefix: text('prefix').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
    revokedAt: text('revoked_at'),
  },
  (table) => [index('api_keys_user_idx').on(table.userId)],
);

/** Every event as received from the plugin, unchanged. Derived tables are rebuilt from here. */
export const events = sqliteTable(
  'events',
  {
    eventId: text('event_id').primaryKey(),
    /**
     * The owner, from the API key at ingest. Not part of what the plugin
     * sends. `eventId` and `sessionId` stay global: an event that reuses
     * another user's session is rejected (ingest/store.ts).
     */
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    type: text('type').notNull(),
    accountHash: text('account_hash').notNull(),
    sessionId: text('session_id').notNull(),
    occurredAt: text('occurred_at').notNull(),
    receivedAt: text('received_at').notNull(),
    // Keys are revoked, never deleted, so no cascade.
    apiKeyId: integer('api_key_id')
      .notNull()
      .references(() => apiKeys.id),
    schemaVersion: integer('schema_version').notNull(),
    /** The event payload as JSON text. */
    payload: text('payload').notNull(),
    /**
     * When the projections last succeeded for this event. `null` while
     * pending or after a failure. Not part of the raw event.
     */
    processedAt: text('processed_at'),
    /** Last projection error (`<projection>: <message>`), `null` if none. */
    projectionError: text('projection_error'),
  },
  (table) => [
    index('events_occurred_at_idx').on(table.occurredAt),
    // Lookups by account (user and hash, and type) in `(occurred_at, event_id)` order.
    index('events_account_type_occurred_idx').on(
      table.userId,
      table.accountHash,
      table.type,
      table.occurredAt,
      table.eventId,
    ),
    index('events_account_occurred_idx').on(
      table.userId,
      table.accountHash,
      table.occurredAt,
      table.eventId,
    ),
    // Lookups by session (and type), e.g. a session's first `session.start`.
    index('events_session_type_occurred_idx').on(
      table.sessionId,
      table.type,
      table.occurredAt,
      table.eventId,
    ),
    // Small: only events that still need projecting (pending or failed).
    index('events_unprocessed_idx')
      .on(table.eventId)
      .where(sql`${table.processedAt} IS NULL`),
  ],
);

/**
 * Stable account ID per (user, account hash). Not derived and never reset, so
 * an account keeps its ID (used in dashboard URLs) across rebuilds. Two users
 * who send data for the same hash get one account each.
 */
export const accountIds = sqliteTable(
  'account_ids',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    accountHash: text('account_hash').notNull(),
  },
  (table) => [uniqueIndex('account_ids_user_hash_idx').on(table.userId, table.accountHash)],
);

// --- Derived tables. Rebuilt from `events` by the projections. ---------------

/** One row per account with at least one projected event. */
export const accounts = sqliteTable(
  'accounts',
  {
    id: integer('id')
      .primaryKey()
      .references(() => accountIds.id),
    /** Same as in `account_ids`. Here so reads can filter by owner without a join. */
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    accountHash: text('account_hash').notNull(),
    /** From the latest `session.start`. `null` until one has been received. */
    accountType: text('account_type'),
    /** From the latest `session.start`. `null` until one has been received. */
    displayName: text('display_name'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (table) => [uniqueIndex('accounts_user_hash_idx').on(table.userId, table.accountHash)],
);

/** Name history: one row per continuous period with the same display name. */
export const accountNames = sqliteTable(
  'account_names',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    /** `occurred_at` of the period's first `session.start`. */
    firstSeenAt: text('first_seen_at').notNull(),
    /** That event's ID, so periods starting in the same millisecond are ordered. */
    firstEventId: text('first_event_id').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (table) => [
    uniqueIndex('account_names_account_first_seen_idx').on(
      table.accountId,
      table.firstSeenAt,
      table.firstEventId,
    ),
  ],
);

// `session_id` in the XP, loot and KC tables has no foreign key: an event can be projected
// before its session row exists (events arrive in any order).

/** One row per `xp.snapshot` event. Totals count only skills in `SKILLS`. */
export const xpSnapshots = sqliteTable(
  'xp_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    eventId: text('event_id')
      .notNull()
      .unique()
      .references(() => events.eventId),
    sessionId: text('session_id').notNull(),
    takenAt: text('taken_at').notNull(),
    reason: text('reason').notNull(),
    totalXp: integer('total_xp').notNull(),
    totalLevel: integer('total_level').notNull(),
  },
  (table) => [
    // Value at a time: the last snapshot before it, in (`taken_at`, `event_id`) order.
    index('xp_snapshots_account_taken_idx').on(table.accountId, table.takenAt, table.eventId),
    // First and last snapshot of a session (session summaries).
    index('xp_snapshots_session_taken_idx').on(table.sessionId, table.takenAt, table.eventId),
  ],
);

/** Every skill in a snapshot, including unknown extra skills. */
export const xpSnapshotSkills = sqliteTable(
  'xp_snapshot_skills',
  {
    snapshotId: integer('snapshot_id')
      .notNull()
      .references(() => xpSnapshots.id, { onDelete: 'cascade' }),
    skill: text('skill').notNull(),
    xp: integer('xp').notNull(),
    level: integer('level').notNull(),
  },
  (table) => [primaryKey({ columns: [table.snapshotId, table.skill] })],
);

/** One row per `loot` event. `source_name` is `null` for `PLAYER` loot. */
export const lootEvents = sqliteTable(
  'loot_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    eventId: text('event_id')
      .notNull()
      .unique()
      .references(() => events.eventId),
    occurredAt: text('occurred_at').notNull(),
    sourceType: text('source_type').notNull(),
    sourceName: text('source_name'),
    sourceNpcId: integer('source_npc_id'),
    killCount: integer('kill_count'),
    /** Sum of `ge_price_each × quantity` over the items. */
    totalGeValue: integer('total_ge_value').notNull(),
    /** Sum of `ha_price_each × quantity` over the items. */
    totalHaValue: integer('total_ha_value').notNull(),
  },
  (table) => [
    // Drops and loot per day, newest or oldest first, without a sort.
    index('loot_events_account_occurred_idx').on(table.accountId, table.occurredAt, table.eventId),
    // The same for `all`.
    index('loot_events_occurred_idx').on(table.occurredAt, table.eventId),
    index('loot_events_session_idx').on(table.sessionId),
  ],
);

/** Items in a loot event, in payload order. Prices are per item at drop time. */
export const lootItems = sqliteTable(
  'loot_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    lootEventId: integer('loot_event_id')
      .notNull()
      .references(() => lootEvents.id, { onDelete: 'cascade' }),
    /** 0-based index in the payload's `items`. Orders drops within a loot event. */
    position: integer('position').notNull(),
    itemId: integer('item_id').notNull(),
    itemName: text('item_name').notNull(),
    quantity: integer('quantity').notNull(),
    gePriceEach: integer('ge_price_each').notNull(),
    haPriceEach: integer('ha_price_each').notNull(),
  },
  (table) => [
    uniqueIndex('loot_items_loot_event_position_idx').on(table.lootEventId, table.position),
  ],
);

/** KC seen in chat (`kc`) or on a named loot event with `killCount`. `boss` is normalized. */
export const kcObservations = sqliteTable(
  'kc_observations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    eventId: text('event_id')
      .notNull()
      .unique()
      .references(() => events.eventId),
    observedAt: text('observed_at').notNull(),
    boss: text('boss').notNull(),
    killCount: integer('kill_count').notNull(),
    timeSeconds: real('time_seconds'),
    personalBest: integer('personal_best', { mode: 'boolean' }).notNull(),
    /** PB after this kill (`kc.personalBestSeconds`, since 1.14.0), `null` if not sent or from loot. */
    personalBestSeconds: real('personal_best_seconds'),
    /** Players in the raid or group (`kc.teamSize`), `null` if not sent or from loot. */
    teamSize: integer('team_size'),
  },
  (table) => [
    // Last KC before a session, and the next session that saw the boss.
    index('kc_observations_account_boss_observed_idx').on(
      table.accountId,
      table.boss,
      table.observedAt,
      table.eventId,
    ),
    // First observation of a boss in a session.
    index('kc_observations_session_boss_observed_idx').on(
      table.sessionId,
      table.boss,
      table.observedAt,
      table.eventId,
    ),
    // Highest KC of a boss in a session.
    index('kc_observations_session_boss_kc_idx').on(table.sessionId, table.boss, table.killCount),
  ],
);

/**
 * Personal bests from the game's records table (`pb.records`, contract
 * 1.17.0), one row per record per event. Every event's rows are kept; PBs only
 * get faster, so readers take the lowest per key. Only the player's own
 * records.
 */
export const pbRecords = sqliteTable(
  'pb_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.eventId),
    observedAt: text('observed_at').notNull(),
    /** Normalized with `normalizeBossName`, like `kc_observations.boss`. */
    boss: text('boss').notNull(),
    /** `overall` for the whole raid, otherwise the room's name as sent. */
    scope: text('scope').notNull(),
    teamSize: integer('team_size').notNull(),
    seconds: real('seconds').notNull(),
  },
  (table) => [
    // The contract allows each (scope, team size) once per event.
    uniqueIndex('pb_records_event_scope_team_size_idx').on(
      table.eventId,
      table.scope,
      table.teamSize,
    ),
    // Best per (boss, scope, team size) for an account.
    index('pb_records_account_boss_scope_idx').on(
      table.accountId,
      table.boss,
      table.scope,
      table.teamSize,
    ),
  ],
);

/**
 * Raid purples, one row per drop. Rebuilt per session from `raid.special_loot`
 * events and purple items in the session's raid loot. A `SELF` event and a loot
 * purple of the same raid and item are one drop: the row then has both
 * `special_event_id` and `loot_event_id`. Teammates are never named:
 * `recipient` is `SELF` or `TEAMMATE`.
 */
export const raidSpecialLoot = sqliteTable(
  'raid_special_loot',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    /** From the `raid.special_loot` event if there is one, else from the loot event. */
    occurredAt: text('occurred_at').notNull(),
    /** Normalized raid mode (e.g. "Tombs of Amascut: Expert Mode"). */
    raid: text('raid').notNull(),
    /** The raid the mode belongs to (`RAIDS`), e.g. "Tombs of Amascut". */
    raidGroup: text('raid_group').notNull(),
    itemId: integer('item_id').notNull(),
    itemName: text('item_name').notNull(),
    quantity: integer('quantity').notNull(),
    gePriceEach: integer('ge_price_each').notNull(),
    /** `SELF` or `TEAMMATE`. */
    recipient: text('recipient').notNull(),
    teamSize: integer('team_size'),
    killCount: integer('kill_count'),
    /** The `raid.special_loot` event, `null` for a loot purple without one. */
    specialEventId: text('special_event_id')
      .unique()
      .references(() => events.eventId),
    /** The `loot` event with the same drop, `null` if none (always for `TEAMMATE`). */
    lootEventId: text('loot_event_id').references(() => events.eventId),
    /** The item's `loot_items.position` in that loot event. */
    lootItemPosition: integer('loot_item_position'),
  },
  (table) => [
    uniqueIndex('raid_special_loot_loot_item_idx').on(table.lootEventId, table.lootItemPosition),
    index('raid_special_loot_account_occurred_idx').on(table.accountId, table.occurredAt),
    index('raid_special_loot_session_idx').on(table.sessionId),
  ],
);

/**
 * One row per session with at least one projected `session.*` event. Every
 * column is recomputed from the session's events (and the clock, for
 * `timeout`). See docs/architecture.md#sessions.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    /** `sessionId` from the plugin. */
    id: text('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** First `session.start`, or the earliest session event if none. */
    startedAt: text('started_at').notNull(),
    /** `null` while the session is open. */
    endedAt: text('ended_at'),
    /** `logout`, `client_closed`, `hop` or `timeout`. `null` while open. */
    endReason: text('end_reason'),
    /** World at start (or first heartbeat). `null` if neither has arrived. */
    world: integer('world'),
    /** Latest heartbeat, or `started_at` if there is none later. */
    lastHeartbeatAt: text('last_heartbeat_at').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    afkSeconds: integer('afk_seconds').notNull(),
    activeSeconds: integer('active_seconds').notNull(),
  },
  (table) => [
    index('sessions_account_started_idx').on(table.accountId, table.startedAt),
    // Small: only open sessions, for the timeout job.
    index('sessions_open_heartbeat_idx')
      .on(table.lastHeartbeatAt)
      .where(sql`${table.endedAt} IS NULL`),
  ],
);

/** One row per `session.heartbeat` event. */
export const sessionHeartbeats = sqliteTable(
  'session_heartbeats',
  {
    eventId: text('event_id')
      .primaryKey()
      .references(() => events.eventId),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    at: text('at').notNull(),
    regionId: integer('region_id').notNull(),
    world: integer('world').notNull(),
    /** RuneLite `WorldType` names as a JSON array. */
    worldTypes: text('world_types').notNull(),
    worldLocation: text('world_location'),
    worldActivity: text('world_activity'),
    idle: integer('idle', { mode: 'boolean' }).notNull(),
  },
  (table) => [index('session_heartbeats_session_at_idx').on(table.sessionId, table.at)],
);

/** One row per `session.afk` event, as sent (not clipped to the session). */
export const sessionAfkPeriods = sqliteTable(
  'session_afk_periods',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: text('event_id')
      .notNull()
      .unique()
      .references(() => events.eventId),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at').notNull(),
  },
  (table) => [index('session_afk_periods_session_idx').on(table.sessionId)],
);

/**
 * One row per closed session, removed if it reopens. Built from the session's
 * XP snapshots, loot events and KC observations. See
 * docs/architecture.md#sessions.
 */
export const sessionSummaries = sqliteTable('session_summaries', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  xpGainedTotal: integer('xp_gained_total').notNull(),
  /** JSON object, skill → XP gained. Only skills with a gain, sorted by key. */
  xpGainedBySkill: text('xp_gained_by_skill').notNull(),
  /** Sum of `loot_events.total_ge_value`. */
  lootGeValue: integer('loot_ge_value').notNull(),
  /** Number of loot events. */
  lootCount: integer('loot_count').notNull(),
  /** JSON object, normalized boss name → KC gained. Every boss seen, sorted by key. */
  kcGainedByBoss: text('kc_gained_by_boss').notNull(),
});

/**
 * Stored weekly summaries of completed weeks, one row per account and local
 * ISO week. Filled when a completed week is first read; rows are deleted by
 * the weekly summaries projection when an event can change them, and emptied
 * by `rebuild`.
 */
export const weeklySummaries = sqliteTable(
  'weekly_summaries',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Local ISO week, e.g. `2026-W45`. */
    isoWeek: text('iso_week').notNull(),
    /** Monday 00:00 local time, in UTC. A row whose bounds differ from `TZ` is stale. */
    start: text('start').notNull(),
    /** Next Monday 00:00 local time, in UTC (exclusive). */
    end: text('end').notNull(),
    /** JSON, internal mergeable format (`AccountWeek` in server/src/read/weekly.ts). */
    data: text('data').notNull(),
    computedAt: text('computed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.isoWeek] }),
    // Invalidation deletes an account's weeks that end after an event.
    index('weekly_summaries_account_end_idx').on(table.accountId, table.end),
  ],
);

/**
 * Item icons uploaded by the plugin. Assets, not game events: never stored in
 * `events`, not a projection, so `rebuild` never touches this table. Keyed by
 * the exact item ID used in events (noted items included); the server never
 * maps IDs. Jagex graphics: they live only in the user's own database.
 */
export const itemIcons = sqliteTable('item_icons', {
  itemId: integer('item_id').primaryKey(),
  /** PNG bytes as uploaded, checked by `checkPng` and never re-encoded. */
  png: blob('png', { mode: 'buffer' }).notNull(),
  /** SHA-256 (hex) of `png`. Same hash on upload = unchanged. Also the ETag. */
  sha256: text('sha256').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Skill and boss/raid icons uploaded by the plugin. Assets like `item_icons`:
 * never derived from events and never touched by `rebuild`.
 */
export const namedIcons = sqliteTable(
  'named_icons',
  {
    /** `SKILL` or `BOSS`. */
    kind: text('kind').notNull(),
    /** Skill name (`ATTACK`), or boss name normalized with `normalizeBossName`. */
    key: text('key').notNull(),
    png: blob('png', { mode: 'buffer' }).notNull(),
    sha256: text('sha256').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.key] })],
);

// --- External sources and GE prices -------------------------------- Not derived
// from events: no projection writes or resets these tables, so they survive
// `rebuild`.

/**
 * One row per external source that has been called (external/sources.ts).
 * `last_attempt_at` is what keeps a source to its schedule across restarts.
 */
export const externalSources = sqliteTable('external_sources', {
  source: text('source').primaryKey(),
  lastAttemptAt: text('last_attempt_at'),
  lastSuccessAt: text('last_success_at'),
  /** From the latest attempt if it failed. Cleared by the next success. */
  lastError: text('last_error'),
  lastErrorAt: text('last_error_at'),
});

/**
 * Settings for the whole server that the admin changes in the dashboard
 * (settings/settings.ts). One row per setting that has been set; a missing row
 * means the default. `value` is JSON. Not user data.
 */
export const serverSettings = sqliteTable('server_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Latest Grand Exchange prices from the OSRS Wiki, by item ID as the wiki
 * gives it (un-noted items only). A row is kept until a newer fetch has the
 * item again, so a failed or partial fetch never removes a price.
 */
export const itemPrices = sqliteTable('item_prices', {
  itemId: integer('item_id').primaryKey(),
  /** Latest instant-buy price and when it happened. `null` if never seen. */
  high: integer('high'),
  highTime: text('high_time'),
  /** Latest instant-sell price and when it happened. `null` if never seen. */
  low: integer('low'),
  lowTime: text('low_time'),
  /** When the server fetched this row. */
  fetchedAt: text('fetched_at').notNull(),
});

/**
 * Earlier Grand Exchange prices, for Price movers: one row per item per stored
 * fetch, written with `item_prices` from the same response. The newest 48
 * fetches are kept, and the newest 35 first-fetches-of-a-UTC-day
 * (prices/history.ts prunes by count when a fetch is stored, never on read and
 * never by the clock). "Newest" is by `seq`, the order the fetches were stored
 * in, not by `fetched_at`: a clock that was ahead for a while must not make its
 * fetches outrank the real ones that follow. Not derived from events and not
 * raw data: `rebuild` never touches it, and it cannot be fetched again. No
 * personal data.
 */
export const itemPriceHistory = sqliteTable(
  'item_price_history',
  {
    /** When the server fetched the prices: the same for every item of a fetch. */
    fetchedAt: text('fetched_at').notNull(),
    itemId: integer('item_id').notNull(),
    high: integer('high'),
    low: integer('low'),
    /** Which stored fetch this was, counting up from 1: the same for every item of a fetch. */
    seq: integer('seq').notNull(),
  },
  // Time first: rows are appended in order and a baseline is one fetch.
  (table) => [primaryKey({ columns: [table.fetchedAt, table.itemId] })],
);

// --- Bank and potion storage --------------------------- Every snapshot keeps
// a row with its totals (for history). Items are stored only for each account's
// latest snapshot and replaced when a newer one is projected; a late, older
// snapshot adds only its totals row. The result depends only on the set of
// events, so rebuild gives the same tables.

/** One row per `bank.snapshot` event. Values are capped at 2^53 − 1. */
export const bankSnapshots = sqliteTable(
  'bank_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    eventId: text('event_id')
      .notNull()
      .unique()
      .references(() => events.eventId),
    takenAt: text('taken_at').notNull(),
    contentHash: text('content_hash').notNull(),
    /** JSON array of the 9 tab sizes (tabs 1–9). */
    tabSizes: text('tab_sizes').notNull(),
    /** Bank items only. */
    totalGe: integer('total_ge').notNull(),
    totalHa: integer('total_ha').notNull(),
    inventoryGe: integer('inventory_ge').notNull(),
    inventoryHa: integer('inventory_ha').notNull(),
    equipmentGe: integer('equipment_ge').notNull(),
    equipmentHa: integer('equipment_ha').notNull(),
    /** Coins + platinum tokens × 1 000 in the bank and the inventory. */
    cash: integer('cash').notNull(),
  },
  (table) => [
    // Latest snapshot per account and history, without a sort.
    index('bank_snapshots_account_taken_idx').on(table.accountId, table.takenAt, table.eventId),
  ],
);

/** Bank slots of each account's latest snapshot only, in container order. */
export const bankSnapshotItems = sqliteTable(
  'bank_snapshot_items',
  {
    snapshotId: integer('snapshot_id')
      .notNull()
      .references(() => bankSnapshots.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    /** 1–9, or 0 for the main tab. */
    tab: integer('tab').notNull(),
    itemId: integer('item_id').notNull(),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull(),
    placeholder: integer('placeholder', { mode: 'boolean' }).notNull(),
    geEach: integer('ge_each').notNull(),
    haEach: integer('ha_each').notNull(),
  },
  (table) => [primaryKey({ columns: [table.snapshotId, table.position] })],
);

/** Inventory and equipment of each account's latest bank snapshot only. */
export const containerSnapshotItems = sqliteTable(
  'container_snapshot_items',
  {
    snapshotId: integer('snapshot_id')
      .notNull()
      .references(() => bankSnapshots.id, { onDelete: 'cascade' }),
    /** `INVENTORY` or `EQUIPMENT`. */
    container: text('container', { enum: ['INVENTORY', 'EQUIPMENT'] }).notNull(),
    /** Index in the payload's list. */
    position: integer('position').notNull(),
    /** Equipment slot name; `null` for inventory. */
    slot: text('slot'),
    itemId: integer('item_id').notNull(),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull(),
    geEach: integer('ge_each').notNull(),
    haEach: integer('ha_each').notNull(),
  },
  (table) => [primaryKey({ columns: [table.snapshotId, table.container, table.position] })],
);

/** One row per `potion_storage.snapshot` event. */
export const potionStorageSnapshots = sqliteTable(
  'potion_storage_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    eventId: text('event_id')
      .notNull()
      .unique()
      .references(() => events.eventId),
    takenAt: text('taken_at').notNull(),
    contentHash: text('content_hash').notNull(),
    totalGe: integer('total_ge').notNull(),
    totalHa: integer('total_ha').notNull(),
  },
  (table) => [
    index('potion_storage_snapshots_account_taken_idx').on(
      table.accountId,
      table.takenAt,
      table.eventId,
    ),
  ],
);

/** Potions of each account's latest potion storage snapshot only. */
export const potionStorageItems = sqliteTable(
  'potion_storage_items',
  {
    snapshotId: integer('snapshot_id')
      .notNull()
      .references(() => potionStorageSnapshots.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    /** Potion name as sent, e.g. "Super combat potion". */
    potion: text('potion').notNull(),
    /** The full item (usually the 4-dose) the prices are for. */
    itemId: integer('item_id').notNull(),
    doses: integer('doses').notNull(),
    /** Doses in item `item_id`, usually 4. */
    itemDoses: integer('item_doses').notNull(),
    geEach: integer('ge_each').notNull(),
    haEach: integer('ha_each').notNull(),
  },
  (table) => [primaryKey({ columns: [table.snapshotId, table.position] })],
);

/** One row per `quests.snapshot` event (history; gives the latest and the earliest). */
export const questSnapshots = sqliteTable(
  'quest_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    eventId: text('event_id')
      .notNull()
      .unique()
      .references(() => events.eventId),
    takenAt: text('taken_at').notNull(),
    questPoints: integer('quest_points').notNull(),
  },
  (table) => [
    index('quest_snapshots_account_taken_idx').on(table.accountId, table.takenAt, table.eventId),
  ],
);

/** Quests and miniquests of each account's latest `quests.snapshot` only. */
export const questStates = sqliteTable(
  'quest_states',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** RuneLite `Quest` enum name, as sent. */
    quest: text('quest').notNull(),
    name: text('name').notNull(),
    state: text('state', { enum: ['NOT_STARTED', 'IN_PROGRESS', 'FINISHED'] }).notNull(),
    /** `null` when the plugin sent no kind (counted as a quest). */
    kind: text('kind', { enum: ['QUEST', 'MINIQUEST'] }),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.quest] })],
);

/**
 * The earliest snapshot, by (`first_finished_at`, `event_id`), that showed the
 * quest as finished. Whether that is a real date or "finished before tracking"
 * is decided when reading (server/src/read/quests.ts).
 */
export const questCompletions = sqliteTable(
  'quest_completions',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    quest: text('quest').notNull(),
    firstFinishedAt: text('first_finished_at').notNull(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.eventId),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.quest] })],
);

/** One row per `diaries.snapshot` event. */
export const diarySnapshots = sqliteTable(
  'diary_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    eventId: text('event_id')
      .notNull()
      .unique()
      .references(() => events.eventId),
    takenAt: text('taken_at').notNull(),
  },
  (table) => [
    index('diary_snapshots_account_taken_idx').on(table.accountId, table.takenAt, table.eventId),
  ],
);

/** Diary tiers of each account's latest `diaries.snapshot` only. */
export const diaryStates = sqliteTable(
  'diary_states',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Region key, as sent. */
    region: text('region').notNull(),
    tier: text('tier', { enum: ['EASY', 'MEDIUM', 'HARD', 'ELITE'] }).notNull(),
    completed: integer('completed', { mode: 'boolean' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.region, table.tier] })],
);

/** The earliest snapshot that showed the tier as completed (see `questCompletions`). */
export const diaryCompletions = sqliteTable(
  'diary_completions',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    region: text('region').notNull(),
    tier: text('tier', { enum: ['EASY', 'MEDIUM', 'HARD', 'ELITE'] }).notNull(),
    firstCompletedAt: text('first_completed_at').notNull(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.eventId),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.region, table.tier] })],
);

export type UserRow = typeof users.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type TrustedDeviceRow = typeof trustedDevices.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type NewApiKeyRow = typeof apiKeys.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type AccountRow = typeof accounts.$inferSelect;
export type AccountNameRow = typeof accountNames.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionSummaryRow = typeof sessionSummaries.$inferSelect;
export type WeeklySummaryRow = typeof weeklySummaries.$inferSelect;

// --- Raid loot split tracker ------------------------------------- The user's
// own choices, entered in the dashboard. Not derived: no projection writes or
// resets these tables, so they survive `rebuild`. Account columns point at
// `account_ids` (kept across rebuilds), not at `accounts`.
//
// `nickname` and `note` are the user's own notes. They are never sent by the
// plugin, never logged and never part of an export or the seed data.

/** An account's default mode, `SPLIT` or `FFA`. No row means `SPLIT`. */
export const raidSplitDefaults = sqliteTable('raid_split_defaults', {
  accountId: integer('account_id')
    .primaryKey()
    .references(() => accountIds.id),
  mode: text('mode').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * The user's choices for one detected purple, keyed by the drop's event: the
 * `raid.special_loot` event with index 0, or for a purple only seen in the
 * chest the `loot` event and the item's position. A chest purple whose
 * `SELF` event arrives later is looked up by both keys.
 */
export const raidDropChoices = sqliteTable(
  'raid_drop_choices',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.eventId),
    itemIndex: integer('item_index').notNull(),
    /** `SPLIT` or `FFA`; `null` uses the account default. */
    mode: text('mode'),
    /** What the drop sold for, in gp; `null` uses the GE value. */
    ownValue: integer('own_value'),
    /** 1–100; `null` uses the event's `teamSize`. */
    partySize: integer('party_size'),
    nickname: text('nickname'),
    note: text('note'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.itemIndex] })],
);

/**
 * A teammate's purple the user added by hand (the game showed no message).
 * Never a raw event. Carries its own choices. The GE price is the latest one
 * in the user's own data when the drop was added, and is never changed
 * afterwards, so a share doesn't move when new data arrives.
 */
export const raidManualDrops = sqliteTable(
  'raid_manual_drops',
  {
    /** UUIDv7 made by the server. */
    id: text('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accountIds.id),
    occurredAt: text('occurred_at').notNull(),
    /** Normalized raid mode. */
    raid: text('raid').notNull(),
    raidGroup: text('raid_group').notNull(),
    itemId: integer('item_id').notNull(),
    itemName: text('item_name').notNull(),
    /**
     * `SELF` or `TEAMMATE`, never a name. Set when the drop is added and never
     * changed. Rows from before own manual drops are teammates'.
     */
    recipient: text('recipient').notNull().default('TEAMMATE'),
    /** Set when the drop is added; `null` (with the two below) if no price was known then. */
    gePriceEach: integer('ge_price_each'),
    /** `SPECIAL_LOOT`, `LOOT` or `BANK`: where the price was found. */
    gePriceSource: text('ge_price_source'),
    /** When that price was seen. */
    gePriceAt: text('ge_price_at'),
    mode: text('mode'),
    ownValue: integer('own_value'),
    partySize: integer('party_size'),
    nickname: text('nickname'),
    note: text('note'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('raid_manual_drops_account_occurred_idx').on(table.accountId, table.occurredAt),
  ],
);

// --- Collection log from an external source ------------------------

/**
 * Raw data from external sources, stored unchanged: one row per response
 * whose content differs from the account's latest row of the same kind. This
 * is to external data what `events` is to plugin data: nothing here is
 * derived, `rebuild` never changes it, and the `clog_*` tables can always be
 * built again from it, in `id` order. The name that was looked up is not
 * stored.
 */
export const externalSnapshots = sqliteTable(
  'external_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** An `ExternalSourceId`, e.g. `RUNEPROFILE`. */
    source: text('source').notNull(),
    /** `COLLECTION_LOG` or `ACTIVITIES`. */
    kind: text('kind').notNull(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accountIds.id),
    fetchedAt: text('fetched_at').notNull(),
    /** `sha256:` and 64 hex characters, of the body's bytes. */
    contentHash: text('content_hash').notNull(),
    /** The response body exactly as received. */
    body: text('body').notNull(),
  },
  (table) => [
    index('external_snapshots_account_kind_idx').on(table.accountId, table.kind, table.id),
  ],
);

/**
 * Raw: one row per successful collection log read of an account, also when
 * the body was unchanged (and so not stored in `external_snapshots`). Written
 * by the sync, never by `rebuild`, and deleted with the user, like
 * `external_snapshots`. Gives the time before which an item first seen by a
 * later read cannot have dropped, so it is tied to a session only when no
 * other session lies between the two reads. Only the account and the time.
 */
export const clogReads = sqliteTable(
  'clog_reads',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => accountIds.id),
    readAt: text('read_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.readAt] })],
);

/**
 * The owner's choice of collection log source per account, and how the latest
 * sync went. Not derived: no rebuild touches it. An account is only ever
 * looked up while it has a row here with `enabled`. Turning the source off
 * keeps the row, so turning it on again goes on from the same state (the
 * minute limit, the feed and the name guard are not reset).
 */
export const accountClogSources = sqliteTable('account_clog_sources', {
  accountId: integer('account_id')
    .primaryKey()
    .references(() => accountIds.id),
  /** A `ClogSource`, e.g. `RUNEPROFILE`. */
  source: text('source').notNull(),
  /** `false` after the owner turned the source off. */
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  /** When the source was last turned on. A running sync from before it is discarded. */
  enabledAt: text('enabled_at').notNull(),
  /** Written before the request, so a crash mid-sync still counts. */
  lastAttemptAt: text('last_attempt_at'),
  lastSuccessAt: text('last_success_at'),
  /** The latest sync that stored a new collection log. */
  lastChangedAt: text('last_changed_at'),
  /** A `ClogSyncStatus` from the latest attempt. `null` before the first. */
  status: text('status'),
  /**
   * `first_seen_at` of the name period (`account_names`) whose profile has
   * passed the name guard. The guard runs again when the period changes.
   */
  verifiedNamePeriod: text('verified_name_period'),
  /**
   * When the source's activity feed was last read without errors. `null`
   * until its history has been read (at the first sync that works).
   */
  feedSyncedAt: text('feed_synced_at'),
});

/** Derived: one row per stored `COLLECTION_LOG` snapshot, with unique counts. */
export const clogSnapshots = sqliteTable(
  'clog_snapshots',
  {
    snapshotId: integer('snapshot_id')
      .primaryKey()
      .references(() => externalSnapshots.id),
    accountId: integer('account_id')
      .notNull()
      .references(() => accountIds.id),
    source: text('source').notNull(),
    takenAt: text('taken_at').notNull(),
    obtained: integer('obtained').notNull(),
    total: integer('total').notNull(),
  },
  (table) => [index('clog_snapshots_account_idx').on(table.accountId, table.snapshotId)],
);

/**
 * Derived: every item of the account's latest snapshot, missing ones
 * (`quantity` 0) included, in the game's order. An item on several pages has
 * a row per page.
 */
export const clogItems = sqliteTable(
  'clog_items',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => accountIds.id),
    tabPosition: integer('tab_position').notNull(),
    pagePosition: integer('page_position').notNull(),
    position: integer('position').notNull(),
    tab: text('tab').notNull(),
    page: text('page').notNull(),
    itemId: integer('item_id').notNull(),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.accountId, table.tabPosition, table.pagePosition, table.position],
    }),
  ],
);

/**
 * Derived: every item an account has had in a snapshot, and when it first
 * appeared. `first_seen_at` is `null` for items in the account's first
 * snapshot (obtained before tracking), the snapshot's time with `approximate`
 * for items new in a later snapshot, and the activity feed's time when the
 * feed has the item. A row is never removed by a later snapshot.
 */
export const clogObtained = sqliteTable(
  'clog_obtained',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => accountIds.id),
    itemId: integer('item_id').notNull(),
    firstSeenAt: text('first_seen_at'),
    approximate: integer('approximate', { mode: 'boolean' }).notNull(),
    /** The snapshot that first had the item. */
    snapshotId: integer('snapshot_id')
      .notNull()
      .references(() => externalSnapshots.id),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.itemId] }),
    // Items first seen in a time span (sessions, the feed).
    index('clog_obtained_account_first_seen_idx').on(table.accountId, table.firstSeenAt),
  ],
);

/** Derived: the earliest "new item" time per item in the stored activity feed pages. */
export const clogFeedTimes = sqliteTable(
  'clog_feed_times',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => accountIds.id),
    itemId: integer('item_id').notNull(),
    obtainedAt: text('obtained_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.itemId] })],
);

/**
 * Derived: one row per `pet.drop` event, `DUPLICATE` messages and drops
 * without a guessed pet included. `account_pets` is built from these rows and
 * the collection log (server/src/pets/merge.ts).
 */
export const petDrops = sqliteTable(
  'pet_drops',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    eventId: text('event_id')
      .notNull()
      .unique()
      .references(() => events.eventId),
    occurredAt: text('occurred_at').notNull(),
    /** A `PetMessage`: which known chat message it was. Never the chat text. */
    message: text('message', { enum: ['FOLLOWED', 'BACKPACK', 'DUPLICATE'] }).notNull(),
    /** The plugin's guess. Both `null` when it could not tell. */
    petItemId: integer('pet_item_id'),
    petName: text('pet_name'),
    /** The plugin's guess of the source. Both `null` when it could not tell. */
    sourceType: text('source_type', { enum: ['ACTIVITY', 'SKILL'] }),
    sourceName: text('source_name'),
  },
  (table) => [
    index('pet_drops_account_occurred_idx').on(table.accountId, table.occurredAt, table.eventId),
  ],
);

/**
 * Derived: the pets an account has, merged from the collection log ("All
 * Pets") and `pet_drops`. One row per pet, so a duplicate can never count.
 * Rebuilt per account whenever either source changes.
 */
export const accountPets = sqliteTable(
  'account_pets',
  {
    // Not `accounts.id`: a collection log can outlive the account's events.
    accountId: integer('account_id')
      .notNull()
      .references(() => accountIds.id),
    /** The pet's collection log item. */
    petItemId: integer('pet_item_id').notNull(),
    name: text('name').notNull(),
    /** The chat drop's time, else the collection log's first-seen time. `null` when unknown. */
    obtainedAt: text('obtained_at'),
    /** `true` when `obtained_at` is the time of a collection log sync. */
    approximate: integer('approximate', { mode: 'boolean' }).notNull(),
    sourceType: text('source_type', { enum: ['ACTIVITY', 'SKILL'] }),
    sourceName: text('source_name'),
    /** `false` until the collection log has the pet. */
    confirmed: integer('confirmed', { mode: 'boolean' }).notNull(),
    /** `CHAT` when a `pet.drop` gave the time and source, else `CLOG`. */
    origin: text('origin', { enum: ['CLOG', 'CHAT'] }).notNull(),
    /** The `pet.drop` event behind a `CHAT` pet. */
    eventId: text('event_id').references(() => events.eventId),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.petItemId] })],
);
