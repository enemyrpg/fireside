import { DAY_MS, MINUTE_MS } from '@fireside/shared';
import type { Profile } from './profiles.js';
import type { Rng } from './rng.js';

// Simulated collection logs. The collection log never comes through ingest: it
// is raw data from an external source, stored unchanged in
// `external_snapshots`. So the seed makes bodies in the shape of RuneProfile's
// public API, written by hand here, and `seed/clog.ts` stores them the way a
// sync does.
//
// A small hand-written layout: the game's five tabs with a few pages each,
// real item IDs and names as text. No icons or other Jagex assets, and no
// account names (see docs/legal.md). Not the game's full collection log, and
// not scraped from anywhere: pages may be shorter than in the game.

type Entry = readonly [id: number, name: string];

interface PageLayout {
  name: string;
  items: readonly Entry[];
}

interface TabLayout {
  name: string;
  pages: readonly PageLayout[];
}

const PETS = {
  abyssalOrphan: [13262, 'Abyssal orphan'],
  graardor: [12650, 'Pet general graardor'],
  vorki: [21992, 'Vorki'],
  snakeling: [12921, 'Pet snakeling'],
  kraken: [12655, 'Pet kraken'],
  hellpuppy: [13247, 'Hellpuppy'],
  princeBlackDragon: [12653, 'Prince black dragon'],
  babyMole: [12646, 'Baby mole'],
  vetionJr: [13179, "Vet'ion jr."],
  darkCore: [12816, 'Pet dark core'],
  olmlet: [20851, 'Olmlet'],
  lilZik: [22473, "Lil' zik"],
  tumekensGuardian: [27352, "Tumeken's guardian"],
  penanceQueen: [12703, 'Pet penance queen'],
  tinyTempor: [25602, 'Tiny tempor'],
  phoenix: [20693, 'Phoenix'],
  rocky: [20663, 'Rocky'],
  heron: [13320, 'Heron'],
  beaver: [13322, 'Beaver'],
  tangleroot: [20661, 'Tangleroot'],
  rockGolem: [13321, 'Rock golem'],
  giantSquirrel: [20659, 'Giant squirrel'],
  riftGuardian: [20665, 'Rift guardian'],
  herbi: [21509, 'Herbi'],
  bloodhound: [19730, 'Bloodhound'],
} as const satisfies Record<string, Entry>;

const ABYSSAL_WHIP: Entry = [4151, 'Abyssal whip'];
const ABYSSAL_DAGGER: Entry = [13265, 'Abyssal dagger'];
const ABYSSAL_HEAD: Entry = [7979, 'Abyssal head'];
const KRAKEN_TENTACLE: Entry = [12004, 'Kraken tentacle'];
const DRAGON_PICKAXE: Entry = [11920, 'Dragon pickaxe'];
const DRACONIC_VISAGE: Entry = [11286, 'Draconic visage'];

