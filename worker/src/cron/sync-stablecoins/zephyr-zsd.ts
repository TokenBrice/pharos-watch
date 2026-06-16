import type { PriceObservedAtMode, StablecoinMeta } from "@shared/types/core";
import { USER_AGENT } from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import type { PeggedAsset } from "./enrich-prices";
import { pegTypeKey, getSupplementalChainLabels, toPositiveFiniteNumber } from "./supplemental-assets/shared";

export const ZEPHYR_ZSD_ASSET_ID = "zsd-zephyr-protocol";
export const ZEPHYR_ZYS_ASSET_ID = "zys-zephyr-protocol";

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
): ZephyrScannerAssetStats | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const supply = toPositiveFiniteNumber(record[supplyKey]);
  if (supply == null) return null;

  const reportedPrice = toPositiveFiniteNumber(record[priceKey]);
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
  return parseZephyrAssetStats(payload, "zsd_circ", "zsd_price", 1.0);
}

export function parseZephyrZysStats(payload: unknown): ZephyrScannerAssetStats | null {
  return parseZephyrAssetStats(payload, "zys_circ", "zys_price", null);
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
  return id === ZEPHYR_ZSD_ASSET_ID || id === ZEPHYR_ZYS_ASSET_ID;
}

function buildZephyrPeggedAsset(
  meta: StablecoinMeta,
  stats: ZephyrScannerAssetStats,
  priceResolution: ZephyrZsdPriceResolution | null,
  nowSec = Math.floor(Date.now() / 1000),
): PeggedAsset | null {
  if (!isZephyrScannerAssetId(meta.id)) return null;
  if (!Number.isFinite(stats.mcap) || stats.mcap <= 0) return null;

  const pKey = pegTypeKey(meta);
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
    circulating: { [pKey]: stats.mcap },
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
  const res = await fetchWithRetry(
    ZEPHYR_LIVESTATS_URL,
    {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal,
    },
    1,
    { timeoutMs: 5_000 },
  );

  if (!res?.ok) {
    await cancelResponseBodyQuietly(res);
    console.warn(`[zephyr-scanner] Live stats fetch failed (${res?.status ?? "no response"})`);
    return null;
  }

  try {
    const payload = await res.json();
    const stats = parseZephyrProtocolStats(payload);
    if (!stats) console.warn("[zephyr-scanner] Live stats payload missing positive ZSD circulation");
    if (stats && !stats.zys) console.warn("[zephyr-scanner] Live stats payload missing positive ZYS circulation or price");
    return stats;
  } catch (err) {
    await cancelResponseBodyQuietly(res);
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[zephyr-scanner] Live stats payload parse failed:", err);
    return null;
  }
}
