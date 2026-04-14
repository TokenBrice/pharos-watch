import type { YieldType } from "@shared/types/core";

export interface ExplicitYieldPoolConfig {
  poolId: string;
  yieldSource: string;
  yieldType: YieldType;
  dataSource?: "defillama" | "defillama-auto";
  expectedProject?: string;
  expectedSymbol?: string;
  expectedChain?: string;
  minApy?: number;
  minTvlUsd?: number;
}

/**
 * Exact-pool curated yield venues for tracked assets that should stay outside
 * the generic stablecoin auto-discovery universe.
 */
export const EXPLICIT_YIELD_SOURCE_POOL_MAP: Record<string, ExplicitYieldPoolConfig[]> = {
  "bold-liquity": [
    {
      // BOLD - Liquity Stability Pool via K3 sBOLD wrapper on Ethereum
      poolId: "dac71f4f-7b97-463a-b19f-9796c56c21f1",
      yieldSource: "Liquity Stability Pool (via K3 sBOLD)",
      yieldType: "lending-vault",
      dataSource: "defillama-auto",
      expectedProject: "liquity-v2",
      expectedChain: "ethereum",
    },
  ],
  "xaut-tether": [
    {
      // XAUT - Yo Protocol isolated lending market on Ethereum
      poolId: "653c3979-83bc-40c9-aba0-f01a5ba0d118",
      yieldSource: "Yo Protocol",
      yieldType: "lending-opportunity",
      dataSource: "defillama",
      expectedProject: "yo-protocol",
      expectedSymbol: "XAUT",
      expectedChain: "ethereum",
    },
  ],
};