export const CLOG_LAYOUT: readonly TabLayout[] = [
  {
    name: 'Bosses',
    pages: [
      {
        name: 'Abyssal Sire',
        items: [
          PETS.abyssalOrphan,
          [13273, 'Unsired'],
          ABYSSAL_HEAD,
          [13274, 'Bludgeon spine'],
          [13275, 'Bludgeon claw'],
          [13276, 'Bludgeon axon'],
          [13277, 'Jar of miasma'],
          ABYSSAL_DAGGER,
          ABYSSAL_WHIP,
        ],
      },
      {
        name: 'Barrows Chests',
        items: [
          [4708, "Ahrim's hood"],
          [4712, "Ahrim's robetop"],
          [4714, "Ahrim's robeskirt"],
          [4710, "Ahrim's staff"],
          [4716, "Dharok's helm"],
          [4720, "Dharok's platebody"],
          [4722, "Dharok's platelegs"],
          [4718, "Dharok's greataxe"],
          [4724, "Guthan's helm"],
          [4728, "Guthan's platebody"],
          [4730, "Guthan's chainskirt"],
          [4726, "Guthan's warspear"],
          [4732, "Karil's coif"],
          [4736, "Karil's leathertop"],
          [4738, "Karil's leatherskirt"],
          [4734, "Karil's crossbow"],
          [4745, "Torag's helm"],
          [4749, "Torag's platebody"],
          [4751, "Torag's platelegs"],
          [4747, "Torag's hammers"],
          [4753, "Verac's helm"],
          [4757, "Verac's brassard"],
          [4759, "Verac's plateskirt"],
          [4755, "Verac's flail"],
          [4740, 'Bolt rack'],
        ],
      },
      {
        name: "Calvar'ion and Vet'ion",
        items: [
          PETS.vetionJr,
          [12601, 'Ring of the gods'],
          DRAGON_PICKAXE,
          [7158, 'Dragon 2h sword'],
        ],
      },
      {
        name: 'Cerberus',
        items: [
          PETS.hellpuppy,
          [13227, 'Eternal crystal'],
          [13229, 'Pegasian crystal'],
          [13231, 'Primordial crystal'],
          [13245, 'Jar of souls'],
          [13233, 'Smouldering stone'],
          [13249, 'Key master teleport'],
        ],
      },
      {
        name: 'Corporeal Beast',
        items: [
          PETS.darkCore,
          [12819, 'Elysian sigil'],
          [12823, 'Spectral sigil'],
          [12827, 'Arcane sigil'],
          [12833, 'Holy elixir'],
          [12829, 'Spirit shield'],
        ],
      },
      {
        name: 'General Graardor',
        items: [
          PETS.graardor,
          [11832, 'Bandos chestplate'],
          [11834, 'Bandos tassets'],
          [11836, 'Bandos boots'],
          [11812, 'Bandos hilt'],
          [11818, 'Godsword shard 1'],
          [11820, 'Godsword shard 2'],
          [11822, 'Godsword shard 3'],
        ],
      },
      {
        name: 'Giant Mole',
        items: [PETS.babyMole, [7418, 'Mole skin'], [7416, 'Mole claw']],
      },
      {
        name: 'King Black Dragon',
        items: [PETS.princeBlackDragon, [7980, 'Kbd heads'], DRAGON_PICKAXE, DRACONIC_VISAGE],
      },
      {
        name: 'Kraken',
        items: [
          PETS.kraken,
          KRAKEN_TENTACLE,
          [11905, 'Trident of the seas (full)'],
          [12007, 'Jar of dirt'],
        ],
      },
      {
        name: 'Vorkath',
        items: [
          PETS.vorki,
          [21907, "Vorkath's head"],
          DRACONIC_VISAGE,
          [22006, 'Skeletal visage'],
          [22106, 'Jar of decay'],
          [22111, 'Dragonbone necklace'],
        ],
      },
      {
        name: 'Zulrah',
        items: [
          PETS.snakeling,
          [13200, 'Tanzanite mutagen'],
          [13201, 'Magma mutagen'],
          [12936, 'Jar of swamp'],
          [12932, 'Magic fang'],
          [12927, 'Serpentine visage'],
          [12922, 'Tanzanite fang'],
          [12938, 'Zul-andra teleport'],
          [6571, 'Uncut onyx'],
          [12934, "Zulrah's scales"],
        ],
      },
    ],
  },
  {
    name: 'Raids',
    pages: [
      {
        name: 'Chambers of Xeric',
        items: [
          PETS.olmlet,
          [22386, 'Metamorphic dust'],
          [20997, 'Twisted bow'],
          [21003, 'Elder maul'],
          [21043, 'Kodai insignia'],
          [13652, 'Dragon claws'],
          [21018, 'Ancestral hat'],
          [21021, 'Ancestral robe top'],
          [21024, 'Ancestral robe bottom'],
          [21015, "Dinh's bulwark"],
          [21034, 'Dexterous prayer scroll'],
          [21079, 'Arcane prayer scroll'],
          [21012, 'Dragon hunter crossbow'],
          [21000, 'Twisted buckler'],
          [21047, 'Torn prayer scroll'],
          [21027, 'Dark relic'],
          [6573, 'Onyx'],
        ],
      },
      {
        name: 'Theatre of Blood',
        items: [
          PETS.lilZik,
          [22486, 'Scythe of vitur (uncharged)'],
          [22324, 'Ghrazi rapier'],
          [22481, 'Sanguinesti staff (uncharged)'],
          [22326, 'Justiciar faceguard'],
          [22327, 'Justiciar chestguard'],
          [22328, 'Justiciar legguards'],
          [22477, 'Avernic defender hilt'],
          [22446, 'Vial of blood'],
          [22494, 'Sinhaza shroud tier 1'],
        ],
      },
      {
        name: 'Tombs of Amascut',
        items: [
          PETS.tumekensGuardian,
          [27277, "Tumeken's shadow (uncharged)"],
          [25985, "Elidinis' ward"],
          [27226, 'Masori mask'],
          [27229, 'Masori body'],
          [27232, 'Masori chaps'],
          [25975, 'Lightbearer'],
          [26219, "Osmumten's fang"],
          [27279, 'Thread of elidinis'],
          [27283, 'Breach of the scarab'],
          [27285, 'Eye of the corruptor'],
          [27289, 'Jewel of the sun'],
          [27255, 'Menaphite ornament kit'],
        ],
      },
    ],
  },
  {
    name: 'Clues',
    pages: [
      {
        name: 'Beginner Treasure Trails',
        items: [
          [23285, 'Mole slippers'],
          [23288, 'Frog slippers'],
          [23291, 'Bear feet'],
          [23294, 'Demon feet'],
          [23297, 'Jester cape'],
          [23300, 'Shoulder parrot'],
          [23303, "Monk's robe top (t)"],
          [23306, "Monk's robe (t)"],
          [23312, 'Sandwich lady hat'],
          [23315, 'Sandwich lady top'],
          [23318, 'Sandwich lady bottom'],
        ],
      },
      {
        name: 'Medium Treasure Trails',
        items: [
          [2577, 'Ranger boots'],
          [2579, 'Wizard boots'],
          [12598, 'Holy sandals'],
          [23389, 'Spiked manacles'],
          [23413, 'Climbing boots (g)'],
        ],
      },
      {
        name: 'Hard Treasure Trails',
        items: [
          [2581, 'Robin hood hat'],
          [3481, 'Gilded platebody'],
          [3483, 'Gilded platelegs'],
          [3486, 'Gilded full helm'],
          [3488, 'Gilded kiteshield'],
          [2615, 'Rune platebody (g)'],
          [2617, 'Rune platelegs (g)'],
          [2619, 'Rune full helm (g)'],
          [2621, 'Rune kiteshield (g)'],
          [10354, 'Amulet of glory (t4)'],
        ],
      },
      {
        name: 'Shared Treasure Trail Rewards',
        items: [
          [10476, 'Purple sweets'],
          [3827, 'Saradomin page 1'],
          [3828, 'Saradomin page 2'],
          [3829, 'Saradomin page 3'],
          [3830, 'Saradomin page 4'],
          [3831, 'Zamorak page 1'],
          [3832, 'Zamorak page 2'],
          [3833, 'Zamorak page 3'],
          [3834, 'Zamorak page 4'],
          [3835, 'Guthix page 1'],
          [3836, 'Guthix page 2'],
          [3837, 'Guthix page 3'],
          [3838, 'Guthix page 4'],
        ],
      },
    ],
  },
  {
    name: 'Minigames',
    pages: [
      {
        name: 'Barbarian Assault',
        items: [
          PETS.penanceQueen,
          [10548, 'Fighter hat'],
          [10550, 'Ranger hat'],
          [10547, 'Healer hat'],
          [10549, 'Runner hat'],
          [10551, 'Fighter torso'],
          [10555, 'Penance skirt'],
          [10552, 'Runner boots'],
          [10553, 'Penance gloves'],
          [10564, 'Granite body'],
        ],
      },
      {
        name: 'Pest Control',
        items: [
          [8841, 'Void knight mace'],
          [8839, 'Void knight top'],
          [8840, 'Void knight robe'],
          [8842, 'Void knight gloves'],
          [11663, 'Void mage helm'],
          [11664, 'Void ranger helm'],
          [11665, 'Void melee helm'],
          [11666, 'Void seal(8)'],
        ],
      },
      {
        name: 'Tempoross',
        items: [
          PETS.tinyTempor,
          [25559, 'Big harpoonfish'],
          [25592, 'Spirit angler headband'],
          [25594, 'Spirit angler top'],
          [25596, 'Spirit angler waders'],
          [25598, 'Spirit angler boots'],
          [25576, 'Tome of water (empty)'],
          [25578, 'Soaked page'],
          [25580, 'Tackle box'],
          [25582, 'Fish barrel'],
          [21028, 'Dragon harpoon'],
        ],
      },
      {
        name: 'Wintertodt',
        items: [
          PETS.phoenix,
          [20716, 'Tome of fire (empty)'],
          [20718, 'Burnt page'],
          [20704, 'Pyromancer garb'],
          [20708, 'Pyromancer hood'],
          [20706, 'Pyromancer robe'],
          [20710, 'Pyromancer boots'],
          [20712, 'Warm gloves'],
          [20720, 'Bruma torch'],
          [6739, 'Dragon axe'],
        ],
      },
    ],
  },
  {
    name: 'Other',
    pages: [
      { name: 'All Pets', items: Object.values(PETS) },
      {
        name: "Champion's Challenge",
        items: [
          [6798, 'Earth warrior champion scroll'],
          [6799, 'Ghoul champion scroll'],
          [6800, 'Giant champion scroll'],
          [6801, 'Goblin champion scroll'],
          [6802, 'Hobgoblin champion scroll'],
          [6803, 'Imp champion scroll'],
          [6804, 'Jogre champion scroll'],
          [6805, 'Lesser demon champion scroll'],
          [6806, 'Skeleton champion scroll'],
          [6807, 'Zombie champion scroll'],
          [21439, "Champion's cape"],
        ],
      },
      {
        name: 'Miscellaneous',
        items: [
          PETS.herbi,
          [7989, 'Big bass'],
          [7991, 'Big swordfish'],
          [7993, 'Big shark'],
          [10976, 'Long bone'],
          [10977, 'Curved bone'],
          [13071, 'Chompy chick'],
          [2366, 'Shield left half'],
          [11335, 'Dragon full helm'],
        ],
      },
      {
        name: 'Slayer',
        items: [
          [7975, 'Crawling hand'],
          [7976, 'Cockatrice head'],
          [7977, 'Basilisk head'],
          [7978, 'Kurask head'],
          ABYSSAL_HEAD,
          [20724, 'Imbued heart'],
          [21270, 'Eternal gem'],
          [20736, 'Dust battlestaff'],
          [20730, 'Mist battlestaff'],
          ABYSSAL_WHIP,
          [4153, 'Granite maul'],
          [11902, 'Leaf-bladed sword'],
          [8901, 'Black mask (10)'],
          [12002, 'Occult necklace'],
          [3140, 'Dragon chainbody'],
          [11840, 'Dragon boots'],
          ABYSSAL_DAGGER,
          KRAKEN_TENTACLE,
        ],
      },
    ],
  },
];

