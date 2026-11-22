import { createHash } from 'node:crypto';
import {
  BANK_FILLER_ITEM_ID,
  BANK_TAB_COUNT,
  COINS_ITEM_ID,
  PLATINUM_TOKEN_ITEM_ID,
  type BankItem,
  type BankSnapshotPayload,
  type EquipmentItem,
  type InventoryItem,
  type LootItem,
  type PotionStorageSnapshotPayload,
} from '@fireside/shared';
import { ITEMS, type Item } from './items.js';
import type { Profile } from './profiles.js';
import type { Rng } from './rng.js';

// Simulated bank, inventory, equipment and potion storage for the seed. Each
// account's bank changes with its sessions: loot is deposited, supplies are
// withdrawn and used, the main sells loot and buys big items (old gear stays
// behind as a placeholder), the iron keeps everything and has many
// placeholders. A snapshot is sent when the bank closes, only if its content
// changed, like the plugin. Item names and IDs only: no icons or other Jagex
// assets (see docs/legal.md).

const DAY_MS = 86_400_000;

function item(id: number, name: string, ge: number, ha: number): Item {
  return { id, name, ge, ha };
}

/** Items only the bank uses (loot items come from `ITEMS`). Untradeables have GE 0. */
export const BANK_ITEMS = {
  platinumToken: item(PLATINUM_TOKEN_ITEM_ID, 'Platinum token', 1000, 1000),
  /** A reserved empty slot: an ordinary item with quantity 1 and no price, as the plugin sends it. */
  bankFiller: item(BANK_FILLER_ITEM_ID, 'Bank filler', 0, 0),
  twistedBow: item(20997, 'Twisted bow', 1_450_000_000, 720_000),
  scytheOfVitur: item(22325, 'Scythe of vitur', 1_100_000_000, 750_000),
  armadylGodsword: item(11802, 'Armadyl godsword', 9_800_000, 750_000),
  armadylCrossbow: item(11785, 'Armadyl crossbow', 33_000_000, 210_000),
  toxicBlowpipe: item(12924, 'Toxic blowpipe (empty)', 3_600_000, 60_000),
  dragonWarhammer: item(13576, 'Dragon warhammer', 26_000_000, 150_000),
  amuletOfFury: item(6585, 'Amulet of fury', 2_500_000, 24_000),
  dragonDefender: item(12954, 'Dragon defender', 0, 40_800),
  fireCape: item(6570, 'Fire cape', 0, 0),
  barrowsGloves: item(7462, 'Barrows gloves', 0, 78_000),
  avasAccumulator: item(10499, "Ava's accumulator", 0, 600),
  dragonBoots: item(11840, 'Dragon boots', 220_000, 30_000),
  berserkerRing: item(6737, 'Berserker ring', 2_300_000, 60_000),
  occultNecklace: item(12002, 'Occult necklace', 600_000, 210_000),
  runePouch: item(12791, 'Rune pouch', 0, 720),
  runeCrossbow: item(9185, 'Rune crossbow', 12_000, 9_720),
  runeArrow: item(892, 'Rune arrow', 110, 240),
  dragonArrow: item(11212, 'Dragon arrow', 1_500, 600),
  saradominBrew4: item(6685, 'Saradomin brew(4)', 6_800, 120),
  superCombat4: item(12695, 'Super combat potion(4)', 12_400, 450),
  superRestore4: item(3024, 'Super restore(4)', 10_100, 180),
  rangingPotion4: item(2444, 'Ranging potion(4)', 1_100, 108),
  staminaPotion4: item(12625, 'Stamina potion(4)', 7_500, 150),
  antiVenomPlus4: item(12913, 'Anti-venom+(4)', 9_000, 300),
  chisel: item(1755, 'Chisel', 10, 1),
  hammer: item(2347, 'Hammer', 30, 1),
  knife: item(946, 'Knife', 60, 3),
  spade: item(952, 'Spade', 60, 1),
  runePickaxe: item(1275, 'Rune pickaxe', 12_000, 19_200),
  ectophial: item(4251, 'Ectophial', 0, 0),
  feather: item(314, 'Feather', 3, 1),
} as const satisfies Record<string, Item>;

