/**
 * Shared types for the DEX price challenger load path.
 *
 * Kept in a leaf module so both `challenger-load` and `challenger-legacy`
 * can import them without creating a runtime/type import cycle.
 */

import type { DexPriceLineage } from "./price-lineage";

// The legacy REAL NOT NULL cell can hold text. Main admits only finite numeric
// prices, so it cannot reuse a quote whose independence requires the receipt.
export const CHALLENGER_LINEAGE_PRICE = "lineage-required";

/** Probe once per run so both pre-0311 databases and old Worker writes remain readable. */
export async function hasChallengerPriceLineageColumn(db: D1Database): Promise<boolean> {
  const column = await db.prepare("SELECT name FROM pragma_table_info('dex_price_challenger_payloads_v2') WHERE name = 'price_lineage_json'")
    .first<{ name: string }>();
  return column?.name === "price_lineage_json";
}

export interface DexPriceChallengerLoadRow extends DexPriceLineage {
  stablecoinId: string;
  poolId: string;
  chain: string;
  protocol: string;
  sourceFamily: string;
  priceUsd: number;
  tvlUsd: number;
  snapshotAt: number;
  publishedAt: number;
  /** Present for v2 payloads; null is unknown, never the publication clock. */
  priceObservedAt?: number | null;
  /** Fallback clock for undated legacy price sources only. Null marks invalid clock evidence. */
  legacyAggregateObservedAt?: number | null;
}

export interface DexPriceChallengerLoadDiagnostics {
  mode: "published" | "legacy" | "mixed" | "absent";
  emptyPublishedCoins: string[];
  incompletePublishedCoins: string[];
  legacyFallbackCoins: string[];
  staleSnapshotCoins: string[];
}

export interface DexPriceChallengerLoadResult {
  challengersByStablecoin: Map<string, DexPriceChallengerLoadRow[]>;
  diagnostics: DexPriceChallengerLoadDiagnostics;
}