/** Items that come in numbers: [lowest, highest] quantity once obtained. */
const STACKS: Readonly<Record<number, readonly [number, number]>> = {
  4740: [400, 6_000], // Bolt rack
  12934: [20_000, 180_000], // Zulrah's scales
  12938: [15, 120], // Zul-andra teleport
  10476: [80, 900], // Purple sweets
  22446: [4, 40], // Vial of blood
  25578: [30, 300], // Soaked page
  20718: [40, 400], // Burnt page
  13249: [3, 25], // Key master teleport
  7418: [50, 600], // Mole skin
  7416: [50, 600], // Mole claw
};

const PET_IDS: ReadonlySet<number> = new Set(Object.values(PETS).map(([id]) => id));

interface ClogPlan {
  /** Chance per page that the account has each of its items by the end. */
  pages: Readonly<Record<string, number>>;
  /** Pages the account has completed. */
  complete: readonly string[];
  /** Pets the account has. Every other pet is missing: pets are rare. */
  pets: readonly number[];
}

/**
 * Which accounts have a collection log, and how far along it is. The third
 * account has none, so "an account without a collection log" can be seen.
 */
const PLANS: Partial<Record<Profile['key'], ClogPlan>> = {
  main: {
    pages: {
      'Abyssal Sire': 0.45,
      'Barrows Chests': 0.6,
      "Calvar'ion and Vet'ion": 0.5,
      Cerberus: 0.45,
      'General Graardor': 0.75,
      'King Black Dragon': 0.5,
      Kraken: 0.75,
      Vorkath: 0.8,
      Zulrah: 0.7,
      'Chambers of Xeric': 0.4,
      'Theatre of Blood': 0.35,
      'Tombs of Amascut': 0.5,
      'Beginner Treasure Trails': 0.3,
      'Medium Treasure Trails': 0.4,
      'Hard Treasure Trails': 0.3,
      'Shared Treasure Trail Rewards': 0.6,
      'Barbarian Assault': 0.5,
      'Pest Control': 0.9,
      Wintertodt: 0.8,
      Miscellaneous: 0.4,
      Slayer: 0.7,
    },
    complete: ['Giant Mole'],
    pets: [PETS.vorki[0], PETS.babyMole[0], PETS.snakeling[0], PETS.heron[0], PETS.phoenix[0]],
  },
  iron: {
    pages: {
      'Abyssal Sire': 0.15,
      'Giant Mole': 0.67,
      'King Black Dragon': 0.25,
      Kraken: 0.25,
      'Beginner Treasure Trails': 0.55,
      'Medium Treasure Trails': 0.2,
      'Shared Treasure Trail Rewards': 0.35,
      'Barbarian Assault': 0.3,
      'Pest Control': 0.5,
      Tempoross: 0.7,
      Wintertodt: 0.9,
      Miscellaneous: 0.3,
      Slayer: 0.4,
    },
    complete: ['Barrows Chests'],
    pets: [PETS.tinyTempor[0], PETS.rockGolem[0]],
  },
};

