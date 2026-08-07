/**
 * Producer-generation resolution for the exact Safety Score V9 input capture.
 *
 * The V8 report-card snapshot builder this module was named for was deleted
 * with the V8 engine. What survives is the set of guards the native V9 capture
 * (`safety-score-v9-capture.ts`) and the compute cron rely on to prove that the
 * DEX and redemption lanes each contribute exactly one published generation.
 */
import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinData } from "@shared/types/market";
import type { ReportCardsFixedInput } from "./report-cards-fixed-input";

interface DexPublicationRow {
  stablecoin_id: string;
  publication_generation_id: string | null;
  updated_at: number | null;
}

function navPriceConfidence(
  confidence: StablecoinData["priceConfidence"],
): "high" | "medium" | "low" | "unknown" {
  if (confidence === "high") return "high";
  if (confidence === "low") return "low";
  if (confidence === "single-source" || confidence === "fallback") return "medium";
  return "unknown";
}

export function buildNavPriceById(
  peggedAssets: readonly StablecoinData[],
  clockSec: number,
): NonNullable<ReportCardsFixedInput["navPriceById"]> {
  const entries: Array<[string, NonNullable<ReportCardsFixedInput["navPriceById"]>[string]]> = [];
  for (const asset of peggedAssets) {
    if (!ACTIVE_META_BY_ID.get(asset.id)?.flags.navToken) continue;
    if (typeof asset.price !== "number" || !Number.isFinite(asset.price) || asset.price <= 0) continue;
    if (!asset.priceSource || asset.priceSource === "missing") continue;
    const rawObservedAtSec = asset.priceObservedAt ?? asset.priceUpdatedAt ?? asset.priceSyncedAt;
    if (typeof rawObservedAtSec !== "number" || !Number.isFinite(rawObservedAtSec)) continue;
    // NavPriceObservationSchema requires integer Unix seconds; floor sub-second
    // provider precision rather than dropping the observation.
    const observedAtSec = Math.floor(rawObservedAtSec);
    if (observedAtSec < 0 || observedAtSec > clockSec) continue;
    entries.push([
      asset.id,
      {
        priceUsd: asset.price,
        sourceId: asset.priceSource,
        observedAtSec,
        confidence: navPriceConfidence(asset.priceConfidence),
      },
    ]);
  }
  return Object.fromEntries(entries);
}

export function resolveExactDexPublicationGeneration(
  rows: readonly DexPublicationRow[],
  activeIds: readonly string[] = ACTIVE_STABLECOINS.map((coin) => coin.id),
): { generationId: string; updatedAt: number } {
  const byId = new Map(rows.map((row) => [row.stablecoin_id, row]));
  const missingIds = activeIds.filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    throw new Error(`Exact fixed-input capture missing ${missingIds.length} active DEX rows: ${missingIds.join(",")}`);
  }
  const activeRows = activeIds.map((id) => byId.get(id)!);
  const generations = new Set(activeRows.map((row) => row.publication_generation_id));
  const timestamps = new Set(activeRows.map((row) => row.updated_at));
  if (generations.size !== 1 || generations.has(null)) {
    throw new Error(`Exact fixed-input capture spans ${generations.size} active DEX generations`);
  }
  if (timestamps.size !== 1 || timestamps.has(null)) {
    throw new Error(`Exact fixed-input capture spans ${timestamps.size} active DEX timestamps`);
  }
  const generationId = activeRows[0]!.publication_generation_id!;
  const updatedAt = activeRows[0]!.updated_at!;
  if (generationId !== `dex-liquidity-${updatedAt}`) {
    throw new Error(`Active DEX generation ${generationId} does not match row timestamp ${updatedAt}`);
  }
  return { generationId, updatedAt };
}

export async function loadExactDexPublicationGeneration(db: D1Database): Promise<{
  generationId: string;
  updatedAt: number;
}> {
  const rows = await db
    .prepare(
      `SELECT stablecoin_id, publication_generation_id, updated_at
         FROM dex_liquidity
        WHERE stablecoin_id != '__global__'
          AND (publication_generation_id IS NULL OR publication_generation_id IN (
            SELECT generation_id FROM dex_liquidity_publication_generations WHERE state = 'published'
          ))`,
    )
    .all<DexPublicationRow>();
  return resolveExactDexPublicationGeneration(rows.results ?? []);
}

export function resolveExactRedemptionPublicationGeneration(args: {
  entries: readonly { updatedAt: number; methodologyVersion: string }[];
  freshnessUpdatedAt: number | null;
  stale: boolean;
  runId: string | null;
  methodologyVersion: string | null;
}): string {
  if (args.entries.length === 0) {
    if (!args.stale) {
      throw new Error("Exact fixed-input capture has no redemption rows but marks redemption current");
    }
    return "redemption-backstops-unavailable";
  }
  if (args.stale || args.freshnessUpdatedAt == null) {
    throw new Error("Exact fixed-input redemption generation has inconsistent freshness and row coverage");
  }
  if (!args.runId?.startsWith("redemption:") || !args.methodologyVersion) {
    throw new Error("Exact fixed-input redemption rows are not bound to a completed producer run");
  }
  const timestamps = new Set(args.entries.map((entry) => entry.updatedAt));
  if (timestamps.size !== 1 || !timestamps.has(args.freshnessUpdatedAt)) {
    throw new Error("Exact fixed-input redemption rows do not match producer freshness");
  }
  const methodologyVersions = new Set(args.entries.map((entry) => entry.methodologyVersion));
  if (methodologyVersions.size !== 1 || !methodologyVersions.has(args.methodologyVersion)) {
    throw new Error("Exact fixed-input redemption rows do not match producer methodology");
  }
  return args.runId;
}
