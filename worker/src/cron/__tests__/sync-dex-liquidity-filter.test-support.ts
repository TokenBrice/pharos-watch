import type { DexApiPool } from "../../lib/dex-api-common";
import type { LlamaPool } from "../dex-liquidity/types";

export function makeOrcaPair() {
  const sol = "So11111111111111111111111111111111111111112";
  const usdc = "EPjFWdd5AufqSSqeM2qA5N8Y7W5a4d8nQv1F6P5a6X1";
  const primary: LlamaPool = {
    pool: "4f44c5d5-b1c2-4b1c-a111-123456789abc", chain: "Solana", project: "orca-dex",
    symbol: "SOL-USDC", tvlUsd: 29_000_000, volumeUsd1d: 2_500_000, volumeUsd7d: 17_000_000,
    stablecoin: false, underlyingTokens: [sol, usdc], apyBase: null, apyReward: null,
    apy: 0, sigma: 0, exposure: "multi", count: 20,
  };
  const direct: DexApiPool = {
    source: "orca", chain: "solana", poolAddress: "9j7M8s9d5M5x6o8N9vQm3P4r5T6u7V8w9X1y2Z3a4Bc",
    poolType: "orca-whirlpool", tokens: [
      { address: usdc, symbol: "USDC", decimals: 6 },
      { address: sol, symbol: "SOL", decimals: 9 },
    ], price: 150, tvlUsd: 29_000_000, volume24hUsd: 2_500_000,
    feeRate: 0.0001, balances: [100_000, 200_000],
  };
  return { primary, direct };
}