const B = BANK_ITEMS;
const I = ITEMS;

/** A potion in potion storage: the full (4-dose) item and its name without dose. */
interface PotionKind {
  item: Item;
  name: string;
}

const POTION = {
  superCombat: { item: B.superCombat4, name: 'Super combat potion' },
  prayer: { item: I.prayerPotion4, name: 'Prayer potion' },
  superRestore: { item: B.superRestore4, name: 'Super restore' },
  saradominBrew: { item: B.saradominBrew4, name: 'Saradomin brew' },
  ranging: { item: B.rangingPotion4, name: 'Ranging potion' },
  stamina: { item: B.staminaPotion4, name: 'Stamina potion' },
  antiVenomPlus: { item: B.antiVenomPlus4, name: 'Anti-venom+' },
} as const satisfies Record<string, PotionKind>;

const POTIONS: readonly PotionKind[] = Object.values(POTION);

/** Filler for the "misc" tabs: loot-table items the accounts don't use otherwise. */
const MISC: readonly Item[] = [
  I.bones,
  I.bigBones,
  I.dragonBones,
  I.superiorDragonBones,
  I.ashes,
  I.cowhide,
  I.blueDragonhide,
  I.boltRack,
  I.dragonBoltsUnf,
  I.cannonball,
  I.adamantiteOre,
  I.runiteBar,
  I.pureEssence,
  I.plank,
  I.oakPlank,
  I.teakPlank,
  I.dynamite,
  I.snakeskin,
  I.zulrahsScales,
  I.grimyCadantine,
  I.grimyDwarfWeed,
  I.grimyTorstol,
  I.limpwurtRoot,
  I.snapdragonSeed,
  I.seaweedSpore,
  I.uncutSapphire,
  I.uncutRuby,
  I.uncutDiamond,
  I.uncutDragonstone,
  I.dragonstone,
  I.rawSwordfish,
  I.vialOfBlood,
  I.purpleSweets,
  I.runeKiteshield,
  I.runeLongsword,
  I.runeTwoHandedSword,
  I.runePlatebody,
  I.runeBattleaxe,
  I.dragonDagger,
  I.dragonBattleaxe,
  I.dragonTwoHandedSword,
  I.battlestaff,
  I.magicLongbow,
  I.leatherBoots,
  I.hillGiantClub,
  I.godswordShard1,
  I.ahrimsRobetop,
  I.dharoksGreataxe,
  I.karilsCrossbow,
  I.guthansHelm,
  I.toragsHammers,
  I.veracsFlail,
  I.tomeOfFire,
  I.bandosBoots,
  I.abyssalDagger,
  I.wrathRune,
  I.soulRune,
];

interface Slot {
  item: Item;
  quantity: number;
}

/** Big items the main saves up for, in order, and the gear each one replaces. */
const MAIN_UPGRADES: readonly { item: Item; replaces?: Item }[] = [
  { item: B.dragonWarhammer },
  { item: B.armadylGodsword },
  { item: I.bandosTassets },
  { item: B.twistedBow, replaces: B.armadylCrossbow },
  { item: B.scytheOfVitur },
];

interface Start {
  /** Tabs 1–9 (missing ones are empty); index 9 is the main tab. */
  tabs: Slot[][];
  equipment: [string, Item, number][];
  potions: [PotionKind, number][];
  /** Items listed as placeholders from the start (iron: used up long ago). */
  placeholders: Item[];
  sells: boolean;
}

const s = (itemOf: Item, quantity: number): Slot => ({ item: itemOf, quantity });

