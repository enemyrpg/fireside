import { isKnownSkill, type SkillValue, type XpSnapshotEvent } from '@fireside/shared';
import { asc, eq } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { accounts, xpSnapshotSkills, xpSnapshots } from '../db/schema.js';
import type { Projection, Stored } from './framework.js';
import { accountIdOf } from './lookup.js';

// `xp_snapshots` and `xp_snapshot_skills`. Keyed insert: one snapshot per
// `xp.snapshot` event, so arrival order doesn't matter.

/**
 * Total XP and total level over the skills in `SKILLS`. Unknown extra skills
 * are stored but not counted until they are added to `SKILLS` (then rebuild).
 */
export function xpTotals(skills: Readonly<Record<string, SkillValue>>): {
  totalXp: number;
  totalLevel: number;
} {
  let totalXp = 0;
  let totalLevel = 0;
  for (const [skill, value] of Object.entries(skills)) {
    if (!isKnownSkill(skill)) continue;
    totalXp += value.xp;
    totalLevel += value.level;
  }
  return { totalXp, totalLevel };
}

function applySnapshot(tx: Queryable, event: Stored<XpSnapshotEvent>): void {
  const { skills, reason } = event.payload;
  const snapshot = tx
    .insert(xpSnapshots)
    .values({
      accountId: accountIdOf(tx, event),
      eventId: event.eventId,
      sessionId: event.sessionId,
      takenAt: event.occurredAt,
      reason,
      ...xpTotals(skills),
    })
    .returning({ id: xpSnapshots.id })
    .get();

  tx.insert(xpSnapshotSkills)
    .values(
      Object.entries(skills).map(([skill, value]) => ({
        snapshotId: snapshot.id,
        skill,
        xp: value.xp,
        level: value.level,
      })),
    )
    .run();
}

export const xpProjection: Projection = {
  name: 'xp',

  apply(tx, event) {
    if (event.type === 'xp.snapshot') applySnapshot(tx, event);
  },

  reset(tx) {
    tx.delete(xpSnapshotSkills).run();
    tx.delete(xpSnapshots).run();
  },

  snapshot(db) {
    const snapshots = db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        eventId: xpSnapshots.eventId,
        sessionId: xpSnapshots.sessionId,
        takenAt: xpSnapshots.takenAt,
        reason: xpSnapshots.reason,
        totalXp: xpSnapshots.totalXp,
        totalLevel: xpSnapshots.totalLevel,
      })
      .from(xpSnapshots)
      .innerJoin(accounts, eq(xpSnapshots.accountId, accounts.id))
      .orderBy(
        asc(accounts.userId),
        asc(accounts.accountHash),
        asc(xpSnapshots.takenAt),
        asc(xpSnapshots.eventId),
      )
      .all();
    const skills = db
      .select({
        eventId: xpSnapshots.eventId,
        skill: xpSnapshotSkills.skill,
        xp: xpSnapshotSkills.xp,
        level: xpSnapshotSkills.level,
      })
      .from(xpSnapshotSkills)
      .innerJoin(xpSnapshots, eq(xpSnapshotSkills.snapshotId, xpSnapshots.id))
      .orderBy(asc(xpSnapshots.eventId), asc(xpSnapshotSkills.skill))
      .all();
    return { snapshots, skills };
  },
};
