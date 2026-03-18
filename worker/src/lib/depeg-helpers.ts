import type { DepegEvent } from "@shared/types";
import {
  DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
  DEX_FRESHNESS_SEC,
  DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
  DEX_PRICE_CHECK_FRESHNESS_SEC,
  DEX_PRICE_CHECK_UI_MIN_TVL_USD,
} from "./constants";
import type { DepegPrimaryTrust, PriceConfidence } from "@shared/types";

/** D1 row shape for the depeg_events table (snake_case columns) */
export interface DepegRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number | null;
  start_price: number;
  peak_price: number | null;
  recovery_price: number | null;
  peg_reference: number;
  source: string;
}

export interface DexPriceRow {
  stablecoin_id: string;
  dex_price_usd: number;
  deviation_from_primary_bps: number | null;
  source_pool_count: number;
  source_total_tvl: number;
  updated_at: number;
}

export type DexPriceTrustTier = "ui" | "depeg";
export type PendingDepegReason = "large-cap" | "low-confidence" | "extreme-move";

interface PrimaryPriceTrustInput {
  price?: number | null;
  priceSource?: string | null;
  priceConfidence?: PriceConfidence | null;
  priceUpdatedAt?: number | null;
}

export async function loadDexPriceRows(db: D1Database): Promise<Map<string, DexPriceRow>> {
  try {
    const dexResult = await db
      .prepare("SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at FROM dex_prices")
      .all<DexPriceRow>();
    return new Map((dexResult.results ?? []).map((row) => [row.stablecoin_id, row]));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      console.error("[depeg-helpers] Unexpected error loading dex_prices:", msg);
    }
    return new Map<string, DexPriceRow>();
  }
}

/** Per-protocol price source stored in dex_prices.price_sources_json */
export interface DexPoolSource {
  protocol: string;
  chain: string;
  price: number;
  tvl: number;
}

/**
 * Load all qualifying individual pool prices per asset from dex_liquidity.top_pools_json.
 * Used as "pool challengers" — if ANY large pool diverges from consensus,
 * it signals that aggregators may be picking up small misleading pools
 * while ignoring large pools showing depeg.
 */
export async function loadDexPoolChallengers(
  db: D1Database,
  minPoolTvlUsd: number,
  maxAgeSec: number,
  nowSec: number,
): Promise<Map<string, Array<{ price: number; tvlUsd: number; protocol: string; chain: string }>>> {
  const result = new Map<string, Array<{ price: number; tvlUsd: number; protocol: string; chain: string }>>();
  try {
    const rows = await db
      .prepare(
        `SELECT stablecoin_id, top_pools_json, updated_at
         FROM dex_liquidity
         WHERE stablecoin_id != '__global__' AND top_pools_json IS NOT NULL`,
      )
      .all<{ stablecoin_id: string; top_pools_json: string; updated_at: number }>();

    for (const row of rows.results ?? []) {
      if (nowSec - row.updated_at > maxAgeSec) continue;
      let pools: Array<{ project?: unknown; chain?: unknown; tvlUsd?: unknown; price?: unknown }>;
      try {
        pools = JSON.parse(row.top_pools_json);
      } catch {
        continue;
      }
      if (!Array.isArray(pools) || pools.length === 0) continue;

      const qualifying: Array<{ price: number; tvlUsd: number; protocol: string; chain: string }> = [];
      for (const pool of pools) {
        const price = typeof pool.price === "number" ? pool.price : Number(pool.price);
        const tvlUsd = typeof pool.tvlUsd === "number" ? pool.tvlUsd : Number(pool.tvlUsd);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tvlUsd) || tvlUsd < minPoolTvlUsd) continue;
        qualifying.push({
          price,
          tvlUsd,
          protocol: typeof pool.project === "string" ? pool.project : "unknown",
          chain: typeof pool.chain === "string" ? pool.chain : "unknown",
        });
      }
      if (qualifying.length > 0) {
        result.set(row.stablecoin_id, qualifying);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      console.error("[depeg-helpers] Unexpected error loading dex pool challengers:", msg);
    }
  }

  if (result.size > 0) return result;

  try {
    const rows = await db
      .prepare("SELECT stablecoin_id, price_sources_json, updated_at FROM dex_prices WHERE price_sources_json IS NOT NULL")
      .all<{ stablecoin_id: string; price_sources_json: string; updated_at: number }>();

    for (const row of rows.results ?? []) {
      if (nowSec - row.updated_at > maxAgeSec) continue;
      let sources: DexPoolSource[];
      try {
        sources = JSON.parse(row.price_sources_json);
      } catch {
        continue;
      }
      if (!Array.isArray(sources) || sources.length === 0) continue;

      const qualifying: Array<{ price: number; tvlUsd: number; protocol: string; chain: string }> = [];
      for (const source of sources) {
        if (source.tvl < minPoolTvlUsd || !Number.isFinite(source.price) || source.price <= 0) continue;
        qualifying.push({ price: source.price, tvlUsd: source.tvl, protocol: source.protocol, chain: source.chain });
      }
      if (qualifying.length > 0) {
        result.set(row.stablecoin_id, qualifying);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      console.error("[depeg-helpers] Unexpected error loading legacy dex pool challengers:", msg);
    }
  }
  return result;
}