/** One stored response of the source, in the order they were fetched. */
export interface SeedExternalSnapshot {
  kind: 'COLLECTION_LOG' | 'ACTIVITIES';
  /** UTC ISO 8601 with milliseconds. */
  fetchedAt: string;
  /** The response body, in the shape of RuneProfile's public API. */
  body: string;
}

export interface SeedCollectionLog {
  accountHash: string;
  /** Unique items at the end of the window. */
  obtained: number;
  total: number;
  snapshots: SeedExternalSnapshot[];
  /** Successful reads, oldest first, as `clog_reads` stores them. */
  reads: string[];
}

/** `GET /accounts/{name}/collection-log` as RuneProfile builds it. */
export function collectionLogBody(quantities: ReadonlyMap<number, number>): string {
  const unique = new Map<number, number>();
  const tabs = CLOG_LAYOUT.map((tab) => {
    const pages = tab.pages.map((page) => {
      const items = page.items.map(([id, name]) => ({
        id,
        name,
        quantity: quantities.get(id) ?? 0,
      }));
      for (const item of items) unique.set(item.id, item.quantity);
      return {
        name: page.name,
        obtained: items.filter((item) => item.quantity > 0).length,
        total: items.length,
        items,
      };
    });
    return {
      name: tab.name,
      obtained: pages.reduce((sum, page) => sum + page.obtained, 0),
      total: pages.reduce((sum, page) => sum + page.total, 0),
      pages,
    };
  });
  return JSON.stringify({
    obtained: [...unique.values()].filter((quantity) => quantity > 0).length,
    total: unique.size,
    tabs,
  });
}

