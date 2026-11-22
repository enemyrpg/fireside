import { RAIDS, type BossKc, type RaidSummary } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import {
  completedModes,
  fastestTeamSizes,
  isRaidEmpty,
  modeLabel,
  raidCards,
  raidColumn,
  raidCompletions,
  specialLootValue,
  splitRaidCards,
  teamSizeLabel,
  totalSpecialLoot,
} from './raids';

function raidKc(boss: string, raid: string, killCount = 10): BossKc {
  return {
    boss,
    killCount,
    lastObservedAt: '2026-11-08T21:10:00.000Z',
    bestTimeSeconds: null,
    gainedLast30Days: 0,
    byAccount: [{ accountId: 1, killCount }],
    category: 'raid',
    raid,
    bestTimesByTeamSize: [],
  };
}

const vorkath: BossKc = {
  ...raidKc('Vorkath', 'x'),
  category: 'boss',
  raid: null,
};

const summaries: RaidSummary[] = RAIDS.map((raid) => ({
  raid: raid.name,
  lootCount: 0,
  lootGeValue: 0,
  specialLootGeValue: 0,
}));

describe('modeLabel', () => {
  it('calls the base mode Normal and shortens the others', () => {
    expect(modeLabel('Theatre of Blood', 'Theatre of Blood')).toBe('Normal');
    expect(modeLabel('Theatre of Blood: Hard Mode', 'Theatre of Blood')).toBe('Hard Mode');
    expect(modeLabel('Odd mode', 'Theatre of Blood')).toBe('Odd mode');
  });
});

describe('teamSizeLabel', () => {
  it('names 1–3 and numbers the rest', () => {
    expect([1, 2, 3, 4, 8].map(teamSizeLabel)).toEqual(['Solo', 'Duo', 'Trio', '4', '8']);
  });
});

describe('raidCards', () => {
  it('has one card per raid with every mode, Entry Mode first', () => {
    const cards = raidCards(RAIDS, [], summaries);
    expect(cards.map((card) => card.raid)).toEqual(RAIDS.map((raid) => raid.name));
    expect(cards[0]?.modes.map((row) => row.label)).toEqual(['Normal', 'Challenge Mode']);
    expect(cards[1]?.modes.map((row) => row.label)).toEqual(['Entry Mode', 'Normal', 'Hard Mode']);
    expect(cards[2]?.modes.map((row) => row.label)).toEqual([
      'Entry Mode',
      'Normal',
      'Expert Mode',
    ]);
    expect(cards.every(isRaidEmpty)).toBe(true);
  });

  it('puts KC on its mode and ignores bosses', () => {
    const expert = raidKc('Tombs of Amascut: Expert Mode', 'Tombs of Amascut', 140);
    const cards = raidCards(RAIDS, [vorkath, expert], summaries);
    const toa = cards[2];
    expect(toa?.modes.find((row) => row.label === 'Expert Mode')?.kc).toBe(expert);
    expect(toa?.modes.find((row) => row.label === 'Normal')?.kc).toBeUndefined();
    expect(toa && isRaidEmpty(toa)).toBe(false);
    expect(cards.flatMap((card) => card.modes).some((row) => row.mode === 'Vorkath')).toBe(false);
  });

  it('keeps unknown modes and raids by name', () => {
    const newMode = raidKc('Tombs of Amascut: Nightmare Mode', 'Tombs of Amascut');
    const newRaid = raidKc('New Raid: Hard Mode', 'New Raid');
    const cards = raidCards(RAIDS, [newMode, newRaid], summaries);
    expect(cards[2]?.modes.at(-1)?.label).toBe('Nightmare Mode');
    expect(cards.at(-1)?.raid).toBe('New Raid');
    expect(cards.at(-1)?.modes.map((row) => row.label)).toEqual(['Hard Mode']);
    expect(cards.at(-1)?.summary).toBeUndefined();
  });

  it('is not empty with loot but no completions', () => {
    const withLoot = summaries.map((summary, index) =>
      index === 0 ? { ...summary, lootCount: 1, lootGeValue: 5 } : summary,
    );
    const [cox] = raidCards(RAIDS, [], withLoot);
    expect(cox && isRaidEmpty(cox)).toBe(false);
  });

  it('has your share per raid, and is not empty with only a share', () => {
    const shares = RAIDS.map((raid, index) => ({
      raid: raid.name,
      share: index === 1 ? 200 : 0,
      fromOwnDrops: 0,
      fromTeammateDrops: index === 1 ? 200 : 0,
      manualSpecialLootValue: 0,
    }));
    const newRaid = raidKc('New Raid: Hard Mode', 'New Raid');
    const cards = raidCards(RAIDS, [newRaid], summaries, shares);
    expect(cards.map((card) => card.share)).toEqual([0, 200, 0, 0, undefined]);
    // A teammate's purple added by hand in a raid you have no KC or loot from.
    expect(cards.map(isRaidEmpty)).toEqual([true, false, true, true, false]);
  });

  it('adds own purples added by hand to special loot, and is not empty with only one', () => {
    const shares = RAIDS.map((raid, index) => ({
      raid: raid.name,
      share: 0,
      fromOwnDrops: 0,
      fromTeammateDrops: 0,
      // A split without a party size: no share yet, but special loot.
      manualSpecialLootValue: index === 0 ? 30 : 0,
    }));
    const withPurple = summaries.map((summary, index) =>
      index === 0 ? { ...summary, lootCount: 1, specialLootGeValue: 12 } : summary,
    );
    expect(raidCards(RAIDS, [], withPurple, shares).map(specialLootValue)).toEqual([42, 0, 0, 0]);
    const manualOnly = raidCards(RAIDS, [], summaries, shares);
    expect(manualOnly.map((card) => card.manualSpecialLoot)).toEqual([30, 0, 0, 0]);
    expect(manualOnly.map(isRaidEmpty)).toEqual([false, true, true, true]);
    // Without the tracker (loading or failed) only what the plugin recorded shows.
    expect(raidCards(RAIDS, [], withPurple).map(specialLootValue)).toEqual([12, 0, 0, 0]);
  });
});

