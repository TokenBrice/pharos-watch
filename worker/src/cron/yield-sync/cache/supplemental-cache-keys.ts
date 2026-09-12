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
import { SUPPLEMENTAL_SOURCE_FAMILY_KEYS } from "../supplemental-source-families";

/**
 * B28: one version constant owns the family cache key prefix, the persisted
 * payload and the run-outcome row, so a payload-shape change invalidates every
 * family across a deploy or a rollback instead of being silently re-read.
 */
const YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION = 1;
const YIELD_SUPPLEMENTAL_FAMILY_CACHE_PREFIX =
  `yield:supplemental-sources:v${YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION}:`;
const YIELD_SUPPLEMENTAL_RUN_OUTCOME_CACHE_PREFIX =
  `yield:supplemental-source-run:v${YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION}`;

export function getYieldSupplementalFamilyCacheKey(family: SupplementalSourceFamilyKey): string {
  return `${YIELD_SUPPLEMENTAL_FAMILY_CACHE_PREFIX}${family}`;
}

/**
 * B1: per-run family outcomes. The writer records which families kept their
 * previous snapshot so the publication can name them in
 * `supplementalMeta.degradedFamilies` (B16 degradation reasons).
 */
export function getYieldSupplementalRunOutcomeCacheKey(): string {
  return YIELD_SUPPLEMENTAL_RUN_OUTCOME_CACHE_PREFIX;
}

export type SupplementalFamilyCacheResult =
  | "published"
  | "skipped-newer"
  | "empty"
  | "empty-published"
  | "retained-previous";

export interface YieldSupplementalRunOutcome {
  version: number;
  checkedAt: number;
  familyCacheResults: Record<SupplementalSourceFamilyKey, SupplementalFamilyCacheResult>;
  degradedFamilies: SupplementalSourceFamilyKey[];
}

export function buildYieldSupplementalRunOutcome(
  familyCacheResults: Record<SupplementalSourceFamilyKey, SupplementalFamilyCacheResult>,
  degradedFamilies: SupplementalSourceFamilyKey[],
  checkedAt = Math.floor(Date.now() / 1000),
): string {
  const payload: YieldSupplementalRunOutcome = {
    version: YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION,
    checkedAt,
    familyCacheResults,
    degradedFamilies,
  };
  return JSON.stringify(payload);
}

/**
 * Families whose last fetch ended degraded. A missing, version-mismatched or
 * malformed row reads as "none known degraded": the retained family markers
 * still carry the age signal, so this is an additive reason, never a gate.
 */
export function parseYieldSupplementalRunOutcome(
  raw: string,
): SupplementalSourceFamilyKey[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return [];
    if (parsed.version !== YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION) {
      logWorkerEventArgs("handler", "warn",
        `[yield-sync] Ignored supplemental run outcome written by cache version ${String(parsed.version)}`,
      );
      return [];
    }
    if (!Array.isArray(parsed.degradedFamilies)) return [];
    return parsed.degradedFamilies.filter(isSupplementalSourceFamilyKey);
  } catch (err) {
    logWorkerEventArgs("handler", "warn",
      `[yield-sync] Failed to parse supplemental run outcome: ${toErrorMessage(err)}`,
    );
    return [];
  }
}

function isSupplementalSourceFamilyKey(value: unknown): value is SupplementalSourceFamilyKey {
  return typeof value === "string"
    && (SUPPLEMENTAL_SOURCE_FAMILY_KEYS as readonly string[]).includes(value);
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

export function buildYieldSupplementalFamilyCache(
  candidates: ResolvedYieldCandidate[],
  updatedAt = Math.floor(Date.now() / 1000),
): string {
  const payload: YieldSupplementalSourcesCachePayload = {
    version: YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION,
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
    if (isRecord(parsed) && parsed.version !== YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION) {
      logWorkerEventArgs("handler", "warn",
        `[yield-sync] Rejected supplemental sources cache written by version ${String(parsed.version)}; expected ${YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION}`,
      );
      return null;
    }
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
