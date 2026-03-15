import type { YieldBenchmarkMeta, YieldSourceInputMeta } from "@shared/types";
import { RISK_FREE_RATE_FALLBACK } from "../../lib/constants";
import type { DlPool } from "./types";

interface RiskFreeRateCachePayload {
  rate: number;
  recordDate: string | null;
  fetchedAt: number | null;
  source: string;
  isFallback: boolean;
  fallbackMode: string | null;
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

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function buildRiskFreeRateCachePayload(
  fields: Partial<RiskFreeRateCachePayload> & Pick<RiskFreeRateCachePayload, "rate" | "source">,
): RiskFreeRateCachePayload {
  return {
    rate: fields.rate,
    recordDate: fields.recordDate ?? null,
    fetchedAt: fields.fetchedAt ?? null,
    source: fields.source,
    isFallback: fields.isFallback ?? false,
    fallbackMode: fields.fallbackMode ?? null,
  };
}

export function serializeRiskFreeRateCache(payload: RiskFreeRateCachePayload): string {
  return JSON.stringify(payload);
}

export function parseRiskFreeRateCache(
  raw: string,
  cacheUpdatedAt: number,
  nowSec = Math.floor(Date.now() / 1000),
): YieldBenchmarkMeta | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      const rate = toFiniteNumber(parsed.rate);
      const fetchedAt = toFiniteNumber(parsed.fetchedAt);
      if (rate != null && rate >= 0) {
        const effectiveFetchedAt = fetchedAt ?? cacheUpdatedAt;
        return {
          rate,
          recordDate: toNullableString(parsed.recordDate),
          fetchedAt: effectiveFetchedAt,
          ageSeconds: effectiveFetchedAt != null ? Math.max(0, nowSec - effectiveFetchedAt) : null,
          source: toNullableString(parsed.source) ?? "unknown",
          isFallback: parsed.isFallback === true,
          fallbackMode: toNullableString(parsed.fallbackMode),
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
