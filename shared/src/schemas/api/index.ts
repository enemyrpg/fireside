import type { z } from 'zod';
import { aboutResponseSchema } from './about.js';
import {
  backupStatusResponseSchema,
  externalSourcesResponseSchema,
  rebuildResponseSchema,
} from './admin.js';
import { accountDetailResponseSchema, accountsResponseSchema } from './accounts.js';
import {
  bankHistoryResponseSchema,
  bankResponseSchema,
  bankSummaryResponseSchema,
  potionStorageResponseSchema,
  priceMoversResponseSchema,
} from './bank.js';
import {
  collectionLogResponseSchema,
  collectionLogSourceRequestSchema,
  collectionLogStatusResponseSchema,
  collectionLogSyncResponseSchema,
} from './collection-log.js';
import { errorResponseSchema } from './common.js';
import { healthResponseSchema } from './health.js';
import {
  iconsUploadRequestSchema,
  iconsStatusResponseSchema,
  iconsUploadResponseSchema,
  iconsWantedRequestSchema,
  iconsWantedResponseSchema,
  iconUploadSchema,
} from './icons.js';
import { ingestRequestSchema, ingestResponseSchema, ingestVerifyResponseSchema } from './ingest.js';
import { kcResponseSchema } from './kc.js';
import {
  authMeResponseSchema,
  changePasswordRequestSchema,
  loginRequestSchema,
  loginResponseSchema,
  loginTotpRequestSchema,
  recoveryCodesResponseSchema,
  totpConfirmRequestSchema,
  totpEnableRequestSchema,
  totpSetupRequestSchema,
  totpSetupResponseSchema,
  twoFactorStatusResponseSchema,
} from './auth.js';
import {
  acceptInviteRequestSchema,
  acceptInviteResponseSchema,
  createdInviteResponseSchema,
  createInviteRequestSchema,
  inviteLookupRequestSchema,
  inviteLookupResponseSchema,
  invitesResponseSchema,
  passwordResetRequestSchema,
} from './invites.js';
import {
  adminKeysResponseSchema,
  createKeyRequestSchema,
  createKeyResponseSchema,
  createUserKeyResponseSchema,
  keysResponseSchema,
} from './keys.js';
import { dropsResponseSchema, lootResponseSchema } from './loot.js';
import { feedResponseSchema } from './feed.js';
import { petsResponseSchema } from './pets.js';
import { diariesResponseSchema, questsResponseSchema } from './quests.js';
import { raidsResponseSchema } from './raids.js';
import {
  raidDropCreateRequestSchema,
  raidDropResponseSchema,
  raidDropUpdateRequestSchema,
  raidSplitDefaultRequestSchema,
  raidSplitDefaultResponseSchema,
  raidSplitsResponseSchema,
} from './raid-splits.js';
import {
  calendarResponseSchema,
  sessionDetailResponseSchema,
  sessionsResponseSchema,
} from './sessions.js';
import {
  screentimeHeatmapResponseSchema,
  screentimeResponseSchema,
  screentimeWorldsResponseSchema,
} from './screentime.js';
import {
  deleteAccountRequestSchema,
  managedUserSchema,
  updateUserRequestSchema,
  usersResponseSchema,
} from './users.js';
import { serverSettingsSchema, updateServerSettingsRequestSchema } from './settings.js';
import { weeklyResponseSchema } from './weekly.js';
import { gainsResponseSchema, xpResponseSchema } from './xp.js';

export * from './accounts.js';
export * from './admin.js';
export * from './auth.js';
export * from './bank.js';
export * from './collection-log.js';
export * from './common.js';
export * from './feed.js';
export * from './about.js';
export * from './health.js';
export * from './icons.js';
export * from './ingest.js';
export * from './invites.js';
export * from './kc.js';
export * from './keys.js';
export * from './loot.js';
export * from './pets.js';
export * from './quests.js';
export * from './raids.js';
export * from './raid-splits.js';
export * from './screentime.js';
export * from './sessions.js';
export * from './settings.js';
export * from './users.js';
export * from './weekly.js';
export * from './xp.js';

/**
 * All JSON bodies in the API (request bodies and responses), by name.
 * Each name has fixtures in `fixtures/api/<name>/`. Query and path schemas
 * are left out: they parse strings, not JSON.
 */
