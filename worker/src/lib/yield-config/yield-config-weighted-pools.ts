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
export const YIELD_WEIGHTED_POOL_GROUPS: Record<string, WeightedYieldPoolGroupConfig> = {};
