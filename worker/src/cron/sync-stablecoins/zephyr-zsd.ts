import { logWorkerEventArgs } from "../../lib/structured-log";
import type { PriceObservedAtMode, StablecoinMeta } from "@shared/types/core";
import {
  isZephyrScannerSupplyId,
  ZEPHYR_ZSD_ASSET_ID,
  ZEPHYR_ZYS_ASSET_ID,
} from "@shared/lib/onchain-supply-probe";
import { USER_AGENT } from "../../lib/constants";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { validatePricingSourceFreshness } from "../../lib/pricing-source-freshness";
import { isReasonablePrice } from "../../lib/price-validation";
import type { PeggedAsset } from "./enrich-prices";
import { pegTypeKey, getSupplementalChainLabels, toPositiveFiniteNumber } from "./supplemental-assets/shared";

export { ZEPHYR_ZSD_ASSET_ID, ZEPHYR_ZYS_ASSET_ID };

const ZEPHYR_SUPPLY_SOURCE = "zephyr-scanner";
const ZEPHYR_LIVESTATS_URL = "https://zephyrprotocol.com/api/v1/livestats";

export interface ZephyrZsdStats {
  supply: number;
  mcap: number;
  mcapPrice: number;
  observedAt?: number | null;
  priceReported?: boolean;
}

export type ZephyrScannerAssetStats = ZephyrZsdStats;

export interface ZephyrProtocolStats {
  zsd: ZephyrScannerAssetStats;
  zys: ZephyrScannerAssetStats | null;
}

export interface ZephyrZsdPriceResolution {
  price: number;
  source: string;
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
}

// Zephyr Scanner stamps protocol observations with `captured_at` (ISO) on reserve
// snapshots and `block_timestamp`/`timestamp` (unix seconds) on stats records. Live
// stats may omit all of them; absence stays absent rather than becoming fetch time.
// The provider's timestamps become both price and supply provenance, so they face
// the registered `zephyr-scanner` trust window like every other observation: a
// future-skewed or stale scanner clock drops the provenance (with a logged,
// machine-readable reason) instead of publishing an impossible observation time.
function normalizeZephyrObservedAt(value: unknown, nowSec: number): number | null {
  const numeric = toPositiveFiniteNumber(value);
  const parsed = numeric != null
    ? Math.floor(numeric > 10_000_000_000 ? numeric / 1000 : numeric)
    : typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > 0
      ? Math.floor(Date.parse(value) / 1000)
      : null;
  if (parsed == null) return null;
  const freshness = validatePricingSourceFreshness({
    source: ZEPHYR_SUPPLY_SOURCE,
    observedAt: parsed,
    observedAtMode: "upstream",
    nowSec,
    requireObservedAt: true,
  });
  if (!freshness.accepted) {
    logWorkerEventArgs(
      "handler",
      "warn",
      `[zephyr-scanner] Dropped ${freshness.reason} observation timestamp (${parsed}) at now=${nowSec}`,
    );
    return null;
  }
  return freshness.observedAt;
}

function parseZephyrAssetStats(
  payload: unknown,
  supplyKey: string,
  priceKey: string,
  fallbackPrice: number | null,
  opts?: { pegType?: string; navToken?: boolean },
  nowSec: number = Math.floor(Date.now() / 1000),
): ZephyrScannerAssetStats | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const supply = toPositiveFiniteNumber(record[supplyKey]);
  if (supply == null) return null;

  const rawReportedPrice = toPositiveFiniteNumber(record[priceKey]);
  const reportedPrice = rawReportedPrice != null && (
    !opts?.pegType || isReasonablePrice(rawReportedPrice, opts.pegType, undefined, { navToken: opts.navToken })
  )
    ? rawReportedPrice
    : undefined;
  const mcapPrice = reportedPrice ?? fallbackPrice;
  if (mcapPrice == null) return null;
  const observedAt = normalizeZephyrObservedAt(
    record.captured_at ?? record.block_timestamp ?? record.timestamp,
    nowSec,
  );
  return {
    supply,
    mcapPrice,
    mcap: supply * mcapPrice,
    observedAt,
    priceReported: reportedPrice != null,
  };
}

export function parseZephyrZsdStats(payload: unknown, nowSec: number = Math.floor(Date.now() / 1000)): ZephyrScannerAssetStats | null {
  return parseZephyrAssetStats(payload, "zsd_circ", "zsd_price", 1.0, { pegType: "peggedUSD" }, nowSec);
}

export function parseZephyrZysStats(payload: unknown, nowSec: number = Math.floor(Date.now() / 1000)): ZephyrScannerAssetStats | null {
  return parseZephyrAssetStats(payload, "zys_circ", "zys_price", null, { pegType: "peggedUSD", navToken: true }, nowSec);
}

export function parseZephyrProtocolStats(payload: unknown, nowSec: number = Math.floor(Date.now() / 1000)): ZephyrProtocolStats | null {
  const zsd = parseZephyrZsdStats(payload, nowSec);
  if (!zsd) return null;

  return {
    zsd,
    zys: parseZephyrZysStats(payload, nowSec),
  };
}

