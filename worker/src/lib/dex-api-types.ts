export interface DexApiPoolToken {
  address: string;
  symbol: string;
  decimals: number;
  /** Per-token USD price when available (Balancer provides this via balanceUSD/balance). */
  priceUsd?: number | null;
  /** Optional target pool weight for protocols like Balancer weighted pools. */
  weight?: number | null;
}

export interface DexApiPool {
  source:
    | "fluid"
    | "balancer"
    | "raydium"
    | "orca"
    | "meteora"
    | "pancakeswap"
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
  balances: number[] | null;
  /** True only when balances are normalized native-token amounts rather than integer base units. */
  balancesNormalized?: boolean;
  /** Optional per-token raw 24h volumes in native token units. */
  tokenVolumes24h?: number[] | null;
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
