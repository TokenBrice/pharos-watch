import type { MintBurnFlowsResponse } from "@shared/types";

type MintBurnFlowCoin = MintBurnFlowsResponse["coins"][number];

/** Canonical signed-v2 mint-burn coin row for flows page and hook tests (AP-3 contract). */
export function makeMintBurnFlowCoin(overrides: Partial<MintBurnFlowCoin> = {}): MintBurnFlowCoin {
  return {
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    flowIntensity: -42,
    pressureShiftScore: -42,
    pressureShiftState: "worsening",
    netFlowDirection24h: "burning",
    has24hActivity: true,
    baselineDailyNetUsd: 1_000_000,
    baselineDailyAbsUsd: 2_000_000,
    baselineDataDays: 30,
    netFlow24hUsd: -3_000_000,
    mintVolume24hUsd: 1_000_000,
    burnVolume24hUsd: 4_000_000,
    mintCount24h: 1,
    burnCount24h: 2,
    netFlow7dUsd: -5_000_000,
    netFlow30dUsd: -8_000_000,
    netFlow90dUsd: -10_000_000,
    largestEvent24h: null,
    ...overrides,
  };
}
