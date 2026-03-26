import type { YieldBenchmarkMeta, YieldSourceInputMeta } from "@shared/types/yield";
import { RISK_FREE_RATE_FALLBACK } from "../../lib/constants";
import { toFiniteNumber } from "../../lib/number-utils";
import type { DlPool, ResolvedYieldCandidate } from "./types";

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

interface YieldSupplementalSourcesCachePayload {
  version: 1;
  updatedAt: number;
  source: string;
  sourceCount: number;
  data: ResolvedYieldCandidate[];
}

export interface ParsedYieldSupplementalSourcesCache {
  candidates: ResolvedYieldCandidate[];
  updatedAt: number;
  ageSeconds: number;
  sourceCount: number;
}

interface DeterministicOnChainHealthStateCachePayload {
  version: 1;
  consecutiveAllFailRuns: number;
  consecutiveMaskedAllFailRuns: number;
  cooldownUntil: number | null;
  lastAttemptedAt: number | null;
  lastAllFailedAt: number | null;
  lastSuccessAt: number | null;
  lastSkippedAt: number | null;
  lastFailureMissingIds: string[];
}

export interface DeterministicOnChainHealthState {
  consecutiveAllFailRuns: number;
  consecutiveMaskedAllFailRuns: number;
  cooldownUntil: number | null;
  lastAttemptedAt: number | null;
  lastAllFailedAt: number | null;
  lastSuccessAt: number | null;
  lastSkippedAt: number | null;
  lastFailureMissingIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function toNonNegativeInteger(value: unknown): number {
  const parsed = toFiniteNumber(value);
  if (parsed == null || parsed < 0) return 0;
  return Math.floor(parsed);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function isResolvedYieldCandidate(value: unknown): value is ResolvedYieldCandidate {
  if (!isRecord(value)) return false;
  if (typeof value.symbol !== "string" || value.symbol.trim() === "") return false;
  if (value.chain != null && typeof value.chain !== "string") return false;
  if (value.address != null && typeof value.address !== "string") return false;
  if (!isRecord(value.yield)) return false;
  return typeof value.yield.sourceKey === "string" && value.yield.sourceKey.trim() !== "";
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
    if (Array.isArray(parsed)) {
      const candidates = parsed.filter(isResolvedYieldCandidate);
      return {
        candidates,
        updatedAt: cacheUpdatedAt,
        ageSeconds: Math.max(0, nowSec - cacheUpdatedAt),
        sourceCount: candidates.length,
      };
    }

    if (isRecord(parsed) && Array.isArray(parsed.data)) {
      const candidates = parsed.data.filter(isResolvedYieldCandidate);
      const updatedAt = toFiniteNumber(parsed.updatedAt) ?? cacheUpdatedAt;
      return {
        candidates,
        updatedAt,
        ageSeconds: Math.max(0, nowSec - updatedAt),
        sourceCount: toNonNegativeInteger(parsed.sourceCount) || candidates.length,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export function getDefaultDeterministicOnChainHealthState(): DeterministicOnChainHealthState {
  return {
    consecutiveAllFailRuns: 0,
    consecutiveMaskedAllFailRuns: 0,
    cooldownUntil: null,
    lastAttemptedAt: null,
    lastAllFailedAt: null,
    lastSuccessAt: null,
    lastSkippedAt: null,
    lastFailureMissingIds: [],
  };
}

export function serializeDeterministicOnChainHealthState(
  state: DeterministicOnChainHealthState,
): string {
  const payload: DeterministicOnChainHealthStateCachePayload = {
    version: 1,
    consecutiveAllFailRuns: state.consecutiveAllFailRuns,
    consecutiveMaskedAllFailRuns: state.consecutiveMaskedAllFailRuns,
    cooldownUntil: state.cooldownUntil,
    lastAttemptedAt: state.lastAttemptedAt,
    lastAllFailedAt: state.lastAllFailedAt,
    lastSuccessAt: state.lastSuccessAt,
    lastSkippedAt: state.lastSkippedAt,
    lastFailureMissingIds: state.lastFailureMissingIds,
  };
  return JSON.stringify(payload);
}

export function parseDeterministicOnChainHealthState(raw: string): DeterministicOnChainHealthState {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return getDefaultDeterministicOnChainHealthState();
    }

    return {
      consecutiveAllFailRuns: toNonNegativeInteger(parsed.consecutiveAllFailRuns),
      consecutiveMaskedAllFailRuns: toNonNegativeInteger(parsed.consecutiveMaskedAllFailRuns),
      cooldownUntil: toFiniteNumber(parsed.cooldownUntil),
      lastAttemptedAt: toFiniteNumber(parsed.lastAttemptedAt),
      lastAllFailedAt: toFiniteNumber(parsed.lastAllFailedAt),
      lastSuccessAt: toFiniteNumber(parsed.lastSuccessAt),
      lastSkippedAt: toFiniteNumber(parsed.lastSkippedAt),
      lastFailureMissingIds: toStringArray(parsed.lastFailureMissingIds),
    };
  } catch {
    return getDefaultDeterministicOnChainHealthState();
  }
}
