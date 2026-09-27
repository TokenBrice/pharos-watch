import type { MintBurnFlowsResponse, MintBurnValuation } from "@shared/types";

type MintBurnFlowCoin = MintBurnFlowsResponse["coins"][number];
type MintBurnCoinValuation = NonNullable<MintBurnFlowCoin["valuation"]>;

/** Per-coin valuation completeness; complete by default, `window24h` fields overridable. */
export function makeMintBurnCoinValuation(
  window24h: Partial<MintBurnValuation> = {},
  overrides: Partial<Omit<MintBurnCoinValuation, "window24h">> = {},
): MintBurnCoinValuation {
  return {
    window24h: {
      completeness: "complete",
      mintCompleteness: "complete",
      burnCompleteness: "complete",
      unpricedMintEventCount: 0,
      unpricedBurnEventCount: 0,
      ...window24h,
    },
    baseline: "complete",
    netFlow7d: "complete",
    netFlow30d: "complete",
    netFlow90d: "complete",
    ...overrides,
  };
}

/** Canonical signed-v2 mint-burn coin row for flows page and hook tests (AP-3 contract). */
export function makeMintBurnFlowCoin(overrides: Partial<MintBurnFlowCoin> = {}): MintBurnFlowCoin {
  return {
    stablecoinId: "usdc-circle",
    symbol: "USDC",
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
    valuation: makeMintBurnCoinValuation(),
    ...overrides,
  };
}

/**
 * Tracked coin with no 24h activity and no published valuation (legacy/unknown);
 * unit tests override only the fields they exercise.
 */
export function makeInactiveMintBurnFlowCoin(overrides: Partial<MintBurnFlowCoin> = {}): MintBurnFlowCoin {
  return {
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    pressureShiftScore: null,
    pressureShiftState: "nr",
    netFlowDirection24h: "inactive",
    has24hActivity: false,
    baselineDailyNetUsd: null,
    baselineDailyAbsUsd: null,
    baselineDataDays: null,
    netFlow24hUsd: 0,
    mintVolume24hUsd: 0,
    burnVolume24hUsd: 0,
    mintCount24h: 0,
    burnCount24h: 0,
    netFlow7dUsd: 0,
    netFlow30dUsd: 0,
    netFlow90dUsd: 0,
    largestEvent24h: null,
    ...overrides,
  };
}
