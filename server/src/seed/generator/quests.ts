import {
  DIARY_REGIONS,
  DIARY_TIERS,
  type DiariesSnapshotPayload,
  type QuestKind,
  type QuestsSnapshotPayload,
  type QuestState,
} from '@fireside/shared';
import type { Profile } from './profiles.js';
import type { Rng } from './rng.js';

// Simulated quest and achievement diary progress for the seed. Each account
// starts somewhere (the main has done most, the iron about half, the F2P alt a
// few free quests) and moves on during its sessions: a quest is started or
// finished, the next diary tier of a region is completed. A snapshot is sent
// after login only if the content changed since the last one sent, and after
// each change during a session, like the plugin. Keys and names are RuneLite's
// `Quest` enum (a subset); quest points are approximate.

interface SeedQuest {
  quest: string;
  name: string;
  points: number;
  kind: QuestKind;
  members: boolean;
}

function quest(quest: string, name: string, points: number, members = true): SeedQuest {
  return { quest, name, points, kind: 'QUEST', members };
}

function miniquest(quest: string, name: string): SeedQuest {
  return { quest, name, points: 0, kind: 'MINIQUEST', members: true };
}

export const SEED_QUESTS: readonly SeedQuest[] = [
  quest('COOKS_ASSISTANT', "Cook's Assistant", 1, false),
  quest('SHEEP_SHEARER', 'Sheep Shearer', 1, false),
  quest('THE_RESTLESS_GHOST', 'The Restless Ghost', 1, false),
  quest('RUNE_MYSTERIES', 'Rune Mysteries', 1, false),
  quest('IMP_CATCHER', 'Imp Catcher', 1, false),
  quest('ERNEST_THE_CHICKEN', 'Ernest the Chicken', 4, false),
  quest('VAMPYRE_SLAYER', 'Vampyre Slayer', 3, false),
  quest('DORICS_QUEST', "Doric's Quest", 1, false),
  quest('GOBLIN_DIPLOMACY', 'Goblin Diplomacy', 5, false),
  quest('ROMEO__JULIET', 'Romeo & Juliet', 5, false),
  quest('DEMON_SLAYER', 'Demon Slayer', 3, false),
  quest('PRINCE_ALI_RESCUE', 'Prince Ali Rescue', 3, false),
  quest('THE_KNIGHTS_SWORD', "The Knight's Sword", 1, false),
  quest('BLACK_KNIGHTS_FORTRESS', "Black Knights' Fortress", 3, false),
  quest('DRAGON_SLAYER_I', 'Dragon Slayer I', 2, false),
  quest('X_MARKS_THE_SPOT', 'X Marks the Spot', 1, false),
  quest('BELOW_ICE_MOUNTAIN', 'Below Ice Mountain', 1, false),
  quest('MISTHALIN_MYSTERY', 'Misthalin Mystery', 1, false),
  quest('PIRATES_TREASURE', "Pirate's Treasure", 2, false),
  quest('WITCHS_POTION', "Witch's Potion", 1, false),
  quest('DRUIDIC_RITUAL', 'Druidic Ritual', 4),
  quest('WATERFALL_QUEST', 'Waterfall Quest', 1),
  quest('TREE_GNOME_VILLAGE', 'Tree Gnome Village', 2),
  quest('THE_GRAND_TREE', 'The Grand Tree', 5),
  quest('FIGHT_ARENA', 'Fight Arena', 2),
  quest('PRIEST_IN_PERIL', 'Priest in Peril', 1),
  quest('LOST_CITY', 'Lost City', 3),
  quest('FAIRYTALE_I__GROWING_PAINS', 'Fairytale I - Growing Pains', 2),
  quest('FAIRYTALE_II__CURE_A_QUEEN', 'Fairytale II - Cure a Queen', 2),
  quest('ANIMAL_MAGNETISM', 'Animal Magnetism', 1),
  quest('BONE_VOYAGE', 'Bone Voyage', 1),
  quest('MONKEY_MADNESS_I', 'Monkey Madness I', 3),
  quest('UNDERGROUND_PASS', 'Underground Pass', 5),
  quest('REGICIDE', 'Regicide', 3),
  quest('HEROES_QUEST', "Heroes' Quest", 1),
  quest('LEGENDS_QUEST', "Legends' Quest", 4),
  quest('THRONE_OF_MISCELLANIA', 'Throne of Miscellania', 1),
  quest('CABIN_FEVER', 'Cabin Fever', 2),
  quest('LUNAR_DIPLOMACY', 'Lunar Diplomacy', 2),
  quest('DESERT_TREASURE_I', 'Desert Treasure I', 3),
  quest('RECIPE_FOR_DISASTER', 'Recipe for Disaster', 10),
  quest('MONKEY_MADNESS_II', 'Monkey Madness II', 4),
  quest('DRAGON_SLAYER_II', 'Dragon Slayer II', 5),
  quest('SONG_OF_THE_ELVES', 'Song of the Elves', 4),
  quest('SINS_OF_THE_FATHER', 'Sins of the Father', 2),
  quest('A_KINGDOM_DIVIDED', 'A Kingdom Divided', 2),
  quest('DESERT_TREASURE_II__THE_FALLEN_EMPIRE', 'Desert Treasure II - The Fallen Empire', 5),
  quest('WHILE_GUTHIX_SLEEPS', 'While Guthix Sleeps', 5),
  miniquest('ALFRED_GRIMHANDS_BARCRAWL', "Alfred Grimhand's Barcrawl"),
  miniquest('BEAR_YOUR_SOUL', 'Bear Your Soul'),
  miniquest('ENTER_THE_ABYSS', 'Enter the Abyss'),
  miniquest('LAIR_OF_TARN_RAZORLOR', 'Lair of Tarn Razorlor'),
  miniquest('MAGE_ARENA_I', 'Mage Arena I'),
  miniquest('MAGE_ARENA_II', 'Mage Arena II'),
];

