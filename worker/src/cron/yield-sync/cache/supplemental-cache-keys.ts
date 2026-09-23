import { logWorkerEventArgs } from "../../../lib/structured-log";
import { isRecord } from "@shared/lib/type-guards";
import { PYS_APY_SANITY_MAX } from "@shared/lib/yield-scoring";
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
import { SUPPLEMENTAL_SOURCE_FAMILY_KEYS } from "../supplemental-source-family-keys";

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
  | "retained-previous"
  /** PENDLE-RL: neutral skip — the family kept its retained row because its per-family fetch cadence had not elapsed. */
  | "skipped-not-due"
  /** PENDLE-RL: neutral skip — the family kept its retained row because an active 429 backoff refused the call. */
  | "skipped-backoff";

export interface YieldSupplementalRunOutcome {
  version: number;
  checkedAt: number;
  familyCacheResults: Record<SupplementalSourceFamilyKey, SupplementalFamilyCacheResult>;
  degradedFamilies: SupplementalSourceFamilyKey[];
  /**
   * PENDLE-RL: machine-readable cause per degraded family (R4). Additive:
   * rows written before the field exists parse as no reasons.
   */
  degradedFamilyReasons?: Record<string, string>;
}

export function buildYieldSupplementalRunOutcome(
  familyCacheResults: Record<SupplementalSourceFamilyKey, SupplementalFamilyCacheResult>,
  degradedFamilies: SupplementalSourceFamilyKey[],
  checkedAt = Math.floor(Date.now() / 1000),
  degradedFamilyReasons?: Record<string, string>,
): string {
  const payload: YieldSupplementalRunOutcome = {
    version: YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION,
    checkedAt,
    familyCacheResults,
    degradedFamilies,
    ...(degradedFamilyReasons && Object.keys(degradedFamilyReasons).length > 0
      ? { degradedFamilyReasons }
      : {}),
  };
  return JSON.stringify(payload);
}

export interface ParsedYieldSupplementalRunOutcome {
  degradedFamilies: SupplementalSourceFamilyKey[];
  degradedFamilyReasons: Record<string, string>;
}


/**
 * Families whose last fetch ended degraded. A missing, version-mismatched or
 * malformed row reads as "none known degraded": the retained family markers
 * still carry the age signal, so this is an additive reason, never a gate.
 */
export function parseYieldSupplementalRunOutcome(
  raw: string,
): SupplementalSourceFamilyKey[] {
  return parseYieldSupplementalRunOutcomeDetailed(raw).degradedFamilies;
}

export function parseYieldSupplementalRunOutcomeDetailed(
  raw: string,
): ParsedYieldSupplementalRunOutcome {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { degradedFamilies: [], degradedFamilyReasons: {} };
    if (parsed.version !== YIELD_SUPPLEMENTAL_SOURCES_CACHE_VERSION) {
      logWorkerEventArgs("handler", "warn",
        `[yield-sync] Ignored supplemental run outcome written by cache version ${String(parsed.version)}`,
      );
      return { degradedFamilies: [], degradedFamilyReasons: {} };
    }
    const degradedFamilies = Array.isArray(parsed.degradedFamilies)
      ? parsed.degradedFamilies.filter(isSupplementalSourceFamilyKey)
      : [];
    const degradedFamilyReasons: Record<string, string> = {};
    if (isRecord(parsed.degradedFamilyReasons)) {
      for (const family of degradedFamilies) {
        const reason = parsed.degradedFamilyReasons[family];
        if (typeof reason === "string" && reason.trim()) {
          degradedFamilyReasons[family] = reason.trim();
        }
      }
    }
    return { degradedFamilies, degradedFamilyReasons };
  } catch (err) {
    logWorkerEventArgs("handler", "warn",
      `[yield-sync] Failed to parse supplemental run outcome: ${toErrorMessage(err)}`,
    );
    return { degradedFamilies: [], degradedFamilyReasons: {} };
  }
}

/** PENDLE-RL: machine-readable cause recorded when the unkeyed quota backoff degrades the family. */
export const PENDLE_RATE_LIMIT_BACKOFF_REASON = "pendle-rate-limited-backoff";

export type YieldSupplementalPendleBackoffSource =
  | "retry-after"
  | "x-ratelimit-weekly-reset"
  | "x-ratelimit-reset"
  | "default";

export interface YieldSupplementalPendleBackoff {
  backoffUntilSec: number;
  reason: string;
  source: YieldSupplementalPendleBackoffSource;
  recordedAtSec: number;
}

/**
 * PENDLE-RL: persisted 429 backoff for the unkeyed Pendle API. The row records
 * when the per-IP quota window is expected to replenish; the pendle family
 * loader refuses to call Pendle again before that time. An expired or
 * malformed row reads as "no active backoff", so a lost or corrupt row can
 * only cost one request, never wedge the lane.
 */
export function getYieldSupplementalPendleBackoffCacheKey(): string {
  return `${YIELD_SUPPLEMENTAL_FAMILY_CACHE_PREFIX}pendle-backoff`;
}

const PENDLE_BACKOFF_SOURCES: readonly YieldSupplementalPendleBackoffSource[] = [
  "retry-after",
  "x-ratelimit-weekly-reset",
  "x-ratelimit-reset",
  "default",
];

export function buildYieldSupplementalPendleBackoff(input: {
  backoffUntilSec: number;
  source: YieldSupplementalPendleBackoffSource;
  recordedAtSec: number;
}): string {
  return JSON.stringify({
    backoffUntilSec: input.backoffUntilSec,
    reason: PENDLE_RATE_LIMIT_BACKOFF_REASON,
    source: input.source,
    recordedAtSec: input.recordedAtSec,
  } satisfies YieldSupplementalPendleBackoff);
}

export function parseYieldSupplementalPendleBackoff(
  raw: string | null | undefined,
  nowSec: number,
): YieldSupplementalPendleBackoff | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const backoffUntilSec = parsed.backoffUntilSec;
    if (
      typeof backoffUntilSec !== "number"
      || !Number.isInteger(backoffUntilSec)
      || backoffUntilSec <= nowSec
      || typeof parsed.recordedAtSec !== "number"
      || !Number.isSafeInteger(parsed.recordedAtSec)
      || parsed.recordedAtSec < 0
      || parsed.recordedAtSec > nowSec + 60
      || backoffUntilSec <= parsed.recordedAtSec
      || backoffUntilSec - parsed.recordedAtSec > 7 * 86400
    ) {
      return null;
    }
    const source = PENDLE_BACKOFF_SOURCES.includes(parsed.source as YieldSupplementalPendleBackoffSource)
      ? (parsed.source as YieldSupplementalPendleBackoffSource)
      : "default";
    return {
      backoffUntilSec,
      reason: PENDLE_RATE_LIMIT_BACKOFF_REASON,
      source,
      recordedAtSec: parsed.recordedAtSec,
    };
  } catch {
    return null;
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
  if (!isFiniteNumber(candidateYield.currentApy) || candidateYield.currentApy > PYS_APY_SANITY_MAX) return false;
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
