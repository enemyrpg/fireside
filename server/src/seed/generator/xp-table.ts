// The OSRS experience table. Levels in `xp.snapshot` must match the XP.

export const MAX_LEVEL = 99;
export const MAX_XP = 200_000_000;

/** XP needed for each level, index = level (index 0 unused). */
const XP_FOR_LEVEL: readonly number[] = (() => {
  const table = [0, 0];
  let points = 0;
  for (let level = 1; level < MAX_LEVEL; level++) {
    points += Math.floor(level + 300 * 2 ** (level / 7));
    table.push(Math.floor(points / 4));
  }
  return table;
})();

/** XP at the start of `level` (1–99). */
export function xpForLevel(level: number): number {
  const xp = XP_FOR_LEVEL[level];
  if (!Number.isInteger(level) || xp === undefined || level < 1) {
    throw new RangeError(`No such level: ${String(level)}`);
  }
  return xp;
}

/** Level (1–99) for an XP amount. */
export function levelForXp(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && (XP_FOR_LEVEL[level + 1] ?? Infinity) <= xp) level++;
  return level;
}