function startOf(profile: Profile): Start {
  switch (profile.key) {
    case 'main':
      return {
        tabs: [
          // 1: melee and range gear
          [
            s(I.bandosChestplate, 1),
            s(B.armadylCrossbow, 1),
            s(B.toxicBlowpipe, 1),
            s(B.amuletOfFury, 1),
            s(B.berserkerRing, 1),
            s(B.dragonBoots, 1),
            s(B.occultNecklace, 1),
            s(I.dragonPickaxe, 1),
            // Fillers that hold the rest of the second row.
            s(B.bankFiller, 1),
            s(B.bankFiller, 1),
            s(B.bankFiller, 1),
            s(B.bankFiller, 1),
          ],
          // 2: food and potions
          [
            s(I.shark, 420),
            s(I.mantaRay, 180),
            s(I.prayerPotion4, 60),
            s(B.superCombat4, 25),
            s(B.saradominBrew4, 30),
            s(B.superRestore4, 40),
            s(B.staminaPotion4, 12),
          ],
          // 3: runes and ammo
          [
            s(I.deathRune, 4_200),
            s(I.bloodRune, 2_600),
            s(I.lawRune, 900),
            s(I.natureRune, 1_800),
            s(B.runeArrow, 3_000),
            s(B.dragonArrow, 400),
            s(B.runePouch, 1),
          ],
          // 4: skilling
          [
            s(I.magicLogs, 820),
            s(I.yewLogs, 2_400),
            s(I.runiteOre, 45),
            s(I.grimyRanarr, 120),
            s(I.ranarrSeed, 18),
          ],
          // 5: odds and ends kept "just in case"
          MISC.map((entry) => s(entry, 1 + (entry.id % 7))),
          [],
          [],
          [],
          [],
          // Main tab: tools, cash and loot that was never sorted
          [
            s(B.hammer, 1),
            s(B.chisel, 1),
            s(B.knife, 1),
            s(B.spade, 1),
            s(I.coins, 38_000_000),
            s(B.platinumToken, 420_000),
            s(B.feather, 5_000),
          ],
        ],
        equipment: [
          ['HEAD', I.robinHoodHat, 1],
          ['CAPE', B.fireCape, 1],
          ['AMULET', B.amuletOfFury, 1],
          ['AMMO', B.runeArrow, 150],
          // The extra ammo slot of Dizana's quiver.
          ['QUIVER_AMMO', B.dragonArrow, 80],
          ['WEAPON', I.abyssalWhip, 1],
          ['BODY', I.bandosChestplate, 1],
          ['SHIELD', B.dragonDefender, 1],
          ['GLOVES', B.barrowsGloves, 1],
          ['BOOTS', B.dragonBoots, 1],
          ['RING', B.berserkerRing, 1],
        ],
        potions: [
          [POTION.superCombat, 340],
          [POTION.prayer, 520],
          [POTION.superRestore, 180],
          [POTION.saradominBrew, 260],
          [POTION.stamina, 44],
        ],
        placeholders: [],
        sells: true,
      };
    case 'iron':
      return {
        tabs: [
          [
            s(B.runeCrossbow, 1),
            s(B.dragonDefender, 1),
            s(B.avasAccumulator, 1),
            s(I.runeScimitar, 1),
            s(I.dragonPickaxe, 1),
            s(I.dragonAxe, 1),
          ],
          [s(I.shark, 85), s(I.prayerPotion4, 14), s(I.rawShark, 40)],
          [s(I.deathRune, 600), s(I.chaosRune, 1_400), s(I.natureRune, 450), s(B.runeArrow, 800)],
          [
            s(I.coal, 1_900),
            s(I.goldOre, 300),
            s(I.yewLogs, 900),
            s(I.grimyToadflax, 34),
            s(I.ranarrSeed, 6),
            s(B.feather, 1_800),
          ],
          [s(B.ectophial, 1), s(B.runePouch, 1)],
          // 6: everything an iron never throws away
          MISC.map((entry) => s(entry, 1 + (entry.id % 23))),
          [],
          [],
          [],
          [s(B.hammer, 1), s(B.chisel, 1), s(B.knife, 1), s(B.spade, 1), s(I.coins, 2_400_000)],
        ],
        equipment: [
          ['HEAD', I.runeMedHelm, 1],
          ['CAPE', B.avasAccumulator, 1],
          ['WEAPON', B.runeCrossbow, 1],
          ['BODY', I.runeChainbody, 1],
          ['AMMO', B.runeArrow, 350],
        ],
        potions: [
          [POTION.prayer, 36],
          [POTION.ranging, 22],
        ],
        placeholders: [
          B.superCombat4,
          B.saradominBrew4,
          B.superRestore4,
          B.staminaPotion4,
          I.mantaRay,
          I.bloodRune,
          I.lawRune,
          B.dragonArrow,
          I.runiteOre,
          I.magicLogs,
          I.grimyRanarr,
          I.dragonHarpoon,
          B.toxicBlowpipe,
          B.barrowsGloves,
          B.fireCape,
        ],
        sells: false,
      };
    case 'alt':
      return {
        tabs: [
          [],
          [],
          [],
          [],
          [],
          [],
          [],
          [],
          [],
          [
            s(I.coins, 180_000),
            s(I.runeScimitar, 1),
            s(I.rawLobster, 60),
            s(I.airRune, 900),
            s(I.mindRune, 700),
            s(I.cowhide, 40),
            s(B.hammer, 1),
          ],
        ],
        equipment: [
          ['WEAPON', I.runeScimitar, 1],
          ['BODY', I.runeChainbody, 1],
        ],
        potions: [],
        placeholders: [],
        sells: false,
      };
  }
}

