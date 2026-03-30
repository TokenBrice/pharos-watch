import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { YieldBenchmarkMeta } from "@shared/types/yield";
import { getCache } from "../../lib/db-cache";
import { computeApyFromPrice } from "../yield-helpers";
import { buildHardcodedUsdBenchmark, type ParsedYieldBenchmarkRegistry } from "./benchmarks";
import { parseRiskFreeRateCache, parseRiskFreeRatesCache } from "./cache";

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

  return {
    apy: computeApyFromPrice(recentRow.price, anchoredRow.price, lookbackDays),
    sourceObservedAt: recentRow.snapshot_date,
    comparisonAnchorObservedAt: anchoredRow.snapshot_date,
  };
}

export async function loadRiskFreeRateRegistry(db: D1Database): Promise<ParsedYieldBenchmarkRegistry> {
  const registryCache = await getCache(db, "risk_free_rates");
  if (registryCache) {
    const parsed = parseRiskFreeRatesCache(registryCache.value, registryCache.updatedAt);
    if (parsed) {
      return parsed;
    }
  }

  const legacyUsdCache = await getCache(db, "risk_free_rate");
  if (legacyUsdCache) {
    const parsedUsd = parseRiskFreeRateCache(
      legacyUsdCache.value,
      legacyUsdCache.updatedAt,
      Math.floor(Date.now() / 1000),
      { key: "USD" },
    );
    if (parsedUsd) {
      return {
        USD: parsedUsd,
        EUR: null,
        CHF: null,
      };
    }
  }

  return {
    USD: buildHardcodedUsdBenchmark(
      registryCache || legacyUsdCache ? "invalid-cache" : "missing-cache",
    ),
    EUR: null,
    CHF: null,
  };
}

export async function loadRiskFreeRateSnapshot(db: D1Database): Promise<YieldBenchmarkMeta> {
  const registry = await loadRiskFreeRateRegistry(db);
  return registry.USD;
}
