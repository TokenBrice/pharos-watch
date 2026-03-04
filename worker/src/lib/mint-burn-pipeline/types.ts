import type { MintBurnType } from "../mint-burn-contracts";

export interface MintBurnRow {
  id: string;
  stablecoin_id: string;
  symbol: string;
  chain_id: string;
  direction: "mint" | "burn";
  amount: number;
  amount_usd: number | null;
  price_used: number | null;
  price_timestamp: number | null;
  price_source: string | null;
  burn_type: MintBurnType | null;
  burn_review_reason: string | null;
  counterparty: string | null;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  explorer_tx_url: string;
}

export interface BurnClassificationCounters {
  effectiveBurns: number;
  bridgeBurns: number;
  reviewBurns: number;
}

export interface MintBurnPriceHistoryPoint {
  snapshotDate: number;
  price: number;
}

export interface MintBurnPriceContext {
  prices: Map<string, number>;
  priceHistory: Map<string, MintBurnPriceHistoryPoint[]>;
}

export interface MintBurnRequestBudget {
  count: number;
  limit: number;
}

export interface MintBurnAffectedHour {
  stablecoinId: string;
  chainId: string;
  hourTs: number;
}

export type MintBurnSyncStateMode = "replace" | "monotonic-max";