/** One page of `GET /accounts/{name}/activities`, newest first. */
function activitiesBody(entries: readonly { itemId: number; atMs: number }[]): string {
  const names = new Map(CLOG_LAYOUT.flatMap((tab) => tab.pages.flatMap((page) => page.items)));
  return JSON.stringify({
    activities: [...entries]
      .sort((a, b) => b.atMs - a.atMs)
      .map(({ itemId, atMs }) => ({
        type: 'new_item_obtained',
        data: { itemId },
        enriched: { itemName: names.get(itemId) ?? 'Unknown' },
        createdAt: new Date(atMs).toISOString(),
      })),
    nextCursor: null,
    prevCursor: null,
    hasMore: false,
    hasPrev: false,
  });
}

/** Share of the account's items it already had when the collection log was first read. */
const BASELINE_SHARE = 0.72;
/** Most sessions after the first read that find something new. */
const MAX_LATER_SYNCS = 14;
/** Share of new items the activity feed has an exact time for. */
const FEED_SHARE = 0.6;
/** Share of post-session reads that fail (the source is down), so nothing is read. */
const FAILED_READ_SHARE = 0.06;

/** A session of the account, as the seed played it. */
export interface ClogSeedSession {
  startMs: number;
  /** `session.end`, or the last heartbeat for a crash. */
  endMs: number;
  end: 'logout' | 'client_closed' | 'hop' | 'crash' | 'open';
}

