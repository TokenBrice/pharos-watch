import type { YieldBenchmarkKey, YieldSourceInputMeta } from "@shared/types/yield";
import { RISK_FREE_RATE_FALLBACK } from "../../lib/constants";
import { toFiniteNumber } from "../../lib/number-utils";
import type { DlPool, ResolvedYieldCandidate } from "./types";
import {
  getYieldBenchmarkStaticMeta,
  type ParsedYieldBenchmarkMeta,
  type ParsedYieldBenchmarkRegistry,
} from "./benchmarks";

interface RiskFreeRateCachePayload {
  key?: YieldBenchmarkKey;
  label?: string;
  currency?: string;
  rate: number;
  recordDate: string | null;
  fetchedAt: number | null;
  source: string;
  isFallback: boolean;
  fallbackMode: string | null;
  isProxy?: boolean;
  lastMarketRate: number | null;
  lastMarketRecordDate: string | null;
  lastMarketFetchedAt: number | null;
  lastMarketSource: string | null;
}

interface RiskFreeRatesCachePayload {
  version: 1;
  benchmarks: {
    USD: RiskFreeRateCachePayload;
    EUR: RiskFreeRateCachePayload | null;
    CHF: RiskFreeRateCachePayload | null;
  };
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

export type YieldRankingsPublishedCutoffResult =
  | { status: "ok"; updatedAt: number }
  | { status: "missing"; updatedAt: null }
  | { status: "parse-error"; updatedAt: null }
  | { status: "invalid-shape"; updatedAt: null };

import { isRecord } from "@shared/lib/type-guards";

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

export function parseYieldRankingsPublishedCutoff(
  cached: { value: string; updatedAt: number } | null,
): YieldRankingsPublishedCutoffResult {
  if (!cached) {
    return { status: "missing", updatedAt: null };
  }

  try {
    const parsed = JSON.parse(cached.value) as unknown;
    if (!isRecord(parsed)) {
      return { status: "invalid-shape", updatedAt: null };
    }

    const updatedAt = toFiniteNumber(parsed.updatedAt);
    if (updatedAt == null || updatedAt <= 0) {
      return { status: "invalid-shape", updatedAt: null };
    }

    return { status: "ok", updatedAt };
  } catch {
    // Expected when a stale cache row was written before the current shape.
    return { status: "parse-error", updatedAt: null };
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null | undefined {
  return value == null || isFiniteNumber(value);
}

function isNullableNonNegativeFiniteNumber(value: unknown): value is number | null | undefined {
  return value == null || (isFiniteNumber(value) && value >= 0);
}

function isNullableStringValue(value: unknown): value is string | null | undefined {
  return value == null || typeof value === "string";
}

function isObservedAt(value: unknown, nowSec: number): value is number | null | undefined {
  return value == null || (isFiniteNumber(value) && value >= 0 && value <= nowSec);
}

function parseCachePayloadUpdatedAt(value: unknown, cacheUpdatedAt: number, nowSec: number): number | null {
  const updatedAt = toFiniteNumber(value) ?? cacheUpdatedAt;
  return updatedAt <= nowSec ? updatedAt : null;
}

function summarizeInvalidRows(rows: unknown[], getKey: (row: unknown, index: number) => string): string[] {
  return rows.slice(0, 5).map(getKey);
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
    console.warn(
      `[yield-sync] Dropped ${rejected.length} invalid DL pool rows from ${context}: ${rejectedExamples.join(", ")}`,
    );
  }
  return { pools, rejectedCount: rejected.length, rejectedExamples };
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
    console.warn(
      `[yield-sync] Dropped ${rejected.length} invalid supplemental yield source rows: ${rejectedExamples.join(", ")}`,
    );
  }
  return { candidates, rejectedCount: rejected.length, rejectedExamples };
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
  const staticMeta =
    fields.key != null
      ? getYieldBenchmarkStaticMeta(fields.key)
      : getYieldBenchmarkStaticMeta("USD");
  return {
    key: fields.key ?? "USD",
    label: fields.label ?? staticMeta.label,
    currency: fields.currency ?? staticMeta.currency,
    rate: fields.rate,
    recordDate: fields.recordDate ?? null,
    fetchedAt: fields.fetchedAt ?? null,
    source: fields.source,
    isFallback: fields.isFallback ?? false,
    fallbackMode: fields.fallbackMode ?? null,
    isProxy: fields.isProxy ?? staticMeta.isProxy,
    lastMarketRate: inferredLastMarketRate,
    lastMarketRecordDate: inferredLastMarketRecordDate,
    lastMarketFetchedAt: inferredLastMarketFetchedAt,
    lastMarketSource: inferredLastMarketSource,
  };
}

export function serializeRiskFreeRateCache(payload: RiskFreeRateCachePayload): string {
  return JSON.stringify(payload);
}

export function buildRiskFreeRatesCachePayload(
  benchmarks: RiskFreeRatesCachePayload["benchmarks"],
): RiskFreeRatesCachePayload {
  return {
    version: 1,
    benchmarks,
  };
}

export function serializeRiskFreeRatesCache(payload: RiskFreeRatesCachePayload): string {
  return JSON.stringify(payload);
}

export function parseRiskFreeRateCache(
  raw: string,
  cacheUpdatedAt: number,
  nowSec = Math.floor(Date.now() / 1000),
  defaults?: {
    key?: YieldBenchmarkKey;
    label?: string;
    currency?: string;
    isProxy?: boolean;
  },
): ParsedYieldBenchmarkMeta | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      const rate = toFiniteNumber(parsed.rate);
      const fetchedAt = toFiniteNumber(parsed.fetchedAt);
      if (rate != null) {
        const effectiveFetchedAt = fetchedAt ?? cacheUpdatedAt;
        const isFallback = parsed.isFallback === true;
        const source = toNullableString(parsed.source) ?? "unknown";
        const parsedKey = toNullableString(parsed.key) as YieldBenchmarkKey | null;
        const key = defaults?.key ?? parsedKey ?? "USD";
        const staticMeta = getYieldBenchmarkStaticMeta(key);
        const lastMarketRate =
          toFiniteNumber(parsed.lastMarketRate) ??
          (!isFallback && source !== "hardcoded-fallback" ? rate : null);
        return {
          key,
          label: defaults?.label ?? toNullableString(parsed.label) ?? staticMeta.label,
          currency: defaults?.currency ?? toNullableString(parsed.currency) ?? staticMeta.currency,
          rate,
          recordDate: toNullableString(parsed.recordDate),
          fetchedAt: effectiveFetchedAt,
          ageSeconds: effectiveFetchedAt != null ? Math.max(0, nowSec - effectiveFetchedAt) : null,
          source,
          isFallback,
          fallbackMode: toNullableString(parsed.fallbackMode),
          isProxy: defaults?.isProxy ?? (typeof parsed.isProxy === "boolean" ? parsed.isProxy : staticMeta.isProxy),
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
  if (legacyRate == null) return null;
  const key = defaults?.key ?? "USD";
  const staticMeta = getYieldBenchmarkStaticMeta(key);
  return {
    key,
    label: defaults?.label ?? staticMeta.label,
    currency: defaults?.currency ?? staticMeta.currency,
    rate: legacyRate,
    recordDate: null,
    fetchedAt: cacheUpdatedAt,
    ageSeconds: Math.max(0, nowSec - cacheUpdatedAt),
    source: "legacy-scalar",
    isFallback: legacyRate === RISK_FREE_RATE_FALLBACK,
    fallbackMode: legacyRate === RISK_FREE_RATE_FALLBACK ? "legacy-scalar-fallback" : null,
    isProxy: defaults?.isProxy ?? staticMeta.isProxy,
    lastMarketRate: legacyRate === RISK_FREE_RATE_FALLBACK ? null : legacyRate,
    lastMarketRecordDate: null,
    lastMarketFetchedAt: legacyRate === RISK_FREE_RATE_FALLBACK ? null : cacheUpdatedAt,
    lastMarketSource: legacyRate === RISK_FREE_RATE_FALLBACK ? null : "legacy-scalar",
  };
}

export function parseRiskFreeRatesCache(
  raw: string,
  cacheUpdatedAt: number,
  nowSec = Math.floor(Date.now() / 1000),
): ParsedYieldBenchmarkRegistry | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.benchmarks)) return null;
    const benchmarks = parsed.benchmarks as Record<string, unknown>;
    const usdRaw = benchmarks.USD;
    if (!usdRaw) return null;

    const usd = parseRiskFreeRateCache(
      JSON.stringify(usdRaw),
      cacheUpdatedAt,
      nowSec,
      { key: "USD" },
    );
    if (!usd) return null;

    const eur = benchmarks.EUR == null
      ? null
      : parseRiskFreeRateCache(JSON.stringify(benchmarks.EUR), cacheUpdatedAt, nowSec, { key: "EUR" });
    const chf = benchmarks.CHF == null
      ? null
      : parseRiskFreeRateCache(JSON.stringify(benchmarks.CHF), cacheUpdatedAt, nowSec, { key: "CHF" });

    return {
      USD: usd,
      EUR: eur,
      CHF: chf,
    };
  } catch (err) {
    console.warn(`[yield-sync] Failed to parse bundled benchmarks cache: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
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
      const updatedAt = parseCachePayloadUpdatedAt(undefined, cacheUpdatedAt, nowSec);
      if (updatedAt == null) {
        console.warn("[yield-sync] Rejected legacy DL pools cache with future updatedAt");
        return null;
      }
      const { pools } = filterValidDlPools(parsed, "legacy dl-stablecoin-pools cache");
      return {
        pools,
        meta: {
          mode: "dex-cache",
          updatedAt,
          ageSeconds: nowSec - updatedAt,
          poolCount: pools.length,
          fallbackMode: "legacy-array-cache",
        },
      };
    }

    if (isRecord(parsed) && Array.isArray(parsed.data)) {
      const { pools } = filterValidDlPools(parsed.data, "structured dl-stablecoin-pools cache");
      const updatedAt = parseCachePayloadUpdatedAt(parsed.updatedAt, cacheUpdatedAt, nowSec);
      if (updatedAt == null) {
        console.warn("[yield-sync] Rejected DL pools cache with future updatedAt");
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
      const updatedAt = parseCachePayloadUpdatedAt(undefined, cacheUpdatedAt, nowSec);
      if (updatedAt == null) {
        console.warn("[yield-sync] Rejected legacy supplemental sources cache with future updatedAt");
        return null;
      }
      const { candidates } = filterValidSupplementalCandidates(parsed, nowSec);
      return {
        candidates,
        updatedAt,
        ageSeconds: nowSec - updatedAt,
        sourceCount: candidates.length,
      };
    }

    if (isRecord(parsed) && Array.isArray(parsed.data)) {
      const { candidates } = filterValidSupplementalCandidates(parsed.data, nowSec);
      const updatedAt = parseCachePayloadUpdatedAt(parsed.updatedAt, cacheUpdatedAt, nowSec);
      if (updatedAt == null) {
        console.warn("[yield-sync] Rejected supplemental sources cache with future updatedAt");
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
    console.warn(`[yield-sync] Failed to parse supplemental sources cache: ${err instanceof Error ? err.message : String(err)}`);
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
    // Expected when the health-state cache is missing, truncated, or from an older schema.
    return getDefaultDeterministicOnChainHealthState();
  }
}
