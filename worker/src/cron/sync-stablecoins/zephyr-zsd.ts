import { logWorkerEventArgs } from "../../lib/structured-log";
import type { PriceObservedAtMode, StablecoinMeta } from "@shared/types/core";
import {
  isZephyrScannerSupplyId,
  ZEPHYR_ZSD_ASSET_ID,
  ZEPHYR_ZYS_ASSET_ID,
} from "@shared/lib/onchain-supply-probe";
import { USER_AGENT } from "../../lib/constants";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
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

function parseZephyrAssetStats(
  payload: unknown,
  supplyKey: string,
  priceKey: string,
  fallbackPrice: number | null,
  opts?: { pegType?: string; navToken?: boolean },
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

  return {
    supply,
    mcapPrice,
    mcap: supply * mcapPrice,
    priceReported: reportedPrice != null,
  };
}

export function parseZephyrZsdStats(payload: unknown): ZephyrScannerAssetStats | null {
  return parseZephyrAssetStats(payload, "zsd_circ", "zsd_price", 1.0, { pegType: "peggedUSD" });
}

export function parseZephyrZysStats(payload: unknown): ZephyrScannerAssetStats | null {
  return parseZephyrAssetStats(payload, "zys_circ", "zys_price", null, { pegType: "peggedUSD", navToken: true });
}

export function parseZephyrProtocolStats(payload: unknown): ZephyrProtocolStats | null {
  const zsd = parseZephyrZsdStats(payload);
  if (!zsd) return null;

  return {
    zsd,
    zys: parseZephyrZysStats(payload),
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
      observedAt: priceResolution.observedAt ?? nowSec,
      observedAtMode: priceResolution.observedAtMode ?? "local_fetch",
      syncedAt: nowSec,
    };
  }

  if (stats.priceReported) {
    return {
      price: stats.mcapPrice,
      source: ZEPHYR_SUPPLY_SOURCE,
      confidence: "single-source",
      observedAt: nowSec,
      observedAtMode: "local_fetch",
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
