import type { DigestInputData } from "@shared/types/digest";

export type DigestSnapshotDate = "2026-07-17" | "2026-07-18";

export interface DigestSnapshotFixture {
  date: DigestSnapshotDate;
  inputData: DigestInputData;
  prevInputData: DigestInputData | null;
  expectedLeadCandidateId: string;
  expectedCompetingCandidateIds: readonly string[];
  expectedLiquidityOrder: readonly string[];
}

const GENERATED_AT = {
  "2026-07-17": 1_784_275_522,
  "2026-07-18": 1_784_361_907,
} as const;

function dataQuality(generatedAt: number): NonNullable<DigestInputData["dataQuality"]> {
  return {
    generatedAt,
    stablecoinsCacheUpdatedAt: generatedAt - 296,
    stablecoinsCacheAgeSec: 296,
    windows: {
      blacklistActivity: { label: "rolling last 24h", start: generatedAt - 86_400, end: generatedAt },
      mintBurnFlows: { label: "rolling last 24h", start: generatedAt - 86_400, end: generatedAt },
      supplyVelocity: { label: "UTC snapshots", dates: [generatedAt, generatedAt - 86_400] },
      psi: { label: "latest sample", sampleAt: generatedAt - 539, dailySnapshotAt: generatedAt - 115_200 },
    },
  };
}

function liquidityShift(
  symbol: string,
  scoreDelta: number,
  mcapUsd: number,
): NonNullable<DigestInputData["liquidityShifts"]>[number] {
  const previousScore = 60;
  return {
    symbol,
    currentScore: previousScore + scoreDelta,
    previousScore,
    scoreDelta,
    currentTvl: 10_000_000,
    previousTvl: 12_000_000,
    mcapUsd,
    tvlChangePct: -1 / 6,
    expectedScoreDeltaFromTvl: -2,
    coverageClass: "primary",
    coverageConfidence: 0.9,
  };
}

function jul17Input(): DigestInputData {
  const generatedAt = GENERATED_AT["2026-07-17"];
  return {
    digestVersion: 3,
    totalMcapUsd: 250_000_000_000,
    mcap7dDelta: -1_000_000_000,
    dataQuality: dataQuality(generatedAt),
    activeDepegCount: 5,
    topDepegs: [
      {
        stablecoinId: "apxusd-apyx",
        symbol: "apxUSD",
        bps: -3_159,
        mcapUsd: 297_165_973,
        startedAt: 1_781_632_159,
        ageHours: 734,
        currentPriceUsd: 0.8608927847,
      },
      {
        stablecoinId: "usda-avalon",
        symbol: "USDA",
        bps: -3_098,
        mcapUsd: 148_011_899,
        startedAt: 1_767_128_451,
        ageHours: 4_763,
        currentPriceUsd: 0.9853003759,
      },
      {
        stablecoinId: "pmusd-precious-metals",
        symbol: "pmUSD",
        bps: -5_568,
        mcapUsd: 67_993_995,
        startedAt: 1_777_682_936,
        ageHours: 1_831,
        currentPriceUsd: 0.7236625167,
      },
      {
        stablecoinId: "usx-dforce",
        symbol: "USX",
        bps: -5_783,
        mcapUsd: 20_814_230,
        startedAt: 1_782_040_737,
        ageHours: 621,
        currentPriceUsd: 0.3910880197,
      },
      {
        stablecoinId: "usda-alpha-partner",
        symbol: "USDA",
        bps: -503,
        mcapUsd: 84_028_284,
        startedAt: 1_783_297_163,
        ageHours: 272,
        currentPriceUsd: 0.9663098557,
      },
    ],
    biggestSupplyChange: {
      id: "usds-sky",
      symbol: "USDS",
      name: "Sky Dollar",
      changeUsd: -878_511_293,
      currentMcap: 6_650_623_668,
    },
    stabilityIndex: {
      score: 95.1,
      band: "BEDROCK",
      components: { severity: 0.03, breadth: 3.41, stressBreadth: 1.09, trend: -0.65 },
    },
    yesterdayIndex: { score: 95.2, band: "BEDROCK" },
    supplyVelocity: [
      { coin: "USDC", change1d: 209_449_542, change7d: -124_117_202, signal: "reversed" },
    ],
    liquidityShifts: [
      liquidityShift("ONyc", -16, 229_397_164),
      liquidityShift("USDai", -9, 201_860_311),
    ],
  };
}

function jul18Input(): DigestInputData {
  const generatedAt = GENERATED_AT["2026-07-18"];
  return {
    digestVersion: 3,
    totalMcapUsd: 249_000_000_000,
    mcap7dDelta: -1_200_000_000,
    dataQuality: dataQuality(generatedAt),
    activeDepegCount: 5,
    topDepegs: [
      {
        stablecoinId: "apxusd-apyx",
        symbol: "apxUSD",
        bps: -3_159,
        mcapUsd: 295_099_602,
        startedAt: 1_781_632_159,
        ageHours: 758,
        currentPriceUsd: 0.8430123578,
      },
      {
        stablecoinId: "usda-avalon",
        symbol: "USDA",
        bps: -3_098,
        mcapUsd: 148_011_904,
        startedAt: 1_767_128_451,
        ageHours: 4_787,
        currentPriceUsd: 0.9821453166,
      },
      {
        stablecoinId: "pmusd-precious-metals",
        symbol: "pmUSD",
        bps: -5_568,
        mcapUsd: 66_262_101,
        startedAt: 1_777_682_936,
        ageHours: 1_855,
        currentPriceUsd: 0.7050225754,
      },
      {
        stablecoinId: "usx-dforce",
        symbol: "USX",
        bps: -5_783,
        mcapUsd: 20_814_227,
        startedAt: 1_782_040_737,
        ageHours: 645,
        currentPriceUsd: 0.377629,
      },
      {
        stablecoinId: "usda-alpha-partner",
        symbol: "USDA",
        bps: -503,
        mcapUsd: 83_946_074,
        startedAt: 1_783_297_163,
        ageHours: 296,
        currentPriceUsd: 0.9653136775,
      },
    ],
    biggestSupplyChange: {
      id: "usds-sky",
      symbol: "USDS",
      name: "Sky Dollar",
      changeUsd: -991_814_571,
      currentMcap: 6_602_555_524,
    },
    stabilityIndex: {
      score: 94.8,
      band: "BEDROCK",
      components: { severity: 0.03, breadth: 2.82, stressBreadth: 1.14, trend: -0.61 },
    },
    yesterdayIndex: { score: 95.1, band: "BEDROCK" },
    supplyVelocity: [
      { coin: "USDS", change1d: -41_691_740, change7d: -1_007_804_599, signal: "decelerating" },
    ],
    liquidityShifts: [
      liquidityShift("ONyc", -16, 234_182_765),
      liquidityShift("CASH", 12, 127_754_962),
    ],
  };
}

export function makeDigestSnapshotFixture(date: DigestSnapshotDate): DigestSnapshotFixture {
  const inputData = date === "2026-07-17" ? jul17Input() : jul18Input();
  return {
    date,
    inputData,
    prevInputData: date === "2026-07-17" ? null : jul17Input(),
    expectedLeadCandidateId: "depeg:apxusd-apyx:active",
    expectedCompetingCandidateIds: [
      "depeg:apxusd-apyx:active",
      "market:usds-sky:weekly-supply",
      date === "2026-07-17" ? "supply:usdc:reversed" : "supply:usds:decelerating",
    ],
    expectedLiquidityOrder: ["liquidity:onyc", date === "2026-07-17" ? "liquidity:usdai" : "liquidity:cash"],
  };
}
