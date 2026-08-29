import type { DEWSInput } from "../dews/types";

export function makeDewsInput(overrides: Partial<DEWSInput> = {}): DEWSInput {
  return {
    stablecoinId: "usdt-tether",
    mcapUsd: 5e9,
    pegType: "peggedUSD",
    // Supply velocity
    circulatingCurrent: 5e9,
    circulatingPrevDay: 5e9,
    circulatingPrevWeek: 5e9,
    // Pool balance
    weightedBalanceRatio: null,
    avgPoolStress: null,
    topPools: null,
    // Liquidity erosion
    liquidityScore: null,
    liquidityScore7dAgo: null,
    tvlCurrent: null,
    tvl7dAgo: null,
    // Price confidence
    priceConfidence: "high",
    prevPriceConfidence: null,
    price: 1,
    // Cross-source divergence
    pegRef: 1,
    dexPriceUsd: null,
    // Blacklist activity
    blacklistEvents24h: 0,
    blacklistEvents7d: 0,
    hasBlacklistTracking: false,
    // Mint/burn flow
    burnVolume24hUsd: null,
    mintVolume24hUsd: null,
    burnBaseline30dUsd: null,
    flowDataAgeDays: 0,
    // Yield anomaly
    yieldWarnings: [],
    // Systemic backdrop
    psiScore: null,
    ...overrides,
  };
}