const REGIONS = Object.keys(DIARY_REGIONS);

interface Progress {
  /** Share of the quests the account can do that start as finished / in progress. */
  finished: number;
  inProgress: number;
  /** Completed tiers per region at the start (0–4, tiers in order). */
  diaryTiers: readonly [number, number];
  /** Chance per session that a quest moves on / a diary tier is completed. */
  questChance: number;
  diaryChance: number;
}

const PROGRESS: Record<Profile['key'], Progress> = {
  main: { finished: 0.8, inProgress: 0.06, diaryTiers: [2, 4], questChance: 0.2, diaryChance: 0.1 },
  iron: {
    finished: 0.5,
    inProgress: 0.08,
    diaryTiers: [0, 3],
    questChance: 0.3,
    diaryChance: 0.12,
  },
  alt: { finished: 0.35, inProgress: 0.1, diaryTiers: [0, 0], questChance: 0.2, diaryChance: 0 },
};

/** Chance that a change at the very end of a session is not sent before the client closes. */
const UNSENT_CHANCE = 0.5;

export interface QuestSnapshots {
  quests?: QuestsSnapshotPayload;
  diaries?: DiariesSnapshotPayload;
}

export class QuestSim {
  private readonly states = new Map<string, QuestState>();
  /** Completed tiers per region; tiers are completed in order. */
  private readonly tiers = new Map<string, number>();
  private readonly progress: Progress;
  private sentQuests = '';
  private sentDiaries = '';

  constructor(
    private readonly profile: Profile,
    private readonly rng: Rng,
  ) {
    this.progress = PROGRESS[profile.key];
    for (const entry of SEED_QUESTS) {
      const roll = rng.next();
      const { finished, inProgress } = this.progress;
      this.states.set(
        entry.quest,
        !this.canDo(entry)
          ? 'NOT_STARTED'
          : roll < finished
            ? 'FINISHED'
            : roll < finished + inProgress
              ? 'IN_PROGRESS'
              : 'NOT_STARTED',
      );
    }
    for (const region of REGIONS) this.tiers.set(region, rng.int(...this.progress.diaryTiers));
  }

  private canDo(entry: SeedQuest): boolean {
    return this.profile.members || !entry.members;
  }

  /** The minute of a session (1-based) when something changes, or `null`. */
  planSession(minutes: number): number | null {
    const { questChance, diaryChance } = this.progress;
    if (minutes < 3 || !this.rng.chance(questChance + diaryChance)) return null;
    return this.rng.int(2, minutes - 1);
  }

  /** One step: a quest is started or finished, or the next diary tier of a region is completed. */
  advance(): void {
    const { questChance, diaryChance } = this.progress;
    if (this.rng.chance(diaryChance / (questChance + diaryChance)) && this.advanceDiary()) return;
    this.advanceQuest();
  }

  /** A change right before the client closes: sometimes it is first sent after the next login. */
  advanceUnsent(): void {
    if (this.rng.chance(this.progress.questChance * UNSENT_CHANCE)) this.advanceQuest();
  }

  private advanceQuest(): void {
    const open = SEED_QUESTS.filter(
      (entry) => this.canDo(entry) && this.states.get(entry.quest) !== 'FINISHED',
    );
    const started = open.filter((entry) => this.states.get(entry.quest) === 'IN_PROGRESS');
    // Mostly finish what is started; otherwise start (or do in one go) a new one.
    const pool = started.length > 0 && this.rng.chance(0.6) ? started : open;
    if (pool.length === 0) return;
    const entry = this.rng.pick(pool);
    const state = this.states.get(entry.quest);
    this.states.set(
      entry.quest,
      state === 'NOT_STARTED' && this.rng.chance(0.6) ? 'IN_PROGRESS' : 'FINISHED',
    );
  }

  private advanceDiary(): boolean {
    const open = REGIONS.filter((region) => (this.tiers.get(region) ?? 0) < DIARY_TIERS.length);
    if (open.length === 0) return false;
    const region = this.rng.pick(open);
    this.tiers.set(region, (this.tiers.get(region) ?? 0) + 1);
    return true;
  }

  /** The snapshots to send now: those whose content changed since the last one sent. */
  changed(): QuestSnapshots {
    const result: QuestSnapshots = {};
    const quests = this.questsPayload();
    const questsKey = JSON.stringify(quests);
    if (questsKey !== this.sentQuests) {
      this.sentQuests = questsKey;
      result.quests = quests;
    }
    const diaries = this.diariesPayload();
    const diariesKey = JSON.stringify(diaries);
    if (diariesKey !== this.sentDiaries) {
      this.sentDiaries = diariesKey;
      result.diaries = diaries;
    }
    return result;
  }

  private questsPayload(): QuestsSnapshotPayload {
    let questPoints = 0;
    const quests = SEED_QUESTS.map((entry) => {
      const state = this.states.get(entry.quest) ?? 'NOT_STARTED';
      if (state === 'FINISHED') questPoints += entry.points;
      return { quest: entry.quest, name: entry.name, state, kind: entry.kind };
    });
    return { questPoints, quests };
  }

  private diariesPayload(): DiariesSnapshotPayload {
    return {
      diaries: REGIONS.flatMap((region) =>
        DIARY_TIERS.map((tier, index) => ({
          region,
          tier,
          completed: index < (this.tiers.get(region) ?? 0),
        })),
      ),
    };
  }
}
