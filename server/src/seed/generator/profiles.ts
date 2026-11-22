import type { AccountType, Skill } from '@fireside/shared';
import type { Range } from './activities.js';

// Simulated accounts. Display names are made up and clearly fake; they must
// never be real players (see docs/legal.md).

export interface PlayPattern {
  /** Chance of playing on a weekday / weekend day. */
  playChance: { weekday: number; weekend: number };
  /** Local start hour (fractional) of the evening block. */
  eveningStart: Range;
  /** Minutes per block on weekdays / weekends. */
  blockMinutes: { weekday: Range; weekend: Range };
  /** Chance of an extra daytime block on weekends. */
  weekendDayBlockChance: number;
  /** Chance that the evening block starts late (crosses midnight). */
  lateNightChance: number;
  /** Holiday length in days (no play). */
  holidayDays: Range;
}

export interface Profile {
  key: 'main' | 'iron' | 'alt';
  displayName: string;
  /** Temporary name used in the middle of the window (iron only). */
  otherName?: string;
  accountType: AccountType;
  /** Account type after the scripted change (iron only). */
  laterAccountType?: AccountType;
  /** Levels at the start of the window; missing skills are level 1. */
  startLevels: Partial<Record<Skill, number>>;
  /** Activities with weights. */
  activities: readonly (readonly [string, number])[];
  members: boolean;
  pattern: PlayPattern;
  /** Chance per active minute of going AFK. */
  afkPerMinute: number;
  /** AFK length in minutes (at least the plugin's 5-minute threshold). */
  afkMinutes: Range;
  /** Chance per session of hopping worlds. */
  hopChance: number;
  /** Chance a session ends by closing the client instead of logging out. */
  clientClosedChance: number;
}

const ALL_99 = 99;

export const PROFILES: readonly Profile[] = [
  {
    key: 'main',
    displayName: 'Seed Main',
    accountType: 'NORMAL',
    startLevels: {
      ATTACK: ALL_99,
      DEFENCE: ALL_99,
      STRENGTH: ALL_99,
      HITPOINTS: ALL_99,
      RANGED: ALL_99,
      PRAYER: 95,
      MAGIC: ALL_99,
      COOKING: ALL_99,
      WOODCUTTING: 92,
      FLETCHING: ALL_99,
      FISHING: 91,
      FIREMAKING: ALL_99,
      CRAFTING: 90,
      SMITHING: 89,
      MINING: 85,
      HERBLORE: 92,
      AGILITY: 88,
      THIEVING: 87,
      SLAYER: 95,
      FARMING: ALL_99,
      RUNECRAFT: 82,
      HUNTER: 86,
      CONSTRUCTION: 90,
      SAILING: 42,
    },
    activities: [
      ['vorkath', 30],
      ['zulrah', 20],
      ['graardor', 14],
      ['calvarion', 10],
      ['seedUnknownBoss', 8],
      ['barrows', 5],
      ['sailing', 8],
      ['construction', 5],
      // Raids: about 28 % of picks, every mode but the entry modes. The Fractured
      // Archive is new (only picked after its release), so popular.
      ['cox', 9],
      ['cox-cm', 3],
      ['tob', 7],
      ['tob-hard', 2],
      ['toa', 5],
      ['toa-expert', 7],
      ['tfa', 15],
    ],
    members: true,
    pattern: {
      playChance: { weekday: 0.75, weekend: 0.9 },
      eveningStart: [18.5, 21],
      blockMinutes: { weekday: [90, 210], weekend: [150, 300] },
      weekendDayBlockChance: 0.45,
      lateNightChance: 0.12,
      holidayDays: [8, 10],
    },
    afkPerMinute: 0.012,
    afkMinutes: [5, 25],
    hopChance: 0.12,
    clientClosedChance: 0.15,
  },
  {
    key: 'iron',
    displayName: 'Seed Iron',
    otherName: 'Iron Seedling',
    accountType: 'HARDCORE_IRONMAN',
    laterAccountType: 'IRONMAN',
    startLevels: {
      ATTACK: 75,
      DEFENCE: 70,
      STRENGTH: 78,
      HITPOINTS: 77,
      RANGED: 74,
      PRAYER: 52,
      MAGIC: 76,
      COOKING: 70,
      WOODCUTTING: 71,
      FLETCHING: 66,
      FISHING: 68,
      FIREMAKING: 62,
      CRAFTING: 63,
      SMITHING: 60,
      MINING: 66,
      HERBLORE: 58,
      AGILITY: 62,
      THIEVING: 65,
      SLAYER: 72,
      FARMING: 67,
      RUNECRAFT: 55,
      HUNTER: 60,
      CONSTRUCTION: 58,
      SAILING: 30,
    },
    activities: [
      ['abyssal-demons', 18],
      ['barrows', 8],
      ['wintertodt', 12],
      ['tempoross', 10],
      ['agility', 14],
      ['woodcutting', 8],
      ['runecraft', 8],
      ['herb-run', 8],
      ['mining', 8],
      ['iron-sailing', 6],
      // Raids: about 16 % of picks, normal CoX and ToA plus entry modes.
      ['cox', 7],
      ['toa-entry', 4],
      ['toa', 4],
      ['tob-entry', 2],
      ['tfa', 4],
    ],
    members: true,
    pattern: {
      playChance: { weekday: 0.7, weekend: 0.85 },
      eveningStart: [19, 21.5],
      blockMinutes: { weekday: [60, 180], weekend: [120, 240] },
      weekendDayBlockChance: 0.55,
      lateNightChance: 0.1,
      holidayDays: [7, 9],
    },
    afkPerMinute: 0.02,
    afkMinutes: [5, 35],
    hopChance: 0.15,
    clientClosedChance: 0.2,
  },
  {
    key: 'alt',
    displayName: 'Seed Alt',
    accountType: 'ULTIMATE_IRONMAN',
    startLevels: {
      ATTACK: 20,
      DEFENCE: 10,
      STRENGTH: 25,
      HITPOINTS: 22,
      MAGIC: 15,
      COOKING: 12,
      WOODCUTTING: 18,
      FISHING: 14,
      FIREMAKING: 10,
      MINING: 16,
    },
    activities: [
      ['cows', 30],
      ['obor', 10],
      ['bryophyta', 8],
      ['f2p-mining', 15],
      ['f2p-fishing', 15],
      ['f2p-woodcutting', 12],
    ],
    members: false,
    pattern: {
      playChance: { weekday: 0.45, weekend: 0.6 },
      eveningStart: [17, 22],
      blockMinutes: { weekday: [15, 50], weekend: [20, 60] },
      weekendDayBlockChance: 0.3,
      lateNightChance: 0.05,
      holidayDays: [7, 8],
    },
    afkPerMinute: 0.03,
    afkMinutes: [5, 20],
    hopChance: 0.08,
    clientClosedChance: 0.3,
  },
];
