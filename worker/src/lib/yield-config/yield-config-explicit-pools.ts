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
// K3 sBOLD's raw Liquity Stability Pool pin is quarantined (2026-09-27):
// holder exchange-rate APY diverged at 7d (9.82% vs 4.11%) and 30d (4.86% vs 2.92%).
// Its holder-specific Kong source and eligible price-derived fallback remain available.
export const EXPLICIT_YIELD_SOURCE_POOL_MAP: Record<string, ExplicitYieldPoolConfig[]> = {
  "zchf-frankencoin": [
    {
      poolId: "8b427366-7bfb-4c61-88be-8dc004fdc3da",
      yieldSource: "Frankencoin Savings",
      yieldType: "lending-opportunity",
      expectedProject: "frankencoin",
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
    {
      // XAUT - lista-lending BSC alt venue
      poolId: "b89d44a1-052a-4ec8-8dba-7802340fee27",
      yieldSource: "Lista Lending (XAUT)",
      yieldType: "lending-opportunity",
      dataSource: "defillama-auto",
      expectedProject: "lista-lending",
      expectedSymbol: "XAUT",
      expectedChain: "bsc",
    },
  ],
  "paxg-paxos": [
    {
      // PAXG - Hydration omnipool single-side LP on Polkadot
      poolId: "d4a6ef0e-dbcb-4dbf-bdfc-b766808f402e",
      yieldSource: "Hydration Omnipool (PAXG)",
      yieldType: "lending-opportunity",
      dataSource: "defillama",
      expectedProject: "hydration-dex",
      expectedSymbol: "PAXG",
      expectedChain: "polkadot",
    },
  ],
};
