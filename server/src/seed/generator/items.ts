// A small hand-written item table for simulated loot: real item IDs and
// names, prices rounded to plausible values. Only text and numbers: no icons
// or other Jagex assets (see docs/legal.md). Not scraped from the wiki.

export interface Item {
  id: number;
  name: string;
  /** Grand Exchange price per item. */
  ge: number;
  /** High alchemy value per item. */
  ha: number;
}

function item(id: number, name: string, ge: number, ha: number): Item {
  return { id, name, ge, ha };
}

export const ITEMS = {
  coins: item(995, 'Coins', 1, 0),
  bones: item(526, 'Bones', 120, 0),
  bigBones: item(532, 'Big bones', 300, 0),
  dragonBones: item(536, 'Dragon bones', 2_400, 0),
  superiorDragonBones: item(22124, 'Superior dragon bones', 9_500, 0),
  ashes: item(592, 'Ashes', 60, 0),
  cowhide: item(1739, 'Cowhide', 110, 0),
  rawBeef: item(2132, 'Raw beef', 70, 0),
  blueDragonhide: item(1751, 'Blue dragonhide', 2_300, 0),
  // Runes and ammunition
  airRune: item(556, 'Air rune', 4, 2),
  mindRune: item(558, 'Mind rune', 3, 2),
  chaosRune: item(562, 'Chaos rune', 70, 54),
  deathRune: item(560, 'Death rune', 180, 108),
  natureRune: item(561, 'Nature rune', 110, 108),
  lawRune: item(563, 'Law rune', 140, 144),
  bloodRune: item(565, 'Blood rune', 300, 240),
  wrathRune: item(21880, 'Wrath rune', 330, 240),
  soulRune: item(566, 'Soul rune', 250, 180),
  boltRack: item(4740, 'Bolt rack', 60, 24),
  dragonBoltsUnf: item(21930, 'Dragon bolts (unf)', 1_600, 600),
  cannonball: item(2, 'Cannonball', 160, 3),
  // Resources
  coal: item(453, 'Coal', 160, 27),
  goldOre: item(444, 'Gold ore', 150, 90),
  adamantiteOre: item(449, 'Adamantite ore', 1_100, 240),
  runiteOre: item(451, 'Runite ore', 11_000, 1_920),
  runiteBar: item(2363, 'Runite bar', 12_200, 3_000),
  yewLogs: item(1515, 'Yew logs', 230, 96),
  magicLogs: item(1513, 'Magic logs', 1_100, 192),
  pureEssence: item(7936, 'Pure essence', 3, 1),
  plank: item(960, 'Plank', 190, 6),
  oakPlank: item(8778, 'Oak plank', 470, 15),
  teakPlank: item(8780, 'Teak plank', 900, 30),
  dynamite: item(13573, 'Dynamite', 450, 0),
  snakeskin: item(6289, 'Snakeskin', 260, 12),
  zulrahsScales: item(12934, "Zulrah's scales", 160, 0),
  grimyRanarr: item(207, 'Grimy ranarr weed', 6_800, 18),
  grimyToadflax: item(3049, 'Grimy toadflax', 2_200, 9),
  grimyCadantine: item(215, 'Grimy cadantine', 3_000, 39),
  grimyDwarfWeed: item(217, 'Grimy dwarf weed', 2_400, 42),
  grimyTorstol: item(219, 'Grimy torstol', 8_500, 45),
  limpwurtRoot: item(225, 'Limpwurt root', 900, 1),
  ranarrSeed: item(5295, 'Ranarr seed', 30_000, 18),
  snapdragonSeed: item(5300, 'Snapdragon seed', 45_000, 18),
  seaweedSpore: item(21490, 'Seaweed spore', 300, 0),
  uncutSapphire: item(1623, 'Uncut sapphire', 450, 15),
  uncutRuby: item(1619, 'Uncut ruby', 900, 60),
  uncutDiamond: item(1617, 'Uncut diamond', 2_900, 120),
  uncutDragonstone: item(1631, 'Uncut dragonstone', 11_000, 600),
  dragonstone: item(1615, 'Dragonstone', 12_000, 6_000),
  uncutOnyx: item(6571, 'Uncut onyx', 2_700_000, 120_000),
  // Food and potions
  rawLobster: item(377, 'Raw lobster', 260, 18),
  rawSwordfish: item(371, 'Raw swordfish', 300, 24),
  rawShark: item(383, 'Raw shark', 900, 60),
  shark: item(385, 'Shark', 950, 90),
  mantaRay: item(391, 'Manta ray', 1_500, 120),
  prayerPotion4: item(2434, 'Prayer potion(4)', 9_500, 91),
  vialOfBlood: item(22446, 'Vial of blood', 900, 30),
  purpleSweets: item(10476, 'Purple sweets', 8, 0),
  // Equipment
  runeKiteshield: item(1201, 'Rune kiteshield', 32_000, 32_640),
  runeLongsword: item(1303, 'Rune longsword', 18_500, 19_200),
  runeTwoHandedSword: item(1319, 'Rune 2h sword', 38_000, 38_400),
  runeMedHelm: item(1147, 'Rune med helm', 11_000, 11_520),
  runeChainbody: item(1113, 'Rune chainbody', 29_000, 30_000),
  runePlatebody: item(1127, 'Rune platebody', 38_500, 39_000),
  runeScimitar: item(1333, 'Rune scimitar', 14_800, 15_360),
  runeBattleaxe: item(1373, 'Rune battleaxe', 24_500, 24_960),
  dragonDagger: item(1215, 'Dragon dagger', 17_000, 18_000),
  dragonBattleaxe: item(1377, 'Dragon battleaxe', 120_000, 150_000),
  dragonTwoHandedSword: item(7158, 'Dragon 2h sword', 110_000, 132_000),
  dragonPickaxe: item(11920, 'Dragon pickaxe', 2_200_000, 3_000),
  dragonAxe: item(6739, 'Dragon axe', 1_400_000, 33_000),
  dragonHarpoon: item(21028, 'Dragon harpoon', 1_500_000, 33_000),
  battlestaff: item(1391, 'Battlestaff', 8_400, 4_200),
  magicLongbow: item(859, 'Magic longbow', 1_200, 1_536),
  leatherBoots: item(1061, 'Leather boots', 180, 3),
  rangerBoots: item(2577, 'Ranger boots', 32_000_000, 21),
  robinHoodHat: item(2581, 'Robin hood hat', 2_100_000, 21),
  hillGiantClub: item(20756, 'Hill giant club', 500_000, 7_200),
  // Boss uniques
  draconicVisage: item(11286, 'Draconic visage', 3_400_000, 60_000),
  skeletalVisage: item(22006, 'Skeletal visage', 9_800_000, 60_000),
  tanzaniteFang: item(12922, 'Tanzanite fang', 1_900_000, 30_000),
  magicFang: item(12932, 'Magic fang', 1_700_000, 30_000),
  serpentineVisage: item(12927, 'Serpentine visage', 1_100_000, 30_000),
  tanzaniteMutagen: item(13200, 'Tanzanite mutagen', 4_500_000, 1),
  bandosChestplate: item(11832, 'Bandos chestplate', 19_000_000, 158_400),
  bandosTassets: item(11834, 'Bandos tassets', 26_000_000, 165_000),
  bandosBoots: item(11836, 'Bandos boots', 180_000, 14_400),
  bandosHilt: item(11812, 'Bandos hilt', 9_500_000, 300_000),
  godswordShard1: item(11818, 'Godsword shard 1', 330_000, 3_000),
  abyssalWhip: item(4151, 'Abyssal whip', 1_500_000, 72_000),
  abyssalDagger: item(13265, 'Abyssal dagger', 1_100_000, 69_000),
  ahrimsRobetop: item(4712, "Ahrim's robetop", 1_300_000, 90_000),
  dharoksGreataxe: item(4718, "Dharok's greataxe", 1_100_000, 124_000),
  karilsCrossbow: item(4734, "Karil's crossbow", 260_000, 72_000),
  guthansHelm: item(4724, "Guthan's helm", 900_000, 36_000),
  toragsHammers: item(4747, "Torag's hammers", 160_000, 84_000),
  veracsFlail: item(4755, "Verac's flail", 400_000, 84_000),
  tomeOfFire: item(20716, 'Tome of fire', 450_000, 0),
} as const satisfies Record<string, Item>;
