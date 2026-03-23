import type { YieldBenchmarkMeta, YieldSourceInputMeta } from "@shared/types";
import { RISK_FREE_RATE_FALLBACK } from "../../lib/constants";
import { toFiniteNumber } from "../../lib/number-utils";
import type { DlPool } from "./types";

interface RiskFreeRateCachePayload {
  rate: number;
  recordDate: string | null;
  fetchedAt: number | null;
  source: string;
  isFallback: boolean;
  fallbackMode: string | null;
  lastMarketRate: number | null;
  lastMarketRecordDate: string | null;
  lastMarketFetchedAt: number | null;
  lastMarketSource: string | null;
}

export interface ParsedRiskFreeRateCache extends YieldBenchmarkMeta {
  lastMarketRate: number | null;
  lastMarketRecordDate: string | null;
  lastMarketFetchedAt: number | null;
  lastMarketSource: string | null;
}

interface DlStablecoinPoolsCachePayload {
  updatedAt: number;
  source: string;
  poolCount: number;
  data: DlPool[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function buildRiskFreeRateCachePayload(
  fields: Partial<RiskFreeRateCachePayload> & Pick<RiskFreeRateCachePayload, "rate" | "source">,
): RiskFreeRateCachePayload {
  const inferredLastMarketRate =
    fields.lastMarketRate ??
    (fields.isFallback === true || fields.source === "hardcoded-fallback" ? null : fields.rate);
  const inferredLastMarketRecordDate =
    fields.lastMarketRecordDate ??
    (inferredLastMarketRate != null ? fields.recordDate ?? null : null);
  const inferredLastMarketFetchedAt =
    fields.lastMarketFetchedAt ??
    (inferredLastMarketRate != null ? fields.fetchedAt ?? null : null);
  const inferredLastMarketSource =
    fields.lastMarketSource ??
    (inferredLastMarketRate != null ? fields.source : null);
  return {
    rate: fields.rate,
    recordDate: fields.recordDate ?? null,
    fetchedAt: fields.fetchedAt ?? null,
    source: fields.source,
    isFallback: fields.isFallback ?? false,
    fallbackMode: fields.fallbackMode ?? null,
    lastMarketRate: inferredLastMarketRate,
    lastMarketRecordDate: inferredLastMarketRecordDate,
    lastMarketFetchedAt: inferredLastMarketFetchedAt,
    lastMarketSource: inferredLastMarketSource,
  };
}

export function serializeRiskFreeRateCache(payload: RiskFreeRateCachePayload): string {
  return JSON.stringify(payload);
}

export function parseRiskFreeRateCache(
  raw: string,
  cacheUpdatedAt: number,
  nowSec = Math.floor(Date.now() / 1000),
): ParsedRiskFreeRateCache | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      const rate = toFiniteNumber(parsed.rate);
      const fetchedAt = toFiniteNumber(parsed.fetchedAt);
      if (rate != null && rate >= 0) {
        const effectiveFetchedAt = fetchedAt ?? cacheUpdatedAt;
        const isFallback = parsed.isFallback === true;
        const source = toNullableString(parsed.source) ?? "unknown";
        const lastMarketRate =
          toFiniteNumber(parsed.lastMarketRate) ??
          (!isFallback && source !== "hardcoded-fallback" ? rate : null);
        return {
          rate,
          recordDate: toNullableString(parsed.recordDate),
          fetchedAt: effectiveFetchedAt,
          ageSeconds: effectiveFetchedAt != null ? Math.max(0, nowSec - effectiveFetchedAt) : null,
          source,
          isFallback,
          fallbackMode: toNullableString(parsed.fallbackMode),
          lastMarketRate,
          lastMarketRecordDate:
            toNullableString(parsed.lastMarketRecordDate) ??
            (lastMarketRate != null ? toNullableString(parsed.recordDate) : null),
          lastMarketFetchedAt:
            toFiniteNumber(parsed.lastMarketFetchedAt) ??
            (lastMarketRate != null ? effectiveFetchedAt : null),
          lastMarketSource:
            toNullableString(parsed.lastMarketSource) ??
            (lastMarketRate != null ? source : null),
        };
      }
    }
  } catch { /* expected: legacy scalar format — fall through to numeric parsing */
  }

  const legacyRate = toFiniteNumber(raw);
  if (legacyRate == null || legacyRate < 0) return null;
  return {
    rate: legacyRate,
    recordDate: null,
    fetchedAt: cacheUpdatedAt,
    ageSeconds: Math.max(0, nowSec - cacheUpdatedAt),
    source: "legacy-scalar",
    isFallback: legacyRate === RISK_FREE_RATE_FALLBACK,
    fallbackMode: legacyRate === RISK_FREE_RATE_FALLBACK ? "legacy-scalar-fallback" : null,
    lastMarketRate: legacyRate === RISK_FREE_RATE_FALLBACK ? null : legacyRate,
    lastMarketRecordDate: null,
    lastMarketFetchedAt: legacyRate === RISK_FREE_RATE_FALLBACK ? null : cacheUpdatedAt,
    lastMarketSource: legacyRate === RISK_FREE_RATE_FALLBACK ? null : "legacy-scalar",
  };
}

export function buildDlStablecoinPoolsCache(
  pools: DlPool[],
  updatedAt = Math.floor(Date.now() / 1000),
): string {
  const payload: DlStablecoinPoolsCachePayload = {
    updatedAt,
    source: "sync-dex-liquidity",
    poolCount: pools.length,
    data: pools,
  };
  return JSON.stringify(payload);
}

export function parseDlStablecoinPoolsCache(
  raw: string,
  cacheUpdatedAt: number,
  nowSec = Math.floor(Date.now() / 1000),
): { pools: DlPool[]; meta: YieldSourceInputMeta } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return {
        pools: parsed as DlPool[],
        meta: {
          mode: "dex-cache",
          updatedAt: cacheUpdatedAt,
          ageSeconds: Math.max(0, nowSec - cacheUpdatedAt),
          poolCount: parsed.length,
          fallbackMode: "legacy-array-cache",
        },
      };
    }

    if (isRecord(parsed) && Array.isArray(parsed.data)) {
      const updatedAt = toFiniteNumber(parsed.updatedAt) ?? cacheUpdatedAt;
      return {
        pools: parsed.data as DlPool[],
        meta: {
          mode: "dex-cache",
          updatedAt,
          ageSeconds: Math.max(0, nowSec - updatedAt),
          poolCount: toFiniteNumber(parsed.poolCount) ?? parsed.data.length,
          fallbackMode: null,
        },
      };
    }
  } catch { /* expected: corrupted or unrecognised cache format */
    return null;
  }

  return null;
}
