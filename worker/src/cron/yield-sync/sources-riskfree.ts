import { DAY_SECONDS } from "@shared/lib/time-constants";
import { getCache } from "../../lib/db-cache";
import { computeApyFromPrice, isDeterministicApyWithinSanityBounds } from "../yield-helpers";
import { buildHardcodedUsdBenchmark, type ParsedYieldBenchmarkMeta, type ParsedYieldBenchmarkRegistry } from "./benchmarks";
import { parseRiskFreeRateCache, parseRiskFreeRatesCache } from "./cache/normalization";

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
  const registryCache = await getCache(db, RISK_FREE_RATES_CACHE_KEY);
  if (registryCache) {
    const parsed = parseRiskFreeRatesCache(registryCache.value, registryCache.updatedAt);
    if (parsed) {
      return parsed;
    }
  }

  const legacyUsdCache = await getCache(db, LEGACY_USD_RISK_FREE_RATE_CACHE_KEY);
  if (legacyUsdCache) {
    const parsedUsd = parseRiskFreeRateCache(
      legacyUsdCache.value,
      legacyUsdCache.updatedAt,
      nowSec,
      { key: "USD" },
    );
    if (parsedUsd) {
      return emptyBenchmarkRegistry(parsedUsd);
    }
  }

  return emptyBenchmarkRegistry(
    buildHardcodedUsdBenchmark(
      registryCache || legacyUsdCache ? "invalid-cache" : "missing-cache",
    ),
  );
}
