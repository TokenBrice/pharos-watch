import { CHAIN_META } from "@shared/lib/chains";
import type { PriceObservedAtMode, StablecoinMeta } from "@shared/types/core";
import { USER_AGENT } from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import type { PeggedAsset } from "./enrich-prices";

export const ZEPHYR_ZSD_ASSET_ID = "zsd-zephyr-protocol";
export const ZEPHYR_LIVESTATS_URL = "https://zephyrprotocol.com/api/v1/livestats";

const ZSD_SUPPLY_SOURCE = "zephyr-scanner";

export interface ZephyrZsdStats {
  supply: number;
  mcap: number;
  mcapPrice: number;
}

export interface ZephyrZsdPriceResolution {
  price: number;
  source: string;
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
}

function toPositiveFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function pegTypeKey(meta: StablecoinMeta): string {
  return `pegged${meta.flags.pegCurrency}`;
}

function getChainLabels(meta: StablecoinMeta): string[] {
  const labels = (meta.contracts ?? [])
    .map((contract) => CHAIN_META[contract.chain]?.name ?? contract.chain)
    .filter((label): label is string => typeof label === "string" && label.length > 0);

  return Array.from(new Set(labels));
}

export function parseZephyrZsdStats(payload: unknown): ZephyrZsdStats | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const supply = toPositiveFiniteNumber(record.zsd_circ);
  if (supply == null) return null;

  const mcapPrice = toPositiveFiniteNumber(record.zsd_price) ?? 1.0;
  return {
    supply,
    mcapPrice,
    mcap: supply * mcapPrice,
  };
}

export function buildZephyrZsdPeggedAsset(
  meta: StablecoinMeta,
  stats: ZephyrZsdStats,
  priceResolution: ZephyrZsdPriceResolution | null,
  nowSec = Math.floor(Date.now() / 1000),
): PeggedAsset | null {
  if (meta.id !== ZEPHYR_ZSD_ASSET_ID) return null;
  if (!Number.isFinite(stats.mcap) || stats.mcap <= 0) return null;

  const pKey = pegTypeKey(meta);
  const hasPrice = priceResolution != null;
  return {
    id: meta.id,
    name: meta.name,
    symbol: meta.symbol,
    geckoId: meta.geckoId,
    pegType: pKey,
    pegMechanism: meta.flags.backing,
    price: priceResolution?.price ?? null,
    priceSource: priceResolution?.source,
    priceConfidence: hasPrice ? "single-source" : null,
    priceUpdatedAt: hasPrice ? priceResolution.observedAt ?? nowSec : null,
    priceObservedAt: hasPrice ? priceResolution.observedAt ?? nowSec : null,
    priceObservedAtMode: hasPrice ? priceResolution.observedAtMode ?? "local_fetch" : null,
    priceSyncedAt: hasPrice ? nowSec : null,
    supplySource: ZSD_SUPPLY_SOURCE,
    circulating: { [pKey]: stats.mcap },
    circulatingPrevDay: null,
    circulatingPrevWeek: null,
    circulatingPrevMonth: null,
    chainCirculating: {},
    chains: getChainLabels(meta),
  } as PeggedAsset;
}

export async function fetchZephyrZsdStats(signal?: AbortSignal): Promise<ZephyrZsdStats | null> {
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
    console.warn(`[zephyr-zsd] Live stats fetch failed (${res?.status ?? "no response"})`);
    return null;
  }

  try {
    const payload = await res.json();
    const stats = parseZephyrZsdStats(payload);
    if (!stats) console.warn("[zephyr-zsd] Live stats payload missing positive zsd_circ");
    return stats;
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    console.warn("[zephyr-zsd] Live stats payload parse failed:", err);
    return null;
  }
}
