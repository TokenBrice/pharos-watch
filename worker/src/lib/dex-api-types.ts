import type { DexExecutionCapabilityGate } from "@shared/types/market";

export interface DexApiPoolToken {
  address: string;
  symbol: string;
  decimals: number;
  /** Per-token USD price when available (Balancer provides this via balanceUSD/balance). */
  priceUsd?: number | null;
  /** A current tracked stablecoin dependency required to convert a token quote
   * into USD. No peg-reference fallback is permitted when this is present. */
  priceUsdDependency?: {
    stablecoinId: string;
    multiplier: number;
  };
  /** Optional target pool weight for protocols like Balancer weighted pools. */
  weight?: number | null;
  /**
   * Rate-provider price rate for Balancer stable-math pools (scaled balance =
   * balance * priceRate). 1.0 for plain tokens; null when the source omits it.
   */
  priceRate?: number | null;
}

export interface DexApiPool {
  source:
    | "fluid"
    | "balancer"
    | "raydium"
    | "orca"
    | "meteora"
    | "pancakeswap"
    | "sunswap"
    | "aerodrome-slipstream"
    | "velodrome-slipstream";
  chain: string;
  poolAddress: string;
  poolType: string;
  tokens: DexApiPoolToken[];
  /** Raw pool price ratio (token[0] / token[1]). Used for price inversion logic. */
  price: number | null;
  tvlUsd: number;
  volume24hUsd: number;
  feeRate: number | null;
  /** Concentrated-liquidity tick spacing when the source exposes it directly. */
  tickSpacing?: number;
  balances: number[] | null;
  /** True only when balances are normalized native-token amounts rather than integer base units. */
  balancesNormalized?: boolean;
  /** Optional per-token raw 24h volumes in native token units. */
  tokenVolumes24h?: number[] | null;
  /**
   * Stable-math amplification in the source contract convention (Ann = amp * n),
   * as reported by the source API. Only set for genuine stableswap pool types on
   * hook-free pools with reviewed rate providers; consumers convert to the plain
   * paper convention before simulation.
   */
  amp?: number | null;
  /** Reviewed exact-family failure that must survive direct-API shaping. */
  executionCapabilityGate?: DexExecutionCapabilityGate;
}

export type DexPaginationPersistenceErrorClass =
  | "not-configured"
  | "missing-table"
  | "write-failed";

export interface DexPaginationPersistenceSummary {
  attempts: number;
  written: number;
  failures: Array<{
    sourceKey: string;
    errorClass: DexPaginationPersistenceErrorClass;
  }>;
}

export interface DexApiFetchResult {
  pools: DexApiPool[];
  ok: boolean;
  degraded: boolean;
  errors: string[];
  warnings?: string[];
  pagination?: {
    state: "complete" | "partial";
    headRefreshed: boolean;
    pagesFetched: number;
    cursor: string | null;
    cycleCompleted: boolean;
    cursorPersistence?: DexPaginationPersistenceSummary;
  };
}
