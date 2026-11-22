import {
  compareSkills,
  isKnownSkill,
  SKILLS,
  type GainsPeriod,
  type GainsResponse,
} from '@fireside/shared';

// Rows of the gains table (2.1 "XP & gains").

export interface GainsRow {
  /** `null` for the Overall row. */
  skill: string | null;
  /** Level at the end of the period (total level for Overall). */
  level: number;
  /** XP at the end of the period. */
  totalXp: number;
  xpGained: number;
  levelsGained: number;
}

/**
 * Overall first, then every skill by XP gained (highest first), ties in skill
 * order. Overall's level and total XP count only skills in `SKILLS`, like the
 * server's `total` and total level. Empty when there is no data at all.
 */
export function buildGainsRows(gains: Pick<GainsResponse, 'total' | 'skills'>): GainsRow[] {
  if (gains.skills.length === 0) return [];

  const skills: GainsRow[] = gains.skills
    .map((gain) => ({
      skill: gain.skill,
      level: gain.endLevel,
      totalXp: gain.endXp,
      xpGained: gain.xpGained,
      levelsGained: gain.levelsGained,
    }))
    .sort((a, b) => b.xpGained - a.xpGained || compareSkills(a.skill, b.skill));

  const known = gains.skills.filter((gain) => isKnownSkill(gain.skill));
  const overall: GainsRow = {
    skill: null,
    level: known.reduce((sum, gain) => sum + gain.endLevel, 0),
    totalXp: known.reduce((sum, gain) => sum + gain.endXp, 0),
    xpGained: gains.total.xpGained,
    levelsGained: gains.total.levelsGained,
  };

  return [overall, ...skills];
}

/**
 * The gains table and the grid under it (2.1 "XP"): the table has Overall and
 * the skills with XP in the period, in the order of `buildGainsRows`; the grid
 * has the skills without, in that same order (skill order, unknown skills
 * last). Overall never goes in the grid.
 */
export function splitGainsRows(rows: readonly GainsRow[]): {
  trained: GainsRow[];
  untrained: GainsRow[];
} {
  return {
    trained: rows.filter((row) => row.skill === null || row.xpGained > 0),
    untrained: rows.filter((row) => row.skill !== null && row.xpGained <= 0),
  };
}

/**
 * Skills in `SKILLS` that gained XP in the period. Unknown skills are left out,
 * like in `total`, so the three big numbers always agree. They still have a
 * row in the table.
 */
export function skillsTrained(gains: Pick<GainsResponse, 'skills'>): number {
  return gains.skills.filter((gain) => gain.xpGained > 0 && isKnownSkill(gain.skill)).length;
}

/**
 * Whether any skill gained XP, also skills the dashboard doesn't know yet
 * (`total` leaves those out). Decides between the table and the empty state.
 */
export function anyXpGained(gains: Pick<GainsResponse, 'skills'>): boolean {
  return gains.skills.some((gain) => gain.xpGained > 0);
}

/**
 * Skills to choose from in the XP chart: every skill in `SKILLS`, then any
 * unknown skill the gains response has, alphabetically.
 */
export function chartSkills(gains: Pick<GainsResponse, 'skills'> | undefined): string[] {
  const unknown = (gains?.skills ?? [])
    .map((gain) => gain.skill)
    .filter((skill) => !isKnownSkill(skill))
    .sort(compareSkills);
  return [...SKILLS, ...new Set(unknown)];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The period a gains response covers, from its own `from`/`to`. While a new
 * period loads, the previous answer stays on screen, so its labels must come
 * from the data and not from the URL. Local days are 23–25 h, weeks 7 days,
 * months 28–31 days and years 365–366 days, so the lengths never overlap.
 */
export function periodOfRange({ from, to }: Pick<GainsResponse, 'from' | 'to'>): GainsPeriod {
  const days = (Date.parse(to) - Date.parse(from)) / DAY_MS;
  if (days < 2) return 'day';
  if (days < 8) return 'week';
  if (days < 32) return 'month';
  return 'year';
}