/** Load per-protocol price breakdowns from dex_prices.price_sources_json for trusted rows. */
export async function loadDexPriceSources(
  db: D1Database,
  maxAgeSec = 2100, // 35 min = 30min cron + 5min buffer
): Promise<Map<string, DexPoolSource[]>> {
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    const rows = await db
      .prepare("SELECT stablecoin_id, price_sources_json, updated_at FROM dex_prices WHERE price_sources_json IS NOT NULL")
      .all<{ stablecoin_id: string; price_sources_json: string; updated_at: number }>();

    const result = new Map<string, DexPoolSource[]>();
    for (const row of rows.results ?? []) {
      if (nowSec - row.updated_at > maxAgeSec) continue;
      let sources: DexPoolSource[];
      try { sources = JSON.parse(row.price_sources_json); } catch { continue; }
      if (!Array.isArray(sources) || sources.length === 0) continue;
      result.set(row.stablecoin_id, sources);
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      console.error("[depeg-helpers] Unexpected error loading dex price sources:", msg);
    }
    return new Map();
  }
}

export function isTrustedDexPriceRow(
  row: Pick<DexPriceRow, "updated_at" | "source_total_tvl">,
  nowSec: number,
  tier: DexPriceTrustTier,
): boolean {
  const maxAgeSec = tier === "ui" ? DEX_PRICE_CHECK_FRESHNESS_SEC : DEX_FRESHNESS_SEC;
  const minTvlUsd = tier === "ui" ? DEX_PRICE_CHECK_UI_MIN_TVL_USD : DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD;
  return (nowSec - row.updated_at) < maxAgeSec && row.source_total_tvl >= minTvlUsd;
}

export function classifyPrimaryDepegTrust(
  input: PrimaryPriceTrustInput,
  nowSec: number,
): DepegPrimaryTrust {
  if (input.price == null || !Number.isFinite(input.price) || input.price <= 0) {
    return "unusable";
  }

  const ageSec =
    typeof input.priceUpdatedAt === "number" && Number.isFinite(input.priceUpdatedAt)
      ? Math.max(0, nowSec - input.priceUpdatedAt)
      : Number.POSITIVE_INFINITY;

  if (
    input.priceSource === "cached" ||
    input.priceConfidence === "fallback" ||
    input.priceConfidence === "low" ||
    ageSec > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC
  ) {
    return "confirm_required";
  }

  if (input.priceConfidence === "high" || input.priceConfidence === "single-source") {
    return "authoritative";
  }

  return "confirm_required";
}

export function buildInsertDepegEventStmt(
  db: D1Database,
  event: DepegEvent,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`,
    )
    .bind(
      event.stablecoinId,
      event.symbol,
      event.pegType,
      event.direction,
      event.peakDeviationBps,
      event.startedAt,
      event.startPrice,
      event.peakPrice ?? event.startPrice,
      event.pegReference,
    );
}

const VALID_DIRECTIONS = new Set(["above", "below"]);
const VALID_SOURCES = new Set(["live", "backfill"]);

/** Convert a snake_case D1 row to a camelCase DepegEvent */
export function rowToDepegEvent(row: DepegRow): DepegEvent {
  if (!VALID_DIRECTIONS.has(row.direction)) {
    console.warn(`[depeg-helpers] Invalid direction "${row.direction}" for event ${row.id}, defaulting to "below"`);
  }
  if (!VALID_SOURCES.has(row.source)) {
    console.warn(`[depeg-helpers] Invalid source "${row.source}" for event ${row.id}, defaulting to "live"`);
  }
  return {
    id: row.id,
    stablecoinId: row.stablecoin_id,
    symbol: row.symbol,
    pegType: row.peg_type,
    direction: VALID_DIRECTIONS.has(row.direction) ? row.direction as "above" | "below" : "below",
    peakDeviationBps: row.peak_deviation_bps,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    startPrice: row.start_price,
    peakPrice: row.peak_price,
    recoveryPrice: row.recovery_price,
    pegReference: row.peg_reference,
    source: VALID_SOURCES.has(row.source) ? row.source as "live" | "backfill" : "live",
  };
}
