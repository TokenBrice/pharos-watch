import { DAY_SECONDS } from "@shared/lib/time-constants";
import { getCache } from "../../lib/db-cache";
import { computeApyFromPrice, isDeterministicApyWithinSanityBounds } from "../yield-helpers";
import { buildHardcodedUsdBenchmark, type ParsedYieldBenchmarkMeta, type ParsedYieldBenchmarkRegistry } from "./benchmarks";
import { parseRiskFreeRateCache, parseRiskFreeRatesCacheDetailed } from "./cache/normalization";

const RISK_FREE_RATES_CACHE_KEY = "risk_free_rates";
const LEGACY_USD_RISK_FREE_RATE_CACHE_KEY = "risk_free_rate";

export async function getPriceDerivedApy(
  db: D1Database,
  stablecoinId: string,
): Promise<{
  apy: number;
  sourceObservedAt: number;
  comparisonAnchorObservedAt: number;
} | null> {
  const now = Math.floor(Date.now() / 1000);
  const minLookbackSec = 7 * DAY_SECONDS;
  const maxLookbackSec = 45 * DAY_SECONDS;

  const [recentRow, anchoredRow] = await Promise.all([
    db
      .prepare(
        "SELECT price, snapshot_date FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1",
      )
      .bind(stablecoinId)
      .first<{ price: number; snapshot_date: number }>(),
    db
      .prepare(
        `SELECT price, snapshot_date
         FROM supply_history
         WHERE stablecoin_id = ?
           AND price IS NOT NULL
           AND snapshot_date BETWEEN ? AND ?
         ORDER BY snapshot_date ASC
         LIMIT 1`,
      )
      .bind(stablecoinId, now - maxLookbackSec, now - minLookbackSec)
      .first<{ price: number; snapshot_date: number }>(),
  ]);

  if (!recentRow?.price || !anchoredRow?.price || anchoredRow.price <= 0) return null;

  const lookbackDays = (recentRow.snapshot_date - anchoredRow.snapshot_date) / DAY_SECONDS;
  if (!Number.isFinite(lookbackDays) || lookbackDays < 7) return null;
  const apy = computeApyFromPrice(recentRow.price, anchoredRow.price, lookbackDays);
  if (!isDeterministicApyWithinSanityBounds(apy)) return null;

  return {
    apy,
    sourceObservedAt: recentRow.snapshot_date,
    comparisonAnchorObservedAt: anchoredRow.snapshot_date,
  };
}

function emptyBenchmarkRegistry(usd: ParsedYieldBenchmarkMeta): ParsedYieldBenchmarkRegistry {
  return {
    USD: usd,
    USD_EFFR: null,
    EUR: null,
    CHF: null,
    GBP: null,
    JPY: null,
    MXN: null,
    BRL: null,
    AUD: null,
    CAD: null,
    RUB: null,
    TRY: null,
    SGD: null,
  };
}

export async function loadRiskFreeRateRegistry(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<ParsedYieldBenchmarkRegistry> {
  return (await loadRiskFreeRateRegistryWithState(db, nowSec)).registry;
}

/**
 * Readability of the cached `risk_free_rates` row this load started from.
 * `invalid` means a row existed and could not be parsed at all; `missing` means
 * there was no row. Callers that publish the registry use it to avoid stamping a
 * placeholder snapshot over an unreadable row.
 */
export type RiskFreeRateRegistryCacheState = "valid" | "invalid" | "missing";

export interface LoadedRiskFreeRateRegistry {
  registry: ParsedYieldBenchmarkRegistry;
  cacheState: RiskFreeRateRegistryCacheState;
}

/**
 * Same read as `loadRiskFreeRateRegistry`, plus the state of the cache row it
 * came from. A USD sub-entry that does not parse degrades USD alone — every
 * other readable key is kept, and USD prefers the readable legacy scalar row
 * over the hardcoded fallback.
 */
export async function loadRiskFreeRateRegistryWithState(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<LoadedRiskFreeRateRegistry> {
  const registryCache = await getCache(db, RISK_FREE_RATES_CACHE_KEY);
  const parsedRegistry = registryCache
    ? parseRiskFreeRatesCacheDetailed(registryCache.value, registryCache.updatedAt, nowSec)
    : null;

  if (parsedRegistry && !parsedRegistry.invalidKeys.includes("USD")) {
    return { registry: parsedRegistry.registry, cacheState: "valid" };
  }

  const legacyUsdCache = await getCache(db, LEGACY_USD_RISK_FREE_RATE_CACHE_KEY);
  const legacyUsd = legacyUsdCache
    ? parseRiskFreeRateCache(legacyUsdCache.value, legacyUsdCache.updatedAt, nowSec, { key: "USD" })
    : null;

  if (parsedRegistry) {
    return {
      registry: { ...parsedRegistry.registry, USD: legacyUsd ?? parsedRegistry.registry.USD },
      cacheState: "valid",
    };
  }

  if (legacyUsd) {
    return {
      registry: emptyBenchmarkRegistry(legacyUsd),
      cacheState: registryCache ? "invalid" : "missing",
    };
  }

  return {
    registry: emptyBenchmarkRegistry(
      buildHardcodedUsdBenchmark(
        registryCache || legacyUsdCache ? "invalid-cache" : "missing-cache",
      ),
    ),
    cacheState: registryCache ? "invalid" : "missing",
  };
}
