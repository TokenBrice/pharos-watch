import { readDexPriceLineage } from "./price-lineage";
import { decodeJsonString } from "../../lib/cache-json";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../../lib/dex-liquidity";
import { getDexAggregateObservedAt } from "../../lib/depeg-trust-policy";
import { logMalformedJsonPath } from "../../lib/json-decode-observability";
import type { DexPriceChallengerLoadRow } from "./challenger-types";
import { getDexPriceSourceEntries } from "@shared/lib/dex-price-sources";
import { isRecord } from "@shared/lib/type-guards";
import { isCurveNavSpotQuoteEvidenceShape } from "./types";

interface LegacyDexPoolSource {
  protocol: string;
  chain: string;
  price: number;
  tvl: number;
  observedAt?: unknown;
}

interface LegacyChallengerPoolRow {
  poolId?: unknown;
  chain?: unknown;
  protocol?: unknown;
  sourceFamily?: unknown;
  priceUsd?: unknown;
  lineagePriceUsd?: unknown;
  tvlUsd?: unknown;
  priceObservedAt?: unknown;
  curveNavSpotQuote?: unknown;
  quotePublishedAtSec?: unknown;
  quoteExpiresAtSec?: unknown;
}

type LegacyJsonDecodeReason = "missing" | "json-parse-failed" | "invalid-shape";

function decodeLegacyJsonArray<T>(
  value: string,
  options: {
    stablecoinId: string;
    source: "dex_liquidity" | "dex_prices";
    context: "dex_liquidity.top_pools_json" | "dex_liquidity.challenger_pools_json" | "dex_prices.price_sources_json";
    updatedAt: number;
  },
  selectEntries: (parsed: unknown) => unknown = (parsed) => parsed,
): T[] | null {
  const decoded = decodeJsonString<T[], LegacyJsonDecodeReason>(value, {
    updatedAt: options.updatedAt,
    missingReason: "missing",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => {
      const sources = selectEntries(parsed);
      return Array.isArray(sources)
        ? { ok: true, payload: sources as T[] }
        : { ok: false, reason: "invalid-shape" };
    },
  });
  if (!decoded.ok) {
    logMalformedJsonPath({
      scope: "cron",
      owner: "challenger-persistence",
      context: options.context,
      reason: decoded.reason,
      source: options.source,
      updatedAt: options.updatedAt,
      extra: { stablecoinId: options.stablecoinId },
    });
    return null;
  }
  return decoded.payload;
}