export const API_SCHEMAS = {
  'ingest-verify-response': ingestVerifyResponseSchema,
  'ingest-request': ingestRequestSchema,
  'ingest-response': ingestResponseSchema,
  'ingest-icons-wanted-request': iconsWantedRequestSchema,
  'ingest-icons-wanted-response': iconsWantedResponseSchema,
  'ingest-icons-request': iconsUploadRequestSchema,
  'ingest-icon': iconUploadSchema,
  'ingest-icons-response': iconsUploadResponseSchema,
  'error-response': errorResponseSchema,
  'health-response': healthResponseSchema,
  'about-response': aboutResponseSchema,
  'accounts-response': accountsResponseSchema,
  'account-detail-response': accountDetailResponseSchema,
  'xp-response': xpResponseSchema,
  'gains-response': gainsResponseSchema,
  'loot-response': lootResponseSchema,
  'drops-response': dropsResponseSchema,
  'kc-response': kcResponseSchema,
  'raids-response': raidsResponseSchema,
  'raid-splits-response': raidSplitsResponseSchema,
  'raid-split-default-request': raidSplitDefaultRequestSchema,
  'raid-split-default-response': raidSplitDefaultResponseSchema,
  'raid-drop-update-request': raidDropUpdateRequestSchema,
  'raid-drop-create-request': raidDropCreateRequestSchema,
  'raid-drop-response': raidDropResponseSchema,
  'sessions-response': sessionsResponseSchema,
  'session-detail-response': sessionDetailResponseSchema,
  'calendar-response': calendarResponseSchema,
  'screentime-response': screentimeResponseSchema,
  'screentime-worlds-response': screentimeWorldsResponseSchema,
  'screentime-heatmap-response': screentimeHeatmapResponseSchema,
  'weekly-response': weeklyResponseSchema,
  'bank-response': bankResponseSchema,
  'bank-history-response': bankHistoryResponseSchema,
  'bank-summary-response': bankSummaryResponseSchema,
  'price-movers-response': priceMoversResponseSchema,
  'potion-storage-response': potionStorageResponseSchema,
  'quests-response': questsResponseSchema,
  'diaries-response': diariesResponseSchema,
  'collection-log-response': collectionLogResponseSchema,
  'collection-log-status-response': collectionLogStatusResponseSchema,
  'collection-log-source-request': collectionLogSourceRequestSchema,
  'collection-log-sync-response': collectionLogSyncResponseSchema,
  'pets-response': petsResponseSchema,
  'feed-response': feedResponseSchema,
  'rebuild-response': rebuildResponseSchema,
  'backup-status-response': backupStatusResponseSchema,
  'external-sources-response': externalSourcesResponseSchema,
  'icons-status-response': iconsStatusResponseSchema,
  'keys-response': keysResponseSchema,
  'create-key-request': createKeyRequestSchema,
  'create-key-response': createKeyResponseSchema,
  'admin-keys-response': adminKeysResponseSchema,
  'create-user-key-response': createUserKeyResponseSchema,
  'server-settings-response': serverSettingsSchema,
  'update-server-settings-request': updateServerSettingsRequestSchema,
  'auth-me-response': authMeResponseSchema,
  'login-request': loginRequestSchema,
  'login-response': loginResponseSchema,
  'change-password-request': changePasswordRequestSchema,
  'login-totp-request': loginTotpRequestSchema,
  'two-factor-status-response': twoFactorStatusResponseSchema,
  'totp-setup-request': totpSetupRequestSchema,
  'totp-setup-response': totpSetupResponseSchema,
  'totp-enable-request': totpEnableRequestSchema,
  'recovery-codes-response': recoveryCodesResponseSchema,
  'totp-confirm-request': totpConfirmRequestSchema,
  'users-response': usersResponseSchema,
  'user-response': managedUserSchema,
  'update-user-request': updateUserRequestSchema,
  'delete-account-request': deleteAccountRequestSchema,
  'invites-response': invitesResponseSchema,
  'create-invite-request': createInviteRequestSchema,
  'created-invite-response': createdInviteResponseSchema,
  'invite-lookup-request': inviteLookupRequestSchema,
  'invite-lookup-response': inviteLookupResponseSchema,
  'accept-invite-request': acceptInviteRequestSchema,
  'accept-invite-response': acceptInviteResponseSchema,
  'password-reset-request': passwordResetRequestSchema,
} as const satisfies Record<string, z.ZodType>;

export type ApiSchemaName = keyof typeof API_SCHEMAS;