function resolveZephyrPrice(
  stats: ZephyrScannerAssetStats,
  priceResolution: ZephyrZsdPriceResolution | null,
  nowSec: number,
): {
  price: number | null;
  source?: string;
  confidence: PeggedAsset["priceConfidence"];
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
  syncedAt: number | null;
} {
  if (priceResolution) {
    return {
      price: priceResolution.price,
      source: priceResolution.source,
      confidence: priceResolution.source === "coingecko-low-volume" ? "fallback" : "single-source",
      observedAt: priceResolution.observedAt,
      observedAtMode: priceResolution.observedAtMode,
      syncedAt: nowSec,
    };
  }

  if (stats.priceReported) {
    return {
      price: stats.mcapPrice,
      source: ZEPHYR_SUPPLY_SOURCE,
      confidence: "single-source",
      observedAt: stats.observedAt ?? null,
      observedAtMode: stats.observedAt != null ? "upstream" : null,
      syncedAt: nowSec,
    };
  }

  return {
    price: null,
    confidence: null,
    observedAt: null,
    observedAtMode: null,
    syncedAt: null,
  };
}

export function isZephyrScannerAssetId(id: string): boolean {
  return isZephyrScannerSupplyId(id);
}

function buildZephyrPeggedAsset(
  meta: StablecoinMeta,
  stats: ZephyrScannerAssetStats,
  priceResolution: ZephyrZsdPriceResolution | null,
  nowSec = Math.floor(Date.now() / 1000),
): PeggedAsset | null {
  if (!isZephyrScannerAssetId(meta.id)) return null;

  const pKey = pegTypeKey(meta);
  const priceForCirculatingMcap = priceResolution?.price != null
    && isReasonablePrice(priceResolution.price, pKey, undefined, { navToken: meta.flags.navToken })
    ? priceResolution.price
    : 1.0;
  const circulatingMcap = meta.id === ZEPHYR_ZSD_ASSET_ID
    ? stats.supply * priceForCirculatingMcap
    : stats.mcap;
  if (!Number.isFinite(circulatingMcap) || circulatingMcap <= 0) return null;

  const resolvedPrice = resolveZephyrPrice(stats, priceResolution, nowSec);
  return {
    id: meta.id,
    name: meta.name,
    symbol: meta.symbol,
    geckoId: meta.geckoId,
    pegType: pKey,
    pegMechanism: meta.flags.backing,
    price: resolvedPrice.price,
    priceSource: resolvedPrice.source,
    priceConfidence: resolvedPrice.confidence,
    priceUpdatedAt: resolvedPrice.observedAt,
    priceObservedAt: resolvedPrice.observedAt,
    priceObservedAtMode: resolvedPrice.observedAtMode,
    priceSyncedAt: resolvedPrice.syncedAt,
    supplySource: ZEPHYR_SUPPLY_SOURCE,
    supplyObservedAt: stats.observedAt ?? null,
    circulating: { [pKey]: circulatingMcap },
    circulatingPrevDay: null,
    circulatingPrevWeek: null,
    circulatingPrevMonth: null,
    chainCirculating: {},
    chains: getSupplementalChainLabels(meta),
  } as PeggedAsset;
}

export function buildZephyrZsdPeggedAsset(
  meta: StablecoinMeta,
  stats: ZephyrScannerAssetStats,
  priceResolution: ZephyrZsdPriceResolution | null,
  nowSec = Math.floor(Date.now() / 1000),
): PeggedAsset | null {
  if (meta.id !== ZEPHYR_ZSD_ASSET_ID) return null;
  return buildZephyrPeggedAsset(meta, stats, priceResolution, nowSec);
}

export function buildZephyrZysPeggedAsset(
  meta: StablecoinMeta,
  stats: ZephyrScannerAssetStats,
  nowSec = Math.floor(Date.now() / 1000),
): PeggedAsset | null {
  if (meta.id !== ZEPHYR_ZYS_ASSET_ID) return null;
  return buildZephyrPeggedAsset(meta, stats, null, nowSec);
}

export function buildZephyrProtocolPeggedAsset(
  meta: StablecoinMeta,
  stats: ZephyrProtocolStats,
  priceResolution: ZephyrZsdPriceResolution | null,
  nowSec = Math.floor(Date.now() / 1000),
): PeggedAsset | null {
  if (meta.id === ZEPHYR_ZSD_ASSET_ID) {
    return buildZephyrZsdPeggedAsset(meta, stats.zsd, priceResolution, nowSec);
  }
  if (meta.id === ZEPHYR_ZYS_ASSET_ID && stats.zys) {
    return buildZephyrZysPeggedAsset(meta, stats.zys, nowSec);
  }
  return null;
}

export async function fetchZephyrProtocolStats(signal?: AbortSignal): Promise<ZephyrProtocolStats | null> {
  const result = await fetchTextWithRetry(
    ZEPHYR_LIVESTATS_URL,
    {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal,
    },
    1,
    { timeoutMs: 5_000 },
  );

  if (!result?.response.ok) {
    logWorkerEventArgs("handler", "warn", `[zephyr-scanner] Live stats fetch failed (${result?.response.status ?? "no response"})`);
    return null;
  }

  try {
    const payload = JSON.parse(result.body);
    const stats = parseZephyrProtocolStats(payload);
    if (!stats) logWorkerEventArgs("handler", "warn", "[zephyr-scanner] Live stats payload missing positive ZSD circulation");
    if (stats && !stats.zys) logWorkerEventArgs("handler", "warn", "[zephyr-scanner] Live stats payload missing positive ZYS circulation or price");
    return stats;
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("handler", "warn", "[zephyr-scanner] Live stats payload parse failed:", err);
    return null;
  }
}
