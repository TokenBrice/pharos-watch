import { decodeJsonString } from "../../lib/cache-json";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../../lib/dex-liquidity";
import { logMalformedJsonPath } from "../../lib/json-decode-observability";
import type { DexPriceChallengerLoadRow } from "./challenger-types";

interface LegacyDexPoolSource {
  protocol: string;
  chain: string;
  price: number;
  tvl: number;
}

type LegacyJsonDecodeReason = "missing" | "json-parse-failed" | "invalid-shape";

function decodeLegacyJsonArray<T>(
  value: string,
  options: {
    stablecoinId: string;
    source: "dex_liquidity" | "dex_prices";
    context: "dex_liquidity.top_pools_json" | "dex_prices.price_sources_json";
    updatedAt: number;
  },
): T[] | null {
  const decoded = decodeJsonString<T[], LegacyJsonDecodeReason>(value, {
    updatedAt: options.updatedAt,
    missingReason: "missing",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => Array.isArray(parsed)
      ? { ok: true, payload: parsed as T[] }
      : { ok: false, reason: "invalid-shape" },
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
): Promise<{
  challengersByStablecoin: Map<string, DexPriceChallengerLoadRow[]>;
  topPoolCoins: Set<string>;
  fallbackCoins: Set<string>;
}> {
  const challengersByStablecoin = new Map<string, DexPriceChallengerLoadRow[]>();
  const topPoolCoins = new Set<string>();
  const fallbackCoins = new Set<string>();

  const rows = await db
    .prepare(
      `SELECT stablecoin_id, top_pools_json, updated_at
         FROM dex_liquidity
         WHERE stablecoin_id != '__global__'
           AND top_pools_json IS NOT NULL
           AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
    )
    .all<{ stablecoin_id: string; top_pools_json: string; updated_at: number }>();

  for (const row of rows.results ?? []) {
    if (nowSec - row.updated_at > maxAgeSec) continue;
    const pools = decodeLegacyJsonArray<Array<{ project?: unknown; chain?: unknown; tvlUsd?: unknown; price?: unknown; poolId?: unknown }>[number]>(
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

    const qualifying: DexPriceChallengerLoadRow[] = [];
    for (const pool of pools) {
        const price = typeof pool.price === "number" ? pool.price : Number(pool.price);
        const tvlUsd = typeof pool.tvlUsd === "number" ? pool.tvlUsd : Number(pool.tvlUsd);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tvlUsd) || tvlUsd < minPoolTvlUsd) continue;
        qualifying.push({
          stablecoinId: row.stablecoin_id,
          poolId: typeof pool.poolId === "string" ? pool.poolId : "",
          chain: typeof pool.chain === "string" ? pool.chain : "unknown",
          protocol: typeof pool.project === "string" ? pool.project : "unknown",
          sourceFamily: "legacy-top-pools",
          priceUsd: price,
          tvlUsd,
          snapshotAt: row.updated_at,
          publishedAt: row.updated_at,
        });
    }
    if (qualifying.length > 0) {
      challengersByStablecoin.set(row.stablecoin_id, qualifying);
      topPoolCoins.add(row.stablecoin_id);
    }
  }

  const priceRows = await db
    .prepare("SELECT stablecoin_id, price_sources_json, updated_at FROM dex_prices WHERE price_sources_json IS NOT NULL")
    .all<{ stablecoin_id: string; price_sources_json: string; updated_at: number }>();

  for (const row of priceRows.results ?? []) {
    if (nowSec - row.updated_at > maxAgeSec) continue;
    if (challengersByStablecoin.has(row.stablecoin_id)) continue;
    const sources = decodeLegacyJsonArray<LegacyDexPoolSource>(row.price_sources_json, {
        stablecoinId: row.stablecoin_id,
        source: "dex_prices",
        context: "dex_prices.price_sources_json",
        updatedAt: row.updated_at,
    });
    if (sources == null) {
      continue;
    }
    if (!Array.isArray(sources) || sources.length === 0) continue;

    const qualifying: DexPriceChallengerLoadRow[] = [];
    for (const source of sources) {
        if (source.tvl < minPoolTvlUsd || !Number.isFinite(source.price) || source.price <= 0) continue;
        qualifying.push({
          stablecoinId: row.stablecoin_id,
          poolId: `${row.stablecoin_id}:${source.protocol}:${source.chain}`,
          chain: source.chain,
          protocol: source.protocol,
          sourceFamily: "legacy-price-sources",
          priceUsd: source.price,
          tvlUsd: source.tvl,
          snapshotAt: row.updated_at,
          publishedAt: row.updated_at,
        });
    }
    if (qualifying.length > 0) {
      challengersByStablecoin.set(row.stablecoin_id, qualifying);
      fallbackCoins.add(row.stablecoin_id);
    }
  }

  return { challengersByStablecoin, topPoolCoins, fallbackCoins };
}
