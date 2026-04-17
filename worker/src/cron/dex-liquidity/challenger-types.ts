/**
 * Shared types for the DEX price challenger load path.
 *
 * Kept in a leaf module so both `challenger-load` and `challenger-legacy`
 * can import them without creating a runtime/type import cycle.
 */

export interface DexPriceChallengerLoadRow {
  stablecoinId: string;
  poolId: string;
  chain: string;
  protocol: string;
  sourceFamily: string;
  priceUsd: number;
  tvlUsd: number;
  snapshotAt: number;
  publishedAt: number;
}

export interface DexPriceChallengerLoadDiagnostics {
  mode: "published" | "legacy" | "mixed" | "absent";
  missingTables: boolean;
  emptyPublishedCoins: string[];
  incompletePublishedCoins: string[];
  legacyFallbackCoins: string[];
  staleSnapshotCoins: string[];
}

export interface DexPriceChallengerLoadResult {
  challengersByStablecoin: Map<string, DexPriceChallengerLoadRow[]>;
  diagnostics: DexPriceChallengerLoadDiagnostics;
}