/** Slight price drift over time, so the value chart moves (±6 %, per item). */
function priceAt(base: number, itemId: number, ms: number): number {
  if (base <= 1) return base;
  const day = ms / DAY_MS;
  return Math.max(1, Math.round(base * (1 + 0.06 * Math.sin(day / 23 + itemId))));
}

function hashOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export interface BankClose {
  bank: BankSnapshotPayload | null;
  potionStorage: PotionStorageSnapshotPayload | null;
}

/** One account's bank over the seed window. */
export class BankSim {
  /** Index 0–8 = tabs 1–9, index 9 = main tab. Quantity 0 = placeholder. */
  private readonly tabs: Slot[][];
  private readonly equipment: [string, Item, number][];
  private readonly potions: Map<number, { kind: PotionKind; doses: number }>;
  private readonly sells: boolean;
  private inventory: Slot[] = [];
  private upgrade = 0;
  private bankHash = '';
  private potionHash = '';

  constructor(
    private readonly profile: Profile,
    private readonly rng: Rng,
  ) {
    const start = startOf(profile);
    this.tabs = start.tabs.map((tab) => tab.map((slot) => ({ ...slot })));
    // Placeholders go to the tab of their kind, or the main tab.
    for (const placeholder of start.placeholders) {
      const tab = POTIONS.some((p) => p.item.id === placeholder.id) ? 1 : 3;
      this.tabs[tab]?.push(s(placeholder, 0));
    }
    this.equipment = start.equipment;
    this.potions = new Map(start.potions.map(([kind, doses]) => [kind.item.id, { kind, doses }]));
    this.sells = start.sells;
  }

  private find(id: number): Slot | undefined {
    for (const tab of this.tabs) {
      const slot = tab.find((entry) => entry.item.id === id);
      if (slot) return slot;
    }
    return undefined;
  }

  private deposit(itemOf: Item, quantity: number): void {
    const slot = this.find(itemOf.id);
    if (slot) slot.quantity += quantity;
    else this.tabs[BANK_TAB_COUNT]?.push(s(itemOf, quantity));
  }

  /** Takes up to `quantity`; the slot stays as a placeholder at 0. */
  private withdraw(id: number, quantity: number): number {
    const slot = this.find(id);
    if (!slot) return 0;
    const taken = Math.min(slot.quantity, quantity);
    slot.quantity -= taken;
    return taken;
  }

  private cash(): number {
    return (
      (this.find(COINS_ITEM_ID)?.quantity ?? 0) +
      (this.find(PLATINUM_TOKEN_ITEM_ID)?.quantity ?? 0) * 1000
    );
  }

