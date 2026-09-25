import type { BuyItemId, SiteInfo } from "./protocol.js";

export const COMPETITIVE_RULES = {
  warmupSeconds: 30,
  freezeSeconds: 15,
  roundSeconds: 105,
  plantSeconds: 3,
  deviceSeconds: 40,
  defuseSeconds: 10,
  kitDefuseSeconds: 5,
  roundEndSeconds: 5,
  halftimeSeconds: 12,
  halftimeAfterRound: 6,
  roundsToWin: 13,
  initialMoney: 800,
  maximumMoney: 16000,
  winReward: 3250,
  lossReward: 1400,
  lossStreakStep: 500,
  lossBonusMaxStreak: 4,
  killReward: 300,
  plantReward: 300,
  defuseReward: 300,
  assistReward: 200,
  buyRadius: 9,
  devicePickupRadius: 1.5,
  plantRadius: 3.2,
  defuseRadius: 2.1,
} as const;

export const BUY_PRICES: Record<BuyItemId, number> = {
  AR12: 2700,
  VEST: 650,
  HELMET: 350,
  DEFUSE_KIT: 400,
};

export const SITES: SiteInfo[] = [
  { id: "A", x: -17, z: -7, radius: COMPETITIVE_RULES.plantRadius },
  { id: "B", x: 17, z: 7, radius: COMPETITIVE_RULES.plantRadius },
];
