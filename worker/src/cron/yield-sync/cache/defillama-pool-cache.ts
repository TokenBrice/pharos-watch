import { logWorkerEventArgs } from "../../../lib/structured-log";
import type { YieldSourceInputMeta } from "@shared/types/yield";
import { isRecord } from "@shared/lib/type-guards";
import type { DlPool } from "../types";
import {
  isFiniteNumber,
  isNullableFiniteNumber,
  parseCachePayloadUpdatedAt,
  summarizeInvalidRows,
} from "./normalization";

interface DlStablecoinPoolsCachePayload {
  updatedAt: number;
  source: string;
  poolCount: number;
  data: DlPool[];
}

function isValidDlPool(value: unknown): value is DlPool {
  if (!isRecord(value)) return false;
  if (typeof value.pool !== "string" || value.pool.trim() === "") return false;
  if (typeof value.chain !== "string" || value.chain.trim() === "") return false;
  if (typeof value.project !== "string" || value.project.trim() === "") return false;
  if (typeof value.symbol !== "string" || value.symbol.trim() === "") return false;
  if (value.poolMeta != null && typeof value.poolMeta !== "string") return false;
  if (!isFiniteNumber(value.tvlUsd) || value.tvlUsd < 0) return false;
  if (!isFiniteNumber(value.apy)) return false;
  if (!isNullableFiniteNumber(value.apyBase)) return false;
  if (!isNullableFiniteNumber(value.apyReward)) return false;
  if (value.apyMean30d != null && !isFiniteNumber(value.apyMean30d)) return false;
  if (typeof value.stablecoin !== "boolean") return false;
  if (typeof value.exposure !== "string") return false;
  if (
    value.underlyingTokens != null &&
    (!Array.isArray(value.underlyingTokens) || value.underlyingTokens.some((token) => typeof token !== "string"))
  ) {
    return false;
  }
  return true;
}

export function filterValidDlPools(
  rows: unknown[],
  context: string,
): { pools: DlPool[]; rejectedCount: number; rejectedExamples: string[] } {
  const pools: DlPool[] = [];
  const rejected: unknown[] = [];
  for (const row of rows) {
    if (isValidDlPool(row)) {
      pools.push(row);
    } else {
      rejected.push(row);
    }
  }
  const rejectedExamples = summarizeInvalidRows(rejected, (row, index) => {
    if (isRecord(row) && typeof row.pool === "string") return row.pool;
    return `row-${index}`;
  });
  if (rejected.length > 0) {
    logWorkerEventArgs("handler", "warn",
      `[yield-sync] Dropped ${rejected.length} invalid DL pool rows from ${context}: ${rejectedExamples.join(", ")}`,
    );
  }
  return { pools, rejectedCount: rejected.length, rejectedExamples };
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
    if (isRecord(parsed) && Array.isArray(parsed.data)) {
      const { pools } = filterValidDlPools(parsed.data, "structured dl-stablecoin-pools cache");
      const updatedAt = parseCachePayloadUpdatedAt(parsed.updatedAt, cacheUpdatedAt, nowSec);
      if (updatedAt == null) {
        logWorkerEventArgs("handler", "warn", "[yield-sync] Rejected DL pools cache with future updatedAt");
        return null;
      }
      return {
        pools,
        meta: {
          mode: "dex-cache",
          updatedAt,
          ageSeconds: Math.max(0, nowSec - updatedAt),
          poolCount: pools.length,
          fallbackMode: null,
        },
      };
    }
  } catch { /* expected: corrupted or unrecognised cache format */
    return null;
  }

  return null;
}