describe('fastestTeamSizes', () => {
  it('marks the fastest size', () => {
    expect(
      fastestTeamSizes([
        { teamSize: 2, seconds: 1338 },
        { teamSize: 3, seconds: 1065 },
        { teamSize: 4, seconds: 1123.8 },
      ]),
    ).toEqual(new Set([3]));
  });

  it('marks every size tied for fastest, as shown to a tenth', () => {
    expect(
      fastestTeamSizes([
        { teamSize: 1, seconds: 1215 },
        { teamSize: 5, seconds: 894 },
        { teamSize: 6, seconds: 894.01 },
        { teamSize: 9, seconds: 893.98 },
      ]),
    ).toEqual(new Set([5, 6, 9]));
  });

  it('marks a single size, and nothing without times', () => {
    expect(fastestTeamSizes([{ teamSize: 4, seconds: 1000 }])).toEqual(new Set([4]));
    expect(fastestTeamSizes([])).toEqual(new Set());
  });
});

describe('splitRaidCards and raidColumn', () => {
  const [cox, tob, toa, tfa] = RAIDS.map((raid) => raid.name) as [string, string, string, string];

  it('gives a card to raids that are not empty and names the rest', () => {
    const cards = raidCards(
      RAIDS,
      [raidKc(`${tob}: Hard Mode`, tob), raidKc(tfa, tfa)],
      summaries,
      [
        {
          raid: cox,
          share: 1_000,
          manualSpecialLootValue: 0,
          fromOwnDrops: 0,
          fromTeammateDrops: 1_000,
        },
      ],
    );
    const { shown, empty, pending } = splitRaidCards(cards);
    // A share alone still makes a card.
    expect(shown.map((card) => card.raid)).toEqual([cox, tob, tfa]);
    expect(empty).toEqual([toa]);
    expect(pending).toBe(0);
  });

  describe('before the tracker has answered', () => {
    // ToB has completions, ToA loot only, CoX a share only, TFA nothing.
    const withLoot = summaries.map((summary) =>
      summary.raid === toa ? { ...summary, lootCount: 3, lootGeValue: 9_000 } : summary,
    );
    const share = {
      raid: cox,
      share: 1_000,
      manualSpecialLootValue: 0,
      fromOwnDrops: 0,
      fromTeammateDrops: 1_000,
    };

    it('shows raids with completions or loot, and holds the others back', () => {
      // `shares` undefined: the tracker is loading.
      const cards = raidCards(RAIDS, [raidKc(tob, tob)], withLoot);
      const { shown, empty, pending } = splitRaidCards(cards, 'loading');
      expect(shown.map((card) => card.raid)).toEqual([tob, toa]);
      // CoX and TFA are neither a card nor on the dashed line yet.
      expect(empty).toEqual([]);
      expect(pending).toBe(2);
    });

    it('gives the share its card once the tracker has answered', () => {
      const cards = raidCards(RAIDS, [raidKc(tob, tob)], withLoot, [share]);
      const { shown, empty } = splitRaidCards(cards, 'loaded');
      expect(shown.map((card) => card.raid)).toEqual([cox, tob, toa]);
      expect(empty).toEqual([tfa]);
    });

    it('decides from completions and loot alone when the tracker failed', () => {
      const cards = raidCards(RAIDS, [raidKc(tob, tob)], withLoot);
      const { shown, empty, pending } = splitRaidCards(cards, 'failed');
      expect(shown.map((card) => card.raid)).toEqual([tob, toa]);
      expect(empty).toEqual([cox, tfa]);
      expect(pending).toBe(0);
    });
  });

  it('never puts a raid with a share or loot but no completions on the dashed line', () => {
    const withLoot = summaries.map((summary) =>
      summary.raid === toa ? { ...summary, lootCount: 1, lootGeValue: 5 } : summary,
    );
    const manual = {
      raid: tfa,
      share: 0,
      manualSpecialLootValue: 30,
      fromOwnDrops: 0,
      fromTeammateDrops: 0,
    };
    const share = { ...manual, raid: cox, share: 10, manualSpecialLootValue: 0 };
    for (const state of ['loading', 'loaded', 'failed'] as const) {
      const cards = raidCards(
        RAIDS,
        [],
        withLoot,
        state === 'loaded' ? [share, manual] : undefined,
      );
      const { shown, empty } = splitRaidCards(cards, state);
      // Loot (ToA) is a card in every state; never also on the line.
      expect(shown.map((card) => card.raid)).toContain(toa);
      expect(empty).not.toContain(toa);
      if (state === 'loaded') {
        expect(empty).toEqual([tob]);
      }
      for (const name of shown.map((card) => card.raid)) {
        expect(empty).not.toContain(name);
      }
    }
  });

  it('alternates the columns among the cards shown only', () => {
    // ToB and TFA shown, CoX and ToA empty: left, right, no gap.
    const cards = raidCards(RAIDS, [raidKc(tob, tob), raidKc(tfa, tfa)], summaries);
    const { shown } = splitRaidCards(cards);
    expect(shown.map((card, index) => [card.raid, raidColumn(index)])).toEqual([
      [tob, 'left'],
      [tfa, 'right'],
    ]);
    expect([0, 1, 2, 3].map(raidColumn)).toEqual(['left', 'right', 'left', 'right']);
  });
});

