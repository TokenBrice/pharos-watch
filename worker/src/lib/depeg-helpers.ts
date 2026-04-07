import type { DepegEvent } from "@shared/types/market";
import type { PegRateSource } from "@shared/lib/peg-rates";
import {
  DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
  DEX_FRESHNESS_SEC,
  DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
  DEX_PRICE_CHECK_FRESHNESS_SEC,
  DEX_PRICE_CHECK_UI_MIN_TVL_USD,
} from "./constants";
import type { DepegPrimaryTrust, PriceConfidence, PriceObservedAtMode } from "@shared/types/core";
import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import {
  countDepegAuthoritativeSources,
  hasUpstreamCapableDepegAuthoritativeSource,
  isSingleSourceDepegAuthoritative,
} from "./pricing-source-policy";
import {
  loadPublishedDexPoolChallengers,
  type DexPriceChallengerLoadRow,
} from "../cron/dex-liquidity/challenger-persistence";
import { decodeJsonString } from "./cache-json";
import { logMalformedJsonPath } from "./json-decode-observability";

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
  priceObservedAt?: number | null;
  priceObservedAtMode?: PriceObservedAtMode | null;
  agreeSources?: string[] | null;
}

interface PegReferenceTrustInput {
  pegCurrency?: string | null;
  pegType?: string | null;
  pegRateSource?: PegRateSource | null;
  pegRateContributorCount?: number | null;
}

function getPrimaryPriceAgeSec(
  input: Pick<PrimaryPriceTrustInput, "priceObservedAt" | "priceUpdatedAt">,
  nowSec: number,
): number {
  return typeof input.priceObservedAt === "number" && Number.isFinite(input.priceObservedAt)
    ? Math.max(0, nowSec - input.priceObservedAt)
    : typeof input.priceUpdatedAt === "number" && Number.isFinite(input.priceUpdatedAt)
      ? Math.max(0, nowSec - input.priceUpdatedAt)
      : Number.POSITIVE_INFINITY;
}

function getPrimaryTrustSources(input: Pick<PrimaryPriceTrustInput, "agreeSources" | "priceSource">): string[] {
  return input.agreeSources && input.agreeSources.length > 0
    ? input.agreeSources
    : splitCompositePriceSource(input.priceSource ?? "");
}

export async function loadDexPriceRows(db: D1Database): Promise<Map<string, DexPriceRow>> {
  try {
    const dexResult = await db
      .prepare("SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at FROM dex_prices")
      .all<DexPriceRow>();
    return new Map((dexResult.results ?? []).map((row) => [row.stablecoin_id, row]));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no such table")) {
      return new Map<string, DexPriceRow>();
    }
    console.error("[depeg-helpers] Unexpected error loading dex_prices:", msg);
    throw err;
  }
}

/** Per-protocol price source stored in dex_prices.price_sources_json */
export interface DexPoolSource {
  protocol: string;
  chain: string;
  price: number;
  tvl: number;
  updatedAt: number;
}

type DexJsonDecodeReason = "missing" | "json-parse-failed" | "invalid-shape";

/**
 * Load all qualifying individual pool prices per asset from the published challenger snapshot,
 * with safe legacy fallback when the challenger tables are absent.
 * Used as "pool challengers" - if ANY large pool diverges from consensus,
 * it signals that aggregators may be picking up small misleading pools
 * while ignoring large pools showing depeg.
 */