  /** Pays `amount` from coins, then platinum tokens. */
  private pay(amount: number): void {
    const coins = this.find(COINS_ITEM_ID);
    const fromCoins = Math.min(coins?.quantity ?? 0, amount);
    if (coins) coins.quantity -= fromCoins;
    const rest = amount - fromCoins;
    if (rest > 0) this.withdraw(PLATINUM_TOKEN_ITEM_ID, Math.ceil(rest / 1000));
  }

  /** Bank open before a PvM trip: food and potions to the inventory. */
  startTrip(pvm: boolean): void {
    if (!pvm) return;
    const food = this.profile.key === 'iron' ? I.shark : this.rng.pick([I.shark, I.mantaRay]);
    const taken = this.withdraw(food.id, this.rng.int(8, 18));
    const pots = this.withdraw(I.prayerPotion4.id, this.rng.int(2, 6));
    this.inventory = [
      ...(taken > 0 ? [s(food, taken)] : []),
      ...(pots > 0 ? [s(I.prayerPotion4, pots)] : []),
      s(I.coins, this.rng.int(10, 120) * 1000),
    ];
  }

  /**
   * Bank open at the end of a session: what's left of the inventory and the
   * session's loot go in, supplies are restocked, loot may be sold and a big
   * item bought. Potion storage doses are used on PvM trips.
   */
  endTrip(loot: readonly LootItem[], pvm: boolean): void {
    for (const slot of this.inventory) {
      // Most of the food and potions were eaten and drunk.
      const left =
        slot.item.id === COINS_ITEM_ID
          ? slot.quantity
          : Math.floor(slot.quantity * this.rng.float(0, 0.4));
      if (left > 0) this.deposit(slot.item, left);
    }
    this.inventory = this.rng.chance(0.6) ? [s(I.coins, this.rng.int(1, 60) * 1000)] : [];
    for (const drop of loot) {
      this.deposit(
        { id: drop.itemId, name: drop.name, ge: drop.gePrice, ha: drop.haPrice },
        drop.quantity,
      );
    }
    if (pvm) {
      for (const potion of this.potions.values()) {
        potion.doses = Math.max(0, potion.doses - this.rng.int(0, 24));
      }
    }
    this.restock();
    if (this.sells && this.rng.chance(0.35)) this.sellLoot();
    if (this.sells) this.buyUpgrade();
  }

  private restock(): void {
    const iron = this.profile.key === 'iron';
    for (const potion of this.potions.values()) {
      if (potion.doses < 40 && this.rng.chance(iron ? 0.15 : 0.5)) {
        const added = iron ? this.rng.int(20, 60) : this.rng.int(150, 300);
        potion.doses += added;
        if (!iron) this.pay(Math.round((added * potion.kind.item.ge) / 4));
      }
    }
    // The iron sometimes brews a new kind of potion.
    if (iron && this.potions.size < POTIONS.length && this.rng.chance(0.04)) {
      const kind = POTIONS.find((p) => !this.potions.has(p.item.id));
      if (kind) this.potions.set(kind.item.id, { kind, doses: this.rng.int(12, 40) });
    }
    for (const food of [I.shark, I.mantaRay, I.prayerPotion4]) {
      const slot = this.find(food.id);
      if (slot && slot.quantity < 40 && this.rng.chance(iron ? 0.2 : 0.6)) {
        const quantity = iron ? this.rng.int(20, 80) : this.rng.int(200, 400);
        slot.quantity += quantity;
        if (!iron) this.pay(quantity * food.ge);
      }
    }
  }

