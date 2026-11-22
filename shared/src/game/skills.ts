/**
 * Skills from RuneLite's `Skill` enum, in enum order (also the display order).
 * `xp.snapshot` must contain all of them. Unknown extra skills are still
 * accepted, so a new skill in the game never breaks ingest.
 */
export const SKILLS = [
  'ATTACK',
  'DEFENCE',
  'STRENGTH',
  'HITPOINTS',
  'RANGED',
  'PRAYER',
  'MAGIC',
  'COOKING',
  'WOODCUTTING',
  'FLETCHING',
  'FISHING',
  'FIREMAKING',
  'CRAFTING',
  'SMITHING',
  'MINING',
  'HERBLORE',
  'AGILITY',
  'THIEVING',
  'SLAYER',
  'FARMING',
  'RUNECRAFT',
  'HUNTER',
  'CONSTRUCTION',
  'SAILING',
] as const;

export type Skill = (typeof SKILLS)[number];

const knownSkills: ReadonlySet<string> = new Set(SKILLS);

export function isKnownSkill(name: string): name is Skill {
  return knownSkills.has(name);
}

const skillIndex: ReadonlyMap<string, number> = new Map(
  SKILLS.map((skill, index) => [skill, index]),
);

/**
 * Display order of skills: `SKILLS` order first, then unknown skills
 * alphabetically. Used by the server (gains, sessions, weekly) and the dashboard.
 */
export function compareSkills(a: string, b: string): number {
  const ia = skillIndex.get(a);
  const ib = skillIndex.get(b);
  if (ia !== undefined && ib !== undefined) return ia - ib;
  if (ia !== undefined) return -1;
  if (ib !== undefined) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