/**
 * When the server's job reads the collection log after a session: 2 minutes
 * after it ends, at the next one-minute check (server/src/jobs/clog.ts). A
 * crashed session is only closed 10 minutes after its last heartbeat. A hop
 * is not a session end for the job; an open session has not ended.
 */
function postSessionReadMs(session: ClogSeedSession, rng: Rng): number | null {
  if (session.end === 'hop' || session.end === 'open') return null;
  const closedMs = session.endMs + (session.end === 'crash' ? 10 * MINUTE_MS : 0);
  return Math.floor(closedMs + 2 * MINUTE_MS + rng.float(0, 60_000));
}

/**
 * The collection log of one account over the window, read as the server's
 * job reads it: after each session ends, a few of the reads failing. The first
 * read is a few days in (those items get no date). Later new items drop in a
 * session and are seen by the next successful read (approximate dates); the
 * activity feed gives some of them the exact time. On purpose, for the session
 * rule in server/src/read/session-clog.ts: the read after one finding session
 * fails, so its item is seen only after another session (tied to none), and one
 * item drops between two hop parts. `reads` are the successful reads, as
 * `clog_reads` stores them. `null` for an account without a collection log.
 */
export function simulateCollectionLog(
  profile: Profile,
  accountHash: string,
  fromMs: number,
  untilMs: number,
  sessions: readonly ClogSeedSession[],
  rng: Rng,
): SeedCollectionLog | null {
  const plan = PLANS[profile.key];
  if (!plan) return null;

  // What the account has at the end, in the layout's order.
  const final = new Map<number, number>();
  const chance = new Map<number, number>();
  for (const tab of CLOG_LAYOUT) {
    for (const page of tab.pages) {
      const p = plan.complete.includes(page.name) ? 1 : (plan.pages[page.name] ?? 0);
      for (const [id] of page.items) chance.set(id, Math.max(chance.get(id) ?? 0, p));
    }
  }
  for (const [id, p] of chance) {
    const has = PET_IDS.has(id) ? p === 1 || plan.pets.includes(id) : rng.chance(p);
    if (!has) continue;
    const stack = STACKS[id];
    // A pet is one of a kind. Other items: a stack, a few, or one.
    const several = !PET_IDS.has(id) && rng.chance(0.3);
    final.set(id, stack ? rng.int(stack[0], stack[1]) : several ? rng.int(2, 6) : 1);
  }

  const ordered = [...sessions].sort((a, b) => a.startMs - b.startMs);
  const span = untilMs - fromMs;
  const firstMs = fromMs + Math.min(span * 0.1, rng.float(1, 3) * DAY_MS);

  // Every post-session read in the window; the first one after `firstMs` is
  // the first read (and never fails).
  const reads: { ms: number; ok: boolean; after: number }[] = [];
  ordered.forEach((session, index) => {
    const ms = postSessionReadMs(session, rng);
    if (ms === null || ms > untilMs) return;
    reads.push({ ms, ok: true, after: index });
  });
  const firstRead = reads.findIndex((read) => read.ms >= firstMs);
  if (firstRead < 0) return null;
  for (const read of reads.slice(firstRead + 1)) read.ok = !rng.chance(FAILED_READ_SHARE);
  const firstReadMs = reads[firstRead]?.ms ?? firstMs;

  const order = rng.shuffle([...final.keys()]);
  const baselineCount = Math.ceil(order.length * BASELINE_SHARE);
  const later = order.slice(baselineCount);

  // Sessions after the first read that find something new: the two most
  // recent, and others at random. Every one of them finds at least one item.
  const eligible = ordered
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => session.startMs > firstReadMs && session.end !== 'open');
  const count = Math.min(MAX_LATER_SYNCS, later.length, eligible.length);
  const recent = eligible.slice(-2);
  const chosen = [
    ...rng.shuffle(eligible.slice(0, -2)).slice(0, Math.max(0, count - recent.length)),
    ...recent.slice(Math.max(0, recent.length - count)),
  ].sort((a, b) => a.index - b.index);

  // When each later item dropped (in a chosen session), and whether the feed has it.
  const drops = new Map<number, { atMs: number; feed: boolean }>();
  later.forEach((id, index) => {
    const found =
      index < chosen.length ? chosen[index] : chosen.length > 0 ? rng.pick(chosen) : undefined;
    if (!found) return;
    const { startMs, endMs } = found.session;
    drops.set(id, { atMs: Math.floor(rng.float(startMs, endMs)), feed: rng.chance(FEED_SHARE) });
  });
  // The read after the second finding session fails, so its items are only
  // seen after the next session.
  const missed = chosen[1];
  if (missed) {
    const read = reads.find((r) => r.after >= missed.index);
    const next = read ? reads.find((r) => r.ms > read.ms) : undefined;
    if (read && next && read !== reads[firstRead]) read.ok = false;
  }
  // One item with an exact time between two hop parts: in no session.
  const hop = ordered.findIndex(
    (session, index) =>
      session.end === 'hop' && session.startMs > firstReadMs && ordered[index + 1] !== undefined,
  );
  // An extra item (beyond one per finding session), so no session loses its only one.
  const gapItem = later.slice(chosen.length).find((id) => drops.has(id));
  const afterHop = ordered[hop + 1];
  if (hop >= 0 && afterHop && gapItem !== undefined) {
    const before = ordered[hop];
    if (before && afterHop.startMs > before.endMs + 1) {
      drops.set(gapItem, { atMs: Math.floor((before.endMs + afterHop.startMs) / 2), feed: true });
    }
  }

  const has = new Map<number, number>();
  for (const id of order.slice(0, baselineCount)) has.set(id, final.get(id) ?? 1);
  const snapshots: SeedExternalSnapshot[] = [
    {
      kind: 'COLLECTION_LOG',
      fetchedAt: new Date(firstReadMs).toISOString(),
      body: collectionLogBody(has),
    },
  ];
  const okReads = reads.slice(firstRead).filter((read) => read.ok);
  let previousMs = firstReadMs;
  for (const read of okReads.slice(1)) {
    const fetchedAt = new Date(read.ms).toISOString();
    const items = [...drops].filter(([, drop]) => drop.atMs > previousMs && drop.atMs < read.ms);
    previousMs = read.ms;
    if (items.length === 0) continue;
    for (const [id] of items) has.set(id, final.get(id) ?? 1);
    snapshots.push({ kind: 'COLLECTION_LOG', fetchedAt, body: collectionLogBody(has) });
    const feed = items
      .filter(([, drop]) => drop.feed)
      .map(([itemId, drop]) => ({ itemId, atMs: drop.atMs }));
    if (feed.length > 0)
      snapshots.push({ kind: 'ACTIVITIES', fetchedAt, body: activitiesBody(feed) });
  }

  return {
    accountHash,
    obtained: has.size,
    total: chance.size,
    snapshots,
    reads: okReads.map((read) => new Date(read.ms).toISOString()),
  };
}