export async function loadLegacyDexPoolChallengers(
  db: D1Database,
  minPoolTvlUsd: number,
  maxAgeSec: number,
  nowSec: number,
): Promise<Map<string, DexPriceChallengerLoadRow[]>> {
  const challengersByStablecoin = new Map<string, DexPriceChallengerLoadRow[]>();

  const cutoffSec = nowSec - maxAgeSec;
  const rows = await db
    .prepare(
      `SELECT stablecoin_id, top_pools_json, challenger_pools_json, updated_at
         FROM dex_liquidity
         WHERE stablecoin_id != '__global__'
           AND (top_pools_json IS NOT NULL OR challenger_pools_json IS NOT NULL)
           AND updated_at >= ?
           AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
    )
    .bind(cutoffSec)
    .all<{
      stablecoin_id: string;
      top_pools_json: string | null;
      challenger_pools_json: string | null;
      updated_at: number;
    }>();

  for (const row of rows.results ?? []) {
    const qualifying: DexPriceChallengerLoadRow[] = [];
    if (row.challenger_pools_json != null) {
      const stored = decodeLegacyJsonArray<LegacyChallengerPoolRow>(
        row.challenger_pools_json,
        {
          stablecoinId: row.stablecoin_id,
          source: "dex_liquidity",
          context: "dex_liquidity.challenger_pools_json",
          updatedAt: row.updated_at,
        },
      );
      for (const pool of stored ?? []) {
        const lineage = readDexPriceLineage(pool);
        const curveNavSpotQuote = pool.curveNavSpotQuote !== undefined
          ? (isCurveNavSpotQuoteEvidenceShape(pool.curveNavSpotQuote) ? pool.curveNavSpotQuote : null)
          : undefined;
        if (curveNavSpotQuote === null) continue;
        const price = ((lineage.upstreamKeys?.length && lineage.pricePoolKeys?.length) || curveNavSpotQuote !== undefined) &&
          typeof pool.lineagePriceUsd === "number"
          ? pool.lineagePriceUsd : Number(pool.priceUsd);
        const tvlUsd = typeof pool.tvlUsd === "number" ? pool.tvlUsd : Number(pool.tvlUsd);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tvlUsd) || tvlUsd < minPoolTvlUsd) continue;
        qualifying.push({
          stablecoinId: row.stablecoin_id,
          ...lineage,
          poolId: typeof pool.poolId === "string" ? pool.poolId : "",
          chain: typeof pool.chain === "string" ? pool.chain : "unknown",
          protocol: typeof pool.protocol === "string" ? pool.protocol : "unknown",
          sourceFamily: typeof pool.sourceFamily === "string" && pool.sourceFamily.length > 0
            ? pool.sourceFamily
            : "legacy-challenger-pools",
          priceUsd: price,
          tvlUsd,
          snapshotAt: row.updated_at,
          publishedAt: row.updated_at,
          priceObservedAt: typeof pool.priceObservedAt === "number" && Number.isFinite(pool.priceObservedAt)
            ? pool.priceObservedAt
            : null,
          ...(curveNavSpotQuote !== undefined ? { curveNavSpotQuote } : {}),
          ...(typeof pool.quotePublishedAtSec === "number" && Number.isSafeInteger(pool.quotePublishedAtSec)
            ? { quotePublishedAtSec: pool.quotePublishedAtSec }
            : {}),
          ...(typeof pool.quoteExpiresAtSec === "number" && Number.isSafeInteger(pool.quoteExpiresAtSec)
            ? { quoteExpiresAtSec: pool.quoteExpiresAtSec }
            : {}),
        });
      }
    }

    // Rows written before the challenger projection existed keep the historical
    // display-slice fallback rather than losing legacy evidence entirely.
    if (qualifying.length === 0 && row.top_pools_json != null) {
      const pools = decodeLegacyJsonArray<LegacyChallengerPoolRow & {
        project?: unknown; price?: unknown; displayPrice?: unknown; challengerTvlUsd?: unknown; priceEvidenceTvlUsd?: unknown;
      }>(
        row.top_pools_json,
        {
          stablecoinId: row.stablecoin_id,
          source: "dex_liquidity",
          context: "dex_liquidity.top_pools_json",
          updatedAt: row.updated_at,
        },
      );
      if (pools == null) {
        continue;
      }
      if (!Array.isArray(pools) || pools.length === 0) continue;
      for (const pool of pools) {
        const curveNavSpotQuote = pool.curveNavSpotQuote !== undefined
          ? (isCurveNavSpotQuoteEvidenceShape(pool.curveNavSpotQuote) ? pool.curveNavSpotQuote : null)
          : undefined;
        if (curveNavSpotQuote === null) continue;
        const hasBoundedProjection = typeof pool.challengerTvlUsd === "number";
        const price = hasBoundedProjection ? pool.displayPrice : Number(pool.price);
        const tvlUsd = Math.min(Number(pool.tvlUsd), Number(pool.challengerTvlUsd ?? pool.priceEvidenceTvlUsd ?? pool.tvlUsd));
        if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || !Number.isFinite(tvlUsd) || tvlUsd < minPoolTvlUsd) continue;
        qualifying.push({
          stablecoinId: row.stablecoin_id,
          ...readDexPriceLineage(pool),
          poolId: typeof pool.poolId === "string" ? pool.poolId : "",
          chain: typeof pool.chain === "string" ? pool.chain : "unknown",
          protocol: typeof pool.project === "string" ? pool.project : "unknown",
          sourceFamily: "legacy-top-pools",
          priceUsd: price,
          tvlUsd,
          snapshotAt: row.updated_at,
          publishedAt: row.updated_at,
          ...(typeof pool.priceObservedAt === "number" && { priceObservedAt: pool.priceObservedAt }),
          ...(curveNavSpotQuote !== undefined ? { curveNavSpotQuote } : {}),
          ...(typeof pool.quotePublishedAtSec === "number" && Number.isSafeInteger(pool.quotePublishedAtSec)
            ? { quotePublishedAtSec: pool.quotePublishedAtSec }
            : {}),
          ...(typeof pool.quoteExpiresAtSec === "number" && Number.isSafeInteger(pool.quoteExpiresAtSec)
            ? { quoteExpiresAtSec: pool.quoteExpiresAtSec }
            : {}),
        });
      }
    }

    if (qualifying.length > 0) {
      challengersByStablecoin.set(row.stablecoin_id, qualifying);
    }
  }

  const priceRows = await db
    .prepare(
      "SELECT stablecoin_id, price_sources_json, updated_at FROM dex_prices WHERE price_sources_json IS NOT NULL AND updated_at >= ?",
    )
    .bind(cutoffSec)
    .all<{ stablecoin_id: string; price_sources_json: string; updated_at: number }>();

  for (const row of priceRows.results ?? []) {
    if (challengersByStablecoin.has(row.stablecoin_id)) continue;
    let aggregateObservedAt: number | null | undefined;
    const sources = decodeLegacyJsonArray<LegacyDexPoolSource>(row.price_sources_json, {
      stablecoinId: row.stablecoin_id,
      source: "dex_prices",
      context: "dex_prices.price_sources_json",
      updatedAt: row.updated_at,
    }, (parsed) => {
      const entries = getDexPriceSourceEntries(parsed, "legacy-challenger")?.filter(isRecord);
      if (!entries) return null;
      const clockCarriers = [parsed, ...entries].filter((entry) => isRecord(entry) && "aggregateObservedAt" in entry);
      if (clockCarriers.length > 0) {
        aggregateObservedAt = getDexAggregateObservedAt(Array.isArray(parsed) ? parsed : clockCarriers, nowSec).aggregateObservedAt;
      }
      return entries;
    });
    if (sources == null) {
      continue;
    }
    if (!Array.isArray(sources) || sources.length === 0) continue;

    const qualifying: DexPriceChallengerLoadRow[] = [];
    for (const source of sources) {
        // Protocol summaries with receipts belong to the promotion surface.
        if (readDexPriceLineage(source).upstreamKeys !== undefined) continue;
        const price = typeof source.price === "number" ? source.price : Number(source.price);
        const tvl = Number(source.tvl);
        if (
          typeof source.chain !== "string" ||
          typeof source.protocol !== "string" ||
          !Number.isFinite(price) ||
          price <= 0 ||
          !Number.isFinite(tvl) ||
          tvl < minPoolTvlUsd
        ) continue;
        const legacyAggregateObservedAt = source.observedAt == null ? aggregateObservedAt : null;
        qualifying.push({
          stablecoinId: row.stablecoin_id,
          poolId: `${row.stablecoin_id}:${source.protocol}:${source.chain}`,
          chain: source.chain,
          protocol: source.protocol,
          sourceFamily: "legacy-price-sources",
          priceUsd: price,
          tvlUsd: tvl,
          snapshotAt: row.updated_at,
          publishedAt: row.updated_at,
          ...(typeof source.observedAt === "number"
            ? { priceObservedAt: source.observedAt }
            : legacyAggregateObservedAt !== undefined && { legacyAggregateObservedAt }),
        });
    }
    if (qualifying.length > 0) {
      challengersByStablecoin.set(row.stablecoin_id, qualifying);
    }
  }

  return challengersByStablecoin;
}