  /** The main sells unsorted loot in the main tab for its GE price. */
  private sellLoot(): void {
    const main = this.tabs[BANK_TAB_COUNT] ?? [];
    const keep = new Set<number>([
      COINS_ITEM_ID,
      PLATINUM_TOKEN_ITEM_ID,
      B.hammer.id,
      B.chisel.id,
      B.knife.id,
      B.spade.id,
      B.feather.id,
    ]);
    let earned = 0;
    for (const slot of main) {
      if (keep.has(slot.item.id) || slot.quantity === 0 || slot.item.ge === 0) continue;
      earned += slot.quantity * slot.item.ge;
      slot.quantity = 0;
    }
    // Duplicate gear from drops is sold, one of each is kept.
    for (const slot of this.tabs[0] ?? []) {
      if (slot.quantity > 1 && slot.item.ge > 0) {
        earned += (slot.quantity - 1) * slot.item.ge;
        slot.quantity = 1;
      }
    }
    // Sold loot doesn't leave placeholders in the main tab.
    this.tabs[BANK_TAB_COUNT] = main.filter((slot) => keep.has(slot.item.id) || slot.quantity > 0);
    this.deposit(I.coins, earned);
    // Large stacks of coins become platinum tokens.
    const coins = this.find(COINS_ITEM_ID);
    if (coins && coins.quantity > 200_000_000) {
      const tokens = Math.floor((coins.quantity - 50_000_000) / 1000);
      coins.quantity -= tokens * 1000;
      this.deposit(B.platinumToken, tokens);
    }
  }

  private buyUpgrade(): void {
    const next = MAIN_UPGRADES[this.upgrade];
    if (!next || this.cash() < next.item.ge * 1.02 || !this.rng.chance(0.4)) return;
    this.pay(next.item.ge);
    this.tabs[0]?.unshift(s(next.item, 1));
    if (next.replaces) {
      // Old gear sold: its slot stays as a placeholder.
      const old = this.find(next.replaces.id);
      if (old && old.quantity > 0) {
        old.quantity = 0;
        this.deposit(I.coins, next.replaces.ge);
      }
    }
    this.upgrade += 1;
  }

  /** The snapshots the plugin would send when the bank closes at `ms` (`null` = unchanged). */
  close(ms: number): BankClose {
    const price = (itemOf: Item) => ({
      gePrice: priceAt(itemOf.ge, itemOf.id, ms),
      haPrice: itemOf.ha,
    });
    const tabs = this.tabs.slice(0, BANK_TAB_COUNT).map((tab) => tab.length);
    const ordered = this.tabs.flat();
    const items: BankItem[] = ordered.map(({ item: itemOf, quantity }) =>
      quantity === 0
        ? { itemId: itemOf.id, name: itemOf.name, quantity: 0, placeholder: true, ...price(itemOf) }
        : { itemId: itemOf.id, name: itemOf.name, quantity, placeholder: false, ...price(itemOf) },
    );
    const inventory: InventoryItem[] = this.inventory.map(({ item: itemOf, quantity }) => ({
      itemId: itemOf.id,
      name: itemOf.name,
      quantity,
      ...price(itemOf),
    }));
    const equipment: EquipmentItem[] = this.equipment.map(([slot, itemOf, quantity]) => ({
      slot,
      itemId: itemOf.id,
      name: itemOf.name,
      quantity,
      ...price(itemOf),
    }));
    // Like the plugin: the hash covers content, not prices or names.
    const bankHash = hashOf([
      tabs,
      items.map((x) => [x.itemId, x.quantity, x.placeholder]),
      inventory.map((x) => [x.itemId, x.quantity]),
      equipment.map((x) => [x.slot, x.itemId, x.quantity]),
    ]);
    const potions = [...this.potions.values()]
      .filter((potion) => potion.doses > 0)
      .map(({ kind, doses }) => ({
        itemId: kind.item.id,
        name: kind.name,
        doses,
        itemDoses: 4,
        ...price(kind.item),
      }));
    const potionHash = hashOf(potions.map((p) => [p.itemId, p.doses]));

    const result: BankClose = { bank: null, potionStorage: null };
    if (bankHash !== this.bankHash) {
      this.bankHash = bankHash;
      result.bank = { tabSizes: tabs, items, inventory, equipment, contentHash: bankHash };
    }
    // Accounts that never used potion storage send nothing.
    if (potionHash !== this.potionHash && (potions.length > 0 || this.potionHash !== '')) {
      this.potionHash = potionHash;
      result.potionStorage = { potions, contentHash: potionHash };
    }
    return result;
  }
}
