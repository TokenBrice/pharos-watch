import { logWorkerEventArgs } from "../../../lib/structured-log";
import { isRecord } from "@shared/lib/type-guards";
import type { ResolvedYieldCandidate } from "../types";
import type { SupplementalSourceFamilyKey } from "../supplemental-source-family-keys";
import {
  isFiniteNumber,
  isNullableFiniteNumber,
  isNullableNonNegativeFiniteNumber,
  isNullableStringValue,
  isObservedAt,
  parseCachePayloadUpdatedAt,
  summarizeInvalidRows,
  toNonNegativeInteger,
} from "./normalization";
import { toErrorMessage } from "@shared/lib/error-utils";

export const YIELD_SUPPLEMENTAL_CACHE_KEY = "yield:supplemental-sources:v1";

export function getYieldSupplementalFamilyCacheKey(family: SupplementalSourceFamilyKey): string {
  return `${YIELD_SUPPLEMENTAL_CACHE_KEY}:${family}`;
}

interface YieldSupplementalSourcesCachePayload {
  version: 1;
  updatedAt: number;
  source: string;
  sourceCount: number;
  data: ResolvedYieldCandidate[];
}

interface ParsedYieldSupplementalSourcesCache {
  candidates: ResolvedYieldCandidate[];
  updatedAt: number;
  ageSeconds: number;
  sourceCount: number;
}

function isResolvedYieldCandidate(value: unknown, nowSec: number): value is ResolvedYieldCandidate {
  if (!isRecord(value)) return false;
  if (typeof value.symbol !== "string" || value.symbol.trim() === "") return false;
  if (value.chain != null && typeof value.chain !== "string") return false;
  if (value.address != null && typeof value.address !== "string") return false;
  if (!isRecord(value.yield)) return false;
  const candidateYield = value.yield;
  if (typeof candidateYield.sourceKey !== "string" || candidateYield.sourceKey.trim() === "") return false;
  if (!isFiniteNumber(candidateYield.currentApy)) return false;
  if (!isNullableFiniteNumber(candidateYield.apyBase)) return false;
  if (!isNullableFiniteNumber(candidateYield.apyReward)) return false;
  if (!isNullableStringValue(candidateYield.sourcePool)) return false;
  if (!isNullableNonNegativeFiniteNumber(candidateYield.sourceTvlUsd)) return false;
  if (
    candidateYield.dataSource !== "onchain" &&
    candidateYield.dataSource !== "defillama" &&
    candidateYield.dataSource !== "defillama-auto" &&
    candidateYield.dataSource !== "price-derived" &&
    candidateYield.dataSource !== "rate-derived" &&
    candidateYield.dataSource !== "protocol-api"
  ) {
    return false;
  }
  if (!isNullableFiniteNumber(candidateYield.exchangeRate)) return false;
  if (!isObservedAt(candidateYield.sourceObservedAt, nowSec)) return false;
  if (!isObservedAt(candidateYield.comparisonAnchorObservedAt, nowSec)) return false;
  if (candidateYield.yieldSource != null && typeof candidateYield.yieldSource !== "string") return false;
  if (candidateYield.project != null && typeof candidateYield.project !== "string") return false;
  return true;
}

function filterValidSupplementalCandidates(
  rows: unknown[],
  nowSec: number,
): { candidates: ResolvedYieldCandidate[]; rejectedCount: number; rejectedExamples: string[] } {
  const candidates: ResolvedYieldCandidate[] = [];
  const rejected: unknown[] = [];
  for (const row of rows) {
    if (isResolvedYieldCandidate(row, nowSec)) {
      candidates.push(row);
    } else {
      rejected.push(row);
    }
  }
  const rejectedExamples = summarizeInvalidRows(rejected, (row, index) => {
    if (isRecord(row) && isRecord(row.yield) && typeof row.yield.sourceKey === "string") {
      return row.yield.sourceKey;
    }
    return `row-${index}`;
  });
  if (rejected.length > 0) {
    logWorkerEventArgs("handler", "warn",
      `[yield-sync] Dropped ${rejected.length} invalid supplemental yield source rows: ${rejectedExamples.join(", ")}`,
    );
  }
  return { candidates, rejectedCount: rejected.length, rejectedExamples };
}

export function buildYieldSupplementalSourcesCache(
  candidates: ResolvedYieldCandidate[],
  updatedAt = Math.floor(Date.now() / 1000),
): string {
  const payload: YieldSupplementalSourcesCachePayload = {
    version: 1,
    updatedAt,
    source: "sync-yield-supplemental",
    sourceCount: candidates.length,
    data: candidates,
  };
  return JSON.stringify(payload);
}

export function parseYieldSupplementalSourcesCache(
  raw: string,
  cacheUpdatedAt: number,
  nowSec = Math.floor(Date.now() / 1000),
): ParsedYieldSupplementalSourcesCache | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.data)) {
      const { candidates } = filterValidSupplementalCandidates(parsed.data, nowSec);
      const updatedAt = parseCachePayloadUpdatedAt(parsed.updatedAt, cacheUpdatedAt, nowSec);
      if (updatedAt == null) {
        logWorkerEventArgs("handler", "warn", "[yield-sync] Rejected supplemental sources cache with future updatedAt");
        return null;
      }
      return {
        candidates,
        updatedAt,
        ageSeconds: Math.max(0, nowSec - updatedAt),
        sourceCount: toNonNegativeInteger(parsed.sourceCount) || candidates.length,
      };
    }
  } catch (err) {
    logWorkerEventArgs("handler", "warn", `[yield-sync] Failed to parse supplemental sources cache: ${toErrorMessage(err)}`);
    return null;
  }

  return null;
}
