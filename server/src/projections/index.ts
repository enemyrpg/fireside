import { accountsProjection } from './accounts.js';
import { bankProjection, potionStorageProjection } from './bank.js';
import type { Projection } from './framework.js';
import { kcProjection } from './kc.js';
import { lootProjection } from './loot.js';
import { pbRecordsProjection } from './pb-records.js';
import { petsProjection } from './pets.js';
import { diariesProjection, questsProjection } from './quests.js';
import { raidSpecialLootProjection } from './raid-special-loot.js';
import { sessionSummariesProjection } from './session-summaries.js';
import { sessionsProjection } from './sessions.js';
import { weeklySummariesProjection } from './weekly-summaries.js';
import { xpProjection } from './xp.js';

export * from './framework.js';

/**
 * All projections, in the order they run for each event. Later projections
 * may read rows written by earlier ones (e.g. `accounts.id`).
 */
export const PROJECTIONS: readonly Projection[] = [
  accountsProjection,
  sessionsProjection,
  xpProjection,
  lootProjection,
  kcProjection,
  pbRecordsProjection,
  bankProjection,
  potionStorageProjection,
  questsProjection,
  diariesProjection,
  petsProjection,
  // Reads the loot rows written above for the same event.
  raidSpecialLootProjection,
  // Last: reads rows the projections above wrote for the same event.
  sessionSummariesProjection,
  // Deletes stored weeks the event can change (they are recomputed when read).
  weeklySummariesProjection,
];
