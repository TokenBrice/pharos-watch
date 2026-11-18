import type { DepegEvent } from "@shared/types/peg";

type RestorationEvent = Pick<DepegEvent,
  "id" | "stablecoinId" | "symbol" | "pegType" | "direction" | "peakDeviationBps" |
  "startedAt" | "endedAt" | "startPrice" | "peakPrice" | "recoveryPrice" | "pegReference" |
  "source" | "confirmationSources" | "pendingReason" | "closeReason"
>;

export const REFERENCE_MARKET_RESTORATIONS = [
  {
    archive: "44f025dd34^:data/depeg-events/2024.json",
    reopen: 1_713_135_600,
    event: {
      id: 24994, stablecoinId: "paxg-paxos", symbol: "PAXG", pegType: "peggedGOLD", direction: "above",
      peakDeviationBps: 475, startedAt: 1_713_052_800, endedAt: 1_713_139_200, startPrice: 2457.901512524764,
      peakPrice: 2457.901512524764, recoveryPrice: 2393.496033151291, pegReference: 2346.4961340996924,
      source: "backfill", confirmationSources: null, pendingReason: null, closeReason: null,
    },
    legacyPsi: [{ day: 1_713_052_800, previousScore: 89.5, repairedScore: 95.7 }],
  },
  {
    archive: "44f025dd34^:data/depeg-events/2026.json",
    reopen: 1_776_639_600,
    event: {
      id: 89640, stablecoinId: "eurs-stasis", symbol: "EURS", pegType: "peggedEUR", direction: "above",
      peakDeviationBps: 296, startedAt: 1_776_529_166, endedAt: 1_776_555_244, startPrice: 1.2112365997199999,
      peakPrice: 1.2117332, recoveryPrice: 1.1844913051383028, pegReference: 1.17694, source: "live",
      confirmationSources: "NativePeg(EUR)+DEX+Pool", pendingReason: "low-confidence", closeReason: null,
    },
    legacyPsi: [{ day: 1_776_470_400, previousScore: 93.8, repairedScore: 95.5 }],
  },
] as const satisfies readonly {
  archive: string;
  reopen: number;
  event: RestorationEvent;
  legacyPsi: readonly { day: number; previousScore: number; repairedScore: number }[];
}[];
