import type { YieldType } from "@shared/types/core";

export interface WeightedYieldPoolGroupConfig {
  sourceKey: string;
  poolIds: string[];
  yieldSource: string;
  yieldType: YieldType;
  expectedProject: string;
  expectedSymbol: string;
  expectedChainsByPoolId: Record<string, string>;
  minPools?: number;
}

/**
 * Exact DeFiLlama pool groups that should publish as one TVL-weighted row
 * because Pharos tracks one protocol asset while the yield wrapper is
 * deployed as chain-isolated, non-fungible vaults.
 */
export const YIELD_WEIGHTED_POOL_GROUPS: Record<string, WeightedYieldPoolGroupConfig> = {
  "sdusd-dtrinity": {
    sourceKey: "defillama-weighted:dtrinity-sdusd",
    yieldSource: "dTRINITY dStake (sdUSD)",
    yieldType: "lending-vault",
    expectedProject: "dtrinity-dusd",
    expectedSymbol: "SDUSD",
    minPools: 2,
    poolIds: [
      // Ethereum sdUSD - dTRINITY dStake
      "78049985-79a8-4343-8618-3c27d41d5054",
      // Fraxtal sdUSD - dTRINITY dStake
      "f42cf641-393d-4671-895a-3c85cf7b1a57",
    ],
    expectedChainsByPoolId: {
      "78049985-79a8-4343-8618-3c27d41d5054": "ethereum",
      "f42cf641-393d-4671-895a-3c85cf7b1a57": "fraxtal",
    },
  },
};
