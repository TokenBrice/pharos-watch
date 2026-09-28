import type { MintBurnType } from "../mint-burn-contracts";

export type SyncMintBurnStatus = "ok" | "degraded" | "error";
export type MintBurnLane = "all" | "critical" | "extended";

export type MintBurnFlowType = "standard" | "atomic_roundtrip" | "bridge_transfer" | "protocol_internal";

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
  flow_type: MintBurnFlowType;
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
  txContextShortfalls: number;
  deferredTxHashes: string[];
}

/** One daily `supply_history` snapshot price with its recorded observation clock. */
export interface MintBurnPriceHistoryPoint {
  snapshotDate: number;
  price: number;
  /** `supply_history.price_observed_at`: the price's actual observation time, not the day label. */
  observedAt: number;
}

/** One `price_cache` row projected for event-time admission (see `context.ts`). */
export interface MintBurnPriceObservation {
  price: number;
  /** Actual observation clock (`observed_at`, else the writer's effective `updated_at`). */
  observedAt: number;
  source: string | null;
  observedAtMode: string | null;
}

export interface MintBurnPriceContext {
  priceObservations: Map<string, MintBurnPriceObservation>;
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
