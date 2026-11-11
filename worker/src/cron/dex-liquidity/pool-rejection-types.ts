export const POOL_REJECTION_POOL_ID_LIMIT = 20;

export type PoolRejectionReason =
  | "invalid-pool-identity"
  | "invalid-pool-tvl"
  | "invalid-pool-volume"
  | "conflicting-pool-observations";

export type PoolRejectionScope = "dex-project" | "non-dex-project" | "unknown-project";

export interface PoolRejectionDetail {
  reason: PoolRejectionReason;
  source: "defillama-yields";
  scope?: PoolRejectionScope;
  protocol: string | null;
  chain: string | null;
  poolId: string | null;
  tvlUsd: number | null;
  stablecoinIds: string[];
}

export interface PoolProcessingRejection {
  reason: PoolRejectionReason;
  /** Project is transient until scoped against the run's admission whitelist. */
  project?: string | null;
  scope?: PoolRejectionScope;
  poolIds: string[];
  count: number;
  tvlUsd: number;
  /** Exact attribution totals; samples must never decide health. Absent in legacy stages. */
  tvlUsdByStablecoin?: Record<string, number>;
  attributionUnavailable?: boolean;
  unavailableTvlCount?: number;
  details?: PoolRejectionDetail[];
}

