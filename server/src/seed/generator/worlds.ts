// Simulated game worlds. Types and locations use RuneLite enum names
// (`WorldType`, `WorldRegion`), as in session.heartbeat.

export interface World {
  number: number;
  types: readonly string[];
  location: string;
  /** Activity text from the world list. Can be empty. */
  activity: string;
}

function world(
  number: number,
  types: readonly string[],
  location: string,
  activity: string,
): World {
  return { number, types, location, activity };
}

const MEMBERS = ['MEMBERS'];

export const MEMBERS_WORLDS: readonly World[] = [
  world(302, MEMBERS, 'UNITED_KINGDOM', 'Trade - Members'),
  world(303, MEMBERS, 'GERMANY', ''),
  world(310, MEMBERS, 'UNITED_KINGDOM', 'Wintertodt'),
  world(330, MEMBERS, 'GERMANY', 'House Party, Gilded Altar'),
  world(350, MEMBERS, 'UNITED_STATES_OF_AMERICA', ''),
  world(356, MEMBERS, 'UNITED_STATES_OF_AMERICA', 'Clan Wars - Free-for-all'),
  world(416, MEMBERS, 'UNITED_KINGDOM', 'LMS Competitive'),
  world(420, MEMBERS, 'GERMANY', ''),
  world(444, MEMBERS, 'GERMANY', 'Blast Furnace'),
  world(477, MEMBERS, 'AUSTRALIA', ''),
  world(486, ['MEMBERS', 'SKILL_TOTAL'], 'GERMANY', '2200 skill total'),
  world(518, MEMBERS, 'UNITED_STATES_OF_AMERICA', 'Tempoross'),
];

export const FREE_WORLDS: readonly World[] = [
  world(301, [], 'UNITED_STATES_OF_AMERICA', 'Trade - Free'),
  world(308, [], 'UNITED_KINGDOM', ''),
  world(335, [], 'GERMANY', ''),
  world(383, [], 'UNITED_KINGDOM', 'Group Iron'),
  world(469, [], 'AUSTRALIA', ''),
];