describe('completedModes and raidCompletions', () => {
  it('lists only modes with completions and sums them over the raids that have any', () => {
    const toa = 'Tombs of Amascut';
    const cards = raidCards(
      RAIDS,
      [
        raidKc(`${toa}: Expert Mode`, toa, 140),
        raidKc(toa, toa, 60),
        raidKc('Theatre of Blood', 'Theatre of Blood', 5),
        vorkath,
      ],
      summaries,
    );
    const toaCard = cards.find((card) => card.raid === toa);
    if (!toaCard) throw new Error('No ToA card');
    expect(completedModes(toaCard).map((row) => row.label)).toEqual(['Normal', 'Expert Mode']);
    expect(raidCompletions(cards)).toEqual({ completions: 205, raids: 2 });
    expect(raidCompletions([])).toEqual({ completions: 0, raids: 0 });
  });
});

describe('totalSpecialLoot', () => {
  it('adds every raid’s special loot, purples added by hand included', () => {
    const cards = raidCards(
      RAIDS,
      [],
      summaries.map((summary, index) => ({ ...summary, specialLootGeValue: index * 1_000 })),
      [
        {
          raid: 'Chambers of Xeric',
          share: 0,
          manualSpecialLootValue: 500,
          fromOwnDrops: 0,
          fromTeammateDrops: 0,
        },
      ],
    );
    // 0 + 1,000 + 2,000 + 3,000 recorded, and 500 added by hand.
    expect(totalSpecialLoot(cards)).toBe(6_500);
  });
});