export async function loadDexPoolChallengers(
  db: D1Database,
  minPoolTvlUsd: number,
  maxAgeSec: number,
  nowSec: number,
): Promise<Map<string, Array<{ price: number; tvlUsd: number; protocol: string; chain: string; observedAt?: number }>>> {
  const { challengersByStablecoin, diagnostics } = await loadPublishedDexPoolChallengers(
    db,
    minPoolTvlUsd,
    maxAgeSec,
    nowSec,
  );

  if (diagnostics.mode !== "absent") {
    if (diagnostics.incompletePublishedCoins.length > 0) {
      console.warn(
        `[depeg-helpers] Incomplete challenger snapshots fell back for: ${diagnostics.incompletePublishedCoins.join(", ")}`,
      );
    }
    if (diagnostics.emptyPublishedCoins.length > 0) {
      console.log(
        `[depeg-helpers] Published empty challenger snapshots for: ${diagnostics.emptyPublishedCoins.join(", ")}`,
      );
    }
    if (diagnostics.legacyFallbackCoins.length > 0 && diagnostics.mode !== "legacy") {
      console.log(
        `[depeg-helpers] Legacy challenger fallback used for: ${diagnostics.legacyFallbackCoins.join(", ")}`,
      );
    }
  }

  return new Map(
    [...challengersByStablecoin.entries()].map(([stablecoinId, rows]) => [
      stablecoinId,
      rows.map((row: DexPriceChallengerLoadRow) => ({
        price: row.priceUsd,
        tvlUsd: row.tvlUsd,
        protocol: row.protocol,
        chain: row.chain,
        observedAt: row.snapshotAt,
      })),
    ]),
  );
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
      const decoded = decodeJsonString<DexPoolSource[], DexJsonDecodeReason>(row.price_sources_json, {
        mode: "degraded",
        updatedAt: row.updated_at,
        missingReason: "missing",
        parseErrorReason: "json-parse-failed",
        normalize: (parsed) => Array.isArray(parsed)
          ? { ok: true, payload: parsed as DexPoolSource[] }
          : { ok: false, reason: "invalid-shape" },
      });
      if (!decoded.ok) {
        logMalformedJsonPath({
          scope: "lib",
          owner: "depeg-helpers",
          context: "dex_prices.price_sources_json",
          reason: decoded.reason,
          source: "dex_prices",
          updatedAt: row.updated_at,
          extra: { stablecoinId: row.stablecoin_id },
        });
        continue;
      }
      if (decoded.payload.length === 0) continue;
      result.set(
        row.stablecoin_id,
        decoded.payload.map((source) => ({
          ...source,
          updatedAt:
            typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt) && source.updatedAt > 0
              ? source.updatedAt
              : row.updated_at,
        })),
      );
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

export function hasFreshMultiSourcePrimaryAgreement(
  input: PrimaryPriceTrustInput,
  nowSec: number,
): boolean {
  if (input.price == null || !Number.isFinite(input.price) || input.price <= 0) {
    return false;
  }

  if (
    input.priceSource === "cached" ||
    input.priceConfidence === "fallback" ||
    input.priceConfidence === "low" ||
    getPrimaryPriceAgeSec(input, nowSec) > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC
  ) {
    return false;
  }

  return getPrimaryTrustSources(input).length >= 2;
}

export function isAuthoritativeDepegPegReference(input: PegReferenceTrustInput): boolean {
  if (!input.pegType || input.pegType === "peggedUSD") {
    return true;
  }

  const pegCurrency = input.pegCurrency ?? null;
  if (
    pegCurrency == null ||
    pegCurrency === "USD" ||
    pegCurrency === "VAR" ||
    pegCurrency === "OTHER" ||
    pegCurrency === "GOLD" ||
    pegCurrency === "SILVER"
  ) {
    return true;
  }

  return input.pegRateSource === "fallback" || (input.pegRateContributorCount ?? 0) >= 3;
}

export function classifyPrimaryDepegTrust(
  input: PrimaryPriceTrustInput,
  nowSec: number,
): DepegPrimaryTrust {
  if (input.price == null || !Number.isFinite(input.price) || input.price <= 0) {
    return "unusable";
  }

  const ageSec = getPrimaryPriceAgeSec(input, nowSec);
  const trustSources = getPrimaryTrustSources(input);

  if (
    input.priceSource === "cached" ||
    input.priceConfidence === "fallback" ||
    input.priceConfidence === "low" ||
    ageSec > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC
  ) {
    return "confirm_required";
  }

  if (input.priceConfidence === "single-source") {
    return trustSources.length === 1 && isSingleSourceDepegAuthoritative(trustSources[0], input.priceObservedAtMode)
      ? "authoritative"
      : "confirm_required";
  }

  if (input.priceConfidence === "high") {
    if (countDepegAuthoritativeSources(trustSources) >= 2) {
      return "authoritative";
    }

    if (hasUpstreamCapableDepegAuthoritativeSource(trustSources)) {
      return "authoritative";
    }
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
